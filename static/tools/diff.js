// @ts-check
// Diff tool: two panes, unified / split / word views. The diff itself runs in
// /lib/diff.worker.js; this file only renders the model it returns.
import { el, toolbar, fileButton, loadCSS } from '../lib/ui.js';
import { collapse, pairRows } from '../lib/diffview.js';

/** @typedef {import('../lib/diffview.js').Line} Line */
/** @typedef {import('../lib/diffview.js').Row} Row */
/** @typedef {'unified'|'split'|'word'} View */

/** Items rendered per chunk inside one visible segment. */
const CHUNK = 2000;
const NARROW = '(max-width: 700px)';

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  await loadCSS('/tools/diff.css');

  /** @type {View} */
  let view = 'unified';
  let seq = 0;
  /** @type {any} */
  let model = null;
  /** @type {number} */
  let timer = 0;
  const narrow = window.matchMedia(NARROW);

  const mkArea = (/** @type {string} */ ph) => /** @type {HTMLTextAreaElement} */ (
    el('textarea', { spellcheck: false, placeholder: ph, wrap: 'off', 'aria-label': ph }));
  const areaA = mkArea('Original: paste text or drop a file');
  const areaB = mkArea('Changed: paste text or drop a file');
  const errA = el('div', { class: 'dv-err', role: 'alert' });
  const errB = el('div', { class: 'dv-err', role: 'alert' });

  /**
   * @param {string} label
   * @param {HTMLTextAreaElement} area
   * @param {HTMLElement} err
   */
  const pane = (label, area, err) => {
    const box = el('div', { class: 'dv-pane' },
      el('div', { class: 'dv-pane-head' },
        el('strong', {}, label),
        el('span', { class: 'spacer' }),
        fileButton('Open', async (f) => { area.value = await f.text(); schedule(0); }),
      ),
      area,
      err,
    );
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
    box.addEventListener('dragleave', () => box.classList.remove('drop'));
    box.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove('drop');
      const f = e.dataTransfer?.files[0];
      if (f) { area.value = await f.text(); schedule(0); }
    });
    return box;
  };

  const inputs = el('div', { class: 'dv-inputs' },
    pane('Original', areaA, errA),
    pane('Changed', areaB, errB),
  );

  const btn = (/** @type {View} */ v, /** @type {string} */ label) => {
    const b = el('button', { type: 'button', onclick: () => setView(v) }, label);
    b.dataset.view = v;
    return b;
  };
  const group = el('div', { class: 'group' }, btn('unified', 'Unified'), btn('split', 'Split'), btn('word', 'Word'));
  const ws = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox' }));
  const json = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox' }));
  const ctx = /** @type {HTMLInputElement} */ (el('input', {
    type: 'number', min: 0, max: 999, value: 3, 'aria-label': 'Context lines', class: 'dv-ctx',
  }));
  const stats = el('span', { class: 'status dv-stats', hidden: true });
  const busy = el('span', { class: 'status', hidden: true }, 'Comparing…');
  const note = el('span', { class: 'status', hidden: true }, 'Split falls back to Unified on narrow screens');
  const editBtn = el('button', { type: 'button', onclick: () => {
    const open = inputs.classList.toggle('open');
    editBtn.classList.toggle('active', open);
    if (open) areaA.focus();
  } }, 'Edit inputs');
  const swapBtn = el('button', { type: 'button', onclick: () => {
    [areaA.value, areaB.value] = [areaB.value, areaA.value];
    schedule(0);
  } }, 'Swap');

  const result = el('div', { class: 'dv-result' });

  root.append(
    toolbar(
      group,
      el('label', { class: 'check' }, ws, 'Ignore whitespace'),
      el('label', { class: 'check' }, json, 'JSON-aware'),
      el('label', { class: 'check' }, 'Context', ctx),
      swapBtn,
      editBtn,
      el('span', { class: 'spacer' }),
      note, busy, stats,
    ),
    inputs,
    result,
  );

  /** @param {string} msg */
  const showEmpty = (msg) => result.replaceChildren(el('div', { class: 'empty' }, msg));

  /** @param {View} v */
  function setView(v) {
    view = v;
    const needsWord = (v === 'word') !== (model?.mode === 'word');
    if (model && !needsWord) render();
    else if (model || areaA.value || areaB.value) schedule(0);
    syncToolbar();
  }

  function syncToolbar() {
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (group.querySelectorAll('button'))) {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
    }
    note.hidden = !(view === 'split' && narrow.matches);
  }

  /** @param {number} delay */
  function schedule(delay) {
    clearTimeout(timer);
    busy.hidden = false;
    timer = window.setTimeout(run, delay);
  }

  /** @type {Worker} */
  const worker = new Worker('/lib/diff.worker.js', { type: 'module' });
  worker.onmessage = (ev) => {
    const d = ev.data;
    if (d.seq !== seq) return; // stale
    busy.hidden = true;
    errA.textContent = d.error?.a ? `Invalid JSON: ${d.error.a}` : '';
    errB.textContent = d.error?.b ? `Invalid JSON: ${d.error.b}` : '';
    if (d.error) {
      model = null;
      stats.hidden = true;
      showEmpty('Fix the JSON errors above to compare.');
    } else if (d.failure) {
      model = null;
      stats.hidden = true;
      result.replaceChildren(el('div', { class: 'empty error' }, `Diff failed: ${d.failure}`));
    } else {
      model = d.model;
      render();
    }
  };
  worker.onerror = (e) => {
    busy.hidden = true;
    result.replaceChildren(el('div', { class: 'empty error' }, `Diff worker failed: ${e.message || 'could not load'}`));
  };

  function run() {
    const a = areaA.value;
    const b = areaB.value;
    if (!a && !b) {
      seq++;
      busy.hidden = true;
      model = null;
      stats.hidden = true;
      errA.textContent = errB.textContent = '';
      showEmpty('Paste or drop text into both panes to compare.');
      return;
    }
    worker.postMessage({
      seq: ++seq, a, b,
      opts: { json: json.checked, ignoreWhitespace: ws.checked, mode: view === 'word' ? 'word' : 'lines' },
    });
  }

  function render() {
    const { added, removed } = model.stats;
    stats.hidden = false;
    stats.replaceChildren(el('span', { class: 'pos' }, `+${added}`), ' ', el('span', { class: 'neg' }, `−${removed}`));
    inputs.classList.add('compact');
    if (model.identical) { showEmpty('No differences'); return; }
    if (model.mode === 'word') { result.replaceChildren(renderWord(model.parts)); result.scrollTop = 0; return; }
    const n = Number.parseInt(ctx.value, 10);
    const segs = collapse(model.lines, Number.isFinite(n) ? n : 3);
    const split = view === 'split' && !narrow.matches;
    result.replaceChildren(renderTable(segs, split));
  }

  ctx.addEventListener('input', () => { if (model?.mode === 'lines' && !model.identical) render(); });
  for (const c of [ws, json]) c.addEventListener('change', () => schedule(0));
  for (const a of [areaA, areaB]) a.addEventListener('input', () => schedule(300));
  const onNarrow = () => { syncToolbar(); if (model?.mode === 'lines') render(); };
  narrow.addEventListener('change', onNarrow);

  showEmpty('Paste or drop text into both panes to compare.');
  syncToolbar();
  if (input.file) areaA.value = await input.file.text();
  else if (input.text) areaA.value = input.text;
  if (areaA.value) schedule(0);
  (areaA.value ? areaB : areaA).focus();

  return () => {
    clearTimeout(timer);
    seq++;
    worker.terminate();
    narrow.removeEventListener('change', onNarrow);
  };
}

/**
 * @param {{type: 'ctx'|'add'|'del', text: string}[]} parts
 */
function renderWord(parts) {
  const box = el('pre', { class: 'dv-word' });
  for (const p of parts) {
    box.append(p.type === 'ctx' ? p.text : el(p.type === 'add' ? 'ins' : 'del', {}, p.text));
  }
  return box;
}

/**
 * @param {string} text
 * @param {[number, number][] | undefined} ranges
 * @returns {DocumentFragment}
 */
function highlight(text, ranges) {
  const f = document.createDocumentFragment();
  if (!ranges?.length) { f.append(text); return f; }
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s > pos) f.append(text.slice(pos, s));
    f.append(el('span', { class: 'hl' }, text.slice(s, e)));
    pos = e;
  }
  if (pos < text.length) f.append(text.slice(pos));
  return f;
}

const MARK = { add: '+', del: '−', ctx: ' ' };

/** @param {Line} l */
function unifiedRow(l) {
  const code = el('td', { class: 'code' });
  code.append(highlight(l.text, l.ranges));
  return el('tr', { class: `ln ${l.type}` },
    el('td', { class: 'no' }, l.oldNo == null ? '' : String(l.oldNo)),
    el('td', { class: 'no' }, l.newNo == null ? '' : String(l.newNo)),
    el('td', { class: 'mk' }, MARK[l.type]),
    code,
  );
}

/** @param {Line | null} l @param {'no'|'code'} kind @param {'old'|'new'} side */
function splitCell(l, kind, side) {
  const td = el('td', { class: kind });
  if (!l) { td.classList.add('filler'); return td; }
  td.classList.add(l.type);
  if (kind === 'no') td.textContent = String(side === 'old' ? l.oldNo : l.newNo);
  else td.append(highlight(l.text, l.ranges));
  return td;
}

/** @param {Row} r */
function splitRow(r) {
  return el('tr', { class: 'ln' },
    splitCell(r.left, 'no', 'old'), splitCell(r.left, 'code', 'old'),
    splitCell(r.right, 'no', 'new'), splitCell(r.right, 'code', 'new'),
  );
}

/**
 * @param {import('../lib/diffview.js').Segment[]} segs
 * @param {boolean} split
 */
function renderTable(segs, split) {
  const table = el('table', { class: `dv ${split ? 'dv-split' : 'dv-unified'}` });
  const cols = split ? ['no', 'code', 'no', 'code'] : ['no', 'no', 'mk', 'code'];
  table.append(el('colgroup', {}, ...cols.map((c) => el('col', { class: `c-${c}` }))));
  const body = el('tbody');
  table.append(body);

  /**
   * Insert up to CHUNK items before `anchor`; leave a "show more" row if any remain.
   * @template T
   * @param {T[]} items
   * @param {(x: T) => HTMLElement} make
   * @param {Node | null} anchor
   * @param {number} [from]
   */
  const emit = (items, make, anchor, from = 0) => {
    const end = Math.min(items.length, from + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = from; i < end; i++) frag.append(make(items[i]));
    if (end < items.length) {
      const more = fullRow(`Show ${Math.min(CHUNK, items.length - end)} more of ${items.length - end} remaining lines`, () => {
        const next = more.nextSibling;
        more.remove();
        emit(items, make, next, end);
      });
      frag.append(more);
    }
    body.insertBefore(frag, anchor);
  };

  /** @param {string} label @param {() => void} onclick */
  const fullRow = (label, onclick) => {
    const b = el('button', { type: 'button', class: 'dv-expand', onclick }, label);
    return el('tr', { class: 'collapsed' }, el('td', { colspan: 4 }, b));
  };

  for (const seg of segs) {
    /** @param {Node | null} a */
    const draw = (a) => {
      if (split) emit(pairRows(seg.lines), splitRow, a);
      else emit(seg.lines, unifiedRow, a);
    };
    if (seg.type === 'lines') draw(null);
    else {
      const row = fullRow(`Expand ${seg.count} lines`, () => {
        const next = row.nextSibling;
        row.remove();
        draw(next);
      });
      body.append(row);
    }
  }
  return table;
}
