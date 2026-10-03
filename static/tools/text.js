// @ts-check
// Plain text view/edit. Also the fallback for unknown file types.
import { el, toolbar, download, fileButton, formatBytes } from '../lib/ui.js';

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  let name = input.file?.name ?? 'untitled.txt';
  const area = /** @type {HTMLTextAreaElement} */ (el('textarea', {
    class: 'text-area', spellcheck: false, placeholder: 'Paste or type text, or drop a file…',
  }));
  const status = el('span', { class: 'status' });
  const wrap = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', checked: true }));

  const updateStatus = () => {
    const lines = area.value ? area.value.split('\n').length : 0;
    status.textContent = `${name} · ${lines} lines · ${formatBytes(new Blob([area.value]).size)}`;
  };
  /** @param {File} f */
  const load = async (f) => {
    name = f.name;
    area.value = await f.text();
    updateStatus();
  };

  wrap.addEventListener('change', () => { area.wrap = wrap.checked ? 'soft' : 'off'; });
  area.addEventListener('input', updateStatus);

  root.append(
    toolbar(
      fileButton('Open', load),
      el('button', { onclick: () => download(name, area.value) }, 'Download'),
      el('label', { class: 'check' }, wrap, 'Wrap'),
      el('span', { class: 'spacer' }),
      status,
    ),
    el('div', { class: 'text-wrap' }, area),
  );

  if (input.file) await load(input.file);
  else if (input.text) { area.value = input.text; updateStatus(); }
  else updateStatus();
  area.focus();
}
