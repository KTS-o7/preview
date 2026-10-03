// @ts-check
// XLSX view/edit. The workbook lives on the server (excelize, in memory);
// this module is the grid. Ported from xl-vps static/index.html.
import { el, toolbar, toast, download, fileButton, loadCSS } from '../lib/ui.js';

/**
 * @typedef {{name: string, rows: number, cols: number, cells: string[][]}} Sheet
 * @typedef {{id: string, sheets: Sheet[]}} WorkbookInfo
 */

const API = '/api/xlsx';
/** Rows drawn at once; "Show more" adds another page. Keeps big sheets snappy. */
const PAGE = 200;
const NOTE = 'Uploaded to the server and held in memory only; dropped after 30 min idle.';

/** @param {number} n 1 -> A, 27 -> AA */
function colLabel(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Top-left (row, col), 1-based, of an "A1:Z100" range; mirrors the server.
 * @param {string} s
 * @returns {{row: number, col: number} | null}
 */
function rangeOrigin(s) {
  const parts = s.trim().toUpperCase().split(':');
  if (parts.length !== 2) return null;
  const pts = parts.map((p) => {
    const m = /^\s*([A-Z]*)(\d*)\s*$/.exec(p);
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Math.max(Number(m[2]) || 1, 1), col: Math.max(col, 1) };
  });
  if (!pts[0] || !pts[1]) return null;
  return { row: Math.min(pts[0].row, pts[1].row), col: Math.min(pts[0].col, pts[1].col) };
}

class ExpiredError extends Error {}

/**
 * @param {Response} r
 * @returns {Promise<any>}
 */
async function json(r) {
  if (r.status === 404) throw new ExpiredError('workbook expired, re-upload');
  let body = null;
  try { body = await r.clone().json(); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
  return body;
}

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  await loadCSS('/tools/xlsx.css');

  /** @type {File | null} */
  let file = null;
  /** @type {string | null} */
  let id = null;
  /** @type {Sheet[]} */
  let sheets = [];
  let active = '';
  let origin = { row: 1, col: 1 };
  let rangeText = '';
  let shown = PAGE;
  let saving = false;
  let alive = true;

  const status = el('span', { class: 'status' }, 'ready');
  const setStatus = (/** @type {string} */ s) => { status.textContent = s; };

  const rangeInput = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text', class: 'xlsx-range', placeholder: 'Range, e.g. A1:Z100', 'aria-label': 'Range', spellcheck: false,
  }));
  const rangeBtn = el('button', { onclick: () => loadRange(rangeInput.value.trim()) }, 'Load range');
  const fullBtn = el('button', { onclick: () => loadRange('') }, 'Full sheet');
  const dlBtn = el('button', { class: 'primary', onclick: () => downloadBook() }, 'Download');
  rangeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRange(rangeInput.value.trim()); });

  const note = el('div', { class: 'xlsx-note' }, NOTE);
  const tabs = el('div', { class: 'xlsx-tabs', role: 'tablist' });
  const table = el('table', { class: 'xlsx-grid' });
  const gridWrap = el('div', { class: 'xlsx-grid-wrap', tabindex: 0 }, table);
  const bench = el('div', { class: 'xlsx-bench' }, tabs, gridWrap);
  const emptyView = el('div', { class: 'empty xlsx-empty' },
    el('h2', {}, 'View and edit spreadsheets'),
    fileButton('Open .xlsx', (f) => upload(f), '.xlsx'),
    el('span', {}, 'or drop an .xlsx'),
  );
  const body = el('div', { class: 'xlsx-body' });

  const tools = [rangeInput, rangeBtn, fullBtn, dlBtn];
  const toolbarEl = toolbar(
    fileButton('Open', (f) => upload(f), '.xlsx'),
    ...tools,
    el('span', { class: 'spacer' }),
    status,
  );
  root.append(toolbarEl, note, body);

  const sheet = () => sheets.find((s) => s.name === active);

  function showEmpty() {
    id = null;
    sheets = [];
    for (const t of tools) t.hidden = true;
    body.replaceChildren(emptyView);
  }

  /** Expired workbook: say so, offer to re-upload. */
  function showExpired() {
    id = null;
    for (const t of tools) t.hidden = true;
    const again = file
      ? el('button', { class: 'primary', onclick: () => upload(/** @type {File} */ (file)) }, `Re-upload ${file.name}`)
      : null;
    body.replaceChildren(el('div', { class: 'empty xlsx-empty' },
      el('h2', { class: 'error' }, 'Workbook expired, re-upload'),
      el('span', {}, 'The server dropped it after sitting idle. Edits not downloaded are lost.'),
      again,
      fileButton('Choose another file', (f) => upload(f), '.xlsx'),
    ));
    setStatus('expired');
  }

  /** @param {unknown} e @param {string} what */
  function fail(e, what) {
    if (e instanceof ExpiredError) { showExpired(); return; }
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`${what} failed`);
    toast(`${what} failed: ${msg}`, 'error');
  }

  /** @param {File} f */
  async function upload(f) {
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      toast('Only .xlsx files are supported', 'error');
      return;
    }
    setStatus(`uploading ${f.name}…`);
    const fd = new FormData();
    fd.append('file', f);
    try {
      /** @type {WorkbookInfo} */
      const wb = await json(await fetch(`${API}/upload`, { method: 'POST', body: fd }));
      if (!alive) return;
      file = f;
      id = wb.id;
      sheets = wb.sheets;
      active = sheets[0]?.name ?? '';
      origin = { row: 1, col: 1 };
      rangeText = '';
      rangeInput.value = '';
      for (const t of tools) t.hidden = false;
      body.replaceChildren(bench);
      renderTabs();
      renderGrid();
      setStatus(`${sheets.length} sheet${sheets.length === 1 ? '' : 's'} · ${f.name}`);
    } catch (e) {
      if (e instanceof ExpiredError) e = new Error('upload failed');
      fail(e, 'Upload');
    }
  }

  /** Range read for big sheets; empty string reloads the whole sheet. @param {string} range */
  async function loadRange(range) {
    if (!id) return;
    const o = range ? rangeOrigin(range) : { row: 1, col: 1 };
    if (!o) { toast('Range looks like A1:Z100', 'error'); return; }
    setStatus('loading…');
    try {
      const q = range ? `?range=${encodeURIComponent(range)}` : '';
      /** @type {WorkbookInfo} */
      const wb = await json(await fetch(`${API}/${id}${q}`));
      sheets = wb.sheets;
      if (!sheet()) active = sheets[0]?.name ?? '';
      origin = o;
      rangeText = range.toUpperCase();
      shown = PAGE;
      renderTabs();
      renderGrid();
      setStatus(rangeText ? `range ${rangeText} · ${active}` : `${sheets.length} sheets · ${file?.name ?? ''}`);
    } catch (e) { fail(e, 'Load'); }
  }

  async function downloadBook() {
    if (!id) return;
    try {
      const r = await fetch(`${API}/${id}/download`);
      if (!r.ok) await json(r);
      const name = (file?.name ?? 'workbook.xlsx').replace(/(\.xlsx)?$/i, '.xlsx');
      download(name, await r.blob());
    } catch (e) { fail(e, 'Download'); }
  }

  function renderTabs() {
    tabs.replaceChildren(...sheets.map((s) => el('button', {
      class: `xlsx-tab${s.name === active ? ' active' : ''}`, role: 'tab',
      'aria-selected': String(s.name === active),
      onclick: () => { active = s.name; shown = PAGE; renderTabs(); renderGrid(); },
    }, s.name)));
  }

  function renderGrid() {
    const s = sheet();
    if (!s || s.rows === 0) {
      table.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    const head = document.createElement('tr');
    head.append(el('th', { class: 'rowhead' }));
    for (let c = 0; c < s.cols; c++) head.append(el('th', {}, colLabel(origin.col + c)));
    const thead = document.createElement('thead');
    thead.append(head);
    frag.append(thead);

    const tbody = document.createElement('tbody');
    const n = Math.min(s.rows, shown);
    for (let r = 0; r < n; r++) {
      const tr = document.createElement('tr');
      tr.append(el('td', { class: 'rowhead' }, String(origin.row + r)));
      const cells = s.cells[r] ?? [];
      for (let c = 0; c < s.cols; c++) {
        const td = el('td', { tabindex: -1, 'data-r': r, 'data-c': c }, cells[c] ?? '');
        if (cells[c]) td.title = cells[c];
        tr.append(td);
      }
      tbody.append(tr);
    }
    frag.append(tbody);
    if (n < s.rows) {
      const more = el('button', {
        onclick: () => { shown += PAGE; renderGrid(); },
      }, `Show more rows (${n} of ${s.rows})`);
      const tr = document.createElement('tr');
      tr.append(el('td', { class: 'more', colspan: s.cols + 1 }, more));
      tbody.append(tr);
    }
    table.replaceChildren(frag);
  }

  /** @param {Element | null} t */
  const cellOf = (t) => {
    const td = t?.closest('td');
    return td && td.dataset.r !== undefined ? /** @type {HTMLTableCellElement} */ (td) : null;
  };
  const rc = (/** @type {HTMLElement} */ td) => ({ r: Number(td.dataset.r), c: Number(td.dataset.c) });
  const valueAt = (/** @type {{r: number, c: number}} */ p) => sheet()?.cells[p.r]?.[p.c] ?? '';

  /** @param {HTMLElement} td @param {string} [initial] */
  function startEdit(td, initial) {
    const open = table.querySelector('td.editing input');
    if (open) void commit(/** @type {HTMLInputElement} */ (open));
    if (td.classList.contains('editing')) return;
    const input = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: initial ?? valueAt(rc(td)), spellcheck: false }));
    td.classList.add('editing');
    td.replaceChildren(input);
    input.focus();
    if (initial === undefined) input.select();
    else input.setSelectionRange(initial.length, initial.length);
  }

  /** @param {HTMLElement} td */
  function restore(td) {
    td.classList.remove('editing');
    td.textContent = valueAt(rc(td));
  }

  /** @param {HTMLInputElement} input */
  async function commit(input) {
    const td = /** @type {HTMLElement} */ (input.parentElement);
    await save(td, input.value);
  }

  /** @param {HTMLElement} td @param {string} value */
  async function save(td, value) {
    const s = sheet();
    if (saving || !id || !s) return;
    const { r, c } = rc(td);
    const row = origin.row + r;
    const col = origin.col + c;
    saving = true;
    setStatus('saving…');
    try {
      const resp = await json(await fetch(`${API}/${id}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sheet: s.name, row, col, value }),
      }));
      if (!resp.ok) throw new Error('server reported save failed');
      // Keep what was typed; the server only returns {ok, id}.
      if (s.cells[r]) s.cells[r][c] = value;
      td.classList.remove('editing');
      td.textContent = value;
      td.title = value;
      td.classList.add('saved');
      setTimeout(() => td.classList.remove('saved'), 400);
      setStatus(`saved · ${s.name} · ${colLabel(col)}${row}`);
    } catch (e) {
      if (e instanceof ExpiredError) { showExpired(); return; }
      restore(td);
      fail(e, 'Save');
    } finally {
      saving = false;
    }
  }

  /** @param {number} r @param {number} c */
  const focusCell = (r, c) => {
    /** @type {HTMLElement | null} */
    const td = table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    td?.focus();
  };

  table.addEventListener('click', (e) => {
    const td = cellOf(/** @type {Element} */ (e.target));
    if (td && !td.classList.contains('editing')) startEdit(td);
  });

  table.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t instanceof HTMLInputElement) {
      const td = /** @type {HTMLElement} */ (t.parentElement);
      const { r, c } = rc(td);
      if (e.key === 'Enter') {
        e.preventDefault();
        void commit(t).then(() => focusCell(r + 1, c));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        restore(td);
        td.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        void commit(t).then(() => focusCell(r, c + (e.shiftKey ? -1 : 1)));
      }
      return;
    }
    const td = cellOf(t);
    if (!td) return;
    const { r, c } = rc(td);
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      focusCell(
        r + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0),
        c + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0),
      );
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit(td);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void save(td, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(td, e.key);
    }
  });

  // This tool takes its own drops so the shell does not re-route them.
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files[0];
    if (f) void upload(f);
  });

  showEmpty();
  if (input.file) await upload(input.file);

  return () => { alive = false; };
}
