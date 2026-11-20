/**
 * The key ring protects an account's master key ("p1": 32 random bytes).
 *
 * p1 is stored (in each vault: Google Drive, OneDrive, this device) only in wrapped form, twice:
 *   password slot  AES-256-GCM key from the master password via PBKDF2-SHA-256 (600,000 rounds)
 *   recovery slot  AES-256-GCM key from the Emergency Kit's recovery key (256 random bits, HKDF)
 * Neither the master password nor the recovery key is ever stored anywhere.
 * Making a new Emergency Kit replaces the recovery slot, so an old kit stops working.
 *
 * All of a person's vaults share one master key, so each keeps a copy of the same key ring. Every
 * change (new password, new kit) bumps its revision, and the newest copy replaces older ones. The
 * revision is signed with the master key itself, so an old copy can't be passed off as newer.
 */
import { decryptAesGcm, deriveAesKey, encryptAesGcm, fromBase64, hmacSha256, importHkdfKey, randomBytes, toBase64, toBase64Url, toHex, utf8 } from './crypto.js';

export const KEYRING_FILE_NAME = 'Secure Box Key Ring.json';
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;
const FORMAT = 'secure-box-keyring';
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

const recoveryKey = async (bytes, salt) => deriveAesKey(await importHkdfKey(bytes), salt, 'secure-box/recovery-key/v1');

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
  return { doc: await signRevision(doc, master, 1), master, recovery };
}

export function parseKeyring(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new KeyringError('bad-keyring', 'The key ring file is damaged.');
  }
  const slotOk = (s) => s && typeof s.salt === 'string' && typeof s.iv === 'string' && typeof s.wrapped === 'string';
  if (typeof doc?.format === 'string' && doc.format !== FORMAT && doc.format.endsWith('-keyring')) {
    // Intact, but in a format this version doesn't read (Secure Box is still changing its formats).
    throw new KeyringError('other-version', `This key ring was made by another version of Secure Box (“${doc.format}”), so this one can’t open it.`);
  }
  if (!doc || doc.format !== FORMAT || typeof doc.kid !== 'string' || !slotOk(doc.password) || !slotOk(doc.recovery)) {
    throw new KeyringError('bad-keyring', 'The key ring file is damaged.');
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
  return signRevision({ ...doc, password: await passwordSlot(master, password) }, master, trustedRevision(doc) + 1);
}

export async function withNewRecovery(doc, master) {
  const recovery = newRecoveryKey();
  return { doc: await signRevision({ ...doc, recovery: await recoverySlot(master, recovery) }, master, trustedRevision(doc) + 1), recovery };
}

// ---------------------------------------------------------------------------
// Revisions: which copy of a key ring is the newest
// ---------------------------------------------------------------------------
async function revisionKey(master) {
  const base = await crypto.subtle.importKey('raw', master.key, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('secure-box/keyring-revision/v1') }, base, 256));
}
const revisionData = (doc, revision) => utf8(JSON.stringify([FORMAT, doc.kid, revision, doc.password, doc.recovery]));

/** Stamps `doc` with `revision`, signed with the master key (HMAC over the key slots). */
export async function signRevision(doc, master, revision) {
  const mac = toBase64Url(await hmacSha256(await revisionKey(master), revisionData(doc, revision)));
  const signed = { ...doc, revision, updated: new Date().toISOString(), revisionMac: mac };
  checked.set(signed, revision);
  return signed;
}

const checked = new WeakMap(); // doc -> revision, once verified with the master key

/** Verifies a copy's revision with the master key; an unsigned or altered one counts as 0. */
export async function verifyRevision(doc, master) {
  let revision = 0;
  if (Number.isSafeInteger(doc.revision) && doc.revision > 0 && typeof doc.revisionMac === 'string' && doc.kid === master.kid) {
    const expected = toBase64Url(await hmacSha256(await revisionKey(master), revisionData(doc, doc.revision)));
    if (expected === doc.revisionMac) revision = doc.revision;
  }
  checked.set(doc, revision);
  return revision;
}

/** A copy's revision after verifyRevision() (0 before, or when it didn't check out). */
export const trustedRevision = (doc) => checked.get(doc) ?? 0;

// ---------------------------------------------------------------------------
// Emergency Kit file and password strength
// ---------------------------------------------------------------------------
export function emergencyKitText({ email, recovery }) {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    'SECURE BOX EMERGENCY KIT',
    '========================',
    '',
    `Vault:            ${email || 'This device'}`,
    `Created:          ${date}`,
    `Recovery key ID:  ${recovery.id}`,
    '',
    'RECOVERY KEY',
    '',
    `    ${recovery.text}`,
    '',
    'What it is for',
    '  If you forget your Secure Box master password, this key lets you set a new one:',
    '  open Secure Box and your vault, choose "Forgot master password?" and load this file.',
    '',
    'Keep it safe',
    '  * Print it, or keep it on a USB stick, somewhere only you can reach.',
    '  * Never store it in your cloud drive (Google Drive, OneDrive) or send it by email:',
    '    together with access to your vaults it unlocks everything in them.',
    '  * It works for all your Secure Box vaults: they share one master key.',
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
