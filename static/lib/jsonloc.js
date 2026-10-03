// @ts-check
// Locate the first syntax error in JSON text with our own scanner, so the
// result does not depend on browser-specific JSON.parse messages. Pure.

/**
 * @param {string} text
 * @returns {{line: number, column: number, message: string} | null} 1-based, null when valid
 */
export function locateJSONError(text) {
  const n = text.length;
  let i = 0;
  /** @type {string[]} */
  const stack = [];

  /** @param {number} pos @param {string} message */
  const fail = (pos, message) => {
    let line = 1;
    let last = -1;
    for (let k = text.indexOf('\n'); k !== -1 && k < pos; k = text.indexOf('\n', k + 1)) { line++; last = k; }
    return { line, column: pos - last, message };
  };
  const eof = () => fail(n, stack.length
    ? `Unexpected end of input: unclosed '${stack[stack.length - 1]}'`
    : 'Unexpected end of input');
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break;
    }
  };
  const isDigit = (/** @type {number} */ c) => c >= 48 && c <= 57;
  const isHex = (/** @type {number} */ c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

  /** Scan a string starting at the opening quote. */
  const str = () => {
    const start = i++;
    for (;;) {
      if (i >= n) return fail(start, 'Unterminated string');
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return null; }
      if (c < 32) return fail(i, 'Control character in string; escape it');
      if (c === 92) {
        const e = text[i + 1];
        if (e !== undefined && '"\\/bfnrt'.includes(e)) { i += 2; continue; }
        if (e === 'u') {
          for (let k = 2; k <= 5; k++) if (!isHex(text.charCodeAt(i + k))) return fail(i, 'Invalid \\u escape');
          i += 6;
          continue;
        }
        if (e === undefined) return fail(start, 'Unterminated string');
        return fail(i, `Invalid escape sequence '\\${e}'`);
      }
      i++;
    }
  };

  const num = () => {
    if (text[i] === '-') i++;
    if (!isDigit(text.charCodeAt(i))) return i >= n ? eof() : fail(i, 'Invalid number');
    if (text[i] === '0') {
      i++;
      if (isDigit(text.charCodeAt(i))) return fail(i, 'Leading zeros are not allowed');
    } else while (isDigit(text.charCodeAt(i))) i++;
    if (text[i] === '.') {
      i++;
      if (!isDigit(text.charCodeAt(i))) return i >= n ? eof() : fail(i, 'Expected digit after decimal point');
      while (isDigit(text.charCodeAt(i))) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!isDigit(text.charCodeAt(i))) return i >= n ? eof() : fail(i, 'Expected digit in exponent');
      while (isDigit(text.charCodeAt(i))) i++;
    }
    return null;
  };

  /** @param {string} ch */
  const badStart = (ch) => ch === "'"
    ? fail(i, 'Single-quoted strings are not valid JSON; use double quotes')
    : fail(i, `Unexpected character '${ch}'`);

  // mode 0: value expected, 1: object key expected, 2: after a complete value
  let mode = 0;
  for (;;) {
    ws();
    if (mode === 0) {
      if (i >= n) return eof();
      const ch = text[i];
      let err = null;
      if (ch === '{' || ch === '[') {
        stack.push(ch);
        i++;
        ws();
        const close = ch === '{' ? '}' : ']';
        if (text[i] === close) { i++; stack.pop(); mode = 2; } else mode = ch === '{' ? 1 : 0;
        continue;
      } else if (ch === '"') err = str();
      else if (ch === '-' || isDigit(ch.charCodeAt(0))) err = num();
      else if (ch >= 'a' && ch <= 'z') {
        let j = i;
        while (text[j] >= 'a' && text[j] <= 'z') j++;
        const word = text.slice(i, j);
        if (word === 'true' || word === 'false' || word === 'null') i = j;
        else err = fail(i, `Unexpected token '${word}'`);
      } else err = badStart(ch);
      if (err) return err;
      mode = 2;
    } else if (mode === 1) {
      if (i >= n) return eof();
      if (text[i] !== '"') return text[i] === "'" ? badStart("'") : fail(i, 'Expected a double-quoted property name');
      const err = str();
      if (err) return err;
      ws();
      if (i >= n) return eof();
      if (text[i] !== ':') return fail(i, "Expected ':' after property name");
      i++;
      mode = 0;
    } else {
      const top = stack[stack.length - 1];
      if (!top) return i < n ? fail(i, 'Unexpected content after the end of the JSON value') : null;
      if (i >= n) return eof();
      const ch = text[i];
      const close = top === '{' ? '}' : ']';
      if (ch === ',') {
        i++;
        ws();
        if (text[i] === close) return fail(i, `Trailing comma before '${close}'`);
        mode = top === '{' ? 1 : 0;
      } else if (ch === close) {
        i++;
        stack.pop();
      } else return fail(i, `Expected ',' or '${close}'`);
    }
  }
}
