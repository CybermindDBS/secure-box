// Editing a .txt file inside Secure Box (textfile.js): a save writes the text back the way the
// file was written (encoding, byte order mark, line breaks), and only .txt files are edited.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEditText, encodeText, TEXT_EDIT_LIMIT, textStyle } from '../src/core/textfile.js';

const utf16 = (text, little) => {
  const out = [little ? 0xff : 0xfe, little ? 0xfe : 0xff];
  for (const unit of text.split('').map((c) => c.charCodeAt(0))) out.push(...(little ? [unit & 0xff, unit >> 8] : [unit >> 8, unit & 0xff]));
  return new Uint8Array(out);
};
const utf8 = (text) => new TextEncoder().encode(text);

test('an unchanged text file is saved back byte for byte, however it was written', () => {
  const files = {
    'plain UTF-8': utf8('Shopping\nmilk, bread\ncafé ☕\n'),
    'Windows line breaks': utf8('Line one\r\nLine two\r\n'),
    'UTF-8 with a byte order mark': new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Notes\r\nmore')]),
    'UTF-16, little-endian': utf16('Héllo\r\nwörld ✓', true),
    'UTF-16, big-endian': utf16('Héllo\nwörld ✓', false),
    empty: new Uint8Array(0),
  };
  for (const [what, bytes] of Object.entries(files)) {
    const style = textStyle(bytes);
    assert.ok(!style.text.includes('\r'), `${what}: a text box sees plain line breaks`);
    assert.deepEqual(encodeText(style.text, style), bytes, what);
  }
});

test('an edit keeps the file’s encoding and line breaks', () => {
  const style = textStyle(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a\r\nb')]));
  assert.deepEqual(style, { text: 'a\nb', utf16: '', bom: true, crlf: true });
  const saved = encodeText(`${style.text}\nc`, style);
  assert.deepEqual(saved, new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a\r\nb\r\nc')]));
});

test('only .txt files are edited, up to the size limit', () => {
  assert.equal(canEditText({ name: 'notes.txt', size: 10 }), true);
  assert.equal(canEditText({ name: 'NOTES.TXT', size: 10 }), true);
  assert.equal(canEditText({ name: 'notes.txt', size: TEXT_EDIT_LIMIT + 1 }), false);
  assert.equal(canEditText({ name: 'readme.md', size: 10 }), false);
  assert.equal(canEditText({ name: 'data.csv', size: 10 }), false);
  assert.equal(canEditText({ name: 'txt', size: 10 }), false);
});
