// @ts-check
// Shell: tool registry, hash router, global drop zone.
//
// Tool module contract (static/tools/<id>.js):
//   export async function mount(root, input) -> optional cleanup function
//     root:  empty HTMLElement the tool owns
//     input: { file?: File, text?: string }  (both absent = empty tool)
// Tools that take their own drops call e.stopPropagation() in their drop
// handler so the global handler below doesn't re-route the file.

import { detectFile } from './lib/detect.js';
import { el, toast, formatBytes, SOFT_LIMIT } from './lib/ui.js';

/** @type {{id: string, name: string, desc: string, server?: boolean}[]} */
export const TOOLS = [
  { id: 'pdf', name: 'PDF', desc: 'View PDFs in the browser' },
  { id: 'docx', name: 'DOCX', desc: 'View Word documents' },
  { id: 'xlsx', name: 'XLSX', desc: 'View and edit spreadsheets', server: true },
  { id: 'csv', name: 'CSV', desc: 'View, sort, filter and edit CSV / TSV' },
  { id: 'md', name: 'Markdown', desc: 'Edit with live preview, export PDF' },
  { id: 'json', name: 'JSON', desc: 'Pretty-print, minify, validate, explore' },
  { id: 'diff', name: 'Diff', desc: 'Unified, split and word diffs' },
  { id: 'image', name: 'Image', desc: 'Zoom, pan, dimensions' },
  { id: 'text', name: 'Text', desc: 'Plain text view and edit' },
];

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const titleEl = /** @type {HTMLElement} */ (document.getElementById('tool-title'));
const overlay = /** @type {HTMLElement} */ (document.getElementById('drop-overlay'));
const picker = /** @type {HTMLInputElement} */ (document.getElementById('file-picker'));

/** @type {{file?: File, text?: string} | null} */
let pending = null;
/** @type {(() => void) | void} */
let cleanup;
let routeSeq = 0;

function currentId() {
  return location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
}

function landing() {
  titleEl.textContent = '';
  document.title = 'preview';
  app.replaceChildren(
    el('section', { class: 'landing' },
      el('div', { class: 'hero' },
        el('h2', {}, 'Drop a file anywhere'),
        el('p', { class: 'muted' }, 'Everything opens in your browser. Only XLSX editing and PDF export touch the server, and nothing is stored.'),
      ),
      el('div', { class: 'grid' },
        ...TOOLS.map((t) => el('a', { class: 'card', href: `#/${t.id}` },
          el('strong', {}, t.name),
          el('span', { class: 'muted' }, t.desc),
          t.server ? el('span', { class: 'badge' }, 'server') : null,
        )),
      ),
    ),
  );
}

async function route() {
  const seq = ++routeSeq;
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (e) { console.error(e); }
  }
  cleanup = undefined;

  const id = currentId();
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) {
    pending = null;
    landing();
    return;
  }
  titleEl.textContent = tool.name;
  document.title = `${tool.name} · preview`;
  const input = pending ?? {};
  pending = null;

  const root = el('div', { class: `tool tool-${id}` });
  app.replaceChildren(root);
  try {
    const mod = await import(`./tools/${id}.js`);
    if (seq !== routeSeq) return;
    cleanup = await mod.mount(root, input);
  } catch (e) {
    console.error(e);
    root.replaceChildren(el('p', { class: 'error' }, `Failed to load ${tool.name}: ${e instanceof Error ? e.message : e}`));
  }
}

/** @param {File} file */
async function openFile(file) {
  const d = await detectFile(file);
  if (!d.tool) {
    toast(d.message ?? 'Cannot open this file', 'error');
    if (d.reason !== 'unsupported') {
      app.prepend(el('div', { class: 'notice' },
        el('span', {}, `${d.message} `),
        el('button', { onclick: () => go('text', { file }) }, 'Open as text'),
      ));
    }
    return;
  }
  if (file.size > SOFT_LIMIT && d.tool !== 'xlsx' &&
      !confirm(`${file.name} is ${formatBytes(file.size)}. Large files may be slow. Continue?`)) {
    return;
  }
  go(d.tool, { file });
}

/**
 * @param {string} id
 * @param {{file?: File, text?: string}} input
 */
function go(id, input) {
  pending = input;
  if (currentId() === id) route();
  else location.hash = `#/${id}`;
}

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  overlay.hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.hidden = true;
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});
// Tool-level drop targets stop propagation, but the overlay still has to go.
document.addEventListener('drop', () => { dragDepth = 0; overlay.hidden = true; }, true);

picker.addEventListener('change', () => {
  const f = picker.files?.[0];
  if (f) openFile(f);
  picker.value = '';
});

window.addEventListener('hashchange', route);
route();
