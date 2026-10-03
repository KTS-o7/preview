// @ts-check
// Small DOM helpers shared by every tool.

/**
 * Create an element. Attributes starting with "on" become listeners.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c);
  }
  return node;
}

/**
 * Trigger a browser download.
 * @param {string} name
 * @param {Blob|string} data
 * @param {string} [type]
 */
export function download(name, data, type = 'text/plain;charset=utf-8') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

let toastTimer = 0;
/**
 * Show a transient message at the bottom of the screen.
 * @param {string} msg
 * @param {'info'|'error'} [kind]
 */
export function toast(msg, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', role: 'status' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t?.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}

/**
 * Toolbar row used at the top of every tool.
 * @param {...(Node|string|null|undefined|false)} children
 */
export const toolbar = (...children) => el('div', { class: 'toolbar' }, ...children);

/**
 * A hidden file input wired to a button.
 * @param {string} label
 * @param {(file: File) => void} onFile
 * @param {string} [accept]
 */
export function fileButton(label, onFile, accept) {
  const input = /** @type {HTMLInputElement} */ (el('input', { type: 'file', accept, hidden: true }));
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    input.value = '';
  });
  return el('label', { class: 'btn' }, label, input);
}

/** Human-readable byte size. @param {number} n */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Files above this size get a warning before browser-only processing. */
export const SOFT_LIMIT = 50 * 1024 * 1024;

/** @type {Map<string, Promise<void>>} */
const cssLoads = new Map();
/**
 * Load a tool stylesheet once. Resolves when it has applied, so tools can
 * await it before first paint and avoid a flash of unstyled content.
 * @param {string} href absolute path, e.g. '/tools/csv.css'
 */
export function loadCSS(href) {
  let p = cssLoads.get(href);
  if (!p) {
    p = new Promise((resolve) => {
      const link = el('link', { rel: 'stylesheet', href });
      link.addEventListener('load', () => resolve());
      link.addEventListener('error', () => resolve());
      document.head.append(link);
    });
    cssLoads.set(href, p);
  }
  return p;
}
