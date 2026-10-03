// @ts-check
// Markdown editor with live preview. Rendered with marked, sanitised with DOMPurify.
import { el, toolbar, toast, download, fileButton, loadCSS, loadScript } from '../lib/ui.js';

const STANDALONE_CSS = `
body{max-width:820px;margin:32px auto;padding:0 16px;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;color:#1f2328;background:#fff}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em}
h1,h2{padding-bottom:.3em;border-bottom:1px solid #d8dee4}
a{color:#0969da}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#eff1f3;padding:.15em .35em;border-radius:4px}
pre{background:#f6f8fa;padding:14px 16px;border-radius:6px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:0 1em;color:#59636e;border-left:4px solid #d0d7de}
table{border-collapse:collapse;display:block;overflow:auto}
th,td{border:1px solid #d0d7de;padding:6px 13px}
th{background:#f6f8fa}
img{max-width:100%}
hr{border:0;border-top:1px solid #d8dee4}
`;

/** @param {string} s */
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  await loadCSS('/tools/md.css');

  let name = input.file?.name ?? 'untitled.md';
  /** @type {(src: string, opts: {gfm: boolean}) => string} */
  let parse = () => '';
  /** @type {(html: string) => string} */
  let sanitize = (h) => h;
  let ready = false;
  let timer = 0;
  let destroyed = false;

  const editor = /** @type {HTMLTextAreaElement} */ (el('textarea', {
    class: 'md-editor', spellcheck: false, 'aria-label': 'Markdown source',
    placeholder: '# Start typing Markdown\n\nOr use Open, or drop a .md file anywhere.',
  }));
  const preview = el('div', { class: 'md-preview', 'aria-label': 'Preview' });
  const status = el('span', { class: 'status md-status' });
  const split = el('div', { class: 'md-split mode-edit' },
    el('div', { class: 'md-pane md-pane-edit' }, editor),
    el('div', { class: 'md-pane md-pane-preview' }, preview),
  );

  const baseName = () => name.replace(/\.[^./\\]+$/, '') || 'document';

  function renderNow() {
    clearTimeout(timer);
    if (!ready || destroyed) return;
    const html = sanitize(parse(editor.value, { gfm: true }));
    preview.innerHTML = html;
    for (const a of preview.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    syncScroll();
    status.textContent = `${name} · ${editor.value.length} chars`;
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(renderNow, 150);
  };

  function syncScroll() {
    const max = editor.scrollHeight - editor.clientHeight;
    const ratio = max > 0 ? editor.scrollTop / max : 0;
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  }

  /** @param {File} f */
  async function load(f) {
    name = f.name;
    editor.value = await f.text();
    editor.scrollTop = 0;
    renderNow();
  }

  // Tab toggle, only visible under 700px (CSS).
  const editTab = el('button', { class: 'active', onclick: () => setMode('edit') }, 'Edit');
  const previewTab = el('button', { onclick: () => setMode('preview') }, 'Preview');
  /** @param {'edit'|'preview'} m */
  function setMode(m) {
    split.classList.toggle('mode-edit', m === 'edit');
    split.classList.toggle('mode-preview', m === 'preview');
    editTab.classList.toggle('active', m === 'edit');
    previewTab.classList.toggle('active', m === 'preview');
    if (m === 'preview') renderNow();
  }

  function exportHtml() {
    renderNow();
    const title = preview.querySelector('h1')?.textContent?.trim() || baseName();
    const doc = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>${STANDALONE_CSS}</style>\n</head>\n<body>\n${preview.innerHTML}\n</body>\n</html>\n`;
    download(`${baseName()}.html`, doc, 'text/html;charset=utf-8');
  }

  const pdfBtn = /** @type {HTMLButtonElement} */ (el('button', { onclick: exportPdf }, 'Export PDF'));
  async function exportPdf() {
    if (!editor.value.trim()) { toast('Nothing to export', 'error'); return; }
    pdfBtn.disabled = true;
    pdfBtn.textContent = 'Exporting…';
    try {
      const res = await fetch('/api/md2pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'text/markdown' },
        body: editor.value,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).trim();
        /** @type {Record<number, string>} */
        const known = {
          413: 'Document is too large to export (10 MB limit).',
          503: 'Server is busy. Try again in a moment.',
          504: 'PDF export timed out.',
        };
        toast(known[res.status] ?? (text || `Export failed (HTTP ${res.status})`), 'error');
        return;
      }
      download(`${baseName()}.pdf`, await res.blob(), 'application/pdf');
    } catch (e) {
      toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.textContent = 'Export PDF';
    }
  }

  editor.addEventListener('input', schedule);
  editor.addEventListener('scroll', syncScroll);
  window.addEventListener('resize', syncScroll);

  root.append(
    toolbar(
      fileButton('Open', load, '.md,.markdown,.mdown,.txt,text/markdown,text/plain'),
      el('span', { class: 'group md-tabs' }, editTab, previewTab),
      el('button', { onclick: () => download(name, editor.value, 'text/markdown;charset=utf-8') }, 'Download .md'),
      el('button', { onclick: exportHtml }, 'Export HTML'),
      pdfBtn,
      el('span', { class: 'spacer' }),
      status,
    ),
    split,
  );

  if (input.file) editor.value = await input.file.text();
  else if (input.text) editor.value = input.text;
  status.textContent = name;

  try {
    const { marked } = await import(/** @type {string} */ ('/vendor/marked.esm.js'));
    await loadScript('/vendor/purify.min.js');
    const purify = /** @type {any} */ (globalThis).DOMPurify;
    parse = (src, opts) => /** @type {string} */ (marked.parse(src, { ...opts, async: false }));
    sanitize = (h) => purify.sanitize(h);
    ready = true;
  } catch (e) {
    console.error(e);
    preview.replaceChildren(el('p', { class: 'error' }, `Could not load the Markdown renderer: ${e instanceof Error ? e.message : String(e)}`));
  }
  renderNow();
  if (!editor.value) editor.focus();

  return () => {
    destroyed = true;
    clearTimeout(timer);
    window.removeEventListener('resize', syncScroll);
  };
}
