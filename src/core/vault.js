/**
 * Vault format, encryption envelope, item model and CSV import/export.
 *
 * Key hierarchy
 *   master key  32 random bytes, kept only in wrapped form in the key ring (see keyring.js)
 *   vault key   HKDF-SHA-256(master key, fresh random salt, "secure-box/vault-encryption/v1")
 *               -> AES-256-GCM. A brand-new key is derived for every save.
 *   file keys   32 random bytes per file, kept inside the encrypted vault (see fileformat.js)
 *
 * The stored vault only ever contains the envelope below; plaintext and keys never leave
 * the browser.
 */
import { decryptAesGcm, deriveAesKey, encryptAesGcm, fromBase64, fromUtf8, importHkdfKey, padme, randomBytes, toBase64, utf8 } from './crypto.js';

// One vault format for every place (Google Drive, OneDrive, this device): a vault's file can move
// from one to another exactly as it is.
const VAULT_FORMAT = 'secure-box-vault';
const VAULT_VERSION = 3;
const HKDF_INFO = 'secure-box/vault-encryption/v1';

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Encrypted envelope
// ---------------------------------------------------------------------------
export function parseEnvelope(text) {
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new VaultError('bad-vault', 'The vault file is not valid JSON.');
  }
  // The vault moved away from here: the note says where to (see movedNote below).
  if (env?.format === MOVED_FORMAT) throw Object.assign(new VaultError('moved', 'This vault was moved to another place, so nothing more can be saved here.'), { note: movedNote(text) });
  // Intact, but in a format this version doesn't read (Secure Box is still changing its formats).
  const otherVersion = () => new VaultError('other-version', 'This vault was made by another version of Secure Box, so this one can’t open it.');
  if (env?.format !== VAULT_FORMAT) throw typeof env?.format === 'string' && env.format.startsWith('secure-box-') ? otherVersion() : new VaultError('bad-vault', 'The file is not a Secure Box vault.');
  if (env.version !== VAULT_VERSION) throw env.version > VAULT_VERSION ? new VaultError('bad-vault', 'This vault was written by a newer version of Secure Box.') : otherVersion();
  for (const field of ['kid', 'salt', 'iv', 'ct']) {
    if (typeof env[field] !== 'string' || !env[field]) throw new VaultError('bad-vault', 'The vault file is incomplete.');
  }
  return env;
}

// Binds the header (format, version, key id, salt) to the ciphertext, so swapping any of it is detected.
const aadFor = (format, version, kid, salt) => utf8(`${format}:${version}:${kid}:${salt}`);

// The same names in every place a vault lives (Google Drive, OneDrive, this device), so a vault
// looks the same wherever you find it: the key ring, the vault, and a folder of encrypted files.
export const VAULT_FILE_NAME = 'Secure Box Vault.json';
export const FILES_FOLDER = 'Encrypted files';

export class VaultCipher {
  /** Holds only a non-extractable HKDF handle to the master key. */
  static async create(master) {
    return new VaultCipher(master.kid, await importHkdfKey(master.key));
  }

  constructor(kid, baseKey) {
    this.kid = kid;
    this.baseKey = baseKey;
  }

  async seal(data) {
    // Fresh salt => a brand-new AES-256 key for every save, so nonce limits never come into play.
    const salt = randomBytes(16);
    const key = await deriveAesKey(this.baseKey, salt, HKDF_INFO);
    const saltText = toBase64(salt);
    const json = utf8(JSON.stringify(data));
    // Pad with spaces (valid trailing JSON whitespace) to a Padmé length, so the size leaks little.
    const padded = new Uint8Array(padme(json.length)).fill(0x20);
    padded.set(json);
    const { iv, ciphertext } = await encryptAesGcm(key, padded, aadFor(VAULT_FORMAT, VAULT_VERSION, this.kid, saltText));
    return JSON.stringify({
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      kid: this.kid,
      salt: saltText,
      iv: toBase64(iv),
      ct: toBase64(ciphertext),
    });
  }

  async open(env) {
    if (env.format !== VAULT_FORMAT) throw new VaultError('bad-vault', 'The file is not a Secure Box vault.');
    if (env.kid !== this.kid) throw new VaultError('wrong-key', 'This key does not belong to the vault.');
    let plain;
    try {
      const key = await deriveAesKey(this.baseKey, fromBase64(env.salt), HKDF_INFO);
      plain = await decryptAesGcm(key, fromBase64(env.iv), fromBase64(env.ct), aadFor(env.format, env.version, env.kid, env.salt));
    } catch {
      throw new VaultError('decrypt-failed', 'The vault could not be decrypted: the key does not match or the data was altered.');
    }
    return normalizeVault(JSON.parse(fromUtf8(plain)));
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
const LIMITS = { title: 200, username: 500, password: 1000, url: 2048, notes: 50000 };

const text = (value, max) => (typeof value === 'string' ? value : value == null ? '' : String(value)).slice(0, max);
const newId = () => globalThis.crypto.randomUUID();

export function emptyVault() {
  return { schema: 2, items: [], folders: [], files: [] };
}

function cleanItem(raw) {
  const type = raw.type === 'note' ? 'note' : 'login';
  const login = type === 'login';
  const now = Date.now();
  return {
    id: raw.id,
    type,
    title: text(raw.title, LIMITS.title) || 'Untitled',
    username: login ? text(raw.username, LIMITS.username) : '',
    password: login ? text(raw.password, LIMITS.password) : '',
    url: login ? text(raw.url, LIMITS.url) : '',
    notes: text(raw.notes, LIMITS.notes),
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}

const cleanName = (value) => text(value, 255).replace(/[\u0000-\u001f\u007f]/g, '').trim();
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;
const BLOB_NAME = /^[0-9a-f-]{36}$/i;

// ---------------------------------------------------------------------------
// Two vaults made one (moving a vault into a place that already has one)
// ---------------------------------------------------------------------------
const changedLater = (a, b) => (b.updated || 0) > (a.updated || 0);

/**
 * What `there` (the vault at the place this one is going) has that `here` doesn't: items,
 * folders and files only it has, and ones both have that it changed later. All zero: it's an
 * earlier copy of `here`, which `here` simply brings up to date.
 */
export function compareVaults(there, here) {
  const count = (kind) => {
    const mine = new Map(here[kind].map((x) => [x.id, x]));
    let only = 0;
    let newer = 0;
    for (const x of there[kind]) {
      const own = mine.get(x.id);
      if (!own) only++;
      else if (changedLater(own, x)) newer++;
    }
    return { only, newer };
  };
  const items = count('items');
  const folders = count('folders');
  const files = count('files');
  return {
    onlyThere: { items: items.only, folders: folders.only, files: files.only },
    newerThere: { items: items.newer, folders: folders.newer, files: files.newer },
    earlierCopy: !items.only && !folders.only && !files.only && !items.newer && !folders.newer && !files.newer,
  };
}

/**
 * `base` (the vault already at a place) and `incoming` (the one arriving) made one, so nothing in
 * either is lost. Something both have (one was copied from the other once: the same id) keeps
 * whichever version was changed last. A folder with the same name in the same place as one
 * already there becomes that one, like folders merged in a file manager; files whose names clash
 * there are renamed ("Report (2).pdf"). The list of copies to delete is `base`'s.
 */
export function mergeVaults(base, incoming) {
  const items = new Map(base.items.map((it) => [it.id, it]));
  for (const it of incoming.items) if (!items.has(it.id) || changedLater(items.get(it.id), it)) items.set(it.id, it);

  // Folders, parents first, so each one's place is known before its own folders come.
  const folders = new Map(base.folders.map((f) => [f.id, { ...f }]));
  const became = new Map(); // an incoming folder's id -> the id of the folder it's now part of
  const placeOf = (id) => (id ? (became.get(id) ?? (folders.has(id) ? id : null)) : null);
  const fromIncoming = new Set();
  // A folder by where it is and its name, to find one with the same name in the same place.
  const spot = (parent, name) => `${parent ?? ''}/${name.toLowerCase()}`;
  const bySpot = new Map();
  for (const f of folders.values()) if (!bySpot.has(spot(f.parent, f.name))) bySpot.set(spot(f.parent, f.name), f.id);
  const setFolder = (f) => {
    const before = folders.get(f.id);
    if (before && bySpot.get(spot(before.parent, before.name)) === f.id) bySpot.delete(spot(before.parent, before.name));
    folders.set(f.id, f);
    if (!bySpot.has(spot(f.parent, f.name))) bySpot.set(spot(f.parent, f.name), f.id);
  };
  const pending = new Map(incoming.folders.map((f) => [f.id, f]));
  const visit = (f) => {
    pending.delete(f.id);
    if (f.parent && pending.has(f.parent)) visit(pending.get(f.parent));
    const parent = placeOf(f.parent);
    const have = folders.get(f.id);
    if (have) {
      became.set(f.id, f.id);
      if (changedLater(have, f)) {
        setFolder({ ...f, parent });
        fromIncoming.add(f.id);
      }
      return;
    }
    const twin = bySpot.get(spot(parent, f.name));
    if (twin) {
      became.set(f.id, twin);
      return;
    }
    setFolder({ ...f, parent });
    became.set(f.id, f.id);
    fromIncoming.add(f.id);
  };
  while (pending.size) visit(pending.values().next().value);

  const files = new Map(base.files.map((f) => [f.id, f]));
  for (const f of incoming.files) {
    const have = files.get(f.id);
    if (have && !changedLater(have, f)) continue;
    files.set(f.id, { ...f, folder: placeOf(f.folder) });
    fromIncoming.add(f.id);
  }

  // What came in keeps clear of the names already beside it.
  const rename = (list, keyOf, isFolder) => {
    const taken = new Map(); // where -> the names there, lowercased
    const counters = new Map(); // where -> how far each name's numbering got
    const namesAt = (x) => taken.get(keyOf(x)) || taken.set(keyOf(x), new Set()).get(keyOf(x));
    for (const x of list) if (!fromIncoming.has(x.id)) namesAt(x).add(x.name.toLowerCase());
    for (const x of list) {
      if (!fromIncoming.has(x.id)) continue;
      const names = namesAt(x);
      const numbering = counters.get(keyOf(x)) || counters.set(keyOf(x), new Map()).get(keyOf(x));
      x.name = uniqueNameWhere(x.name, (lower) => names.has(lower), { isFolder, counters: numbering });
      names.add(x.name.toLowerCase());
    }
  };
  const folderList = [...folders.values()];
  const fileList = [...files.values()].map((f) => ({ ...f }));
  rename(folderList, (f) => f.parent ?? '', true);
  rename(fileList, (f) => f.folder ?? '', false);
  repairTree(folderList, fileList);
  const inUse = new Set(fileList.map((f) => f.blob));
  return { ...base, items: [...items.values()], folders: folderList, files: fileList, trash: (base.trash || []).filter((name) => !inUse.has(name)) };
}

// ---------------------------------------------------------------------------
// Where a vault was moved away from: a short note in place of the vault
// ---------------------------------------------------------------------------
// Left in the old place when a vault moves away from a cloud (migrate.js), so another device
// that still looks there learns where it went, rather than finding it "deleted". It holds only
// that: the place it went to (google, microsoft, local) and when.
const MOVED_FORMAT = 'secure-box-moved';

export const movedNoteText = (to, at = new Date()) => JSON.stringify({ format: MOVED_FORMAT, version: 1, to, at: at.toISOString() });

/** The note's { to, at }, if `text` is one. */
export function movedNote(text) {
  try {
    const note = JSON.parse(text);
    return note?.format === MOVED_FORMAT && typeof note.to === 'string' ? { to: note.to, at: Date.parse(note.at) || 0 } : null;
  } catch {
    return null;
  }
}

function cleanFolder(raw) {
  const now = Date.now();
  return {
    id: raw.id,
    name: cleanName(raw.name) || 'Untitled folder',
    parent: isId(raw.parent) ? raw.parent : null,
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}

function cleanFile(raw) {
  const now = Date.now();
  return {
    id: raw.id,
    name: cleanName(raw.name) || 'Untitled file',
    type: text(raw.type, 200),
    size: raw.size,
    folder: isId(raw.folder) ? raw.folder : null,
    // The name its encrypted copy is stored under, the same in every place (never a place's own
    // file id): the file's own id, or a new name once it was saved again (an edited text file).
    blob: raw.blob,
    key: raw.key,
    chunk: raw.chunk,
    thumbBytes: Number.isInteger(raw.thumbBytes) && raw.thumbBytes > 0 ? raw.thumbBytes : 0,
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}

/** A stored copy's name: a random id, so the same in every place and safe in any query or path. */
export const isBlobName = (name) => typeof name === 'string' && BLOB_NAME.test(name);

const validFile = (f) =>
  f && isId(f.id) && isBlobName(f.blob) && typeof f.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(f.key) &&
  Number.isSafeInteger(f.size) && f.size >= 0 && Number.isSafeInteger(f.chunk) && f.chunk > 0;

/** Re-homes anything whose parent folder is missing, and breaks accidental cycles. */
function repairTree(folders, files) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (const folder of folders) {
    if (folder.parent && !byId.has(folder.parent)) folder.parent = null;
    const seen = new Set([folder.id]);
    for (let cursor = folder.parent; cursor; cursor = byId.get(cursor)?.parent ?? null) {
      if (seen.has(cursor)) {
        folder.parent = null;
        break;
      }
      seen.add(cursor);
    }
  }
  for (const file of files) if (file.folder && !byId.has(file.folder)) file.folder = null;
}

function normalizeVault(data) {
  if (!data || !Array.isArray(data.items)) {
    throw new VaultError('bad-vault', 'The vault contents are not in the expected format.');
  }
  const { items, folders, files, schema, ...unknown } = data; // keep fields from newer versions intact
  const cleanFolders = (Array.isArray(folders) ? folders : []).filter((f) => f && isId(f.id)).map(cleanFolder);
  const cleanFiles = (Array.isArray(files) ? files : []).filter(validFile).map(cleanFile);
  repairTree(cleanFolders, cleanFiles);
  return {
    ...unknown,
    schema: 2,
    items: items.filter((it) => it && typeof it.id === 'string' && it.id).map(cleanItem),
    folders: cleanFolders,
    files: cleanFiles,
  };
}

/** Build a new item, or the next version of `previous`, from editor fields. */
export function makeItem(fields, previous = null) {
  const now = Date.now();
  const type = fields.type === 'note' ? 'note' : 'login';
  const login = type === 'login';
  const url = login ? text(fields.url, LIMITS.url).trim() : '';
  const username = login ? text(fields.username, LIMITS.username).trim() : '';
  let title = text(fields.title, LIMITS.title).trim();
  if (!title) title = hostnameOf(url) || username || (login ? 'Untitled login' : 'Untitled note');
  return {
    id: previous?.id || newId(),
    type,
    title,
    username,
    password: login ? text(fields.password, LIMITS.password) : '',
    url,
    notes: text(fields.notes, LIMITS.notes),
    created: previous?.created || now,
    updated: now,
  };
}

const fingerprint = (it) => JSON.stringify([it.type, it.title, it.username, it.password, it.url, it.notes]);

// ---------------------------------------------------------------------------
// Folders and files (each file's encrypted copy is stored under its `blob` name)
// ---------------------------------------------------------------------------
export function makeFolder({ name, parent = null }, previous = null) {
  const now = Date.now();
  return {
    id: previous?.id || newId(),
    name: cleanName(name) || 'Untitled folder',
    parent: parent ?? null,
    created: previous?.created || now,
    updated: now,
  };
}

export function makeFileEntry(fields, previous = null) {
  const now = Date.now();
  return cleanFile({ ...previous, ...fields, id: previous?.id || fields.id || newId(), created: previous?.created || now, updated: now });
}

/** "Report.pdf" -> "Report (2).pdf" when the name is already taken in that folder. */
export function uniqueName(name, takenNames, { isFolder = false } = {}) {
  const taken = new Set([...takenNames].map((n) => n.toLowerCase()));
  return uniqueNameWhere(name, (lower) => taken.has(lower), { isFolder });
}

/**
 * uniqueName, asking `isTaken(lowercased name)` instead of going through a list of names.
 * `counters` (a Map, for one folder) remembers where the numbering of each name got to, so
 * thousands of files with one name don't each count up from 2 again. Every number up to where
 * it got to must stay taken: forget the counters when a name leaves that folder.
 */
export function uniqueNameWhere(name, isTaken, { isFolder = false, counters = null } = {}) {
  if (!isTaken(name.toLowerCase())) return name;
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const key = `${base}\u0000${ext}`.toLowerCase();
  for (let n = (counters?.get(key) ?? 1) + 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate.toLowerCase())) {
      counters?.set(key, n);
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Finding things in a big vault
// ---------------------------------------------------------------------------
// A vault is never changed in place (each change makes a new one), so what's worked out about one
// holds for as long as it's around: its files and folders by id, what each folder holds, and how
// much is inside each folder at any depth. It's worked out once, the first time it's needed, so
// thousands of files cost one pass instead of one pass per question.
const indexes = new WeakMap();
const NONE = Object.freeze([]);

function listIn(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * { files, folders } (Maps by id), foldersIn(id) and filesIn(id) (what a folder holds directly;
 * null: the top level), and totals(id) = { folders, files, bytes } inside a folder at any depth.
 */
export function vaultIndex(vault) {
  let index = indexes.get(vault);
  if (index) return index;
  const files = new Map();
  const folders = new Map();
  const foldersAt = new Map();
  const filesAt = new Map();
  for (const f of vault.folders) {
    if (folders.has(f.id)) continue;
    folders.set(f.id, f);
    listIn(foldersAt, f.parent ?? null, f);
  }
  for (const f of vault.files) {
    if (files.has(f.id)) continue;
    files.set(f.id, f);
    listIn(filesAt, f.folder ?? null, f);
  }
  const foldersIn = (id) => foldersAt.get(id ?? null) || NONE;
  const filesIn = (id) => filesAt.get(id ?? null) || NONE;
  /** Folder `id` and every folder inside it, at any depth, each once, with their files. */
  const walk = (id) => {
    const folderIds = [id];
    const inside = [];
    if (!id) return { folderIds, files: inside };
    const seen = new Set(folderIds);
    for (let i = 0; i < folderIds.length; i++) {
      inside.push(...filesIn(folderIds[i]));
      for (const sub of foldersIn(folderIds[i])) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        folderIds.push(sub.id);
      }
    }
    return { folderIds, files: inside };
  };
  const sums = new Map();
  const totals = (id) => {
    let sum = sums.get(id);
    if (!sum) {
      const tree = walk(id);
      sum = { folders: tree.folderIds.length - 1, files: tree.files.length, bytes: tree.files.reduce((n, f) => n + f.size, 0) };
      sums.set(id, sum);
    }
    return sum;
  };
  index = { files, folders, foldersIn, filesIn, totals, walk };
  indexes.set(vault, index);
  return index;
}

/** Folders from the top level down to `folderId` (inclusive). */
export function folderChain(vault, folderId) {
  const { folders } = vaultIndex(vault);
  const chain = [];
  for (let cursor = folderId; cursor && folders.has(cursor); cursor = folders.get(cursor).parent) {
    chain.unshift(folders.get(cursor));
    if (chain.length > 256) break;
  }
  return chain;
}

/** Every folder and file inside `folderId`, at any depth (the folder itself included). */
export const collectTree = (vault, folderId) => vaultIndex(vault).walk(folderId);

/** The names of the encrypted copies the vault's files use. */
export const copiesInUse = (vault) => new Set(vault.files.map((f) => f.blob));

/**
 * Changes are replayed on top of the latest stored vault when another device saved first, so a
 * change to something already there names only what changed ('item-update', 'file-update',
 * 'folder-update'): it applies to that thing as it is now, never to a copy of it from before.
 * A batch (thousands of files uploaded or moved at once) is applied in one pass: each change in
 * it finds what it needs by id and by name instead of going through the whole vault again.
 */
export function applyChange(vault, change) {
  const draft = new Draft(vault);
  draft.apply(change);
  return draft.result();
}

/**
 * Keeps how many things in each folder have each name (lowercased): parent -> name -> count. A
 * name leaving a folder makes its numbering counters (uniqueNameWhere) start over.
 */
function countName(counts, key, name, by, counters) {
  let names = counts.get(key);
  if (!names) counts.set(key, (names = new Map()));
  const lower = name.toLowerCase();
  const n = (names.get(lower) || 0) + by;
  if (n > 0) names.set(lower, n);
  else names.delete(lower);
  if (by < 0) counters?.delete(key);
}

/** A vault being changed: what a change touches is copied once, changed in place, and put back at the end. */
class Draft {
  constructor(vault) {
    this.vault = vault;
    this.touched = new Set(); // 'items' | 'folders' | 'files' | 'trash'
  }

  /** id -> thing, in the vault's order (the first of any repeated id). */
  byId(kind) {
    const key = `_${kind}`;
    if (!this[key]) {
      const map = new Map();
      for (const x of this.vault[kind]) if (!map.has(x.id)) map.set(x.id, x);
      this[key] = map;
    }
    return this[key];
  }

  /** Name counts per folder for `kind` ('folders' by parent, 'files' by folder), made when first needed. */
  names(kind) {
    const key = `_${kind}Names`;
    if (!this[key]) {
      const counts = new Map();
      for (const x of this.byId(kind).values()) countName(counts, placeOf(kind, x), x.name, 1);
      this[key] = counts;
    }
    return this[key];
  }

  /** Puts `next` where `previous` (if any) was, or at the end, keeping the name counts right. */
  place(kind, previous, next, { last = false } = {}) {
    const map = this.byId(kind);
    const counts = this[`_${kind}Names`];
    if (previous) {
      if (counts) countName(counts, placeOf(kind, previous), previous.name, -1, this.counters(kind));
      if (last) map.delete(previous.id);
    }
    map.set(next.id, next);
    if (counts) countName(counts, placeOf(kind, next), next.name, 1);
    this.touched.add(kind);
  }

  drop(kind, id) {
    const map = this.byId(kind);
    const previous = map.get(id);
    if (!previous) return;
    const counts = this[`_${kind}Names`];
    if (counts) countName(counts, placeOf(kind, previous), previous.name, -1, this.counters(kind));
    map.delete(id);
    this.touched.add(kind);
  }

  /** Where the numbering of names got to, per folder (uniqueNameWhere): parent -> name -> number. */
  counters(kind) {
    return (this[`_${kind}Counters`] ??= new Map());
  }

  /** `name`, or "name (2)" and so on, kept apart from the others at `where` (`self` aside). */
  freeName(kind, name, where, self) {
    const at = where ?? null;
    const here = this.names(kind).get(at);
    const mine = placeOf(kind, self) === at ? self.name.toLowerCase() : null;
    // Counting on from where the numbering got to holds only while every number up to it is
    // taken: not when the name being changed is one of them.
    const all = this.counters(kind);
    const counters = mine ? null : all.get(at) || all.set(at, new Map()).get(at);
    return uniqueNameWhere(name, (lower) => (here?.get(lower) || 0) - (lower === mine ? 1 : 0) > 0, { isFolder: kind === 'folders', counters });
  }

  /** Is folder `id` inside folder `root` at any depth (or `root` itself)? */
  inside(id, root) {
    const folders = this.byId('folders');
    for (let cursor = id, steps = 0; cursor && steps <= folders.size; cursor = folders.get(cursor)?.parent, steps++) {
      if (cursor === root) return true;
    }
    return false;
  }

  /** The list of copies to delete, as a Set; null when the vault has none and `create` is false. */
  trash(create = false) {
    if (!this._trash && (create || this.vault.trash)) this._trash = new Set(this.vault.trash || []);
    return this._trash || null;
  }

  /** A copy a file uses again (a restore, a change from elsewhere) comes off the list of copies to delete. */
  keepCopy(name) {
    const trash = this.trash();
    if (trash?.delete(name)) this.touched.add('trash');
  }

  apply(change) {
    switch (change.op) {
      case 'put': {
        const items = this.byId('items');
        this.place('items', items.get(change.item.id), change.item, { last: true });
        return;
      }
      case 'item-update': {
        // The fields that were edited (`fields`), over another device's edits to the others meanwhile.
        // Deleted elsewhere meanwhile: the edited item (`item`) comes back, so nothing typed is lost.
        const current = this.byId('items').get(change.item.id);
        if (!current) return this.place('items', null, change.item);
        return this.place('items', current, cleanItem({ ...current, ...change.fields, updated: change.item.updated }));
      }
      case 'delete':
        return this.drop('items', change.id);
      case 'folder-put':
        return this.place('folders', this.byId('folders').get(change.folder.id), change.folder, { last: true });
      case 'folder-update': {
        // A rename or move. One deleted meanwhile stays deleted; one moved into a folder deleted
        // meanwhile goes to the top; a move into itself (after another move meanwhile) is left out.
        const folders = this.byId('folders');
        const current = folders.get(change.id);
        if (!current) return;
        const fields = { ...change.fields };
        if (fields.parent && !folders.has(fields.parent)) fields.parent = null;
        if (fields.parent && this.inside(fields.parent, current.id)) return;
        if ('name' in fields || 'parent' in fields) {
          const parent = 'parent' in fields ? fields.parent : current.parent;
          fields.name = this.freeName('folders', fields.name ?? current.name, parent, current);
        }
        return this.place('folders', current, cleanFolder({ ...current, ...fields }));
      }
      case 'file-put': {
        // A folder deleted meanwhile (in another window or device): the file lands in All files.
        const lost = change.file.folder && !this.byId('folders').has(change.file.folder);
        const file = lost ? { ...change.file, folder: null } : change.file;
        this.place('files', this.byId('files').get(file.id), file, { last: true });
        return this.keepCopy(file.blob);
      }
      case 'file-update': {
        // A rename, a move, or a saved edit (a new encrypted copy). One deleted meanwhile stays
        // deleted, unless the change brings the whole file back (`orAdd`: a saved edit, so what was
        // typed isn't lost). `ifBlob`: only while its copy is still that one, so an edit saved
        // elsewhere meanwhile is never replaced (the editor then asks what to do).
        const current = this.byId('files').get(change.id);
        if (!current) return change.orAdd ? this.apply({ op: 'file-put', file: change.orAdd }) : undefined;
        if (change.ifBlob && current.blob !== change.ifBlob) return;
        const fields = { ...change.fields };
        if (fields.folder && !this.byId('folders').has(fields.folder)) fields.folder = null;
        if ('name' in fields || 'folder' in fields) {
          const folder = 'folder' in fields ? fields.folder : current.folder;
          fields.name = this.freeName('files', fields.name ?? current.name, folder, current);
        }
        const file = cleanFile({ ...current, ...fields });
        this.place('files', current, file);
        return this.keepCopy(file.blob);
      }
      case 'remove':
        for (const id of change.folders || []) this.drop('folders', id);
        for (const id of change.files || []) this.drop('files', id);
        this.touched.add('folders').add('files');
        return;
      case 'batch':
        for (const next of change.changes) this.apply(next);
        return;
      // Encrypted copies that couldn't be deleted yet (offline, say), by name: kept here, inside the
      // encrypted vault, and tried again on a later sync from any device.
      case 'trash-add': {
        const inUse = new Set([...this.byId('files').values()].map((f) => f.blob)); // never one a file uses (it may have come back meanwhile)
        const trash = this.trash(true);
        for (const name of change.names) if (!inUse.has(name)) trash.add(name);
        this.touched.add('trash');
        return;
      }
      case 'trash-done': {
        const trash = this.trash(true);
        for (const name of change.names) trash.delete(name);
        this.touched.add('trash');
        return;
      }
      case 'import': {
        const items = this.byId('items');
        const seen = new Set([...items.values()].map(fingerprint));
        for (const it of change.items) {
          const key = fingerprint(it);
          if (seen.has(key)) continue;
          seen.add(key);
          this.place('items', null, it);
        }
        this.touched.add('items');
        return;
      }
      default:
        throw new Error(`Unknown change: ${change.op}`);
    }
  }

  /** The changed vault: a new one when anything changed, with only what changed copied. */
  result() {
    if (!this.touched.size) return this.vault;
    const next = { ...this.vault };
    for (const kind of ['items', 'folders', 'files']) if (this.touched.has(kind)) next[kind] = [...this.byId(kind).values()];
    if (this.touched.has('trash')) next.trash = [...this.trash(true)];
    return next;
  }
}

/** Where a folder ('folders': its parent) or a file ('files': its folder) is; null at the top. */
const placeOf = (kind, x) => (kind === 'folders' ? x.parent : kind === 'files' ? x.folder : null) ?? null;

function parseLooseUrl(value) {
  if (!value) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

export function hostnameOf(value) {
  const url = parseLooseUrl(value);
  return url && /^https?:$/.test(url.protocol) ? url.hostname.replace(/^www\./, '') : '';
}

/** Only http(s) links are ever rendered as clickable. */
export function safeHref(value) {
  const url = parseLooseUrl(value);
  return url && /^https?:$/.test(url.protocol) && url.hostname ? url.href : null;
}

// ---------------------------------------------------------------------------
// CSV import / export (Chrome, Firefox, Bitwarden, 1Password, LastPass, ...)
// ---------------------------------------------------------------------------
export function parseCsv(input) {
  const src = input.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const CSV_COLUMNS = {
  title: ['name', 'title', 'account', 'item name', 'entry'],
  url: ['url', 'login_uri', 'uri', 'website', 'web site', 'login url', 'site'],
  username: ['username', 'login_username', 'user name', 'login name', 'login', 'user', 'email', 'e-mail'],
  password: ['password', 'login_password', 'pass'],
  notes: ['note', 'notes', 'extra', 'comments', 'comment'],
  type: ['type'],
};

export function itemsFromCsv(input) {
  const rows = parseCsv(input);
  if (rows.length < 2) throw new VaultError('bad-csv', 'The CSV file has no rows to import.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [field, names] of Object.entries(CSV_COLUMNS)) {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index >= 0) {
        col[field] = index;
        break;
      }
    }
  }
  if (col.password === undefined && col.username === undefined && col.notes === undefined) {
    throw new VaultError('bad-csv', 'No username, password or notes column found. Export a CSV from your old password manager and try again.');
  }
  const items = [];
  for (const row of rows.slice(1)) {
    const get = (field) => (col[field] === undefined ? '' : row[col[field]] ?? '');
    let url = get('url').trim();
    if (url === 'http://sn') url = ''; // LastPass marks secure notes this way
    const username = get('username');
    const password = get('password');
    const notes = get('notes');
    const declared = get('type').trim().toLowerCase();
    const isNote =
      ['note', 'securenote', 'secure note', 'secure_note'].includes(declared) || (!username && !password && !url && !!notes);
    if (!get('title').trim() && !username && !password && !url && !notes.trim()) continue;
    items.push(makeItem({ type: isNote ? 'note' : 'login', title: get('title'), username, password, url, notes }));
  }
  if (!items.length) throw new VaultError('bad-csv', 'The CSV file has no rows to import.');
  return items;
}

/** Chrome-compatible CSV (name,url,username,password,note) that every major password manager can import. */
export function itemsToCsv(items) {
  const cell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [['name', 'url', 'username', 'password', 'note']];
  for (const it of items) lines.push([it.title, it.url, it.username, it.password, it.notes]);
  return `${lines.map((line) => line.map((v) => cell(v ?? '')).join(',')).join('\r\n')}\r\n`;
}
