/**
 * Secure Box encrypted file format, version 1 ("SECBOXF1").
 *
 * Every file gets its own random 256-bit key. That key lives only inside the encrypted
 * vault (S3), never next to the file (Google Drive), so neither provider alone can decrypt.
 *
 * Layout of the blob stored in Drive:
 *
 *   header (35 bytes, authenticated as AAD of every chunk)
 *     "SECBOXF1" | chunk size (u32 BE) | nonce prefix (7 random bytes) | file id (16 bytes)
 *   thumbnail segment (optional, for images/videos)
 *   content segment: Padmé-padded file bytes, split into chunks
 *
 * Each chunk is sealed with AES-256-GCM using nonce = prefix | chunk index (u32 BE) | flag,
 * where flag is 0 = content, 1 = last content chunk, 2 = thumbnail, 3 = last thumbnail chunk.
 * This is the STREAM construction (Hoang et al.) as used by Google Tink's streaming AEAD:
 * chunks can't be reordered, dropped, truncated or moved between files without detection,
 * and huge files never have to fit in memory.
 */
import { decryptAesGcm, encryptAesGcm, fromBase64Url, importAesKey, padme, randomBytes, toBase64Url } from './crypto.js';

export const CHUNK_SIZE = 1024 * 1024;
export const HEADER_BYTES = 35;
export const MAX_FILE_SIZE = 2 * 1024 ** 3;
const TAG_BYTES = 16;
const MAGIC = [0x53, 0x45, 0x43, 0x42, 0x4f, 0x58, 0x46, 0x31]; // "SECBOXF1"
const FLAG = { content: 0, contentLast: 1, thumb: 2, thumbLast: 3 };

export class FileCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileCryptoError';
  }
}

export function uuidToBytes(id) {
  const hex = String(id).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new FileCryptoError('Invalid file id.');
  return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
}

function buildHeader(chunk, prefix, fileId) {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(8, chunk);
  header.set(prefix, 12);
  header.set(uuidToBytes(fileId), 19);
  return header;
}

function nonceFor(prefix, index, flag) {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(7, index);
  nonce[11] = flag;
  return nonce;
}

const segment = (bytes, chunk) => {
  const chunks = Math.max(1, Math.ceil(bytes / chunk));
  return { chunks, encrypted: bytes + chunks * TAG_BYTES };
};

/** Where everything sits inside the encrypted blob. */
export function layout({ size, thumbBytes = 0, chunk = CHUNK_SIZE }) {
  const padded = padme(size);
  const content = segment(padded, chunk);
  const thumb = thumbBytes ? segment(thumbBytes, chunk) : { chunks: 0, encrypted: 0 };
  return {
    padded,
    contentStart: HEADER_BYTES + thumb.encrypted,
    thumbEnd: HEADER_BYTES + thumb.encrypted, // exclusive
    total: HEADER_BYTES + thumb.encrypted + content.encrypted,
    contentChunks: content.chunks,
    thumbChunks: thumb.chunks,
  };
}

/**
 * Encrypts a Blob/File chunk by chunk and passes the ciphertext, in order, to `write`.
 * Returns the per-file key (base64url) and layout facts the vault index needs. `rawKey` is
 * only passed when the caller must know the key up front (local .sbox boxes).
 */
export async function encryptFile({ file, fileId, thumbnail = null, rawKey = randomBytes(32), write, onProgress, signal }) {
  const key = await importAesKey(rawKey, ['encrypt']);
  const prefix = randomBytes(7);
  const chunk = CHUNK_SIZE;
  const header = buildHeader(chunk, prefix, fileId);
  const thumbBytes = thumbnail ? thumbnail.length : 0;
  const plan = layout({ size: file.size, thumbBytes, chunk });

  await write(header);
  for (let i = 0; i < plan.thumbChunks; i++) {
    const last = i === plan.thumbChunks - 1;
    const part = thumbnail.subarray(i * chunk, (i + 1) * chunk);
    const { ciphertext } = await encryptAesGcm(key, part, header, nonceFor(prefix, i, last ? FLAG.thumbLast : FLAG.thumb));
    await write(ciphertext);
  }
  for (let i = 0; i < plan.contentChunks; i++) {
    signal?.throwIfAborted();
    const start = i * chunk;
    const end = Math.min(plan.padded, start + chunk);
    const plain = new Uint8Array(end - start); // zero-filled: anything past the real size is padding
    if (start < file.size) plain.set(new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer()));
    const last = i === plan.contentChunks - 1;
    const { ciphertext } = await encryptAesGcm(key, plain, header, nonceFor(prefix, i, last ? FLAG.contentLast : FLAG.content));
    await write(ciphertext);
    onProgress?.(end / plan.padded);
  }
  return { key: toBase64Url(rawKey), chunk, thumbBytes, encryptedSize: plan.total };
}

/** Reads exact byte counts from a ReadableStream. */
class StreamReader {
  constructor(stream) {
    this.reader = stream.getReader();
    this.chunks = [];
    this.length = 0;
    this.done = false;
  }

  async fill(n) {
    while (this.length < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value?.length) {
        this.chunks.push(value);
        this.length += value.length;
      }
    }
    if (this.length < n) throw new FileCryptoError('The encrypted file is incomplete — it may be damaged.');
  }

  async read(n) {
    await this.fill(n);
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    return out;
  }

  async skip(n) {
    let left = n;
    while (left > 0) {
      const step = Math.min(left, 4 * 1024 * 1024);
      await this.read(step);
      left -= step;
    }
  }

  async atEnd() {
    if (this.length) return false;
    await this.fill(0).catch(() => {});
    while (!this.done && !this.length) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value?.length) {
        this.chunks.push(value);
        this.length += value.length;
      }
    }
    return this.length === 0;
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

/**
 * Decrypts the content (or the thumbnail, with part: 'thumb') of an encrypted blob.
 * `entry` is the file's vault record: { id, size, key, chunk, thumbBytes }.
 * Returns plaintext parts suitable for `new Blob(parts)`.
 */
export async function decryptFile(stream, entry, { part = 'content', onProgress, signal } = {}) {
  const reader = new StreamReader(stream);
  try {
    const key = await importAesKey(fromBase64Url(entry.key), ['decrypt']);
    const chunk = entry.chunk || CHUNK_SIZE;
    const plan = layout({ size: entry.size, thumbBytes: entry.thumbBytes || 0, chunk });
    const header = await reader.read(HEADER_BYTES);
    if (!MAGIC.every((byte, i) => header[i] === byte)) throw new FileCryptoError('This is not a Secure Box encrypted file.');
    if (new DataView(header.buffer).getUint32(8) !== chunk) throw new FileCryptoError('The encrypted file does not match its record.');
    const idBytes = uuidToBytes(entry.id);
    if (!idBytes.every((byte, i) => header[19 + i] === byte)) throw new FileCryptoError('The encrypted file belongs to a different record.');
    const prefix = header.slice(12, 19);

    const thumb = part === 'thumb';
    if (thumb && !plan.thumbChunks) throw new FileCryptoError('This file has no thumbnail.');
    if (!thumb) await reader.skip(plan.contentStart - HEADER_BYTES);
    const chunks = thumb ? plan.thumbChunks : plan.contentChunks;
    const plainTotal = thumb ? entry.thumbBytes : plan.padded;
    const keep = thumb ? entry.thumbBytes : entry.size;

    const parts = [];
    let produced = 0;
    for (let i = 0; i < chunks; i++) {
      signal?.throwIfAborted();
      const plainLength = Math.min(chunk, plainTotal - i * chunk);
      const sealed = await reader.read(plainLength + TAG_BYTES);
      const last = i === chunks - 1;
      const flag = thumb ? (last ? FLAG.thumbLast : FLAG.thumb) : last ? FLAG.contentLast : FLAG.content;
      let plain;
      try {
        plain = await decryptAesGcm(key, nonceFor(prefix, i, flag), sealed, header);
      } catch {
        throw new FileCryptoError('This file failed its integrity check — it is damaged or was tampered with.');
      }
      const usable = Math.max(0, Math.min(plain.length, keep - produced));
      if (usable) parts.push(plain.subarray(0, usable));
      produced += usable;
      onProgress?.((i + 1) / chunks);
    }
    if (!thumb && !(await reader.atEnd())) {
      throw new FileCryptoError('The encrypted file has unexpected extra data — it may have been tampered with.');
    }
    return parts;
  } finally {
    reader.cancel();
  }
}

/**
 * Collects ciphertext and hands it to `send(piece, offset, total)` in pieces of `pieceSize`
 * (Google Drive's resumable uploads need multiples of 256 KiB, except the last piece).
 */
export function createPieceWriter({ total, send, pieceSize = 8 * 1024 * 1024, onProgress }) {
  const pending = [];
  let pendingLength = 0;
  let offset = 0;
  let result = null;

  function take(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = pending[0];
      const count = Math.min(head.length, n - filled);
      out.set(head.subarray(0, count), filled);
      filled += count;
      if (count === head.length) pending.shift();
      else pending[0] = head.subarray(count);
    }
    pendingLength -= n;
    return out;
  }

  return {
    async write(bytes) {
      pending.push(bytes);
      pendingLength += bytes.length;
      const final = offset + pendingLength === total;
      while (pendingLength >= pieceSize || (final && pendingLength > 0)) {
        const size = final && pendingLength <= pieceSize ? pendingLength : pieceSize;
        result = await send(take(size), offset, total);
        offset += size;
        onProgress?.(offset / total);
      }
      if (offset + pendingLength > total) throw new FileCryptoError('Encrypted size mismatch.');
    },
    get result() {
      return result;
    },
  };
}
