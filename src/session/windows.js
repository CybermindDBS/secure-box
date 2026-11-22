/**
 * Secure Box windows of this browser share one session over a BroadcastChannel: an unlocked
 * window hands its session to a new one (in memory only, never to disk), locking locks them all,
 * a fresh cloud token reaches every window, and activity anywhere keeps them all unlocked. Only
 * pages from Secure Box's own address can join, and the demo has a channel of its own.
 */
import { idleLimit, lastActive, lock, noteActivity, sessionLimit, syncNow, tokenFromElsewhere } from './cloud.js';
import { files } from './files.js';
import { lockedAt, lockedAtKey } from './memory.js';
import { isDevice } from './places.js';
import { DEMO, state } from './store.js';
import { joinOtherWindow, refreshKeyringFromElsewhere } from './vaults.js';

export const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DEMO ? 'secure-box-session-demo' : 'secure-box-session') : null;

/** What an unlocked window hands to a new one. */
export function sessionToShare() {
  const fresh = Date.now() - lastActive() < idleLimit() && Date.now() - state.unlockedAt < sessionLimit();
  if (!state.unlocked || !state.master || (!DEMO && !isDevice() && !state.auth) || !fresh || lockedAt() > state.unlockedAt) return null;
  return {
    vault: isDevice() ? { provider: 'local', where: state.backend.where, kid: state.master.kid } : { provider: state.provider },
    // The access token only: a Microsoft refresh token stays in the window that signed in.
    auth: DEMO || isDevice() ? null : { provider: state.auth.provider || 'google', accessToken: state.auth.accessToken, expiresAt: state.auth.expiresAt, identity: { ...state.identity }, driveGranted: true },
    master: { kid: state.master.kid, key: state.master.key },
    unlockedAt: state.unlockedAt,
  };
}

export function validSession(s) {
  const auth = s?.auth;
  const authOk = DEMO || s?.vault?.provider === 'local' || (typeof auth?.accessToken === 'string' && Number.isFinite(auth.expiresAt) && typeof auth.identity?.sub === 'string');
  return Boolean(
    authOk && s.master && typeof s.master.kid === 'string' && s.master.key instanceof Uint8Array && s.master.key.length === 32
      && Number.isFinite(s.unlockedAt) && s.unlockedAt > lockedAt() && Date.now() - s.unlockedAt < sessionLimit(),
  );
}

let listening = false;

export function listenToOtherWindows() {
  if (!channel || listening) return;
  listening = true;
  channel.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'request': {
        const session = sessionToShare();
        if (session) channel.postMessage({ type: 'offer', id: data.id, session });
        break;
      }
      case 'lock':
        if (state.unlocked) lock(data.reason, { fromOtherWindow: true });
        break;
      case 'vault-changed':
        // Another window saved to this device's vault: pick it up.
        if (state.unlocked && isDevice() && data.kid === state.master?.kid) syncNow({ quiet: true });
        break;
      case 'busy?':
        // Another window is about to lock: it waits for what's under way here, and says what it stops.
        if (state.unlocked) channel.postMessage({ type: 'busy', id: data.id, uploads: files.runningCount(), paused: files.pausedCount(), device: Boolean(state.device.busy || state.moving) });
        break;
      case 'vault-moved': {
        // Another window moved the vault this one has open (migrate.js): the place it reads from is cleared.
        const same = data.provider === 'local' ? isDevice() && state.master?.kid === data.kid : state.provider === data.provider && state.identity?.sub === data.sub;
        if (state.unlocked && same) lock('moved', { fromOtherWindow: true });
        break;
      }
      case 'keyring-changed':
        // Another window changed a key ring (master password, Emergency Kit): use its copy too.
        if (state.unlocked && typeof data.kid === 'string') refreshKeyringFromElsewhere(data.kid);
        break;
      case 'activity':
        if (state.unlocked && Number.isFinite(data.at)) noteActivity(data.at);
        break;
      case 'token':
        tokenFromElsewhere(data);
        break;
      case 'unlocked': {
        // Unlocking one window unlocks the others that are waiting at sign-in or unlock.
        const waiting = ['places', 'unlock'].includes(state.gate?.panel);
        if (!state.unlocked && waiting && (!state.identity || state.identity.sub === data.sub)) {
          joinOtherWindow(state.auth && state.auth.expiresAt - Date.now() > 60_000 ? state.auth : null);
        }
        break;
      }
      default:
    }
  });
  // Backup for locks: fires in every other window when the shared lock time changes.
  window.addEventListener('storage', (event) => {
    if (event.key === lockedAtKey && state.unlocked && Number(event.newValue) > state.unlockedAt) lock('other', { fromOtherWindow: true });
  });
}

/** Asks the other Secure Box windows of this browser for an unlocked session. */
export function requestSession(timeout = 400) {
  if (!channel) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (session) => {
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      resolve(session);
    };
    const onMessage = ({ data }) => {
      if (data?.type === 'offer' && data.id === id && validSession(data.session)) done(data.session);
    };
    const timer = setTimeout(() => done(null), timeout);
    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'request', id });
  });
}
