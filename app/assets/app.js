/**
 * Secure Box — app controller.
 *
 * Unlock: Google sign-in -> load key ring + encrypted vault from your Drive -> master password
 * (PBKDF2) unwraps the master key -> vault decrypted in this browser. Nothing is stored anywhere
 * else; the app itself is only static files.
 */
import { createCloudBackend } from './backend.js';
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
  unlockWithPassword,
  unlockWithRecovery,
  withNewPassword,
  withNewRecovery,
} from './keyring.js';
import { createLocalTools } from './local-tools.js';
import { allowFolder, findLocalVault, forgetFolder, isLocalId, localSupport, openLocalVault } from './localstore.js';
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
// The local vault on this device (the Local tab): found when the tab first opens.
const local = { store: null, found: undefined, error: '', busy: '', strays: [] };
const cloudStore = {
  kind: 'cloud',
  getVault: () => state.vault,
  commit: (change) => commit(change),
  backend: () => state.backend,
  ensure: () => ensureDrive(),
  fresh: (ms) => driveFresh(ms),
};
let localFiles = null; // the local vault as the files view sees it

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

  const read = (id, a, b) => (isLocalId(id) ? local.store.backend.readBytes(id, a, b) : state.backend.readBytes(id, a, b));
  const streaming = startStreaming({ describe: describeForStream, read }).then((ok) => {
    state.streaming = ok;
  });
  streamingStarted = streaming;

  if (DEMO) {
    showWorking('Preparing the demo vault…');
    state.backend = await createDemoBackend();
    state.identity = state.backend.identity;
    state.config = { autoLockMinutes: 10, sessionHours: 8 };
    await streaming;
    listenToOtherWindows();
    if (!reason && (await joinOtherWindow())) return;
    showSignIn({ message: lockMessage });
    return;
  }

  state.config = await loadConfig();
  if (!state.config) {
    showPanel('setup');
    return;
  }
  listenToOtherWindows();
  let auth;
  try {
    auth = takeGoogleRedirect(state.config.googleClientId);
  } catch (err) {
    // A background sign-in that needs the person (signed out, another account…) just shows the button.
    showSignIn(err.silent ? { message: lockMessage } : { message: err.message, tone: 'error' });
    return;
  }
  // Another unlocked Secure Box window in this browser can hand over its session: no sign-in,
  // no password. Not right after a lock, which locks every window anyway.
  if (!reason && (await joinOtherWindow(auth))) return;
  if (!auth) {
    // Signed in here before: ask Google in the background, so only the master password is left.
    if (silentSignInAllowed()) silentSignIn(reason);
    else showSignIn({ message: lockMessage });
    return;
  }
  state.auth = auth;
  state.identity = auth.identity;
  saveHint(auth.identity.email);
  if (!auth.driveGranted) {
    showError({
      title: 'Google Drive access is needed',
      message: 'Secure Box stores your encrypted vault and files in your own Google Drive. Continue with Google again and leave the Drive permission ticked.',
      action: 'signin-consent',
      actionLabel: 'Continue with Google',
    });
    return;
  }
  state.backend = createCloudBackend(auth);
  await streaming;
  await openAccount();
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
function describeForStream(fileId) {
  if (!state.unlocked) return null;
  const entry = state.vault.files.find((f) => f.id === fileId);
  if (entry) return { entry, ...state.backend.describe() };
  // Local vault files: the worker asks this page for their (encrypted) bytes.
  const localEntry = local.store?.getVault().files.find((f) => f.id === fileId);
  return localEntry ? { entry: localEntry, source: 'page' } : null;
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

function showSignIn({ message = '', tone = 'info' } = {}) {
  $('#signin-label').textContent = DEMO ? 'Open the demo' : 'Continue with Google';
  $('#google-logo').toggleAttribute('hidden', DEMO); // SVG elements have no .hidden property
  setText('#signin-status', message);
  $('#signin-status').dataset.tone = tone;
  $('#signin-other').hidden = DEMO || !readHint();
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

const who = () => (state.identity?.email ? `Signed in as ${state.identity.email}` : '');

function signIn(prompt = '') {
  if (DEMO) return openAccount();
  if (prompt === 'select_account') clearHint();
  showWorking('Redirecting to Google…');
  beginGoogleSignIn({ clientId: state.config.googleClientId, loginHint: readHint(), prompt });
  return undefined;
}

function retry() {
  if (DEMO || (state.auth && state.auth.expiresAt - Date.now() > 120_000)) return openAccount();
  return signIn();
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
      for (const id of ['#create-password', '#create-confirm']) $(id).value = '';
      setText('#create-error', '');
      setText('#create-who', who());
      showPanel('create');
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
  setText('#unlock-who', who());
  $('#unlock-demo-hint').hidden = !DEMO;
  $('#unlock-other').hidden = DEMO;
  showPanel('unlock');
}

async function unlock() {
  const password = $('#unlock-password').value;
  if (!password) return setText('#unlock-error', 'Enter your master password.');
  const button = $('[data-action="unlock"]');
  setBusy(button, true);
  setText('#unlock-error', '');
  try {
    const master = await unlockWithPassword(state.keyringDoc, password);
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
  const cipher = await VaultCipher.create(master);
  if (!state.loaded.vault) {
    state.pendingApp = { master, cipher };
    showPanel('missing-vault');
    return;
  }
  const envelope = parseEnvelope(state.loaded.vault.text);
  if (envelope.kid !== master.kid) throw new VaultError('wrong-key', 'Your vault and key ring belong to different keys. Restore the matching files from Drive’s trash.');
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
    const cipher = await VaultCipher.create(master);
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
  $('#account-email').textContent = state.identity?.email || '';
  $('#source-email').textContent = state.identity?.email || '';
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
    const saved = localStorage.getItem(SECTION_KEY);
    if (['files', 'local'].includes(saved)) section = saved;
  } catch {
    /* ignore */
  }
  setSection(section, { push: false });
  history.replaceState(navState(), '');
  setSyncStatus('idle');
  startAutoLock();
}

// ===========================================================================
// Sections: Google Drive (Passwords, Files) and Local
// ===========================================================================
/** Files and an open local vault share the file manager. */
const filesMode = () => state.section === 'files' || (state.section === 'local' && Boolean(localFiles));

function setSection(section, { push = true } = {}) {
  state.section = section;
  try {
    localStorage.setItem(SECTION_KEY, section);
  } catch {
    /* ignore */
  }
  for (const tab of $$('[data-section]')) tab.setAttribute('aria-selected', String(tab.dataset.section === section));
  if (section === 'files') files.useStore(cloudStore);
  if (section === 'local' && localFiles) files.useStore(localFiles);
  const setup = section === 'local' && !localFiles;
  $('#passwords-view').hidden = section !== 'passwords';
  $('#files-view').hidden = !filesMode();
  $('#files-view').classList.toggle('is-local', section === 'local');
  $('#local-setup').hidden = !setup;
  const search = $('#search');
  search.value = filesMode() ? files.query : section === 'passwords' ? state.query : '';
  search.placeholder = section === 'files' ? 'Search files' : section === 'local' ? 'Search local vault' : 'Search passwords';
  search.disabled = setup;
  $('.topbar').classList.toggle('is-searching', Boolean(search.value));
  renderAll();
  if (section === 'local') {
    if (localFiles) checkStrays();
    else openLocalTab();
  }
  if (push) pushNav();
}

function renderAll() {
  if (!state.unlocked) return;
  if (filesMode()) {
    files.render();
    if (state.section === 'local') renderLocalStatus();
  } else if (state.section === 'local') renderLocalSetup();
  else {
    renderList();
    renderDetail();
  }
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
    if (target.section !== state.section && ['passwords', 'files', 'local'].includes(target.section)) setSection(target.section, { push: false });
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

// ---------------------------------------------------------------------------
// Local: the local vault on this device
// ---------------------------------------------------------------------------
async function openLocalTab() {
  if (local.busy) return;
  if (local.found === undefined) {
    local.busy = 'Looking for a local vault…';
    renderAll();
    try {
      local.found = await findLocalVault(state.master.kid, { demo: DEMO });
    } catch (err) {
      local.found = null;
      local.error = err.message;
    }
    local.busy = '';
  }
  if (local.found?.ready) await openLocal({ where: local.found.where, handle: local.found.handle });
  else renderAll();
}

async function openLocal({ where, handle = null, create = false }) {
  local.busy = create ? 'Creating the local vault…' : 'Opening the local vault…';
  local.error = '';
  renderAll();
  try {
    local.store = await openLocalVault({
      master: state.master,
      where,
      handle,
      create,
      demo: DEMO,
      notify: () => channel?.postMessage({ type: 'local-changed', kid: state.master.kid }),
    });
    localFiles = {
      kind: 'local',
      getVault: () => local.store.getVault(),
      commit: (change) => local.store.commit(change),
      backend: () => local.store.backend,
      ensure: async () => {},
      fresh: () => true,
    };
    local.found = { where, handle, name: handle?.name, ready: true };
    local.protection = await local.store.protection();
  } catch (err) {
    console.error(err);
    local.store = null;
    localFiles = null;
    local.error = err.code === 'other-account' ? err.message : `The local vault couldn’t be opened: ${err.message}`;
  } finally {
    local.busy = '';
  }
  if (state.section === 'local') setSection('local', { push: false });
}

async function createLocal() {
  const where = $('input[name="local-where"]:checked')?.value === 'folder' ? 'folder' : 'browser';
  let handle = null;
  if (where === 'folder') {
    try {
      handle = await window.showDirectoryPicker({ id: 'secure-box-local', mode: 'readwrite' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      throw err;
    }
  } else {
    // Ask the browser to keep it. Firefox asks the person, which needs this click.
    navigator.storage?.persist?.().catch(() => {});
  }
  await openLocal({ where, handle, create: true });
  if (local.store) toast(where === 'folder' ? `Local vault ready in “${handle.name}”` : 'Local vault ready');
}

async function allowLocalFolder() {
  if (await allowFolder(local.found.handle)) await openLocal({ where: 'folder', handle: local.found.handle });
  else toast('Secure Box wasn’t allowed to open the folder.', 'error');
}

async function forgetLocalFolder() {
  const name = local.found?.name || 'this folder';
  const ok = await confirmDialog({
    title: 'Stop using this folder?',
    message: `Secure Box forgets “${name}”. The encrypted files stay in it: choose the folder again any time to open them.`,
    confirmLabel: 'Forget folder',
  });
  if (!ok) return;
  await forgetFolder(state.master.kid, { demo: DEMO });
  Object.assign(local, { store: null, found: null, strays: [], error: '' });
  localFiles = null;
  setSection('local', { push: false });
}

async function protectLocal() {
  const granted = await local.store.protect();
  local.protection = await local.store.protection();
  renderLocalStatus();
  if (granted) toast('Protected: the browser won’t clear the local vault by itself');
  else toast('The browser said no. Installing Secure Box as an app (Install app, or Add to Home Screen) usually changes that.', 'error');
}

const busyText = (label) => (p) => {
  local.busy = `${label}… ${Math.floor(p * 100)}%`;
  renderLocalStatus();
};

async function backupLocal() {
  if (!local.store || local.busy) return;
  let backup;
  try {
    local.busy = 'Backing up…';
    renderLocalStatus();
    backup = await local.store.backup({ onProgress: busyText('Backing up') });
  } catch (err) {
    toast(err.message, 'error');
    return;
  } finally {
    local.busy = '';
    renderLocalStatus();
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

async function restoreLocal() {
  const file = await pickFile('.zip,application/zip');
  if (!file) return;
  if (!local.store) await openLocal({ where: 'browser', create: true });
  if (!local.store) return;
  try {
    local.busy = 'Restoring…';
    renderAll();
    const added = await local.store.restore(file, { onProgress: busyText('Restoring') });
    toast(added ? `Restored ${added} ${added === 1 ? 'file' : 'files'}` : 'Nothing to add: everything in that backup is already here');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    local.busy = '';
    renderAll();
  }
}

/** Plain files put into a folder vault by hand: offer to encrypt them. */
async function checkStrays() {
  if (local.store?.where !== 'folder') return;
  try {
    local.strays = await local.store.strays();
  } catch {
    local.strays = [];
  }
  if (state.section === 'local') renderLocalStatus();
}

async function encryptStrays() {
  const strays = local.strays;
  if (!strays.length || !localFiles) return;
  const count = strays.length === 1 ? `“${strays[0].name}”` : `${strays.length} files`;
  const ok = await confirmDialog({
    title: `Encrypt ${count}?`,
    message: 'They were put into the local vault’s folder by hand, so they aren’t encrypted. Secure Box encrypts each one into the local vault, then deletes the unencrypted original.',
    confirmLabel: 'Encrypt',
  });
  if (!ok) return;
  local.strays = [];
  renderLocalStatus();
  await files.enqueue(strays.map((s) => ({ file: s.file, path: s.path, after: () => local.store.removeStray(s) })), null, localFiles);
  await local.store.pruneEmptyFolders().catch(() => {});
  await checkStrays();
  renderAll();
}

function renderLocalStatus() {
  const bar = $('#local-status');
  const store = local.store;
  bar.hidden = !store || state.section !== 'local';
  if (bar.hidden) return;
  const v = store.getVault();
  const parts = [];
  const where = store.where === 'folder' ? `In “${store.name}”` : 'In this browser';
  parts.push(h('span', { class: 'local-where' }, icon(store.where === 'folder' ? 'folder' : 'device', 16), h('span', { text: where })));
  if (local.protection === 'protected') parts.push(h('span', { class: 'local-pill is-ok', text: 'Won’t be cleared automatically' }));
  if (local.protection === 'unprotected') {
    parts.push(h('span', { class: 'local-pill is-warn', text: 'The browser may clear it when space runs low' }));
    parts.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { action: 'local-protect' } }, icon('shield', 16), h('span', { text: 'Protect' })));
  }
  if (local.busy) parts.push(h('span', { class: 'local-busy', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), h('span', { text: local.busy })));
  else if (store.where === 'browser' && v.files.length) {
    const stale = !v.backupAt || (v.changedAt > v.backupAt && Date.now() - v.backupAt > 7 * 86_400_000);
    parts.push(h('span', { class: `local-pill${stale ? ' is-warn' : ''}`, text: v.backupAt ? `Backed up ${relativeTime(v.backupAt)}` : 'Not backed up yet' }));
    parts.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { action: 'local-backup' } }, icon('download', 16), h('span', { text: 'Back up' })));
  }
  const rows = [h('div', { class: 'local-status-row' }, ...parts)];
  if (local.strays.length) {
    const names = local.strays.slice(0, 3).map((s) => s.name).join(', ') + (local.strays.length > 3 ? ` and ${local.strays.length - 3} more` : '');
    rows.push(
      h('div', { class: 'local-status-row local-strays' },
        icon('alert', 16),
        h('span', { text: `${local.strays.length === 1 ? 'An unencrypted file is' : `${local.strays.length} unencrypted files are`} in this vault’s folder: ${names}` }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { action: 'local-strays' } }, icon('lock', 16), h('span', { text: 'Encrypt them' }))),
    );
  }
  bar.replaceChildren(...rows);
  $('#tools-forget').hidden = store.where !== 'folder';
  $('#tools-backup').hidden = store.where !== 'browser';
  // Re-checks quietly: the browser may grant (or drop) protection at any time.
  store.protection().then((p) => {
    if (p !== local.protection) {
      local.protection = p;
      renderLocalStatus();
    }
  }).catch(() => {});
}

function renderLocalSetup() {
  const support = localSupport();
  const parts = [
    h('div', { class: 'empty-icon' }, icon('device', 22)),
    h('h2', { class: 'local-title', text: 'Local vault' }),
    h('p', { class: 'local-lead', text: 'Encrypted files kept on this device only. They never go to Google Drive, and they unlock with your master password, like everything else.' }),
  ];
  if (local.busy) {
    parts.push(h('div', { class: 'working' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: local.busy })));
  } else if (local.found && !local.found.ready) {
    parts.push(
      h('p', { class: 'local-note', text: `Your local vault is in the folder “${local.found.name}”. Your browser asks once per visit before Secure Box may open it.` }),
      h('div', { class: 'local-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'local-allow' } }, icon('folder', 16), h('span', { text: `Open “${local.found.name}”` })),
        h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'local-forget' } }, h('span', { text: 'Forget this folder' }))),
    );
  } else if (!support.browser && !support.folder) {
    parts.push(h('p', { class: 'local-note', text: 'This browser can’t keep a local vault. Use an up-to-date Chrome, Edge, Firefox or Safari.' }));
  } else if (support.ios && !support.standalone) {
    parts.push(
      h('p', { class: 'local-note', text: 'On iPhone and iPad, keep your local vault in the Secure Box app on your Home Screen. Safari deletes the data of websites you haven’t opened for 7 days, and only Home Screen apps are safe from that.' }),
      h('ol', { class: 'local-steps' }, h('li', { text: 'Tap Share in Safari, then Add to Home Screen.' }), h('li', { text: 'Open Secure Box from your Home Screen, unlock, and come back to Local.' })),
    );
  } else {
    const folderChoice = support.folder && !DEMO;
    if (folderChoice) {
      parts.push(
        h('div', { class: 'local-where-choice', role: 'radiogroup', 'aria-label': 'Where to keep it' },
          h('label', { class: 'local-option' },
            h('input', { type: 'radio', name: 'local-where', value: 'browser', checked: true }),
            h('span', {}, h('strong', { text: 'In this browser' }), h('small', { text: 'Nothing to set up. Back it up now and then: clearing this site’s data in the browser deletes it.' }))),
          h('label', { class: 'local-option' },
            h('input', { type: 'radio', name: 'local-where', value: 'folder' }),
            h('span', {}, h('strong', { text: 'In a folder you choose' }), h('small', { text: 'Ordinary encrypted files you can see, copy and back up. A synced folder (OneDrive, Dropbox, iCloud Drive) works too.' })))),
      );
    } else {
      parts.push(h('p', { class: 'local-note', text: 'It’s kept in this browser’s private storage. Back it up now and then: clearing this site’s data in the browser deletes it.' }));
    }
    parts.push(
      h('div', { class: 'local-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'local-create' } }, icon('plus', 16), h('span', { text: 'Create local vault' })),
        h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'local-restore' } }, icon('upload', 16), h('span', { text: 'Restore a backup…' }))),
    );
  }
  if (local.error) parts.push(h('p', { class: 'form-error', role: 'alert', text: local.error }));
  const tool = (action, iconName, title, text) =>
    h('button', { type: 'button', class: 'local-tool', dataset: { action } }, h('span', { class: 'local-tool-icon' }, icon(iconName, 18)), h('span', {}, h('strong', { text: title }), h('small', { text })));
  $('#local-setup').replaceChildren(
    h('div', { class: 'local-setup-inner' },
      h('section', { class: 'local-card' }, ...parts),
      h('section', { class: 'local-tools-list', 'aria-label': 'Tools' },
        h('h3', { text: 'Tools' }),
        tool('box-encrypt-open', 'lock', 'Encrypt files', 'Turn files or a folder into .sbox files to keep or share'),
        tool('box-decrypt-open', 'unlock', 'Decrypt .sbox files', 'Open .sbox files made with Secure Box'),
        tool('text-open', 'note', 'Encrypt text', 'Encrypt a message, or read one you were sent'),
        tool('export-keyring', 'key', 'Key ring backup', 'Opens your .sbox files even without Google Drive'))),
  );
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
        const rev = await state.backend.writeVault(await state.cipher.seal(next));
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
  const envelope = parseEnvelope(text);
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
  const text = { saving: 'Saving…', syncing: 'Syncing…', saved: 'Saved', error: 'Not saved', idle: 'Encrypted · synced' }[status];
  for (const el of $$('[data-sync-status]')) {
    el.dataset.state = status;
    el.textContent = text;
  }
  if (status === 'saved') syncLabelTimer = setTimeout(() => setSyncStatus('idle'), 2200);
}

function describeSaveError(err) {
  if (err instanceof GoogleError && err.code === 'expired') return 'Google access expired — nothing was saved. Reconnect and try again.';
  if (err instanceof GoogleError && err.code === 'network') return 'You seem to be offline — nothing was saved. Try again.';
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

/** Takes a fresher Google token for the same account (from this or another window). */
function useToken({ accessToken, expiresAt }) {
  if (!state.auth || !(expiresAt > state.auth.expiresAt)) return false;
  state.auth.accessToken = accessToken;
  state.auth.expiresAt = expiresAt;
  forgetStreams();
  return true;
}

/** Resolves when Drive can be used. Shows a one-click "Reconnect" dialog when the token ran out. */
function ensureDrive() {
  if (driveFresh()) return Promise.resolve();
  reconnecting ??= new Promise((resolve, reject) => {
    const dialog = $('#reconnect');
    const status = $('#reconnect-status');
    const go = $('#reconnect-go');
    let controller = null;
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
      toast('Reconnected to Google Drive');
      finish(resolve);
    };
    go.onclick = () => {
      controller = new AbortController();
      go.disabled = true;
      setText('#reconnect-status', 'Finish signing in in the Google window…');
      reconnectWithPopup({ clientId: state.config.googleClientId, loginHint: state.identity.email, expectedSub: state.identity.sub, signal: controller.signal }).then(
        (result) => {
          useToken(result);
          // Every other Secure Box window of this browser can use the new token too.
          channel?.postMessage({ type: 'token', sub: state.identity.sub, accessToken: result.accessToken, expiresAt: result.expiresAt });
          toast('Reconnected to Google Drive');
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
      finish(reject, new GoogleError('cancelled', 'Google Drive is disconnected. Reconnect to continue.'));
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
  window.addEventListener('pageshow', checkAutoLock);
  document.addEventListener('visibilitychange', () => {
    checkAutoLock();
    if (document.visibilityState === 'visible' && state.unlocked && Date.now() - state.lastSync > 60_000 && !$('dialog[open]')) syncNow({ quiet: true });
  });
  window.addEventListener('beforeunload', (event) => {
    if (files?.busy() || tools.busy() || local.busy) event.preventDefault();
  });
}

function checkAutoLock() {
  if (!state.unlocked) return;
  // Another window locked while this one was asleep or in the back/forward cache.
  if (lockedAt() > state.unlockedAt) return lock('other', { fromOtherWindow: true });
  // Uploads, local encryption and playing media count as activity.
  if (files?.busy() || tools.busy() || local.busy || $$('video, audio').some((m) => !m.paused)) noteActivity();
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
  if (!state.unlocked || !state.master || (!DEMO && !state.auth) || !fresh || lockedAt() > state.unlockedAt) return null;
  return {
    auth: DEMO ? null : { accessToken: state.auth.accessToken, expiresAt: state.auth.expiresAt, identity: { ...state.identity }, driveGranted: true },
    master: { kid: state.master.kid, key: state.master.key },
    unlockedAt: state.unlockedAt,
  };
}

function validSession(s) {
  const auth = s?.auth;
  const authOk = DEMO || (typeof auth?.accessToken === 'string' && Number.isFinite(auth.expiresAt) && typeof auth.identity?.sub === 'string');
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
    } else if (data.type === 'local-changed') {
      // Another window saved to the local vault: pick it up.
      if (local.store && data.kid === state.master?.kid) local.store.reload().then((changed) => changed && renderAll()).catch(() => {});
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
    if (!DEMO) {
      // Someone who just chose another Google account doesn't want this one.
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
      state.auth = auth;
      state.identity = auth.identity;
      saveHint(auth.identity.email);
      state.backend = createCloudBackend(auth);
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
  showWorking('Signing in with Google…');
  beginGoogleSignIn({ clientId: state.config.googleClientId, loginHint: readHint(), silent: true });
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
  if (ok) downloadFile(`unibox-passwords-${today()}.csv`, itemsToCsv(state.vault.items), 'text/csv;charset=utf-8');
}

function openPasswordDialog() {
  for (const id of ['#pw-current', '#pw-new', '#pw-confirm']) $(id).value = '';
  setText('#pw-error', '');
  $('#password-dialog').showModal();
  $('#pw-current').focus();
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
    toast('Master password changed');
  } catch (err) {
    setText('#pw-error', err instanceof KeyringError ? 'Your current master password is not correct.' : describeSaveError(err));
  } finally {
    setBusy(button, false);
  }
}

async function newEmergencyKit() {
  const ok = await confirmDialog({
    title: 'Make a new Emergency Kit?',
    message: 'Your current Emergency Kit will stop working immediately. Save the new one offline — never in Google Drive or email.',
    confirmLabel: 'Make new kit',
  });
  if (!ok) return;
  try {
    await ensureDrive();
    const { doc, recovery } = await withNewRecovery(state.keyringDoc, state.master);
    await state.backend.saveKeyring(serializeKeyring(doc));
    state.keyringDoc = doc;
    downloadKit(recovery);
    toast('New Emergency Kit downloaded — the old one no longer works');
  } catch (err) {
    toast(describeSaveError(err), 'error');
  }
}

/** A copy of the key ring: with it, .sbox files made with this account open even without Drive. */
async function exportKeyring() {
  if (!state.unlocked || !state.keyringDoc) throw new Error('Unlock Secure Box first.');
  const ok = await confirmDialog({
    title: 'Export key ring backup?',
    message:
      'With this file and your master password or Emergency Kit, .sbox files made with your account open on any device, even without Google Drive. It’s encrypted, but keep it private: it keeps opening with today’s master password and Emergency Kit even after you change them.',
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

function readHint() {
  try {
    return localStorage.getItem(HINT_KEY) || '';
  } catch {
    return '';
  }
}

function saveHint(email) {
  try {
    if (email) localStorage.setItem(HINT_KEY, email);
  } catch {
    /* ignore */
  }
}

function clearHint() {
  try {
    localStorage.removeItem(HINT_KEY);
  } catch {
    /* ignore */
  }
}

const actions = {
  signin: () => signIn(),
  'signin-other': () => signIn('select_account'),
  'signin-consent': () => signIn('consent'),
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
  'local-create': () => createLocal(),
  'local-allow': () => allowLocalFolder(),
  'local-forget': () => forgetLocalFolder(),
  'local-protect': () => protectLocal(),
  'local-backup': () => backupLocal(),
  'local-restore': () => restoreLocal(),
  'local-strays': () => encryptStrays(),
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
    if (!state.unlocked || $('dialog[open]')) return;
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
