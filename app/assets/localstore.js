/**
 * The "This device" vault: passwords and files kept on this device only. It works like the cloud
 * vaults (same key ring, same encryption, same app), but nothing in it is ever uploaded.
 *
 * Where it lives
 *   browser  the browser's private storage for Secure Box (the "origin private file system").
 *            Works in every modern browser, phones included, but isn't visible as files and goes
 *            away if someone clears this site's data, so we ask for persistent storage (the
 *            browser then never clears it on its own) and make backups easy.
 *   folder   a folder you choose (Chrome and Edge on computers, Chrome on Android): ordinary
 *            encrypted files you can see, copy or keep in a synced folder. The browser asks once
 *            per visit to allow it.
 *
 * Layout, in either place:   keyring.json   the key ring (your master key, locked)
 *                             index.json     the vault: passwords, folders, files and their keys,
 *                                            encrypted with a key of its own (LOCAL_INDEX)
 *                             files/<id>     one encrypted blob per file (fileformat.js)
 * In the browser, each vault has a folder named after its master key's id. In a chosen folder,
 * the vault sits in a "Secure Box" subfolder; anything else found there was put in by hand and is
 * still unencrypted, so the app offers to encrypt it (strays()).
 */
import { zipEntries, zipEntryData, zipFolder } from './localbox.js';
import { LOCAL_INDEX } from './vault.js';

const VAULT_DIR = 'Secure Box';
const KEYRING = 'keyring.json';
const INDEX = 'index.json';
const FILES = 'files';
const ID_PREFIX = 'local:';
const BACKUP_FORMAT = 'secure-box-local-backup';
const DB_NAME = 'secure-box-local';
const IGNORED = /^(\..*|desktop\.ini|thumbs\.db|.*\.crswap)$/i; // hidden files, OS clutter, a browser's half-written files

export const isLocalId = (driveId) => typeof driveId === 'string' && driveId.startsWith(ID_PREFIX);

export class LocalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalError';
    this.code = code;
  }
}

/** What this browser can do. On iPhone and iPad, only Home Screen apps are safe from Safari's 7-day clean-up. */
export function localSupport() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  return {
    browser: typeof navigator.storage?.getDirectory === 'function' && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype,
    folder: typeof window.showDirectoryPicker === 'function',
    ios,
    standalone,
  };
}

// ---------------------------------------------------------------------------
// Chosen folders are remembered per master key id in IndexedDB (a handle, no secrets)
// ---------------------------------------------------------------------------
function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('folders');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('folders', mode);
      const request = run(tx.objectStore('folders'));
      tx.oncomplete = () => {
        db.close();
        resolve(request?.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

const spaceKey = (kid, demo) => (demo ? `demo:${kid}` : kid);

async function browserBase(demo, create) {
  const opfs = await navigator.storage.getDirectory();
  return opfs.getDirectoryHandle(demo ? 'secure-box-demo' : 'secure-box', { create });
}

async function has(dir, name, kind = 'file') {
  try {
    await (kind === 'file' ? dir.getFileHandle(name) : dir.getDirectoryHandle(name));
    return true;
  } catch {
    return false;
  }
}

/** The vault's own folder inside a chosen folder (or the chosen folder itself, if that's the one). */
async function folderRoot(picked, create) {
  if ((await has(picked, INDEX)) || (await has(picked, KEYRING))) return picked;
  return picked.getDirectoryHandle(VAULT_DIR, { create });
}

/**
 * The local vaults on this device: [{ kid, where, handle?, name, ready }]. `ready` is false for
 * a folder that needs permission again.
 */
export async function findLocalVaults({ demo = false } = {}) {
  const support = localSupport();
  const found = [];
  if (support.folder && !demo) {
    const keys = await idb('readonly', (s) => s.getAllKeys()).catch(() => []);
    for (const kid of keys || []) {
      const handle = await idb('readonly', (s) => s.get(kid)).catch(() => null);
      if (!handle) continue;
      let permission = 'prompt';
      try {
        permission = await handle.queryPermission({ mode: 'readwrite' });
      } catch {
        /* treated as "ask again" */
      }
      found.push({ kid, where: 'folder', handle, name: handle.name, ready: permission === 'granted' });
    }
  }
  if (support.browser) {
    try {
      const base = await browserBase(demo, false);
      for await (const [kid, dir] of base.entries()) {
        if (dir.kind !== 'directory' || !(await has(dir, INDEX)) || !(await has(dir, KEYRING))) continue;
        found.push({ kid, where: 'browser', name: 'This browser', ready: true });
      }
    } catch {
      /* no local vault in this browser */
    }
  }
  return found;
}

/** Asks for access to a remembered folder again; needs a click. */
export async function allowFolder(handle) {
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function forgetFolder(kid, { demo = false } = {}) {
  await idb('readwrite', (s) => s.delete(spaceKey(kid, demo))).catch(() => {});
}

// ---------------------------------------------------------------------------
// The backend (same calls as the cloud ones in backend.js)
// ---------------------------------------------------------------------------
/**
 * `kid` names an existing vault in the browser (or comes with create()); `handle` is a chosen
 * folder. `notify()` runs after each save, so other windows can reload.
 */
export function createLocalBackend({ where = 'browser', handle = null, kid = null, demo = false, notify = () => {} }) {
  let root = null;
  let filesDir = null;
  let stamp = '';
  let currentKid = kid;

  const lockName = () => `secure-box-local:${where}:${spaceKey(currentKid || handle?.name || 'new', demo)}`;
  const withLock = (run) => (navigator.locks ? navigator.locks.request(lockName(), run) : run());

  async function open(create = false) {
    if (root) return root;
    if (where === 'folder') root = await folderRoot(handle, create);
    else {
      if (!currentKid) throw new LocalError('missing', 'There is no vault on this device yet.');
      root = await (await browserBase(demo, create)).getDirectoryHandle(currentKid, { create });
    }
    filesDir = await root.getDirectoryHandle(FILES, { create: true });
    return root;
  }

  async function readFile(name) {
    try {
      return await (await (await open()).getFileHandle(name)).getFile();
    } catch (err) {
      if (err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  async function writeFile(name, text) {
    const handleOf = await (await open(true)).getFileHandle(name, { create: true });
    const writable = await handleOf.createWritable(); // replaces the old file in one step, on close()
    await writable.write(text);
    await writable.close();
    return handleOf.getFile();
  }

  const stampOf = (file) => (file ? `${file.lastModified}:${file.size}` : '');

  async function remember() {
    if (where === 'folder' && currentKid) await idb('readwrite', (s) => s.put(handle, spaceKey(currentKid, demo))).catch(() => {});
  }

  const fid = (driveId) => {
    const id = isLocalId(driveId) ? driveId.slice(ID_PREFIX.length) : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Not a file of this device’s vault.');
    return id;
  };

  async function blobOf(driveId) {
    await open();
    try {
      return await (await filesDir.getFileHandle(fid(driveId))).getFile();
    } catch (err) {
      if (err.name === 'NotFoundError') throw new Error('This file is missing from the vault on this device.');
      throw err;
    }
  }

  const backend = {
    kind: 'local',
    provider: 'local',
    where,
    vaultPurpose: LOCAL_INDEX,
    get kid() {
      return currentKid;
    },
    get name() {
      return where === 'folder' ? handle.name : 'This browser';
    },
    get identity() {
      return { sub: `local:${currentKid || ''}`, email: '' };
    },
    tokenExpiresAt: () => Infinity,
    describe: () => ({ source: 'page' }), // the streaming worker asks this page for the bytes

    async load() {
      if (where === 'browser' && !currentKid) return { keyring: null, vault: null }; // a new vault, not made yet
      try {
        await open(where === 'folder');
      } catch (err) {
        if (err.name === 'NotFoundError' && where === 'browser') return { keyring: null, vault: null };
        throw err;
      }
      const [keyringFile, indexFile] = await Promise.all([readFile(KEYRING), readFile(INDEX)]);
      const keyring = keyringFile ? await keyringFile.text() : null;
      if (keyring && !currentKid) {
        try {
          currentKid = JSON.parse(keyring).kid;
        } catch {
          /* the app reports a damaged key ring */
        }
      }
      await remember();
      stamp = stampOf(indexFile);
      return { keyring, vault: indexFile ? { text: await indexFile.text(), rev: stamp } : null };
    },

    async create({ keyringText, vaultText, kid: newKid }) {
      currentKid ||= newKid;
      await open(true);
      await writeFile(KEYRING, keyringText);
      const rev = await this.createVault(vaultText);
      await remember();
      return rev;
    },

    async createVault(vaultText) {
      return withLock(async () => {
        stamp = stampOf(await writeFile(INDEX, vaultText));
        notify();
        return stamp;
      });
    },

    async saveKeyring(text) {
      await writeFile(KEYRING, text);
    },

    vaultRevision: async () => stampOf(await readFile(INDEX)),

    /** Replaces the vault, but only if it's still the version this window last read. */
    writeVault(text, rev) {
      return withLock(async () => {
        const now = stampOf(await readFile(INDEX));
        if (rev && now !== rev) throw new LocalError('conflict', 'The vault changed in another window.');
        stamp = stampOf(await writeFile(INDEX, text));
        notify();
        return stamp;
      });
    },

    async readVault() {
      const file = await readFile(INDEX);
      if (!file) throw new LocalError('missing', 'The vault on this device is missing.');
      return { text: await file.text(), rev: stampOf(file) };
    },

    async openUpload({ fid: id }) {
      await open(true);
      const fileHandle = await filesDir.getFileHandle(id, { create: true });
      const writable = await fileHandle.createWritable();
      const send = async (piece, offset, total) => {
        await writable.write(piece);
        if (offset + piece.length < total) return null;
        await writable.close();
        return `${ID_PREFIX}${id}`;
      };
      send.abort = async () => {
        await writable.abort().catch(() => {});
        await filesDir.removeEntry(id).catch(() => {});
      };
      return send;
    },

    async trash(driveId) {
      await open();
      await filesDir.removeEntry(fid(driveId)).catch((err) => {
        if (err.name !== 'NotFoundError') throw err;
      });
    },

    readRange: async (driveId, start, end) => (await blobOf(driveId)).slice(start, end + 1).stream(),
    readBytes: async (driveId, start, end) => (await blobOf(driveId)).slice(start, end + 1).arrayBuffer(),

    // ---- Keeping it safe --------------------------------------------------
    /** 'files' (a real folder), 'protected' (the browser won't clear it by itself) or 'unprotected'. */
    async protection() {
      if (where === 'folder') return 'files';
      return (await navigator.storage?.persisted?.()) ? 'protected' : 'unprotected';
    },
    /** Asks the browser for persistent storage. Firefox asks the person; others decide by themselves. */
    async protect() {
      return Boolean(await navigator.storage?.persist?.());
    },

    /** Unencrypted files someone put into a folder vault by hand. */
    async strays() {
      if (where !== 'folder') return [];
      const top = await open();
      const found = [];
      const walk = async (dir, path) => {
        for await (const [name, entry] of dir.entries()) {
          if (IGNORED.test(name) || (dir === top && [KEYRING, INDEX, FILES].includes(name))) continue;
          if (entry.kind === 'file') found.push({ name, path, parent: dir, file: await entry.getFile() });
          else await walk(entry, [...path, name]);
        }
      };
      await walk(top, []);
      return found;
    },
    async removeStray(stray) {
      await stray.parent.removeEntry(stray.name);
    },
    async pruneEmptyFolders() {
      const top = await open();
      const prune = async (dir) => {
        let empty = true;
        for await (const [name, entry] of dir.entries()) {
          if (entry.kind === 'directory' && !(dir === top && name === FILES) && (await prune(entry))) await dir.removeEntry(name).catch(() => {});
          else empty = false;
        }
        return empty;
      };
      await prune(top);
    },

    // ---- Backups ----------------------------------------------------------
    /**
     * One ZIP of the vault exactly as stored: key ring, vault and file blobs, nothing decrypted.
     * It opens only with your master password or Emergency Kit, so it can be kept anywhere.
     */
    async backup(fileEntries, { onProgress, signal } = {}) {
      const [keyringFile, indexFile] = await Promise.all([readFile(KEYRING), readFile(INDEX)]);
      if (!keyringFile || !indexFile) throw new LocalError('missing', 'The vault on this device is incomplete.');
      const now = Date.now();
      const manifest = { format: BACKUP_FORMAT, version: 2, kid: currentKid, created: new Date(now).toISOString(), files: fileEntries.length };
      const text = (name, value) => ({ path: name, file: new File([value], name, { lastModified: now }) });
      const items = [
        text('backup.json', JSON.stringify(manifest, null, 2)),
        text(KEYRING, await keyringFile.text()),
        text(INDEX, await indexFile.text()),
        { path: `${FILES}/`, dir: true, mtime: now },
      ];
      for (const entry of fileEntries) {
        try {
          items.push({ path: `${FILES}/${fid(entry.driveId)}`, file: await blobOf(entry.driveId) });
        } catch {
          /* a missing blob can't be backed up */
        }
      }
      const blob = await zipFolder(items, { onProgress, signal });
      return { blob, name: `Secure Box backup (this device) ${new Date(now).toISOString().slice(0, 10)}.zip` };
    },

    /** Copies one file's encrypted blob out of a backup (see readBackup) into this vault. */
    async restoreBlob(backup, driveId, onBytes) {
      await open(true);
      const id = fid(driveId);
      const entry = backup.blob(id);
      if (!entry) return false;
      const writable = await (await filesDir.getFileHandle(id, { create: true })).createWritable();
      try {
        for await (const bytes of zipEntryData(backup.content, entry)) {
          await writable.write(bytes);
          onBytes?.(bytes.length);
        }
        await writable.close();
        return true;
      } catch (err) {
        await writable.abort().catch(() => {});
        await filesDir.removeEntry(id).catch(() => {});
        throw err;
      }
    },
  };
  return backend;
}

/** Reads a backup ZIP: { manifest, keyring, index, blob(id) -> zip entry, content, size(id) }. */
export async function readBackup(file) {
  const content = { size: file.size, read: async (from, to) => new Uint8Array(await file.slice(from, to + 1).arrayBuffer()) };
  const notBackup = () => new LocalError('not-backup', 'That isn’t a Secure Box backup, or it’s damaged.');
  let entries;
  try {
    entries = await zipEntries(content);
  } catch {
    throw notBackup();
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const readText = async (path) => {
    const entry = byPath.get(path);
    if (!entry || entry.size > 64 * 1024 * 1024) throw notBackup();
    const parts = [];
    for await (const bytes of zipEntryData(content, entry)) parts.push(bytes);
    return new Blob(parts).text();
  };
  let manifest;
  try {
    manifest = JSON.parse(await readText('backup.json'));
  } catch {
    throw notBackup();
  }
  if (manifest?.format !== BACKUP_FORMAT) throw notBackup();
  if (manifest.version !== 2) throw manifest.version > 2 ? new LocalError('newer', 'That backup was made by a newer version of Secure Box.') : notBackup();
  return {
    manifest,
    keyring: await readText(KEYRING),
    index: await readText(INDEX),
    content,
    blob: (id) => byPath.get(`${FILES}/${id}`) || null,
    blobIds: () =>
      entries
        .filter((e) => !e.dir && e.path.startsWith(`${FILES}/`))
        .map((e) => e.path.slice(FILES.length + 1))
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
  };
}
