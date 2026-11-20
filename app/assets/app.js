/**
 * Secure Box — app controller.
 *
 * Unlock: Google sign-in -> load key ring + encrypted vault from your Drive -> master password
 * (PBKDF2) unwraps the master key -> vault decrypted in this browser. Nothing is stored anywhere
 * else; the app itself is only static files.
 */
import { createCloudBackend, createOneDriveBackend } from './backend.js';
import { generatePassword, passwordEntropyBits } from './crypto.js';
import { DEMO_PASSWORD, createDemoBackend } from './demo.js';
import { createFilesView } from './files-view.js';
import { formatBytes } from './filetypes.js';
import { GoogleError, beginGoogleSignIn, isAuthPopupReturn, reconnectWithPopup, relayAuthPopupReturn, takeGoogleRedirect } from './google.js';
import {
  KeyringError,
  createKeyring,
  emergencyKitText,
  parseKeyring,
  passwordProblem,
  passwordStrength,
  recoveryKeyFromKit,
  serializeKeyring,
  trustedRevision,
  unlockWithPassword,
  unlockWithRecovery,
  verifyRevision,
  withNewPassword,
  withNewRecovery,
} from './keyring.js';
import { createLocalTools } from './local-tools.js';
import { MicrosoftError, beginMicrosoftSignIn, reconnectMicrosoftWithPopup, refreshMicrosoft, takeMicrosoftRedirect } from './microsoft.js';
import { allowFolder, createLocalBackend, findLocalVaults, forgetFolder, localSupport, readBackup } from './localstore.js';
import { forgetStreams, startStreaming } from './stream.js';
import { $, $$, avatar, confirmDialog, copyText, downloadFile, formatDate, h, icon, pickFile, relativeTime, toast } from './ui.js';
import { VaultCipher, VaultError, applyChange, emptyVault, hostnameOf, itemsFromCsv, itemsToCsv, makeItem, parseEnvelope, safeHref } from './vault.js';

// Clickjacking defence: plain S3 hosting cannot send frame-ancestors / X-Frame-Options.
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('Secure Box refuses to run inside a frame.');
}
// The Google "reconnect" pop-up lands here: hand the tokens to the Secure Box tab and close.
if (isAuthPopupReturn()) {
  relayAuthPopupReturn();
  throw new Error('Reconnect window: done.');
}

const DEMO = new URLSearchParams(location.search).has('demo');
const HINT_KEY = 'unibox.loginHint';
const LOCK_KEY = 'unibox.lockReason';
const SECTION_KEY = 'unibox.section';
const GENERATOR_KEY = 'unibox.generator';
const LOCKED_AT_KEY = DEMO ? 'unibox.demo.lockedAt' : 'unibox.lockedAt'; // last lock in any window (no secrets)
const SILENT_KEY = 'unibox.silentSignIn';
// The demo keeps its own: trying it never changes which vault the real app opens.
const PROVIDER_KEY = DEMO ? 'unibox.demo.provider' : 'unibox.provider'; // the vault used last: 'google', 'microsoft' or 'local'
const DEVICE_KEY = DEMO ? 'unibox.demo.deviceVault' : 'unibox.deviceVault'; // which vault on this device, and where ({ kid, where }; no secrets)
const BACKUP_KEY = DEMO ? 'unibox.demo.deviceBackupAt' : 'unibox.deviceBackupAt'; // when this device's vault was last backed up, per key id
// Secure Box windows of this browser talk over this channel: an unlocked window hands its session
// to a new one, and locking locks them all. Only pages from Secure Box's own address can join it,
// and demo windows use a channel of their own.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DEMO ? 'unibox-session-demo' : 'unibox-session') : null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const state = {
  config: null,
  backend: null,
  auth: null,
  identity: null,
  loaded: null, // { keyring, vault } as found in Drive
  keyringDoc: null,
  provider: null, // the open vault: 'google', 'microsoft' or 'local'
  switching: null, // the vault being opened instead, while it opens: { provider, step, since }
  auths: {}, // cloud sign-ins of this session, by provider
  master: null,
  cipher: null,
  vault: null,
  rev: null,
  lastSync: 0,
  unlocked: false,
  unlockedAt: 0,
  section: 'passwords',
  selectedId: null,
  query: '',
  revealed: new Set(),
  pendingApp: null,
  pendingKit: null,
  adoptDoc: null, // a key ring brought from the other cloud, for a new vault with the same master password
  recoveryText: '',
  streaming: false,
  lockMessage: '', // why this window is locked, shown once on the unlock screen
};

let saveChain = Promise.resolve();
let lastActivity = Date.now();
let syncLabelTimer = 0;
let files = null;
let streamingStarted = Promise.resolve();
// File and text tools (.sbox files, messages). Opening them also works while locked, with a sharing password.
const tools = createLocalTools({ master: () => (state.unlocked ? state.master : null) });
// What the files view works on: the open vault, wherever it lives.
const cloudStore = {
  get kind() {
    return state.backend?.kind === 'local' ? 'local' : 'cloud';
  },
  getVault: () => state.vault,
  commit: (change) => commit(change),
  backend: () => state.backend,
  ensure: () => ensureDrive(),
  fresh: (ms) => driveFresh(ms),
  trashNote: () =>
    state.provider === 'microsoft'
      ? 'The encrypted copies go to your OneDrive recycle bin.'
      : state.provider === 'local'
        ? 'They’re deleted from this device for good.'
        : 'The encrypted copies go to your Google Drive trash.',
};
// The This device vault's status bar: protection, backups, files put in by hand.
const device = { busy: '', strays: [], protection: '' };

start().catch((err) => {
  console.error(err);
  showError({ title: 'Secure Box could not start', message: err.message || String(err), action: 'reload', actionLabel: 'Reload' });
});

// ===========================================================================
// Startup
// ===========================================================================
async function start() {
  for (const el of $$('[data-icon]')) el.prepend(icon(el.dataset.icon, Number(el.dataset.iconSize) || 18));
  wireEvents();
  restoreGeneratorPrefs();
  const reason = takeLockReason();
  const lockMessage = {
    idle: 'Locked after a period of inactivity.',
    expired: 'Your session ended. Unlock to continue.',
    other: 'Locked from another Secure Box window.',
  }[reason] || '';
  state.lockMessage = lockMessage;

  const streaming = startStreaming({ describe: describeForStream, read: (id, a, b) => state.backend.readBytes(id, a, b) }).then((ok) => {
    state.streaming = ok;
  });
  streamingStarted = streaming;

  if (DEMO) {
    showWorking('Preparing the demo vault…');
    state.backend = await createDemoBackend();
    state.demoBackend = state.backend; // the demo's stand-in for Google Drive
    state.identity = state.backend.identity;
    state.provider = 'google';
    state.config = { autoLockMinutes: 10, sessionHours: 8 };
    await streaming;
    listenToOtherWindows();
    if (!reason && (await joinOtherWindow())) return;
    showWelcome({ message: lockMessage });
    return;
  }

  state.config = await loadConfig();
  if (!state.config) {
    showPanel('setup');
    return;
  }
  listenToOtherWindows();
  renderSource();
  let auth;
  try {
    if (new URLSearchParams(location.hash.slice(1)).has('state')) showWorking('Signing in…');
    auth = (await takeMicrosoftRedirect(state.config.microsoftClientId)) || takeGoogleRedirect(state.config.googleClientId);
  } catch (err) {
    // A background sign-in that needs the person (signed out, another account…) just shows the choices.
    showWelcome(err.silent ? { message: lockMessage } : { message: err.message, tone: 'error' });
    return;
  }
  // Another unlocked Secure Box window in this browser can hand over its session: no sign-in,
  // no password. Not right after a lock, which locks every window anyway.
  if (!reason && (await joinOtherWindow(auth))) return;
  if (!auth) {
    // Back to the vault used last: this device's straight away, a cloud's after a background sign-in.
    await streaming;
    if (lastProvider() === 'local' && (await openDeviceVault({ quiet: true }))) return;
    if (lastProvider() !== 'local' && silentSignInAllowed()) silentSignIn(reason);
    else showWelcome({ message: lockMessage });
    return;
  }
  useAuth(auth);
  if (!auth.driveGranted) {
    const microsoft = auth.provider === 'microsoft';
    showError({
      title: `${providerName()} access is needed`,
      message: microsoft
        ? 'Secure Box keeps your encrypted vault and files in its own folder in your OneDrive. Continue with Microsoft again and allow access to that folder.'
        : 'Secure Box stores your encrypted vault and files in your own Google Drive. Continue with Google again and leave the Drive permission ticked.',
      action: 'signin-consent',
      actionLabel: `Continue with ${microsoft ? 'Microsoft' : 'Google'}`,
    });
    return;
  }
  state.backend = backendFor(auth);
  await streaming;
  await openAccount();
}

// ---------------------------------------------------------------------------
// Vaults: Google Drive, OneDrive or this device. They share one master key.
// ---------------------------------------------------------------------------
const PROVIDERS = ['google', 'microsoft', 'local'];
const microsoftReady = () => Boolean(state.config?.microsoftClientId) && !DEMO;
const currentProvider = () => state.provider || lastProvider();
const providerName = (provider = currentProvider()) => ({ microsoft: 'OneDrive', local: 'This device' })[provider] || 'Google Drive';
const companyName = (provider = currentProvider()) => (provider === 'microsoft' ? 'Microsoft' : 'Google');
const isDevice = () => state.backend?.kind === 'local';

function lastProvider() {
  try {
    const saved = localStorage.getItem(PROVIDER_KEY);
    return PROVIDERS.includes(saved) ? saved : 'google';
  } catch {
    return 'google';
  }
}

function rememberProvider(provider) {
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    /* ignore */
  }
}

/** Which vault on this device was used last (its key id and where it lives; nothing secret). */
function deviceChoice() {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
  } catch {
    return null;
  }
}

function rememberDeviceChoice(choice) {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(choice));
  } catch {
    /* ignore */
  }
}

const backendFor = (auth) => (auth.provider === 'microsoft' ? createOneDriveBackend(auth) : createCloudBackend(auth));
const notifyVaultChanged = () => channel?.postMessage({ type: 'vault-changed', provider: 'local', kid: state.master?.kid });
const cipherFor = (master, backend = state.backend) => VaultCipher.create(master, backend?.vaultPurpose);

function useAuth(auth) {
  auth.provider ||= 'google';
  state.auth = auth;
  state.auths[auth.provider] = auth;
  state.provider = auth.provider;
  state.identity = auth.identity;
  saveHint(auth.identity.email, auth.provider);
  rememberProvider(auth.provider);
  renderSource();
}

/** Who and where, for the unlock screen and the vault menu: "Google Drive · you@example.com". */
function vaultLabel() {
  const where = isDevice() ? state.backend.name : state.identity?.email || '';
  return where ? `${providerName()} · ${where}` : providerName();
}

/** The vault's name wherever the page shows it, and the vault menu. While another vault opens, the button names that one. */
function renderSource() {
  const provider = currentProvider();
  const name = providerName(provider);
  const opening = state.switching?.provider || null;
  const shown = opening || provider;
  const shownName = providerName(shown);
  const button = $('#source-btn');
  button.querySelector('.source-name').textContent = shownName;
  button.firstElementChild.replaceWith(opening ? h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }) : icon(shown === 'local' ? 'device' : 'cloud', 16));
  button.classList.toggle('is-opening', Boolean(opening));
  button.title = opening ? `${switchTitle(opening)}…` : shown === 'local' ? 'Passwords and Files are kept on this device only' : `Passwords and Files are stored in your ${shownName}`;
  button.setAttribute('aria-label', opening ? switchTitle(opening) : `${shownName}: where Passwords and Files are kept`);
  button.closest('.section-group').setAttribute('aria-label', shownName);
  for (const el of $$('[data-provider-name]')) el.textContent = name;
  for (const el of $$('[data-company-name]')) el.textContent = companyName(provider === 'local' ? 'google' : provider);
  for (const option of $$('.source-option[data-provider]')) {
    const { provider: p } = option.dataset;
    const current = state.unlocked && p === provider;
    const available = p !== 'microsoft' || microsoftReady();
    option.classList.toggle('is-current', current);
    option.classList.toggle('is-soon', !available);
    option.disabled = current || !available || Boolean(opening);
    const sub = p === opening
      ? 'Opening…'
      : current
      ? p === 'local' ? state.backend?.name || '' : state.identity?.email || ''
      : !available ? 'Coming soon'
      : p === 'local' ? 'Only on this device, not synced'
      : state.auths[p] ? `Open · ${state.auths[p].identity.email}` : `Sign in with ${companyName(p)}`;
    option.querySelector('small').textContent = sub;
  }
}

/** A cloud sign-in in a pop-up, while Secure Box stays unlocked. Must come from a click. */
async function signInPopup(provider) {
  if (provider === 'microsoft') return reconnectMicrosoftWithPopup({ clientId: state.config.microsoftClientId, loginHint: readHint('microsoft') });
  return { ...(await reconnectWithPopup({ clientId: state.config.googleClientId, loginHint: readHint('google') })), provider: 'google' };
}

/**
 * Opens another vault without locking: the master key stays in memory, so a vault with the same
 * key opens without a password, and a place without a vault gets one, with the same password.
 */
async function switchVault(provider) {
  if (!PROVIDERS.includes(provider) || provider === state.provider || !state.unlocked || state.switching) return;
  if (tools.busy()) return toast('Finish or cancel the open tool first.', 'error');
  if (files?.unfinished()) {
    // Unfinished uploads (paused ones too) belong to this vault: stop them before another one opens.
    const ok = await confirmDialog({
      title: 'Stop the uploads?',
      message: state.provider === 'local'
        ? 'Some files haven’t finished saving to your vault on this device. Stop them and switch? They won’t be saved.'
        : `Some files haven’t finished uploading to your ${providerName()} vault. Stop them and switch? They won’t be saved.`,
      confirmLabel: 'Stop and switch',
    });
    if (!ok) return;
    await files.stopAll();
  }
  // From here the open vault steps aside: Passwords and Files empty out and a loader fills them.
  beginSwitching(provider);
  let opened = false;
  try {
    let backend;
    let auth = null;
    if (provider === 'local') {
      setSwitchStep('find');
      backend = await deviceBackendForSession();
      if (!backend) return;
    } else if (DEMO) {
      backend = state.demoBackend;
    } else {
      auth = state.auths[provider];
      if (!auth || auth.expiresAt - Date.now() < 2 * 60_000) {
        setSwitchStep('signin');
        auth = await signInPopup(provider);
      }
      if (!auth.driveGranted) throw new Error(`Secure Box needs access to ${providerName(provider)}. Try again and allow it.`);
      auth.provider = provider;
      saveHint(auth.identity.email, provider);
      backend = backendFor(auth);
    }
    setSwitchStep('load');
    const loaded = await backend.load();
    let doc = loaded.keyring ? parseKeyring(loaded.keyring) : null;
    if (!doc && loaded.vault) {
      // Every vault keeps its key ring beside it, so this one's was deleted (as the unlock screen says too).
      throw new Error(
        provider === 'local'
          ? 'The vault on this device is missing its key ring file (keyring.json).'
          : `Your ${providerName(provider)} vault is missing its key ring file. Restore “Secure Box Key Ring.json” from the bin there, then try again.`,
      );
    }
    if (doc && doc.kid !== state.master.kid) {
      const ok = await confirmDialog({
        title: 'A different master password',
        message: `The vault in ${providerName(provider)} was made with another master password. Secure Box locks, and you can open it with that one.`,
        confirmLabel: 'Lock and open it',
      });
      if (!ok) return;
      if (auth) state.auths[provider] = auth;
      rememberProvider(provider);
      return lock('manual');
    }
    const cipher = await cipherFor(state.master, backend);
    let vault;
    let rev;
    if (!doc) {
      // Nothing there yet: set up a vault with the same master password.
      const ok = await confirmDialog({
        title: `Set up ${providerName(provider)}?`,
        message:
          provider === 'local'
            ? 'Your vault on this device starts empty and opens with your current master password and Emergency Kit. Nothing in it is uploaded.'
            : `Your new ${providerName(provider)} vault starts empty and opens with your current master password and Emergency Kit.`,
        confirmLabel: 'Set it up',
      });
      if (!ok) return;
      setSwitchStep('create');
      vault = emptyVault();
      rev = await backend.create({ keyringText: serializeKeyring(state.keyringDoc), vaultText: await cipher.seal(vault), kid: state.master.kid });
      doc = state.keyringDoc;
    } else {
      doc = await syncKeyring(doc, backend);
      if (loaded.vault) {
        setSwitchStep('decrypt');
        const env = parseEnvelope(loaded.vault.text, cipher.format);
        vault = await cipher.open(env);
        rev = loaded.vault.rev;
      } else {
        setSwitchStep('create');
        vault = emptyVault();
        rev = await backend.createVault(await cipher.seal(vault), state.master.kid);
      }
    }
    await settleSwitching();
    if (!state.unlocked) return;
    await crossFade(() => {
      endSwitching();
      enterVault({ provider, backend, auth, keyringDoc: doc, cipher, vault, rev });
      markArriving();
    });
    opened = true;
    toast(`Opened ${provider === 'local' ? 'your vault on this device' : `your ${providerName(provider)} vault`}`);
  } catch (err) {
    console.error(err);
    if (err?.code !== 'cancelled') toast(err.message || 'Couldn’t open that vault.', 'error');
  } finally {
    if (!opened) await returnToOpenVault();
  }
}

/** This device's vault for the unlocked key: found, or (after asking where) a new one. */
async function deviceBackendForSession() {
  const support = localSupport();
  if (support.ios && !support.standalone) {
    await confirmDialog({
      title: 'Use the Home Screen app',
      message: 'On iPhone and iPad, keep a vault on this device only in the Secure Box app on your Home Screen: Safari deletes the data of websites you haven’t opened for 7 days. Tap Share → Add to Home Screen, then open Secure Box from there.',
      confirmLabel: 'OK',
    });
    return null;
  }
  if (!support.browser && !support.folder) throw new Error('This browser can’t keep a vault on this device. Use an up-to-date Chrome, Edge, Firefox or Safari.');
  const vaults = await findLocalVaults({ demo: DEMO });
  let pick = vaults.find((v) => v.kid === state.master.kid);
  if (!pick) {
    const choice = await chooseDeviceWhere();
    if (!choice) return null;
    pick = { kid: state.master.kid, ...choice, ready: true };
  }
  if (pick.where === 'folder' && !pick.ready && !(await allowFolder(pick.handle))) throw new Error('Secure Box wasn’t allowed to open the folder.');
  return createLocalBackend({ where: pick.where, handle: pick.handle || null, kid: pick.kid, demo: DEMO, notify: notifyVaultChanged });
}

/** Where a new vault on this device goes: the browser's storage, or a folder (Chrome and Edge on computers, Chrome on Android). */
async function chooseDeviceWhere() {
  if (!localSupport().folder || DEMO) return { where: 'browser' };
  const dialog = $('#device-where');
  dialog.returnValue = '';
  dialog.querySelector('input[value="browser"]').checked = true;
  const result = await new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
  if (result !== 'ok') return null;
  if (dialog.querySelector('input[value="folder"]').checked) {
    try {
      return { where: 'folder', handle: await window.showDirectoryPicker({ id: 'secure-box-local', mode: 'readwrite' }) };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  navigator.storage?.persist?.().catch(() => {}); // ask the browser to keep it (Firefox asks the person)
  return { where: 'browser' };
}

// ---------------------------------------------------------------------------
// Switching vaults as one calm transition: the open vault clears at once and a loader takes its
// place inside Passwords and Files (their bars stay where they are), then the other vault rises
// in. If it doesn't open, the vault that was open comes back the same way.
// ---------------------------------------------------------------------------
const SWITCH_MIN_MS = 650; // a loader that flashes for a frame reads as a glitch, not a step
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let arrivingTimer = 0;

/** Runs `update` as a cross-fade where the browser has View Transitions, and at once elsewhere. */
async function crossFade(update) {
  if (!document.startViewTransition || reducedMotion() || document.hidden) return update();
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => {}); // a newer transition skips this one, which is fine
  transition.finished.catch(() => {});
  return transition.updateCallbackDone;
}

const switchTitle = (provider) => (provider === 'local' ? 'Opening your vault on this device' : `Opening your ${providerName(provider)} vault`);

function switchStepText(provider, step) {
  return (
    {
      signin: `Sign in with ${companyName(provider)} in the pop-up window`,
      find: 'Looking for your vault on this device…',
      load: provider === 'local' ? 'Reading your encrypted vault…' : `Fetching your encrypted vault from ${providerName(provider)}…`,
      decrypt: 'Decrypting it with your master key…',
      create: 'Setting up your new vault…',
    }[step] || 'Just a moment…'
  );
}

function beginSwitching(provider) {
  state.switching = { provider, step: switchStepText(provider), since: performance.now() };
  crossFade(paintSwitching).catch((err) => console.warn('Switching:', err));
}

/** The line under the loader's title says what is happening right now. */
function setSwitchStep(step) {
  if (!state.switching) return;
  state.switching.step = switchStepText(state.switching.provider, step);
  for (const el of $$('[data-switch-step]')) {
    el.textContent = state.switching.step;
    if (!reducedMotion()) el.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

/** Keeps the loader up long enough to read as a step rather than a flicker. */
async function settleSwitching() {
  const left = SWITCH_MIN_MS - (performance.now() - (state.switching?.since ?? 0));
  if (left > 0) await pause(left);
}

/** While a vault opens, nothing can be clicked that would act on the vault that's closing. */
function switchingChrome(on) {
  $('#app').classList.toggle('is-switching', on);
  for (const el of $$('.list-tools, .files-tools, #menu-btn')) el.inert = on;
  $('#search').disabled = on;
}

function paintSwitching() {
  switchingChrome(Boolean(state.switching));
  renderSource();
  renderAll();
}

function endSwitching() {
  state.switching = null;
  files?.showLoading(null);
  switchingChrome(false);
}

/** The other vault didn't open (cancelled, declined or failed): the open one comes back. */
async function returnToOpenVault() {
  if (!state.switching) return;
  if (!state.unlocked) return endSwitching(); // locking: the page reloads
  await crossFade(() => {
    endSwitching();
    renderSource();
    renderAll();
    markArriving();
  }).catch((err) => console.warn('Switching back:', err));
}

/** What fills Passwords and Files while another vault opens. */
function switchLoader() {
  const { provider, step } = state.switching;
  return h('div', { class: 'vault-loader', role: 'status' },
    h('span', { class: 'vault-loader-mark', 'aria-hidden': 'true' }, icon(provider === 'local' ? 'device' : 'cloud', 24)),
    h('p', { class: 'vault-loader-title', text: switchTitle(provider) }),
    h('p', { class: 'vault-loader-step', text: step, dataset: { switchStep: '' } }));
}

/** A vault that has just appeared rises in, a few rows at a time. */
function markArriving() {
  const app = $('#app');
  app.classList.add('is-arriving');
  clearTimeout(arrivingTimer);
  arrivingTimer = setTimeout(() => app.classList.remove('is-arriving'), 900);
}

/** Makes another vault the open one (no reload, no password: same master key). */
function enterVault({ provider, backend, auth, keyringDoc, cipher, vault, rev }) {
  if (auth) {
    state.auths[provider] = auth;
    state.auth = auth;
    state.identity = auth.identity;
  } else {
    state.auth = null;
    state.identity = backend.identity;
  }
  Object.assign(state, { provider, backend, keyringDoc, cipher, vault, rev, lastSync: Date.now(), selectedId: null, query: '' });
  state.loaded = null;
  state.revealed.clear();
  rememberProvider(provider);
  if (provider === 'local') rememberDeviceChoice({ kid: state.master.kid, where: backend.where });
  forgetStreams();
  files.reset();
  files.clearTransfers();
  $('#search').value = '';
  $('#account-email').textContent = vaultLabel();
  renderSource();
  setSection(state.section, { push: false });
  history.replaceState(navState(), '');
  setSyncStatus('idle');
  renderDeviceStatus();
  if (provider === 'local') checkStrays();
}

/** Keeps every copy of the key ring at the newest revision. `doc` was just read from `backend`. */
async function syncKeyring(doc, backend) {
  const theirs = await verifyRevision(doc, state.master);
  const ours = trustedRevision(state.keyringDoc);
  if (theirs > ours) {
    state.keyringDoc = doc;
    spreadKeyring(backend).catch((err) => console.warn('Key ring update:', err));
    return doc;
  }
  if (ours > theirs) await backend.saveKeyring(serializeKeyring(state.keyringDoc)).catch((err) => console.warn('Key ring update:', err));
  return state.keyringDoc;
}

/**
 * Brings every vault Secure Box can reach right now up to the newest key ring: the open one, the
 * one on this device and the clouds signed in this session. The newest copy anywhere wins.
 */
async function spreadKeyring(alreadyDone = null) {
  if (!state.unlocked && !state.master) return;
  const kid = state.master.kid;
  const reach = [];
  if (state.backend && state.backend !== alreadyDone) reach.push(state.backend);
  const here = (await findLocalVaults({ demo: DEMO }).catch(() => [])).find((v) => v.kid === kid && v.ready);
  if (here && !(isDevice() && state.backend.where === here.where)) reach.push(createLocalBackend({ where: here.where, handle: here.handle || null, kid, demo: DEMO }));
  for (const [provider, auth] of Object.entries(state.auths)) {
    if (auth && provider !== state.provider && auth.expiresAt - Date.now() > 60_000) reach.push(backendFor(auth));
  }
  const copies = [];
  for (const backend of reach) {
    try {
      const { keyring } = await backend.load();
      const copy = keyring ? parseKeyring(keyring) : null;
      if (copy?.kid === kid) copies.push({ backend, copy, revision: await verifyRevision(copy, state.master) });
    } catch (err) {
      console.warn('Key ring check:', err);
    }
  }
  const newest = copies.reduce((best, c) => (c.revision > trustedRevision(best) ? c.copy : best), state.keyringDoc);
  state.keyringDoc = newest;
  const revision = trustedRevision(newest);
  for (const { backend, copy, revision: theirs } of copies) {
    if (theirs < revision && copy !== newest) await backend.saveKeyring(serializeKeyring(newest)).catch((err) => console.warn('Key ring update:', err));
  }
}

/** The key ring kept by this device's vault for `kid`, if it's newer than `than`: a fallback at unlock. */
async function newerKeyringHere(than) {
  const here = (await findLocalVaults({ demo: DEMO }).catch(() => [])).find((v) => v.kid === than.kid && v.ready);
  if (!here || (isDevice() && state.backend.where === here.where)) return null;
  try {
    const { keyring } = await createLocalBackend({ where: here.where, handle: here.handle || null, kid: than.kid, demo: DEMO }).load();
    const copy = keyring ? parseKeyring(keyring) : null;
    return copy && serializeKeyring(copy) !== serializeKeyring(than) ? copy : null;
  } catch {
    return null;
  }
}

async function loadConfig() {
  try {
    const res = await fetch('assets/config.json', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const config = await res.json();
    if (typeof config.googleClientId !== 'string' || !config.googleClientId.trim()) return null;
    return { autoLockMinutes: 10, sessionHours: 8, ...config };
  } catch {
    return null;
  }
}

/** Answers the streaming service worker: key + Drive token for one file, only while unlocked. */
/** What the streaming worker needs for a file: its entry, and where to get the bytes (`fresh`: new addresses). */
async function describeForStream(fileId, options) {
  if (!state.unlocked) return null;
  const entry = state.vault.files.find((f) => f.id === fileId);
  return entry ? { entry, ...(await state.backend.describe(entry, options)) } : null;
}

// ===========================================================================
// Gate screens
// ===========================================================================
function showPanel(name) {
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  $('#app').hidden = true;
  $('#gate').hidden = false;
  const active = $(`[data-panel="${name}"]`);
  (active?.querySelector('input:not([type=checkbox]):not([hidden])') || active?.querySelector('.btn:not([hidden])'))?.focus({ preventScroll: true });
}

function setText(selector, value) {
  const el = $(selector);
  el.textContent = value || '';
  el.hidden = !value;
}

function showWorking(message) {
  $('#working-text').textContent = message;
  showPanel('working');
}

/** The first screen: where your vault lives. The clouds come first; this device is the quiet option. */
function showWelcome({ message = '', tone = 'info' } = {}) {
  $('#signin-label').textContent = DEMO ? 'Open the demo' : 'Continue with Google';
  $('#google-logo').toggleAttribute('hidden', DEMO); // SVG elements have no .hidden property
  $('#signin-microsoft').hidden = !microsoftReady();
  $('#welcome-device').hidden = DEMO;
  $('#welcome-title').textContent = DEMO ? 'Try Secure Box' : readHint('google') || readHint('microsoft') || deviceChoice() ? 'Open your vault' : 'Where should your vault live?';
  // The cloud used last comes first.
  if (microsoftReady() && lastProvider() === 'microsoft') $('#signin-microsoft').after($('[data-action="signin"]'));
  setText('#signin-status', message);
  $('#signin-status').dataset.tone = tone;
  $('#signin-other').hidden = DEMO || !readHint('google');
  $('#demo-note').hidden = !DEMO;
  showPanel('signin');
}

function showError({ title, message, action = 'retry', actionLabel = 'Try again' }) {
  $('#error-title').textContent = title;
  $('#error-text').textContent = message;
  const button = $('#error-action');
  button.dataset.action = action;
  button.textContent = actionLabel;
  showPanel('error');
}

const who = () => vaultLabel();

function signIn(prompt = '', provider = 'google') {
  if (DEMO) return openAccount();
  if (prompt === 'select_account') clearHint(provider);
  rememberProvider(provider);
  showWorking(`Redirecting to ${companyName(provider)}…`);
  if (provider === 'microsoft') {
    return beginMicrosoftSignIn({ clientId: state.config.microsoftClientId, loginHint: readHint('microsoft'), prompt }).catch((err) => showWelcome({ message: err.message, tone: 'error' }));
  }
  beginGoogleSignIn({ clientId: state.config.googleClientId, loginHint: readHint('google'), prompt });
  return undefined;
}

function retry() {
  if (currentProvider() === 'local' && !DEMO) return openDeviceVault();
  if (DEMO || (state.auth && state.auth.expiresAt - Date.now() > 120_000)) return openAccount();
  return signIn('', currentProvider());
}

function strengthMeter(input, meter) {
  const update = () => {
    const { score, label } = passwordStrength(input.value);
    meter.dataset.score = String(score);
    meter.querySelector('.meter-label').textContent = label;
  };
  input.addEventListener('input', update);
  update();
}

// ===========================================================================
// Account: create, unlock, recover
// ===========================================================================
async function openAccount() {
  showWorking('Opening your Secure Box…');
  try {
    state.loaded = await state.backend.load();
    state.keyringDoc = state.loaded.keyring ? parseKeyring(state.loaded.keyring) : null;
    if (!state.keyringDoc && state.loaded.vault) {
      setText('#missing-keyring-who', who());
      showPanel('missing-keyring');
    } else if (!state.keyringDoc) {
      showCreate();
    } else showUnlock();
  } catch (err) {
    handleError(err);
  }
}

function showUnlock(message = '') {
  const input = $('#unlock-password');
  input.value = DEMO ? DEMO_PASSWORD : '';
  setText('#unlock-error', message);
  setText('#unlock-status', state.lockMessage);
  state.lockMessage = '';
  setText('#unlock-who', vaultLabel());
  $('#unlock-demo-hint').hidden = !DEMO;
  $('#unlock-other').hidden = DEMO || isDevice();
  $('#unlock-switch').hidden = DEMO;
  showPanel('unlock');
}

async function unlock() {
  const password = $('#unlock-password').value;
  if (!password) return setText('#unlock-error', 'Enter your master password.');
  const button = $('[data-action="unlock"]');
  setBusy(button, true);
  setText('#unlock-error', '');
  try {
    let master;
    try {
      master = await unlockWithPassword(state.keyringDoc, password);
    } catch (err) {
      // Changed the master password in another vault? This device may already have the new key ring.
      const newer = err instanceof KeyringError ? await newerKeyringHere(state.keyringDoc) : null;
      if (!newer) throw err;
      master = await unlockWithPassword(newer, password);
      state.keyringDoc = newer;
    }
    $('#unlock-password').value = '';
    await openVault(master);
  } catch (err) {
    if (err instanceof KeyringError) setText('#unlock-error', err.message);
    else handleError(err);
  } finally {
    setBusy(button, false);
  }
}

async function openVault(master, { unlockedAt } = {}) {
  const cipher = await cipherFor(master);
  if (!state.loaded.vault) {
    state.pendingApp = { master, cipher };
    showPanel('missing-vault');
    return;
  }
  const envelope = parseEnvelope(state.loaded.vault.text, cipher.format);
  if (envelope.kid !== master.kid) throw new VaultError('wrong-key', 'Your vault and key ring belong to different keys. Restore the matching files from the trash (recycle bin) where they’re stored.');
  const vault = await cipher.open(envelope);
  enterApp({ master, cipher, vault, rev: state.loaded.vault.rev, unlockedAt });
}

async function startNewVault() {
  const { master, cipher } = state.pendingApp;
  showWorking('Creating an empty vault…');
  try {
    const vault = emptyVault();
    const rev = await state.backend.createVault(await cipher.seal(vault), master.kid);
    enterApp({ master, cipher, vault, rev });
  } catch (err) {
    handleError(err);
  }
}

async function createAccount() {
  const password = $('#create-password').value;
  const problem = passwordProblem(password, $('#create-confirm').value);
  if (problem) return setText('#create-error', problem);
  const button = $('[data-action="create-account"]');
  setBusy(button, true);
  setText('#create-error', '');
  try {
    const { doc, master, recovery } = await createKeyring(password);
    const cipher = await cipherFor(master);
    const vault = emptyVault();
    const rev = await state.backend.create({ keyringText: serializeKeyring(doc), vaultText: await cipher.seal(vault), kid: master.kid });
    $('#create-password').value = '';
    $('#create-confirm').value = '';
    state.keyringDoc = doc;
    state.pendingApp = { master, cipher, vault, rev };
    state.pendingKit = recovery;
    showKit();
  } catch (err) {
    handleError(err);
  } finally {
    setBusy(button, false);
  }
}

function showCreate() {
  for (const id of ['#create-password', '#create-confirm']) $(id).value = '';
  setText('#create-error', '');
  setText('#create-who', who());
  $('#create-adopt').hidden = DEMO;
  showPanel('create');
}

// ---------------------------------------------------------------------------
// A new vault, the same master password: it starts with the key ring you already have, from a
// key ring backup (when Secure Box is unlocked, switching vaults does this by itself).
// ---------------------------------------------------------------------------
function showAdopt() {
  state.adoptDoc = null;
  $('#adopt-password').value = '';
  setText('#adopt-error', '');
  setText('#adopt-file', '');
  setText('#adopt-who', vaultLabel());
  showPanel('adopt');
}

async function pickAdoptKeyring() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    state.adoptDoc = parseKeyring(await file.text());
    setText('#adopt-file', `Using ${file.name}`);
    setText('#adopt-error', '');
  } catch (err) {
    state.adoptDoc = null;
    setText('#adopt-file', '');
    setText('#adopt-error', `That isn’t a Secure Box key ring backup (${err.message})`);
  }
}

async function adoptKeyring() {
  const doc = state.adoptDoc;
  if (!doc) return setText('#adopt-error', 'Load your key ring backup first. In a vault that’s open: ⋯ → Key ring backup.');
  const secret = $('#adopt-password').value;
  if (!secret) return setText('#adopt-error', 'Enter your master password.');
  const button = $('[data-action="adopt"]');
  setBusy(button, true);
  setText('#adopt-error', '');
  try {
    let master;
    try {
      master = await unlockWithPassword(doc, secret);
    } catch (err) {
      if (!(err instanceof KeyringError)) throw err;
      // An Emergency Kit recovery key opens it too.
      master = await unlockWithRecovery(doc, secret).catch(() => {
        throw new KeyringError('wrong-password', 'That master password (or recovery key) doesn’t open this key ring.');
      });
    }
    await verifyRevision(doc, master);
    const cipher = await cipherFor(master);
    const vault = emptyVault();
    const rev = await state.backend.create({ keyringText: serializeKeyring(doc), vaultText: await cipher.seal(vault), kid: master.kid });
    $('#adopt-password').value = '';
    state.keyringDoc = doc;
    state.adoptDoc = null;
    enterApp({ master, cipher, vault, rev });
    toast(`Your ${providerName()} vault is ready, with the same master password`);
  } catch (err) {
    if (err instanceof KeyringError) setText('#adopt-error', err.message);
    else handleError(err);
  } finally {
    setBusy(button, false);
  }
}

function showKit() {
  $('#kit-saved').checked = false;
  $('#kit-continue').disabled = true;
  $('#kit-id').textContent = state.pendingKit.id;
  showPanel('kit');
}

function downloadKit(recovery) {
  downloadFile(`Secure Box Emergency Kit (${recovery.id}).txt`, emergencyKitText({ email: state.identity?.email, recovery }), 'text/plain;charset=utf-8');
}

function finishKit() {
  state.pendingKit = null;
  enterApp(state.pendingApp);
  toast('Your vault is ready');
}

function showRecover() {
  state.recoveryText = '';
  for (const id of ['#recover-key', '#recover-password', '#recover-confirm']) $(id).value = '';
  setText('#recover-file-name', '');
  setText('#recover-error', '');
  showPanel('recover');
}

async function pickKit() {
  const file = await pickFile('.txt,text/plain');
  if (!file) return;
  try {
    state.recoveryText = recoveryKeyFromKit(await file.text());
    $('#recover-key').value = '';
    setText('#recover-file-name', `Using ${file.name}`);
    setText('#recover-error', '');
  } catch (err) {
    setText('#recover-error', err.message);
  }
}

async function recover() {
  const key = $('#recover-key').value.trim() || state.recoveryText;
  if (!key) return setText('#recover-error', 'Load your Emergency Kit file or type the recovery key from it.');
  const password = $('#recover-password').value;
  const problem = passwordProblem(password, $('#recover-confirm').value);
  if (problem) return setText('#recover-error', problem);
  const button = $('[data-action="recover"]');
  setBusy(button, true);
  setText('#recover-error', '');
  try {
    const master = await unlockWithRecovery(state.keyringDoc, key);
    await verifyRevision(state.keyringDoc, master);
    const doc = await withNewPassword(state.keyringDoc, master, password);
    await state.backend.saveKeyring(serializeKeyring(doc));
    state.keyringDoc = doc;
    await openVault(master);
    toast('Master password changed — you’re in');
  } catch (err) {
    if (err instanceof KeyringError) setText('#recover-error', err.message);
    else handleError(err);
  } finally {
    setBusy(button, false);
  }
}

function handleError(err) {
  console.error(err);
  const again = { action: 'signin', actionLabel: 'Continue with Google' };
  if (err instanceof MicrosoftError) {
    const microsoft = { action: 'signin-microsoft', actionLabel: 'Continue with Microsoft' };
    if (err.code === 'expired') return showError({ title: 'Please sign in again', message: err.message, ...microsoft });
    if (err.code === 'drive-scope') return showError({ title: 'OneDrive access is needed', message: err.message, action: 'signin-consent', actionLabel: 'Continue with Microsoft' });
    return showError({ title: 'OneDrive problem', message: err.message });
  }
  if (err instanceof GoogleError) {
    if (err.code === 'expired') return showError({ title: 'Please sign in again', message: err.message, ...again });
    if (err.code === 'drive-scope') return showError({ title: 'Google Drive access is needed', message: err.message, action: 'signin-consent', actionLabel: 'Continue with Google' });
    return showError({ title: err.code === 'drive-disabled' ? 'Turn on the Google Drive API' : 'Google Drive problem', message: err.message });
  }
  if (err instanceof VaultError || err instanceof KeyringError) return showError({ title: 'Couldn’t open your vault', message: err.message });
  return showError({ title: 'Something went wrong', message: err.message || String(err) });
}

function enterApp({ master, cipher, vault, rev, unlockedAt = Date.now() }) {
  // A window that joined another keeps that window's unlock time, so the session limit still holds.
  Object.assign(state, { master, cipher, vault, rev, lastSync: Date.now(), unlocked: true, unlockedAt, pendingApp: null });
  lastActivity = Date.now();
  channel?.postMessage({ type: 'unlocked', sub: state.identity?.sub });
  $('#account-email').textContent = vaultLabel();
  state.provider ||= state.backend?.provider || 'google';
  if (isDevice()) rememberDeviceChoice({ kid: master.kid, where: state.backend.where });
  renderSource();
  $('#demo-badge').hidden = !DEMO;
  $('#gate').hidden = true;
  $('#app').hidden = false;
  files ??= createFilesView({
    cloud: cloudStore,
    streaming: () => state.streaming,
    onChange: () => renderAll(),
    onNavigate: () => pushNav(),
  });
  let section = 'passwords';
  try {
    if (localStorage.getItem(SECTION_KEY) === 'files') section = 'files';
  } catch {
    /* ignore */
  }
  setSection(section, { push: false });
  markArriving();
  history.replaceState(navState(), '');
  setSyncStatus('idle');
  renderDeviceStatus();
  if (isDevice()) checkStrays();
  startAutoLock();
  // Every copy of the key ring this device can reach goes to the newest revision.
  verifyRevision(state.keyringDoc, master)
    .then(() => spreadKeyring())
    .catch((err) => console.warn('Key ring check:', err));
}

// ===========================================================================
// Sections: Passwords and Files, of whichever vault is open
// ===========================================================================
const filesMode = () => state.section === 'files';

function setSection(section, { push = true } = {}) {
  state.section = section === 'files' ? 'files' : 'passwords';
  try {
    localStorage.setItem(SECTION_KEY, state.section);
  } catch {
    /* ignore */
  }
  for (const tab of $$('[data-section]')) tab.setAttribute('aria-selected', String(tab.dataset.section === state.section));
  $('#passwords-view').hidden = state.section !== 'passwords';
  $('#files-view').hidden = state.section !== 'files';
  const search = $('#search');
  search.value = filesMode() ? files.query : state.query;
  search.placeholder = filesMode() ? 'Search files' : 'Search passwords';
  $('.topbar').classList.toggle('is-searching', Boolean(search.value));
  renderAll();
  if (push) pushNav();
}

function renderAll() {
  if (!state.unlocked) return;
  if (state.switching) return renderSwitching();
  if (filesMode()) files.render();
  else {
    renderList();
    renderDetail();
  }
  if (isDevice()) renderDeviceStatus();
}

/** Passwords and Files while another vault opens: nothing of the one that's closing, just the loader. */
function renderSwitching() {
  $('#vault-status').hidden = true;
  $('#menu-device').hidden = true;
  if (filesMode()) return files.showLoading(switchLoader());
  renderedDetailId = null;
  $('#passwords-view').classList.remove('show-detail');
  $('#list').replaceChildren();
  $('#count').textContent = '';
  const empty = $('#list-empty');
  empty.hidden = false;
  empty.replaceChildren(switchLoader()); // on phones the list is all there is
  $('#detail').replaceChildren(h('div', { class: 'detail-empty' }, switchLoader()));
}

// ---------------------------------------------------------------------------
// Back and Forward move between sections, folders, the viewer and (on phones) an item
// ---------------------------------------------------------------------------
const narrow = () => window.matchMedia('(max-width: 760px)').matches;
let restoringNav = false;
let viewerEntry = false; // the open viewer has its own history entry

function navState() {
  return { sb: 1, section: state.section, folder: filesMode() ? files.folder : null, item: state.section === 'passwords' && narrow() ? state.selectedId : null };
}

function pushNav() {
  if (restoringNav || !state.unlocked) return;
  const next = navState();
  const now = history.state;
  if (now?.sb && !now.viewer && now.section === next.section && now.folder === next.folder && now.item === next.item) return;
  history.pushState(next, '');
}

function onPopState(event) {
  if (!state.unlocked) return;
  const target = event.state;
  if ($('#viewer').open && !target?.viewer) {
    viewerEntry = false; // Back already took the viewer's entry off
    files.actions['viewer-close']();
  }
  if (!target?.sb) return;
  restoringNav = true;
  try {
    if (target.section !== state.section && ['passwords', 'files'].includes(target.section)) setSection(target.section, { push: false });
    if (filesMode() && target.folder !== files.folder) files.goTo(target.folder ?? null, { push: false });
    if (state.section === 'passwords' && narrow() && target.item !== state.selectedId) {
      select(target.item && state.vault.items.some((it) => it.id === target.item) ? target.item : null, { push: false });
    }
  } finally {
    restoringNav = false;
  }
}

/** The detail's back arrow on phones goes Back, so the browser's Back button stays in step. */
function closeDetail() {
  if (history.state?.sb && history.state.item) history.back();
  else select(null);
}

// ===========================================================================
// This device: the vault kept only here
// ===========================================================================
/**
 * From the first screen: opens this device's vault (the one used last), or offers to make one.
 * With `quiet`, it only opens one that exists, and says whether it did.
 */
async function openDeviceVault({ quiet = false } = {}) {
  const support = localSupport();
  if (support.ios && !support.standalone) {
    if (!quiet) showPanel('device-ios');
    return false;
  }
  if (!support.browser && !support.folder) {
    if (!quiet) showError({ title: 'Not in this browser', message: 'This browser can’t keep a vault on this device. Use an up-to-date Chrome, Edge, Firefox or Safari.', action: 'show-welcome', actionLabel: 'Back' });
    return false;
  }
  const vaults = await findLocalVaults({ demo: DEMO });
  const last = deviceChoice();
  const pick = vaults.find((v) => v.kid === last?.kid && v.where === last?.where) || vaults.find((v) => v.where === 'browser') || vaults[0];
  if (!pick) {
    if (quiet) return false;
    showDeviceNew();
    return true;
  }
  if (pick.where === 'folder' && !pick.ready) {
    state.devicePick = pick;
    setText('#device-allow-name', pick.name);
    showPanel('device-allow');
    return true;
  }
  await useDeviceVault(pick);
  return true;
}

function showDeviceNew() {
  const folder = localSupport().folder && !DEMO;
  $('#device-new-choice').hidden = !folder;
  $('#device-new-browser-note').hidden = folder;
  $('input[name="device-new-where"][value="browser"]').checked = true;
  setText('#device-new-error', '');
  showPanel('device-new');
}

/** Opens (or prepares to create) this device's vault, ready for its unlock or create screen. */
async function useDeviceVault({ where, handle = null, kid = null }) {
  state.auth = null;
  state.provider = 'local';
  state.backend = createLocalBackend({ where, handle, kid, demo: DEMO, notify: notifyVaultChanged });
  state.identity = state.backend.identity;
  rememberProvider('local');
  renderSource();
  await streamingStarted;
  await openAccount();
}

async function createDeviceVault() {
  const where = $('input[name="device-new-where"]:checked')?.value === 'folder' && localSupport().folder ? 'folder' : 'browser';
  let handle = null;
  if (where === 'folder') {
    try {
      handle = await window.showDirectoryPicker({ id: 'secure-box-local', mode: 'readwrite' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      throw err;
    }
  } else {
    navigator.storage?.persist?.().catch(() => {}); // ask the browser to keep it (Firefox asks the person)
  }
  await useDeviceVault({ where, handle });
}

async function allowDeviceFolder() {
  const pick = state.devicePick;
  if (!pick) return showWelcome();
  if (!(await allowFolder(pick.handle))) return setText('#device-allow-error', 'Secure Box wasn’t allowed to open the folder.');
  await useDeviceVault(pick);
}

async function forgetDeviceFolderAtGate() {
  const pick = state.devicePick;
  if (pick) await forgetFolder(pick.kid, { demo: DEMO });
  state.devicePick = null;
  showWelcome({ message: `Secure Box forgot “${pick?.name || 'the folder'}”. Its encrypted files are still there.` });
}

/** First screen → Restore a backup: makes this device's vault from a backup file. */
async function restoreDeviceFromGate() {
  const file = await pickFile('.zip,application/zip');
  if (!file) return;
  setText('#device-new-error', '');
  try {
    const backup = await readBackup(file);
    const { kid } = backup.manifest;
    if ((await findLocalVaults({ demo: DEMO })).some((v) => v.kid === kid && v.where === 'browser')) {
      throw new Error('This device already has that vault. Open it, then use ⋯ → Restore a backup to add what’s missing.');
    }
    showWorking('Restoring your vault…');
    const backend = createLocalBackend({ where: 'browser', kid, demo: DEMO });
    await backend.create({ keyringText: backup.keyring, vaultText: backup.index, kid });
    for (const id of backup.blobIds()) await backend.restoreBlob(backup, `local:${id}`);
    await useDeviceVault({ where: 'browser', kid });
    toast('Restored. Unlock it with your master password.');
  } catch (err) {
    showDeviceNew();
    setText('#device-new-error', err.message);
  }
}

// ---- The status bar of this device's vault ---------------------------------
function backupAt() {
  try {
    return Number(JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}')[state.master?.kid]) || 0;
  } catch {
    return 0;
  }
}

function rememberBackup(at) {
  try {
    const all = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}');
    all[state.master.kid] = at;
    localStorage.setItem(BACKUP_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

function renderDeviceStatus() {
  const bar = $('#vault-status');
  const backend = state.backend;
  bar.hidden = !state.unlocked || !isDevice() || Boolean(state.switching);
  $('#menu-device').hidden = bar.hidden;
  if (bar.hidden) return;
  $('#menu-device-backup').hidden = backend.where !== 'browser';
  $('#menu-device-forget').hidden = backend.where !== 'folder';
  const parts = [
    h('span', { class: 'local-where' }, icon(backend.where === 'folder' ? 'folder' : 'device', 16), h('span', { text: backend.where === 'folder' ? `Kept in “${backend.name}”` : 'Kept in this browser' })),
  ];
  if (device.protection === 'protected') parts.push(h('span', { class: 'local-pill is-ok', text: 'Won’t be cleared automatically' }));
  if (device.protection === 'unprotected') {
    parts.push(h('span', { class: 'local-pill is-warn', text: 'The browser may clear it when space runs low' }));
    parts.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { action: 'device-protect' } }, icon('shield', 16), h('span', { text: 'Protect' })));
  }
  if (device.busy) parts.push(h('span', { class: 'local-busy', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), h('span', { text: device.busy })));
  else if (backend.where === 'browser' && (state.vault.items.length || state.vault.files.length)) {
    const at = backupAt();
    const changed = Number(String(state.rev || '').split(':')[0]) || 0; // when the vault was last saved
    const stale = !at || (changed > at + 5000 && Date.now() - at > 7 * 86_400_000);
    parts.push(h('span', { class: `local-pill${stale ? ' is-warn' : ''}`, text: at ? `Backed up ${relativeTime(at)}` : 'Not backed up yet' }));
    parts.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { action: 'device-backup' } }, icon('download', 16), h('span', { text: 'Back up' })));
  }
  const rows = [h('div', { class: 'local-status-row' }, ...parts)];
  if (device.strays.length) {
    const names = device.strays.slice(0, 3).map((s) => s.name).join(', ') + (device.strays.length > 3 ? ` and ${device.strays.length - 3} more` : '');
    rows.push(
      h('div', { class: 'local-status-row local-strays' },
        icon('alert', 16),
        h('span', { text: `${device.strays.length === 1 ? 'An unencrypted file is' : `${device.strays.length} unencrypted files are`} in this vault’s folder: ${names}` }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { action: 'device-strays' } }, icon('lock', 16), h('span', { text: 'Encrypt them' }))),
    );
  }
  bar.replaceChildren(...rows);
  // Re-checks quietly: the browser may grant (or drop) protection at any time.
  backend.protection().then((p) => {
    if (p !== device.protection && state.backend === backend) {
      device.protection = p;
      renderDeviceStatus();
    }
  }).catch(() => {});
}

async function protectDevice() {
  const granted = await state.backend.protect();
  device.protection = await state.backend.protection();
  renderDeviceStatus();
  if (granted) toast('Protected: the browser won’t clear this vault by itself');
  else toast('The browser said no. Installing Secure Box as an app (Install app, or Add to Home Screen) usually changes that.', 'error');
}

const busyText = (label) => (p) => {
  device.busy = `${label}… ${Math.floor(p * 100)}%`;
  renderDeviceStatus();
};

async function backupDevice() {
  if (!isDevice() || device.busy) return;
  let backup;
  try {
    device.busy = 'Backing up…';
    renderDeviceStatus();
    backup = await state.backend.backup(state.vault.files, { onProgress: busyText('Backing up') });
    rememberBackup(Date.now());
  } catch (err) {
    toast(err.message, 'error');
    return;
  } finally {
    device.busy = '';
    renderDeviceStatus();
  }
  const { blob, name } = backup;
  const file = new File([blob], name, { type: 'application/zip' });
  if (localSupport().ios && navigator.canShare?.({ files: [file] })) {
    // Sharing needs a fresh tap: building the backup took a while.
    const ok = await confirmDialog({ title: 'Backup ready', message: `${formatBytes(blob.size)}. Save it somewhere off this device, for example in Files or iCloud Drive.`, confirmLabel: 'Save backup' });
    if (ok) await navigator.share({ files: [file], title: name }).catch((err) => err.name === 'AbortError' || toast(err.message, 'error'));
    return;
  }
  downloadFile(name, blob, 'application/zip');
  toast(`Backup saved to your downloads (${formatBytes(blob.size)})`);
}

/** ⋯ → Restore a backup: adds whatever the backup has and this device's vault doesn't. */
async function restoreDevice() {
  if (!isDevice()) return;
  const file = await pickFile('.zip,application/zip');
  if (!file) return;
  try {
    device.busy = 'Restoring…';
    renderDeviceStatus();
    const backup = await readBackup(file);
    if (backup.manifest.kid !== state.master.kid) throw new Error('That backup belongs to a different Secure Box master key.');
    const saved = await state.cipher.open(parseEnvelope(backup.index, state.cipher.format));
    const have = { items: new Set(state.vault.items.map((i) => i.id)), folders: new Set(state.vault.folders.map((f) => f.id)), files: new Set(state.vault.files.map((f) => f.id)) };
    const changes = [
      ...saved.items.filter((i) => !have.items.has(i.id)).map((item) => ({ op: 'put', item })),
      ...saved.folders.filter((f) => !have.folders.has(f.id)).map((folder) => ({ op: 'folder-put', folder })),
    ];
    const todo = saved.files.filter((f) => !have.files.has(f.id));
    const total = todo.reduce((n, f) => n + f.size, 0) || 1;
    let copied = 0;
    for (const entry of todo) {
      const ok = await state.backend.restoreBlob(backup, entry.driveId, (n) => {
        copied += n;
        busyText('Restoring')(Math.min(1, copied / total));
      });
      if (ok) changes.push({ op: 'file-put', file: entry });
    }
    if (changes.length) await commit({ op: 'batch', changes });
    if (backup.keyring) {
      const copy = parseKeyring(backup.keyring);
      if (copy.kid === state.master.kid && (await verifyRevision(copy, state.master)) > trustedRevision(state.keyringDoc)) {
        state.keyringDoc = copy;
        await spreadKeyring();
      }
    }
    toast(changes.length ? `Restored ${changes.length} ${changes.length === 1 ? 'item' : 'items'}` : 'Nothing to add: everything in that backup is already here');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    device.busy = '';
    renderAll();
    renderDeviceStatus();
  }
}

async function forgetDeviceFolder() {
  const name = state.backend?.name || 'this folder';
  const ok = await confirmDialog({
    title: 'Stop using this folder?',
    message: `Secure Box forgets “${name}” and locks. The encrypted files stay in the folder: choose it again any time to open them.`,
    confirmLabel: 'Forget folder',
  });
  if (!ok) return;
  await forgetFolder(state.master.kid, { demo: DEMO });
  rememberProvider('google');
  lock('manual');
}

/** Plain files put into a folder vault by hand: offer to encrypt them. */
async function checkStrays() {
  if (!isDevice() || state.backend.where !== 'folder') {
    device.strays = [];
    return;
  }
  try {
    device.strays = await state.backend.strays();
  } catch {
    device.strays = [];
  }
  renderDeviceStatus();
}

async function encryptStrays() {
  const strays = device.strays;
  if (!strays.length || !isDevice()) return;
  const backend = state.backend;
  const count = strays.length === 1 ? `“${strays[0].name}”` : `${strays.length} files`;
  const ok = await confirmDialog({
    title: `Encrypt ${count}?`,
    message: 'They were put into this vault’s folder by hand, so they aren’t encrypted. Secure Box encrypts each one into the vault, then deletes the unencrypted original.',
    confirmLabel: 'Encrypt',
  });
  if (!ok) return;
  device.strays = [];
  renderDeviceStatus();
  await files.enqueue(strays.map((s) => ({ file: s.file, path: s.path, after: () => backend.removeStray(s) })), null);
  await backend.pruneEmptyFolders().catch(() => {});
  await checkStrays();
  renderAll();
}

// ===========================================================================
// Saving & syncing (the vault file in Google Drive)
// ===========================================================================
function commit(change) {
  const run = async () => {
    setSyncStatus('saving');
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        // Another device saved since we last read? Pull it first and replay our change on top.
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
      throw err;
    }
  };
  const result = saveChain.then(run, run);
  saveChain = result.catch(() => {});
  return result;
}

async function pullLatest() {
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
  return true;
}

async function syncNow({ quiet = false } = {}) {
  if (!state.unlocked) return;
  if (!quiet) await ensureDrive();
  else if (!driveFresh(60_000)) return;
  setSyncStatus('syncing');
  try {
    await saveChain;
    const changed = await pullLatest();
    if (changed) {
      if (!state.vault.items.some((it) => it.id === state.selectedId)) state.selectedId = null;
      renderAll();
    }
    setSyncStatus('saved');
    if (!quiet) toast(changed ? 'Updated with changes from another device' : 'Already up to date');
  } catch (err) {
    setSyncStatus('error');
    if (!quiet) toast(`Sync failed: ${err.message}`, 'error');
  }
}

function setSyncStatus(status) {
  clearTimeout(syncLabelTimer);
  const text = { saving: 'Saving…', syncing: 'Syncing…', saved: 'Saved', error: 'Not saved', idle: isDevice() ? 'Encrypted · on this device' : 'Encrypted · synced' }[status];
  for (const el of $$('[data-sync-status]')) {
    el.dataset.state = status;
    el.textContent = text;
  }
  if (status === 'saved') syncLabelTimer = setTimeout(() => setSyncStatus('idle'), 2200);
}

function describeSaveError(err) {
  const cloud = err instanceof GoogleError || err instanceof MicrosoftError;
  if (cloud && err.code === 'expired') return `${providerName()} access expired — nothing was saved. Reconnect and try again.`;
  if (cloud && err.code === 'network') return 'You seem to be offline — nothing was saved. Try again.';
  return `Couldn’t save: ${err.message}`;
}

// ===========================================================================
// Google Drive access (tokens last an hour; reconnect without locking)
// ===========================================================================
function driveFresh(margin = 5 * 60_000) {
  return DEMO || state.backend.tokenExpiresAt() - Date.now() > margin;
}

let reconnecting = null;
let reconnectedElsewhere = null; // closes this window's Reconnect dialog when another window reconnected

/** Takes a fresher token for the same account (from this or another window). */
function useToken({ accessToken, expiresAt, refreshToken }) {
  if (!state.auth || !(expiresAt > state.auth.expiresAt)) return false;
  state.auth.accessToken = accessToken;
  state.auth.expiresAt = expiresAt;
  if (refreshToken) state.auth.refreshToken = refreshToken;
  forgetStreams();
  return true;
}

let refreshing = null;

/**
 * Microsoft: renews the access token in the background with the refresh token (valid 24 hours),
 * and shares it with the other windows. Resolves true when it worked.
 */
function refreshQuietly() {
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

/** Resolves when the cloud can be used. Shows a one-click "Reconnect" dialog when the sign-in ran out. */
async function ensureDrive() {
  if (driveFresh()) return;
  if (await refreshQuietly()) return;
  reconnecting ??= new Promise((resolve, reject) => {
    const dialog = $('#reconnect');
    const status = $('#reconnect-status');
    const go = $('#reconnect-go');
    let controller = null;
    const microsoft = state.auth?.provider === 'microsoft';
    $('#reconnect-title').textContent = `Reconnect ${providerName()}`;
    $('#reconnect-text').textContent = microsoft
      ? 'Microsoft asks you to sign in again once a day. Reconnect to keep working — your vault stays unlocked.'
      : 'For your security, Google’s access lasts one hour. Reconnect to keep working — your vault stays unlocked.';
    setText('#reconnect-status', '');
    go.disabled = false;
    const finish = (fn, value) => {
      go.onclick = null;
      dialog.onclose = null;
      reconnectedElsewhere = null;
      if (dialog.open) dialog.close();
      reconnecting = null;
      fn(value);
    };
    reconnectedElsewhere = () => {
      controller?.abort();
      toast(`Reconnected to ${providerName()}`);
      finish(resolve);
    };
    go.onclick = () => {
      controller = new AbortController();
      go.disabled = true;
      setText('#reconnect-status', `Finish signing in in the ${companyName()} window…`);
      const popup = microsoft
        ? reconnectMicrosoftWithPopup({ clientId: state.config.microsoftClientId, loginHint: state.identity.email, previous: state.auth, signal: controller.signal })
        : reconnectWithPopup({ clientId: state.config.googleClientId, loginHint: state.identity.email, expectedSub: state.identity.sub, signal: controller.signal });
      popup.then(
        (result) => {
          useToken(result);
          // Every other Secure Box window of this browser can use the new token too.
          channel?.postMessage({ type: 'token', sub: state.identity.sub, accessToken: result.accessToken, expiresAt: result.expiresAt });
          toast(`Reconnected to ${providerName()}`);
          finish(resolve);
        },
        (err) => {
          go.disabled = false;
          status.hidden = false;
          status.textContent = err.code === 'cancelled' ? '' : err.message;
        },
      );
    };
    dialog.onclose = () => {
      controller?.abort();
      finish(reject, new GoogleError('cancelled', `${providerName()} is disconnected. Reconnect to continue.`));
    };
    dialog.showModal();
  });
  return reconnecting;
}

// ===========================================================================
// Auto-lock
// ===========================================================================
let autoLockStarted = false;
let activityShared = 0;

const idleLimit = () => Math.max(1, Number(state.config?.autoLockMinutes) || 10) * 60_000;
const sessionLimit = () => Math.min(12, Math.max(1, Number(state.config?.sessionHours) || 8)) * 3_600_000;

/** Activity in any Secure Box window keeps every window unlocked (shared at most every 15 s). */
function noteActivity(at = Date.now()) {
  lastActivity = Math.max(lastActivity, at);
  if (channel && state.unlocked && at - activityShared > 15_000) {
    activityShared = at;
    channel.postMessage({ type: 'activity', at });
  }
}

function startAutoLock() {
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
    if (document.visibilityState === 'visible' && state.unlocked && Date.now() - state.lastSync > 60_000 && !$('dialog[open]')) syncNow({ quiet: true });
  });
  window.addEventListener('beforeunload', (event) => {
    if (files?.busy() || tools.busy() || device.busy) event.preventDefault();
  });
}

function checkAutoLock() {
  if (!state.unlocked) return;
  // Another window locked while this one was asleep or in the back/forward cache.
  if (lockedAt() > state.unlockedAt) return lock('other', { fromOtherWindow: true });
  // Uploads, local encryption and playing media count as activity.
  if (files?.busy() || tools.busy() || device.busy || $$('video, audio').some((m) => !m.paused)) noteActivity();
  if (Date.now() - lastActivity >= idleLimit()) lock('idle');
  else if (Date.now() - state.unlockedAt >= sessionLimit()) lock('expired');
}

function lockedAt() {
  try {
    return Number(localStorage.getItem(LOCKED_AT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Locks this window, and every other Secure Box window of this browser with it (they share one
 * session). `fromOtherWindow` marks a lock that another window started.
 */
async function lock(reason = 'manual', { fromOtherWindow = false } = {}) {
  if (reason !== 'manual' && !state.unlocked) return;
  const wasUnlocked = state.unlocked;
  state.unlocked = false;
  if (wasUnlocked && !fromOtherWindow) {
    try {
      localStorage.setItem(LOCKED_AT_KEY, String(Date.now()));
    } catch {
      /* storage blocked: the message below still reaches open windows */
    }
    channel?.postMessage({ type: 'lock', reason });
  }
  if (reason === 'manual' || fromOtherWindow) await Promise.race([saveChain, pause(4000)]);
  forgetStreams();
  try {
    sessionStorage.setItem(LOCK_KEY, reason === 'manual' && fromOtherWindow ? 'other' : reason);
  } catch {
    /* private mode */
  }
  // Reloading is the most reliable way to drop every decrypted secret, key and token from memory.
  location.replace(`${location.pathname}${DEMO ? '?demo' : ''}`);
}

// ===========================================================================
// Other windows: share one unlocked session, lock together, reuse fresh Google tokens
// ===========================================================================
function currentPanel() {
  if ($('#gate').hidden) return null;
  return $$('[data-panel]').find((panel) => !panel.hidden)?.dataset.panel ?? null;
}

/** What an unlocked window hands to a new one. It travels only in memory, never to disk. */
function sessionToShare() {
  const fresh = Date.now() - lastActivity < idleLimit() && Date.now() - state.unlockedAt < sessionLimit();
  if (!state.unlocked || !state.master || (!DEMO && !isDevice() && !state.auth) || !fresh || lockedAt() > state.unlockedAt) return null;
  return {
    vault: isDevice() ? { provider: 'local', where: state.backend.where, kid: state.master.kid } : { provider: state.provider },
    // The access token only: a Microsoft refresh token stays in the window that signed in.
    auth: DEMO || isDevice() ? null : { provider: state.auth.provider || 'google', accessToken: state.auth.accessToken, expiresAt: state.auth.expiresAt, identity: { ...state.identity }, driveGranted: true },
    master: { kid: state.master.kid, key: state.master.key },
    unlockedAt: state.unlockedAt,
  };
}

function validSession(s) {
  const auth = s?.auth;
  const authOk = DEMO || s?.vault?.provider === 'local' || (typeof auth?.accessToken === 'string' && Number.isFinite(auth.expiresAt) && typeof auth.identity?.sub === 'string');
  return Boolean(
    authOk && s.master && typeof s.master.kid === 'string' && s.master.key instanceof Uint8Array && s.master.key.length === 32
      && Number.isFinite(s.unlockedAt) && s.unlockedAt > lockedAt() && Date.now() - s.unlockedAt < sessionLimit(),
  );
}

function listenToOtherWindows() {
  if (!channel) return;
  channel.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'request') {
      const session = sessionToShare();
      if (session) channel.postMessage({ type: 'offer', id: data.id, session });
    } else if (data.type === 'lock') {
      if (state.unlocked) lock(data.reason, { fromOtherWindow: true });
    } else if (data.type === 'vault-changed') {
      // Another window saved to this device's vault: pick it up.
      if (state.unlocked && isDevice() && data.kid === state.master?.kid) syncNow({ quiet: true });
    } else if (data.type === 'activity') {
      if (state.unlocked && Number.isFinite(data.at)) lastActivity = Math.max(lastActivity, Math.min(Date.now(), data.at));
    } else if (data.type === 'token') {
      if (data.sub === state.identity?.sub && typeof data.accessToken === 'string' && useToken(data)) reconnectedElsewhere?.();
    } else if (data.type === 'unlocked') {
      // Unlocking one window unlocks the others that are waiting at sign-in or unlock.
      const waiting = ['signin', 'unlock'].includes(currentPanel());
      if (!state.unlocked && waiting && (!state.identity || state.identity.sub === data.sub)) {
        joinOtherWindow(state.auth && state.auth.expiresAt - Date.now() > 60_000 ? state.auth : null);
      }
    }
  });
  // Backup for locks: fires in every other window when the shared lock time changes.
  window.addEventListener('storage', (event) => {
    if (event.key === LOCKED_AT_KEY && state.unlocked && Number(event.newValue) > state.unlockedAt) lock('other', { fromOtherWindow: true });
  });
}

/** Asks the other Secure Box windows of this browser for an unlocked session. */
function requestSession(timeout = 400) {
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

let joining = false;

/**
 * Opens this window with the session of an unlocked one, if there is one. `ownAuth` is this
 * window's own Google sign-in, if it has one. Returns true when it took over the screen.
 */
async function joinOtherWindow(ownAuth = null) {
  if (!channel || joining || state.unlocked) return false;
  joining = true;
  try {
    const shared = await requestSession();
    if (!shared || state.unlocked) return false;
    if (shared.vault?.provider === 'local') {
      // The other window has this device's vault open: open the same one.
      if (ownAuth) return false;
      const here = (await findLocalVaults({ demo: DEMO })).find((v) => v.kid === shared.vault.kid && v.where === shared.vault.where && v.ready);
      if (!here) return false;
      state.auth = null;
      state.provider = 'local';
      state.backend = createLocalBackend({ where: here.where, handle: here.handle || null, kid: here.kid, demo: DEMO, notify: notifyVaultChanged });
      state.identity = state.backend.identity;
      renderSource();
    } else if (!DEMO) {
      // Someone who just chose another account (or cloud) doesn't want this one.
      if (ownAuth && ownAuth.identity.sub !== shared.auth.identity.sub) return false;
      let auth = ownAuth;
      if (!auth) {
        // Nearly expired token: fetch our own in the background first, then join again on return.
        if (shared.auth.expiresAt - Date.now() < 2 * 60_000 && silentSignInAllowed()) {
          silentSignIn('');
          return true;
        }
        auth = { ...shared.auth, identity: { ...shared.auth.identity } };
      }
      useAuth(auth);
      state.backend = backendFor(auth);
    }
    showWorking('Opening your Secure Box…');
    await streamingStarted;
    if (!driveFresh(60_000)) await ensureDrive();
    state.loaded = await state.backend.load();
    state.keyringDoc = state.loaded.keyring ? parseKeyring(state.loaded.keyring) : null;
    if (state.keyringDoc?.kid !== shared.master.kid) {
      await openAccount(); // the key ring changed meanwhile: unlock normally
      return true;
    }
    await openVault(shared.master, { unlockedAt: shared.unlockedAt });
    if (state.unlocked) toast('Unlocked from your other Secure Box window');
    return true;
  } catch (err) {
    handleError(err);
    return true;
  } finally {
    joining = false;
  }
}

function silentSignInAllowed() {
  if (DEMO || !readHint()) return false;
  if (lastProvider() === 'microsoft' && !microsoftReady()) return false;
  try {
    // At most one background attempt every 20 seconds per tab, so a problem can never loop.
    return Date.now() - (Number(sessionStorage.getItem(SILENT_KEY)) || 0) > 20_000;
  } catch {
    return false;
  }
}

function silentSignIn(reason) {
  try {
    sessionStorage.setItem(SILENT_KEY, String(Date.now()));
    if (reason) sessionStorage.setItem(LOCK_KEY, reason); // still explain the lock after the round trip
  } catch {
    /* private mode */
  }
  const provider = lastProvider();
  showWorking(`Signing in with ${companyName(provider)}…`);
  if (provider === 'microsoft') {
    beginMicrosoftSignIn({ clientId: state.config.microsoftClientId, loginHint: readHint('microsoft'), silent: true }).catch(() => showWelcome());
    return;
  }
  beginGoogleSignIn({ clientId: state.config.googleClientId, loginHint: readHint('google'), silent: true });
}

function takeLockReason() {
  try {
    const reason = sessionStorage.getItem(LOCK_KEY);
    sessionStorage.removeItem(LOCK_KEY);
    return reason;
  } catch {
    return null;
  }
}

// ===========================================================================
// Passwords: list & detail
// ===========================================================================
function visibleItems() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  return state.vault.items
    .filter((it) => !terms.length || terms.every((t) => `${it.title}\n${it.username}\n${it.url}\n${it.notes}`.toLowerCase().includes(t)))
    .sort((a, b) => collator.compare(a.title, b.title));
}

const subtitleOf = (item) => (item.type === 'note' ? 'Secure note' : item.username || hostnameOf(item.url) || 'Login');

function renderList() {
  if (state.switching) return; // renderSwitching() fills it meanwhile
  const items = visibleItems();
  const total = state.vault.items.length;
  $('#list').replaceChildren(
    ...items.map((item) =>
      h('li', {},
        h('button', { type: 'button', class: 'row', dataset: { id: item.id }, onclick: () => select(item.id) },
          avatar(item),
          h('span', { class: 'row-text' }, h('span', { class: 'row-title', text: item.title }), h('span', { class: 'row-sub', text: subtitleOf(item) })))),
    ),
  );
  $('#count').textContent = state.query ? `${items.length} of ${total}` : `${total} ${total === 1 ? 'item' : 'items'}`;
  const empty = $('#list-empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.replaceChildren(
      ...(total
        ? [h('p', { class: 'empty-title', text: 'No matches' }), h('p', { text: `Nothing matches “${state.query.trim()}”.` })]
        : [
            h('div', { class: 'empty-icon' }, icon('shield', 22)),
            h('p', { class: 'empty-title', text: 'Your vault is empty' }),
            h('p', { text: 'Add a password or a secure note to get started.' }),
            h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { action: 'new-item' } }, icon('plus', 16), h('span', { text: 'New item' })),
          ]),
    );
  }
  markSelection();
}

function markSelection() {
  for (const row of $$('#list .row')) {
    const selected = row.dataset.id === state.selectedId;
    row.classList.toggle('is-selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}

function select(id, { push = true } = {}) {
  if (state.selectedId !== id) state.revealed.clear();
  state.selectedId = id;
  markSelection();
  renderDetail();
  if (id) $(`#list .row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  if (push && id && narrow()) pushNav(); // on phones the item fills the screen: Back closes it
}

function moveSelection(step) {
  const items = visibleItems();
  if (!items.length) return;
  const index = items.findIndex((it) => it.id === state.selectedId);
  const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + step));
  select(items[next].id);
}

let renderedDetailId = null;

function renderDetail() {
  if (state.switching) return;
  const pane = $('#detail');
  const item = state.vault.items.find((it) => it.id === state.selectedId);
  const entering = Boolean(item) && item.id !== renderedDetailId;
  renderedDetailId = item ? item.id : null;
  $('#passwords-view').classList.toggle('show-detail', Boolean(item));
  if (!item) {
    pane.replaceChildren(
      h('div', { class: 'detail-empty' },
        h('div', { class: 'empty-icon' }, icon('lock', 22)),
        h('p', { class: 'empty-title', text: state.vault.items.length ? 'Select an item' : 'Nothing here yet' }),
        h('p', { text: 'Everything is encrypted in this browser before it is saved.' })),
    );
    return;
  }
  const fields = [];
  if (item.type === 'login') {
    if (item.username) fields.push(plainField('Username', item.username));
    if (item.password) fields.push(secretField(item, 'password', 'Password'));
    if (item.url) fields.push(linkField(item.url));
  }
  if (item.notes) fields.push(secretField(item, 'notes', item.type === 'note' ? 'Secret' : 'Notes'));
  pane.replaceChildren(
    h('article', { class: `detail${entering ? ' is-entering' : ''}` },
      h('header', { class: 'detail-head' },
        h('button', { type: 'button', class: 'icon-btn back-btn', 'aria-label': 'Back to list', onclick: () => closeDetail() }, icon('back')),
        avatar(item, 'lg'),
        h('div', { class: 'detail-heading' }, h('h2', { text: item.title }), h('p', { text: item.type === 'note' ? 'Secure note' : hostnameOf(item.url) || 'Login' })),
        h('div', { class: 'detail-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openEditor(item) }, icon('edit', 16), h('span', { text: 'Edit' })),
          h('button', { type: 'button', class: 'icon-btn icon-btn-danger', 'aria-label': 'Delete item', title: 'Delete', onclick: () => deleteItem(item) }, icon('trash')))),
      fields.length ? h('div', { class: 'fields' }, fields) : h('p', { class: 'muted', text: 'No details saved for this item yet.' }),
      h('p', { class: 'meta', text: `Edited ${relativeTime(item.updated)} · Created ${formatDate(item.created)}` }),
    ),
  );
}

const toolButton = (iconName, label, onclick) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, onclick }, icon(iconName));

const fieldRow = (label, valueNode, tools) =>
  h('div', { class: 'field-row' }, h('div', { class: 'field-main' }, h('span', { class: 'field-label', text: label }), valueNode), h('div', { class: 'field-tools' }, tools));

function plainField(label, value) {
  return fieldRow(label, h('span', { class: 'field-value', text: value }), [toolButton('copy', `Copy ${label.toLowerCase()}`, () => copyValue(value, label, false))]);
}

function linkField(url) {
  const href = safeHref(url);
  const value = href ? h('a', { class: 'field-value field-link', href, target: '_blank', rel: 'noopener noreferrer', text: url }) : h('span', { class: 'field-value', text: url });
  return fieldRow('Website', value, [
    href && h('a', { class: 'icon-btn', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open website', title: 'Open website' }, icon('external')),
    toolButton('copy', 'Copy website', () => copyValue(url, 'Website', false)),
  ]);
}

function secretField(item, field, label) {
  const key = `${item.id}:${field}`;
  const shown = state.revealed.has(key);
  const value = item[field];
  const toggle = () => {
    if (shown) state.revealed.delete(key);
    else state.revealed.add(key);
    renderDetail();
  };
  const valueNode =
    field === 'password'
      ? shown
        ? colorizedPassword(value)
        : h('span', { class: 'field-value mono concealed', text: '••••••••••••' })
      : shown
        ? h('div', { class: 'field-value note-text', text: value })
        : h('button', { type: 'button', class: 'reveal-note', onclick: toggle }, icon('eye', 16), h('span', { text: 'Hidden — click to reveal' }));
  return fieldRow(label, valueNode, [
    toolButton(shown ? 'eyeOff' : 'eye', `${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`, toggle),
    toolButton('copy', `Copy ${label.toLowerCase()}`, () => copyValue(value, label, true)),
  ]);
}

function colorizedPassword(value) {
  const el = h('span', { class: 'field-value mono password' });
  for (const part of value.match(/[A-Za-z]+|[0-9]+|[^A-Za-z0-9]+/g) || []) {
    if (/^[A-Za-z]/.test(part)) el.append(part);
    else el.append(h('span', { class: /^[0-9]/.test(part) ? 'pw-digit' : 'pw-symbol', text: part }));
  }
  return el;
}

async function copyValue(value, label, sensitive) {
  try {
    await copyText(value, { sensitive });
    toast(sensitive ? `${label} copied · clears in 30s` : `${label} copied`);
  } catch {
    toast('The browser blocked clipboard access.', 'error');
  }
}

// ===========================================================================
// Password editor
// ===========================================================================
const editor = {
  item: null,
  snapshot: '',
  get dialog() {
    return $('#editor');
  },
  get fields() {
    return { title: $('#f-title'), username: $('#f-username'), password: $('#f-password'), url: $('#f-url'), notes: $('#f-notes') };
  },
};

const editorType = () => $('input[name="item-type"]:checked')?.value || 'login';

function setEditorType(type) {
  for (const radio of $$('input[name="item-type"]')) radio.checked = radio.value === type;
  editor.dialog.classList.toggle('is-note', type === 'note');
  $('#f-notes-label').textContent = type === 'note' ? 'Secret' : 'Notes';
  $('#f-notes').rows = type === 'note' ? 8 : 3;
  $('#f-title').placeholder = type === 'note' ? 'e.g. Home Wi-Fi' : 'e.g. GitHub';
}

function editorValues() {
  const f = editor.fields;
  return { type: editorType(), title: f.title.value, username: f.username.value, password: f.password.value, url: f.url.value, notes: f.notes.value };
}

function openEditor(item = null) {
  editor.item = item;
  $('#editor-title').textContent = item ? 'Edit item' : 'New item';
  setEditorType(item?.type || 'login');
  for (const [name, input] of Object.entries(editor.fields)) input.value = item?.[name] ?? '';
  setPasswordVisible(false);
  $('#generator').hidden = true;
  setText('#editor-error', '');
  editor.snapshot = JSON.stringify(editorValues());
  editor.dialog.showModal();
  editor.fields.title.focus();
}

async function closeEditor() {
  if (JSON.stringify(editorValues()) !== editor.snapshot) {
    const discard = await confirmDialog({ title: 'Discard changes?', message: 'Your unsaved edits to this item will be lost.', confirmLabel: 'Discard', danger: true });
    if (!discard) return;
  }
  editor.dialog.close();
}

async function saveEditor() {
  const values = editorValues();
  const loginDetails = values.type === 'login' && (values.username.trim() || values.password || values.url.trim());
  if (!values.title.trim() && !values.notes.trim() && !loginDetails) return setText('#editor-error', 'Add a title or some details first.');
  const item = makeItem(values, editor.item);
  const button = $('#editor-save');
  setBusy(button, true);
  try {
    await ensureDrive();
    await commit({ op: 'put', item });
    editor.dialog.close();
    state.selectedId = item.id;
    state.revealed.clear();
    renderAll();
    toast(editor.item ? 'Changes saved' : 'Saved to your vault');
  } catch (err) {
    setText('#editor-error', describeSaveError(err));
  } finally {
    setBusy(button, false);
  }
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
}

function setPasswordVisible(visible) {
  $('#f-password').type = visible ? 'text' : 'password';
  const button = $('#reveal-password');
  button.replaceChildren(icon(visible ? 'eyeOff' : 'eye'));
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  button.title = visible ? 'Hide password' : 'Show password';
}

function generatorOptions() {
  return { length: Number($('#g-length').value), upper: $('#g-upper').checked, lower: $('#g-lower').checked, digits: $('#g-digits').checked, symbols: $('#g-symbols').checked };
}

function regeneratePassword() {
  const options = generatorOptions();
  $('#f-password').value = generatePassword(options);
  $('#g-length-out').textContent = String(options.length);
  $('#g-strength').textContent = `≈ ${passwordEntropyBits(options)} bits`;
  setPasswordVisible(true);
  try {
    localStorage.setItem(GENERATOR_KEY, JSON.stringify(options));
  } catch {
    /* ignore */
  }
}

function restoreGeneratorPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(GENERATOR_KEY) || 'null');
    if (!saved) return;
    $('#g-length').value = String(Math.min(64, Math.max(8, Number(saved.length) || 20)));
    for (const name of ['upper', 'lower', 'digits', 'symbols']) $(`#g-${name}`).checked = saved[name] !== false;
  } catch {
    /* ignore */
  }
}

async function deleteItem(item) {
  const ok = await confirmDialog({ title: `Delete “${item.title}”?`, message: 'It will be removed from your vault on every device.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await ensureDrive();
    await commit({ op: 'delete', id: item.id });
    if (state.selectedId === item.id) state.selectedId = null;
    renderAll();
    toast('Item deleted');
  } catch (err) {
    toast(describeSaveError(err), 'error');
  }
}

// ===========================================================================
// Menu: CSV, master password, Emergency Kit
// ===========================================================================
const today = () => new Date().toISOString().slice(0, 10);

async function importCsv() {
  const file = await pickFile('.csv,text/csv');
  if (!file) return;
  let items;
  try {
    items = itemsFromCsv(await file.text());
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const added = applyChange(state.vault, { op: 'import', items }).items.length - state.vault.items.length;
  if (!added) return toast('Everything in that file is already in your vault.');
  const plural = added === 1 ? '' : 's';
  const ok = await confirmDialog({
    title: `Import ${added} item${plural}?`,
    message: `From “${file.name}”. They will be encrypted and added to your vault. Delete the CSV afterwards — it is not encrypted.`,
    confirmLabel: 'Import',
  });
  if (!ok) return;
  try {
    await ensureDrive();
    await commit({ op: 'import', items });
    renderAll();
    toast(`Imported ${added} item${plural}`);
  } catch (err) {
    toast(describeSaveError(err), 'error');
  }
}

async function exportCsv() {
  const ok = await confirmDialog({
    title: 'Export an unencrypted CSV?',
    message: 'The file will contain every password and note in plain text. Keep it somewhere safe and delete it when you are done.',
    confirmLabel: 'Export',
  });
  if (ok) downloadFile(`secure-box-passwords-${today()}.csv`, itemsToCsv(state.vault.items), 'text/csv;charset=utf-8');
}

function openPasswordDialog() {
  for (const id of ['#pw-current', '#pw-new', '#pw-confirm']) $(id).value = '';
  setText('#pw-error', '');
  $('#password-dialog').showModal();
  $('#pw-current').focus();
}

/** The vaults this device knows of, besides the open one: for "it reaches them when you open them". */
function otherVaultsNote() {
  const others = PROVIDERS.filter((p) => p !== state.provider && (p === 'local' ? deviceChoice() : readHint(p))).map((p) => providerName(p));
  return others.length ? ` Your ${others.join(' and ')} ${others.length === 1 ? 'vault gets' : 'vaults get'} it when you next open ${others.length === 1 ? 'it' : 'them'} here, from the vault menu.` : '';
}

async function changePassword() {
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  const problem = passwordProblem(next, $('#pw-confirm').value);
  if (!current) return setText('#pw-error', 'Enter your current master password.');
  if (problem) return setText('#pw-error', problem);
  const button = $('[data-action="pw-save"]');
  setBusy(button, true);
  setText('#pw-error', '');
  try {
    await unlockWithPassword(state.keyringDoc, current);
    await ensureDrive();
    const doc = await withNewPassword(state.keyringDoc, state.master, next);
    await state.backend.saveKeyring(serializeKeyring(doc));
    state.keyringDoc = doc;
    $('#password-dialog').close();
    await spreadKeyring(state.backend); // this device's vault and the clouds signed in now
    toast(`Master password changed.${otherVaultsNote()}`);
  } catch (err) {
    setText('#pw-error', err instanceof KeyringError ? 'Your current master password is not correct.' : describeSaveError(err));
  } finally {
    setBusy(button, false);
  }
}

async function newEmergencyKit() {
  const ok = await confirmDialog({
    title: 'Make a new Emergency Kit?',
    message: 'Your current Emergency Kit stops working, for all your vaults. Save the new one offline: never in your cloud drive or email.',
    confirmLabel: 'Make new kit',
  });
  if (!ok) return;
  try {
    await ensureDrive();
    const { doc, recovery } = await withNewRecovery(state.keyringDoc, state.master);
    await state.backend.saveKeyring(serializeKeyring(doc));
    state.keyringDoc = doc;
    downloadKit(recovery);
    await spreadKeyring(state.backend);
    toast(`New Emergency Kit downloaded: the old one no longer works.${otherVaultsNote()}`);
  } catch (err) {
    toast(describeSaveError(err), 'error');
  }
}

/** A copy of the key ring, which all of this person's vaults share. */
async function exportKeyring() {
  if (!state.unlocked || !state.keyringDoc) throw new Error('Unlock Secure Box first.');
  const ok = await confirmDialog({
    title: 'Export key ring backup?',
    message:
      'The key ring is your master key, locked with your master password and Emergency Kit. All your vaults share it. With this copy and your master password or Emergency Kit, you can open your .sbox files and messages on any device, and start a new vault with the same master password. Keep it private: it keeps opening with today’s master password and Emergency Kit, even after you change them.',
    confirmLabel: 'Export',
  });
  if (!ok) return;
  downloadFile(`Secure Box Key Ring backup (${state.keyringDoc.kid}).json`, serializeKeyring(state.keyringDoc), 'application/json');
  toast('Key ring backup downloaded');
}

// ===========================================================================
// Events
// ===========================================================================
/** Phones: the search field takes over the top bar while it's open. */
function openSearch() {
  $('.topbar').classList.add('is-searching');
  $('#search').focus();
}

function closeSearch() {
  const search = $('#search');
  if (search.value) {
    search.value = '';
    search.dispatchEvent(new Event('input'));
  }
  $('.topbar').classList.remove('is-searching');
}

// Which account this browser last used, per provider (an email, no secrets).
const hintKey = (provider) => (provider === 'microsoft' ? `${HINT_KEY}.microsoft` : HINT_KEY);

function readHint(provider = lastProvider()) {
  try {
    return localStorage.getItem(hintKey(provider)) || '';
  } catch {
    return '';
  }
}

function saveHint(email, provider = 'google') {
  try {
    if (email) localStorage.setItem(hintKey(provider), email);
  } catch {
    /* ignore */
  }
}

function clearHint(provider = lastProvider()) {
  try {
    localStorage.removeItem(hintKey(provider));
  } catch {
    /* ignore */
  }
}

const actions = {
  signin: () => signIn('', 'google'),
  'signin-microsoft': () => signIn('', 'microsoft'),
  'signin-other': () => signIn('select_account', 'google'),
  'signin-other-current': () => signIn('select_account', currentProvider()),
  'source-switch': (button) => switchVault(button.dataset.provider),
  'adopt-show': () => showAdopt(),
  'adopt-pick': () => pickAdoptKeyring(),
  adopt: () => adoptKeyring(),
  'adopt-cancel': () => showCreate(),
  'signin-consent': () => signIn('consent', currentProvider()),
  retry: () => retry(),
  reload: () => location.reload(),
  'search-open': () => openSearch(),
  'search-close': () => closeSearch(),
  unlock: () => unlock(),
  'create-account': () => createAccount(),
  'download-kit': () => {
    downloadKit(state.pendingKit);
    $('#kit-download').classList.add('is-done');
  },
  'kit-continue': () => finishKit(),
  'show-recover': () => showRecover(),
  'show-unlock': () => showUnlock(),
  'recover-pick': () => pickKit(),
  recover: () => recover(),
  'new-vault': () => startNewVault(),
  'new-item': () => openEditor(),
  primary: () => (filesMode() ? files.upload() : openEditor()),
  'open-device': () => openDeviceVault(),
  'device-create': () => createDeviceVault(),
  'device-restore-new': () => restoreDeviceFromGate(),
  'device-allow': () => allowDeviceFolder(),
  'device-forget-gate': () => forgetDeviceFolderAtGate(),
  'show-welcome': () => showWelcome(),
  'device-protect': () => protectDevice(),
  'device-backup': () => backupDevice(),
  'device-restore': () => restoreDevice(),
  'device-forget': () => forgetDeviceFolder(),
  'device-strays': () => encryptStrays(),
  lock: () => lock('manual'),
  sync: () => syncNow(),
  'import-csv': () => importCsv(),
  'export-csv': () => exportCsv(),
  'change-password': () => openPasswordDialog(),
  'pw-save': () => changePassword(),
  'pw-cancel': () => $('#password-dialog').close(),
  'new-kit': () => newEmergencyKit(),
  'export-keyring': () => exportKeyring(),
  ...tools.actions,
  'reconnect-cancel': () => $('#reconnect').close(),
  'editor-save': () => saveEditor(),
  'editor-cancel': () => closeEditor(),
  'editor-reveal': () => setPasswordVisible($('#f-password').type === 'password'),
  'editor-generate': () => {
    $('#generator').hidden = false;
    regeneratePassword();
  },
};

function onEnter(selector, action) {
  $(selector).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    Promise.resolve()
      .then(() => actions[action]())
      .catch((err) => {
        console.error(err);
        toast(err.message || 'Something went wrong.', 'error');
      });
  });
}

function wireEvents() {
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger || trigger.disabled) return;
    const run = actions[trigger.dataset.action] || files?.actions[trigger.dataset.action];
    if (!run) return;
    event.preventDefault();
    const menu = trigger.closest('.menu[popover]');
    if (menu?.matches(':popover-open')) menu.hidePopover();
    Promise.resolve()
      .then(() => run(trigger, event))
      .catch((err) => {
        console.error(err);
        if (err?.code !== 'cancelled') toast(err.message || 'Something went wrong.', 'error');
      });
  });

  for (const tab of $$('[data-section]')) tab.addEventListener('click', () => setSection(tab.dataset.section));
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-close]');
    if (button) button.closest('dialog')?.close(button.dataset.close);
  });

  // Gate forms (plain fields, not <form>s, so browsers don't offer to save the master password)
  onEnter('#unlock-password', 'unlock');
  onEnter('#create-confirm', 'create-account');
  onEnter('#recover-confirm', 'recover');
  onEnter('#pw-confirm', 'pw-save');
  onEnter('#box-confirm', 'box-encrypt-go');
  onEnter('#box-open-password', 'box-decrypt-go');
  onEnter('#box-master', 'box-decrypt-go');
  strengthMeter($('#create-password'), $('#create-strength'));
  strengthMeter($('#recover-password'), $('#recover-strength'));
  strengthMeter($('#pw-new'), $('#pw-strength'));
  $('#kit-saved').addEventListener('change', () => {
    $('#kit-continue').disabled = !$('#kit-saved').checked;
  });

  // Search
  const search = $('#search');
  search.addEventListener('input', () => {
    if (filesMode()) files.setQuery(search.value);
    else {
      state.query = search.value;
      renderList();
    }
  });
  search.addEventListener('keydown', (event) => {
    if (filesMode()) return files.searchKey(event);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      const first = visibleItems()[0];
      if (first && !visibleItems().some((it) => it.id === state.selectedId)) select(first.id);
    } else if (event.key === 'Escape' && search.value) {
      event.preventDefault();
      search.value = '';
      state.query = '';
      renderList();
    }
  });
  // Phones show search behind a button: Escape or leaving an empty field folds it away again.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !search.value) closeSearch();
  });
  search.addEventListener('blur', () => {
    if (!search.value) $('.topbar').classList.remove('is-searching');
  });

  $('#list').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    $('#list .row.is-selected')?.focus();
  });

  // Global shortcuts
  document.addEventListener('keydown', (event) => {
    if (!state.unlocked || state.switching || $('dialog[open]')) return;
    const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if ((event.key === '/' && !typing && plain) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
      event.preventDefault();
      openSearch();
      search.select();
    } else if (filesMode()) files.key(event, { typing, plain });
    else if (state.section !== 'passwords') return;
    else if (event.key.toLowerCase() === 'n' && !typing && plain) {
      event.preventDefault();
      openEditor();
    } else if (event.key === 'Escape' && !typing && state.selectedId) select(null);
  });

  // Back and Forward walk through sections, folders and the viewer (see pushNav).
  window.addEventListener('popstate', onPopState);
  // The open viewer gets a history entry of its own, so Back closes it (and nothing else).
  const viewerDialog = $('#viewer');
  new MutationObserver(() => {
    if (viewerDialog.open) {
      if (!viewerEntry && state.unlocked) {
        history.pushState({ ...navState(), viewer: true }, '');
        viewerEntry = true;
      }
    } else if (viewerEntry) {
      viewerEntry = false;
      if (history.state?.viewer) history.back(); // closed in the page: take its entry off again
    }
  }).observe(viewerDialog, { attributes: true, attributeFilter: ['open'] });

  // Editor
  const dialog = $('#editor');
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeEditor();
  });
  for (const radio of $$('input[name="item-type"]')) radio.addEventListener('change', () => setEditorType(radio.value));
  dialog.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' && event.target.matches('input.input')) || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      saveEditor();
    }
  });
  $('#g-length').addEventListener('input', regeneratePassword);
  for (const name of ['upper', 'lower', 'digits', 'symbols']) $(`#g-${name}`).addEventListener('change', regeneratePassword);

  $('#confirm-ok').addEventListener('click', () => $('#confirm').close('ok'));
  $('#confirm-cancel').addEventListener('click', () => $('#confirm').close('cancel'));

  // Pop-up menus open under their button: by its right edge, or its left edge with data-align="left".
  for (const menu of $$('.menu[popover][data-anchor]')) {
    menu.addEventListener('beforetoggle', (event) => {
      if (event.newState !== 'open') return;
      const rect = $(menu.dataset.anchor).getBoundingClientRect();
      menu.style.top = `${Math.round(rect.bottom + 8)}px`;
      if (menu.dataset.align === 'left') {
        menu.style.left = `${Math.round(Math.max(8, rect.left))}px`;
        menu.style.right = 'auto';
      } else {
        menu.style.right = `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`;
        menu.style.left = 'auto';
      }
    });
  }
}
