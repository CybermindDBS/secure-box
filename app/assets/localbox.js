/**
 * Local boxes (".sbox"): files and folders encrypted on this device from the Tools menu.
 * Nothing is uploaded.
 *
 *   "SBOXLCL1"          8 bytes: magic and format version
 *   header length H     4 bytes, big-endian
 *   header              H bytes of JSON: box id, kind, locked copies of the file key, and the
 *                       encrypted name, size and date
 *   content             the Secure Box file format (fileformat.js) with the box id as file id:
 *                       AES-256-GCM in 1 MiB chunks, Padmé-padded, tamper-evident
 *
 * Keys ("envelope encryption"). The content is encrypted with a random 256-bit file key, which
 * the header keeps only in locked copies ("slots"):
 *   account    locked with a key derived (HKDF-SHA-256) from the account's master key, so it
 *              opens wherever Secure Box is unlocked, including after an Emergency Kit reset
 *   password   optional, for sharing: locked with a key stretched from a password
 *              (PBKDF2-SHA-256, 600,000 rounds)
 * Every copy, and the metadata, is bound to the box id, so nothing can be moved between boxes.
 * A folder is stored as one ZIP (zip-core.js) inside a single box.
 */
import './stream-core.js';
import './zip-core.js';
import { decryptAesGcm, deriveAesKey, encryptAesGcm, fromBase64Url, fromUtf8, importHkdfKey, randomBytes, toBase64Url, utf8 } from './crypto.js';
import { encryptFile, layout } from './fileformat.js';

const S = globalThis.UniboxStream;
const Z = globalThis.UniboxZip;
const MAGIC = 'SBOXLCL1';
const PREFIX_BYTES = 12;
const MAX_HEADER = 64 * 1024;

export const BOX_EXTENSION = '.sbox';
export const SHARE_ITERATIONS = 600_000;

export class BoxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoxError';
    this.code = code;
  }
}

const damaged = (message = 'This .sbox file is damaged or was changed after it was made.') => new BoxError('damaged', message);
const bind = (...parts) => utf8(['secure-box-local', 1, ...parts].join('|'));

async function accountKey(master, salt) {
  return deriveAesKey(await importHkdfKey(master.key), salt, 'secure-box local files v1');
}

async function passwordKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', utf8(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function metadataKey(fileKey) {
  return deriveAesKey(await importHkdfKey(fileKey), new Uint8Array(0), 'secure-box local metadata v1');
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Encrypts `source` (a Blob or File) into a box, handing the bytes to `write` in order.
 * `meta` = { kind: 'file'|'folder', name, type, mtime, files } is stored encrypted.
 * `master` ({ kid, key }) adds the account copy; `password` adds a sharing copy.
 */
export async function writeBox({ source, meta, master = null, password = '', write, onProgress, signal }) {
  if (!master && !password) throw new BoxError('no-key', 'A box needs your account, a sharing password, or both.');
  const id = crypto.randomUUID();
  const fileKey = randomBytes(32);
  try {
    const slots = [];
    if (master) {
      const salt = randomBytes(32);
      const { iv, ciphertext } = await encryptAesGcm(await accountKey(master, salt), fileKey, bind('slot', 'account', id, master.kid));
      slots.push({ type: 'account', kid: master.kid, salt: toBase64Url(salt), iv: toBase64Url(iv), key: toBase64Url(ciphertext) });
    }
    if (password) {
      const salt = randomBytes(16);
      const { iv, ciphertext } = await encryptAesGcm(await passwordKey(password, salt, SHARE_ITERATIONS), fileKey, bind('slot', 'password', id));
      slots.push({ type: 'password', kdf: 'PBKDF2-SHA-256', iterations: SHARE_ITERATIONS, salt: toBase64Url(salt), iv: toBase64Url(iv), key: toBase64Url(ciphertext) });
    }
    const info = { kind: meta.kind, name: meta.name, type: meta.type || '', mtime: meta.mtime || Date.now(), size: source.size };
    if (meta.files) info.files = meta.files;
    const sealed = await encryptAesGcm(await metadataKey(fileKey), utf8(JSON.stringify(info)), bind('meta', id, meta.kind));
    const header = utf8(JSON.stringify({ format: 'secure-box-local', version: 1, id, kind: meta.kind, slots, meta: { iv: toBase64Url(sealed.iv), data: toBase64Url(sealed.ciphertext) } }));
    const prefix = new Uint8Array(PREFIX_BYTES);
    prefix.set(utf8(MAGIC));
    new DataView(prefix.buffer).setUint32(8, header.length);
    await write(prefix);
    await write(header);
    await encryptFile({ file: source, fileId: id, rawKey: fileKey, write, onProgress, signal });
    return { id, size: PREFIX_BYTES + header.length + layout({ size: source.size }).total };
  } finally {
    fileKey.fill(0);
  }
}

/**
 * Packs a folder into a ZIP Blob for a folder box. `items` are { path, file } and
 * { path, dir: true }, with paths relative to the folder's parent ("Trips/Japan/a.jpg").
 * File contents aren't copied: only their CRC-32 is computed, then the Blob points at them.
 */
export async function zipFolder(items, { onProgress, signal } = {}) {
  const entries = items.map((it) => (it.dir ? { path: it.path, dir: true, mtime: it.mtime } : { path: it.path, size: it.file.size, mtime: it.file.lastModified }));
  for (const entry of entries) Z.checkPath(entry.path, entry.dir);
  const plan = Z.plan(entries);
  const total = items.reduce((n, it) => n + (it.dir ? 0 : it.file.size), 0);
  let done = 0;
  const crcs = [];
  for (const it of items) {
    if (it.dir) {
      crcs.push(0);
      continue;
    }
    let crc = 0;
    const reader = it.file.stream().getReader();
    for (;;) {
      signal?.throwIfAborted();
      const { value, done: end } = await reader.read();
      if (end) break;
      crc = Z.crc32(crc, value);
      done += value.length;
      onProgress?.(total ? done / total : 1);
    }
    crcs.push(crc);
  }
  const parts = [];
  plan.items.forEach((item, i) => {
    parts.push(Z.localHeader(item));
    if (!item.dir) parts.push(items[i].file, Z.dataDescriptor(item, crcs[i]));
  });
  parts.push(Z.centralDirectory(plan, crcs));
  const blob = new Blob(parts, { type: 'application/zip' });
  if (blob.size !== plan.total) throw new BoxError('changed', 'A file changed while the folder was being packed. Try again.');
  return blob;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Reads and checks a box's header. Nothing secret is needed for this. */
export async function readBox(blob) {
  const notBox = () => new BoxError('not-box', 'This isn’t a Secure Box .sbox file.');
  if (blob.size < PREFIX_BYTES) throw notBox();
  const prefix = new Uint8Array(await blob.slice(0, PREFIX_BYTES).arrayBuffer());
  const magic = String.fromCharCode(...prefix.subarray(0, 8));
  if (magic !== MAGIC) {
    if (/^SBOXLCL[2-9]$/.test(magic)) throw new BoxError('newer', 'This .sbox file needs a newer version of Secure Box.');
    throw notBox();
  }
  const length = new DataView(prefix.buffer).getUint32(8);
  if (!length || length > MAX_HEADER || PREFIX_BYTES + length > blob.size) throw damaged();
  let header;
  try {
    header = JSON.parse(fromUtf8(new Uint8Array(await blob.slice(PREFIX_BYTES, PREFIX_BYTES + length).arrayBuffer())));
  } catch {
    throw damaged();
  }
  if (header?.format !== 'secure-box-local') throw notBox();
  if (header.version !== 1) throw new BoxError('newer', 'This .sbox file needs a newer version of Secure Box.');
  const valid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header.id) &&
    ['file', 'folder'].includes(header.kind) &&
    Array.isArray(header.slots) &&
    header.slots.length > 0 &&
    typeof header.meta?.iv === 'string' &&
    typeof header.meta?.data === 'string';
  if (!valid) throw damaged();
  return { header, payloadStart: PREFIX_BYTES + length, size: blob.size };
}

/** Who can open a box: this account, another account, and/or a sharing password. */
export function boxAccess(box, master) {
  const accounts = box.header.slots.filter((s) => s.type === 'account');
  const mine = Boolean(master) && accounts.some((s) => s.kid === master.kid);
  return { mine, otherAccount: accounts.length > 0 && !mine, password: box.header.slots.some((s) => s.type === 'password') };
}

/**
 * Unlocks a box with the account's master key or its sharing password. Returns the file key and
 * the decrypted metadata { kind, name, type, mtime, size }.
 */
export async function unlockBox(box, { master = null, password = '' } = {}) {
  const { header } = box;
  let fileKey = null;
  let failure = null;
  for (const slot of header.slots) {
    if (fileKey) break;
    try {
      if (slot.type === 'account' && master && slot.kid === master.kid) {
        failure = 'damaged';
        fileKey = await decryptAesGcm(await accountKey(master, fromBase64Url(slot.salt)), fromBase64Url(slot.iv), fromBase64Url(slot.key), bind('slot', 'account', header.id, slot.kid));
      } else if (slot.type === 'password' && password) {
        failure ??= 'wrong-password';
        const iterations = Math.trunc(Number(slot.iterations));
        if (!(iterations >= 100_000 && iterations <= 10_000_000)) continue;
        fileKey = await decryptAesGcm(await passwordKey(password, fromBase64Url(slot.salt), iterations), fromBase64Url(slot.iv), fromBase64Url(slot.key), bind('slot', 'password', header.id));
      }
    } catch {
      fileKey = null; // not this copy; try the next one
    }
  }
  if (!fileKey || fileKey.length !== 32) {
    const access = boxAccess(box, master);
    if (failure === 'damaged') throw damaged();
    if (failure === 'wrong-password') throw new BoxError('wrong-password', 'That sharing password doesn’t open this file.');
    if (access.password) throw new BoxError('needs-password', 'This file needs its sharing password.');
    throw new BoxError('other-account', 'This file was encrypted with a different Secure Box account.');
  }
  let meta;
  try {
    meta = JSON.parse(fromUtf8(await decryptAesGcm(await metadataKey(fileKey), fromBase64Url(header.meta.iv), fromBase64Url(header.meta.data), bind('meta', header.id, header.kind))));
  } catch {
    throw damaged();
  }
  if (meta.kind !== header.kind || !Number.isSafeInteger(meta.size) || meta.size < 0 || typeof meta.name !== 'string') throw damaged();
  return { fileKey, meta };
}

/**
 * Random access to the decrypted content of an unlocked box: read(from, to) returns plaintext
 * bytes [from, to]; stream() yields the whole content in order. Every byte is authenticated.
 */
export async function openContent(blob, box, unlocked) {
  const { payloadStart } = box;
  const head = new Uint8Array(await blob.slice(payloadStart, payloadStart + S.HEADER).arrayBuffer());
  if (head.length !== S.HEADER) throw damaged();
  const chunk = new DataView(head.buffer).getUint32(8);
  if (chunk < 4096 || chunk > 64 * 1024 * 1024) throw damaged();
  const entry = { id: box.header.id, size: unlocked.meta.size, chunk, thumbBytes: 0, key: toBase64Url(unlocked.fileKey) };
  let prefix;
  try {
    prefix = S.checkHeader(head, entry);
  } catch {
    throw damaged();
  }
  const plan = S.plan(entry);
  if (payloadStart + plan.total !== blob.size) throw damaged('This .sbox file is incomplete, or has extra data after it.');
  const key = await S.importKey(entry);
  const size = unlocked.meta.size;

  async function chunks(first, last) {
    const sp = S.span(plan, first * plan.chunk, Math.min(plan.padded, (last + 1) * plan.chunk) - 1);
    const sealed = new Uint8Array(await blob.slice(payloadStart + sp.start, payloadStart + sp.end + 1).arrayBuffer());
    const out = [];
    let at = 0;
    for (let i = first; i <= last; i++) {
      const length = S.chunkLength(plan, i);
      try {
        out.push(await S.decryptChunk(key, prefix, i, i === plan.contentChunks - 1 ? 1 : 0, head, sealed.subarray(at, at + length)));
      } catch {
        throw damaged();
      }
      at += length;
    }
    return out;
  }

  async function read(from, to) {
    if (from < 0 || to >= size || to < from) throw new RangeError('Outside the file.');
    const first = Math.floor(from / plan.chunk);
    const last = Math.floor(to / plan.chunk);
    const out = new Uint8Array(to - from + 1);
    let written = 0;
    (await chunks(first, last)).forEach((plain, n) => {
      const chunkStart = (first + n) * plan.chunk;
      const a = Math.max(from, chunkStart) - chunkStart;
      const b = Math.min(to + 1, chunkStart + plain.length) - chunkStart;
      if (b > a) {
        out.set(plain.subarray(a, b), written);
        written += b - a;
      }
    });
    return out;
  }

  async function* stream({ window = 8, onProgress, signal } = {}) {
    if (!size) {
      await chunks(plan.contentChunks - 1, plan.contentChunks - 1); // still authenticate an empty file
      onProgress?.(1);
      return;
    }
    for (let from = 0; from < size; from += plan.chunk * window) {
      signal?.throwIfAborted();
      const to = Math.min(size, from + plan.chunk * window) - 1;
      yield await read(from, to);
      onProgress?.((to + 1) / size);
    }
    // The last chunk (and so a cut-off file) is always checked, even if the padding is skipped.
    if (Math.floor((size - 1) / plan.chunk) !== plan.contentChunks - 1) await chunks(plan.contentChunks - 1, plan.contentChunks - 1);
  }

  return { size, read, stream };
}

/** Lists the folders and files inside a folder box (whose content is a ZIP). */
export async function zipEntries(content) {
  const { size } = content;
  if (size < 22) throw damaged();
  const tailStart = Math.max(0, size - (22 + 0xffff + 20));
  const tail = await content.read(tailStart, size - 1);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw damaged();
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tv.getUint32(locator, true) !== 0x07064b50) throw damaged();
    const end64 = Number(tv.getBigUint64(locator + 8, true));
    if (end64 + 56 > size) throw damaged();
    const record = await content.read(end64, end64 + 55);
    const rv = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (rv.getUint32(0, true) !== 0x06064b50) throw damaged();
    count = Number(rv.getBigUint64(32, true));
    cdSize = Number(rv.getBigUint64(40, true));
    cdOffset = Number(rv.getBigUint64(48, true));
  }
  if (cdOffset + cdSize > size) throw damaged();
  const cd = cdSize ? await content.read(cdOffset, cdOffset + cdSize - 1) : new Uint8Array(0);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const decoder = new TextDecoder();
  const out = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.length || v.getUint32(at, true) !== 0x02014b50) throw damaged();
    const method = v.getUint16(at + 10, true);
    let packed = v.getUint32(at + 20, true);
    let length = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    let offset = v.getUint32(at + 42, true);
    const path = decoder.decode(cd.subarray(at + 46, at + 46 + nameLength));
    for (let e = at + 46 + nameLength, end = e + extraLength; e + 4 <= end; ) {
      const id = v.getUint16(e, true);
      const fieldLength = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        // ZIP64: only the fields marked 0xFFFFFFFF above are present, in this order.
        let p = e + 4;
        if (length === 0xffffffff) {
          length = Number(v.getBigUint64(p, true));
          p += 8;
        }
        if (packed === 0xffffffff) {
          packed = Number(v.getBigUint64(p, true));
          p += 8;
        }
        if (offset === 0xffffffff) offset = Number(v.getBigUint64(p, true));
      }
      e += 4 + fieldLength;
    }
    const dir = path.endsWith('/');
    if (method !== 0 || packed !== length) throw new BoxError('zip', 'This folder box uses a ZIP feature Secure Box doesn’t read.');
    try {
      Z.checkPath(path, dir);
    } catch {
      throw damaged('This folder box contains an unsafe path.');
    }
    out.push({ path, dir, size: length, offset, crc: v.getUint32(at + 16, true) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** Yields the bytes of one file inside a folder box, and checks its CRC-32 at the end. */
export async function* zipEntryData(content, entry, { window = 8 * 1024 * 1024 } = {}) {
  const local = await content.read(entry.offset, entry.offset + 29);
  const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (lv.getUint32(0, true) !== 0x04034b50) throw damaged();
  const start = entry.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  if (start + entry.size > content.size) throw damaged();
  let crc = 0;
  for (let from = start; from < start + entry.size; from += window) {
    const bytes = await content.read(from, Math.min(start + entry.size, from + window) - 1);
    crc = Z.crc32(crc, bytes);
    yield bytes;
  }
  if (crc !== entry.crc) throw damaged(`${entry.path} failed its checksum.`);
}
