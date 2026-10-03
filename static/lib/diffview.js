// @ts-check
// Pure diff helpers: no DOM, no jsdiff import. Used by the worker, the tool
// and the tests.

/**
 * @typedef {{type: 'ctx'|'add'|'del', oldNo?: number, newNo?: number, text: string, ranges?: [number, number][]}} Line
 * @typedef {{type: 'lines', lines: Line[]}} LinesSegment
 * @typedef {{type: 'collapsed', count: number, lines: Line[]}} CollapsedSegment
 * @typedef {LinesSegment | CollapsedSegment} Segment
 * @typedef {{left: Line | null, right: Line | null}} Row
 */

/**
 * Parse JSON, sort object keys recursively and pretty-print with 2 spaces.
 * Throws a SyntaxError on invalid JSON.
 * @param {string} text
 * @returns {string}
 */
export function normalizeJSON(text) {
  return JSON.stringify(sortKeys(JSON.parse(text)), null, 2);
}

/** @param {any} v @returns {any} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Turn jsdiff diffLines output into per-line records with line numbers.
 * @param {{value: string, added?: boolean, removed?: boolean}[]} changes
 * @returns {Line[]}
 */
export function buildLines(changes) {
  /** @type {Line[]} */
  const lines = [];
  let oldNo = 1;
  let newNo = 1;
  for (const ch of changes) {
    if (ch.value === '') continue;
    const parts = ch.value.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    for (const raw of parts) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (ch.added) lines.push({ type: 'add', newNo: newNo++, text });
      else if (ch.removed) lines.push({ type: 'del', oldNo: oldNo++, text });
      else lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return lines;
}

/**
 * Group lines into visible runs and collapsed runs of unchanged lines.
 * Exactly `context` lines stay next to each change. Between two changes a
 * run collapses only if longer than 2*context; at the start or end of the
 * file only if longer than context. With no changes everything collapses.
 * Each collapsed segment carries its hidden `count`.
 * @param {Line[]} lines
 * @param {number} context
 * @returns {Segment[]}
 */
export function collapse(lines, context) {
  const ctxN = Math.max(0, Math.floor(context));
  /** @type {Segment[]} */
  const out = [];
  /** @param {Line[]} ls */
  const show = (ls) => {
    if (!ls.length) return;
    const last = out[out.length - 1];
    if (last && last.type === 'lines') last.lines.push(...ls);
    else out.push({ type: 'lines', lines: ls.slice() });
  };
  /** @param {Line[]} ls */
  const hide = (ls) => { if (ls.length) out.push({ type: 'collapsed', count: ls.length, lines: ls }); };

  const n = lines.length;
  let i = 0;
  let seenChange = false;
  while (i < n) {
    if (lines[i].type !== 'ctx') {
      let j = i;
      while (j < n && lines[j].type !== 'ctx') j++;
      show(lines.slice(i, j));
      seenChange = true;
      i = j;
      continue;
    }
    let j = i;
    while (j < n && lines[j].type === 'ctx') j++;
    const run = lines.slice(i, j);
    const atEnd = j === n;
    if (!seenChange && atEnd) {
      hide(run);
    } else if (!seenChange) {
      if (run.length > ctxN) { hide(run.slice(0, run.length - ctxN)); show(run.slice(run.length - ctxN)); }
      else show(run);
    } else if (atEnd) {
      if (run.length > ctxN) { show(run.slice(0, ctxN)); hide(run.slice(ctxN)); }
      else show(run);
    } else if (run.length > 2 * ctxN) {
      show(run.slice(0, ctxN));
      hide(run.slice(ctxN, run.length - ctxN));
      show(run.slice(run.length - ctxN));
    } else show(run);
    i = j;
  }
  return out;
}

/**
 * Pair lines into side-by-side rows. Context lines appear on both sides; an
 * adjacent block of deletions followed by additions is paired row by row,
 * extras get an empty filler (null) on the other side.
 * @param {Line[]} lines
 * @returns {Row[]}
 */
export function pairRows(lines) {
  /** @type {Row[]} */
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'ctx') { rows.push({ left: l, right: l }); i++; continue; }
    /** @type {Line[]} */
    const dels = [];
    /** @type {Line[]} */
    const adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    const m = Math.max(dels.length, adds.length);
    for (let k = 0; k < m; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/**
 * Convert word-diff parts for one paired line into changed character ranges
 * on each side.
 * @param {{value: string, added?: boolean, removed?: boolean}[]} parts
 * @returns {{old: [number, number][], new: [number, number][]}}
 */
export function rangesFromParts(parts) {
  /** @type {[number, number][]} */
  const o = [];
  /** @type {[number, number][]} */
  const n = [];
  let po = 0;
  let pn = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) { pushRange(n, pn, pn + len); pn += len; }
    else if (p.removed) { pushRange(o, po, po + len); po += len; }
    else { po += len; pn += len; }
  }
  return { old: o, new: n };
}

/** @param {[number, number][]} arr @param {number} s @param {number} e */
function pushRange(arr, s, e) {
  const last = arr[arr.length - 1];
  if (last && last[1] === s) last[1] = e;
  else arr.push([s, e]);
}
