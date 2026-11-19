/**
 * Local vault: encrypted files kept on this device only. Nothing here is uploaded, and it
 * unlocks together with the account (its index is sealed with a key derived from the master key).
 *
 * Where it lives
 *   browser  the browser's private storage for Secure Box (the "origin private file system").
 *            Works in every modern browser, phones included, but isn't visible as files and goes
 *            away if someone clears this site's data, so we ask for persistent storage (the
 *            browser then never clears it on its own) and make backups easy.
 *   folder   a folder you choose (Chrome and Edge on computers): ordinary encrypted files you can
 *            see, copy or keep in a synced folder. The browser asks once per visit to allow it.
 *
 * Layout, in either place:   index.json   folders, files and their keys, encrypted (LOCAL_INDEX)
 *                             files/<id>   one encrypted blob per file (fileformat.js)
 * In a chosen folder, these sit in a "Secure Box" subfolder. Anything else found there is a file
 * someone put in by hand: still unencrypted, so the app offers to encrypt it (see strays()).
 */
import { zipEntries, zipEntryData, zipFolder } from './localbox.js';
import { LOCAL_INDEX, VaultCipher, applyChange, parseEnvelope } from './vault.js';

const VAULT_DIR = 'Secure Box';
const INDEX = 'index.json';
const FILES = 'files';
const ID_PREFIX = 'local:';
const BACKUP_FORMAT = 'secure-box-local-backup';
const DB_NAME = 'secure-box-local';
const IGNORED = /^(\..*|desktop\.ini|thumbs\.db|.*\.crswap)$/i; // hidden files, OS clutter, a browser's half-written files

export const isLocalId = (driveId) => typeof driveId === 'string' && driveId.startsWith(ID_PREFIX);

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
// A chosen folder is remembered per account in IndexedDB (a handle, no secrets)
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

async function browserRoot(kid, demo, create) {
  const opfs = await navigator.storage.getDirectory();
  const base = await opfs.getDirectoryHandle(demo ? 'secure-box-demo' : 'secure-box', { create });
  return base.getDirectoryHandle(kid, { create });
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
  if (await has(picked, INDEX)) return picked;
  return picked.getDirectoryHandle(VAULT_DIR, { create });
}

/** Where this account's local vault is on this device: { where, handle?, name?, ready } or null. */
export async function findLocalVault(kid, { demo = false } = {}) {
  const support = localSupport();
  if (support.folder && !demo) {
    const handle = await idb('readonly', (s) => s.get(spaceKey(kid, demo))).catch(() => null);
    if (handle) {
      let permission = 'prompt';
      try {
        permission = await handle.queryPermission({ mode: 'readwrite' });
      } catch {
        /* treated as "ask again" */
      }
      return { where: 'folder', handle, name: handle.name, ready: permission === 'granted' };
    }
  }
  if (support.browser) {
    try {
      if (await has(await browserRoot(kid, demo, false), INDEX)) return { where: 'browser', ready: true };
    } catch {
      /* no local vault in this browser */
    }
  }
  return null;
}

/** Asks for access to a remembered folder again; needs a click. */
export async function allowFolder(handle) {
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function forgetFolder(kid, { demo = false } = {}) {
  await idb('readwrite', (s) => s.delete(spaceKey(kid, demo))).catch(() => {});
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------
/**
 * Opens (or with `create`, makes) this account's local vault. `notify()` is called after each
 * save so other windows can reload. Errors: 'other-account' when a folder's vault belongs to
 * another account.
 */
export async function openLocalVault({ master, where, handle = null, create = false, demo = false, notify = () => {} }) {
  const cipher = await VaultCipher.create(master, LOCAL_INDEX);
  const root = where === 'folder' ? await folderRoot(handle, create) : await browserRoot(master.kid, demo, create);
  const filesDir = await root.getDirectoryHandle(FILES, { create: true });
  const lockName = `secure-box-local:${where}:${spaceKey(master.kid, demo)}`;
  const withLock = (run) => (navigator.locks ? navigator.locks.request(lockName, run) : run());
  let index = null;
  let stamp = '';

  async function readIndex() {
    let file;
    try {
      file = await (await root.getFileHandle(INDEX)).getFile();
    } catch (err) {
      if (err.name === 'NotFoundError') return null;
      throw err;
    }
    const nextStamp = `${file.lastModified}:${file.size}`;
    if (index && nextStamp === stamp) return index;
    const env = parseEnvelope(await file.text(), LOCAL_INDEX.format);
    if (env.kid !== master.kid) {
      const err = new Error('This folder holds the local vault of a different Secure Box account.');
      err.code = 'other-account';
      throw err;
    }
    index = await cipher.open(env);
    stamp = nextStamp;
    return index;
  }

  async function writeIndex(data) {
    const handle = await root.getFileHandle(INDEX, { create: true });
    const writable = await handle.createWritable(); // replaces the old index in one step, on close()
    await writable.write(await cipher.seal(data));
    await writable.close();
    const file = await handle.getFile();
    index = data;
    stamp = `${file.lastModified}:${file.size}`;
  }

  await withLock(async () => {
    if (!(await readIndex())) {
      if (!create) throw new Error('The local vault on this device is missing.');
      await writeIndex({ schema: 2, items: [], folders: [], files: [], created: Date.now(), changedAt: 0, backupAt: 0 });
    }
  });
  if (where === 'folder') await idb('readwrite', (s) => s.put(handle, spaceKey(master.kid, demo)));

  const fid = (driveId) => {
    const id = isLocalId(driveId) ? driveId.slice(ID_PREFIX.length) : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Not a file of the local vault.');
    return id;
  };
  async function blobOf(driveId) {
    try {
      return await (await filesDir.getFileHandle(fid(driveId))).getFile();
    } catch (err) {
      if (err.name === 'NotFoundError') throw new Error('This file is missing from the local vault on this device.');
      throw err;
    }
  }

  const store = {
    kind: 'local',
    where,
    name: where === 'folder' ? handle.name : 'This browser',
    getVault: () => index,

    /** Applies a change to the latest index (another window may have saved first). */
    commit(change) {
      return withLock(async () => {
        const latest = await readIndex();
        const next = change.op === 'set' ? { ...latest, ...change.fields } : { ...applyChange(latest, change), changedAt: Date.now() };
        await writeIndex(next);
        notify();
        return next;
      });
    },

    /** Picks up another window's changes; true when something changed. */
    async reload() {
      const before = index;
      await withLock(readIndex);
      return index !== before;
    },

    backend: {
      async readRange(driveId, start, end) {
        return (await blobOf(driveId)).slice(start, end + 1).stream();
      },
      async readBytes(driveId, start, end) {
        return (await blobOf(driveId)).slice(start, end + 1).arrayBuffer();
      },
      async openUpload({ fid: id }) {
        const handle = await filesDir.getFileHandle(id, { create: true });
        const writable = await handle.createWritable();
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
        await filesDir.removeEntry(fid(driveId)).catch((err) => {
          if (err.name !== 'NotFoundError') throw err;
        });
      },
    },

    /** 'files' (a real folder), 'protected' (the browser won't clear it by itself) or 'unprotected'. */
    async protection() {
      if (where === 'folder') return 'files';
      return (await navigator.storage?.persisted?.()) ? 'protected' : 'unprotected';
    },
    /** Asks the browser for persistent storage. Firefox asks the person; others decide by themselves. */
    async protect() {
      return Boolean(await navigator.storage?.persist?.());
    },
    async usage() {
      return where === 'browser' && navigator.storage?.estimate ? navigator.storage.estimate() : null;
    },

    /** Unencrypted files someone put into the vault's folder by hand (folder vaults only). */
    async strays() {
      if (where !== 'folder') return [];
      const found = [];
      const walk = async (dir, path) => {
        for await (const [name, entry] of dir.entries()) {
          if (IGNORED.test(name) || (dir === root && (name === INDEX || name === FILES))) continue;
          if (entry.kind === 'file') found.push({ name, path, parent: dir, file: await entry.getFile() });
          else await walk(entry, [...path, name]);
        }
      };
      await walk(root, []);
      return found;
    },
    /** Removes an original after it was encrypted, then any folders that are left empty. */
    async removeStray(stray) {
      await stray.parent.removeEntry(stray.name);
    },
    async pruneEmptyFolders() {
      const prune = async (dir) => {
        let empty = true;
        for await (const [name, entry] of dir.entries()) {
          if (entry.kind === 'directory' && !(dir === root && name === FILES) && (await prune(entry))) await dir.removeEntry(name).catch(() => {});
          else empty = false;
        }
        return empty;
      };
      await prune(root);
    },

    /**
     * One ZIP of the vault exactly as stored: the encrypted index and blobs, nothing decrypted.
     * It opens only with this account, so it can be kept anywhere.
     */
    async backup({ onProgress, signal } = {}) {
      const { indexText, files } = await withLock(async () => {
        await readIndex();
        const text = await (await (await root.getFileHandle(INDEX)).getFile()).text();
        return { indexText: text, files: index.files };
      });
      const now = Date.now();
      const manifest = { format: BACKUP_FORMAT, version: 1, kid: master.kid, created: new Date(now).toISOString(), files: files.length };
      const items = [
        { path: 'backup.json', file: new File([JSON.stringify(manifest, null, 2)], 'backup.json', { lastModified: now }) },
        { path: 'index.json', file: new File([indexText], 'index.json', { lastModified: now }) },
        { path: `${FILES}/`, dir: true, mtime: now },
      ];
      for (const entry of files) {
        try {
          items.push({ path: `${FILES}/${fid(entry.driveId)}`, file: await blobOf(entry.driveId) });
        } catch {
          /* a missing blob can't be backed up */
        }
      }
      const blob = await zipFolder(items, { onProgress, signal });
      await store.commit({ op: 'set', fields: { backupAt: now } });
      return { blob, name: `Secure Box local vault backup ${new Date(now).toISOString().slice(0, 10)}.zip` };
    },

    /** Adds what's in a backup and not here yet. Returns how many files were added. */
    async restore(file, { onProgress, signal } = {}) {
      const content = { size: file.size, read: async (from, to) => new Uint8Array(await file.slice(from, to + 1).arrayBuffer()) };
      const notBackup = () => new Error('That isn’t a Secure Box local vault backup, or it’s damaged.');
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
      if (manifest.version !== 1) throw new Error('That backup was made by a newer version of Secure Box.');
      if (manifest.kid !== master.kid) throw new Error('That backup belongs to a different Secure Box account.');
      const saved = await cipher.open(parseEnvelope(await readText('index.json'), LOCAL_INDEX.format));
      const current = await withLock(readIndex);
      const haveFiles = new Set(current.files.map((f) => f.id));
      const haveFolders = new Set(current.folders.map((f) => f.id));
      const todo = saved.files.filter((f) => !haveFiles.has(f.id) && byPath.has(`${FILES}/${fid(f.driveId)}`));
      const total = todo.reduce((n, f) => n + byPath.get(`${FILES}/${fid(f.driveId)}`).size, 0) || 1;
      let copied = 0;
      const changes = saved.folders.filter((f) => !haveFolders.has(f.id)).map((folder) => ({ op: 'folder-put', folder }));
      for (const entry of todo) {
        signal?.throwIfAborted();
        const id = fid(entry.driveId);
        const writable = await (await filesDir.getFileHandle(id, { create: true })).createWritable();
        try {
          for await (const bytes of zipEntryData(content, byPath.get(`${FILES}/${id}`))) {
            signal?.throwIfAborted();
            await writable.write(bytes);
            copied += bytes.length;
            onProgress?.(copied / total);
          }
          await writable.close();
        } catch (err) {
          await writable.abort().catch(() => {});
          await filesDir.removeEntry(id).catch(() => {});
          throw err;
        }
        changes.push({ op: 'file-put', file: entry });
      }
      if (changes.length) await store.commit({ op: 'batch', changes });
      return todo.length;
    },
  };
  return store;
}
