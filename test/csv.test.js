import { test, expect } from 'bun:test';
import { parse, serialize, detectDelimiter } from '../static/lib/csv.js';

test.each([
  ['quoted commas', 'a,"b,c",d\n', ',', [['a', 'b,c', 'd']]],
  ['escaped quotes', 'x,"say ""hi"""\n', ',', [['x', 'say "hi"']]],
  ['newline in quoted field', 'a,"l1\nl2"\nb,c\n', ',', [['a', 'l1\nl2'], ['b', 'c']]],
  ['CRLF inside quotes', '"a\r\nb",c\r\n', ',', [['a\r\nb', 'c']]],
  ['no trailing newline', 'a,b\n1,2', ',', [['a', 'b'], ['1', '2']]],
  ['empty trailing field', 'a,b,\n', ',', [['a', 'b', '']]],
])('parse: %s', (_name, text, delim, rows) => {
  expect(parse(text, delim).rows).toEqual(rows);
});

test.each([
  ['BOM', '﻿a,b\n1,2\n', { bom: true, eol: '\n', trailingEol: true }],
  ['CRLF', 'a,b\r\n1,2\r\n', { bom: false, eol: '\r\n', trailingEol: true }],
  ['no final newline', 'a,b\n1,2', { bom: false, eol: '\n', trailingEol: false }],
])('parse meta: %s', (_name, text, meta) => {
  const r = parse(text, ',');
  expect({ bom: r.bom, eol: r.eol, trailingEol: r.trailingEol }).toEqual(meta);
  expect(r.rows[0]).toEqual(['a', 'b']);
});

test.each([
  ['comma', 'a,b,c\n1,2,3\n', 'data.csv', ','],
  ['semicolon', 'a;b;c\n1;2;3\n', 'data.csv', ';'],
  ['tab', 'a\tb\tc\n1\t2\t3\n', 'data.txt', '\t'],
  ['pipe', 'a|b|c\n1|2|3\n', 'data.csv', '|'],
  ['quoted delimiter ignored', '"a,b";c\n"d,e";f\n', 'x.csv', ';'],
  ['tsv fallback', 'single\nvalues\n', 'x.tsv', '\t'],
  ['csv fallback', 'single\nvalues\n', 'x.csv', ','],
])('detect: %s', (_name, text, file, delim) => {
  expect(detectDelimiter(text, file)).toBe(delim);
});

test.each([
  ['plain', 'a,b\n1,2\n', ','],
  ['quotes and newlines', 'a,"b,c","d ""q"""\n"l1\nl2",x,y\n', ','],
  ['BOM + CRLF', '﻿a;b\r\n"1;2";3\r\n', ';'],
  ['no trailing newline', 'a\tb\n1\t2', '\t'],
  ['blank line and empty fields', 'a,,c\n\n,,\n', ','],
])('round trip: %s', (_name, text, delim) => {
  const p = parse(text, delim);
  expect(serialize(p.rows, { delim, ...p })).toBe(text);
});
