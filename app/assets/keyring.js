/**
 * The key ring protects an account's master key ("p1": 32 random bytes).
 *
 * p1 is stored in Google Drive only in wrapped (encrypted) form, twice:
 *   password slot  AES-256-GCM key from the master password via PBKDF2-SHA-256 (600,000 rounds)
 *   recovery slot  AES-256-GCM key from the Emergency Kit's recovery key (256 random bits, HKDF)
 * Neither the master password nor the recovery key is ever stored anywhere.
 * Making a new Emergency Kit replaces the recovery slot, so an old kit stops working.
 */
import { decryptAesGcm, deriveAesKey, encryptAesGcm, fromBase64, importHkdfKey, randomBytes, toBase64, toHex, utf8 } from './crypto.js';

export const KEYRING_FILE_NAME = 'Secure Box Key Ring.json';
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;
const FORMAT = 'unibox-keyring';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class KeyringError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyringError';
    this.code = code;
  }
}

const aad = (kid, slot, extra = '') => utf8(`${FORMAT}:1:${kid}:${slot}${extra ? `:${extra}` : ''}`);

async function passwordKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', utf8(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const recoveryKey = async (bytes, salt) => deriveAesKey(await importHkdfKey(bytes), salt, 'unibox/recovery-key/v1');

async function seal(key, p1, additionalData) {
  const { iv, ciphertext } = await encryptAesGcm(key, p1, additionalData);
  return { iv: toBase64(iv), wrapped: toBase64(ciphertext) };
}

async function open(key, slot, additionalData) {
  try {
    const p1 = await decryptAesGcm(key, fromBase64(slot.iv), fromBase64(slot.wrapped), additionalData);
    return p1.length === 32 ? p1 : null;
  } catch {
    return null;
  }
}

async function passwordSlot(master, password) {
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt, PBKDF2_ITERATIONS);
  return { kdf: 'PBKDF2-SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt), ...(await seal(key, master.key, aad(master.kid, 'password'))) };
}

async function recoverySlot(master, recovery) {
  const salt = randomBytes(16);
  const key = await recoveryKey(recovery.bytes, salt);
  return { id: recovery.id, created: new Date().toISOString(), salt: toBase64(salt), ...(await seal(key, master.key, aad(master.kid, 'recovery', recovery.id))) };
}

// ---------------------------------------------------------------------------
// Recovery keys: 256 random bits written as 13 groups of 4 Crockford base-32 characters
// ---------------------------------------------------------------------------
export function encodeRecoveryKey(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

export function decodeRecoveryKey(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 52 || /[^0-9A-HJKMNP-TV-Z]/.test(clean)) {
    throw new KeyringError('bad-recovery', 'That doesn’t look like a recovery key — check it against your Emergency Kit.');
  }
  const bytes = new Uint8Array(32);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    value = (value << 5) | CROCKFORD.indexOf(char);
    bits += 5;
    if (bits >= 8 && index < 32) {
      bytes[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return bytes;
}

export function newRecoveryKey() {
  const bytes = randomBytes(32);
  return { id: toHex(randomBytes(4)), bytes, text: encodeRecoveryKey(bytes) };
}

// ---------------------------------------------------------------------------
// Key ring lifecycle
// ---------------------------------------------------------------------------
/** `master` is only ever passed by the demo, which uses a fixed key so its windows can share it. */
export async function createKeyring(password, master = { kid: toHex(randomBytes(8)), key: randomBytes(32) }) {
  const recovery = newRecoveryKey();
  const doc = {
    format: FORMAT,
    version: 1,
    kid: master.kid,
    created: new Date().toISOString(),
    note: 'Secure Box key ring. Your master key is stored here only in encrypted form: it needs your master password or Emergency Kit. Do not edit or delete this file.',
    password: await passwordSlot(master, password),
    recovery: await recoverySlot(master, recovery),
  };
  return { doc, master, recovery };
}

export function parseKeyring(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new KeyringError('bad-keyring', 'The key ring file in your Drive is damaged.');
  }
  const slotOk = (s) => s && typeof s.salt === 'string' && typeof s.iv === 'string' && typeof s.wrapped === 'string';
  if (!doc || doc.format !== FORMAT || typeof doc.kid !== 'string' || !slotOk(doc.password) || !slotOk(doc.recovery)) {
    throw new KeyringError('bad-keyring', 'The key ring file in your Drive is damaged.');
  }
  if (doc.version !== 1) throw new KeyringError('bad-keyring', 'This key ring was written by a newer version of Secure Box.');
  return doc;
}

export const serializeKeyring = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

export async function unlockWithPassword(doc, password) {
  const iterations = Math.max(100_000, Number(doc.password.iterations) || PBKDF2_ITERATIONS);
  const key = await passwordKey(password, fromBase64(doc.password.salt), iterations);
  const p1 = await open(key, doc.password, aad(doc.kid, 'password'));
  if (!p1) throw new KeyringError('wrong-password', 'That master password is not correct.');
  return { kid: doc.kid, key: p1 };
}

export async function unlockWithRecovery(doc, recoveryText) {
  const key = await recoveryKey(decodeRecoveryKey(recoveryText), fromBase64(doc.recovery.salt));
  const p1 = await open(key, doc.recovery, aad(doc.kid, 'recovery', doc.recovery.id));
  if (!p1) {
    throw new KeyringError('wrong-recovery', 'This recovery key doesn’t match your account. A newer Emergency Kit may have replaced it.');
  }
  return { kid: doc.kid, key: p1 };
}

export async function withNewPassword(doc, master, password) {
  return { ...doc, password: await passwordSlot(master, password) };
}

export async function withNewRecovery(doc, master) {
  const recovery = newRecoveryKey();
  return { doc: { ...doc, recovery: await recoverySlot(master, recovery) }, recovery };
}

// ---------------------------------------------------------------------------
// Emergency Kit file and password strength
// ---------------------------------------------------------------------------
export function emergencyKitText({ email, recovery }) {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    'SECURE BOX EMERGENCY KIT',
    '========================',
    '',
    `Account:          ${email || '(your Google account)'}`,
    `Created:          ${date}`,
    `Recovery key ID:  ${recovery.id}`,
    '',
    'RECOVERY KEY',
    '',
    `    ${recovery.text}`,
    '',
    'What it is for',
    '  If you forget your Secure Box master password, this key lets you set a new one:',
    '  open Secure Box, continue with Google, choose "Forgot master password?" and load this file.',
    '',
    'Keep it safe',
    '  * Print it, or keep it on a USB stick, somewhere only you can reach.',
    '  * Never store it in Google Drive or send it by email: together with your Google',
    '    account it unlocks everything in your vault.',
    '  * Making a new Emergency Kit (Secure Box menu) cancels this one.',
    '',
  ].join('\r\n');
}

export function recoveryKeyFromKit(text) {
  const match = String(text).match(/[0-9A-Z]{4}(?:-[0-9A-Z]{4}){12}/i);
  if (!match) throw new KeyringError('bad-recovery', 'No recovery key found in that file. Choose your Secure Box Emergency Kit.');
  return match[0];
}

/** Rough strength estimate (character pool × length, discounted for repetition). */
export function passwordStrength(password) {
  const pw = String(password || '');
  if (!pw) return { score: 0, label: '', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const chars = [...pw];
  const variety = new Set(chars).size / chars.length;
  const bits = Math.round(chars.length * Math.log2(Math.max(pool, 2)) * Math.min(1, 0.35 + variety));
  const score = bits < 45 ? 1 : bits < 65 ? 2 : bits < 85 ? 3 : 4;
  return { score, bits, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

export function passwordProblem(password, confirm) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters — a short sentence works well.`;
  if (passwordStrength(password).score < 2) return 'That password is too easy to guess. Add more words or characters.';
  if (confirm !== undefined && password !== confirm) return 'The two passwords don’t match.';
  return '';
}
