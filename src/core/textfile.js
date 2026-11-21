/**
 * Editing a .txt file inside Secure Box. The file is decrypted into memory, edited there, and
 * saved by encrypting the new text again: it's never written to disk. A save keeps the file as it
 * was written: its encoding (UTF-8, or UTF-16 with its byte order mark), a UTF-8 byte order mark,
 * and Windows line breaks.
 */
import { extOf } from './filetypes.js';
import { decodeText } from './readers.js';

/** Only .txt files are edited, up to this size: a text box slows down well before 2 MB of text. */
export const TEXT_EDIT_LIMIT = 2 * 1024 * 1024;

export const canEditText = (file) => extOf(file?.name || '') === 'txt' && file.size <= TEXT_EDIT_LIMIT;

/**
 * How a text file was written, and its text with plain "\n" line breaks (what a text box shows):
 * { text, utf16: '' | 'le' | 'be', bom, crlf }.
 */
export function textStyle(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const utf16 = data[0] === 0xff && data[1] === 0xfe ? 'le' : data[0] === 0xfe && data[1] === 0xff ? 'be' : '';
  const bom = Boolean(utf16) || (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf);
  const text = decodeText(data);
  return { text: text.replace(/\r\n?/g, '\n'), utf16, bom, crlf: text.includes('\r\n') };
}

/** `text` (with "\n" line breaks) as the bytes of a file written like `style`. */
export function encodeText(text, { utf16 = '', bom = false, crlf = false } = {}) {
  const body = crlf ? text.replace(/\n/g, '\r\n') : text;
  if (utf16) {
    const out = new Uint8Array(2 + body.length * 2);
    const little = utf16 === 'le';
    out.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < body.length; i++) {
      const unit = body.charCodeAt(i);
      out[2 + i * 2] = little ? unit & 0xff : unit >> 8;
      out[3 + i * 2] = little ? unit >> 8 : unit & 0xff;
    }
    return out;
  }
  const utf8 = new TextEncoder().encode(body);
  if (!bom) return utf8;
  const out = new Uint8Array(utf8.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(utf8, 3);
  return out;
}
