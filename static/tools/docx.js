// @ts-check
// DOCX viewer built on docx-preview (needs JSZip as a global).
import { el, toolbar, download, fileButton, formatBytes, loadCSS, loadScript } from '../lib/ui.js';

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

// Word list bullets use private-use code points from the Symbol/Wingdings
// fonts, which browsers don't ship, so they render as missing-glyph boxes.
/** @type {Record<string, string>} */
const SYMBOL_GLYPHS = {
  '\uf0b7': '•', '\uf0a7': '▪', '\uf06e': '■', '\uf0d8': '➢',
  '\uf076': '❖', '\uf0fc': '✓', '\uf0a8': '□', '\uf0e0': '➔',
};

/** @param {HTMLElement} root */
function fixSymbolBullets(root) {
  for (const style of root.querySelectorAll('style')) {
    const css = style.textContent ?? '';
    if (!/[\uf000-\uf0ff]/.test(css)) continue;
    style.textContent = css
      .replace(/[\uf000-\uf0ff]/g, (c) => SYMBOL_GLYPHS[c] ?? '•')
      .replace(/font-family:\s*(Symbol|Wingdings)[^;]*;/g, 'font-family: inherit;');
  }
}

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  await loadCSS('/tools/docx.css');

  /** @type {File | null} */
  let file = null;
  let zoom = 100;
  let seq = 0;

  const status = el('span', { class: 'status docx-name' });
  const pct = el('span', { class: 'docx-pct', title: 'Zoom' }, '100%');
  const minus = el('button', { 'aria-label': 'Zoom out', onclick: () => setZoom(zoom - ZOOM_STEP) }, '−');
  const plus = el('button', { 'aria-label': 'Zoom in', onclick: () => setZoom(zoom + ZOOM_STEP) }, '+');
  const printBtn = el('button', { onclick: () => window.print() }, 'Print');
  const dl = el('button', { onclick: () => { if (file) download(file.name, file, file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); } }, 'Download original');
  const doc = el('div', { class: 'docx-doc' });
  const scroll = el('div', { class: 'docx-scroll' }, doc);

  const emptyView = () => el('div', { class: 'empty' },
    fileButton('Open a DOCX', load, '.docx'),
    el('span', {}, 'or drop a file anywhere'),
  );

  /** @param {number} z */
  function setZoom(z) {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z)));
    doc.style.setProperty('zoom', String(zoom / 100));
    pct.textContent = `${zoom}%`;
    minus.toggleAttribute('disabled', zoom <= ZOOM_MIN);
    plus.toggleAttribute('disabled', zoom >= ZOOM_MAX);
  }

  /** @param {string} msg */
  function showError(msg) {
    doc.replaceChildren(el('div', { class: 'docx-error error' }, msg));
  }

  /** @param {File} f */
  async function load(f) {
    const my = ++seq;
    file = f;
    status.textContent = `${f.name} · ${formatBytes(f.size)}`;
    toggleControls(true);
    doc.replaceChildren(el('div', { class: 'docx-msg muted' }, 'Rendering…'));
    try {
      const buf = await f.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
        throw new Error('Word 97 format (.doc) is not supported. Save the file as .docx and open it again.');
      }
      await loadScript('/vendor/jszip.min.js');
      await loadScript('/vendor/docx-preview.min.js');
      if (my !== seq) return;
      const docx = /** @type {any} */ (globalThis).docx;
      doc.replaceChildren();
      await docx.renderAsync(buf, doc, undefined, {
        className: 'docx',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
      });
      fixSymbolBullets(doc);
    } catch (e) {
      if (my !== seq) return;
      console.error(e);
      showError(`Could not render this document: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** @param {boolean} on */
  function toggleControls(on) {
    for (const b of [minus, plus, printBtn, dl]) b.toggleAttribute('hidden', !on);
    pct.toggleAttribute('hidden', !on);
  }

  root.append(
    toolbar(
      fileButton('Open', load, '.docx'),
      status,
      el('span', { class: 'spacer' }),
      el('span', { class: 'group' }, minus, plus),
      pct,
      printBtn,
      dl,
    ),
    scroll,
  );
  toggleControls(false);
  setZoom(100);

  if (input.file) await load(input.file);
  else doc.replaceChildren(emptyView());

  return () => { seq++; };
}
