/**
 * How you like to see Secure Box, remembered in this browser (#8): the tab you were on, the tools
 * mode, thumbnails, grid or list, sorting, monospace text, the password generator, hidden .sbox
 * names. One validated record, shared by every Secure Box window here.
 *
 * Nothing from inside a vault is ever kept here: no names, folders, searches or secrets.
 */
import { createStore } from './store.js';

const KEY = 'secure-box.prefs';

const oneOf = (...allowed) => (value) => allowed.includes(value);
const bool = (value) => typeof value === 'boolean';
const SCHEMA = {
  section: { ok: oneOf('passwords', 'files'), fallback: 'passwords' }, // the vault's tab you used last
  lockedSection: { ok: oneOf('vault', 'tools'), fallback: 'vault' }, // locked
  toolsMode: { ok: oneOf('files', 'text'), fallback: 'files' },
  thumbnails: { ok: bool, fallback: true },
  layout: { ok: oneOf('grid', 'list'), fallback: 'grid' },
  sort: { ok: oneOf('name', 'updated', 'size', 'type'), fallback: 'name' },
  textMono: { ok: bool, fallback: false }, // plain-text documents in a fixed-width font
  hideNames: { ok: bool, fallback: true }, // .sbox files get random names
  generator: {
    ok: (g) => g && typeof g === 'object' && Number.isInteger(g.length) && g.length >= 8 && g.length <= 64 && ['upper', 'lower', 'digits', 'symbols'].every((k) => bool(g[k])),
    fallback: { length: 20, upper: true, lower: true, digits: true, symbols: true },
  },
};

function read() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const prefs = {};
  for (const [name, { ok, fallback }] of Object.entries(SCHEMA)) prefs[name] = ok(saved[name]) ? saved[name] : fallback;
  return prefs;
}

export const prefs = createStore(read());

export const pref = (name) => prefs.get()[name];

export function setPref(name, value) {
  const rule = SCHEMA[name];
  if (!rule || !rule.ok(value)) return;
  if (JSON.stringify(prefs.get()[name]) === JSON.stringify(value)) return;
  prefs.set((all) => ({ ...all, [name]: value }));
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.get()));
  } catch {
    /* storage blocked: it lasts for this visit */
  }
}

// Another Secure Box window changed a preference: follow it.
window.addEventListener('storage', (event) => {
  if (event.key === KEY) prefs.set(read());
});

/** For tests: the rules, so a stored value can be checked. */
export const prefRules = SCHEMA;
