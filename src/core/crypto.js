/**
 * Dependency-free crypto helpers built on WebCrypto.
 * Runs in modern browsers and in Node 20+ (the test suite imports this file).
 */
const webcrypto = globalThis.crypto;
const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text) => encoder.encode(text);
export const fromUtf8 = (bytes) => decoder.decode(bytes);
const asBytes = (data) => (typeof data === 'string' ? utf8(data) : data);

export function randomBytes(length) {
  return webcrypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const toBase64Url = (bytes) =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data) {
  return toHex(new Uint8Array(await subtle.digest('SHA-256', asBytes(data))));
}

export async function hmacSha256(key, data) {
  const hmacKey = await subtle.importKey('raw', asBytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', hmacKey, asBytes(data)));
}

/** Import high-entropy key material once, as a non-extractable HKDF base key. */
export function importHkdfKey(keyMaterial) {
  return subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveKey']);
}

/** Derive a non-extractable AES-256-GCM key from an HKDF base key (HKDF-SHA-256). */
export function deriveAesKey(baseKey, salt, info) {
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Import a raw 256-bit key for AES-GCM (non-extractable). */
export function importAesKey(raw, usages = ['encrypt', 'decrypt']) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

export async function encryptAesGcm(key, plaintext, additionalData, iv = randomBytes(12)) {
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

export async function decryptAesGcm(key, iv, ciphertext, additionalData) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, ciphertext));
}

/**
 * Padmé length padding (Nikitin et al., "Reducing Metadata Leakage from Encrypted Files and
 * Communication with PURBs", PETS 2019). Rounds a length up so that it leaks only O(log log L)
 * bits about the real size, with at most ~12% overhead. Everything is at least 256 bytes.
 */
export function padme(length) {
  const L = Math.max(length, 256);
  const E = Math.floor(Math.log2(L));
  const S = Math.floor(Math.log2(E)) + 1;
  const step = 2 ** (E - S);
  return Math.ceil(L / step) * step;
}

// ---------------------------------------------------------------------------
// Password generator
// Look-alike characters (I l 1 O 0) are left out so passwords are easy to read.
// ---------------------------------------------------------------------------
export const CHARSETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!#$%&*+-=?@^_~',
};

/** Unbiased random integer in [0, max). */
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do webcrypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

function pools({ upper = true, lower = true, digits = true, symbols = true }) {
  const list = [];
  if (upper) list.push(CHARSETS.upper);
  if (lower) list.push(CHARSETS.lower);
  if (digits) list.push(CHARSETS.digits);
  if (symbols) list.push(CHARSETS.symbols);
  if (list.length === 0) list.push(CHARSETS.lower);
  return list;
}

/** Random password that contains at least one character from every selected set. */
export function generatePassword(options = {}) {
  const length = Math.max(4, Math.min(128, Math.round(options.length || 20)));
  const sets = pools(options);
  const alphabet = sets.join('');
  const chars = sets.map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(alphabet[randomInt(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join('');
}

export function passwordEntropyBits(options = {}) {
  const length = Math.max(4, Math.min(128, Math.round(options.length || 20)));
  return Math.floor(length * Math.log2(pools(options).join('').length));
}
