// @ts-check
// PDF viewer: blob URL in an iframe; iOS gets an "Open PDF" button instead.
import { el, toolbar, download, fileButton, formatBytes, loadCSS } from '../lib/ui.js';

function isIOS() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  await loadCSS('/tools/pdf.css');
  /** @type {string | null} */
  let url = null;
  const body = el('div', { class: 'pdf-body' });
  const bar = el('div', { class: 'toolbar-slot' });
  root.append(bar, body);

  const revoke = () => { if (url) URL.revokeObjectURL(url); url = null; };

  /** @param {File} f */
  const show = (f) => {
    revoke();
    const u = URL.createObjectURL(new Blob([f], { type: 'application/pdf' }));
    url = u;
    const ios = isIOS();
    const open = () => window.open(u, '_blank', 'noopener');
    bar.replaceChildren(toolbar(
      fileButton('Open', show, 'application/pdf,.pdf'),
      el('span', { class: 'status pdf-name' }, `${f.name} · ${formatBytes(f.size)}`),
      el('span', { class: 'spacer' }),
      ios ? null : el('button', { onclick: open }, 'Open in new tab'),
      el('button', { onclick: () => download(f.name, f, 'application/pdf') }, 'Download'),
    ));
    if (ios) {
      body.replaceChildren(el('div', { class: 'empty' },
        el('p', {}, 'Inline PDF viewing only shows the first page on iOS.'),
        el('button', { class: 'primary pdf-big', onclick: open }, 'Open PDF'),
      ));
    } else {
      body.replaceChildren(el('iframe', { class: 'pdf-frame', src: u, title: f.name }));
    }
  };

  const empty = () => {
    bar.replaceChildren(toolbar(fileButton('Open', show, 'application/pdf,.pdf')));
    body.replaceChildren(el('div', { class: 'empty' },
      fileButton('Open a PDF', show, 'application/pdf,.pdf'),
      el('span', {}, 'or drop a file anywhere'),
    ));
  };

  if (input.file) show(input.file); else empty();
  return revoke;
}
