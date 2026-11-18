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

export const VAULT_FILE_NAME = 'Secure Box Vault.json';

export function createCloudBackend(auth) {
  const drive = new Drive(() => auth.accessToken);
  const ids = { root: null, files: null, keyring: null, vault: null, legacy: [] };

  async function rootFolder() {
    ids.root ??= await drive.createFolder('Secure Box', null, 'root');
    return ids.root;
  }

  return {
    kind: 'cloud',
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
      ids.legacy = of('master-key').map((f) => f.id);
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
      const rev = await this.createVault(vaultText, kid);
      // The unprotected key file from the first version of Secure Box is no longer used.
      await Promise.all(ids.legacy.map((id) => drive.trash(id).catch(() => {})));
      ids.legacy = [];
      return rev;
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

    async openUpload({ fid, size }) {
      ids.files ??= await drive.createFolder('Encrypted files', await rootFolder(), 'files');
      return drive.startUpload({ name: fid, parentId: ids.files, size, appProperties: { unibox: 'file' } });
    },

    trash: (driveId) => drive.trash(driveId),
    readRange: (driveId, start, end) => drive.readRange(driveId, start, end),
  };
}
