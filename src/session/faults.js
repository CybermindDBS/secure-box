/**
 * Demo only: ?demo&faults=quota,expire,trash,save makes the demo's storage fail on purpose, to
 * rehearse what Secure Box does when things go wrong (#20):
 *   quota   uploads fail as if the storage were full: the queue stops once, with one message
 *   expire  uploads fail as if the sign-in ran out: they pause, ready for Reconnect & resume
 *   trash   deleting encrypted copies fails: they're remembered and tried again on a later sync
 *   save    the first vault save fails: the change isn't saved, and says so
 * and the vault deleted outside Secure Box (gone.js):
 *   bin     opening finds the vault's folder in the Google Drive bin, ready to take out
 *   deleted opening finds no vault, not even in the bin, where this browser saw one before
 *   trashed once open, the vault is put in the bin: the next save or sync asks what to do
 *   gone    once open, the vault is deleted for good: likewise
 */
import { GoogleError } from '../core/google.js';

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
