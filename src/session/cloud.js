/**
 * Saving and syncing the open vault, keeping the cloud sign-in fresh (Reconnect without
 * locking), the idle and session locks, and locking every Secure Box window together.
 */
import { downloadsRunning, forgetStreams } from '../core/stream.js';
import { GoogleError, reconnectWithPopup } from '../core/google.js';
import { MicrosoftError, reconnectMicrosoftWithPopup, refreshMicrosoft } from '../core/microsoft.js';
import { VaultError, applyChange, parseEnvelope } from '../core/vault.js';
import { answerAll, ask, confirmDialog, toast } from './bridge.js';
import { files } from './files.js';
import { lockedAt, rememberLock, setLockReason } from './memory.js';
import { companyName, isDevice, providerName } from './places.js';
import { DEMO, pause, publish, state } from './store.js';
import { tools } from './tools.js';
import { editingDirty, editingName } from './viewer.js';
import { channel } from './windows.js';

// ===========================================================================
// Saving & syncing
// ===========================================================================
export let saveChain = Promise.resolve();
let syncLabelTimer = 0;

/** Saves `change` on top of the newest copy of the vault (another device may have saved since). */
export function commit(change) {
  const run = async () => {
    setSyncStatus('saving');
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if ((await state.backend.vaultRevision()) !== state.rev) await pullLatest();
        const next = applyChange(state.vault, change);
        let rev;
        try {
          // OneDrive replaces the vault only if it's still the version we read; if not, go round again.
          rev = await state.backend.writeVault(await state.cipher.seal(next), state.rev);
        } catch (err) {
          if (err?.code === 'conflict') continue;
          throw err;
        }
        state.vault = next;
        state.rev = rev;
        state.lastSync = Date.now();
        setSyncStatus('saved');
        return next;
      }
      throw new Error('The vault keeps changing on another device. Try again in a moment.');
    } catch (err) {
      setSyncStatus('error');
      // The vault was deleted outside Secure Box: once it's back, this change is saved after all.
      if (isGone(err) && (await vaultGone(err))) return run();
      throw err;
    }
  };
  const result = saveChain.then(run, run);
  saveChain = result.catch(() => {});
  return result;
}

/** Reads the newest copy of the vault. Resolves true when it changed. */
export async function pullLatest() {
  const { text, rev } = await state.backend.readVault();
  if (rev === state.rev) {
    state.lastSync = Date.now();
    return false;
  }
  const envelope = parseEnvelope(text, state.cipher.format);
  if (envelope.kid !== state.cipher.kid) throw new VaultError('wrong-key', 'The vault was re-keyed on another device. Lock and unlock again.');
  state.vault = await state.cipher.open(envelope);
  state.rev = rev;
  state.lastSync = Date.now();
  publish();
  return true;
}

export async function syncNow({ quiet = false } = {}) {
  if (!state.unlocked || state.switching) return;
  if (!quiet) await ensureDrive();
  else if (!driveFresh(60_000)) return;
  setSyncStatus('syncing');
  try {
    await saveChain;
    const changed = await pullLatest();
    if (changed && !state.vault.items.some((it) => it.id === state.selectedId)) state.selectedId = null;
    setSyncStatus('saved');
    files.vaultChanged();
    if (!quiet) toast(changed ? 'Updated with changes from another device' : 'Already up to date');
  } catch (err) {
    setSyncStatus('error');
    if (isGone(err)) {
      if (await vaultGone(err)) setSyncStatus('saved');
      return;
    }
    if (!quiet) toast(`Sync failed: ${err.message}`, 'error');
  }
}

/** The open vault was deleted (or put in the bin) outside Secure Box. */
export const isGone = (err) => err?.code === 'gone' || err?.code === 'trashed';

let goneAsking = null;

/**
 * The open vault was deleted or moved outside Secure Box (or put in the bin), so nothing can be
 * saved to it. One dialog, however many things noticed it at once, offers the ways back: find it
 * again, take it out of the bin, save what's open again, or lock. Resolves true once it's back.
 */
export function vaultGone(err) {
  if (!state.unlocked) return Promise.resolve(false);
  goneAsking ??= import('./gone.js')
    .then(({ recoverVault }) => recoverVault(err))
    .finally(() => {
      goneAsking = null;
    });
  return goneAsking;
}

export function setSyncStatus(status) {
  clearTimeout(syncLabelTimer);
  state.sync = status;
  publish();
  if (status === 'saved') syncLabelTimer = setTimeout(() => setSyncStatus('idle'), 2200);
}

export const syncLabel = (status) =>
  ({ saving: 'Saving…', syncing: 'Syncing…', saved: 'Saved', error: 'Not saved' })[status] || (isDevice() ? 'Encrypted · on this device' : 'Encrypted · synced');

export function describeSaveError(err) {
  const cloud = err instanceof GoogleError || err instanceof MicrosoftError;
  if (cloud && err.code === 'expired') return `${providerName()} access expired — nothing was saved. Reconnect and try again.`;
  if (cloud && err.code === 'network') return 'You seem to be offline — nothing was saved. Try again.';
  if (err?.code === 'cancelled') return err.message;
  return `Couldn’t save: ${err.message}`;
}

// ===========================================================================
// Cloud access: tokens last an hour; reconnect without locking
// ===========================================================================
export function driveFresh(margin = 5 * 60_000) {
  return DEMO || !state.backend || state.backend.tokenExpiresAt() - Date.now() > margin;
}

/** Takes a fresher token for the same account (from this or another window). */
export function useToken({ accessToken, expiresAt, refreshToken }) {
  if (!state.auth || !(expiresAt > state.auth.expiresAt)) return false;
  state.auth.accessToken = accessToken;
  state.auth.expiresAt = expiresAt;
  if (refreshToken) state.auth.refreshToken = refreshToken;
  forgetStreams();
  return true;
}

/** Another window shared a fresher token for this account: an open Reconnect dialog can go. */
export function tokenFromElsewhere(data) {
  if (data.sub !== state.identity?.sub || typeof data.accessToken !== 'string' || !useToken(data)) return;
  if (reconnecting) {
    toast(`Reconnected to ${providerName()}`);
    answerAll('reconnect', true);
  }
}

let refreshing = null;

/** Microsoft: renews the access token in the background with the refresh token, and shares it. */
export function refreshQuietly() {
  if (state.auth?.provider !== 'microsoft' || !state.auth.refreshToken) return Promise.resolve(false);
  refreshing ??= refreshMicrosoft(state.config.microsoftClientId, state.auth)
    .then((next) => {
      useToken(next);
      channel?.postMessage({ type: 'token', sub: state.identity.sub, accessToken: next.accessToken, expiresAt: next.expiresAt });
      return true;
    })
    .catch((err) => {
      console.warn('Microsoft token refresh:', err);
      return false;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

let reconnecting = null;

/** The Reconnect dialog's button: signs in again in a pop-up, for the same account. */
export async function reconnectNow(signal) {
  const microsoft = state.auth?.provider === 'microsoft';
  const result = microsoft
    ? await reconnectMicrosoftWithPopup({ clientId: state.config.microsoftClientId, loginHint: state.identity.email, previous: state.auth, signal })
    : await reconnectWithPopup({ clientId: state.config.googleClientId, loginHint: state.identity.email, expectedSub: state.identity.sub, signal });
  useToken(result);
  // Every other Secure Box window of this browser can use the new token too.
  channel?.postMessage({ type: 'token', sub: state.identity.sub, accessToken: result.accessToken, expiresAt: result.expiresAt });
  toast(`Reconnected to ${providerName()}`);
}

/** Resolves when the cloud can be used. Asks to Reconnect (one click) when the sign-in ran out. */
export async function ensureDrive() {
  if (driveFresh()) return;
  if (await refreshQuietly()) return;
  reconnecting ??= ask('reconnect', {
    provider: state.provider,
    title: `Reconnect ${providerName()}`,
    text:
      state.auth?.provider === 'microsoft'
        ? 'Microsoft asks you to sign in again once a day. Reconnect to keep working — your vault stays unlocked.'
        : 'For your security, Google’s access lasts one hour. Reconnect to keep working — your vault stays unlocked.',
    company: companyName(),
  }).finally(() => {
    reconnecting = null;
  });
  const ok = await reconnecting;
  if (!ok) throw new GoogleError('cancelled', `${providerName()} is disconnected. Reconnect to continue.`);
}

// ===========================================================================
// Auto-lock
// ===========================================================================
let autoLockStarted = false;
let activityShared = 0;
let lastActivity = Date.now();

export const idleLimit = () => Math.max(1, Number(state.config?.autoLockMinutes) || 10) * 60_000;
export const sessionLimit = () => Math.min(12, Math.max(1, Number(state.config?.sessionHours) || 8)) * 3_600_000;
export const lastActive = () => lastActivity;

/** Activity in any Secure Box window keeps every window unlocked (shared at most every 15 s). */
export function noteActivity(at = Date.now()) {
  lastActivity = Math.max(lastActivity, Math.min(Date.now(), at));
  if (channel && state.unlocked && at - activityShared > 15_000) {
    activityShared = at;
    channel.postMessage({ type: 'activity', at });
  }
}

const mediaPlaying = () => [...document.querySelectorAll('video, audio')].some((m) => !m.paused);

export function startAutoLock() {
  if (autoLockStarted) return;
  autoLockStarted = true;
  lastActivity = Date.now();
  const touch = () => noteActivity();
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input']) {
    document.addEventListener(type, touch, { capture: true, passive: true });
  }
  setInterval(checkAutoLock, 5000);
  // Microsoft: renew the hour-long access token in the background, before anything needs it.
  setInterval(() => {
    if (state.unlocked && state.auth?.provider === 'microsoft' && !driveFresh(10 * 60_000)) refreshQuietly();
  }, 60_000);
  window.addEventListener('pageshow', checkAutoLock);
  document.addEventListener('visibilitychange', () => {
    checkAutoLock();
    if (document.visibilityState === 'visible' && state.unlocked && Date.now() - state.lastSync > 60_000 && !document.querySelector('dialog[open]')) syncNow({ quiet: true });
  });
}

let checkingLock = false;
let lockWaits = false; // the session limit passed while transfers were running

export async function checkAutoLock() {
  if (!state.unlocked || checkingLock) return;
  // The clock went back: times noted before count from now, or the vault would stay open until
  // the clock caught up with them.
  const now = Date.now();
  if (lastActivity > now) lastActivity = now;
  if (state.unlockedAt > now) state.unlockedAt = now;
  // Another window locked while this one was asleep or in the back/forward cache.
  if (lockedAt() > state.unlockedAt) return lock('other', { fromOtherWindow: true });
  // Uploads, local encryption and playing media count as activity.
  if (files.busy() || tools.busy() || state.device.busy || mediaPlaying()) noteActivity();
  const reason = Date.now() - lastActivity >= idleLimit() ? 'idle' : Date.now() - state.unlockedAt >= sessionLimit() ? 'expired' : null;
  if (!reason) return;
  checkingLock = true;
  try {
    // What's under way in any window (uploads, downloads, work on this device's vault) finishes
    // first: locking would stop it. Paused uploads don't hold the lock: they wait for Reconnect,
    // and a vault must never stay open for something that won't finish by itself.
    const running = await transfersRunning();
    if (!state.unlocked) return;
    if (running.total) {
      if (reason === 'expired' && !lockWaits) {
        lockWaits = true;
        toast(`Your session is over. Secure Box locks once ${running.total === 1 ? 'the transfer finishes' : 'the transfers finish'}.`);
      }
      return;
    }
    lock(reason);
  } finally {
    checkingLock = false;
  }
}

/**
 * What a lock would stop, in this window and the others: uploads under way, uploads paused until
 * Reconnect, downloads (any window), and work on the vault on this device (a move, backup or
 * restore). `total` counts what is under way, which a lock waits for; paused uploads aren't in it.
 */
export async function transfersRunning() {
  const [elsewhere, downloads] = await Promise.all([busyElsewhere(), downloadsRunning()]);
  const uploads = files.runningCount() + elsewhere.uploads;
  const paused = files.pausedCount() + elsewhere.paused;
  const device = (state.device.busy ? 1 : 0) + elsewhere.device;
  return { uploads, paused, downloads, device, total: uploads + downloads + device };
}

/** What the other Secure Box windows of this browser have under way (they answer at once). */
function busyElsewhere(wait = 300) {
  const found = { uploads: 0, paused: 0, device: 0 };
  if (!channel) return Promise.resolve(found);
  const id = crypto.randomUUID();
  const onMessage = ({ data }) => {
    if (data?.type !== 'busy' || data.id !== id) return;
    found.uploads += Number(data.uploads) || 0;
    found.paused += Number(data.paused) || 0;
    found.device += data.device ? 1 : 0;
  };
  channel.addEventListener('message', onMessage);
  channel.postMessage({ type: 'busy?', id });
  return new Promise((resolve) =>
    setTimeout(() => {
      channel.removeEventListener('message', onMessage);
      resolve(found);
    }, wait),
  );
}

export const counted = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');

/** Lock (button, menu): asks first when locking would stop something, since nothing asks after. */
export async function lockWhenAsked() {
  const running = await transfersRunning();
  const uploads = running.uploads + running.paused;
  const what = [counted(uploads, 'upload', 'uploads'), counted(running.downloads, 'download', 'downloads')].filter(Boolean).join(' and ');
  const unsaved = editingDirty() ? editingName() : '';
  if (what || running.device || unsaved) {
    const n = uploads + running.downloads;
    const ok = await confirmDialog({
      title: 'Lock now?',
      message: [
        unsaved && `Your changes to “${unsaved}” aren’t saved, and locking discards them.`,
        what && `${what[0].toUpperCase()}${what.slice(1)} ${n === 1 ? 'hasn’t' : 'haven’t'} finished. Locking now stops ${n === 1 ? 'it' : 'them'}.`,
        running.device && 'Your vault on this device is still being moved, backed up or restored, and locking stops that partway.',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Lock anyway',
      danger: true,
    });
    if (!ok) return;
  }
  lock('manual');
}

/**
 * Locks this window, and every other Secure Box window of this browser with it (they share one
 * session). `fromOtherWindow` marks a lock that another window started.
 */
export async function lock(reason = 'manual', { fromOtherWindow = false } = {}) {
  if (reason !== 'manual' && !state.unlocked) return;
  const wasUnlocked = state.unlocked;
  state.unlocked = false;
  if (wasUnlocked && !fromOtherWindow) {
    rememberLock();
    channel?.postMessage({ type: 'lock', reason });
  }
  if (reason === 'manual' || fromOtherWindow) await Promise.race([saveChain, pause(4000)]);
  forgetStreams();
  // Uploads that hadn't finished stop with the page: the unlock card says so ("idle:2").
  const kind = reason === 'manual' && fromOtherWindow ? 'other' : reason;
  const stopped = files.unfinishedCount();
  setLockReason(stopped ? `${kind}:${stopped}` : kind);
  // Reloading is the most reliable way to drop every decrypted secret, key and token from memory.
  location.replace(`${location.pathname}${DEMO ? '?demo' : ''}`);
}
