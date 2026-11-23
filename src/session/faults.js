/**
 * Demo only: ?demo&faults=quota,expire,trash,save makes the demo's storage fail on purpose, to
 * rehearse what Secure Box does when things go wrong (#20):
 *   quota   uploads fail as if the storage were full: the queue stops once, with one message
 *   expire  uploads fail as if the sign-in ran out: they pause, ready for Reconnect & resume
 *   trash   deleting encrypted copies fails: they're remembered and tried again on a later sync
 *   save    the first vault save fails: the change isn't saved, and says so
 *   slow    a slow connection: each piece of an upload takes 1.5 s, and each read (a thumbnail,
 *           say) a third of a second, to rehearse adding files while others upload, or scrolling
 *   race    the first vault save crosses with another device's, which it replaces (Google Drive
 *           can't refuse it): Secure Box takes that save back and puts its change on top
 *   moved   once open, the vault is moved to another place from another device: the next save
 *           or sync finds the note it left, and says where it went
 *   away    opening finds only that note: the vault moved away (to a device) before
 *   older   opening finds only a vault an earlier version of Secure Box made (Google Drive)
 *   lost    one file's encrypted copy was deleted outside Secure Box: it's marked missing, and
 *           opening it says what to do
 *   newapp  Secure Box now connects as a new app, which sees nothing: the vault is with its
 *           previous connection, and Bring it over copies it across (vaults.js, bringover.js)
 *   oldgone likewise, but the previous connection is gone too: the cloud's download is the way back
 * and the vault deleted outside Secure Box (gone.js):
 *   bin     opening finds the vault's folder in the Google Drive bin, ready to take out
 *   deleted opening finds no vault, not even in the bin, where this browser saw one before
 *   trashed once open, the vault is put in the bin: the next save or sync asks what to do
 *   gone    once open, the vault is deleted for good: likewise
 */
import { GoogleError } from '../core/google.js';
import { movedNoteText } from '../core/vault.js';
import { pause } from './store.js';

export function injectFaults(backend, list) {
  const faults = new Set(String(list || '').split(',').map((f) => f.trim()).filter(Boolean));
  if (!faults.size) return;
  console.warn('Secure Box demo: injecting failures:', [...faults].join(', '));
  if (faults.has('quota')) backend.openUpload = async () => Promise.reject(new GoogleError('quota', 'Your Google Drive is full.', 403));
  if (faults.has('expire')) backend.openUpload = async () => Promise.reject(new GoogleError('expired', 'Your Google access expired. Reconnect to continue.', 401));
  if (faults.has('trash')) backend.trash = async () => Promise.reject(new GoogleError('network', 'Could not reach Google Drive. Check your connection and try again.'));
  if (faults.has('bin')) {
    const load = backend.load.bind(backend);
    let binned = true;
    backend.load = async () => (binned ? { keyring: null, vault: null, inBin: true } : load());
    backend.restoreFromBin = async () => {
      binned = false;
    };
  }
  if (faults.has('deleted')) backend.load = async () => ({ keyring: null, vault: null });
  if (faults.has('lost')) {
    const load = backend.load.bind(backend);
    let lost = false;
    backend.load = async () => {
      const loaded = await load();
      if (!lost) {
        // The first file's encrypted copy, deleted by hand where the vault is.
        const [name] = (await backend.listBlobs()).keys();
        if (name) await backend.trash(name);
        lost = true;
      }
      return loaded;
    };
  }
  if (faults.has('trashed') || faults.has('gone')) {
    const code = faults.has('trashed') ? 'trashed' : 'gone';
    const fail = () => new GoogleError(code, code === 'trashed' ? 'Your vault was moved to the bin in Google Drive.' : 'Your vault was deleted from Google Drive.', code === 'gone' ? 404 : 0);
    let missing = true;
    const guard = (run) => async (...args) => {
      if (missing) throw fail();
      return run(...args);
    };
    backend.vaultRevision = guard(backend.vaultRevision.bind(backend));
    backend.readVault = guard(backend.readVault.bind(backend));
    backend.writeVault = guard(backend.writeVault.bind(backend));
    backend.findAgain = guard(async () => {});
    backend.restoreFromBin = async () => {
      missing = false;
    };
    backend.recreate = async ({ keyringText, vaultText }) => {
      missing = false;
      return backend.create({ keyringText, vaultText });
    };
  }
  if (faults.has('older')) backend.load = async () => ({ keyring: null, vault: null, otherVersion: 'here' });
  if (faults.has('away')) backend.load = async () => ({ keyring: null, vault: { text: movedNoteText('local', new Date()), rev: 'note' } });
  if (faults.has('moved')) {
    const read = backend.readVault.bind(backend);
    let open = 0;
    backend.load = ((load) => async () => {
      open++;
      return load();
    })(backend.load.bind(backend));
    // After unlocking, "another device" moves the vault away: a note takes its place.
    backend.vaultRevision = async () => (open ? 'moved' : '1');
    backend.readVault = async () => (open ? { text: movedNoteText('local', new Date()), rev: 'moved' } : read());
  }
  if (faults.has('race')) {
    const write = backend.writeVault.bind(backend);
    let crossed = false;
    backend.writeVault = async (text, rev) => {
      if (crossed) return write(text, rev);
      crossed = true;
      const theirs = await backend.saveFromAnotherDevice(); // lands just before this save...
      const ours = await write(text, rev); // ...which replaces it, as Google Drive allows
      throw Object.assign(new GoogleError('overwrote', 'Another device saved the vault at the same moment.'), { overwrote: theirs, rev: ours });
    };
  }
  if (faults.has('slow')) {
    const open = backend.openUpload.bind(backend);
    backend.openUpload = async (...args) => {
      const send = await open(...args);
      const slowly = async (...piece) => {
        await pause(1500);
        return send(...piece);
      };
      return Object.assign(slowly, { pieceSize: send.pieceSize, abort: send.abort });
    };
    const readBytes = backend.readBytes.bind(backend);
    backend.readBytes = async (...args) => {
      await pause(330);
      return readBytes(...args);
    };
  }
  if (faults.has('save')) {
    const write = backend.writeVault.bind(backend);
    let failed = false;
    backend.writeVault = async (...args) => {
      if (!failed) {
        failed = true;
        throw new GoogleError('network', 'Could not reach Google Drive. Check your connection and try again.');
      }
      return write(...args);
    };
  }
}
