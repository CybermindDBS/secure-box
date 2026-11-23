/**
 * The "This device" vault: passwords and files kept on this device only. It works like the cloud
 * vaults (same key ring, same encryption, same app), but nothing in it is ever uploaded.
 *
 * Where it lives
 *   folder   a folder you choose (Chrome and Edge on computers, Chrome on Android): ordinary
 *            encrypted files you can see, copy or keep in a synced folder. The browser asks once
 *            per visit to allow it.
 *   browser  an experiment, off in production (experiments.js): the browser's private storage
 *            for Secure Box (the "origin private file system"). Works in every modern browser,
 *            phones included, but isn't visible as files, goes away if someone clears this site's
 *            data, and stays behind at this address if Secure Box moves to another; we ask for
 *            persistent storage (the browser then never clears it on its own) and make backups easy.
 *
 * Layout, in either place, exactly as in the clouds (a vault is the same everywhere):
 *   Secure Box Key Ring.json   the key ring (your master key, locked)
 *   Secure Box Vault.json      the vault: passwords, folders, files and their keys, encrypted
 *   Encrypted files/<name>     one encrypted copy per file (fileformat.js), named in the vault
 * In the browser, each vault has a folder named after its master key's id. In a chosen folder,
 * the vault sits in a "Secure Box" subfolder; anything else found there was put in by hand and is
 * still unencrypted, so the app offers to encrypt it (strays()).
 */
import { isEncryptedCopy } from './fileformat.js';
import { zipEntries, zipEntryData, zipFolder } from './localbox.js';
import { KEYRING_FILE_NAME, parseKeyring } from './keyring.js';
import { FILES_FOLDER, VAULT_FILE_NAME, isBlobName, parseEnvelope } from './vault.js';
import { BROWSER_VAULT } from '../experiments.js';

const VAULT_DIR = 'Secure Box';
const KEYRING = KEYRING_FILE_NAME;
const INDEX = VAULT_FILE_NAME;
const FILES = FILES_FOLDER;
const BACKUP_FORMAT = 'secure-box-backup';
const BACKUP_VERSION = 1;
/** The day of `time` where you are (YYYY-MM-DD), for a file name: not in UTC, which can be another day. */
const localDay = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DB_NAME = 'secure-box-local';
const IGNORED = /^(\..*|desktop\.ini|thumbs\.db|.*\.crswap)$/i; // hidden files, OS clutter, a browser's half-written files
// Copies of the key ring or vault that a sync service made when two computers changed them at
// once ("Secure Box Vault (1).json", "Secure Box Vault-LAPTOP.json"): Secure Box's own, never
// files put in by hand.
const OWN_COPY = /^Secure Box (Vault|Key Ring)\b.*\.json$/i;

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
    // The browser's own storage: only where that experiment is on (experiments.js).
    browser: BROWSER_VAULT && typeof navigator.storage?.getDirectory === 'function' && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype,
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
  if (BROWSER_VAULT && support.browser) {
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
const ignoreMissing = (err) => {
  if (err?.name !== 'NotFoundError') throw err;
};

async function isEmpty(dir) {
  return Boolean((await dir.entries().next()).done);
}

/** False once a directory was deleted (or moved) outside Secure Box: then everything on its handle fails. */
const reachable = (dir) => dir.entries().next().then(() => true, () => false);

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
      if (!BROWSER_VAULT || !currentKid) throw new LocalError('missing', 'There is no vault on this device yet.');
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
    if (BROWSER_VAULT && where === 'browser') message = BROWSER_GONE;
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

  /**
   * The vault file's revision: when it was saved, and the random salt that save sealed it with,
   * so two saves never look alike, however coarse the disk's clock (FAT32 keeps 2-second times)
   * and however alike their sizes. The salt is near the start of the file, so little is read.
   */
  async function stampOf(file) {
    if (!file) return '';
    const salt = /"salt":"([^"]+)"/.exec(await file.slice(0, 512).text())?.[1];
    return `${file.lastModified}:${salt || file.size}`;
  }

  async function remember() {
    if (where === 'folder' && currentKid) await idb('readwrite', (s) => s.put(handle, spaceKey(currentKid, demo))).catch(() => {});
  }

  const checked = (name) => {
    if (!isBlobName(name)) throw new Error('Not a file of this device’s vault.');
    return name;
  };

  /** The vault's own folder goes too once it's empty: the key id's folder in the browser, "Secure Box" in a chosen one. */
  async function dropFolder(top) {
    if (!(await isEmpty(top))) return;
    if (BROWSER_VAULT && where === 'browser') await (await browserBase(demo, false)).removeEntry(currentKid).catch(() => {});
    else if (!(await top.isSameEntry(handle))) await handle.removeEntry(VAULT_DIR).catch(() => {});
  }

  async function blobOf(name) {
    const dir = await filesFolder();
    try {
      if (!dir) throw new DOMException('There are no encrypted files here.', 'NotFoundError');
      return await (await dir.getFileHandle(checked(name))).getFile();
    } catch (err) {
      const why = await notFound(err);
      if (why !== err || err.name !== 'NotFoundError') throw why;
      throw new LocalError('not-found', 'This file’s encrypted copy is missing from the vault on this device.');
    }
  }

  const backend = {
    kind: 'local',
    provider: 'local',
    where,
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
      if (BROWSER_VAULT && where === 'browser' && !currentKid) return { keyring: null, vault: null }; // a new vault, not made yet
      try {
        // A newly chosen folder gets its vault folder now; a known one must still be there.
        await open(where === 'folder' && !currentKid);
      } catch (err) {
        if (BROWSER_VAULT && err.name === 'NotFoundError' && where === 'browser') return { keyring: null, vault: null };
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
      stamp = await stampOf(indexFile);
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
    placeIsThere: async () => (BROWSER_VAULT && where === 'browser') || reachable(handle),

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
        stamp = await stampOf(await writeFile(INDEX, vaultText));
        notify();
        return stamp;
      });
    },

    async saveKeyring(text) {
      await writeFile(KEYRING, text);
    },
    putKeyring(text) {
      return this.saveKeyring(text);
    },
    /** Free space for this site's storage in the browser, in bytes; null for a chosen folder (browsers don't say). */
    async freeSpace() {
      if (!BROWSER_VAULT || where === 'folder') return null;
      const { quota, usage } = (await navigator.storage?.estimate?.()) || {};
      return Number.isFinite(quota) ? Math.max(0, quota - (usage || 0)) : null;
    },

    vaultRevision: async () => stampOf(await readFile(INDEX)),

    /** Replaces the vault, but only if it's still the version this window last read. */
    writeVault(text, rev) {
      return withLock(async () => {
        const now = await stampOf(await readFile(INDEX));
        if (rev && now !== rev) throw new LocalError('conflict', 'The vault changed in another window.');
        stamp = await stampOf(await writeFile(INDEX, text));
        notify();
        return stamp;
      });
    },

    async readVault() {
      const file = await readFile(INDEX);
      if (!file) throw new LocalError('missing', 'The vault on this device is missing.');
      return { text: await file.text(), rev: await stampOf(file) };
    },

    /** Stores a new encrypted copy under `name`: returns send(piece, offset, total) for the piece writer. */
    async openUpload({ name }) {
      const dir = await filesFolder(true);
      let writable;
      try {
        writable = await (await dir.getFileHandle(checked(name), { create: true })).createWritable();
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
        return name;
      };
      send.abort = async () => {
        await writable.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
      };
      return send;
    },

    /** The encrypted copies stored here: name -> { size } (none while this place has no vault yet). */
    async listBlobs() {
      const found = new Map();
      const dir = await filesFolder().catch((err) => {
        if (err.name === 'NotFoundError') return null; // nothing made here yet
        throw err;
      });
      if (!dir) return found;
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind === 'file' && isBlobName(name)) found.set(name, { size: (await entry.getFile()).size });
      }
      return found;
    },

    /** Of `names`, the ones whose encrypted copy isn't here (deleted outside Secure Box, say). */
    async absent(names) {
      const here = new Set();
      const top = await open();
      try {
        // Found afresh: a folder deleted, or put back, since the vault opened.
        const dir = await top.getDirectoryHandle(FILES);
        if (names.length <= 8) {
          for (const name of names) {
            const found = await dir.getFileHandle(checked(name)).then(
              () => true,
              (err) => {
                if (err.name !== 'NotFoundError') throw err;
                return false;
              },
            );
            if (found) here.add(name);
          }
        } else for await (const [name] of dir.entries()) here.add(name);
      } catch (err) {
        const why = await notFound(err);
        if (why !== err || err.name !== 'NotFoundError') throw why; // the vault itself went, or worse
        // No encrypted files' folder: none of the copies is here.
      }
      return names.filter((name) => !here.has(name));
    },

    /** Deletes an encrypted copy (one that's gone already counts as deleted). */
    async trash(name) {
      const dir = await filesFolder();
      if (!dir) return; // no encrypted files here at all
      await dir.removeEntry(checked(name)).catch(async (err) => {
        if (err.name !== 'NotFoundError') throw err;
        if (!(await stillThere())) throw await goneError();
      });
    },

    readRange: async (name, start, end) => (await blobOf(name)).slice(start, end + 1).stream(),
    readBytes: async (name, start, end) => (await blobOf(name)).slice(start, end + 1).arrayBuffer(),

    // ---- Keeping it safe --------------------------------------------------
    /** 'files' (a real folder), 'protected' (the browser won't clear it by itself) or 'unprotected'. */
    async protection() {
      if (!BROWSER_VAULT || where === 'folder') return 'files';
      return (await navigator.storage?.persisted?.()) ? 'protected' : 'unprotected';
    },
    /** Asks the browser for persistent storage. Firefox asks the person; others decide by themselves. */
    async protect() {
      return BROWSER_VAULT && Boolean(await navigator.storage?.persist?.());
    },

    /**
     * Unencrypted files someone put into a folder vault by hand. Secure Box's own files never
     * count, wherever they are: encrypted copies (by their name, or by what's in them, if one was
     * renamed or moved), and sync services' copies of the key ring or vault.
     */
    async strays() {
      if (where !== 'folder') return [];
      const top = await open();
      const found = [];
      const walk = async (dir, path) => {
        for await (const [name, entry] of dir.entries()) {
          if (IGNORED.test(name) || OWN_COPY.test(name) || (dir === top && [KEYRING, INDEX, FILES].includes(name))) continue;
          if (entry.kind !== 'file') {
            await walk(entry, [...path, name]);
            continue;
          }
          if (isBlobName(name)) continue;
          const file = await entry.getFile();
          if (!(await isEncryptedCopy(file))) found.push({ name, path, parent: dir, file });
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

    /** A place chosen for a transfer that didn't happen (migrate.js): its folders go if they hold nothing. */
    async dropIfEmpty() {
      if (!root) return;
      const top = root;
      root = null;
      filesDir = null;
      const files = await top.getDirectoryHandle(FILES).catch(() => null);
      if (files && (await isEmpty(files))) await top.removeEntry(FILES).catch(() => {});
      await dropFolder(top);
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
     * One ZIP of the vault exactly as stored, laid out as it is in every place: key ring, vault
     * and the encrypted copies, nothing decrypted. It opens only with your master password or
     * Emergency Kit, so it can be kept anywhere. `missing`: the file entries whose encrypted copy
     * isn't here (deleted outside Secure Box), so isn't in the backup either. `pack(items,
     * { onProgress })`, if given, packs the ZIP instead (in a worker: packing reads every byte to
     * checksum it); if it can't, the ZIP is packed here.
     */
    async backup(fileEntries, { onProgress, signal, pack = null } = {}) {
      const [keyringFile, indexFile] = await Promise.all([readFile(KEYRING), readFile(INDEX)]);
      if (!keyringFile || !indexFile) throw new LocalError('missing', 'The vault on this device is incomplete.');
      const now = Date.now();
      const copies = [];
      const missing = [];
      for (const entry of fileEntries) {
        try {
          copies.push({ path: `${FILES}/${checked(entry.blob)}`, file: await blobOf(entry.blob) });
        } catch (err) {
          if (err?.code !== 'not-found') throw err;
          missing.push(entry);
        }
      }
      const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, kid: currentKid, created: new Date(now).toISOString(), files: copies.length };
      const text = (name, value) => ({ path: name, file: new File([value], name, { lastModified: now }) });
      const items = [
        text('backup.json', JSON.stringify(manifest, null, 2)),
        text(KEYRING, await keyringFile.text()),
        text(INDEX, await indexFile.text()),
        { path: `${FILES}/`, dir: true, mtime: now },
        ...copies,
      ];
      const packed = pack
        ? await pack(items, { onProgress }).catch((err) => {
            console.warn('Packing the backup in a worker failed, so it’s packed here:', err);
            return null;
          })
        : null;
      const blob = packed || (await zipFolder(items, { onProgress, signal }));
      return { blob, missing, name: `Secure Box backup (this device) ${localDay(now)}.zip` };
    },

    /** Copies one encrypted copy, by its name, out of a backup (see readBackup) into this vault. */
    async restoreBlob(backup, name, onBytes) {
      const dir = await filesFolder(true);
      const entry = backup.blob(checked(name));
      if (!entry) return false;
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      try {
        for await (const bytes of zipEntryData(entry.content, entry)) {
          await writable.write(bytes);
          onBytes?.(bytes.length);
        }
        await writable.close();
        return true;
      } catch (err) {
        await writable.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
        throw err;
      }
    },
  };
  return backend;
}

/**
 * Reads what a vault can be restored from: one or more ZIP files (`files`: a File, or a list).
 *   - A Secure Box backup (⋯ → Back up this vault): backup.json, then the key ring, the vault and
 *     its encrypted copies, exactly as stored.
 *   - A vault's folder as Google Drive or OneDrive download it from their own websites (its
 *     “Secure Box” folder, which Google Drive may split over several ZIP files). A vault is the
 *     same in every place, so that's a whole vault too: the way back when Secure Box can't see
 *     it there any more, for one because it now connects to that cloud as a different app.
 * Resolves with { from: 'backup' | 'download', manifest: { kid, … }, keyring, vault, blob(name),
 * names() }: blob(name) is the ZIP entry of that encrypted copy (with the file it's in), or null.
 */
export async function readBackup(files) {
  const list = Array.isArray(files) ? files : [files];
  const notBackup = (name = '') => new LocalError('not-backup', `${name ? `“${name}”` : 'That'} isn’t a Secure Box backup or a download of a vault’s folder, or it’s damaged.`);
  const entries = []; // every file in every ZIP, each with the ZIP it's in
  for (const file of list) {
    const content = { size: file.size, read: async (from, to) => new Uint8Array(await file.slice(from, to + 1).arrayBuffer()) };
    let found;
    try {
      found = await zipEntries(content);
    } catch (err) {
      if (err?.code === 'zip') throw new LocalError('zip', `${list.length > 1 ? `“${file.name}”` : 'That ZIP file'} is packed in a way Secure Box doesn’t read.`);
      throw notBackup(list.length > 1 ? file.name : '');
    }
    for (const entry of found) if (!entry.dir) entries.push({ ...entry, content });
  }
  const readText = async (entry) => {
    if (!entry || entry.size > 64 * 1024 * 1024) throw notBackup();
    const parts = [];
    for await (const bytes of zipEntryData(entry.content, entry)) parts.push(bytes);
    return new Blob(parts).text();
  };
  const inThose = list.length > 1 ? 'those ZIP files' : 'that ZIP file';
  const manifestEntry = entries.find((e) => e.path === 'backup.json');
  const from = manifestEntry ? 'backup' : 'download';
  // Intact, but in a format this version doesn't read (Secure Box is still changing its formats).
  const otherVersion = () => new LocalError('other-version', `${manifestEntry ? 'That backup' : 'That vault'} was made by another version of Secure Box, so this one can’t restore it.`);
  let manifest = null;
  let root = ''; // where the vault's parts are in the ZIP
  if (manifestEntry) {
    if (list.length > 1) throw new LocalError('several', 'Restore one backup at a time.');
    try {
      manifest = JSON.parse(await readText(manifestEntry));
    } catch {
      throw notBackup();
    }
    if (manifest?.format !== BACKUP_FORMAT) throw typeof manifest?.format === 'string' && manifest.format.startsWith('secure-box-') ? otherVersion() : notBackup();
    if (manifest.version !== BACKUP_VERSION) throw manifest.version > BACKUP_VERSION ? new LocalError('newer', 'That backup was made by a newer version of Secure Box.') : otherVersion();
  } else {
    // A folder download: the vault's parts are wherever its key ring is (“Secure Box/”, or the top).
    const rings = entries.filter((e) => e.path === KEYRING || e.path.endsWith(`/${KEYRING}`));
    if (!rings.length) {
      if (entries.some((e) => copyName(e.path))) {
        throw new LocalError('no-keyring', `The vault’s key ring (${KEYRING}) isn’t in ${inThose}. If your download came as several ZIP files, choose all of them.`);
      }
      throw notBackup();
    }
    if (new Set(rings.map((e) => e.path)).size > 1) throw new LocalError('several', `There’s more than one vault in ${inThose}. Download one vault’s “${VAULT_DIR}” folder at a time.`);
    root = rings[0].path.slice(0, -KEYRING.length);
    if (!entries.some((e) => e.path === `${root}${INDEX}`)) {
      throw new LocalError('no-vault', `The vault file (${INDEX}) isn’t in ${inThose}. Download the whole “${VAULT_DIR}” folder again.`);
    }
  }
  const vault = await readText(entries.find((e) => e.path === `${root}${INDEX}`));
  let envelope;
  try {
    envelope = parseEnvelope(vault);
  } catch (err) {
    if (err?.code === 'moved') throw new LocalError('moved', `${manifestEntry ? 'That backup' : 'That download'} holds only a note that its vault moved to another place, not the vault itself.`);
    throw err?.code === 'other-version' ? otherVersion() : notBackup();
  }
  const keyring = await readText(entries.find((e) => e.path === `${root}${KEYRING}`));
  if (!manifestEntry) {
    let doc;
    try {
      doc = parseKeyring(keyring);
    } catch {
      throw notBackup();
    }
    if (doc.kid !== envelope.kid) throw new LocalError('mismatch', 'Its key ring and its vault belong to different master keys.');
    manifest = { kid: doc.kid };
  }
  // The encrypted copies, by name: in “Encrypted files” next to the key ring in a backup; in any
  // “Encrypted files” folder of a download (every part of a split one, or that folder downloaded alone).
  const copies = new Map();
  for (const entry of entries) {
    const name = copyName(entry.path);
    if (name && !copies.has(name) && (!manifestEntry || entry.path === `${FILES}/${name}`)) copies.set(name, entry);
  }
  return { from, manifest, keyring, vault, blob: (name) => copies.get(name) || null, names: () => [...copies.keys()] };
}

/** The name of the encrypted copy at `path` in a ZIP (“…/Encrypted files/<name>”), or ''. */
function copyName(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  return parts.at(-2) === FILES && isBlobName(name) ? name : '';
}
