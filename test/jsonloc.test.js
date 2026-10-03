import { test, expect } from 'bun:test';
import { locateJSONError } from '../static/lib/jsonloc.js';

test.each([
  ['empty input', '', 1, 1],
  ['trailing comma in array', '[1,2,]', 1, 6],
  ['trailing comma in object', '{\n  "a": 1,\n}', 3, 1],
  ['unquoted key', '{a: 1}', 1, 2],
  ['single-quoted string', "['x']", 1, 2],
  ['unterminated string', '{"a": "abc', 1, 7],
  ['missing colon', '{"a" 1}', 1, 6],
  ['missing comma', '[1 2]', 1, 4],
  ['bad literal', '[tru]', 1, 2],
  ['invalid escape', '"a\\xb"', 1, 3],
  ['control char in string', '"a\tb"', 1, 3],
  ['trailing garbage', '{"a":1}\nx', 2, 1],
  ['unclosed bracket at EOF', '[1,\n [2', 2, 4],
])('%s', (_name, text, line, column) => {
  expect(locateJSONError(text)).toMatchObject({ line, column });
});

test('valid JSON returns null', () => {
  expect(locateJSONError('{"a": [1, -2.5e3, true, null, "x\\u00e9\\n"], "b": {}}')).toBeNull();
});
