import { test, expect } from 'bun:test';
import { detect } from '../static/lib/detect.js';

const bytes = (/** @type {string|number[]} */ x) =>
  new Uint8Array(typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : x);
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

test.each([
  ['report.pdf', bytes('%PDF-1.7'), 'pdf'],
  ['letter.docx', ZIP, 'docx'],
  ['book.XLSX', ZIP, 'xlsx'],
  ['data.tsv', bytes('a\tb\n'), 'csv'],
  ['README.md', bytes('# hi'), 'md'],
  ['config.json', bytes('{"a":1}'), 'json'],
  ['photo.jpeg', bytes([0xff, 0xd8, 0xff, 0xe0]), 'image'],
  ['anim.webp', bytes('RIFF\0\0\0\0WEBP'), 'image'],
  ['logo.svg', bytes('<svg'), 'image'],
  ['empty.pdf', bytes([]), 'pdf'],
])('%s opens in %s', (name, head, tool) => {
  expect(detect(name, head)).toEqual({ tool });
});

test.each([
  ['fake.pdf', ZIP, 'mismatch'],
  ['fake.png', bytes('GIF89a'), 'mismatch'],
  ['old.doc', OLE, 'unsupported'],
  ['old.xls', OLE, 'unsupported'],
  ['locked.docx', OLE, 'unsupported'],
  ['deck.pptx', ZIP, 'unsupported'],
  ['archive.tar.gz', bytes([0x1f, 0x8b]), 'unknown'],
  ['Makefile', bytes('all:'), 'unknown'],
])('%s is rejected as %s', (name, head, reason) => {
  const d = detect(name, head);
  expect(d.tool).toBeNull();
  expect(d.reason).toBe(reason);
  expect(d.message).toBeTruthy();
});
