/**
 * The places a vault can live (Google Drive, OneDrive, this device) and how the screens name
 * them: the same words on the Vault tab, in the vault switcher and in every message.
 */
import { createCloudBackend, createOneDriveBackend } from '../core/backend.js';
import { localSupport } from '../core/localstore.js';
import { VaultCipher } from '../core/vault.js';
import { deviceChoice, lastProvider, readHint } from './memory.js';
import { DEMO, state } from './store.js';

export const PROVIDERS = ['google', 'microsoft', 'local'];

export const microsoftReady = () => Boolean(state.config?.microsoftClientId) && !DEMO;
export const currentProvider = () => state.provider || lastProvider() || 'google';
export const providerName = (provider = currentProvider()) => ({ microsoft: 'OneDrive', local: 'This device' })[provider] || 'Google Drive';
export const companyName = (provider = currentProvider()) => (provider === 'microsoft' ? 'Microsoft' : 'Google');
export const isDevice = () => state.backend?.kind === 'local';

/**
 * The app Secure Box connects to a cloud as, which decides what it can see there: Google Drive
 * shows an app only the files its Google Cloud project made (the number a client id starts
 * with), and OneDrive only the folder of its app registration (the client id itself).
 */
export const appOf = (provider, clientId) => (provider === 'microsoft' ? String(clientId || '') : String(clientId || '').split('-')[0]);
export const clientIdOf = (provider) => (provider === 'microsoft' ? state.config?.microsoftClientId : state.config?.googleClientId) || '';
export const cloudApp = (provider) => (DEMO ? 'demo' : appOf(provider, clientIdOf(provider)));

/**
 * Secure Box's previous connection to `provider` (config.json, while vaults are brought over
 * from it after a switch to a new Google project or Microsoft app), or '' when there's none.
 */
export function previousClientId(provider) {
  if (DEMO) return state.demoPrevious ? 'demo' : '';
  const id = String((provider === 'microsoft' ? state.config?.previousMicrosoftClientId : state.config?.previousGoogleClientId) || '');
  return id && appOf(provider, id) !== cloudApp(provider) ? id : '';
}

/** A place as the screens name it: the demo's stand-in for the clouds is the "Demo vault". */
export const placeName = (provider = currentProvider()) => (DEMO && provider === 'google' ? 'Demo vault' : providerName(provider));

/** "Google Drive vault", "vault on this device", "demo vault". */
export const placeOfVault = (provider) => (provider === 'local' ? 'vault on this device' : DEMO && provider === 'google' ? 'demo vault' : `${providerName(provider)} vault`);

/** "your Google Drive vault", "your vault on this device". */
export const yourVault = (provider) => `your ${placeOfVault(provider)}`;

export const backendFor = (auth) => (auth.provider === 'microsoft' ? createOneDriveBackend(auth) : createCloudBackend(auth));
export const cipherFor = (master) => VaultCipher.create(master);

/**
 * Where a vault went, from the note left where it was (vault.js, movedNote), seen from `from`:
 * { where: 'OneDrive' | 'another Google account' | 'a device of yours', when: 'on 21 Nov 2026' }.
 */
export function movedWhere(note, from) {
  const where = note.to === from && from !== 'local' ? `another ${companyName(from)} account` : note.to === 'local' ? 'a device of yours' : providerName(note.to);
  const when = note.at ? `on ${new Date(note.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
  return { where, when };
}

/** "moved to OneDrive on 21 Nov 2026". */
export function movedTo(note, from) {
  const { where, when } = movedWhere(note, from);
  return `moved to ${where}${when ? ` ${when}` : ''}`;
}

/**
 * Where a folder vault on this device is, as precisely as a browser allows: websites only ever
 * learn a folder's name, never its full path (#11).
 */
export const folderPath = (name) => `“${name}” › Secure Box`;

/** Who and where, beside the place: an email for a cloud, the folder for this device. */
export function placeDetail(provider = currentProvider()) {
  if (provider === 'local') {
    const backend = state.provider === 'local' ? state.backend : null;
    if (backend?.where === 'folder') return folderPath(backend.name);
    if (backend?.where === 'browser') return 'In this browser';
    return '';
  }
  if (state.provider === provider && state.identity?.email) return state.identity.email;
  return state.auths[provider]?.identity?.email || '';
}

/** "Google Drive · you@example.com": the open (or opening) vault. */
export function vaultLabel() {
  const detail = placeDetail();
  return detail ? `${placeName()} · ${detail}` : placeName();
}

/** Other vaults this browser has seen: "Google Drive", "OneDrive", "this device". */
export function knownVaultsElsewhere(here) {
  const known = [];
  if (here !== 'google' && readHint('google')) known.push('Google Drive');
  if (here !== 'microsoft' && microsoftReady() && readHint('microsoft')) known.push('OneDrive');
  if (here !== 'local' && deviceChoice()) known.push('this device');
  return known;
}

/**
 * What the Vault tab says about each place before you choose it: what this browser knows
 * (an account, a vault here), or how you'd start.
 */
export function placeRows() {
  const last = lastProvider();
  const support = localSupport();
  const rows = [];
  if (DEMO) {
    rows.push({ provider: 'google', name: 'Demo vault', sub: 'Sample data that lives only in this tab', last: true, icon: 'cloud' });
    return rows;
  }
  const cloud = (provider) => {
    const email = readHint(provider);
    return {
      provider,
      name: providerName(provider),
      sub: email ? `${last === provider ? 'Last used' : 'Signed in before'} · ${email}` : `Sign in with ${companyName(provider)}`,
      last: last === provider,
      icon: 'cloud',
    };
  };
  rows.push(cloud('google'));
  if (microsoftReady()) rows.push(cloud('microsoft'));
  const device = deviceChoice();
  rows.push({
    provider: 'local',
    name: 'This device',
    sub: device ? `${last === 'local' ? 'Last used · ' : ''}Your vault is here` : support.ios && !support.standalone ? 'In the Home Screen app' : 'No account · you back it up',
    last: last === 'local',
    icon: 'device',
    disabled: !support.browser && !support.folder,
  });
  return rows;
}
