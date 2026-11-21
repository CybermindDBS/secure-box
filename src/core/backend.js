/**
 * Storage backend: everything lives in the signed-in person's own Google Drive.
 *
 *   My Drive / Secure Box /
 *     Secure Box Key Ring.json     master key, encrypted with the master password + Emergency Kit
 *     Secure Box Vault.json        passwords, notes and the file index, encrypted
 *     Encrypted files /            one opaque blob per file, named by a random id
 *
 * Items are found by app-private properties, so renaming or moving them in Drive is harmless.
 */
import { Drive, GoogleError } from './google.js';
import { KEYRING_FILE_NAME } from './keyring.js';
import { MicrosoftError, OneDrive } from './microsoft.js';
import { FILES_FOLDER, VAULT_FILE_NAME } from './vault.js';

export { VAULT_FILE_NAME };

/**
 * OneDrive: everything lives in Secure Box's own folder, which OneDrive shows as
 * "Apps/Secure Box" (Secure Box can't see anything else):
 *   Secure Box Key Ring.json, Secure Box Vault.json, Encrypted files/<random id>
 * The vault is only ever replaced if it's still the version this device last read (If-Match).
 */
export function createOneDriveBackend(auth) {
  const od = new OneDrive(() => auth.accessToken);
  const ids = { files: null, keyring: null, vault: null };
  // The vault deleted outside Secure Box (to OneDrive's recycle bin, or for good) is "gone".
  const orGone = (promise) =>
    promise.catch((err) => {
      throw err?.code === 'not-found' ? new MicrosoftError('gone', 'Your vault was deleted from OneDrive.', 404) : err;
    });
  return {
    kind: 'cloud',
    provider: 'microsoft',
    get identity() {
      return auth.identity;
    },
    tokenExpiresAt: () => auth.expiresAt,
    // The streaming worker fetches files itself, in one request each (as with Google Drive), from
    // these addresses. Where it can't, it asks this page for the bytes.
    describe: async (entry, { fresh = false } = {}) => {
      const links = await od.streamSources(entry.driveId, { fresh }).catch(() => []);
      return links.length ? { source: 'link', links } : { source: 'page' };
    },

    async load() {
      const items = await od.listRoot();
      const file = (name) => items.find((i) => i.name === name && i.file);
      const keyring = file(KEYRING_FILE_NAME);
      const vault = file(VAULT_FILE_NAME);
      ids.keyring = keyring?.id || null;
      ids.vault = vault?.id || null;
      ids.files = items.find((i) => i.name === FILES_FOLDER && i.folder)?.id || null;
      const [keyringText, vaultText] = await Promise.all([keyring && od.readText(keyring.id), vault && od.readText(vault.id)]);
      return { keyring: keyringText || null, vault: vault ? { text: vaultText, rev: vault.eTag } : null };
    },

    async create({ keyringText, vaultText, kid }) {
      ids.keyring = (await od.createText(KEYRING_FILE_NAME, keyringText)).id;
      return this.createVault(vaultText, kid);
    },

    async createVault(vaultText) {
      const item = await od.createText(VAULT_FILE_NAME, vaultText);
      ids.vault = item.id;
      return item.eTag;
    },

    saveKeyring: (text) => od.updateText(ids.keyring, text),
    vaultRevision: () => orGone(od.revision(ids.vault)),
    writeVault: (text, rev) => orGone(od.updateText(ids.vault, text, rev)),

    async readVault() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await orGone(od.revision(ids.vault));
        const text = await orGone(od.readText(ids.vault));
        if ((await orGone(od.revision(ids.vault))) === before) return { text, rev: before };
      }
      throw new Error('The vault keeps changing on another device. Try again in a moment.');
    },

    /** Looks for the vault again (it may have been restored from the recycle bin). */
    async findAgain() {
      const { vault } = await this.load();
      if (!vault) throw new MicrosoftError('gone', 'Secure Box still can’t find your vault in your OneDrive.');
    },

    /** Saves an open vault again after it was deleted: its key ring and vault, from what's open. */
    async recreate({ keyringText, vaultText, kid }) {
      Object.assign(ids, { files: null, keyring: null, vault: null });
      return this.create({ keyringText, vaultText, kid });
    },

    async openUpload({ fid, signal }) {
      if (!ids.files) {
        try {
          ids.files = await od.folder(FILES_FOLDER);
        } catch (err) {
          // Some OneDrives refuse to make a folder outright: uploading into it by name makes it.
          if (err.code !== 'drive') throw err;
          return od.startUpload({ folderName: FILES_FOLDER, name: fid, signal });
        }
      }
      return od.startUpload({ parentId: ids.files, name: fid, signal });
    },

    trash: (id) => od.remove(id),
    readRange: async (id, start, end) => (await od.readRange(id, start, end)).body,
    readBytes: async (id, start, end) => (await od.readRange(id, start, end)).arrayBuffer(),
  };
}

export function createCloudBackend(auth) {
  const drive = new Drive(() => auth.accessToken);
  const ids = { root: null, files: null, keyring: null, vault: null };

  async function rootFolder() {
    ids.root ??= await drive.createFolder('Secure Box', null, 'root');
    return ids.root;
  }

  /**
   * The vault's revision. A vault put in the bin can still be read and written, so saving would
   * quietly go on into the bin: it's a GoogleError 'trashed' instead (and 'gone' once deleted for good).
   */
  async function head() {
    const { headRevisionId, trashed } = await drive.revisionState(ids.vault);
    if (trashed) throw new GoogleError('trashed', 'Your vault was moved to the bin in Google Drive.');
    return headRevisionId;
  }

  return {
    kind: 'cloud',
    provider: 'google',
    get identity() {
      return auth.identity;
    },
    tokenExpiresAt: () => auth.expiresAt,
    describe: () => ({ source: 'drive', token: auth.accessToken }),

    async load() {
      const items = await drive.findUnibox();
      const of = (kind) => items.filter((f) => f.kind === kind);
      ids.root = of('root')[0]?.id || null;
      ids.files = (of('files').find((f) => f.parents?.includes(ids.root)) || of('files')[0])?.id || null;
      const keyring = of('keyring')[0] || null;
      const vault = (keyring && of('vault').find((v) => v.kid === keyring.kid)) || of('vault')[0] || null;
      if (!keyring && !vault) {
        // Nothing here: the Secure Box folder (or its files) may have been put in the bin by hand.
        const binned = await drive.findUnibox({ trashed: true });
        if (binned.some((f) => f.kind === 'keyring' || f.kind === 'vault')) return { keyring: null, vault: null, inBin: true };
      }
      ids.keyring = keyring?.id || null;
      ids.vault = vault?.id || null;
      const [keyringText, vaultText] = await Promise.all([keyring && drive.readText(keyring.id), vault && drive.readText(vault.id)]);
      return { keyring: keyringText || null, vault: vault ? { text: vaultText, rev: vault.headRevisionId } : null };
    },

    async create({ keyringText, vaultText, kid }) {
      const parentId = await rootFolder();
      ids.keyring = (
        await drive.createText({
          name: KEYRING_FILE_NAME,
          parentId,
          text: keyringText,
          appProperties: { unibox: 'keyring', kid },
          description: 'Secure Box key ring: your master key, encrypted with your master password. Do not delete.',
        })
      ).id;
      return this.createVault(vaultText, kid);
    },

    async createVault(vaultText, kid) {
      const file = await drive.createText({
        name: VAULT_FILE_NAME,
        parentId: await rootFolder(),
        text: vaultText,
        appProperties: { unibox: 'vault', kid },
        description: 'Secure Box vault: your passwords, notes and file index, encrypted. Do not delete.',
      });
      ids.vault = file.id;
      return file.headRevisionId;
    },

    saveKeyring: (text) => drive.updateText(ids.keyring, text),
    vaultRevision: head,
    writeVault: (text) =>
      drive.updateText(ids.vault, text).catch((err) => {
        throw err?.status === 404 ? new GoogleError('gone', 'Your vault was deleted from Google Drive.', 404) : err;
      }),

    async readVault() {
      // Revision before and after the read must agree, or another device wrote in between.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await head();
        const text = await drive.readText(ids.vault);
        if ((await head()) === before) return { text, rev: before };
      }
      throw new Error('The vault keeps changing on another device. Try again in a moment.');
    },

    /** Takes Secure Box's folder and files out of the bin: the folder first, then anything binned on its own. */
    async restoreFromBin() {
      const binned = await drive.findUnibox({ trashed: true });
      for (const item of [...binned.filter((f) => f.kind === 'root'), ...binned.filter((f) => f.kind !== 'root')]) await drive.untrash(item.id);
    },

    /** Looks for the vault again (it may have been taken out of the bin). */
    async findAgain() {
      const { vault } = await this.load();
      if (!vault) throw new GoogleError('gone', 'Secure Box still can’t find your vault in your Google Drive.');
    },

    /** Saves an open vault again after it was deleted for good: a new Secure Box folder, key ring and vault. */
    async recreate({ keyringText, vaultText, kid }) {
      Object.assign(ids, { root: null, files: null, keyring: null, vault: null });
      return this.create({ keyringText, vaultText, kid });
    },

    async openUpload({ fid, size, signal }) {
      ids.files ??= await drive.createFolder(FILES_FOLDER, await rootFolder(), 'files');
      return drive.startUpload({ name: fid, parentId: ids.files, size, appProperties: { unibox: 'file' }, signal });
    },

    trash: (driveId) => drive.trash(driveId),
    readRange: (driveId, start, end) => drive.readRange(driveId, start, end),
  };
}
