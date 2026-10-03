// @ts-check
// JSON editor: format, minify, sort keys, validate with error location, tree view.
import { el, toolbar, toast, download, fileButton, loadCSS } from '../lib/ui.js';
import { locateJSONError } from '../lib/jsonloc.js';

const CHUNK = 200;

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 * @returns {Promise<() => void>}
 */
export async function mount(root, input) {
  await loadCSS('/tools/json.css');

  let name = 'data.json';
  /** @type {'tree'|'text'} */
  let mode = 'text';
  /** @type {{line: number, column: number, message: string} | null} */
  let error = null;

  const area = /** @type {HTMLTextAreaElement} */ (el('textarea', {
    class: 'json-area', spellcheck: false, wrap: 'off', placeholder: 'Paste or type JSON, or drop a file…',
  }));
  const treeEl = el('div', { class: 'json-tree', hidden: true });
  const status = el('button', { class: 'json-status', title: 'Jump to the error' });
  const indentSel = /** @type {HTMLSelectElement} */ (el('select', { title: 'Indent' },
    el('option', { value: '2' }, '2 spaces'),
    el('option', { value: '4' }, '4 spaces'),
    el('option', { value: 'tab' }, 'Tab')));
  const textBtn = el('button', { class: 'active', onclick: () => setMode('text') }, 'Text');
  const treeBtn = el('button', { onclick: () => setMode('tree') }, 'Tree');
  const panes = el('div', { class: 'json-panes' }, area, treeEl);

  root.append(
    toolbar(
      fileButton('Open', (f) => openFile(f), '.json,application/json,.txt'),
      el('span', { class: 'group' },
        el('button', { onclick: () => transform('format') }, 'Format'),
        indentSel),
      el('button', { onclick: () => transform('minify') }, 'Minify'),
      el('button', { onclick: () => transform('sort') }, 'Sort keys'),
      el('span', { class: 'group' }, textBtn, treeBtn),
      el('button', { onclick: copy }, 'Copy'),
      el('button', { onclick: () => download(name, area.value, 'application/json;charset=utf-8') }, 'Download'),
      el('span', { class: 'spacer' }),
      status,
    ),
    panes,
  );

  const indent = () => (indentSel.value === 'tab' ? '\t' : Number(indentSel.value));
  const byteLength = (/** @type {string} */ s) => new TextEncoder().encode(s).length;

  /** @param {{line: number, column: number}} loc */
  function offsetOf(loc) {
    const t = area.value;
    let off = 0;
    for (let l = 1; l < loc.line; l++) {
      const nl = t.indexOf('\n', off);
      if (nl === -1) break;
      off = nl + 1;
    }
    return Math.min(t.length, off + loc.column - 1);
  }

  /** Select and scroll the textarea to the current error. */
  function goToError() {
    if (!error) return;
    if (mode !== 'text') setMode('text');
    const off = offsetOf(error);
    const t = area.value;
    area.focus();
    area.setSelectionRange(off, Math.min(t.length, off + 1));
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 19.5;
    area.scrollTop = Math.max(0, (error.line - 1) * lh - area.clientHeight / 2);
  }

  /** Validate, update the status line, return the parsed value (or undefined on error). */
  function validate() {
    const text = area.value;
    status.classList.remove('err', 'ok');
    if (!text.trim()) {
      error = null;
      status.textContent = '';
      return { ok: false, empty: true };
    }
    try {
      const value = JSON.parse(text);
      error = null;
      status.textContent = `Valid JSON · ${byteLength(text).toLocaleString()} bytes`;
      status.classList.add('ok');
      return { ok: true, value };
    } catch (e) {
      error = locateJSONError(text) ?? { line: 1, column: 1, message: e instanceof Error ? e.message : 'Invalid JSON' };
      status.textContent = `Line ${error.line}, column ${error.column}: ${error.message}`;
      status.classList.add('err');
      return { ok: false };
    }
  }

  /** @param {'format'|'minify'|'sort'} kind */
  function transform(kind) {
    const r = validate();
    if (!r.ok) {
      if (error) goToError();
      else toast('Nothing to format', 'error');
      return;
    }
    const v = kind === 'sort' ? sortKeys(r.value) : r.value;
    area.value = kind === 'minify' ? JSON.stringify(v) : JSON.stringify(v, null, indent());
    validate();
    if (mode === 'tree') renderTree();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(area.value);
      toast('Copied');
    } catch {
      area.select();
      toast('Copy failed; text selected instead', 'error');
    }
  }

  /** @param {File} f */
  async function openFile(f) {
    name = f.name;
    area.value = await f.text();
    validate();
    if (error) goToError();
    if (mode === 'tree') renderTree();
  }

  /** @param {'tree'|'text'} m */
  function setMode(m) {
    mode = m;
    textBtn.classList.toggle('active', m === 'text');
    treeBtn.classList.toggle('active', m === 'tree');
    panes.classList.toggle('split', m === 'tree');
    treeEl.hidden = m !== 'tree';
    if (m === 'tree') renderTree();
  }

  // ---- tree ----
  /** @type {WeakMap<Element, unknown>} */
  const values = new WeakMap();

  function renderTree() {
    const r = validate();
    if (!r.ok) {
      treeEl.replaceChildren(el('p', { class: 'error json-tree-msg' },
        r.empty ? 'Nothing to show.' : 'Fix the JSON error to see the tree.'));
      return;
    }
    const node = buildNode(null, r.value);
    treeEl.replaceChildren(node);
    if (isContainer(r.value)) toggle(node, true);
  }

  /** @param {unknown} v @returns {v is object} */
  const isContainer = (v) => typeof v === 'object' && v !== null;

  /**
   * @param {string|number|null} key
   * @param {unknown} v
   */
  function buildNode(key, v) {
    const line = el('div', { class: 'jt-line' });
    if (key !== null) line.append(el('span', { class: 'jt-key' }, typeof key === 'number' ? String(key) : JSON.stringify(key)), el('span', { class: 'jt-punct' }, ': '));
    const node = el('div', { class: 'jt-node' }, line);
    if (isContainer(v)) {
      const arr = Array.isArray(v);
      const count = arr ? v.length : Object.keys(v).length;
      node.classList.add('jt-container');
      line.classList.add('jt-toggle');
      line.setAttribute('tabindex', '0');
      line.setAttribute('role', 'button');
      line.setAttribute('aria-expanded', 'false');
      line.prepend(el('span', { class: 'jt-caret' }, '▶'));
      line.append(el('span', { class: 'jt-count' }, arr ? `[${count}]` : `{${count}}`));
      values.set(node, v);
    } else {
      const type = v === null ? 'null' : typeof v;
      line.append(el('span', { class: `jt-val jt-${type}` }, type === 'string' ? JSON.stringify(v) : String(v)));
    }
    return node;
  }

  /**
   * Expand or collapse a container node, rendering children lazily.
   * @param {Element} node @param {boolean} [force]
   */
  function toggle(node, force) {
    const line = /** @type {HTMLElement} */ (node.firstElementChild);
    const open = force ?? line.getAttribute('aria-expanded') !== 'true';
    line.setAttribute('aria-expanded', String(open));
    const caret = line.querySelector('.jt-caret');
    if (caret) caret.textContent = open ? '▼' : '▶';
    let kids = node.querySelector(':scope > .jt-children');
    if (!open) { if (kids) /** @type {HTMLElement} */ (kids).hidden = true; return; }
    if (kids) { /** @type {HTMLElement} */ (kids).hidden = false; return; }
    kids = el('div', { class: 'jt-children' });
    node.append(kids);
    const v = /** @type {any} */ (values.get(node));
    const entries = /** @type {[string|number, unknown][]} */ (Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v));
    appendChunk(/** @type {HTMLElement} */ (kids), entries, 0);
  }

  /**
   * @param {HTMLElement} host @param {[string|number, unknown][]} entries @param {number} from
   */
  function appendChunk(host, entries, from) {
    const end = Math.min(entries.length, from + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = from; i < end; i++) frag.append(buildNode(entries[i][0], entries[i][1]));
    if (end < entries.length) {
      const more = el('button', { class: 'jt-more' }, `Show ${Math.min(CHUNK, entries.length - end)} more (${entries.length - end} left)`);
      more.addEventListener('click', () => { more.remove(); appendChunk(host, entries, end); });
      frag.append(more);
    }
    host.append(frag);
  }

  treeEl.addEventListener('click', (e) => {
    const line = /** @type {HTMLElement} */ (e.target).closest('.jt-toggle');
    if (line?.parentElement) toggle(line.parentElement);
  });
  treeEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const line = /** @type {HTMLElement} */ (e.target).closest('.jt-toggle');
    if (line?.parentElement) { e.preventDefault(); toggle(line.parentElement); }
  });

  // ---- wiring ----
  status.addEventListener('click', goToError);
  /** @type {number} */
  let timer = 0;
  area.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      validate();
      if (mode === 'tree') renderTree();
    }, 200);
  });

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

  if (input.file) await openFile(input.file);
  else if (input.text) {
    area.value = input.text;
    validate();
    if (error) goToError();
  }
  return () => clearTimeout(timer);
}

/**
 * Recursively sort object keys. Uses fromEntries so a "__proto__" key stays a plain property.
 * @param {any} v
 * @returns {any}
 */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}
