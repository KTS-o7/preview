// @ts-check
// File-type detection: extension picks the tool, magic bytes confirm it.

/** @typedef {{tool: string|null, reason?: 'mismatch'|'unsupported'|'unknown', message?: string}} Detection */

/** @type {Record<string, string>} */
const BY_EXT = {
  pdf: 'pdf',
  docx: 'docx',
  csv: 'csv', tsv: 'csv',
  md: 'md', markdown: 'md',
  json: 'json', geojson: 'json',
  xlsx: 'xlsx', xlsm: 'xlsx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', avif: 'image', bmp: 'image', ico: 'image',
  txt: 'text', log: 'text', yaml: 'text', yml: 'text', toml: 'text', xml: 'text',
  ini: 'text', conf: 'text', html: 'text', css: 'text', js: 'text', ts: 'text',
  go: 'text', rs: 'text', py: 'text', sh: 'text', sql: 'text',
};

/** Old binary Office formats we recognise but can't open. */
const UNSUPPORTED = {
  doc: 'Word 97 format (.doc) is not supported. Save it as .docx and try again.',
  xls: 'Old Excel format (.xls) is not supported. Save it as .xlsx and try again.',
  ppt: 'PowerPoint files are not supported yet.',
  pptx: 'PowerPoint files are not supported yet.',
};

/**
 * @param {Uint8Array} b
 * @param {number[]} sig
 * @param {number} [at]
 */
const starts = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (/** @type {string} */ s) => [...s].map((c) => c.charCodeAt(0));

const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** @type {Record<string, (b: Uint8Array) => boolean>} */
const MAGIC = {
  pdf: (b) => starts(b, ascii('%PDF')),
  zip: (b) => starts(b, ZIP),
  png: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]),
  jpg: (b) => starts(b, [0xff, 0xd8, 0xff]),
  gif: (b) => starts(b, ascii('GIF8')),
  webp: (b) => starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8),
};

/** Extension → which magic check must pass. Types not listed are not checked. */
/** @type {Record<string, string>} */
const EXPECT = {
  pdf: 'pdf', docx: 'zip', xlsx: 'zip', xlsm: 'zip',
  png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp',
};

/** @param {string} name */
export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * @param {string} name file name
 * @param {Uint8Array} head first 12 (or fewer) bytes of the file
 * @returns {Detection}
 */
export function detect(name, head) {
  const ext = extOf(name);
  if (ext in UNSUPPORTED) {
    return { tool: null, reason: 'unsupported', message: UNSUPPORTED[/** @type {keyof typeof UNSUPPORTED} */ (ext)] };
  }
  const tool = BY_EXT[ext];
  if (!tool) {
    return { tool: null, reason: 'unknown', message: `Can't preview .${ext || name} files yet.` };
  }
  const want = EXPECT[ext];
  if (want && head.length > 0 && !MAGIC[want](head)) {
    if ((ext === 'docx' || ext === 'xlsx' || ext === 'xlsm') && starts(head, OLE)) {
      return { tool: null, reason: 'unsupported', message: 'This file is password-protected or in an old binary Office format.' };
    }
    return { tool: null, reason: 'mismatch', message: `This file is named .${ext} but its contents don't match.` };
  }
  return { tool };
}

/**
 * @param {File} file
 * @returns {Promise<Detection>}
 */
export async function detectFile(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return detect(file.name, head);
}
