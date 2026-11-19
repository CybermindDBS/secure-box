/**
 * Vault format, encryption envelope, item model and CSV import/export.
 *
 * Key hierarchy
 *   master key  32 random bytes, kept only in wrapped form in the key ring (see keyring.js)
 *   vault key   HKDF-SHA-256(master key, fresh random salt, "unibox/vault-encryption/v1")
 *               -> AES-256-GCM. A brand-new key is derived for every save.
 *   file keys   32 random bytes per file, kept inside the encrypted vault (see fileformat.js)
 *
 * The stored vault only ever contains the envelope below; plaintext and keys never leave
 * the browser.
 */
import { decryptAesGcm, deriveAesKey, encryptAesGcm, fromBase64, fromUtf8, importHkdfKey, padme, randomBytes, toBase64, utf8 } from './crypto.js';

const VAULT_FORMAT = 'unibox-vault';
const VAULT_VERSION = 2;
const HKDF_INFO = 'unibox/vault-encryption/v1';

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
export function parseEnvelope(text, format = VAULT_FORMAT) {
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new VaultError('bad-vault', 'The vault file is not valid JSON.');
  }
  if (!env || env.format !== format) throw new VaultError('bad-vault', 'The file is not a Secure Box vault.');
  if (env.version !== 1 && env.version !== 2) throw new VaultError('bad-vault', 'This vault was written by a newer version of Secure Box.');
  for (const field of ['kid', 'salt', 'iv', 'ct']) {
    if (typeof env[field] !== 'string' || !env[field]) throw new VaultError('bad-vault', 'The vault file is incomplete.');
  }
  return env;
}

// Binds the header (format, version, key id, salt) to the ciphertext, so swapping any of it is detected.
const aadFor = (format, version, kid, salt) => utf8(`${format}:${version}:${kid}:${salt}`);

/** The local vault's index (localstore.js) uses its own format and key, so it can't pass for the vault. */
export const LOCAL_INDEX = { format: 'secure-box-local-index', info: 'secure-box/local-index/v1' };

export class VaultCipher {
  /** Holds only a non-extractable HKDF handle to the master key. */
  static async create(master, purpose = { format: VAULT_FORMAT, info: HKDF_INFO }) {
    return new VaultCipher(master.kid, await importHkdfKey(master.key), purpose);
  }

  constructor(kid, baseKey, purpose = { format: VAULT_FORMAT, info: HKDF_INFO }) {
    this.kid = kid;
    this.baseKey = baseKey;
    this.format = purpose.format;
    this.info = purpose.info;
  }

  async seal(data) {
    // Fresh salt => a brand-new AES-256 key for every save, so nonce limits never come into play.
    const salt = randomBytes(16);
    const key = await deriveAesKey(this.baseKey, salt, this.info);
    const saltText = toBase64(salt);
    const json = utf8(JSON.stringify(data));
    // Pad with spaces (valid trailing JSON whitespace) to a Padmé length, so the size leaks little.
    const padded = new Uint8Array(padme(json.length)).fill(0x20);
    padded.set(json);
    const { iv, ciphertext } = await encryptAesGcm(key, padded, aadFor(this.format, VAULT_VERSION, this.kid, saltText));
    return JSON.stringify({
      format: this.format,
      version: VAULT_VERSION,
      kid: this.kid,
      salt: saltText,
      iv: toBase64(iv),
      ct: toBase64(ciphertext),
    });
  }

  async open(env) {
    if (env.format !== this.format) throw new VaultError('bad-vault', 'The file is not a Secure Box vault.');
    if (env.kid !== this.kid) throw new VaultError('wrong-key', 'This key does not belong to the vault.');
    let plain;
    try {
      const key = await deriveAesKey(this.baseKey, fromBase64(env.salt), this.info);
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
    driveId: raw.driveId,
    key: raw.key,
    chunk: raw.chunk,
    thumbBytes: Number.isInteger(raw.thumbBytes) && raw.thumbBytes > 0 ? raw.thumbBytes : 0,
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}

const validFile = (f) =>
  f && isId(f.id) && typeof f.driveId === 'string' && f.driveId && typeof f.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(f.key) &&
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
// Folders and files (the encrypted index of what is stored in Google Drive)
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
  if (!taken.has(name.toLowerCase())) return name;
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Folders from the top level down to `folderId` (inclusive). */
export function folderChain(vault, folderId) {
  const byId = new Map(vault.folders.map((f) => [f.id, f]));
  const chain = [];
  for (let cursor = folderId; cursor && byId.has(cursor); cursor = byId.get(cursor).parent) {
    chain.unshift(byId.get(cursor));
    if (chain.length > 256) break;
  }
  return chain;
}

/** Every folder and file inside `folderId`, at any depth (the folder itself included). */
export function collectTree(vault, folderId) {
  const folderIds = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of vault.folders) {
      if (f.parent && folderIds.has(f.parent) && !folderIds.has(f.id)) {
        folderIds.add(f.id);
        grew = true;
      }
    }
  }
  const files = vault.files.filter((f) => f.folder && folderIds.has(f.folder));
  return { folderIds: [...folderIds], files };
}

/** Changes are replayed on top of the latest stored vault when another device saved first. */
export function applyChange(vault, change) {
  switch (change.op) {
    case 'put':
      return { ...vault, items: vault.items.filter((it) => it.id !== change.item.id).concat(change.item) };
    case 'delete':
      return { ...vault, items: vault.items.filter((it) => it.id !== change.id) };
    case 'folder-put':
      return { ...vault, folders: vault.folders.filter((f) => f.id !== change.folder.id).concat(change.folder) };
    case 'file-put':
      return { ...vault, files: vault.files.filter((f) => f.id !== change.file.id).concat(change.file) };
    case 'remove': {
      const folders = new Set(change.folders || []);
      const files = new Set(change.files || []);
      return { ...vault, folders: vault.folders.filter((f) => !folders.has(f.id)), files: vault.files.filter((f) => !files.has(f.id)) };
    }
    case 'batch':
      return change.changes.reduce((acc, next) => applyChange(acc, next), vault);
    case 'import': {
      const seen = new Set(vault.items.map(fingerprint));
      const fresh = change.items.filter((it) => {
        const key = fingerprint(it);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...vault, items: vault.items.concat(fresh) };
    }
    default:
      throw new Error(`Unknown change: ${change.op}`);
  }
}

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
