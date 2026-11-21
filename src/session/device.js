/**
 * The vault kept only on this device: making and opening it (in this browser, or in a folder you
 * choose), backups, moving it, deleting it, and what happens when its folder goes missing.
 */
import { parseKeyring, trustedRevision, verifyRevision } from '../core/keyring.js';
import { allowFolder, BROWSER_GONE, createLocalBackend, findLocalVaults, forgetFolder, localSupport, readBackup, vaultIn } from '../core/localstore.js';
import { forgetStreams } from '../core/stream.js';
import { formatBytes } from '../core/filetypes.js';
import { parseEnvelope } from '../core/vault.js';
import { ask, confirmDialog, toast } from './bridge.js';
import { commit, counted, lock, saveChain, vaultGone } from './cloud.js';
import { files } from './files.js';
import { downloadFile, pickFile } from './io.js';
import * as memory from './memory.js';
import { folderPath, isDevice } from './places.js';
import { DEMO, publish, state } from './store.js';
import { channel } from './windows.js';
import { handleError, openAccount, showError, showPanel, showWelcome, showWorking, spreadKeyring, streamingReady } from './vaults.js';

export const notifyVaultChanged = () => channel?.postMessage({ type: 'vault-changed', provider: 'local', kid: state.master?.kid });

/**
 * A backend for a vault on this device, wired to the session: other windows hear of each save,
 * and a vault found deleted outside Secure Box while it's open is reported once (gone.js).
 */
export const deviceBackend = (options) => createLocalBackend({ demo: DEMO, notify: notifyVaultChanged, onGone: (err) => vaultGone(err), ...options });

/** Chrome won't let a site use Documents, Desktop or Downloads themselves, only folders inside them (#9). */
export const FOLDER_HINT = 'Choose a folder inside Documents, or make one in the picker (for example “Vaults”). Browsers don’t allow Documents, Desktop or Downloads themselves.';

/** The folder picker, opening in Documents. Resolves null when cancelled. */
async function pickVaultFolder() {
  try {
    return await window.showDirectoryPicker({ id: 'secure-box-local', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

const placeOf = (backend) => (backend.where === 'folder' ? folderPath(backend.name) : 'this browser');

const setDevice = (patch) => {
  state.device = { ...state.device, ...patch };
  publish();
};

// ===========================================================================
// From the Vault tab
// ===========================================================================
/**
 * Opens this device's vault (the one used last), or offers to make one. With `quiet`, it only
 * opens one that exists, and says whether it did.
 */
export async function openDeviceVault({ quiet = false } = {}) {
  const support = localSupport();
  if (support.ios && !support.standalone) {
    if (!quiet) {
      state.provider = 'local';
      showPanel('device-ios');
    }
    return false;
  }
  if (!support.browser && !support.folder) {
    if (!quiet) showError({ title: 'Not in this browser', message: 'This browser can’t keep a vault on this device. Use an up-to-date Chrome, Edge, Firefox or Safari.', action: 'show-welcome', actionLabel: 'Back' });
    return false;
  }
  const vaults = await findLocalVaults({ demo: DEMO });
  const last = memory.deviceChoice();
  // The vault this device used isn't here any more: say so, rather than offer a new one.
  if (last && !vaults.some((v) => v.kid === last.kid && v.where === last.where)) {
    showMissingDevice(last.where === 'browser' ? BROWSER_GONE : 'Secure Box lost track of the folder that holds your vault on this device.', last.where);
    return true;
  }
  const pick = vaults.find((v) => v.kid === last?.kid && v.where === last?.where) || vaults.find((v) => v.where === 'browser') || vaults[0];
  if (!pick) {
    if (quiet) return false;
    showDeviceNew();
    return true;
  }
  state.provider = 'local';
  if (pick.where === 'folder' && !pick.ready) {
    state.devicePick = pick;
    showPanel('device-allow', { name: pick.name });
    return true;
  }
  await useDeviceVault(pick);
  return true;
}

export function showDeviceNew(error = '') {
  state.provider = 'local';
  state.backend = null;
  showPanel('device-new', { folderOk: localSupport().folder && !DEMO, error });
}

/**
 * A vault this device had is gone, deleted or moved outside Secure Box: what happened, and the
 * ways on (the vault-missing card): try again once it's put back, find its folder, restore a
 * backup, or start over without it.
 */
export function showMissingDevice(message, where = state.backend?.where || memory.deviceChoice()?.where || 'folder') {
  state.provider = 'local';
  const kid = state.backend?.kid || memory.deviceChoice()?.kid || '';
  showPanel('vault-missing', { kind: where === 'browser' ? 'browser' : 'folder', message, kid, backupAt: kid ? memory.backupAt(kid) : 0 });
}

/** Vault-missing card → Start over: Secure Box forgets the missing vault, then opens another here or offers a new one. */
export async function startOverDevice() {
  const kid = state.gate.kid;
  if (kid) await forgetDeletedDevice(kid);
  state.backend = null;
  await openDeviceVault();
}

/** Opens (or prepares to create) this device's vault, ready for its unlock or create card. */
export async function useDeviceVault({ where, handle = null, kid = null }) {
  state.auth = null;
  state.provider = 'local';
  state.backend = deviceBackend({ where, handle, kid, existing: Boolean(kid) });
  state.identity = state.backend.identity;
  memory.rememberProvider('local');
  publish();
  await streamingReady();
  await openAccount();
}

export async function createDeviceVault(where) {
  const inFolder = where === 'folder' && localSupport().folder && !DEMO;
  let handle = null;
  if (inFolder) {
    handle = await pickVaultFolder();
    if (!handle) return;
  } else {
    navigator.storage?.persist?.().catch(() => {}); // ask the browser to keep it (Firefox asks the person)
  }
  await useDeviceVault({ where: inFolder ? 'folder' : 'browser', handle });
}

export async function allowDeviceFolder() {
  const pick = state.devicePick;
  if (!pick) return showWelcome();
  // A folder that's gone can't be allowed: opening it then says what happened.
  const allowed = await allowFolder(pick.handle).catch((err) => (err.name === 'NotFoundError' ? 'gone' : Promise.reject(err)));
  if (!allowed) return showPanel('device-allow', { name: pick.name, error: 'Secure Box wasn’t allowed to open the folder.' });
  await useDeviceVault(pick);
}

export async function forgetDeviceFolderAtGate() {
  const pick = state.devicePick;
  if (pick) {
    await forgetFolder(pick.kid, { demo: DEMO });
    memory.forgetDeviceChoice(pick.kid);
  }
  state.devicePick = null;
  showWelcome({ message: `Secure Box forgot ${pick ? folderPath(pick.name) : 'the folder'}. Its encrypted files are still there.` });
}

/** Vault tab → This device → Restore a backup: makes this device's vault from a backup file. */
export async function restoreDeviceFromGate() {
  const file = await pickFile('.zip,application/zip');
  if (!file) return;
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
    showDeviceNew(err.message);
  }
}

/** Recovery or problem card → Delete this vault: for a vault on this device that can't be opened any more. */
export async function deleteDeviceAtGate() {
  if (!isDevice()) return;
  const backend = state.backend;
  const ok = await confirmDialog({
    title: 'Delete the vault on this device?',
    message: `This deletes its passwords and files from ${placeOf(backend)} for good, without opening it.${backend.where === 'folder' ? ' Anything else in that folder stays.' : ''} Your Google Drive and OneDrive vaults aren’t affected.`,
    confirmLabel: 'Delete vault',
    danger: true,
  });
  if (!ok) return;
  try {
    await backend.removeAll();
  } catch (err) {
    showError({ title: 'Couldn’t delete it', message: err.message, deletable: true });
    return;
  }
  await forgetDeletedDevice(backend.kid);
  channel?.postMessage({ type: 'lock', reason: 'deleted' }); // a window that still had it open
  showWelcome({ message: 'Your vault on this device was deleted.' });
}

/** Missing-vault card → Find the folder: the vault's folder was moved or renamed outside Secure Box. */
export async function relocateDevice() {
  const handle = await pickVaultFolder();
  if (!handle) return;
  const kid = await vaultIn(handle);
  if (!kid) {
    return showError({
      title: 'No vault in that folder',
      message: `“${handle.name}” doesn’t hold a Secure Box vault. Choose the folder that does, or let Secure Box forget the missing one.`,
      action: 'device-relocate',
      actionLabel: 'Find the folder…',
      forgettable: true,
    });
  }
  await useDeviceVault({ where: 'folder', handle, kid }); // remembers the folder where it is now
}

/** Missing-vault card → Forget it: the vault on this device is gone for good. */
export async function forgetGoneDevice() {
  const kid = state.backend?.kid;
  if (kid) await forgetDeletedDevice(kid);
  showWelcome({ message: 'Secure Box forgot the missing vault on this device.' });
}

/** What this browser remembers about a deleted vault on this device: its folder, the choice of it, its last backup. */
async function forgetDeletedDevice(kid) {
  await forgetFolder(kid, { demo: DEMO });
  memory.forgetDeviceChoice(kid);
  memory.forgetBackup(kid);
}

// ===========================================================================
// While unlocked: switching to it, its status bar, backups, moving, deleting
// ===========================================================================
/**
 * This device's vault for the open session: the one with the open key ring, else one with a key
 * ring open this session, else the one used last (if it has its own key ring, switching asks for
 * its password). Only when there's none at all is a new one made, after asking where.
 */
export async function deviceBackendForSession() {
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
  let pick =
    vaults.find((v) => v.kid === state.master.kid) ||
    vaults.find((v) => state.masters.has(v.kid)) ||
    vaults.find((v) => v.kid === memory.deviceChoice()?.kid) ||
    vaults[0];
  const found = Boolean(pick);
  if (!pick) {
    const choice = await chooseDeviceWhere();
    if (!choice) return null;
    pick = { kid: state.master.kid, ...choice, ready: true };
  }
  if (pick.where === 'folder' && !pick.ready && !(await allowFolder(pick.handle))) throw new Error('Secure Box wasn’t allowed to open the folder.');
  return deviceBackend({ where: pick.where, handle: pick.handle || null, kid: pick.kid, existing: found });
}

/**
 * Where a vault on this device goes: the browser's storage, or a folder (Chrome and Edge on
 * computers, Chrome on Android). With `moving` (where it is now), where it moves to.
 */
export async function chooseDeviceWhere({ moving = null } = {}) {
  const folderOk = localSupport().folder && !DEMO;
  if (!moving && !folderOk) return { where: 'browser' };
  const where = await ask('deviceWhere', { moving, folderOk, folderName: moving === 'folder' ? state.backend?.name : '' });
  if (!where) return null;
  if (where === 'folder') {
    const handle = await pickVaultFolder();
    return handle ? { where: 'folder', handle } : null;
  }
  navigator.storage?.persist?.().catch(() => {}); // ask the browser to keep it (Firefox asks the person)
  return { where: 'browser' };
}

/** The bar under the tabs: re-checks whether the browser protects this vault, quietly. */
export function refreshDeviceStatus() {
  if (!state.unlocked || !isDevice()) return;
  const backend = state.backend;
  backend
    .protection()
    .then((protection) => {
      if (protection !== state.device.protection && state.backend === backend) setDevice({ protection });
    })
    .catch(() => {});
}

/** When this device's vault was last backed up, and whether that's long ago. */
export function backupState() {
  if (!isDevice() || state.backend.where !== 'browser') return null;
  const at = memory.backupAt(state.master.kid);
  const changed = Number(String(state.rev || '').split(':')[0]) || 0; // when the vault was last saved
  const stale = !at || (changed > at + 5000 && Date.now() - at > 7 * 86_400_000);
  return { at, stale, empty: !(state.vault.items.length || state.vault.files.length) };
}

export async function protectDevice() {
  const granted = await state.backend.protect();
  setDevice({ protection: await state.backend.protection() });
  if (granted) toast('Protected: the browser won’t clear this vault by itself');
  else toast('The browser said no. Installing Secure Box as an app (Install app, or Add to Home Screen) usually changes that.', 'error');
}

const busyText = (label) => (p) => setDevice({ busy: `${label}… ${Math.floor(p * 100)}%` });

export async function backupDevice() {
  if (!isDevice() || state.device.busy) return;
  let backup;
  try {
    setDevice({ busy: 'Backing up…' });
    backup = await state.backend.backup(state.vault.files, { onProgress: busyText('Backing up') });
    memory.rememberBackup(state.master.kid, Date.now());
  } catch (err) {
    toast(err.message, 'error');
    return;
  } finally {
    setDevice({ busy: '' });
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
export async function restoreDevice() {
  if (!isDevice()) return;
  const file = await pickFile('.zip,application/zip');
  if (!file) return;
  try {
    setDevice({ busy: 'Restoring…' });
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
    setDevice({ busy: '' });
    files.vaultChanged();
  }
}

/** ⋯ → Move this vault: copies it to another place exactly as stored, opens it there, then deletes the old copy. */
export async function moveDevice() {
  if (!isDevice() || state.device.busy) return;
  if (files.unfinished()) return toast('Let the uploads finish, then move the vault.', 'error');
  const source = state.backend;
  const choice = await chooseDeviceWhere({ moving: source.where });
  if (!choice) return;
  const kid = state.master.kid;
  const target = deviceBackend({ where: choice.where, handle: choice.handle || null, kid });
  setDevice({ busy: 'Moving…' });
  try {
    await saveChain; // nothing half-saved left behind in the old place
    const leftover = await source.moveTo(target, {
      onProgress: busyText('Moving'),
      // The copy is complete: from here the app reads and saves there.
      opened: async () => {
        const { vault } = await target.load(); // also remembers a chosen folder
        if (!vault) throw new Error('The copy couldn’t be opened.');
        state.backend = target;
        state.rev = vault.rev;
        memory.rememberDeviceChoice({ kid, where: target.where });
        if (target.where === 'browser') await forgetFolder(kid, { demo: DEMO });
        forgetStreams();
      },
    });
    channel?.postMessage({ type: 'device-moved', kid }); // other windows with it open lock, then open it in its new place
    state.device = { ...state.device, protection: '' };
    if (target.where === 'browser') navigator.storage?.persist?.().catch(() => {});
    if (leftover) toast(`Moved to ${placeOf(target)}, but the old copy couldn’t be deleted: ${leftover.message}`, 'error');
    else toast(`Moved to ${placeOf(target)}`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setDevice({ busy: '' });
    refreshDeviceStatus();
    checkStrays();
  }
}

/** ⋯ → Delete this vault: deletes the vault on this device for good, then locks. */
export async function deleteDevice() {
  if (!isDevice() || state.device.busy) return;
  const backend = state.backend;
  const what = [counted(state.vault.items.length, 'password or note', 'passwords and notes'), counted(state.vault.files.length, 'file', 'files')].filter(Boolean).join(' and ');
  const ok = await confirmDialog({
    title: 'Delete your vault on this device?',
    message: [
      what ? `This deletes its ${what} from ${placeOf(backend)} for good, then locks Secure Box.` : `It’s empty. This deletes it from ${placeOf(backend)}, then locks Secure Box.`,
      backend.where === 'folder' ? 'Anything else in that folder stays.' : what && !memory.backupAt(state.master.kid) ? 'It has never been backed up.' : '',
      'Your Google Drive and OneDrive vaults aren’t affected.',
    ].filter(Boolean).join(' '),
    confirmLabel: 'Delete vault',
    danger: true,
  });
  if (!ok) return;
  await files.stopAll();
  setDevice({ busy: 'Deleting…' });
  try {
    await saveChain; // a save still on its way would bring the vault back
    await backend.removeAll();
  } catch (err) {
    setDevice({ busy: '' });
    toast(`Couldn’t delete it: ${err.message}`, 'error');
    return;
  }
  await forgetDeletedDevice(state.master.kid);
  lock('deleted'); // every window locks: none of them should show the deleted vault
}

export async function forgetDeviceFolder() {
  const name = state.backend?.name || 'this folder';
  const ok = await confirmDialog({
    title: 'Stop using this folder?',
    message: `Secure Box forgets ${folderPath(name)} and locks. The encrypted files stay in the folder: choose it again any time to open them.`,
    confirmLabel: 'Forget folder',
  });
  if (!ok) return;
  await forgetFolder(state.master.kid, { demo: DEMO });
  memory.forgetDeviceChoice(state.master.kid);
  memory.rememberProvider('google');
  lock('manual');
}

/** Plain files put into a folder vault by hand: offer to encrypt them. */
export async function checkStrays() {
  if (!isDevice() || state.backend.where !== 'folder') {
    if (state.device.strays.length) setDevice({ strays: [] });
    return;
  }
  let strays = [];
  try {
    strays = await state.backend.strays();
  } catch {
    strays = [];
  }
  setDevice({ strays });
}

export async function encryptStrays() {
  const strays = state.device.strays;
  if (!strays.length || !isDevice()) return;
  const backend = state.backend;
  const count = strays.length === 1 ? `“${strays[0].name}”` : `${strays.length} files`;
  const ok = await confirmDialog({
    title: `Encrypt ${count}?`,
    message: 'They were put into this vault’s folder by hand, so they aren’t encrypted. Secure Box encrypts each one into the vault, then deletes the unencrypted original.',
    confirmLabel: 'Encrypt',
  });
  if (!ok) return;
  setDevice({ strays: [] });
  await files.enqueue(strays.map((s) => ({ file: s.file, path: s.path, after: () => backend.removeStray(s) })), null);
  await backend.pruneEmptyFolders().catch(() => {});
  await checkStrays();
  files.vaultChanged();
}

