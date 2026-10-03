// @ts-check
// Module worker: computes the diff model off the main thread.
//   in:  {seq, a, b, opts: {json, ignoreWhitespace, mode}}
//   out: {seq, error?: {a?: string, b?: string}, model?: Model, failure?: string}
import { normalizeJSON, buildLines, rangesFromParts, pairRows } from './diffview.js';

/** @type {any} */
const scope = self;
/** Skip intra-line highlighting for very long lines (quadratic cost). */
const MAX_INTRA = 3000;

/** @type {Promise<any>} */
const jsdiff = import(new URL('../vendor/diff.js', import.meta.url).href);

/** @param {unknown} e */
const msg = (e) => (e instanceof Error ? e.message : String(e));

scope.onmessage = async (/** @type {MessageEvent} */ ev) => {
  const { seq, a, b, opts } = ev.data;
  try {
    const D = await jsdiff;
    let left = a;
    let right = b;
    if (opts.json) {
      /** @type {{a?: string, b?: string}} */
      const error = {};
      if (a.trim()) { try { left = normalizeJSON(a); } catch (e) { error.a = msg(e); } }
      if (b.trim()) { try { right = normalizeJSON(b); } catch (e) { error.b = msg(e); } }
      if (error.a || error.b) { scope.postMessage({ seq, error }); return; }
    }
    const ws = !!opts.ignoreWhitespace;
    const lines = buildLines(D.diffLines(left, right, { ignoreWhitespace: ws }));
    let added = 0;
    let removed = 0;
    for (const l of lines) { if (l.type === 'add') added++; else if (l.type === 'del') removed++; }
    const stats = { added, removed };
    const wordFn = ws ? D.diffWords : D.diffWordsWithSpace;

    if (opts.mode === 'word') {
      const parts = wordFn(left, right).map((/** @type {any} */ p) => ({
        type: p.added ? 'add' : p.removed ? 'del' : 'ctx', text: p.value,
      }));
      scope.postMessage({ seq, model: { mode: 'word', parts, stats, identical: added + removed === 0 } });
      return;
    }

    for (const row of pairRows(lines)) {
      const { left: l, right: r } = row;
      if (!l || !r || l === r) continue;
      if (l.text.length > MAX_INTRA || r.text.length > MAX_INTRA) continue;
      const rg = rangesFromParts(wordFn(l.text, r.text));
      if (rg.old.length) l.ranges = rg.old;
      if (rg.new.length) r.ranges = rg.new;
    }
    scope.postMessage({ seq, model: { mode: 'lines', lines, stats, identical: added + removed === 0 } });
  } catch (e) {
    scope.postMessage({ seq, failure: msg(e) });
  }
};
