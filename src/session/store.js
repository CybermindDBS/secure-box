/**
 * The session's state, shared by the session modules (which change it) and the React components
 * (which show it). Components subscribe and read; they never change it themselves.
 *
 * Fields are replaced, not changed in place, whenever the screen should notice (a new vault
 * object, a new Set of revealed fields…): components compare by identity.
 */
export const DEMO = new URLSearchParams(location.search).has('demo');

/** A tiny observable value: get(), set(next or patch), subscribe(listener). */
export function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const state = {
  // Where: the vault that's open, or the one being opened from the Vault tab.
  config: null,
  provider: null, // 'google' | 'microsoft' | 'local'
  backend: null,
  auth: null,
  identity: null,
  auths: {}, // cloud sign-ins of this session, by provider
  demoBackend: null, // the demo's stand-in for the clouds
  streaming: false,
  // Found before unlocking.
  loaded: null, // { keyring, vault } as read from the place
  keyringDoc: null,
  pendingApp: null,
  pendingKit: null,
  adoptDoc: null, // a key ring brought from another vault, for a new vault with the same master password
  devicePick: null, // this device's folder vault that needs the browser's permission first
  // The unlocked session.
  unlocked: false,
  unlockedAt: 0,
  master: null,
  masters: new Map(), // every key ring unlocked this session: kid -> { master, keyringDoc }
  kids: {}, // the key id each vault turned out to use, by provider
  cipher: null,
  vault: null,
  rev: null,
  lastSync: 0,
  switching: null, // the vault opening instead, while it opens: { provider, step, since }
  moving: false, // the open vault is being moved or copied to another place (migrate.js)
  // What the screen shows.
  section: 'vault', // locked: 'vault' | 'tools'; unlocked: 'passwords' | 'files' | 'tools'
  gate: { panel: 'loading' }, // the Vault tab's card while locked
  lockMessage: '', // why this window locked, shown once on the unlock card
  sync: 'idle', // 'idle' | 'saving' | 'syncing' | 'saved' | 'error'
  selectedId: null,
  query: '',
  revealed: new Set(), // "itemId:field" shown in the clear
  pending: new Map(), // itemId -> what's happening to it ('saving', 'deleting')
  device: { busy: '', strays: [], protection: '' }, // this device's vault: the bar under the tabs
  arriving: 0, // when a vault last appeared (it rises in)
  returnTo: null, // 'tools': unlocking was asked for by the tools, so go back there
};

const listeners = new Set();
let version = 0;
let queued = false;

/** Tells every subscriber that the state changed. Several calls in one task cost one render. */
export function publish({ now = false } = {}) {
  version++;
  if (now) {
    queued = false;
    for (const listener of [...listeners]) listener();
    return;
  }
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    if (!queued) return;
    queued = false;
    for (const listener of [...listeners]) listener();
  });
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getVersion = () => version;

/** Changes some fields and publishes. */
export function update(patch) {
  Object.assign(state, patch);
  publish();
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
