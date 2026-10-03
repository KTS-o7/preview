// @ts-check
// RFC 4180 CSV parsing, serialising and delimiter detection. Pure, no DOM.

const DELIMS = [',', ';', '\t', '|'];

/**
 * @typedef {Object} CsvMeta
 * @property {boolean} bom        input began with a UTF-8 BOM
 * @property {'\n'|'\r\n'} eol    line ending of the first record break
 * @property {boolean} trailingEol input ended with a record break
 */

/**
 * Single-pass record scanner. Stops after maxRows records.
 * @param {string} text BOM already stripped
 * @param {string} delim
 * @param {number} maxRows
 * @returns {{rows: string[][], eol: '\n'|'\r\n', trailingEol: boolean}}
 */
function scan(text, delim, maxRows) {
  const n = text.length;
  const d = delim.charCodeAt(0);
  /** @type {string[][]} */
  const rows = [];
  /** @type {'\n'|'\r\n'|''} */
  let eol = '';
  let trailingEol = false;
  let row = /** @type {string[]} */ ([]);
  let i = 0;
  while (i < n && rows.length < maxRows) {
    let field;
    if (text.charCodeAt(i) === 34) {
      let start = i + 1;
      field = '';
      for (;;) {
        const q = text.indexOf('"', start);
        if (q === -1) { field += text.slice(start); i = n; break; } // unterminated: take the rest
        field += text.slice(start, q);
        if (text.charCodeAt(q + 1) === 34) { field += '"'; start = q + 2; continue; }
        i = q + 1;
        break;
      }
      // Tolerate junk between the closing quote and the delimiter.
      const junkStart = i;
      let c = text.charCodeAt(i);
      while (i < n && c !== d && c !== 10 && c !== 13) c = text.charCodeAt(++i);
      if (i > junkStart) field += text.slice(junkStart, i);
    } else {
      const start = i;
      let c = text.charCodeAt(i);
      while (i < n && c !== d && c !== 10 && c !== 13) c = text.charCodeAt(++i);
      field = text.slice(start, i);
    }
    row.push(field);
    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      if (i >= n) row.push(''); // trailing delimiter at EOF: empty last field
      continue;
    }
    // Record break.
    let brk = '\n';
    if (c === 13 && text.charCodeAt(i + 1) === 10) { brk = '\r\n'; i += 2; } else i++;
    if (!eol) eol = /** @type {'\n'|'\r\n'} */ (brk);
    rows.push(row);
    row = [];
    if (i >= n) trailingEol = true;
  }
  if (row.length) rows.push(row);
  return { rows, eol: eol || '\n', trailingEol };
}

/**
 * Parse CSV text.
 * @param {string} text
 * @param {string} delim single character
 * @returns {{rows: string[][]} & CsvMeta}
 */
export function parse(text, delim) {
  const bom = text.charCodeAt(0) === 0xfeff;
  const { rows, eol, trailingEol } = scan(bom ? text.slice(1) : text, delim, Infinity);
  return { rows, bom, eol, trailingEol };
}

/**
 * Serialise rows. Quotes only where required.
 * @param {string[][]} rows
 * @param {{delim: string} & Partial<CsvMeta>} opts
 */
export function serialize(rows, { delim, bom = false, eol = '\n', trailingEol = false }) {
  const out = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = new Array(row.length);
    for (let j = 0; j < row.length; j++) {
      const f = row[j];
      cells[j] = (f.includes(delim) || f.includes('"') || f.includes('\n') || f.includes('\r'))
        ? `"${f.replaceAll('"', '""')}"` : f;
    }
    out[r] = cells.join(delim);
  }
  return (bom ? '﻿' : '') + out.join(eol) + (trailingEol && out.length ? eol : '');
}

/**
 * Pick the delimiter giving a consistent field count > 1 over the first 50 records.
 * @param {string} text
 * @param {string} [filename]
 */
export function detectDelimiter(text, filename = '') {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Bound the work on huge single-line inputs; the possibly cut final record is dropped.
  const cut = body.length > 1 << 20;
  const sample = cut ? body.slice(0, 1 << 20) : body;
  const tsv = /\.tsv$/i.test(filename);
  let best = '';
  let bestCount = 1;
  for (const delim of DELIMS) {
    let { rows } = scan(sample, delim, 51);
    rows = cut ? rows.slice(0, -1) : rows.slice(0, 50);
    rows = rows.filter((r) => !(r.length === 1 && r[0] === ''));
    if (!rows.length) continue;
    const count = rows[0].length;
    if (count < 2 || rows.some((r) => r.length !== count)) continue;
    if (tsv && delim === '\t') return delim;
    if (count > bestCount) { best = delim; bestCount = count; }
  }
  return best || (tsv ? '\t' : ',');
}
