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
 * Layout, in either place, with the same names as in the clouds:
 *   Secure Box Key Ring.json   the key ring (your master key, locked)
 *   Secure Box Vault.json      the vault: passwords, folders, files and their keys, encrypted
 *                              with a key of its own (LOCAL_INDEX)
 *   Encrypted files/<id>       one encrypted blob per file (fileformat.js)
 * In the browser, each vault has a folder named after its master key's id. In a chosen folder,
 * the vault sits in a "Secure Box" subfolder; anything else found there was put in by hand and is
 * still unencrypted, so the app offers to encrypt it (strays()).
 */
import { zipEntries, zipEntryData, zipFolder } from './localbox.js';
import { KEYRING_FILE_NAME } from './keyring.js';
import { FILES_FOLDER, LOCAL_INDEX, VAULT_FILE_NAME } from './vault.js';

const VAULT_DIR = 'Secure Box';
const KEYRING = KEYRING_FILE_NAME;
const INDEX = VAULT_FILE_NAME;
const FILES = FILES_FOLDER;
const ID_PREFIX = 'local:';
const BACKUP_FORMAT = 'secure-box-local-backup';
const DB_NAME = 'secure-box-local';
const IGNORED = /^(\..*|desktop\.ini|thumbs\.db|.*\.crswap)$/i; // hidden files, OS clutter, a browser's half-written files

export const isLocalId = (driveId) => typeof driveId === 'string' && driveId.startsWith(ID_PREFIX);

/** Why a vault kept in the browser is gone. */
export const BROWSER_GONE = 'This site’s data in the browser was cleared (in the browser’s settings, by a clean-up tool, or by the browser itself to free up space), and your vault in this browser went with it.';

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

/** The key id of the vault in a chosen folder (in it, or in its "Secure Box" folder), or null if it holds none. */
export async function vaultIn(picked) {
  try {
    const root = await folderRoot(picked, false);
    return JSON.parse(await (await (await root.getFileHandle(KEYRING)).getFile()).text()).kid || null;
  } catch {
    return null;
  }
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
// Moving and deleting touch only a vault's own entries (key ring, vault, files), so anything
// else in a chosen folder stays where it is.
// ---------------------------------------------------------------------------
const BLOB_NAME = /^[0-9a-f-]{36}$/i;

const ignoreMissing = (err) => {
  if (err?.name !== 'NotFoundError') throw err;
};

async function isEmpty(dir) {
  return Boolean((await dir.entries().next()).done);
}

/** False once a directory was deleted (or moved) outside Secure Box: then everything on its handle fails. */
const reachable = (dir) => dir.entries().next().then(() => true, () => false);

async function writeFrom(dir, name, file, onBytes) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    const reader = file.stream().getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      await writable.write(next.value);
      onBytes?.(next.value.length);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

/**
 * Copies a vault, exactly as stored, from one directory to another: its encrypted files first,
 * then the vault and its key ring, so a copy that stops halfway is never taken for a vault. A
 * place that already has a vault is refused, and on any failure what was written is removed.
 */
export async function copyVault(from, to, { onProgress, signal } = {}) {
  if ((await has(to, KEYRING)) || (await has(to, INDEX))) throw new LocalError('exists', 'There’s already a Secure Box vault there.');
  const [keyring, index] = await Promise.all([KEYRING, INDEX].map(async (name) => (await from.getFileHandle(name)).getFile()));
  const fromFiles = await from.getDirectoryHandle(FILES).catch(() => null);
  const blobs = [];
  if (fromFiles) {
    for await (const [name, entry] of fromFiles.entries()) if (entry.kind === 'file' && BLOB_NAME.test(name)) blobs.push({ name, file: await entry.getFile() });
  }
  const toFiles = await to.getDirectoryHandle(FILES, { create: true });
  const total = blobs.reduce((n, b) => n + b.file.size, keyring.size + index.size) || 1;
  let done = 0;
  const step = (n) => onProgress?.(Math.min(1, (done += n) / total));
  const written = [];
  try {
    for (const { name, file } of blobs) {
      signal?.throwIfAborted();
      written.push([toFiles, name]);
      await writeFrom(toFiles, name, file, step);
    }
    for (const [name, file] of [[INDEX, index], [KEYRING, keyring]]) {
      written.push([to, name]);
      await writeFrom(to, name, file, step);
    }
    for (const { name, file } of blobs) {
      if ((await (await toFiles.getFileHandle(name)).getFile()).size !== file.size) throw new LocalError('copy', 'A file didn’t copy completely.');
    }
  } catch (err) {
    for (const [dir, name] of written.reverse()) await dir.removeEntry(name).catch(() => {}); // the key ring goes first
    if (await isEmpty(toFiles)) await to.removeEntry(FILES).catch(() => {});
    throw err;
  }
}

/** Deletes a vault's own entries from its directory, the key ring first: a delete that stops halfway leaves no vault. */
export async function removeVault(dir) {
  for (const name of [KEYRING, INDEX]) await dir.removeEntry(name).catch(ignoreMissing);
  await dir.removeEntry(FILES, { recursive: true }).catch(ignoreMissing);
}

// ---------------------------------------------------------------------------
// The backend (same calls as the cloud ones in backend.js)
// ---------------------------------------------------------------------------
/**
 * `kid` names an existing vault in the browser (or comes with create()); `handle` is a chosen
 * folder. `existing`: a vault this device had is expected here, so finding none means it was
 * deleted or moved outside Secure Box. `notify()` runs after each save, so other windows can
 * reload; `onGone(err)` once the vault turns out to be gone, whatever was being done with it.
 */
export function createLocalBackend({ where = 'browser', handle = null, kid = null, demo = false, existing = false, notify = () => {}, onGone = () => {} }) {
  let root = null;
  let filesDir = null;
  let stamp = '';
  let currentKid = kid;
  let lost = null; // set once the vault turns out to be gone (see goneError)

  const lockName = () => `secure-box-local:${where}:${spaceKey(currentKid || handle?.name || 'new', demo)}`;
  const withLock = (run) => (navigator.locks ? navigator.locks.request(lockName(), run) : run());

  async function open(create = false) {
    if (lost) throw lost; // never quietly make a new, empty vault where the old one was
    if (root) return root;
    if (where === 'folder') {
      try {
        root = await folderRoot(handle, create);
      } catch (err) {
        throw err.name === 'NotFoundError' ? await goneError() : err;
      }
    } else {
      if (!currentKid) throw new LocalError('missing', 'There is no vault on this device yet.');
      try {
        root = await (await browserBase(demo, create)).getDirectoryHandle(currentKid, { create });
      } catch (err) {
        throw err.name === 'NotFoundError' && existing ? await goneError() : err;
      }
    }
    // The encrypted files' folder is made when a file first needs it, so a vault found emptied
    // is left exactly as it was found.
    filesDir = await root.getDirectoryHandle(FILES, { create }).catch((err) => {
      if (err.name === 'NotFoundError') return null;
      throw err;
    });
    return root;
  }

  /** The encrypted files' folder, made first if `create`; null while there's none. */
  async function filesFolder(create = false) {
    const top = await open(create);
    if (!filesDir && create) {
      try {
        filesDir = await top.getDirectoryHandle(FILES, { create: true });
      } catch (err) {
        throw await notFound(err);
      }
    }
    return filesDir;
  }

  /**
   * The vault was deleted or moved outside Secure Box (`emptied`: its folder is still there, but
   * not its files). From now on every call says so, until findAgain() finds it again; the app
   * hears of it once, through onGone().
   */
  async function goneError(emptied = false) {
    root = null;
    filesDir = null;
    if (lost) return lost;
    let message;
    if (where === 'browser') message = BROWSER_GONE;
    else if (!(await reachable(handle))) message = `The folder “${handle.name}” that held your vault on this device isn’t there any more.`;
    else if (emptied) message = `Your vault’s files aren’t in “${handle.name}” any more: they were moved or deleted.`;
    else message = `Your vault isn’t in “${handle.name}” any more: its “${VAULT_DIR}” folder was moved or deleted.`;
    lost = new LocalError('gone', message);
    onGone(lost);
    return lost;
  }

  /** After a "not found": is just that one entry missing, or the whole vault? */
  async function stillThere() {
    const top = root;
    if (!top || !(await reachable(top))) return false;
    return (await has(top, INDEX)) || (await has(top, KEYRING));
  }

  /** `err`, or the vault's own "gone" error when a "not found" came from the vault going. */
  async function notFound(err) {
    return err?.name === 'NotFoundError' && !(await stillThere()) ? goneError() : err;
  }

  async function readFile(name) {
    const top = await open();
    try {
      return await (await top.getFileHandle(name)).getFile();
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
      if (!(await reachable(top))) throw await goneError();
      return null;
    }
  }

  async function writeFile(name, text) {
    let handleOf;
    try {
      handleOf = await (await open(true)).getFileHandle(name, { create: true });
    } catch (err) {
      throw err.name === 'NotFoundError' ? await goneError() : err;
    }
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
    if (!BLOB_NAME.test(id)) throw new Error('Not a file of this device’s vault.');
    return id;
  };

  /** The vault's own folder goes too once it's empty: the key id's folder in the browser, "Secure Box" in a chosen one. */
  async function dropFolder(top) {
    if (!(await isEmpty(top))) return;
    if (where === 'browser') await (await browserBase(demo, false)).removeEntry(currentKid).catch(() => {});
    else if (!(await top.isSameEntry(handle))) await handle.removeEntry(VAULT_DIR).catch(() => {});
  }

  async function blobOf(driveId) {
    const dir = await filesFolder();
    try {
      if (!dir) throw new DOMException('There are no encrypted files here.', 'NotFoundError');
      return await (await dir.getFileHandle(fid(driveId))).getFile();
    } catch (err) {
      const why = await notFound(err);
      if (why !== err || err.name !== 'NotFoundError') throw why;
      throw new Error('This file is missing from the vault on this device.');
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
        // A newly chosen folder gets its vault folder now; a known one must still be there.
        await open(where === 'folder' && !currentKid);
      } catch (err) {
        if (err.name === 'NotFoundError' && where === 'browser') return { keyring: null, vault: null };
        throw err;
      }
      const [keyringFile, indexFile] = await Promise.all([readFile(KEYRING), readFile(INDEX)]);
      // A vault this device had, found emptied: its files were deleted or moved outside Secure Box.
      if (existing && !keyringFile && !indexFile) throw await goneError(true);
      existing ||= Boolean(keyringFile || indexFile);
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
      existing = true;
      await remember();
      return rev;
    },

    /** After the vault was found gone: looks for it again (it may have been put back), from scratch. */
    async findAgain() {
      lost = null;
      root = null;
      filesDir = null;
      const top = await open();
      if (!(await has(top, INDEX)) && !(await has(top, KEYRING))) throw await goneError(true);
    },

    /** Whether the vault can be saved again where it was: in the browser always, in a folder while that folder is there. */
    placeIsThere: async () => where === 'browser' || reachable(handle),

    /**
     * Saves an open vault again where it was, after it was deleted outside Secure Box: its key
     * ring and vault, from what's open. Its encrypted files can't come back this way.
     */
    async recreate({ keyringText, vaultText }) {
      lost = null;
      root = null;
      filesDir = null;
      await writeFile(KEYRING, keyringText);
      return this.createVault(vaultText);
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
      const dir = await filesFolder(true);
      let writable;
      try {
        writable = await (await dir.getFileHandle(id, { create: true })).createWritable();
      } catch (err) {
        throw await notFound(err);
      }
      const send = async (piece, offset, total) => {
        try {
          await writable.write(piece);
          if (offset + piece.length < total) return null;
          await writable.close();
        } catch (err) {
          throw await notFound(err);
        }
        return `${ID_PREFIX}${id}`;
      };
      send.abort = async () => {
        await writable.abort().catch(() => {});
        await dir.removeEntry(id).catch(() => {});
      };
      return send;
    },

    async trash(driveId) {
      const dir = await filesFolder();
      if (!dir) return; // no encrypted files here at all
      await dir.removeEntry(fid(driveId)).catch(async (err) => {
        if (err.name !== 'NotFoundError') throw err;
        if (!(await stillThere())) throw await goneError();
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

    // ---- Moving and deleting ------------------------------------------------
    /** The vault's own folder (made if `create`): see the layout at the top. */
    root: (create = false) => open(create),

    /** After a copy here didn't finish: this place's folders go if they hold nothing. */
    async dropIfEmpty() {
      if (!root) return;
      const top = root;
      root = null;
      filesDir = null;
      const files = await top.getDirectoryHandle(FILES).catch(() => null);
      if (files && (await isEmpty(files))) await top.removeEntry(FILES).catch(() => {});
      await dropFolder(top);
    },

    /**
     * Moves this vault, exactly as stored, to `target` (a backend for another place on this
     * device, same key id): copies it, lets the app open the copy (`opened`), then deletes it
     * here. Other windows' saves wait meanwhile. Resolves with the error that kept the old copy,
     * if deleting it failed; nothing is deleted when the copy or `opened` fails.
     */
    async moveTo(target, { onProgress, signal, opened }) {
      return withLock(async () => {
        const from = await open();
        const to = await target.root(true);
        if (await from.isSameEntry(to)) throw new LocalError('same', 'Your vault is already there.');
        // Deleting this copy afterwards would take a copy inside it along.
        if (await from.resolve?.(to)) {
          await target.dropIfEmpty().catch(() => {});
          throw new LocalError('inside', 'That folder is inside your vault’s own folder. Choose one outside it.');
        }
        try {
          await copyVault(from, to, { onProgress, signal });
        } catch (err) {
          if (err.code !== 'exists') await target.dropIfEmpty().catch(() => {});
          throw err;
        }
        try {
          await opened();
        } catch (err) {
          // No locks here: a move between two folders shares this one.
          await removeVault(to).catch(() => {});
          await target.dropIfEmpty().catch(() => {});
          throw err;
        }
        try {
          await removeVault(from);
          root = null;
          filesDir = null;
          await dropFolder(from);
          return null;
        } catch (err) {
          return err;
        }
      });
    },

    /** Deletes this vault from this device: its key ring, vault and encrypted files, and nothing else. */
    async removeAll() {
      await withLock(async () => {
        const top = await open();
        await removeVault(top);
        root = null;
        filesDir = null;
        await dropFolder(top);
      });
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
      const dir = await filesFolder(true);
      const id = fid(driveId);
      const entry = backup.blob(id);
      if (!entry) return false;
      const writable = await (await dir.getFileHandle(id, { create: true })).createWritable();
      try {
        for await (const bytes of zipEntryData(backup.content, entry)) {
          await writable.write(bytes);
          onBytes?.(bytes.length);
        }
        await writable.close();
        return true;
      } catch (err) {
        await writable.abort().catch(() => {});
        await dir.removeEntry(id).catch(() => {});
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
