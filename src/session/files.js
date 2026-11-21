/**
 * The Files tab: a file manager over the encrypted index in the vault. Names and folders exist
 * only inside the vault; the cloud (or this device) holds opaque, randomly named blobs.
 *
 * Uploads run a few at a time, are saved to the vault in small batches, survive a passing
 * network failure (the clouds' uploads resume piece by piece), pause when the sign-in runs out
 * and stop once when the storage is full. Deleting takes the files out of the vault first, then
 * deletes their encrypted copies; any copy that can't be deleted yet is remembered (inside the
 * encrypted vault) and tried again later.
 */
import { MAX_FILE_SIZE, createPieceWriter, decryptFile, encryptFile, layout } from '../core/fileformat.js';
import { canThumbnail, formatBytes, guessType, kindOf } from '../core/filetypes.js';
import { fileUrl, zipUrl } from '../core/stream.js';
import { makeThumbnail } from '../core/thumbs.js';
import { runTask } from '../workers/pool.js';
import { collectTree, folderChain, makeFileEntry, makeFolder, uniqueName } from '../core/vault.js';
import { ask, confirmDialog, toast } from './bridge.js';
import { commit, driveFresh, ensureDrive } from './cloud.js';
import { downloadFile, pickFiles } from './io.js';
import { pushNav } from './nav.js';
import { pref } from './prefs.js';
import { createStore, state } from './store.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const ROOT_NAME = 'All files';
export const KIND_ICON = { image: 'image', video: 'video', audio: 'audio', pdf: 'file', doc: 'note', sheet: 'sheet', slides: 'slides', code: 'code', text: 'note', archive: 'archive', other: 'file' };

const store = createStore({
  folder: null, // the open folder (null: All files)
  query: '',
  selected: new Set(),
  anchor: null, // where a Shift range starts
  pending: new Map(), // id -> 'deleting' | 'moving' | 'renaming' (#10)
  transfers: [], // what the uploads tray shows
  tray: 'open', // 'open' | 'collapsed'
});
const get = () => store.get();
const set = (patch) => store.set((v) => ({ ...v, ...patch }));

const vault = () => state.vault;
const isLocal = () => state.backend?.kind === 'local';
const folderById = (id) => vault()?.folders.find((f) => f.id === id);
const fileById = (id) => vault()?.files.find((f) => f.id === id);
export { fileById, folderById };

// ===========================================================================
// What is shown
// ===========================================================================
const timeOf = (item) => {
  const t = new Date(item.updated || item.created || Date.now()).getTime();
  return Number.isFinite(t) ? t : Date.now();
};

function sortFiles(list, sort) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const order = {
    name: byName,
    updated: (a, b) => timeOf(b) - timeOf(a) || byName(a, b),
    size: (a, b) => b.size - a.size || byName(a, b),
    type: (a, b) => collator.compare(kindOf(a), kindOf(b)) || byName(a, b),
  }[sort] || byName;
  return list.sort(order);
}

/** The folders and files the Files tab shows: the open folder's, or everything matching a search. */
export function visibleEntries(v = vault(), folder = get().folder, query = get().query, sort = pref('sort')) {
  if (!v) return { folders: [], files: [] };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const match = (name) => terms.every((t) => name.toLowerCase().includes(t));
    return {
      folders: v.folders.filter((f) => match(f.name)).sort((a, b) => collator.compare(a.name, b.name)),
      files: sortFiles(v.files.filter((f) => match(f.name)), sort),
    };
  }
  return {
    folders: v.folders.filter((f) => f.parent === folder).sort((a, b) => collator.compare(a.name, b.name)),
    files: sortFiles(v.files.filter((f) => f.folder === folder), sort),
  };
}

export function folderStats(folderId) {
  const { folderIds, files } = collectTree(vault(), folderId);
  return { folders: folderIds.length - 1, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

export const folderPath = (file) => [ROOT_NAME, ...folderChain(vault(), file.folder).map((f) => f.name)].join(' / ');
export const crumbsOf = (folder) => folderChain(vault(), folder);

// ===========================================================================
// Moving around and choosing
// ===========================================================================
// Opening a folder is a step Back can return from (looked up when called: the modules import each other).
let onNavigate = () => pushNav();

/** `push: false` when the browser's Back or Forward brought us here (no new history entry). */
export function openFolder(id, { push = true } = {}) {
  const target = id && folderById(id) ? id : null;
  const moved = get().folder !== target || get().query;
  set({ folder: target, query: '', selected: new Set(), anchor: null });
  if (push && moved) onNavigate();
}

export function goUp() {
  const folder = folderById(get().folder);
  if (folder) openFolder(folder.parent ?? null);
}

export function setFilesQuery(query) {
  set({ query, selected: new Set(), anchor: null });
}

export function setSelection(ids, anchor = undefined) {
  set({ selected: new Set(ids), ...(anchor !== undefined ? { anchor } : {}) });
}

export function toggleSelected(id) {
  const selected = new Set(get().selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  set({ selected, anchor: id });
}

/** Shift: everything from the anchor to `id` in `order`; with `add` (Ctrl/⌘ too) on top of what's chosen. */
export function selectRange(id, order, { add = false } = {}) {
  const anchor = get().anchor ?? id;
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return setSelection([id], id);
  const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  set({ selected: new Set(add ? [...get().selected, ...range] : range) });
}

export const clearSelection = () => set({ selected: new Set(), anchor: null });

export function selection() {
  const ids = [...get().selected];
  return { folders: ids.filter((id) => folderById(id)), files: ids.filter((id) => fileById(id)) };
}

const setPending = (ids, what) => {
  const pending = new Map(get().pending);
  for (const id of ids) {
    if (what) pending.set(id, what);
    else pending.delete(id);
  }
  set({ pending });
};

// ===========================================================================
// Reading files: streamed through the service worker, or decrypted in the page
// ===========================================================================
const objectUrls = new Map();

async function decryptHere(file, part = 'content') {
  const plan = layout({ size: file.size, thumbBytes: file.thumbBytes, chunk: file.chunk });
  const end = part === 'thumb' ? plan.contentStart - 1 : plan.total - 1;
  const stream = await state.backend.readRange(file.driveId, 0, end);
  return decryptFile(stream, file, { part });
}

export async function sourceUrl(file) {
  if (state.streaming) return fileUrl(file.id);
  if (!objectUrls.has(file.id)) objectUrls.set(file.id, URL.createObjectURL(new Blob(await decryptHere(file), { type: file.type })));
  return objectUrls.get(file.id);
}

const readError = async (res) => (res.status === 401 ? 'Access to your cloud drive expired. Reconnect and try again.' : (await res.text()) || `The file couldn’t be read (${res.status}).`);

export async function fetchBytes(file) {
  if (state.streaming) {
    const res = await fetch(fileUrl(file.id), { cache: 'no-store' });
    if (!res.ok) throw new Error(await readError(res));
    return res.arrayBuffer();
  }
  return new Blob(await decryptHere(file)).arrayBuffer();
}

/** Plaintext bytes [start, end] of a file (to sniff unknown types). */
export async function fetchRange(file, start, end) {
  if (state.streaming) {
    const res = await fetch(fileUrl(file.id), { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
    if (!res.ok) throw new Error(await readError(res));
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await new Blob(await decryptHere(file)).arrayBuffer()).subarray(start, end + 1);
}

/** The whole decrypted file as a File (to share it to another app). */
export async function fileForSharing(file) {
  return new File([await fetchBytes(file)], file.name, { type: file.type || 'application/octet-stream' });
}

export function releaseUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

/**
 * Hands a service-worker URL to the browser as a download. Chrome can send <a download> clicks
 * straight to the server, skipping the worker; a navigation in a hidden frame always reaches it.
 * If the worker answers with an error instead of a file, the frame shows its text: pass it on.
 */
function downloadViaWorker(url) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'Download';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.addEventListener('load', () => {
    let text = '';
    try {
      text = frame.contentDocument?.body?.textContent?.trim() || '';
    } catch {
      /* not readable: nothing to report */
    }
    if (text) toast(text.length > 200 ? 'The download failed. Try again.' : text, 'error');
  });
  frame.src = url;
  document.body.append(frame);
  setTimeout(() => frame.remove(), 120_000);
}

export async function download(file) {
  await ensureDrive();
  // The worker streams the decrypted file straight into the browser's download.
  if (state.streaming) downloadViaWorker(fileUrl(file.id, { download: true }));
  else downloadFile(file.name, new Blob(await decryptHere(file), { type: file.type }), file.type);
}

async function downloadEach(list) {
  if (list.length > 10 && !(await confirmDialog({ title: `Download ${list.length} files?`, message: 'Each file is decrypted and saved separately. Your browser may ask to allow multiple downloads.', confirmLabel: 'Download' }))) return;
  for (const file of list) {
    await download(file);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** A file or folder name that unpacks safely on Windows, macOS and Linux. */
function zipName(name) {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return clean && clean !== '.' && clean !== '..' ? clean : '_';
}

function uniqueZipName(taken, name, isFile) {
  const dot = isFile ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let pick = name;
  for (let n = 2; taken.has(pick.toLowerCase()); n++) pick = `${stem} (${n})${ext}`;
  taken.add(pick.toLowerCase());
  return pick;
}

/** ZIP entries for chosen folders (with everything inside) and files, in a stable order. */
function zipEntries(folderIds, fileIds) {
  const v = vault();
  const byName = (a, b) => collator.compare(a.name, b.name);
  const covered = new Set(folderIds.flatMap((id) => collectTree(v, id).folderIds));
  const entries = [];
  const addFile = (file, path, taken) => {
    entries.push({ path: `${path}${uniqueZipName(taken, zipName(file.name), true)}`, size: file.size, mtime: timeOf(file), fileId: file.id });
  };
  const addFolder = (folder, path, taken) => {
    const here = `${path}${uniqueZipName(taken, zipName(folder.name), false)}/`;
    entries.push({ path: here, dir: true, mtime: timeOf(folder) });
    const inner = new Set();
    for (const sub of v.folders.filter((f) => f.parent === folder.id).sort(byName)) addFolder(sub, here, inner);
    for (const file of v.files.filter((f) => f.folder === folder.id).sort(byName)) addFile(file, here, inner);
  };
  const top = new Set();
  // A folder or file already inside another chosen folder isn't added twice.
  for (const id of folderIds) {
    const folder = folderById(id);
    if (folder && !covered.has(folder.parent)) addFolder(folder, '', top);
  }
  for (const id of fileIds) {
    const file = fileById(id);
    if (file && !covered.has(file.folder)) addFile(file, '', top);
  }
  return entries;
}

/** Several folders and files as one ZIP that keeps the folders, built while it downloads. */
export async function downloadZip(folderIds, fileIds) {
  const entries = zipEntries(folderIds, fileIds);
  const list = entries.filter((e) => !e.dir);
  if (!list.length) return toast('Nothing to download: the chosen folders are empty.');
  if (!state.streaming) return downloadEach(list.map((e) => fileById(e.fileId)));
  await ensureDrive();
  const single = folderIds.length === 1 && !fileIds.length ? folderById(folderIds[0]) : null;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = single ? `${zipName(single.name)}.zip` : `Secure Box ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
  downloadViaWorker(zipUrl({ name, entries }));
  const bytes = list.reduce((n, e) => n + e.size, 0);
  toast(`Downloading ${name}: ${list.length} ${list.length === 1 ? 'file' : 'files'}, ${formatBytes(bytes)}`);
  return undefined;
}

/** One file downloads as itself; anything more becomes one ZIP that keeps the folders. */
export function downloadEntries(folderIds, fileIds) {
  if (!folderIds.length && fileIds.length === 1) return download(fileById(fileIds[0]));
  return downloadZip(folderIds, fileIds);
}

// ===========================================================================
// Changes: new folder, rename, move, delete
// ===========================================================================
export async function newFolder() {
  const name = await ask('prompt', { title: 'New folder', label: 'Folder name', value: 'Untitled folder', confirmLabel: 'Create' });
  if (!name) return;
  await ensureDrive();
  const parent = get().folder;
  const siblings = vault().folders.filter((f) => f.parent === parent).map((f) => f.name);
  const folder = makeFolder({ name: uniqueName(name, siblings, { isFolder: true }), parent });
  await commit({ op: 'folder-put', folder });
  setSelection([folder.id], folder.id);
}

export async function renameEntry(entry, isFolder) {
  const name = await ask('prompt', { title: isFolder ? 'Rename folder' : 'Rename file', label: 'Name', value: entry.name, confirmLabel: 'Rename', selectStem: !isFolder });
  if (!name || name === entry.name) return;
  setPending([entry.id], 'renaming');
  try {
    await ensureDrive();
    if (isFolder) {
      const siblings = vault().folders.filter((f) => f.parent === entry.parent && f.id !== entry.id).map((f) => f.name);
      await commit({ op: 'folder-put', folder: makeFolder({ name: uniqueName(name, siblings, { isFolder: true }), parent: entry.parent }, entry) });
    } else {
      const siblings = vault().files.filter((f) => f.folder === entry.folder && f.id !== entry.id).map((f) => f.name);
      await commit({ op: 'file-put', file: makeFileEntry({ name: uniqueName(name, siblings), type: guessType(name, entry.type) }, entry) });
    }
  } finally {
    setPending([entry.id], null);
  }
}

export async function moveEntries(folderIds, fileIds, target) {
  if (!folderIds.length && !fileIds.length) return;
  const blocked = new Set(folderIds.flatMap((id) => collectTree(vault(), id).folderIds));
  if (target === undefined) {
    const count = folderIds.length + fileIds.length;
    const only = count === 1 ? (folderById(folderIds[0]) || fileById(fileIds[0])).name : `${count} items`;
    const choice = await ask('moveTo', { title: `Move “${only}” to…`, exclude: [...blocked], from: get().folder });
    if (!choice) return;
    target = choice.folder;
  }
  if (target !== null && blocked.has(target)) return toast('A folder can’t be moved into itself.', 'error');
  const ids = [...folderIds, ...fileIds];
  setPending(ids, 'moving');
  try {
    await ensureDrive();
    const v = vault();
    const changes = [];
    const takenFolders = v.folders.filter((f) => f.parent === target && !folderIds.includes(f.id)).map((f) => f.name);
    for (const id of folderIds) {
      const folder = folderById(id);
      if (!folder || folder.parent === target) continue;
      const name = uniqueName(folder.name, takenFolders, { isFolder: true });
      takenFolders.push(name);
      changes.push({ op: 'folder-put', folder: makeFolder({ name, parent: target }, folder) });
    }
    const takenFiles = v.files.filter((f) => f.folder === target && !fileIds.includes(f.id)).map((f) => f.name);
    for (const id of fileIds) {
      const file = fileById(id);
      if (!file || file.folder === target) continue;
      const name = uniqueName(file.name, takenFiles);
      takenFiles.push(name);
      changes.push({ op: 'file-put', file: makeFileEntry({ name, folder: target }, file) });
    }
    if (!changes.length) return;
    await commit({ op: 'batch', changes });
    clearSelection();
    toast(`Moved to ${target ? folderById(target).name : ROOT_NAME}`);
  } finally {
    setPending(ids, null);
  }
}

const trashNote = () =>
  state.provider === 'microsoft' ? 'The encrypted copies go to your OneDrive recycle bin.' : state.provider === 'local' ? 'They’re deleted from this device for good.' : 'The encrypted copies go to your Google Drive trash.';

export async function deleteEntries(folderIds, fileIds) {
  const trees = folderIds.map((id) => collectTree(vault(), id));
  const allFolders = [...new Set(trees.flatMap((t) => t.folderIds))];
  const allFiles = [...new Map([...trees.flatMap((t) => t.files), ...fileIds.map(fileById).filter(Boolean)].map((f) => [f.id, f])).values()];
  const label = folderIds.length + fileIds.length === 1 ? `“${(folderById(folderIds[0]) || fileById(fileIds[0])).name}”` : `${folderIds.length + fileIds.length} items`;
  const inside = folderIds.length && allFiles.length ? ` and the ${allFiles.length} ${allFiles.length === 1 ? 'file' : 'files'} inside` : '';
  const ok = await confirmDialog({
    title: `Delete ${label}?`,
    message: isLocal() ? `This deletes ${label}${inside} from the vault on this device. It can’t be undone.` : `This removes ${label}${inside} from Secure Box on every device. ${trashNote()}`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const ids = [...folderIds, ...fileIds];
  setPending(ids, 'deleting');
  const driveIds = allFiles.map((f) => f.driveId).filter(Boolean);
  try {
    await ensureDrive();
    // Out of the vault first, with a note of the encrypted copies still to delete: if deleting
    // them fails now, a later sync finishes the job.
    await commit({ op: 'batch', changes: [{ op: 'remove', folders: allFolders, files: allFiles.map((f) => f.id) }, ...(driveIds.length ? [{ op: 'trash-add', ids: driveIds }] : [])] });
  } catch (err) {
    setPending(ids, null);
    throw err;
  }
  setPending(ids, null);
  clearSelection();
  toast(allFiles.length + allFolders.length === 1 ? 'Deleted' : `Deleted ${allFiles.length + allFolders.length} items`);
  const left = await deleteCopies(driveIds);
  if (left.length) toast(`Deleted from Secure Box. ${left.length === 1 ? 'Its encrypted copy' : `${left.length} encrypted copies`} couldn’t be removed yet: Secure Box tries again on the next sync.`, 'error');
}

/** Deletes encrypted copies; returns the ones that couldn't be deleted (they stay on the vault's list). */
async function deleteCopies(driveIds) {
  if (!driveIds.length) return [];
  const backend = state.backend;
  const done = [];
  const left = [];
  for (const id of driveIds) {
    try {
      await backend.trash(id);
      done.push(id);
    } catch (err) {
      // Gone already counts as done.
      if (err?.status === 404 || err?.code === 'not-found') done.push(id);
      else {
        console.warn('Delete: the encrypted copy stayed', id, err);
        left.push(id);
      }
    }
  }
  if (done.length && state.backend === backend) await commit({ op: 'trash-done', ids: done }).catch((err) => console.warn('Trash list:', err));
  return left;
}

let retrying = false;

/** Encrypted copies left over from earlier deletes: try again (after unlocking and syncing). */
export async function retryTrash() {
  const ids = vault()?.trash || [];
  if (!ids.length || retrying || !state.unlocked || !driveFresh(60_000)) return;
  retrying = true;
  try {
    await deleteCopies([...ids]);
  } finally {
    retrying = false;
  }
}

export function deleteSelection() {
  const s = selection();
  if (s.folders.length || s.files.length) return deleteEntries(s.folders, s.files);
  return undefined;
}

// ===========================================================================
// Uploads
// ===========================================================================
const tasks = [];
const ACTIVE = new Set(['queued', 'preparing', 'uploading', 'paused']);
const RUNNING = new Set(['queued', 'preparing', 'uploading']);
let running = 0;
let stoppedFor = ''; // the storage is full: nothing else starts until you retry
const parallel = () => (state.backend?.kind === 'local' ? 2 : 3);

let snapTimer = 0;
function snapshot() {
  clearTimeout(snapTimer);
  snapTimer = 0;
  set({
    transfers: tasks.map((t) => ({ id: t.id, name: t.file.name, size: t.file.size, type: guessType(t.file.name, t.file.type), status: t.status, progress: t.progress, error: t.error, local: t.local })),
  });
}
const snapSoon = () => {
  snapTimer ||= setTimeout(snapshot, 120);
};

/** Opens the browser's file picker and uploads what's chosen into the open folder. */
export async function upload({ directory = false } = {}) {
  if (!driveFresh(10 * 60_000)) {
    await ensureDrive(); // reconnect first; the file picker needs a fresh click
    return toast('Reconnected — choose Upload again.');
  }
  const target = get().folder;
  const picked = await pickFiles({ folder: directory });
  enqueue(picked.map((file) => ({ file, path: directory ? file.webkitRelativePath.split('/').slice(0, -1) : [] })), target);
  return undefined;
}

/** Files and folders dropped on the Files tab (or on a folder), with their folders. */
export function uploadFromDrop(dataTransfer, target = get().folder) {
  // Entries must be read before the drop event finishes.
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...dataTransfer.files];
  (async () => {
    const found = [];
    const walk = async (entry, path) => {
      if (entry.isFile) found.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, [...path, entry.name]);
        }
      }
    };
    if (entries.length) for (const entry of entries) await walk(entry, []);
    else found.push(...plain.map((file) => ({ file, path: [] })));
    enqueue(found, target);
  })().catch((err) => toast(err.message, 'error'));
}

/**
 * Queues files for the open vault. An item may carry `after()`, run once it's encrypted and
 * saved. Resolves when every item has finished, failed or stopped.
 */
export function enqueue(items, target = get().folder) {
  if (!items.length) return Promise.resolve([]);
  stoppedFor = '';
  const added = items.map(({ file, path, after }) => {
    const task = { id: crypto.randomUUID(), file, path, target, after, backend: state.backend, local: state.backend?.kind === 'local', progress: 0, status: 'queued', error: '', abort: new AbortController() };
    task.finished = new Promise((resolve) => {
      task.settle = resolve;
    });
    return task;
  });
  tasks.push(...added);
  set({ tray: 'open' });
  snapshot();
  pump();
  return Promise.all(added.map((t) => t.finished));
}

function pump() {
  while (running < parallel()) {
    const task = tasks.find((t) => t.status === 'queued');
    if (!task) break;
    if (task.backend !== state.backend) {
      // The vault changed: what's still waiting belonged to the one that closed.
      task.status = 'cancelled';
      task.settle('cancelled');
      continue;
    }
    if (!task.local && !driveFresh(2 * 60_000)) {
      for (const t of tasks) if (t.status === 'queued') t.status = 'paused';
      snapshot();
      break;
    }
    run(task);
  }
  if (!tasks.some((t) => ACTIVE.has(t.status))) {
    pathJobs.clear();
    if (tasks.length && tasks.every((t) => t.status === 'done')) setTimeout(clearFinished, 4000);
  }
}

async function run(task) {
  running++;
  task.status = 'preparing';
  snapshot();
  try {
    await uploadOne(task);
    task.status = 'done';
    task.progress = 1;
    if (task.after) await Promise.resolve().then(task.after).catch((err) => console.warn('After saving:', err));
  } catch (err) {
    if (err?.name === 'AbortError') {
      task.status = 'cancelled';
      task.error = '';
    } else if (err?.code === 'expired') {
      // The sign-in ran out mid-way: it waits for "Reconnect & resume" instead of failing.
      task.status = 'paused';
      task.progress = 0;
      task.error = '';
      task.abort = new AbortController();
    } else if (err?.code === 'quota') {
      task.status = 'error';
      task.error = err.message;
      stopQueue(err.message);
    } else {
      task.status = 'error';
      task.error = err?.message || String(err);
    }
  } finally {
    running--;
    if (task.status !== 'paused') task.settle?.(task.status);
    snapshot();
    pump();
  }
}

/** Storage is full: everything still waiting stops, with one message (#20). */
function stopQueue(reason) {
  if (stoppedFor) return;
  stoppedFor = reason;
  for (const t of tasks) {
    if (t.status === 'queued' || t.status === 'paused') {
      t.status = 'error';
      t.error = reason;
      t.settle?.('error');
    }
  }
  toast(`${reason} The uploads still waiting were stopped: free up some space, then retry them.`, 'error');
}

// Folders made for dropped folders, shared by uploads running at the same time so they don't
// each make their own copy of the same folder.
const pathJobs = new Map();

async function ensurePath(target, path) {
  // The folder it was going into was deleted meanwhile: All files instead.
  let parent = target && folderById(target) ? target : null;
  for (const name of path) {
    const existing = vault().folders.find((f) => f.parent === parent && f.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      parent = existing.id;
      continue;
    }
    const key = `${parent}/${name.toLowerCase()}`;
    if (!pathJobs.has(key)) {
      const folder = makeFolder({ name, parent });
      pathJobs.set(key, commit({ op: 'folder-put', folder }).then(() => folder.id));
    }
    try {
      parent = await pathJobs.get(key);
    } catch (err) {
      pathJobs.delete(key);
      throw err;
    }
  }
  return parent;
}

async function uploadOne(task) {
  const { file } = task;
  if (file.size > MAX_FILE_SIZE) throw new Error(`Files up to ${formatBytes(MAX_FILE_SIZE)} are supported.`);
  const folder = await ensurePath(task.target, task.path);
  const id = crypto.randomUUID();
  const type = guessType(file.name, file.type);
  // Photos' thumbnails are made in a worker; a video's needs the page (a <video> element).
  const thumbnail = !canThumbnail({ name: file.name, type })
    ? null
    : type.startsWith('image/')
      ? await runTask('thumbnail', { file }).catch(() => makeThumbnail(file, type))
      : await makeThumbnail(file, type);
  const plan = layout({ size: file.size, thumbBytes: thumbnail?.length || 0 });
  task.status = 'uploading';
  snapshot();
  const { backend } = task;
  const send = await backend.openUpload({ fid: id, size: plan.total, signal: task.abort.signal });
  const writer = createPieceWriter({
    total: plan.total,
    send,
    pieceSize: send.pieceSize, // OneDrive wants multiples of 320 KiB
    onProgress: (p) => {
      task.progress = p;
      snapSoon();
    },
  });
  let meta;
  try {
    meta = await encryptFile({ file, fileId: id, thumbnail, write: (bytes) => writer.write(bytes), signal: task.abort.signal });
  } catch (err) {
    await send.abort?.(); // the upload session (or a half-written file here) goes
    throw err;
  }
  const entry = makeFileEntry({ id, name: file.name, type, size: file.size, folder, driveId: writer.result, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes });
  await saveEntry(entry, backend);
}

// Saved to the vault in small batches: many small files make a few vault saves, not one each.
let batch = [];
let batchTimer = 0;

function saveEntry(entry, backend) {
  return new Promise((resolve, reject) => {
    batch.push({ entry, backend, resolve, reject });
    clearTimeout(batchTimer);
    if (batch.length >= 20) flush();
    else batchTimer = setTimeout(flush, 600);
  });
}

async function flush() {
  clearTimeout(batchTimer);
  const items = batch;
  batch = [];
  if (!items.length) return;
  const v = vault();
  const names = new Map();
  const changes = items.map(({ entry }) => {
    const taken = names.get(entry.folder) || v.files.filter((f) => f.folder === entry.folder).map((f) => f.name);
    const name = uniqueName(entry.name, taken);
    taken.push(name);
    names.set(entry.folder, taken);
    return { op: 'file-put', file: { ...entry, name } };
  });
  try {
    await commit({ op: 'batch', changes });
  } catch (err) {
    for (const { entry, backend, reject } of items) {
      backend.trash(entry.driveId).catch(() => {});
      reject(err);
    }
    return;
  }
  // A folder deleted meanwhile in another window or device: those files are in All files now.
  const moved = changes.filter((c) => c.file.folder && !vault().files.some((f) => f.id === c.file.id && f.folder === c.file.folder));
  if (moved.length) toast(`${moved.length === 1 ? `“${moved[0].file.name}” was` : `${moved.length} files were`} saved in ${ROOT_NAME}: the folder ${moved.length === 1 ? 'it was going to' : 'they were going to'} was deleted meanwhile.`);
  for (const { resolve } of items) resolve();
}

export function retryTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  Object.assign(task, { status: 'queued', progress: 0, error: '', abort: new AbortController(), backend: state.backend });
  task.finished = new Promise((resolve) => {
    task.settle = resolve;
  });
  stoppedFor = '';
  snapshot();
  pump();
}

export function cancelTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.abort.abort();
  if (task.status === 'queued' || task.status === 'paused') {
    task.status = 'cancelled';
    task.settle?.('cancelled');
  }
  snapshot();
}

/** Reconnect & resume: uploads paused when the sign-in ran out start again. */
export async function resumePaused() {
  await ensureDrive();
  for (const t of tasks) {
    if (t.status === 'paused') {
      t.status = 'queued';
      t.backend = state.backend;
    }
  }
  snapshot();
  pump();
}

export function clearFinished() {
  if (tasks.some((t) => ACTIVE.has(t.status))) return;
  for (let i = tasks.length - 1; i >= 0; i--) if (['done', 'cancelled'].includes(tasks[i].status)) tasks.splice(i, 1);
  snapshot();
}

/** The tray's ✕: with uploads unfinished it asks first, since closing stops them (#14). */
export async function closeTray() {
  const unfinished = tasks.filter((t) => ACTIVE.has(t.status));
  if (unfinished.length) {
    const n = unfinished.length;
    const ok = await confirmDialog({
      title: `Stop ${n === 1 ? 'the upload' : `${n} uploads`}?`,
      message: `${n === 1 ? 'A file hasn’t' : `${n} files haven’t`} finished ${tasks[0]?.local ? 'saving' : 'uploading'}. ${n === 1 ? 'It won’t' : 'They won’t'} be saved if you stop now.`,
      confirmLabel: n === 1 ? 'Stop upload' : 'Stop uploads',
      cancelLabel: 'Keep uploading',
      danger: true,
    });
    if (!ok) return;
    await stopAll();
  }
  tasks.length = 0;
  snapshot();
}

export const toggleTray = () => set({ tray: get().tray === 'open' ? 'collapsed' : 'open' });

/** Stops every upload, and resolves once all of them have stopped. */
export async function stopAll() {
  const live = tasks.filter((t) => ACTIVE.has(t.status));
  for (const task of live) cancelTask(task.id);
  await Promise.all(live.map((t) => t.finished));
}

const unfinished = () => tasks.some((t) => ACTIVE.has(t.status));

// Leaving the page while files are still uploading (or saving here) asks first. A lock never
// asks: it must always go through, and the lock button has asked already when it should.
window.addEventListener('beforeunload', (event) => {
  if (state.unlocked && (unfinished() || state.device.busy)) event.preventDefault();
});

// ===========================================================================
// What the rest of the session relies on
// ===========================================================================
export const files = {
  store,
  busy: () => tasks.some((t) => RUNNING.has(t.status)),
  unfinished,
  unfinishedCount: () => tasks.filter((t) => ACTIVE.has(t.status)).length,
  /** Uploads under way, the ones waiting their turn included. */
  runningCount: () => tasks.filter((t) => RUNNING.has(t.status)).length,
  /** Uploads paused until Reconnect & resume: they never finish by themselves. */
  pausedCount: () => tasks.filter((t) => t.status === 'paused').length,
  stopAll,
  /** Another vault opened: start at the top, nothing chosen. */
  reset() {
    set({ folder: null, query: '', selected: new Set(), anchor: null, pending: new Map() });
    releaseUrls();
  },
  /** Another vault opened: its finished uploads aren't this vault's to retry. */
  clearTransfers() {
    if (unfinished()) return;
    tasks.length = 0;
    snapshot();
  },
  /** The vault changed (a sync, a restore): forget what's gone, retry pending deletes. */
  vaultChanged() {
    const v = get();
    const selected = new Set([...v.selected].filter((id) => fileById(id) || folderById(id)));
    const folder = v.folder && !folderById(v.folder) ? null : v.folder;
    if (selected.size !== v.selected.size || folder !== v.folder) set({ selected, folder });
    retryTrash().catch((err) => console.warn('Trash retry:', err));
  },
  enqueue,
  folder: () => get().folder,
  goTo: (folder, options) => openFolder(folder, options),
  setQuery: setFilesQuery,
  onNavigate(fn) {
    onNavigate = fn;
  },
  key: null, // the Files tab's keyboard handler, while it's shown
  searchKey: null,
};
