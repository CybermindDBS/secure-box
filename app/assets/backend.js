/**
 * Storage backend: everything lives in the signed-in person's own Google Drive.
 *
 *   My Drive / Secure Box /
 *     Secure Box Key Ring.json     master key, encrypted with the master password + Emergency Kit
 *     Secure Box Vault.json        passwords, notes and the file index, encrypted
 *     Encrypted files /        one opaque blob per file, named by a random id
 *
 * Items are found by app-private properties, so renaming or moving them in Drive is harmless.
 */
import { Drive } from './google.js';
import { KEYRING_FILE_NAME } from './keyring.js';
import { OneDrive } from './microsoft.js';

export const VAULT_FILE_NAME = 'Secure Box Vault.json';
const FILES_FOLDER = 'Encrypted files';

/**
 * OneDrive: everything lives in Secure Box's own folder, which OneDrive shows as
 * "Apps/Secure Box" (Secure Box can't see anything else):
 *   Secure Box Key Ring.json, Secure Box Vault.json, Encrypted files/<random id>
 * The vault is only ever replaced if it's still the version this device last read (If-Match).
 */
export function createOneDriveBackend(auth) {
  const od = new OneDrive(() => auth.accessToken);
  const ids = { files: null, keyring: null, vault: null };
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
    vaultRevision: () => od.revision(ids.vault),
    writeVault: (text, rev) => od.updateText(ids.vault, text, rev),

    async readVault() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await od.revision(ids.vault);
        const text = await od.readText(ids.vault);
        if ((await od.revision(ids.vault)) === before) return { text, rev: before };
      }
      throw new Error('The vault keeps changing on another device. Try again in a moment.');
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
    vaultRevision: () => drive.revision(ids.vault),
    writeVault: (text) => drive.updateText(ids.vault, text),

    async readVault() {
      // Revision before and after the read must agree, or another device wrote in between.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await drive.revision(ids.vault);
        const text = await drive.readText(ids.vault);
        if ((await drive.revision(ids.vault)) === before) return { text, rev: before };
      }
      throw new Error('The vault keeps changing on another device. Try again in a moment.');
    },

    async openUpload({ fid, size, signal }) {
      ids.files ??= await drive.createFolder('Encrypted files', await rootFolder(), 'files');
      return drive.startUpload({ name: fid, parentId: ids.files, size, appProperties: { unibox: 'file' }, signal });
    },

    trash: (driveId) => drive.trash(driveId),
    readRange: (driveId, start, end) => drive.readRange(driveId, start, end),
  };
}
