/**
 * The open vault was deleted or moved outside Secure Box while it was open: its folder deleted in
 * Explorer or Finder, this site's data cleared, the Secure Box folder put in the Google Drive bin
 * or deleted from OneDrive. Instead of failing every save, or locking without a word, one dialog
 * says what happened and offers the ways back:
 *   Try again       it was put back (from the Recycle Bin, say): carry on with it
 *   Restore it      Google Drive: take it out of the bin
 *   Save it again   write what's open back: passwords, notes and folders, though not its files
 *   Open it there   it was moved away (from another device): open it in its new place
 *   Lock
 * The save that noticed it goes ahead once the vault is back (cloud.js, commit).
 */
import { serializeKeyring } from '../core/keyring.js';
import { BROWSER_VAULT } from '../experiments.js';
import { forgetFolder, localSupport, vaultIn } from '../core/localstore.js';
import { ask, toast } from './bridge.js';
import { isGone, lock, pullLatest, setSyncStatus } from './cloud.js';
import { deviceBackend, pickVaultFolder, refreshDeviceStatus } from './device.js';
import { files } from './files.js';
import * as memory from './memory.js';
import { companyName, movedWhere, providerName } from './places.js';
import { DEMO, publish, state } from './store.js';
import { switchVault } from './vaults.js';

const NOT_ITS_FILES = 'your passwords, notes and folders come back, but not its files';

/** What the dialog says, and the ways back it offers, for how the open vault went missing. */
async function describe(err) {
  const backend = state.backend;
  if (err.code === 'moved') {
    // Moved away from another window or device: nothing more can be saved here.
    const note = err.note || { to: '' };
    const { where, when } = note.to ? movedWhere(note, state.provider) : { where: 'another place', when: '' };
    const there = note.to && note.to !== state.provider && note.to !== 'local';
    const next = there
      ? 'Open it there to carry on, and make your last change again: it wasn’t saved.'
      : note.to === 'local'
        ? 'Open it on that device, under This device.'
        : note.to === state.provider
          ? `Lock, then sign in with the ${companyName(state.provider)} account it went to.`
          : 'Lock, then open it in its new place.';
    return {
      title: 'Your vault was moved',
      text: `Another window or device moved it to ${where}${when ? ` ${when}` : ''}, so nothing more can be saved here. ${next}`,
      actions: there ? [{ id: `open:${note.to}`, label: `Open it in ${providerName(note.to)}`, primary: true, close: true }] : [],
    };
  }
  if (backend.kind === 'local') {
    if (BROWSER_VAULT && backend.where === 'browser') {
      return {
        title: 'Your vault in this browser was deleted',
        text: `${err.message} Secure Box still has it open, so it can save it again: ${NOT_ITS_FILES} (only a backup has those).`,
        actions: [{ id: 'again', label: 'Save it again', primary: true }],
      };
    }
    const there = await backend.placeIsThere();
    return {
      title: 'Your vault on this device was deleted',
      text: `${err.message} If that was a mistake, restore it from the Recycle Bin (the Trash on a Mac), then choose Try again: everything comes back, files too. Or save what’s open again ${there ? `in “${backend.name}”` : BROWSER_VAULT && localSupport().browser ? 'in this browser, as its folder is gone too' : 'in a folder you choose, as its folder is gone too'}: ${NOT_ITS_FILES}.`,
      actions: [
        { id: 'again', label: 'Save it again' },
        { id: 'retry', label: 'Try again', primary: true },
      ],
    };
  }
  if (state.provider === 'microsoft') {
    return {
      title: 'Your vault was deleted from OneDrive',
      text: `Its files were deleted from your OneDrive while Secure Box had it open. If that was a mistake, restore them from the OneDrive recycle bin, then choose Try again: everything comes back, files too. Or save what’s open again: ${NOT_ITS_FILES}.`,
      actions: [
        { id: 'again', label: 'Save it again' },
        { id: 'retry', label: 'Try again', primary: true },
      ],
    };
  }
  if (err.code === 'trashed') {
    return {
      title: 'Your vault was put in the bin',
      text: 'Its folder was moved to the bin in your Google Drive while Secure Box had it open, and nothing can be saved to it there. Take it out of the bin to carry on: everything in it comes back as it was.',
      actions: [{ id: 'restore', label: 'Restore it', primary: true }],
    };
  }
  return {
    title: 'Your vault was deleted from Google Drive',
    text: `Its files were deleted from your Google Drive for good while Secure Box had it open. Secure Box still has it open, so it can save it again: ${NOT_ITS_FILES}.`,
    actions: [{ id: 'again', label: 'Save it again', primary: true }],
  };
}

/** Asks how to get the open vault back. Resolves true once it's back, so saving can go on. */
export async function recoverVault(err) {
  const choice = await ask('vaultGone', await describe(err));
  if (choice === 'back') return true;
  if (String(choice).startsWith('open:')) {
    switchVault(choice.slice(5)); // the change that noticed it wasn't saved: it says so, then the vault opens there
    return false;
  }
  if (choice === 'lock') lock('gone');
  return false; // "Not now": the next save asks again
}

/** A button of the dialog: resolves once the vault is back, or throws what's still wrong. */
export async function recoverWith(action) {
  const backend = state.backend;
  if (action === 'retry') {
    try {
      await backend.findAgain();
    } catch (err) {
      if (isGone(err)) throw new Error('It still isn’t there: restore it first, then try again.');
      throw err;
    }
    await pullLatest();
    return back('Your vault is back.');
  }
  if (action === 'restore') {
    await backend.restoreFromBin();
    await pullLatest();
    return back('Your vault is out of the bin, as it was.');
  }
  // Save it again, from what's open.
  const kid = state.master.kid;
  const placeGone = backend.kind === 'local' && !(await backend.placeIsThere());
  // Its folder is gone too: a folder chosen now (first, while the click that asked still counts),
  // or, where that experiment is on, this browser's own storage.
  let handle = null;
  if (placeGone && !(BROWSER_VAULT && localSupport().browser)) {
    handle = await pickVaultFolder();
    if (!handle) throw new Error('Choose a folder to save your vault in.');
    if (await vaultIn(handle)) throw new Error(`“${handle.name}” holds a vault already. Choose another folder.`);
  }
  const keyringText = serializeKeyring(state.keyringDoc);
  const vaultText = await state.cipher.seal(state.vault);
  if (placeGone) {
    const where = handle ? 'folder' : 'browser';
    await forgetFolder(kid, { demo: DEMO }); // the missing folder: a new one is remembered in its place
    const target = deviceBackend({ where, handle, kid: handle ? null : kid });
    state.rev = await target.create({ keyringText, vaultText, kid });
    state.backend = target;
    memory.rememberDeviceChoice({ kid, where });
    refreshDeviceStatus();
  } else {
    state.rev = await backend.recreate({ keyringText, vaultText, kid });
  }
  return back(state.vault.files.length ? 'Your vault is saved again. Files deleted with it won’t open: restore them from a backup, or delete them here.' : 'Your vault is saved again.');
}

function back(message) {
  state.lastSync = Date.now();
  setSyncStatus('saved');
  files.vaultChanged();
  publish();
  toast(message);
}
