/**
 * What this browser remembers between visits so it can open the right vault quickly: which vault
 * you used last, the account you signed in with (an email), where this device's vault is, when it
 * was backed up, why the last window locked. Nothing secret. The demo keeps its own copy, so
 * trying it never changes what the real app opens.
 */
import { BROWSER_VAULT } from '../experiments.js';
import { DEMO } from './store.js';

const ns = DEMO ? 'secure-box.demo.' : 'secure-box.';
const KEYS = {
  provider: `${ns}provider`, // 'google' | 'microsoft' | 'local'
  device: `${ns}deviceVault`, // { kid, where } of this device's vault
  backups: `${ns}deviceBackupAt`, // { kid: time } of the last backup of this device's vault
  lockedAt: `${ns}lockedAt`, // last lock in any window
  keyrings: `${ns}keyrings`, // { kid: { revision, changedAt } }: when a master password last changed (#19)
  cloudVaults: `${ns}cloudVaults`, // { 'google:you@example.com': { kid, app } }: cloud accounts that had a vault
  hint: (provider) => `secure-box.loginHint.${provider === 'microsoft' ? 'microsoft' : 'google'}`,
  // Per tab (sessionStorage):
  lockReason: 'secure-box.lockReason',
  silent: 'secure-box.silentSignIn',
};

const PROVIDERS = ['google', 'microsoft', 'local'];

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function write(storage, key, value) {
  try {
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* storage blocked: fine for this visit */
  }
}

function readText(storage, key) {
  try {
    return storage.getItem(key) || '';
  } catch {
    return '';
  }
}

// The vault used last.
export function lastProvider() {
  const saved = readText(localStorage, KEYS.provider);
  return PROVIDERS.includes(saved) ? saved : null;
}
export const rememberProvider = (provider) => write(localStorage, KEYS.provider, provider);

// This device's vault: its key id and where it lives.
/** This device's vault used last: { kid, where }. One in the browser's storage only counts where that experiment is on. */
export function deviceChoice() {
  const choice = readJson(localStorage, KEYS.device, null);
  return choice?.where === 'browser' && !BROWSER_VAULT ? null : choice;
}
export const rememberDeviceChoice = (choice) => write(localStorage, KEYS.device, choice);
export function forgetDeviceChoice(kid) {
  if (deviceChoice()?.kid === kid) write(localStorage, KEYS.device, null);
}

// Cloud accounts that had a vault opened here: finding nothing there later means it was deleted,
// or that Secure Box now connects to that cloud as another app (`app`, places.js cloudApp),
// which sees nothing the one before it made.
const cloudKey = (provider, email) => `${provider}:${String(email || '').toLowerCase()}`;
export function rememberCloudVault(provider, email, kid, app = '') {
  if (!email || provider === 'local') return;
  write(localStorage, KEYS.cloudVaults, { ...readJson(localStorage, KEYS.cloudVaults, {}), [cloudKey(provider, email)]: { kid, app } });
}
export const hadCloudVault = (provider, email) => Boolean(email && readJson(localStorage, KEYS.cloudVaults, {})[cloudKey(provider, email)]);
/** The app Secure Box connected to that cloud as when this browser last opened the vault there ('' if unknown). */
export const cloudVaultApp = (provider, email) => String((email && readJson(localStorage, KEYS.cloudVaults, {})[cloudKey(provider, email)]?.app) || '');
export function forgetCloudVault(provider, email) {
  const all = readJson(localStorage, KEYS.cloudVaults, {});
  delete all[cloudKey(provider, email)];
  write(localStorage, KEYS.cloudVaults, all);
}

// Backups of this device's vault.
export const backupAt = (kid) => Number(readJson(localStorage, KEYS.backups, {})[kid]) || 0;
export function rememberBackup(kid, at) {
  const all = readJson(localStorage, KEYS.backups, {});
  all[kid] = at;
  write(localStorage, KEYS.backups, all);
}
export function forgetBackup(kid) {
  const all = readJson(localStorage, KEYS.backups, {});
  delete all[kid];
  write(localStorage, KEYS.backups, all);
}

// The account used last with each cloud (its email).
export const readHint = (provider) => readText(localStorage, KEYS.hint(provider));
export function saveHint(email, provider) {
  if (email) write(localStorage, KEYS.hint(provider), email);
}
export const clearHint = (provider) => write(localStorage, KEYS.hint(provider), null);

// Locks: when the last one happened (any window), and why this tab locked.
export function lockedAt() {
  const at = Number(readText(localStorage, KEYS.lockedAt)) || 0;
  if (at <= Date.now()) return at;
  // A time still to come was written before the clock went back (set by hand, or corrected):
  // kept, it would lock every window unlocked from now until the clock caught up with it.
  write(localStorage, KEYS.lockedAt, null);
  return 0;
}
export const rememberLock = (at = Date.now()) => write(localStorage, KEYS.lockedAt, String(at));
export const lockedAtKey = KEYS.lockedAt;
export function takeLockReason() {
  const reason = readText(sessionStorage, KEYS.lockReason);
  write(sessionStorage, KEYS.lockReason, null);
  return reason || null;
}
export const setLockReason = (reason) => write(sessionStorage, KEYS.lockReason, reason);

// Background sign-ins: at most one every 20 seconds per tab, so a problem can never loop.
export const lastSilentSignIn = () => Number(readText(sessionStorage, KEYS.silent)) || 0;
export const noteSilentSignIn = () => write(sessionStorage, KEYS.silent, String(Date.now()));

// Master password changes this browser saw, per key ring (no secrets): a copy of the key ring
// that missed one can then say so instead of "not correct" (#19).
export const keyringMemory = (kid) => readJson(localStorage, KEYS.keyrings, {})[kid] || null;

/**
 * Notes the newest revision seen of key ring `kid`; `passwordChanged` when this revision is a
 * new master password (a copy older than it still has the previous password).
 */
export function rememberKeyring(kid, revision, { passwordChanged = false } = {}) {
  if (!kid || !Number.isSafeInteger(revision) || revision <= 0) return;
  const all = readJson(localStorage, KEYS.keyrings, {});
  const known = all[kid] || {};
  if (revision < (known.revision || 0)) return;
  all[kid] = {
    revision,
    passwordRevision: passwordChanged ? revision : known.passwordRevision || 0,
    passwordChangedAt: passwordChanged ? Date.now() : known.passwordChangedAt || 0,
  };
  write(localStorage, KEYS.keyrings, all);
}
export function forgetKeyring(kid) {
  const all = readJson(localStorage, KEYS.keyrings, {});
  delete all[kid];
  write(localStorage, KEYS.keyrings, all);
}
