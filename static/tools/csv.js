// @ts-check
// CSV / TSV viewer and editor with a virtualised grid. Runs fully in the browser.
import { el, toolbar, toast, download, fileButton, loadCSS } from '../lib/ui.js';
import { parse, serialize, detectDelimiter } from '../lib/csv.js';

const ROW_H = 26;
const HEAD_H = 30;
const NUM_W = 76;
const OVERSCAN = 8;
const DELIM_LABELS = /** @type {[string, string][]} */ ([[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']]);

/** @param {number} i spreadsheet-style column label */
function colLabel(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 * @returns {Promise<() => void>}
 */
export async function mount(root, input) {
  await loadCSS('/tools/csv.css');

  // ---- state ----
  let name = 'data.csv';
  let delim = ',';
  /** @type {string[][]} */
  let rows = [];
  let meta = { bom: false, eol: /** @type {'\n'|'\r\n'} */ ('\n'), trailingEol: false };
  let hasHeader = true;
  let cols = 0;
  /** @type {number[]} */
  let colW = [];
  /** @type {number[]} */
  let colLeft = [];
  let filterText = '';
  let sortCol = -1;
  let sortDir = 0; // 0 original, 1 asc, -1 desc
  let view = /** @type {Uint32Array} */ (new Uint32Array(0)); // indices into rows
  /** @type {{p: number, c: number} | null} */
  let sel = null;
  /** @type {HTMLInputElement | null} */
  let editor = null;
  let loaded = false;

  const dataStart = () => (hasHeader ? 1 : 0);

  // ---- DOM ----
  const info = el('span', { class: 'status' });
  const delimSel = /** @type {HTMLSelectElement} */ (el('select', { title: 'Delimiter' },
    ...DELIM_LABELS.map(([v, l]) => el('option', { value: v }, l))));
  const headerChk = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', checked: true }));
  const filterBox = /** @type {HTMLInputElement} */ (el('input', { type: 'search', placeholder: 'Filter rows…', class: 'csv-filter' }));
  const delRowBtn = el('button', { title: 'Delete the selected row' }, 'Delete row');
  const delColBtn = el('button', { title: 'Delete the selected column' }, 'Delete col');

  const headEl = el('div', { class: 'csv-head' });
  const bodyEl = el('div', { class: 'csv-body' });
  const sizer = el('div', { class: 'csv-sizer' }, headEl, bodyEl);
  const scroller = el('div', { class: 'csv-scroller', tabindex: '0', role: 'grid' }, sizer);
  scroller.style.setProperty('--row-h', `${ROW_H}px`);
  scroller.style.setProperty('--head-h', `${HEAD_H}px`);
  scroller.style.setProperty('--num-w', `${NUM_W}px`);

  const grid = el('div', { class: 'csv-grid', hidden: true }, scroller);
  const pasteArea = /** @type {HTMLTextAreaElement} */ (el('textarea', { class: 'csv-paste', spellcheck: false, placeholder: 'Paste CSV or TSV here…' }));
  const empty = el('div', { class: 'empty csv-empty' },
    el('p', {}, 'Drop a CSV / TSV file anywhere, or'),
    fileButton('Open file', (f) => openFile(f), '.csv,.tsv,.txt,text/csv,text/tab-separated-values'),
    el('p', {}, 'paste data below'),
    pasteArea,
    el('button', { class: 'primary', onclick: () => { if (pasteArea.value) loadText(pasteArea.value, 'data'); } }, 'Load'),
  );
  const bar = toolbar(
    fileButton('Open', (f) => openFile(f), '.csv,.tsv,.txt,text/csv,text/tab-separated-values'),
    info,
    delimSel,
    el('label', { class: 'check' }, headerChk, 'First row is header'),
    filterBox,
    el('span', { class: 'group' },
      el('button', { onclick: () => addRow() }, '+ Row'),
      el('button', { onclick: () => addCol() }, '+ Col'),
      delRowBtn, delColBtn),
    el('span', { class: 'spacer' }),
    el('button', { class: 'primary', onclick: () => doDownload() }, 'Download'),
  );
  bar.hidden = true;
  root.append(bar, empty, grid);

  // ---- data ----
  /** @param {string} text @param {string} fname */
  function loadText(text, fname) {
    const d = detectDelimiter(text, fname);
    name = /\.[A-Za-z0-9]+$/.test(fname) ? fname : `${fname}${d === '\t' ? '.tsv' : '.csv'}`;
    delim = d;
    const p = parse(text, d);
    rows = p.rows;
    meta = { bom: p.bom, eol: p.eol, trailingEol: p.trailingEol };
    afterLoad();
  }

  /** @param {File} f */
  async function openFile(f) {
    // Blob.text() would drop the BOM, which we want to preserve.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await f.arrayBuffer());
    loadText(text, f.name);
  }

  function afterLoad() {
    if (!rows.length) rows = [['']];
    sortCol = -1; sortDir = 0; sel = null; editor = null;
    delimSel.value = delim;
    measureCols();
    loaded = true;
    empty.hidden = true;
    bar.hidden = false;
    grid.hidden = false;
    rebuildView();
    scroller.scrollTo(0, 0);
    scroller.focus();
  }

  function measureCols() {
    cols = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].length > cols) cols = rows[i].length;
    if (!cols) cols = 1;
    colW = [];
    // Sample the head plus ~400 rows spread over the file, so long values
    // further down don't get clipped.
    const sample = [];
    for (let r = 0; r < Math.min(rows.length, 100); r++) sample.push(r);
    const stride = Math.max(1, Math.floor(rows.length / 400));
    for (let r = 100; r < rows.length; r += stride) sample.push(r);
    for (let c = 0; c < cols; c++) {
      let m = c < 26 ? 1 : 3;
      for (const r of sample) {
        const v = rows[r][c];
        if (v && v.length > m) m = v.length;
      }
      colW.push(Math.max(70, Math.min(320, m * 8 + 24)));
    }
    colLeft = [];
    let x = NUM_W;
    for (const w of colW) { colLeft.push(x); x += w; }
    colLeft.push(x);
  }

  /** @param {number} c */
  function headerName(c) {
    if (hasHeader) return rows[0]?.[c] ?? '';
    return colLabel(c);
  }

  // ---- view (filter + sort produce index arrays only) ----
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

  function rebuildView() {
    const start = dataStart();
    const q = filterText.toLowerCase();
    /** @type {Uint32Array} */
    let idx;
    if (q) {
      /** @type {number[]} */
      const hit = [];
      for (let r = start; r < rows.length; r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
          if (row[c].toLowerCase().includes(q)) { hit.push(r); break; }
        }
      }
      idx = Uint32Array.from(hit);
    } else {
      idx = new Uint32Array(Math.max(0, rows.length - start));
      for (let k = 0; k < idx.length; k++) idx[k] = start + k;
    }
    if (sortDir !== 0 && sortCol >= 0 && sortCol < cols) {
      const c = sortCol;
      const keys = /** @type {(number|string)[]} */ (new Array(rows.length));
      for (let k = 0; k < idx.length; k++) {
        const v = rows[idx[k]][c] ?? '';
        const t = v.trim();
        const num = t === '' ? NaN : Number(t);
        keys[idx[k]] = Number.isFinite(num) ? num : v;
      }
      const dir = sortDir;
      idx.sort((a, b) => {
        const x = keys[a], y = keys[b];
        const xn = typeof x === 'number', yn = typeof y === 'number';
        let r;
        if (xn && yn) r = x - y;
        else if (xn) r = -1; // numbers before text
        else if (yn) r = 1;
        else r = collator.compare(/** @type {string} */ (x), /** @type {string} */ (y));
        return r * dir;
      });
    }
    view = idx;
    if (sel && sel.p >= view.length) sel = view.length ? { p: view.length - 1, c: sel.c } : null;
    layout();
  }

  // ---- rendering ----
  /** @type {Map<number, HTMLElement>} */
  const nodes = new Map();
  let frame = 0;

  function layout() {
    sizer.style.width = `${colLeft[cols]}px`;
    sizer.style.height = `${HEAD_H + view.length * ROW_H}px`;
    renderHeader();
    updateInfo();
    refresh();
  }

  function renderHeader() {
    headEl.replaceChildren();
    headEl.append(el('div', { class: 'csv-num csv-hcell' }, '#'));
    for (let c = 0; c < cols; c++) {
      const arrow = sortCol === c && sortDir ? (sortDir > 0 ? ' ▲' : ' ▼') : '';
      const cell = el('div', { class: 'csv-hcell csv-sortable', 'data-c': c, title: 'Click to sort' }, headerName(c) + arrow);
      cell.style.width = `${colW[c]}px`;
      headEl.append(cell);
    }
  }

  function updateInfo() {
    const total = Math.max(0, rows.length - dataStart());
    const r = view.length === total ? `${total.toLocaleString()}` : `${view.length.toLocaleString()} of ${total.toLocaleString()}`;
    info.textContent = `${name} · ${r} rows × ${cols} cols`;
    delRowBtn.toggleAttribute('disabled', !sel);
    delColBtn.toggleAttribute('disabled', !sel || cols <= 1);
  }

  function refresh() {
    nodes.clear();
    bodyEl.replaceChildren();
    render();
  }

  function render() {
    frame = 0;
    const h = scroller.clientHeight - HEAD_H;
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(view.length - 1, Math.ceil((scroller.scrollTop + h) / ROW_H) + OVERSCAN);
    for (const [p, node] of nodes) {
      if (p < first || p > last) { node.remove(); nodes.delete(p); }
    }
    for (let p = first; p <= last; p++) {
      if (nodes.has(p)) continue;
      const node = buildRow(p);
      nodes.set(p, node);
      bodyEl.append(node);
    }
  }

  /** @param {number} p */
  function buildRow(p) {
    const ri = view[p];
    const row = rows[ri];
    const node = el('div', { class: 'csv-row', role: 'row', 'data-p': p });
    node.style.top = `${p * ROW_H}px`;
    const isSelRow = sel?.p === p;
    if (isSelRow) node.classList.add('sel-row');
    const num = el('div', { class: 'csv-num' }, String(ri - dataStart() + 1));
    node.append(num);
    for (let c = 0; c < cols; c++) {
      const cell = el('div', { class: isSelRow && sel?.c === c ? 'csv-cell sel' : 'csv-cell', 'data-c': c }, row[c] ?? '');
      cell.style.width = `${colW[c]}px`;
      node.append(cell);
    }
    return node;
  }

  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  // ---- selection / scrolling ----
  /** @param {number} p @param {number} c */
  function select(p, c) {
    if (!view.length) { sel = null; return; }
    sel = { p: Math.max(0, Math.min(view.length - 1, p)), c: Math.max(0, Math.min(cols - 1, c)) };
    ensureVisible();
    updateInfo();
    refresh();
  }

  function ensureVisible() {
    if (!sel) return;
    const top = sel.p * ROW_H;
    const viewH = scroller.clientHeight - HEAD_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + viewH) scroller.scrollTop = top + ROW_H - viewH;
    const left = colLeft[sel.c], right = colLeft[sel.c + 1];
    if (left - NUM_W < scroller.scrollLeft) scroller.scrollLeft = left - NUM_W;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
  }

  // ---- editing ----
  /** @param {number} p @param {number} c */
  function startEdit(p, c) {
    if (editor) commitEdit();
    select(p, c);
    const node = nodes.get(p);
    const cell = node?.children[c + 1];
    if (!node || !cell || !sel) return;
    const input = /** @type {HTMLInputElement} */ (el('input', { type: 'text', class: 'csv-edit', 'data-p': p, 'data-c': c }));
    input.value = rows[view[p]][c] ?? '';
    editor = input;
    cell.textContent = '';
    cell.append(input);
    input.focus();
    input.select();
  }

  /** @param {boolean} [save] @param {boolean} [refocus] */
  function endEdit(save = true, refocus = true) {
    const input = editor;
    if (!input) return;
    editor = null;
    if (save) {
      const p = Number(input.dataset.p), c = Number(input.dataset.c);
      const row = rows[view[p]];
      while (row.length <= c) row.push('');
      row[c] = input.value;
    }
    refresh();
    if (refocus) scroller.focus();
  }
  const commitEdit = () => endEdit(true, false);

  // ---- mutations ----
  function addRow() {
    rows.push(new Array(cols).fill(''));
    sortDir = 0; sortCol = -1;
    filterText = ''; filterBox.value = '';
    rebuildView();
    select(view.length - 1, sel?.c ?? 0);
  }

  function addCol() {
    for (const row of rows) { while (row.length < cols) row.push(''); row.push(''); }
    if (hasHeader) rows[0][cols] = `Column ${cols + 1}`;
    cols++;
    measureCols();
    rebuildView();
    if (sel) select(sel.p, cols - 1);
    else scroller.scrollLeft = scroller.scrollWidth;
  }

  function delRow() {
    if (!sel) return;
    rows.splice(view[sel.p], 1);
    if (!rows.length) rows = [new Array(cols).fill('')];
    rebuildView();
    if (view.length) select(sel?.p ?? 0, sel?.c ?? 0);
  }

  function delCol() {
    if (!sel || cols <= 1) return;
    const c = sel.c;
    for (const row of rows) if (row.length > c) row.splice(c, 1);
    if (sortCol === c) { sortCol = -1; sortDir = 0; } else if (sortCol > c) sortCol--;
    cols--;
    measureCols();
    rebuildView();
    select(sel.p, Math.min(c, cols - 1));
  }

  function doDownload() {
    if (editor) commitEdit();
    const out = serialize(rows, { delim, ...meta });
    download(name, out, delim === '\t' ? 'text/tab-separated-values;charset=utf-8' : 'text/csv;charset=utf-8');
  }

  // ---- events ----
  delRowBtn.addEventListener('click', delRow);
  delColBtn.addEventListener('click', delCol);

  delimSel.addEventListener('change', () => {
    if (!loaded) return;
    if (editor) commitEdit();
    // Re-parse the current (possibly edited) data under the new delimiter.
    const text = serialize(rows, { delim, ...meta, bom: false });
    const nd = delimSel.value;
    const p = parse(text, nd);
    delim = nd;
    rows = p.rows;
    meta = { bom: meta.bom, eol: meta.eol, trailingEol: meta.trailingEol };
    afterLoad();
  });

  headerChk.addEventListener('change', () => {
    if (editor) commitEdit();
    hasHeader = headerChk.checked;
    sortCol = -1; sortDir = 0; sel = null;
    rebuildView();
  });

  /** @type {number} */
  let debounce = 0;
  filterBox.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      filterText = filterBox.value;
      if (editor) commitEdit();
      sel = null;
      rebuildView();
      scroller.scrollTop = 0;
    }, 150);
  });

  scroller.addEventListener('scroll', scheduleRender, { passive: true });

  headEl.addEventListener('click', (e) => {
    const cell = /** @type {HTMLElement} */ (e.target).closest('.csv-sortable');
    if (!cell) return;
    if (editor) commitEdit();
    const c = Number(/** @type {HTMLElement} */ (cell).dataset.c);
    if (sortCol !== c) { sortCol = c; sortDir = 1; }
    else if (sortDir === 1) sortDir = -1;
    else { sortDir = 0; sortCol = -1; }
    rebuildView();
  });

  /** @param {Event} e */
  const hit = (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const cell = t.closest('.csv-cell');
    const rowEl = t.closest('.csv-row');
    if (!rowEl) return null;
    const p = Number(/** @type {HTMLElement} */ (rowEl).dataset.p);
    if (!cell) return { p, c: sel?.c ?? 0, onNum: true };
    return { p, c: Number(/** @type {HTMLElement} */ (cell).dataset.c), onNum: false };
  };

  bodyEl.addEventListener('mousedown', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('.csv-edit')) return;
    const h = hit(e);
    if (!h) return;
    if (editor) commitEdit();
    e.preventDefault(); // keep focus on the grid, no text selection while clicking
    scroller.focus();
    // Double-click is detected here, not with a dblclick listener: select()
    // re-renders the rows, so the second click lands on a new node and the
    // browser would fire dblclick on an ancestor instead of the cell.
    if (e.detail >= 2 && !h.onNum) startEdit(h.p, h.c);
    else select(h.p, h.c);
  });

  scroller.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t === editor) {
      if (e.key === 'Enter') { e.preventDefault(); const s = sel; endEdit(true); if (s) select(s.p, s.c); }
      else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const s = sel;
        endEdit(true);
        if (s) select(s.p, Math.min(cols - 1, s.c + (e.shiftKey ? -1 : 1)));
      }
      return;
    }
    if (t !== scroller || !sel) return;
    const { p, c } = sel;
    const page = Math.max(1, Math.floor((scroller.clientHeight - HEAD_H) / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowUp': select(p - 1, c); break;
      case 'ArrowDown': select(p + 1, c); break;
      case 'ArrowLeft': select(p, c - 1); break;
      case 'ArrowRight': select(p, c + 1); break;
      case 'Tab': if (!e.shiftKey && c < cols - 1) select(p, c + 1); else if (e.shiftKey && c > 0) select(p, c - 1); else return; break;
      case 'PageUp': select(p - page, c); break;
      case 'PageDown': select(p + page, c); break;
      case 'Home': select(e.ctrlKey || e.metaKey ? 0 : p, 0); break;
      case 'End': select(e.ctrlKey || e.metaKey ? view.length - 1 : p, cols - 1); break;
      case 'Enter': case 'F2': startEdit(p, c); break;
      case 'Delete': case 'Backspace': {
        const row = rows[view[p]];
        if (c < row.length) { row[c] = ''; refresh(); }
        break;
      }
      default: return;
    }
    e.preventDefault();
  });

  // Own drop target so the file loads in place, without the global router.
  const onDragOver = (/** @type {DragEvent} */ e) => e.preventDefault();
  const onDrop = (/** @type {DragEvent} */ e) => {
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    openFile(f).catch((err) => toast(String(err), 'error'));
  };
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);

  const ro = new ResizeObserver(() => { if (loaded) scheduleRender(); });
  ro.observe(scroller);

  // ---- initial input ----
  if (input.file) await openFile(input.file);
  else if (input.text) loadText(input.text, 'data');

  return () => {
    ro.disconnect();
    clearTimeout(debounce);
    cancelAnimationFrame(frame);
  };
}
