/**
 * The Encrypt & decrypt tab: .sbox files and messages, on this device, with or without a vault.
 *
 * Without a vault, a password protects what you encrypt (and is the only way to open it). With a
 * vault open, your account is always added (your master password opens it) and a password for
 * others is optional. Opening uses any key ring unlocked this session, a sharing password, or a
 * key ring backup. Nothing is uploaded.
 *
 * Where the browser allows it (Chrome and Edge on computers, Chrome on Android), results are
 * written straight into a folder you pick, a piece at a time. Elsewhere they're saved as
 * downloads, which means each result is assembled in memory first.
 */
import { generatePassword } from '../core/crypto.js';
import { formatBytes } from '../core/filetypes.js';
import { KeyringError, keyFileKind, parseKeyring, passwordProblem, unlockWithPassword, unlockWithRecovery } from '../core/keyring.js';
import { BOX_EXTENSION, boxAccess, openContent, readBox, unlockBox, writeBox, zipEntries, zipEntryData, zipFolder } from '../core/localbox.js';
import { looksLikeMessage, messageAccess, openMessage, readMessage, sealText } from '../core/textbox.js';
import { toast } from './bridge.js';
import { copyText, downloadFile } from './io.js';
import { setSection } from './nav.js';
import { pref, setPref } from './prefs.js';
import { createStore, pause, state } from './store.js';
import { runTask } from '../workers/pool.js';

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';
const percent = (p) => `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
let nextId = 0;
const newId = () => `t${++nextId}`;

/** A file or folder name that's valid on Windows, macOS and Linux. */
export function safeName(name, fallback = 'file') {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

const randomName = () => `${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}${BOX_EXTENSION}`;

/** A name not yet used in `dir`: "name", then "name (2).ext", "name (3).ext"… */
async function freeName(dir, name, kind = 'file') {
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    try {
      await (kind === 'file' ? dir.getFileHandle(candidate) : dir.getDirectoryHandle(candidate));
    } catch (err) {
      if (err.name === 'NotFoundError') return candidate;
      if (err.name !== 'TypeMismatchError') throw err; // a folder with that name, or the other way round
    }
  }
}

/** Writes one file into a picked folder; a failed write leaves nothing half-written behind. */
async function writeToFolder(dir, name, produce) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await produce((bytes) => writable.write(bytes));
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw err;
  }
}

async function collect(produce) {
  const parts = [];
  await produce((bytes) => {
    parts.push(bytes);
  });
  return new Blob(parts);
}

/** The folder results go into, where the browser lets a site write one; null for downloads. */
async function pickTarget(id) {
  if (!canPickFolder()) return null;
  try {
    return await window.showDirectoryPicker({ id, mode: 'readwrite', startIn: 'downloads' });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null; // not allowed here: fall back to downloads
  }
}

/** Unpacks a folder box into `target`. If anything fails, what was unpacked so far is removed. */
async function extractFolder(content, target, onProgress) {
  const entries = await zipEntries(content);
  const total = entries.reduce((n, e) => n + e.size, 0) || 1;
  let done = 0;
  const created = []; // what this run added to `target` itself
  const dirs = new Map([['', target]]);
  const dirFor = async (path) => {
    if (dirs.has(path)) return dirs.get(path);
    const cut = path.lastIndexOf('/');
    const parentPath = cut < 0 ? '' : path.slice(0, cut);
    const parent = await dirFor(parentPath);
    let name = safeName(path.slice(cut + 1), 'Folder');
    if (!parentPath) {
      name = await freeName(parent, name, 'dir'); // never merge into an existing folder
      created.push(name);
    }
    const handle = await parent.getDirectoryHandle(name, { create: true });
    dirs.set(path, handle);
    return handle;
  };
  try {
    for (const entry of entries) {
      const path = entry.path.replace(/\/$/, '');
      if (entry.dir) {
        await dirFor(path);
        continue;
      }
      const cut = path.lastIndexOf('/');
      const dir = await dirFor(cut < 0 ? '' : path.slice(0, cut));
      const name = await freeName(dir, safeName(path.slice(cut + 1)));
      if (dir === target) created.push(name);
      await writeToFolder(dir, name, async (write) => {
        for await (const bytes of zipEntryData(content, entry)) {
          await write(bytes);
          done += bytes.length;
          onProgress(done / total);
        }
      });
    }
  } catch (err) {
    for (const name of created) await target.removeEntry(name, { recursive: true }).catch(() => {});
    throw err;
  }
}

/** A key ring backup opens with its master password, or with its Emergency Kit's recovery key. */
async function unlockBackup(doc, secret) {
  try {
    return await unlockWithPassword(doc, secret);
  } catch (err) {
    if (!(err instanceof KeyringError)) throw err;
  }
  try {
    return await unlockWithRecovery(doc, secret);
  } catch {
    throw new Error('That master password or recovery key doesn’t open this key ring backup.');
  }
}

/** Every master key unlocked this session (the open vault's first). */
export function sessionKeys() {
  if (!state.unlocked) return [];
  const keys = new Map();
  if (state.master) keys.set(state.master.kid, state.master);
  for (const { master } of state.masters.values()) if (!keys.has(master.kid)) keys.set(master.kid, master);
  return [...keys.values()];
}

const keyFor = (box) => sessionKeys().find((master) => boxAccess(box, master).mine) || null;

// ===========================================================================
// State
// ===========================================================================
const blank = () => ({
  // Files: what to encrypt (files and folders) and what to open (.sbox files)
  jobs: [], // [{ id, kind: 'file', name, size, file } | { id, kind: 'folder', name, size, count, items }]
  boxes: [], // [{ id, file, box?, error?, failure? }]
  backup: null, // a key ring backup: { doc, name }
  busy: '', // 'encrypt' | 'open' | 'text' while working
  status: '', // progress
  error: '',
  done: null, // the last result: { kind: 'encrypt' | 'open', text, password }
  // Text
  text: '',
  textMode: 'encrypt', // 'encrypt' | 'decrypt'
  textOut: '',
  textOutSecret: false, // decrypted text: copies are wiped from the clipboard after 30 s
  textError: '',
  textErrorCode: '',
});

export const toolsStore = createStore({ mode: pref('toolsMode'), ...blank() });
const set = (patch) => toolsStore.set((s) => ({ ...s, ...patch }));
const get = () => toolsStore.get();
let controller = null;
let lastUse = Date.now();
const used = () => {
  lastUse = Date.now();
};

export const tools = {
  busy: () => Boolean(get().busy),
  /** Drops everything chosen, typed and decrypted here. */
  clear() {
    controller?.abort();
    toolsStore.set((s) => ({ mode: s.mode, ...blank() }));
  },
  /** Back from "Unlock your vault": a message waiting to be read opens now. */
  afterUnlock() {
    const s = get();
    if (s.textMode === 'decrypt' && s.text && !s.textOut) {
      try {
        if (sessionKeys().some((key) => messageAccess(readMessage(s.text), key).mine)) runText();
      } catch {
        /* shown when they press Decrypt */
      }
    }
  },
};

export function setToolsMode(mode) {
  set({ mode });
  setPref('toolsMode', mode);
}

/** Asked from the tab: unlock a vault, then come back here. */
export async function unlockForTools() {
  state.returnTo = 'tools';
  setSection('vault');
}

/** Stops whatever is running. */
export function stopTools() {
  controller?.abort();
}

// Everything here is cleared after the idle time without use, like a vault locks.
setInterval(() => {
  const s = get();
  const idle = Math.max(1, Number(state.config?.autoLockMinutes) || 10) * 60_000;
  const holding = s.jobs.length || s.boxes.length || s.text || s.textOut || s.backup || s.done;
  if (!s.busy && holding && Date.now() - lastUse > idle) {
    tools.clear();
    toast('Cleared the Encrypt & decrypt tab after a while without use.');
  }
}, 30_000);

// ===========================================================================
// Files: choosing
// ===========================================================================
/** Files dropped or chosen: .sbox files go to "Open", anything else to "Encrypt". */
export async function addFiles(list) {
  used();
  const jobs = [];
  const boxes = [];
  for (const file of list) {
    try {
      boxes.push({ id: newId(), file, box: await readBox(file) });
    } catch (err) {
      if (err?.code === 'not-box' && !file.name.toLowerCase().endsWith(BOX_EXTENSION)) jobs.push({ id: newId(), kind: 'file', name: file.name, size: file.size, file });
      else boxes.push({ id: newId(), file, error: err.message });
    }
  }
  const s = get();
  const known = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  const haveFiles = new Set(s.jobs.filter((j) => j.kind === 'file').map((j) => known(j.file)));
  const haveBoxes = new Set(s.boxes.map((b) => known(b.file)));
  set({
    jobs: [...s.jobs, ...jobs.filter((j) => !haveFiles.has(known(j.file)))],
    boxes: [...s.boxes, ...boxes.filter((b) => !haveBoxes.has(known(b.file)))],
    error: '',
    done: null,
  });
}

/**
 * A folder to encrypt as one .sbox: `files` with paths relative to the folder's parent
 * ("Photos/2024/a.jpg"). Names some systems can't store (a ":" from a Mac) are tidied.
 */
export function addFolder(name, files, paths) {
  used();
  const top = safeName(name, 'Folder');
  const clean = paths.map((p) => p.split('/').map((part) => safeName(part)).join('/'));
  const dirs = new Set();
  for (const path of clean) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const items = [...[...dirs].sort().map((path) => ({ path, dir: true })), ...files.map((file, i) => ({ path: clean[i], file })).sort((a, b) => (a.path < b.path ? -1 : 1))];
  const size = files.reduce((n, f) => n + f.size, 0);
  set({ jobs: [...get().jobs, { id: newId(), kind: 'folder', name: top, size, count: files.length, items }], error: '', done: null });
}

export function removeJob(id) {
  set({ jobs: get().jobs.filter((j) => j.id !== id), error: '' });
}

export function removeBox(id) {
  set({ boxes: get().boxes.filter((b) => b.id !== id), error: '' });
}

export function clearFiles() {
  set({ jobs: [], boxes: [], backup: null, error: '', status: '', done: null });
}

export const dismissDone = () => set({ done: null });

/** A key ring backup, to open files made with a vault that isn't open here. */
export async function chooseBackup(file) {
  if (!file) return;
  used();
  const text = await file.text();
  try {
    set({ backup: { doc: parseKeyring(text), name: file.name }, error: '', boxes: get().boxes.map((b) => ({ ...b, failure: '' })) });
  } catch (err) {
    set({
      backup: null,
      error: keyFileKind(text) === 'kit' ? 'That’s an Emergency Kit. Choose the key ring backup: the .json file saved with ⋯ → Key ring backup.' : `That isn’t a Secure Box key ring backup (${err.message})`,
    });
  }
}

export const dropBackup = () => set({ backup: null });

/** A strong sharing password, ready to copy. */
export function newSharingPassword() {
  return generatePassword({ length: 24 });
}

// ===========================================================================
// Files: how each one opens
// ===========================================================================
/**
 * How a chosen .sbox file will open (or why it didn't): { text, tone, needs } where needs is
 * '' | 'password' | 'vault' (a vault's key: unlock it, or use a key ring backup).
 */
export function boxStatus(entry, backup = get().backup) {
  if (entry.error) return { text: entry.error, tone: 'error', needs: '' };
  if (entry.failure) return { text: entry.failure, tone: 'error', needs: entry.failureNeeds || '' };
  const { box } = entry;
  if (keyFor(box)) return { text: 'Opens with your vault', tone: 'ok', needs: '' };
  if (backup && boxAccess(box, { kid: backup.doc.kid }).mine) return { text: 'Opens with your key ring backup', tone: 'ok', needs: '' };
  const access = boxAccess(box, null);
  if (access.password) return { text: 'Needs its password', tone: 'info', needs: 'password' };
  return { text: state.unlocked ? 'Made with another Secure Box vault' : 'Made with a Secure Box vault', tone: 'info', needs: 'vault' };
}

// ===========================================================================
// Files: encrypting
// ===========================================================================
/** Encrypts every chosen file and folder into .sbox files. Resolves when done (or stopped). */
export async function encryptJobs({ password = '', confirm = '', share = false, hideNames = pref('hideNames') }) {
  used();
  const { jobs } = get();
  if (!jobs.length) return set({ error: 'Choose files or a folder first.' });
  const master = state.unlocked ? state.master : null;
  const withPassword = !master || share;
  if (withPassword) {
    const problem = passwordProblem(password, confirm);
    if (problem) return set({ error: problem });
  }
  setPref('hideNames', hideNames);
  let target;
  try {
    target = await pickTarget('secure-box-encrypted');
  } catch {
    return undefined; // the folder picker was closed: nothing happens
  }
  controller = new AbortController();
  const { signal } = controller;
  set({ busy: 'encrypt', error: '', status: 'Starting…', done: null });
  let done = 0;
  try {
    for (const job of jobs) {
      const step = jobs.length > 1 ? `${done + 1} of ${jobs.length} · ` : '';
      let source = job.file;
      let meta = { kind: 'file', name: job.name, type: job.file?.type || '', mtime: job.file?.lastModified };
      if (job.kind === 'folder') {
        // Packing reads every file and computes its checksum: done in a worker (#21).
        source = await runTask('zipFolder', { items: job.items }, { onProgress: (p) => set({ status: `${step}Packing “${job.name}”… ${percent(p)}` }) });
        if (signal.aborted) throw new DOMException('Stopped.', 'AbortError');
        meta = { kind: 'folder', name: job.name, type: 'application/zip', mtime: Date.now(), files: job.count };
      }
      const name = hideNames ? randomName() : `${safeName(job.name)}${BOX_EXTENSION}`;
      const produce = (write) =>
        writeBox({ source, meta, master, password: withPassword ? password : '', write, signal, onProgress: (p) => set({ status: `${step}Encrypting “${job.name}”… ${percent(p)}` }) });
      if (target) await writeToFolder(target, await freeName(target, name), produce);
      else {
        downloadFile(name, await collect(produce), 'application/octet-stream');
        await pause(400); // let the browser start each download
      }
      done++;
      set({ jobs: get().jobs.filter((j) => j.id !== job.id) });
    }
    const what = done === 1 ? `“${jobs[0].name}”` : `${done} ${jobs.some((j) => j.kind === 'folder') ? 'items' : 'files'}`;
    set({
      busy: '',
      status: '',
      done: {
        kind: 'encrypt',
        text: `Encrypted ${what}${target ? ` into “${target.name}”` : ' to your downloads'}.`,
        password: withPassword,
        account: Boolean(master),
      },
    });
  } catch (err) {
    const finished = done ? ` (${done} of ${jobs.length} finished)` : '';
    set({ busy: '', status: '', error: err?.name === 'AbortError' ? `Stopped${finished}.` : `${err.message || err}${finished}` });
  } finally {
    controller = null;
  }
  return undefined;
}

// ===========================================================================
// Files: opening
// ===========================================================================
const failureOf = (err) => {
  if (err?.code === 'other-account') return { failure: state.unlocked ? 'Made with another Secure Box vault' : 'Made with a Secure Box vault', failureNeeds: 'vault' };
  if (err?.code === 'needs-password') return { failure: 'Needs its password', failureNeeds: 'password' };
  if (err?.code === 'wrong-password') return { failure: 'That password doesn’t open it', failureNeeds: 'password' };
  return { failure: err?.message || String(err), failureNeeds: '' };
};

/** Decrypts every chosen .sbox file it can. */
export async function openBoxes({ password = '', backupSecret = '' }) {
  used();
  const ready = get().boxes.filter((b) => b.box);
  if (!ready.length) return set({ error: 'Choose .sbox files first.' });
  const { backup } = get();
  let backupKey = null;
  if (backup) {
    if (!backupSecret) return set({ error: 'Enter the master password or recovery key of the key ring backup.' });
    try {
      backupKey = await unlockBackup(backup.doc, backupSecret);
    } catch (err) {
      return set({ error: err.message });
    }
  }
  // Nothing to open with: say what's missing instead of failing every file.
  const keyOf = (box) => keyFor(box) || (backupKey && boxAccess(box, backupKey).mine ? backupKey : null);
  const opensWith = ({ box }) => keyOf(box) || (password && boxAccess(box, null).password);
  if (!ready.some(opensWith)) {
    const wantsPassword = ready.some(({ box }) => boxAccess(box, null).password);
    return set({ error: wantsPassword && !password ? 'Enter the file’s password.' : state.unlocked ? 'These were made with another vault: use its key ring backup.' : 'Unlock the vault that made these, or use its key ring backup.' });
  }
  let target;
  try {
    target = await pickTarget('secure-box-decrypted');
  } catch {
    return undefined;
  }
  controller = new AbortController();
  const { signal } = controller;
  set({ busy: 'open', error: '', status: 'Starting…', done: null, boxes: get().boxes.map((b) => ({ ...b, failure: '' })) });
  let failed = 0;
  let done = 0;
  let stopped = false;
  let lastName = '';
  for (const [i, entry] of ready.entries()) {
    const { file, box } = entry;
    const step = ready.length > 1 ? `${i + 1} of ${ready.length} · ` : '';
    const progress = (p) => set({ status: `${step}Decrypting ${file.name}… ${percent(p)}` });
    try {
      const unlocked = await unlockBox(box, { master: keyOf(box), password });
      const content = await openContent(file, box, unlocked);
      const { meta } = unlocked;
      const produce = async (write) => {
        for await (const bytes of content.stream({ signal, onProgress: progress })) await write(bytes);
      };
      if (meta.kind === 'folder') {
        if (target) await extractFolder(content, target, progress);
        else downloadFile(`${safeName(meta.name, 'Folder')}.zip`, await collect(produce), 'application/zip');
      } else {
        const name = safeName(meta.name);
        if (target) await writeToFolder(target, await freeName(target, name), produce);
        else downloadFile(name, await collect(produce), meta.type || 'application/octet-stream');
      }
      if (!target) await pause(400);
      lastName = meta.name;
      done++;
      set({ boxes: get().boxes.filter((b) => b.id !== entry.id) });
    } catch (err) {
      if (err?.name === 'AbortError') {
        stopped = true;
        break;
      }
      failed++;
      const why = failureOf(err);
      set({ boxes: get().boxes.map((b) => (b.id === entry.id ? { ...b, ...why } : b)) });
    }
  }
  controller = null;
  if (failed || stopped) {
    const parts = [];
    if (done) parts.push(`${done} decrypted.`);
    if (failed) parts.push(failed === 1 ? 'One file didn’t open: see the list.' : `${failed} files didn’t open: see the list.`);
    if (stopped) parts.push('Stopped.');
    set({ busy: '', status: '', error: parts.join(' ') });
    return undefined;
  }
  set({
    busy: '',
    status: '',
    backup: null,
    done: { kind: 'open', text: `Decrypted ${done === 1 ? `“${lastName}”` : `${done} files`}${target ? ` into “${target.name}”` : ' to your downloads'}.` },
  });
  return undefined;
}

// ===========================================================================
// Text messages
// ===========================================================================
/** The text box changed. Pasting a message switches to Decrypt by itself. */
export function setText(text) {
  used();
  const s = get();
  const textMode = looksLikeMessage(text) ? 'decrypt' : s.textMode;
  set({ text, textMode, textOut: '', textOutSecret: false, textError: '', textErrorCode: '' });
}

export function setTextMode(textMode) {
  used();
  set({ textMode, textOut: '', textOutSecret: false, textError: '', textErrorCode: '' });
}

/**
 * How the message in the box will open: { ok, mine, password, account, error } — for the line
 * under it ("Opens with your vault", "Needs its password", "Made with a Secure Box vault").
 */
export function messageStatus(text) {
  if (!text.trim()) return null;
  try {
    const message = readMessage(text);
    const mine = sessionKeys().some((key) => messageAccess(message, key).mine);
    const access = messageAccess(message, null);
    return { ok: true, mine, password: access.password, account: access.account };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Encrypt or Decrypt, whichever the tab is on. */
export async function runText({ password = '', confirm = '', share = false } = {}) {
  used();
  const s = get();
  const value = s.text;
  if (s.textMode === 'decrypt') {
    let message;
    try {
      message = readMessage(value);
    } catch (err) {
      return set({ textError: err.message, textErrorCode: err.code || '' });
    }
    const key = sessionKeys().find((k) => messageAccess(message, k).mine) || null;
    const access = messageAccess(message, null);
    if (!key && !password) {
      return set({
        textError: access.password ? 'Enter the message’s password.' : state.unlocked ? 'This message was made with another Secure Box vault.' : 'This message opens with the master password of the vault that made it.',
        textErrorCode: access.password ? 'needs-password' : 'needs-vault',
      });
    }
    set({ busy: 'text', textError: '' });
    try {
      const plain = await openMessage(message, { master: key, password });
      set({ busy: '', textOut: plain, textOutSecret: true });
    } catch (err) {
      set({ busy: '', textError: err.code === 'other-account' ? 'This message was made with another Secure Box vault.' : err.message, textErrorCode: err.code || '' });
    }
    return undefined;
  }
  if (!value.trim()) return set({ textError: 'Type or paste the text to encrypt.' });
  const master = state.unlocked ? state.master : null;
  const withPassword = !master || share;
  if (withPassword) {
    const problem = passwordProblem(password, confirm);
    if (problem) return set({ textError: problem });
  }
  set({ busy: 'text', textError: '' });
  try {
    const armored = await sealText({ text: value, master, password: withPassword ? password : '' });
    set({ busy: '', textOut: armored, textOutSecret: false });
  } catch (err) {
    set({ busy: '', textError: err.message });
  }
  return undefined;
}

export async function copyTextOut() {
  const s = get();
  try {
    await copyText(s.textOut, { sensitive: s.textOutSecret });
    toast(s.textOutSecret ? 'Copied. It’s cleared from the clipboard in 30 seconds.' : 'Copied');
  } catch {
    toast('The browser blocked clipboard access.', 'error');
  }
}

export function shareTextOut() {
  return navigator.share({ text: get().textOut }).catch((err) => err.name === 'AbortError' || toast(err.message, 'error'));
}

export const startOverText = () => set({ text: '', textOut: '', textOutSecret: false, textError: '', textErrorCode: '' });

export { formatBytes };
