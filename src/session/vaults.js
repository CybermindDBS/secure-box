/**
 * Opening a vault. The Vault tab's card while locked (choose a place, sign in, unlock, create a
 * master password, bring the one you have, Emergency Kit, recovery, problems), unlocking, and
 * switching between vaults without locking.
 *
 * Unlock: sign in (or open this device's vault) -> load the key ring and the encrypted vault ->
 * the master password (PBKDF2) unwraps the master key -> the vault is decrypted in this browser.
 */
import { DEMO_PASSWORD, createDemoBackend } from '../core/demo.js';
import { GoogleError, beginGoogleSignIn, reconnectWithPopup, takeGoogleRedirect } from '../core/google.js';
import {
  KeyringError,
  createKeyring,
  emergencyKitText,
  isNewer,
  keyFileKind,
  parseKeyring,
  passwordProblem,
  recoveryKeyFromKit,
  serializeKeyring,
  trustedRevision,
  unlockWithPassword,
  unlockWithRecovery,
  verifyRevision,
  withNewPassword,
} from '../core/keyring.js';
import { LocalError, allowFolder, createLocalBackend, findLocalVaults } from '../core/localstore.js';
import { MicrosoftError, beginMicrosoftSignIn, reconnectMicrosoftWithPopup, takeMicrosoftRedirect } from '../core/microsoft.js';
import { forgetStreams, startStreaming } from '../core/stream.js';
import { VaultError, emptyVault, movedNote, parseEnvelope } from '../core/vault.js';
import { ask, confirmDialog, crossFade, reducedMotion, toast } from './bridge.js';
import { driveFresh, ensureDrive, lock, noteActivity, setSyncStatus, startAutoLock } from './cloud.js';
import { bringOver } from './bringover.js';
import { checkStrays, chooseDeviceWhere, deviceBackend, deviceBackendForSession, deviceVaultGone, openDeviceVault, refreshDeviceStatus, relocateDevice, showMissingDevice } from './device.js';
import { files } from './files.js';
import { copyText, downloadFile } from './io.js';
import * as memory from './memory.js';
import { replaceNav } from './nav.js';
import { PROVIDERS, backendFor, cipherFor, clientIdOf, cloudApp, companyName, currentProvider, folderPath, isDevice, knownVaultsElsewhere, microsoftReady, movedTo, placeOfVault, previousClientId, providerName, yourVault } from './places.js';
import { pref } from './prefs.js';
import { DEMO, pause, publish, state } from './store.js';
import { tools } from './tools.js';
import { leaveEditing } from './viewer.js';
import { channel, listenToOtherWindows, requestSession } from './windows.js';

const LOCK_MESSAGES = {
  idle: 'Locked after a period of inactivity.',
  expired: 'Your session ended. Unlock to continue.',
  other: 'Locked from another Secure Box window.',
  deleted: 'Your vault on this device was deleted.',
  moved: 'Your vault was moved in another window. Unlock to open it in its new place.',
  gone: 'Locked: your vault was deleted or moved while it was open.',
};

/** Why this window locked, for the unlock card: "idle", or "idle:2" when 2 unfinished uploads stopped with it. */
function lockMessageOf(reason) {
  const [kind, count] = String(reason || '').split(':');
  const n = Number(count) || 0;
  const message = LOCK_MESSAGES[kind] || '';
  if (!message || !n) return message;
  return `${message} ${n === 1 ? 'An upload that hadn’t finished was' : `${n} uploads that hadn’t finished were`} stopped: upload ${n === 1 ? 'it' : 'them'} again.`;
}

let streamingStarted = Promise.resolve();
export const streamingReady = () => streamingStarted;

// ===========================================================================
// Starting up
// ===========================================================================
let deferredSignIn = null; // a background sign-in that waits until the Vault tab is opened

export async function boot() {
  const reason = memory.takeLockReason();
  state.lockMessage = lockMessageOf(reason);
  state.section = pref('lockedSection');
  publish();
  streamingStarted = startStreaming({ describe: describeForStream, read: readForStream }).then((ok) => {
    state.streaming = ok;
  });

  if (DEMO) {
    showWorking('Preparing the demo vault…');
    const faults = new URLSearchParams(location.search).get('faults');
    // ?demo&faults=newapp: Secure Box connects to the demo's cloud as a new app, so it finds
    // nothing there; the sample vault is with its previous connection, to be brought over.
    // oldgone: likewise, but that previous connection is gone (the download is the way back).
    const newApp = /(^|,)\s*(newapp|oldgone)\s*(,|$)/.test(faults || '');
    // ?demo&files=N: a big vault, to see how Secure Box handles thousands of files.
    const photos = Math.min(20000, Math.max(0, Math.trunc(Number(new URLSearchParams(location.search).get('files')) || 0)));
    state.backend = await createDemoBackend({ empty: newApp, photos });
    if (newApp) state.demoPrevious = { backend: await createDemoBackend(), gone: /(^|,)\s*oldgone\s*(,|$)/.test(faults) };
    state.demoBackend = state.backend; // the demo's stand-in for the clouds
    if (faults) (await import('./faults.js')).injectFaults(state.backend, faults);
    state.identity = state.backend.identity;
    state.provider = 'google';
    state.config = { autoLockMinutes: 10, sessionHours: 8 };
    await streamingStarted;
    listenToOtherWindows();
    if (!reason && (await joinOtherWindow())) return;
    showWelcome({ message: state.lockMessage });
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
    if (new URLSearchParams(location.hash.slice(1)).has('state')) {
      state.section = 'vault'; // back from signing in, which started on the Vault tab
      showWorking('Signing in…');
    }
    auth = (await takeMicrosoftRedirect(state.config.microsoftClientId)) || takeGoogleRedirect(state.config.googleClientId);
  } catch (err) {
    // A background sign-in that needs the person (signed out, another account…) just shows the places.
    showWelcome(err.silent ? { message: state.lockMessage } : { message: err.message, tone: 'error' });
    return;
  }
  // Another unlocked Secure Box window in this browser can hand over its session: no sign-in,
  // no password. Not right after a lock, which locks every window anyway.
  if (!reason && (await joinOtherWindow(auth))) return;
  if (!auth) {
    await streamingStarted;
    const last = memory.lastProvider();
    if (last === 'local' && (await openDeviceVault({ quiet: true }))) return;
    if (last && last !== 'local' && silentSignInAllowed()) {
      if (state.section === 'tools') {
        // Using the tools: the background sign-in (a quick trip to the cloud and back) waits
        // until you open the Vault tab, so nothing jumps away under you.
        deferredSignIn = () => silentSignIn(reason);
        showWelcome({ message: state.lockMessage });
        return;
      }
      silentSignIn(reason);
    } else showWelcome({ message: state.lockMessage });
    return;
  }
  state.section = 'vault';
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
  await streamingStarted;
  await openAccount();
}

/** The Vault tab was opened: a background sign-in that waited for it goes now. */
export function runDeferredSignIn() {
  const run = deferredSignIn;
  deferredSignIn = null;
  if (run && !state.unlocked && state.gate.panel === 'places') run();
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

// ===========================================================================
// Streaming: the service worker asks for a file's key and where to read it
// ===========================================================================
// Vaults left this session (newest first), so downloads that started in them finish after a
// switch: a ZIP asks for each file as it gets there. They're dropped on lock, like everything else.
const leftVaults = [];

function rememberLeftVault() {
  if (!state.backend || !state.vault) return;
  leftVaults.unshift({ backend: state.backend, vault: state.vault });
  leftVaults.length = Math.min(leftVaults.length, 4);
}

const streamSources = () => [{ backend: state.backend, vault: state.vault }, ...leftVaults];

async function describeForStream(fileId, options) {
  if (!state.unlocked) return null;
  for (const { backend, vault } of streamSources()) {
    const entry = vault?.files.find((f) => f.id === fileId);
    if (entry) return { entry, ...(await backend.describe(entry, options)) };
  }
  return null;
}

/** Encrypted bytes of a file being streamed (by its copy's name), from whichever vault it belongs to. */
function readForStream(name, start, end) {
  const source = streamSources().find(({ vault }) => vault?.files.some((f) => f.blob === name));
  return (source?.backend || state.backend).readBytes(name, start, end);
}

// ===========================================================================
// The Vault tab's card
// ===========================================================================
export function showPanel(panel, data = {}) {
  state.gate = { panel, ...data };
  publish();
}

/** Changes what the card shows without changing the step. */
export function patchGate(patch) {
  state.gate = { ...state.gate, ...patch };
  publish();
}

export const setGateError = (error, code = '') => patchGate({ error, errorCode: code });

export function showWorking(text) {
  showPanel('working', { text });
}

/** The first card: the places your vault can live. */
export function showWelcome({ message = '', tone = 'info' } = {}) {
  adoptAbort?.abort();
  showPanel('places', { message, tone });
}

/**
 * Something went wrong: what happened, the one thing to do, and always "Open another vault".
 * `deletable`: the vault on this device that couldn't be opened can be deleted from here;
 * `forgettable`: one that's gone can be forgotten.
 */
export function showError({ title, message, action = 'retry', actionLabel = 'Try again', deletable = false, forgettable = false }) {
  showPanel('problem', { title, message, action, actionLabel, deletable, forgettable });
}

/** The Vault tab's places: open the vault there. */
export function openPlace(provider) {
  if (DEMO) return openAccount();
  if (provider === 'local') return openDeviceVault();
  return signIn('', provider);
}

export function signIn(prompt = '', provider = currentProvider()) {
  if (DEMO) return openAccount();
  if (provider === 'local') return openDeviceVault();
  if (prompt === 'select_account') memory.clearHint(provider);
  memory.rememberProvider(provider);
  state.provider = provider;
  showWorking(`Redirecting to ${companyName(provider)}…`);
  if (provider === 'microsoft') {
    return beginMicrosoftSignIn({ clientId: state.config.microsoftClientId, loginHint: memory.readHint('microsoft'), prompt }).catch((err) =>
      showWelcome({ message: err.message, tone: 'error' }),
    );
  }
  beginGoogleSignIn({ clientId: state.config.googleClientId, loginHint: memory.readHint('google'), prompt });
  return undefined;
}

export function retry() {
  if (currentProvider() === 'local' && !DEMO) return openDeviceVault();
  if (DEMO || (state.auth && state.auth.expiresAt - Date.now() > 120_000)) return openAccount();
  return signIn('', currentProvider());
}

/** The main button of a problem card. */
export function problemAction(action) {
  const run = {
    retry: () => retry(),
    reload: () => location.reload(),
    signin: () => signIn('', 'google'),
    'signin-microsoft': () => signIn('', 'microsoft'),
    'signin-consent': () => signIn('consent', currentProvider()),
    'device-relocate': () => relocateDevice(),
    'show-welcome': () => showWelcome(),
    'bring-over': () => bringOver(),
  }[action];
  return (run || retry)();
}

export function useAuth(auth) {
  auth.provider ||= 'google';
  state.auth = auth;
  state.auths = { ...state.auths, [auth.provider]: auth };
  state.provider = auth.provider;
  state.identity = auth.identity;
  memory.saveHint(auth.identity.email, auth.provider);
  memory.rememberProvider(auth.provider);
  publish();
}

/**
 * A cloud sign-in in a pop-up, while Secure Box stays unlocked (or on the card). Must come from a
 * click. `chooseAccount`: the account chooser, for an account other than the one used before;
 * `loginHint`: the account to sign in again (by default the one used last here). `clientId`:
 * through another of Secure Box's connections to that cloud (its previous one, bringover.js);
 * `previous` ({ identity }): the Microsoft account it must be.
 */
export async function signInPopup(provider, { signal, chooseAccount = false, loginHint = memory.readHint(provider), expectedSub, clientId = clientIdOf(provider), previous } = {}) {
  const prompt = chooseAccount ? 'select_account' : '';
  const hint = chooseAccount ? '' : loginHint;
  if (provider === 'microsoft') return reconnectMicrosoftWithPopup({ clientId, loginHint: hint, prompt, signal, previous });
  return { ...(await reconnectWithPopup({ clientId, loginHint: hint, expectedSub, prompt, signal })), provider: 'google' };
}

// ===========================================================================
// Unlock, create, recover
// ===========================================================================
export async function openAccount() {
  showWorking('Opening your Secure Box…');
  try {
    state.loaded = await state.backend.load();
    state.keyringDoc = state.loaded.keyring ? parseKeyring(state.loaded.keyring) : null;
    const note = state.loaded.vault && movedNote(state.loaded.vault.text);
    // The vault moved away from here (from another device, say): where it went, and the way there.
    if (note) showPanel('vault-moved', { to: note.to, at: note.at, text: movedTo(note, state.provider) });
    else if (!state.keyringDoc && state.loaded.vault) showPanel('missing-keyring');
    // Nothing here, but the vault is in the Google Drive bin: it can come back as it was.
    else if (!state.keyringDoc && state.loaded.inBin) showPanel('vault-missing', { kind: 'bin' });
    // A vault an earlier version of Secure Box made (Google Drive finds it apart, by its old tags).
    else if (!state.keyringDoc && state.loaded.otherVersion === 'here') {
      showError({
        title: 'This vault is from another version',
        message: `Your ${providerName()} has a vault made by another version of Secure Box, so this one can’t open it. To start over, move the “Secure Box” folder in your Google Drive to the bin, then try again.`,
      });
    }
    // ...and that vault is in the bin now, put there to start over: a new vault can be made here.
    else if (!state.keyringDoc && state.loaded.otherVersion === 'bin') {
      memory.forgetCloudVault(state.provider, state.identity?.email);
      showStart();
    }
    // Nothing here while Secure Box moves over from its previous connection to this cloud (a new
    // Google project or Microsoft app sees nothing the old one made): the vault can be there.
    else if (!state.keyringDoc && previousClientId(state.provider)) showPanel('vault-missing', { kind: 'previous', had: memory.hadCloudVault(state.provider, state.identity?.email) });
    // Nothing here, and this browser last opened a vault here as another app: it's still there,
    // out of this app's sight, and the cloud's own download is the way back.
    else if (!state.keyringDoc && memory.hadCloudVault(state.provider, state.identity?.email) && ![cloudApp(state.provider), ''].includes(memory.cloudVaultApp(state.provider, state.identity?.email))) {
      showPanel('vault-missing', { kind: 'app' });
    }
    // Nothing here, but this account had a vault: it was deleted outside Secure Box.
    else if (!state.keyringDoc && memory.hadCloudVault(state.provider, state.identity?.email)) showPanel('vault-missing', { kind: 'cloud' });
    else if (!state.keyringDoc) showStart();
    else showUnlock();
  } catch (err) {
    handleError(err);
  }
}

/** Vault-missing card (Google Drive) → Restore it: takes the vault out of the bin, then opens it. */
export async function restoreFromBin() {
  showWorking('Taking your vault out of the bin…');
  try {
    await state.backend.restoreFromBin();
    await openAccount();
  } catch (err) {
    handleError(err);
  }
}

/** Vault-missing card (a cloud) → Start a new vault: Secure Box forgets the deleted one here. */
export function startOverInCloud() {
  memory.forgetCloudVault(state.provider, state.identity?.email);
  showStart();
}

export function showUnlock(error = '') {
  showPanel('unlock', { error, status: state.lockMessage, demoPassword: DEMO ? DEMO_PASSWORD : '' });
  state.lockMessage = '';
}

/** Why a master password didn't open the key ring, as helpfully as this browser can say. */
function wrongPasswordText(err, doc) {
  if (err.code !== 'wrong-password') return err.message;
  const known = memory.keyringMemory(doc?.kid);
  const claimed = Number(doc?.revision) || 0;
  if (known?.passwordRevision && claimed < known.passwordRevision) {
    // This copy missed a master password change made elsewhere (#19).
    const when = new Date(known.passwordChangedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `This vault still has your previous master password: you changed it on ${when} in another vault. Enter the previous one once, and this vault takes the new one.`;
  }
  return 'That master password is not correct.';
}

export async function unlock(password) {
  if (!state.keyringDoc) return showWelcome(); // nothing to unlock here (any more)
  if (!password) return setGateError('Enter your master password.');
  setGateError('');
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
    await openVault(master);
  } catch (err) {
    if (err instanceof KeyringError) setGateError(wrongPasswordText(err, state.keyringDoc), err.code);
    else handleError(err);
  }
}

export async function openVault(master, { unlockedAt } = {}) {
  const cipher = await cipherFor(master);
  if (!state.loaded.vault) {
    state.pendingApp = { master, cipher };
    showPanel('missing-vault');
    return;
  }
  const envelope = parseEnvelope(state.loaded.vault.text);
  if (envelope.kid !== master.kid) throw new VaultError('wrong-key', 'Your vault and key ring belong to different keys. Restore the matching files from the trash (recycle bin) where they’re stored.');
  const vault = await cipher.open(envelope);
  enterApp({ master, cipher, vault, rev: state.loaded.vault.rev, unlockedAt });
}

export async function startNewVault() {
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

export async function createAccount(password, confirm) {
  const problem = passwordProblem(password, confirm);
  if (problem) return setGateError(problem);
  setGateError('');
  try {
    const { doc, master, recovery } = await createKeyring(password);
    const cipher = await cipherFor(master);
    const vault = emptyVault();
    const rev = await state.backend.create({ keyringText: serializeKeyring(doc), vaultText: await cipher.seal(vault), kid: master.kid });
    state.keyringDoc = doc;
    memory.rememberKeyring(master.kid, trustedRevision(doc));
    state.pendingApp = { master, cipher, vault, rev };
    state.pendingKit = recovery;
    showPanel('kit', { id: recovery.id });
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------------------
// A place with no vault yet. First the question that decides everything: is this the first
// vault (create a master password), or one more for the master password you already have?
// ---------------------------------------------------------------------------
export function showStart() {
  const here = currentProvider();
  const known = knownVaultsElsewhere(here);
  showPanel('start', {
    title: here === 'local' ? 'No vault on this device yet' : `No vault in your ${providerName(here)} yet`,
    hint: known.length ? `You’ve used Secure Box with ${known.join(' and ')} in this browser. To keep that master password, choose “No, I already have one”.` : '',
    suggested: known.length > 0,
  });
}

export const showCreate = () => showPanel('create');

// ---------------------------------------------------------------------------
// One more vault for the master password you already have, in two steps: bring the key ring of a
// vault you have (a cloud signs in, in a pop-up; this device's is read here; or a key ring backup
// file), then unlock it. When Secure Box is unlocked, switching vaults does all this.
// ---------------------------------------------------------------------------
let adoptAbort = null; // cancels a sign-in pop-up that's still open

export async function showAdopt() {
  state.adoptDoc = null;
  const here = currentProvider();
  const sources = PROVIDERS.filter((p) => p !== here && p !== 'local' && (p !== 'microsoft' || microsoftReady()) && !DEMO);
  showPanel('adopt', {
    step: 'source',
    intro: `Your new ${placeOfVault(here)} starts empty, and opens with the same master password and Emergency Kit as your other vaults.`,
    sources,
    local: '',
  });
  if (here !== 'local') {
    // This device's vault is offered once one is found.
    const vaults = await findLocalVaults({ demo: DEMO }).catch(() => []);
    const pick = vaults.find((v) => v.kid === memory.deviceChoice()?.kid) || vaults[0];
    if (pick && state.gate.panel === 'adopt') patchGate({ local: pick.where === 'folder' ? `Its vault in ${folderPath(pick.name)}` : 'Its vault in this browser' });
  }
}

const adoptWaiting = (waiting, cancellable = false) => patchGate({ waiting, cancellable });

/** What went wrong while bringing a key ring from `place`, and what to do instead. */
function adoptProblem(err, place) {
  if (err?.code === 'popup-closed') return `The ${place} sign-in window was closed before you signed in. Choose ${place} again when you’re ready.`;
  if (err?.code === 'network') return `Couldn’t reach ${place} just now. Check your connection and try again, or bring the key ring another way.`;
  if (err?.code === 'popup-blocked') return err.message;
  if (err?.code === 'other-version') return `${err.message} Go back and choose “Yes, it’s my first” to start afresh.`;
  if (err?.code === 'bad-keyring') return `The key ring in ${place} is damaged. Bring it another way, for example from a key ring backup.`;
  if (err instanceof GoogleError || err instanceof MicrosoftError) return `${place} said: ${err.message}`;
  return err?.message || String(err);
}

/** Fetches the key ring of the vault in `from` ('google', 'microsoft' or 'local'). */
export async function adoptFrom(from) {
  const place = from === 'local' ? 'this device' : providerName(from);
  setGateError('');
  adoptAbort = new AbortController();
  try {
    let text;
    let found;
    if (from === 'local') {
      adoptWaiting('Reading the key ring on this device…');
      const vaults = await findLocalVaults({ demo: DEMO });
      const pick = vaults.find((v) => v.kid === memory.deviceChoice()?.kid) || vaults[0];
      if (!pick) throw new Error('There’s no vault on this device any more.');
      if (pick.where === 'folder' && !pick.ready && !(await allowFolder(pick.handle))) throw new Error('Secure Box wasn’t allowed to open its folder.');
      text = (await createLocalBackend({ where: pick.where, handle: pick.handle || null, kid: pick.kid, demo: DEMO, existing: true }).load()).keyring;
      if (!text) throw new Error('The vault on this device has no key ring.');
      found = pick.where === 'folder' ? `The key ring of your vault in ${folderPath(pick.name)}` : 'The key ring of your vault in this browser';
    } else {
      adoptWaiting(`Sign in with ${companyName(from)} in the pop-up window…`, true);
      const auth = await signInPopup(from, { signal: adoptAbort.signal });
      if (!auth.driveGranted) throw new Error(`Secure Box needs access to ${place}. Try again, and allow it when ${companyName(from)} asks.`);
      auth.provider = from;
      state.auths = { ...state.auths, [from]: auth }; // switching to that vault later needs no new sign-in
      memory.saveHint(auth.identity.email, from);
      adoptWaiting(`Fetching the key ring from ${place}…`);
      text = (await backendFor(auth).load()).keyring;
      if (!text) throw new Error(`There’s no Secure Box vault in ${place} for ${auth.identity.email}. If yours is in another ${companyName(from)} account, try again and choose that one.`);
      found = `The key ring of your ${place} vault (${auth.identity.email})`;
    }
    state.adoptDoc = parseKeyring(text);
    patchGate({ step: 'unlock', found, waiting: '', error: '' });
  } catch (err) {
    state.adoptDoc = null;
    patchGate({ waiting: '', error: err?.code === 'cancelled' ? '' : adoptProblem(err, place) });
  } finally {
    adoptAbort = null;
  }
}

export const adoptStop = () => adoptAbort?.abort();

export function adoptChange() {
  state.adoptDoc = null;
  patchGate({ step: 'source', found: '', error: '' });
}

/** A key ring backup file, chosen on the card. */
export async function adoptKeyringFile(file) {
  if (!file) return;
  setGateError('');
  const text = await file.text();
  try {
    state.adoptDoc = parseKeyring(text);
    patchGate({ step: 'unlock', found: `The key ring backup “${file.name}”` });
  } catch (err) {
    state.adoptDoc = null;
    if (keyFileKind(text) === 'kit') return setGateError('That’s an Emergency Kit, not a key ring backup. A key ring backup is the .json file saved with ⋯ → Key ring backup.');
    setGateError(err?.code === 'other-version' ? adoptProblem(err) : 'That file isn’t a Secure Box key ring backup. It’s the .json file saved with ⋯ → Key ring backup.');
  }
}

export async function adoptKeyring(secret) {
  const doc = state.adoptDoc;
  if (!doc) return setGateError('First choose where one of your vaults is.');
  if (!secret) return setGateError('Enter your master password.');
  setGateError('');
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
    memory.rememberKeyring(master.kid, await verifyRevision(doc, master));
    const cipher = await cipherFor(master);
    const vault = emptyVault();
    const rev = await state.backend.create({ keyringText: serializeKeyring(doc), vaultText: await cipher.seal(vault), kid: master.kid });
    state.keyringDoc = doc;
    state.adoptDoc = null;
    enterApp({ master, cipher, vault, rev });
    toast(`${yourVault(state.provider).replace(/^y/, 'Y')} is ready, with the same master password`);
  } catch (err) {
    if (err instanceof KeyringError) setGateError(err.message, err.code);
    else handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Emergency Kit (right after creating a master password)
// ---------------------------------------------------------------------------
export function downloadKit(recovery = state.pendingKit) {
  downloadFile(`Secure Box Emergency Kit (${recovery.id}).txt`, emergencyKitText({ email: state.identity?.email, recovery }), 'text/plain;charset=utf-8');
}

/** Another way to keep it, where downloads don't land anywhere visible (#19). */
export async function copyRecoveryKey(recovery = state.pendingKit) {
  await copyText(recovery.text, { sensitive: true });
  toast('Recovery key copied · cleared from the clipboard in 30 s');
}

export const pendingRecoveryKey = () => state.pendingKit?.text || '';

export function finishKit() {
  state.pendingKit = null;
  enterApp(state.pendingApp);
  toast('Your vault is ready');
}

// ---------------------------------------------------------------------------
// Forgot the master password: the Emergency Kit sets a new one
// ---------------------------------------------------------------------------
let recoveryText = '';

export function showRecover() {
  recoveryText = '';
  showPanel('recover', { deletable: isDevice() }); // a cloud vault is deleted in the cloud, not from here
}

export async function recoverKitFile(file) {
  if (!file) return;
  const text = await file.text();
  if (keyFileKind(text) === 'keyring') return setGateError('That’s a key ring backup, not an Emergency Kit. Choose the “Secure Box Emergency Kit” .txt file.');
  try {
    recoveryText = recoveryKeyFromKit(text);
    patchGate({ fileName: file.name, error: '' });
  } catch (err) {
    setGateError(err.message);
  }
}

export async function recover({ key, password, confirm }) {
  const recovery = key.trim() || recoveryText;
  if (!recovery) return setGateError('Load your Emergency Kit file or type the recovery key from it.');
  const problem = passwordProblem(password, confirm);
  if (problem) return setGateError(problem);
  setGateError('');
  try {
    const master = await unlockWithRecovery(state.keyringDoc, recovery);
    await verifyRevision(state.keyringDoc, master);
    const doc = await withNewPassword(state.keyringDoc, master, password, { after: memory.keyringMemory(master.kid)?.revision || 0 });
    await state.backend.saveKeyring(serializeKeyring(doc));
    state.keyringDoc = doc;
    memory.rememberKeyring(master.kid, trustedRevision(doc), { passwordChanged: true });
    recoveryText = '';
    await openVault(master);
    toast('Master password changed — you’re in');
  } catch (err) {
    if (err instanceof KeyringError) setGateError(err.message, err.code);
    else handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Problems: what happened and the way on
// ---------------------------------------------------------------------------
export function handleError(err) {
  console.error(err);
  if (err instanceof MicrosoftError) {
    if (err.code === 'expired') return showError({ title: 'Please sign in again', message: err.message, action: 'signin-microsoft', actionLabel: 'Continue with Microsoft' });
    if (err.code === 'drive-scope') return showError({ title: 'OneDrive access is needed', message: err.message, action: 'signin-consent', actionLabel: 'Continue with Microsoft' });
    if (err.code === 'network') return showError({ title: 'OneDrive can’t be reached', message: 'Check your connection and try again. Your vault is safe where it is.' });
    return showError({ title: 'OneDrive problem', message: err.message });
  }
  if (err instanceof GoogleError) {
    if (err.code === 'expired') return showError({ title: 'Please sign in again', message: err.message, action: 'signin', actionLabel: 'Continue with Google' });
    if (err.code === 'drive-scope') return showError({ title: 'Google Drive access is needed', message: err.message, action: 'signin-consent', actionLabel: 'Continue with Google' });
    if (err.code === 'network') return showError({ title: 'Google Drive can’t be reached', message: 'Check your connection and try again. Your vault is safe where it is.' });
    return showError({ title: err.code === 'drive-disabled' ? 'Turn on the Google Drive API' : 'Google Drive problem', message: err.message });
  }
  if (err instanceof LocalError && err.code === 'gone') return showMissingDevice(err.message);
  if ((err instanceof KeyringError || err instanceof VaultError) && err.code === 'other-version') {
    const startOver = isDevice()
      ? 'You can delete it below and start over.'
      : state.provider === 'microsoft'
        ? 'To start over, delete what’s in “Apps/Secure Box” in your OneDrive, then reload this page.'
        : 'To start over, move the “Secure Box” folder in your Google Drive to the bin, then reload this page.';
    return showError({ title: 'This vault is from another version', message: `${err.message} ${startOver}`, deletable: isDevice() });
  }
  if (err instanceof VaultError || err instanceof KeyringError) return showError({ title: 'Couldn’t open your vault', message: err.message, deletable: isDevice() });
  return showError({ title: 'Something went wrong', message: err?.message || String(err) });
}

// ===========================================================================
// Unlocked
// ===========================================================================
let arrivingTimer = 0;

/** A vault that has just appeared rises in, a few rows at a time. */
export function markArriving() {
  state.arriving = Date.now();
  clearTimeout(arrivingTimer);
  arrivingTimer = setTimeout(() => {
    state.arriving = 0;
    publish();
  }, 900);
}

export function enterApp({ master, cipher, vault, rev, unlockedAt = Date.now() }) {
  // A window that joined another keeps that window's unlock time, so the session limit still holds.
  Object.assign(state, { master, cipher, vault, rev, lastSync: Date.now(), unlocked: true, unlockedAt, pendingApp: null });
  noteActivity();
  channel?.postMessage({ type: 'unlocked', sub: state.identity?.sub });
  state.provider ||= state.backend?.provider || 'google';
  state.masters = new Map([[master.kid, { master, keyringDoc: state.keyringDoc }]]);
  state.kids = { ...state.kids, [state.provider]: master.kid };
  if (isDevice()) memory.rememberDeviceChoice({ kid: master.kid, where: state.backend.where });
  else memory.rememberCloudVault(state.provider, state.identity?.email, master.kid, cloudApp(state.provider));
  memory.rememberProvider(state.provider);
  // The tab: back to the tools if they asked for the unlock (or you were there), else the
  // vault's tab you used last.
  const fromTools = state.returnTo === 'tools';
  const toTools = fromTools || state.section === 'tools';
  state.returnTo = null;
  state.section = toTools ? 'tools' : pref('section');
  state.gate = { panel: 'unlocked' };
  markArriving();
  replaceNav();
  setSyncStatus('idle');
  refreshDeviceStatus();
  if (isDevice()) checkStrays();
  startAutoLock();
  publish();
  if (fromTools) tools.afterUnlock(); // a message waiting to be read opens now
  files.vaultChanged(); // and encrypted copies still to delete from earlier get another try
  files.checkCopies(); // and ones deleted outside Secure Box are marked
  // Every copy of the key ring this device can reach goes to the newest revision.
  verifyRevision(state.keyringDoc, master)
    .then((revision) => {
      memory.rememberKeyring(master.kid, revision);
      return spreadKeyring();
    })
    .catch((err) => console.warn('Key ring check:', err));
}

// ===========================================================================
// Switching vaults without locking. The open vault steps aside at once and a loader takes its
// place inside Passwords and Files; then the other vault rises in. If it doesn't open, the vault
// that was open comes back the same way.
// ===========================================================================
const SWITCH_MIN_MS = 650; // a loader that flashes for a frame reads as a glitch, not a step

export const switchTitle = (provider) => `Opening ${yourVault(provider)}`;

function switchStepText(provider, step) {
  return (
    {
      signin: `Sign in with ${companyName(provider)} in the pop-up window`,
      find: 'Looking for your vault on this device…',
      load: provider === 'local' ? 'Reading your encrypted vault…' : `Fetching your encrypted vault from ${providerName(provider)}…`,
      decrypt: 'Decrypting it with your master key…',
      own: 'This vault has its own master password…',
      create: 'Setting up your new vault…',
    }[step] || 'Just a moment…'
  );
}

function beginSwitching(provider) {
  state.switching = { provider, step: switchStepText(provider), since: performance.now() };
  crossFade(() => publish({ now: true })).catch((err) => console.warn('Switching:', err));
}

function setSwitchStep(step) {
  if (!state.switching) return;
  state.switching = { ...state.switching, step: switchStepText(state.switching.provider, step) };
  publish();
}

/** Keeps the loader up long enough to read as a step rather than a flicker. */
async function settleSwitching() {
  const left = SWITCH_MIN_MS - (performance.now() - (state.switching?.since ?? 0));
  if (left > 0) await pause(left);
}

/** The other vault didn't open (cancelled, declined or failed): the open one comes back. */
async function returnToOpenVault() {
  if (!state.switching) return;
  if (!state.unlocked) {
    state.switching = null; // locking: the page reloads
    return;
  }
  await crossFade(() => {
    state.switching = null;
    markArriving();
    publish({ now: true });
  }).catch((err) => console.warn('Switching back:', err));
}

/**
 * Opens another vault without locking: the master key stays in memory, so a vault with the same
 * key opens without a password, and a place without a vault gets one, with the same password.
 */
export async function switchVault(provider) {
  if (!PROVIDERS.includes(provider) || provider === state.provider || !state.unlocked || state.switching) return;
  if (tools.busy()) return toast('Finish or cancel the encryption that’s running first.', 'error');
  if (!(await leaveEditing())) return; // a text file's unsaved changes: only once let go
  if (files.unfinished()) {
    // Unfinished uploads (paused ones too) belong to this vault: stop them before another one opens.
    const ok = await confirmDialog({
      title: 'Stop the uploads?',
      message:
        state.provider === 'local'
          ? 'Some files haven’t finished saving to your vault on this device. Stop them and switch? They won’t be saved.'
          : `Some files haven’t finished uploading to your ${providerName()} vault. Stop them and switch? They won’t be saved.`,
      confirmLabel: 'Stop and switch',
    });
    if (!ok) return;
    await files.stopAll();
  }
  beginSwitching(provider);
  let opened = false;
  let backend = null;
  let goneHere = null; // this device's vault turned out deleted or moved outside Secure Box
  try {
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
      memory.saveHint(auth.identity.email, provider);
      backend = backendFor(auth);
    }
    setSwitchStep('load');
    const loaded = await backend.load();
    let doc = loaded.keyring ? parseKeyring(loaded.keyring) : null;
    // The vault that was here moved away: a new one can take its place (backend.create clears the note).
    const note = loaded.vault && movedNote(loaded.vault.text);
    if (note) loaded.vault = null;
    if (!doc && loaded.vault) {
      // Every vault keeps its key ring beside it, so this one's was deleted.
      throw new Error(
        provider === 'local'
          ? 'The vault on this device is missing its key ring file (Secure Box Key Ring.json).'
          : `Your ${providerName(provider)} vault is missing its key ring file. Restore “Secure Box Key Ring.json” from the bin there, then try again.`,
      );
    }
    // The key rings this session has open: the open vault's, and any other unlocked since.
    state.masters.set(state.master.kid, { master: state.master, keyringDoc: state.keyringDoc });
    let entry = state.masters.get(state.master.kid);
    if (doc) {
      state.kids = { ...state.kids, [provider]: doc.kid };
      if (doc.kid !== state.master.kid) {
        // A vault with its own key ring (its own master key, even if its password is the same).
        entry = state.masters.get(doc.kid);
        if (!entry) {
          setSwitchStep('own');
          const master = await askOwnPassword(doc, provider);
          if (!master || !state.unlocked) return;
          await verifyRevision(doc, master);
          entry = { master, keyringDoc: doc };
          state.masters.set(doc.kid, entry);
        }
      }
    }
    const cipher = await cipherFor(entry.master);
    let vault;
    let rev;
    if (!doc) {
      // Nothing there yet: set up a vault with the same master password.
      const ok = await confirmDialog({
        title: note ? `Your vault isn’t in ${DEMO ? 'the demo vault' : providerName(provider)} any more` : `Set up ${providerName(provider)}?`,
        message: [
          note ? `It was ${movedTo(note, provider)}.` : '',
          provider === 'local'
            ? 'Your vault on this device starts empty and opens with your current master password and Emergency Kit. Nothing in it is uploaded.'
            : `${note ? 'A new' : 'Your new'} ${DEMO ? 'demo' : providerName(provider)} vault starts empty and opens with your current master password and Emergency Kit.`,
        ].filter(Boolean).join(' '),
        confirmLabel: note ? 'Set up a new vault' : 'Set it up',
        cancelLabel: note ? 'Not now' : undefined,
      });
      if (!ok) return;
      setSwitchStep('create');
      await freshenOpenKeyring();
      vault = emptyVault();
      rev = await backend.create({ keyringText: serializeKeyring(state.keyringDoc), vaultText: await cipher.seal(vault), kid: state.master.kid });
      doc = state.keyringDoc;
    } else {
      doc = await syncKeyring(doc, backend, entry);
      if (loaded.vault) {
        setSwitchStep('decrypt');
        const env = parseEnvelope(loaded.vault.text);
        vault = await cipher.open(env);
        rev = loaded.vault.rev;
      } else {
        setSwitchStep('create');
        vault = emptyVault();
        rev = await backend.createVault(await cipher.seal(vault), entry.master.kid);
      }
    }
    await settleSwitching();
    if (!state.unlocked) return;
    await crossFade(() => {
      state.switching = null;
      enterVault({ provider, backend, auth, keyringDoc: doc, cipher, vault, rev, master: entry.master });
      markArriving();
      publish({ now: true });
    });
    opened = true;
    toast(`Opened ${yourVault(provider)}`);
  } catch (err) {
    console.error(err);
    if (provider === 'local' && err?.code === 'gone') goneHere = Object.assign(err, { kid: err.kid || backend?.kid || '', where: err.where || backend?.where || 'browser' });
    else if (err?.code === 'popup-closed') toast(`The ${companyName(provider)} sign-in window was closed. ${yourVault(state.provider).replace(/^y/, 'Y')} stays open.`);
    else if (err?.code !== 'cancelled') toast(err.message || 'Couldn’t open that vault.', 'error');
  } finally {
    if (!opened) await returnToOpenVault();
  }
  // Asked once the open vault is back in view: the ways on, then this device's vault opens.
  if (goneHere && (await deviceVaultGone(goneHere).catch((err) => toast(err.message, 'error')))) await switchVault('local');
}

/** Makes another vault the open one, without a reload. `master` is its master key. */
export function enterVault({ provider, backend, auth, keyringDoc, cipher, vault, rev, master = state.master }) {
  if (state.backend !== backend) rememberLeftVault(); // its downloads keep going
  if (auth) {
    state.auths = { ...state.auths, [provider]: auth };
    state.auth = auth;
    state.identity = auth.identity;
  } else {
    state.auth = null;
    state.identity = backend.identity;
  }
  Object.assign(state, { provider, backend, keyringDoc, cipher, vault, rev, master, lastSync: Date.now(), selectedId: null, query: '' });
  state.masters.set(master.kid, { master, keyringDoc });
  state.kids = { ...state.kids, [provider]: master.kid };
  state.loaded = null;
  state.revealed = new Set();
  memory.rememberProvider(provider);
  if (provider === 'local') memory.rememberDeviceChoice({ kid: master.kid, where: backend.where });
  else memory.rememberCloudVault(provider, state.identity?.email, master.kid, cloudApp(provider));
  forgetStreams();
  files.reset();
  files.clearTransfers();
  if (state.section === 'vault') state.section = pref('section');
  replaceNav();
  setSyncStatus('idle');
  refreshDeviceStatus();
  if (provider === 'local') checkStrays();
  files.checkCopies();
}

/** A vault with its own key ring: its master password (or recovery key), asked in place. Null if cancelled. */
function askOwnPassword(doc, provider) {
  return ask('ownKey', {
    doc,
    text: `Your ${placeOfVault(provider)} has its own key ring, so the master password you unlocked with doesn’t open it, even if it’s the same words. Enter the master password you use for it.`,
  });
}

/** The own-key dialog's button: resolves with the master key, or throws when it doesn't open. */
export async function openOwnKeyring(doc, secret) {
  try {
    return await unlockWithPassword(doc, secret);
  } catch (err) {
    if (!(err instanceof KeyringError)) throw err;
    return unlockWithRecovery(doc, secret).catch(() => {
      throw new KeyringError('wrong-password', 'That isn’t the master password (or recovery key) of this vault.');
    });
  }
}

// ===========================================================================
// Key rings: every copy goes to the newest revision
// ===========================================================================
/**
 * Keeps every copy of a key ring at the newest revision. `doc` was just read from `backend`;
 * `entry` is what this session knows of that key ring ({ master, keyringDoc }), by default the
 * open vault's. Returns the newest copy.
 */
async function syncKeyring(doc, backend, entry = { master: state.master, keyringDoc: state.keyringDoc }) {
  await verifyRevision(doc, entry.master);
  if (isNewer(doc, entry.keyringDoc)) {
    entry.keyringDoc = doc;
    memory.rememberKeyring(doc.kid, trustedRevision(doc));
    // The other copies catch up now for the open key ring (another key ring's do when its vault is open).
    if (entry.master.kid === state.master.kid) {
      state.keyringDoc = doc;
      spreadKeyring(backend).catch((err) => console.warn('Key ring update:', err));
    }
    return doc;
  }
  if (isNewer(entry.keyringDoc, doc)) await backend.saveKeyring(serializeKeyring(entry.keyringDoc)).catch((err) => console.warn('Key ring update:', err));
  return entry.keyringDoc;
}

/**
 * Brings every vault Secure Box can reach right now up to the newest key ring: the open one, the
 * one on this device and the clouds signed in this session. The newest copy anywhere wins.
 */
export async function spreadKeyring(alreadyDone = null) {
  if (!state.master) return;
  const kid = state.master.kid;
  const reach = [];
  if (state.backend && state.backend !== alreadyDone) reach.push(state.backend);
  const here = (await findLocalVaults({ demo: DEMO }).catch(() => [])).find((v) => v.kid === kid && v.ready);
  if (here && !(isDevice() && state.backend.where === here.where)) reach.push(createLocalBackend({ where: here.where, handle: here.handle || null, kid, demo: DEMO, existing: true }));
  for (const [provider, auth] of Object.entries(state.auths)) {
    if (auth && provider !== state.provider && auth.expiresAt - Date.now() > 60_000) reach.push(backendFor(auth));
  }
  const copies = [];
  for (const backend of reach) {
    try {
      const { keyring } = await backend.load();
      const copy = keyring ? parseKeyring(keyring) : null;
      if (copy?.kid === kid) {
        await verifyRevision(copy, state.master);
        copies.push({ backend, copy });
      }
    } catch (err) {
      console.warn('Key ring check:', err);
    }
  }
  const newest = copies.reduce((best, c) => (isNewer(c.copy, best) ? c.copy : best), state.keyringDoc);
  state.keyringDoc = newest;
  state.masters.set(kid, { master: state.master, keyringDoc: newest });
  memory.rememberKeyring(kid, trustedRevision(newest));
  for (const { backend, copy } of copies) {
    if (copy !== newest && isNewer(newest, copy)) await backend.saveKeyring(serializeKeyring(newest)).catch((err) => console.warn('Key ring update:', err));
  }
}

/** The key ring kept by this device's vault for `kid`, if it's newer than `than`: a fallback at unlock. */
async function newerKeyringHere(than) {
  const here = (await findLocalVaults({ demo: DEMO }).catch(() => [])).find((v) => v.kid === than.kid && v.ready);
  if (!here || (isDevice() && state.backend.where === here.where)) return null;
  try {
    const { keyring } = await createLocalBackend({ where: here.where, handle: here.handle || null, kid: than.kid, demo: DEMO, existing: true }).load();
    const copy = keyring ? parseKeyring(keyring) : null;
    return copy && serializeKeyring(copy) !== serializeKeyring(than) ? copy : null;
  } catch {
    return null;
  }
}

/**
 * Before changing the open key ring (master password, Emergency Kit, a new vault with it): read
 * the copy where the open vault keeps it, in case another window or device changed it since.
 * A change is then made on top of the newest copy, so it never undoes one made elsewhere (#19).
 */
export async function freshenOpenKeyring() {
  if (!state.master || !state.backend) return state.keyringDoc;
  try {
    const { keyring } = await state.backend.load();
    const copy = keyring ? parseKeyring(keyring) : null;
    if (copy?.kid === state.master.kid) {
      await verifyRevision(copy, state.master);
      if (isNewer(copy, state.keyringDoc)) {
        state.keyringDoc = copy;
        state.masters.set(copy.kid, { master: state.master, keyringDoc: copy });
        memory.rememberKeyring(copy.kid, trustedRevision(copy));
      }
    }
  } catch (err) {
    console.warn('Key ring check:', err);
  }
  return state.keyringDoc;
}

/** Another window changed key ring `kid`: read the copy beside the open vault, if it's that one. */
export async function refreshKeyringFromElsewhere(kid) {
  if (state.master?.kid !== kid || state.switching) return;
  await freshenOpenKeyring();
}

// ===========================================================================
// Other windows: open with the session of one that's unlocked
// ===========================================================================
let joining = false;

/**
 * Opens this window with the session of an unlocked one, if there is one. `ownAuth` is this
 * window's own cloud sign-in, if it has one. Returns true when it took over the screen.
 */
export async function joinOtherWindow(ownAuth = null) {
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
      state.backend = deviceBackend({ where: here.where, handle: here.handle || null, kid: here.kid, existing: true });
      state.identity = state.backend.identity;
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
  const provider = memory.lastProvider();
  if (DEMO || !provider || provider === 'local' || !memory.readHint(provider)) return false;
  if (provider === 'microsoft' && !microsoftReady()) return false;
  return Date.now() - memory.lastSilentSignIn() > 20_000;
}

function silentSignIn(reason) {
  memory.noteSilentSignIn();
  if (reason) memory.setLockReason(reason); // still explain the lock after the round trip
  const provider = memory.lastProvider() || 'google';
  state.provider = provider;
  showWorking(`Signing in with ${companyName(provider)}…`);
  if (provider === 'microsoft') {
    beginMicrosoftSignIn({ clientId: state.config.microsoftClientId, loginHint: memory.readHint('microsoft'), silent: true }).catch(() => showWelcome());
    return;
  }
  beginGoogleSignIn({ clientId: state.config.googleClientId, loginHint: memory.readHint('google'), silent: true });
}

