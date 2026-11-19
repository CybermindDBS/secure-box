/**
 * Encrypted text messages: a short armored block you can paste into a chat or an email.
 *
 *   -----BEGIN SECURE BOX MESSAGE-----
 *   base64 of:  "SBT1" | flags | message id (16) | account copy? | password copy? | iv (12) | ciphertext
 *   -----END SECURE BOX MESSAGE-----
 *
 * Same key design as .sbox files (localbox.js): the text is encrypted with a random 256-bit key,
 * kept only in locked copies. The account copy is locked with a key derived (HKDF-SHA-256) from
 * the account's master key; the optional sharing copy with a key stretched from a password
 * (PBKDF2-SHA-256, 600,000 rounds). Everything before the ciphertext is authenticated with it, so
 * no copy can be removed, swapped or moved to another message. The length is padded (Padmé).
 */
import { decryptAesGcm, deriveAesKey, encryptAesGcm, fromUtf8, importAesKey, importHkdfKey, padme, randomBytes, utf8 } from './crypto.js';

export const TEXT_ITERATIONS = 600_000;
export const MAX_TEXT_LENGTH = 1_000_000; // characters
const BEGIN = '-----BEGIN SECURE BOX MESSAGE-----';
const END = '-----END SECURE BOX MESSAGE-----';
const MAGIC = [0x53, 0x42, 0x54, 0x31]; // "SBT1"
const FLAG_ACCOUNT = 1;
const FLAG_PASSWORD = 2;
const PREFIX = 4 + 1 + 16;
const ACCOUNT_SLOT = 8 + 16 + 12 + 48;
const PASSWORD_SLOT = 4 + 16 + 12 + 48;

export class TextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TextError';
    this.code = code;
  }
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const kidBytes = (kid) => {
  if (!/^[0-9a-f]{16}$/.test(kid)) throw new TextError('bad-key', 'Unexpected account key id.');
  return Uint8Array.from(kid.match(/../g), (pair) => parseInt(pair, 16));
};
const kidText = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function accountKey(master, salt) {
  return deriveAesKey(await importHkdfKey(master.key), salt, 'secure-box local text v1');
}

async function passwordKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', utf8(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Does this text contain an encrypted message? */
export const looksLikeMessage = (text) => String(text).includes(BEGIN);

/** Encrypts `text` for this account (`master`), a sharing `password`, or both. Returns the armored block. */
export async function sealText({ text, master = null, password = '' }) {
  if (!master && !password) throw new TextError('no-key', 'A message needs your account, a sharing password, or both.');
  if (text.length > MAX_TEXT_LENGTH) throw new TextError('too-long', 'That text is too long to encrypt as a message. Encrypt it as a file instead.');
  const flags = (master ? FLAG_ACCOUNT : 0) | (password ? FLAG_PASSWORD : 0);
  const prefix = concat(new Uint8Array(MAGIC), new Uint8Array([flags]), randomBytes(16));
  const contentKey = randomBytes(32);
  const parts = [prefix];
  if (master) {
    const kid = kidBytes(master.kid);
    const salt = randomBytes(16);
    const { iv, ciphertext } = await encryptAesGcm(await accountKey(master, salt), contentKey, concat(utf8('sbt1|account|'), prefix, kid));
    parts.push(kid, salt, iv, ciphertext);
  }
  if (password) {
    const iterations = u32(TEXT_ITERATIONS);
    const salt = randomBytes(16);
    const { iv, ciphertext } = await encryptAesGcm(await passwordKey(password, salt, TEXT_ITERATIONS), contentKey, concat(utf8('sbt1|password|'), prefix, iterations));
    parts.push(iterations, salt, iv, ciphertext);
  }
  const header = concat(...parts);
  const body = utf8(text);
  const plain = new Uint8Array(padme(4 + body.length)); // zero padding after the text
  plain.set(u32(body.length), 0);
  plain.set(body, 4);
  const { iv, ciphertext } = await encryptAesGcm(await importAesKey(contentKey, ['encrypt']), plain, header);
  const lines = toBase64(concat(header, iv, ciphertext)).match(/.{1,64}/g);
  return [BEGIN, ...lines, END].join('\n');
}

/** Reads the armored block's structure; nothing secret is needed. */
export function readMessage(armored) {
  const text = String(armored);
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END, start + BEGIN.length);
  if (start < 0) throw new TextError('not-message', 'That isn’t a Secure Box message.');
  if (end < 0) throw new TextError('damaged', 'The message is cut off: copy everything from BEGIN to END.');
  let bytes;
  try {
    const b64 = text.slice(start + BEGIN.length, end).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new TextError('damaged', 'The message is damaged: some characters are missing or changed.');
  }
  if (bytes.length < PREFIX || !MAGIC.every((b, i) => bytes[i] === b)) throw new TextError('damaged', 'The message is damaged or isn’t a Secure Box message.');
  const flags = bytes[4];
  if (!flags || flags & ~(FLAG_ACCOUNT | FLAG_PASSWORD)) throw new TextError('newer', 'This message needs a newer version of Secure Box.');
  const prefix = bytes.subarray(0, PREFIX);
  let at = PREFIX;
  const take = (n) => {
    if (at + n > bytes.length) throw new TextError('damaged', 'The message is damaged: it’s shorter than it should be.');
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const message = { prefix, account: null, password: null };
  if (flags & FLAG_ACCOUNT) {
    const kid = take(8);
    message.account = { kid: kidText(kid), kidBytes: kid, salt: take(16), iv: take(12), key: take(48) };
  }
  if (flags & FLAG_PASSWORD) {
    const iterBytes = take(4);
    message.password = { iterBytes, iterations: new DataView(iterBytes.buffer, iterBytes.byteOffset, 4).getUint32(0), salt: take(16), iv: take(12), key: take(48) };
  }
  message.header = bytes.subarray(0, at);
  message.iv = take(12);
  message.ciphertext = bytes.subarray(at);
  if (message.ciphertext.length < 16 + 4) throw new TextError('damaged', 'The message is damaged: it’s shorter than it should be.');
  return message;
}

/** Who can open a message: this account, and/or a sharing password. */
export function messageAccess(message, master) {
  return { mine: Boolean(master && message.account && message.account.kid === master.kid), account: Boolean(message.account), password: Boolean(message.password) };
}

/** Decrypts a message with the account's master key or its sharing password. */
export async function openMessage(message, { master = null, password = '' } = {}) {
  let contentKey = null;
  let tried = '';
  if (master && message.account?.kid === master.kid) {
    tried = 'account';
    try {
      const a = message.account;
      contentKey = await decryptAesGcm(await accountKey(master, a.salt), a.iv, a.key, concat(utf8('sbt1|account|'), message.prefix, a.kidBytes));
    } catch {
      contentKey = null;
    }
  }
  if (!contentKey && password && message.password) {
    tried ||= 'password';
    const p = message.password;
    if (p.iterations >= 100_000 && p.iterations <= 10_000_000) {
      try {
        contentKey = await decryptAesGcm(await passwordKey(password, p.salt, p.iterations), p.iv, p.key, concat(utf8('sbt1|password|'), message.prefix, p.iterBytes));
      } catch {
        contentKey = null;
      }
    }
  }
  if (!contentKey) {
    if (tried === 'account') throw new TextError('damaged', 'The message is damaged or was changed after it was made.');
    if (tried === 'password') throw new TextError('wrong-password', 'That sharing password doesn’t open this message.');
    if (message.password) throw new TextError('needs-password', 'This message needs its sharing password.');
    throw new TextError('other-account', 'This message was encrypted with a different Secure Box account.');
  }
  let plain;
  try {
    plain = await decryptAesGcm(await importAesKey(contentKey, ['decrypt']), message.iv, message.ciphertext, message.header);
  } catch {
    throw new TextError('damaged', 'The message is damaged or was changed after it was made.');
  }
  const length = new DataView(plain.buffer, plain.byteOffset, 4).getUint32(0);
  if (length > plain.length - 4) throw new TextError('damaged', 'The message is damaged or was changed after it was made.');
  return fromUtf8(plain.subarray(4, 4 + length));
}
