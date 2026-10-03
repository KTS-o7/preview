import { test, expect } from 'bun:test';
import { normalizeJSON, buildLines, collapse } from '../static/lib/diffview.js';
import { diffLines } from '../static/vendor/diff.js';

test('JSON-aware: reordered keys and whitespace normalise to identical text', () => {
  const a = '{"b":[1,{"y":2,"x":1}],"a":{"d":null,"c":"s"}}';
  const b = '{\n  "a": { "c": "s",\n "d": null },\n\t"b": [1, {"x": 1, "y": 2}]\n}\n';
  const na = normalizeJSON(a);
  expect(na).toBe(normalizeJSON(b));
  const changes = diffLines(na, normalizeJSON(b));
  expect(changes.some((c) => c.added || c.removed)).toBe(false);
  expect(() => normalizeJSON('{"a":')).toThrow();
});

/** tokens: ".x" context, "+x" added, "-x" removed. */
const mk = (/** @type {string} */ spec) =>
  buildLines(spec.split(' ').map((t) => ({
    value: t.slice(1) + '\n', added: t[0] === '+', removed: t[0] === '-',
  })));

const ctxs = (/** @type {number} */ n, p = 'c') => Array.from({ length: n }, (_, i) => `.${p}${i}`).join(' ');

// Summarise segments as "shown:N" / "hidden:N".
const shape = (/** @type {import('../static/lib/diffview.js').Segment[]} */ segs) =>
  segs.map((s) => (s.type === 'collapsed' ? `hidden:${s.count}` : `shown:${s.lines.length}`));

test.each([
  ['change at start', `-x +y ${ctxs(10)}`, 2, ['shown:4', 'hidden:8']],
  ['change at end', `${ctxs(10)} -x +y`, 2, ['hidden:8', 'shown:4']],
  ['change in the middle', `${ctxs(10)} -x ${ctxs(10, 'd')}`, 3, ['hidden:7', 'shown:7', 'hidden:7']],
  ['two changes far apart', `-x ${ctxs(10)} +y`, 2, ['shown:3', 'hidden:6', 'shown:3']],
  ['two changes close together', `-x ${ctxs(4)} +y`, 2, ['shown:6']],
  ['gap of exactly 2*context stays', `-x ${ctxs(4)} +y ${ctxs(2, 'z')}`, 2, ['shown:8']],
  ['short file edges not collapsed', `${ctxs(2)} -x ${ctxs(2, 'd')}`, 3, ['shown:5']],
  ['no changes', ctxs(7), 3, ['hidden:7']],
  ['empty', '', 3, []],
])('collapse: %s', (_name, spec, context, expected) => {
  const lines = spec ? mk(spec) : [];
  const segs = collapse(lines, context);
  expect(shape(segs)).toEqual(expected);
  // Nothing lost or reordered.
  expect(segs.flatMap((s) => s.lines)).toEqual(lines);
});

test('collapse keeps exactly N context lines beside each change', () => {
  const segs = collapse(mk(`${ctxs(10)} -x ${ctxs(10, 'd')}`), 3);
  expect(segs[1].lines.map((l) => l.text)).toEqual(['c7', 'c8', 'c9', 'x', 'd0', 'd1', 'd2']);
  const hidden = /** @type {any} */ (segs[0]);
  expect(hidden.lines[0].oldNo).toBe(1);
  expect(hidden.lines[hidden.count - 1].text).toBe('c6');
});
