// @ts-check
// Image viewer: fit by default, zoom (buttons, ctrl/cmd+wheel, pinch), drag to pan.
import { el, toolbar, fileButton, formatBytes, loadCSS } from '../lib/ui.js';

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

/**
 * @param {HTMLElement} root
 * @param {{file?: File, text?: string}} input
 */
export async function mount(root, input) {
  await loadCSS('/tools/image.css');

  /** @type {string | null} */
  let url = null;
  let file = /** @type {File | null} */ (null);
  let isSvg = false;
  let nw = 0;
  let nh = 0;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let fit = true;

  const img = /** @type {HTMLImageElement} */ (el('img', { class: 'img-el', alt: '', draggable: 'false' }));
  const view = el('div', { class: 'img-view' }, img);
  const info = el('span', { class: 'status img-info' });
  const pct = el('span', { class: 'img-pct' });
  const dims = el('span', { class: 'status' });

  /** Scale at which the whole image fits the viewport. */
  function fitScale() {
    if (!nw || !nh) return 1;
    const s = Math.min(view.clientWidth / nw, view.clientHeight / nh);
    return isSvg ? s : Math.min(s, 1);
  }

  function clamp() {
    const w = nw * scale;
    const h = nh * scale;
    const vw = view.clientWidth;
    const vh = view.clientHeight;
    tx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, tx));
    ty = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, ty));
  }

  function apply() {
    clamp();
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    pct.textContent = `${Math.round(scale * 100)}%`;
    fitBtn.classList.toggle('active', fit);
    oneBtn.classList.toggle('active', !fit && Math.abs(scale - 1) < 0.001);
  }

  function doFit() {
    fit = true;
    scale = fitScale();
    tx = ty = 0;
    apply();
  }

  /** @param {number} s @param {number} [cx] @param {number} [cy] */
  function zoomTo(s, cx = view.clientWidth / 2, cy = view.clientHeight / 2) {
    s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const k = s / scale;
    // Keep the image point under (cx, cy) fixed. Use the unclamped origin
    // when the image is centred, which clamp() already applied last time.
    tx = cx - (cx - tx) * k;
    ty = cy - (cy - ty) * k;
    scale = s;
    fit = false;
    apply();
  }

  /** @param {number} cx @param {number} cy */
  function do100(cx = view.clientWidth / 2, cy = view.clientHeight / 2) {
    zoomTo(1, cx, cy);
  }

  const fitBtn = el('button', { onclick: doFit }, 'Fit');
  const oneBtn = el('button', { onclick: () => do100() }, '100%');
  const outBtn = el('button', { 'aria-label': 'Zoom out', onclick: () => zoomTo(scale / 1.25) }, '−');
  const inBtn = el('button', { 'aria-label': 'Zoom in', onclick: () => zoomTo(scale * 1.25) }, '+');
  const controls = el('span', { class: 'group' }, outBtn, inBtn, fitBtn, oneBtn);

  /** @param {MouseEvent | WheelEvent | PointerEvent} e */
  const local = (e) => {
    const r = view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** @type {(() => void)[]} */
  const disposers = [];
  /** @type {(t: EventTarget, type: string, fn: any, opts?: any) => void} */
  const on = (t, type, fn, opts) => {
    t.addEventListener(type, fn, opts);
    disposers.push(() => t.removeEventListener(type, fn, opts));
  };

  on(view, 'wheel', (/** @type {WheelEvent} */ e) => {
    if (!file) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const { x, y } = local(e);
      zoomTo(scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), x, y);
    } else {
      tx -= e.deltaX;
      ty -= e.deltaY;
      apply();
    }
  }, { passive: false });

  /** @type {Map<number, {x: number, y: number}>} */
  const pointers = new Map();
  let pinchDist = 0;
  const dist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  on(view, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    if (!file || (e.pointerType === 'mouse' && e.button !== 0)) return;
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    view.classList.add('panning');
    if (pointers.size === 2) pinchDist = dist();
  });
  on(view, 'pointermove', (/** @type {PointerEvent} */ e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (pointers.size === 1) {
      tx += cur.x - prev.x;
      ty += cur.y - prev.y;
      pointers.set(e.pointerId, cur);
      apply();
    } else if (pointers.size === 2) {
      const before = mid();
      pointers.set(e.pointerId, cur);
      const d = dist();
      const m = mid();
      tx += m.x - before.x;
      ty += m.y - before.y;
      if (pinchDist > 0) zoomTo(scale * (d / pinchDist), m.x, m.y);
      else apply();
      pinchDist = d;
    }
  });
  /** @param {PointerEvent} e */
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 1) pinchDist = 0;
    if (pointers.size === 0) view.classList.remove('panning');
  };
  on(view, 'pointerup', release);
  on(view, 'pointercancel', release);
  on(view, 'dblclick', (/** @type {MouseEvent} */ e) => {
    if (!file) return;
    const { x, y } = local(e);
    if (fit) do100(x, y); else doFit();
  });
  on(window, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (!file || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomTo(scale * 1.25);
    else if (e.key === '-') zoomTo(scale / 1.25);
    else if (e.key === '0') doFit();
    else if (e.key === '1') do100();
  });

  const ro = new ResizeObserver(() => { if (file && nw) { if (fit) doFit(); else apply(); } });
  ro.observe(view);
  disposers.push(() => ro.disconnect());

  const emptyView = el('div', { class: 'empty img-empty' },
    fileButton('Open an image', load, 'image/*,.svg'),
    el('span', {}, 'or drop a file anywhere'),
  );

  /** @param {File} f */
  async function load(f) {
    if (url) URL.revokeObjectURL(url);
    file = f;
    isSvg = f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);
    const u = URL.createObjectURL(isSvg && f.type !== 'image/svg+xml' ? new Blob([f], { type: 'image/svg+xml' }) : f);
    url = u;
    emptyView.hidden = true;
    controls.hidden = pct.hidden = dims.hidden = false;
    info.textContent = `${f.name} · ${formatBytes(f.size)}`;
    img.hidden = true;
    try {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(undefined);
        img.onerror = () => reject(new Error('decode failed'));
        img.src = u;
      });
    } catch {
      if (url !== u) return;
      nw = nh = 0;
      dims.textContent = '';
      emptyView.hidden = false;
      emptyView.querySelector('span')?.replaceChildren(`Could not decode ${f.name}. Open another image or drop one anywhere.`);
      controls.hidden = pct.hidden = true;
      return;
    }
    if (url !== u) return;
    nw = img.naturalWidth || 300;
    nh = img.naturalHeight || 150;
    img.style.width = `${nw}px`;
    img.style.height = `${nh}px`;
    img.hidden = false;
    dims.textContent = `${img.naturalWidth || '?'} × ${img.naturalHeight || '?'}`;
    doFit();
  }

  view.append(emptyView);
  root.append(
    toolbar(
      fileButton('Open', load, 'image/*,.svg'),
      info,
      el('span', { class: 'spacer' }),
      dims,
      controls,
      pct,
    ),
    view,
  );
  controls.hidden = pct.hidden = dims.hidden = true;
  img.hidden = true;

  if (input.file) await load(input.file);

  return () => {
    for (const d of disposers) d();
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
}
