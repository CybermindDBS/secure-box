/**
 * Storage backend: everything lives in the signed-in person's own Google Drive.
 *
 *   My Drive / Secure Box /
 *     Secure Box Key Ring.json     master key, encrypted with the master password + Emergency Kit
 *     Secure Box Vault.json        passwords, notes and the file index, encrypted
 *     Encrypted files /            one encrypted copy per file, named by a random id
 *
 * Items are found by app-private properties (google.js, TAG), so renaming or moving them in
 * Drive is harmless.
 */
import { Drive, GoogleError, TAG } from './google.js';
import { KEYRING_FILE_NAME } from './keyring.js';
import { MicrosoftError, OneDrive } from './microsoft.js';
import { FILES_FOLDER, VAULT_FILE_NAME, isBlobName, movedNote } from './vault.js';

export { VAULT_FILE_NAME };

/** Runs `run` while holding the browser-wide lock `name`: this site's windows take turns. */
const withLock = (name, run) => (globalThis.navigator?.locks ? navigator.locks.request(name, run) : run());

/**
 * Where each encrypted copy is. The clouds address files by ids of their own, which the vault
 * never records: it names each copy, so a vault is the same in every place. Each name is looked
 * up here once and remembered for the session: all of them in one listing when the vault loads
 * (a request per 1,000 copies on Google Drive, per 200 on OneDrive), and a copy stored since
 * (by another device) on its own.
 *   listAll()      -> Map name -> { id, size }
 *   findOne(name)  -> { id, size }, or null if there's none
 *   missing()      -> the error for a copy that isn't there
 */
export function createCopies({ listAll, findOne, missing }) {
  let known = new Map();
  let listing = null;

  const checked = (name) => {
    if (!isBlobName(name)) throw new Error('Not an encrypted copy of this vault.');
    return name;
  };

  /** A copy's id, or null if there's none. */
  async function find(name) {
    checked(name);
    if (!known.has(name) && listing) await listing.catch(() => {});
    if (!known.has(name)) {
      const found = await findOne(name);
      if (found) known.set(name, found);
    }
    return known.get(name)?.id || null;
  }

  /** Forgets what was found (the vault was loaded again) and lists the copies anew, meanwhile. */
  function reload() {
    known = new Map();
    const run = listAll().then((found) => {
      if (listing === run) for (const [name, at] of found) if (!known.has(name)) known.set(name, at);
      return found;
    });
    listing = run;
    run.catch(() => {}); // then each copy is looked up on its own
  }

  return {
    checked,
    find,
    /** A copy's id; one that isn't there is the place's "missing" error. */
    async locate(name) {
      const id = await find(name);
      if (!id) throw missing();
      return id;
    },
    /** Forgets every copy found so far (the vault was deleted, or is made anew). */
    reset() {
      known = new Map();
      listing = null;
    },
    reload,
    /**
     * Of `names`, the ones with no copy here (deleted outside Secure Box, say): checked against
     * the listing made when the vault loaded (listed again if that failed), and each one not in
     * it looked up on its own, as it may have been stored since. `fresh`: each one is looked up
     * anew, as it may have been deleted, or put back, since.
     */
    async absent(names, { fresh = false } = {}) {
      if (fresh) for (const name of names) known.delete(name);
      else if (!listing || !(await listing.then(() => true, () => false))) {
        reload();
        await listing;
      }
      // Each one not in the listing is looked up on its own, a few at a time.
      const gone = new Array(names.length).fill(false);
      let next = 0;
      const worker = async () => {
        while (next < names.length) {
          const i = next++;
          if (!(await find(names[i]))) gone[i] = true;
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, names.length) }, worker));
      return names.filter((_, i) => gone[i]);
    },
    /** Every copy stored here, listed afresh: name -> { size }. */
    async list() {
      const found = await listAll();
      for (const [name, at] of found) known.set(name, at);
      return new Map([...found].map(([name, { size }]) => [name, { size }]));
    },
    /** The upload's `send`, remembering where the new copy went once it's complete. */
    track(name, send) {
      const tracked = async (piece, offset, total) => {
        const id = await send(piece, offset, total);
        if (id) known.set(name, { id, size: total });
        return id;
      };
      return Object.assign(tracked, { pieceSize: send.pieceSize, abort: send.abort });
    },
    forget(name) {
      known.delete(name);
    },
  };
}

/**
 * OneDrive: everything lives in Secure Box's own folder, which OneDrive shows as
 * "Apps/Secure Box" (Secure Box can't see anything else):
 *   Secure Box Key Ring.json, Secure Box Vault.json, Encrypted files/<random id>
 * The vault is only ever replaced if it's still the version this device last read (If-Match).
 */
export function createOneDriveBackend(auth) {
  const od = new OneDrive(() => auth.accessToken);
  const ids = { files: null, keyring: null, vault: null, note: false }; // note: the vault moved away from here (vault.js, movedNote)
  const copies = createCopies({
    listAll: async () => (ids.files ? new Map((await od.listFolder(ids.files)).map((f) => [f.name, { id: f.id, size: f.size }])) : new Map()),
    findOne: (name) => od.fileAt(`${FILES_FOLDER}/${name}`),
    missing: () => new MicrosoftError('not-found', 'This file’s encrypted copy is missing from your OneDrive.', 404),
  });
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
      const id = await copies.find(entry.blob).catch(() => null);
      const links = id ? await od.streamSources(id, { fresh }).catch(() => []) : [];
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
      if (vault) copies.reload();
      const [keyringText, vaultText] = await Promise.all([keyring && od.readText(keyring.id), vault && od.readText(vault.id)]);
      ids.note = Boolean(vaultText && movedNote(vaultText));
      return { keyring: keyringText || null, vault: vault ? { text: vaultText, rev: vault.eTag } : null };
    },

    async create({ keyringText, vaultText, kid }) {
      if (ids.note && ids.vault) {
        // A note that a vault moved away from here: a new vault takes its place.
        await od.remove(ids.vault);
        Object.assign(ids, { vault: null, note: false });
      }
      ids.keyring = (await od.createText(KEYRING_FILE_NAME, keyringText)).id;
      return this.createVault(vaultText, kid);
    },

    async createVault(vaultText) {
      const item = await od.createText(VAULT_FILE_NAME, vaultText);
      ids.vault = item.id;
      return item.eTag;
    },

    saveKeyring: (text) => od.updateText(ids.keyring, text),
    /** Saves the key ring, making its file if this place has none yet (a vault found without one). */
    async putKeyring(text) {
      if (ids.keyring) return od.updateText(ids.keyring, text);
      ids.keyring = (await od.createText(KEYRING_FILE_NAME, text)).id;
    },
    freeSpace: () => od.freeSpace(),
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
      copies.reset();
      return this.create({ keyringText, vaultText, kid });
    },

    /** The encrypted copies stored here: name -> { size }. */
    listBlobs: () => copies.list(),
    absent: (names, options) => copies.absent(names, options),

    /** Deletes the whole vault (its key ring, vault and encrypted files) to OneDrive's recycle bin. */
    async removeAll() {
      for (const item of await od.listRoot()) {
        if ([KEYRING_FILE_NAME, VAULT_FILE_NAME, FILES_FOLDER].includes(item.name)) await od.remove(item.id);
      }
      Object.assign(ids, { files: null, keyring: null, vault: null, note: false });
      copies.reset();
    },

    /**
     * After the vault moved away (migrate.js): it becomes `noteText`, a note of where it went, and
     * its key ring and encrypted files go to OneDrive's recycle bin.
     */
    async retire(noteText) {
      await od.updateText(ids.vault, noteText);
      if (ids.keyring) await od.remove(ids.keyring);
      if (ids.files) await od.remove(ids.files);
      Object.assign(ids, { files: null, keyring: null, note: true });
      copies.reset();
    },

    /** Stores a new encrypted copy under `name`: returns send(piece, offset, total) for the piece writer. */
    async openUpload({ name, signal }) {
      copies.checked(name);
      if (!ids.files) {
        try {
          ids.files = await od.folder(FILES_FOLDER);
        } catch (err) {
          // Some OneDrives refuse to make a folder outright: uploading into it by name makes it.
          if (err.code !== 'drive') throw err;
          return copies.track(name, await od.startUpload({ folderName: FILES_FOLDER, name, signal }));
        }
      }
      return copies.track(name, await od.startUpload({ parentId: ids.files, name, signal }));
    },

    /** Deletes an encrypted copy to the recycle bin (one that's gone already counts as deleted). */
    async trash(name) {
      const id = await copies.find(name);
      if (!id) return;
      await od.remove(id);
      copies.forget(name);
    },
    readRange: async (name, start, end) => (await od.readRange(await copies.locate(name), start, end)).body,
    readBytes: async (name, start, end) => (await od.readRange(await copies.locate(name), start, end)).arrayBuffer(),
  };
}

export function createCloudBackend(auth) {
  const drive = new Drive(() => auth.accessToken);
  const ids = { root: null, files: null, keyring: null, vault: null, note: false }; // note: the vault moved away from here
  const copies = createCopies({
    listAll: () => drive.findCopies(),
    findOne: (name) => drive.findCopy(name),
    missing: () => new GoogleError('not-found', 'This file’s encrypted copy is missing from your Google Drive.', 404),
  });

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
    // The streaming worker fetches the file from Drive itself, by Drive's id for it.
    describe: async (entry) => ({ source: 'drive', token: auth.accessToken, id: await copies.locate(entry.blob) }),

    async load() {
      const items = await drive.findParts();
      const of = (kind) => items.filter((f) => f.kind === kind);
      ids.root = of('root')[0]?.id || null;
      ids.files = (of('files').find((f) => f.parents?.includes(ids.root)) || of('files')[0])?.id || null;
      const keyring = of('keyring')[0] || null;
      const vault = (keyring && of('vault').find((v) => v.kid === keyring.kid)) || of('vault')[0] || null;
      if (!keyring && !vault) {
        // Nothing here: the Secure Box folder (or its files) may have been put in the bin by hand.
        const binned = await drive.findParts({ trashed: true });
        if (binned.some((f) => f.kind === 'keyring' || f.kind === 'vault')) return { keyring: null, vault: null, inBin: true };
        // Or it's a vault an earlier version of Secure Box made, tagged differently: say so, rather
        // than "deleted". `otherVersion`: 'here', or 'bin' once it was put in the bin to start over.
        if (await drive.hasEarlier()) return { keyring: null, vault: null, otherVersion: 'here' };
        if (await drive.hasEarlier({ trashed: true })) return { keyring: null, vault: null, otherVersion: 'bin' };
      }
      ids.keyring = keyring?.id || null;
      ids.vault = vault?.id || null;
      if (vault) copies.reload();
      const [keyringText, vaultText] = await Promise.all([keyring && drive.readText(keyring.id), vault && drive.readText(vault.id)]);
      ids.note = Boolean(vaultText && movedNote(vaultText));
      return { keyring: keyringText || null, vault: vault ? { text: vaultText, rev: vault.headRevisionId } : null };
    },

    async create({ keyringText, vaultText, kid }) {
      if (ids.note && ids.vault) {
        // A note that a vault moved away from here: a new vault takes its place (the note goes to the bin).
        await drive.trash(ids.vault);
        Object.assign(ids, { vault: null, note: false });
      }
      const parentId = await rootFolder();
      ids.keyring = (
        await drive.createText({
          name: KEYRING_FILE_NAME,
          parentId,
          text: keyringText,
          appProperties: { [TAG]: 'keyring', kid },
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
        appProperties: { [TAG]: 'vault', kid },
        description: 'Secure Box vault: your passwords, notes and file index, encrypted. Do not delete.',
      });
      ids.vault = file.id;
      return file.headRevisionId;
    },

    saveKeyring: (text) => drive.updateText(ids.keyring, text),
    /** Saves the key ring, making its file if this place has none yet (a vault found without one). */
    async putKeyring(text, kid) {
      if (ids.keyring) return drive.updateText(ids.keyring, text);
      ids.keyring = (
        await drive.createText({
          name: KEYRING_FILE_NAME,
          parentId: await rootFolder(),
          text,
          appProperties: { [TAG]: 'keyring', kid },
          description: 'Secure Box key ring: your master key, encrypted with your master password. Do not delete.',
        })
      ).id;
    },
    freeSpace: () => drive.freeSpace(),
    vaultRevision: head,

    /**
     * Replaces the vault, but only over the version this window last read (`rev`). Drive can't
     * refuse a write that comes second, so: this browser's windows take turns (a lock), the
     * revision is checked right before writing, and afterwards Drive's history must show this
     * save straight after `rev`. If another device saved in between, this save replaced it:
     * GoogleError 'overwrote' names that save (`overwrote`) and this one (`rev`), and commit()
     * puts its change on top of the other device's and saves again.
     */
    writeVault(text, rev) {
      return withLock(`secure-box-save:${ids.vault}`, async () => {
        if (rev && (await head()) !== rev) throw new GoogleError('conflict', 'The vault changed on another device.');
        const written = await drive.updateText(ids.vault, text).catch((err) => {
          throw err?.status === 404 ? new GoogleError('gone', 'Your vault was deleted from Google Drive.', 404) : err;
        });
        const before = rev ? await drive.revisionBefore(ids.vault, written).catch(() => null) : null;
        if (before && before !== rev) throw Object.assign(new GoogleError('overwrote', 'Another device saved the vault at the same moment.'), { overwrote: before, rev: written });
        return written;
      });
    },
    /** What the vault held at an earlier revision (another device's save that this one replaced). */
    readRevision: (revisionId) => drive.readRevision(ids.vault, revisionId),

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
      const binned = await drive.findParts({ trashed: true });
      for (const item of [...binned.filter((f) => f.kind === 'root'), ...binned.filter((f) => f.kind !== 'root')]) await drive.untrash(item.id);
    },

    /**
     * Renames the vault's folder (after load()). For a vault Secure Box moved over from its
     * previous connection: Google Drive would otherwise show two folders called “Secure Box”.
     */
    async renameFolder(name) {
      if (ids.root) await drive.rename(ids.root, name);
    },

    /** Looks for the vault again (it may have been taken out of the bin). */
    async findAgain() {
      const { vault } = await this.load();
      if (!vault) throw new GoogleError('gone', 'Secure Box still can’t find your vault in your Google Drive.');
    },

    /** Saves an open vault again after it was deleted for good: a new Secure Box folder, key ring and vault. */
    async recreate({ keyringText, vaultText, kid }) {
      Object.assign(ids, { root: null, files: null, keyring: null, vault: null });
      copies.reset();
      return this.create({ keyringText, vaultText, kid });
    },

    /** The encrypted copies stored here: name -> { size }. */
    listBlobs: () => copies.list(),
    absent: (names, options) => copies.absent(names, options),

    /**
     * Deletes this vault to the bin: its Secure Box folder with everything in it, its own key
     * ring, vault and files folder if they were moved out of it, and the encrypted copies it names
     * (`names`) if they were. Nothing of another vault in the same Drive is touched.
     */
    async removeAll(names = []) {
      const parts = await drive.findParts();
      const own = new Set([ids.files, ids.keyring, ids.vault].filter(Boolean));
      if (ids.root) await drive.trash(ids.root);
      for (const part of parts) {
        if (own.has(part.id) && !(ids.root && part.parents?.includes(ids.root))) await drive.trash(part.id);
      }
      // What's left of its copies (not in the bin with its folder): those moved out of it.
      const named = new Set(names);
      for (const [name, { id }] of await drive.findCopies()) if (named.has(name)) await drive.trash(id);
      Object.assign(ids, { root: null, files: null, keyring: null, vault: null, note: false });
      copies.reset();
    },

    /**
     * After the vault moved away (migrate.js): it becomes `noteText`, a note of where it went, and
     * its key ring and encrypted files (`names`, wherever they are) go to the Google Drive bin.
     */
    async retire(noteText, names = []) {
      await drive.updateText(ids.vault, noteText);
      if (ids.keyring) await drive.trash(ids.keyring);
      if (ids.files) await drive.trash(ids.files); // with the copies in it
      const named = new Set(names);
      for (const [name, { id }] of await drive.findCopies()) if (named.has(name)) await drive.trash(id); // ones moved out of it
      Object.assign(ids, { files: null, keyring: null, note: true });
      copies.reset();
    },

    /** Stores a new encrypted copy under `name`: returns send(piece, offset, total) for the piece writer. */
    async openUpload({ name, size, signal }) {
      copies.checked(name);
      ids.files ??= await drive.createFolder(FILES_FOLDER, await rootFolder(), 'files');
      return copies.track(name, await drive.startUpload({ name, parentId: ids.files, size, appProperties: { [TAG]: 'blob', blob: name }, signal }));
    },

    /** Moves an encrypted copy to the bin (one that's gone already counts as deleted). */
    async trash(name) {
      const id = await copies.find(name);
      if (!id) return;
      await drive.trash(id);
      copies.forget(name);
    },
    readRange: async (name, start, end) => drive.readRange(await copies.locate(name), start, end),
    readBytes: async (name, start, end) => new Response(await drive.readRange(await copies.locate(name), start, end)).arrayBuffer(),
  };
}
