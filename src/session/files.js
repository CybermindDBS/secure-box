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
import { backoff, transient } from '../core/retry.js';
import { downloadsUnderWay, fileUrl, forgetStreams, zipUrl } from '../core/stream.js';
import { makeThumbnail } from '../core/thumbs.js';
import { forgetThumbs } from './thumbs.js';
import { runTask } from '../workers/pool.js';
import { collectTree, copiesInUse, folderChain, makeFileEntry, makeFolder, uniqueName, uniqueNameWhere, vaultIndex } from '../core/vault.js';
import { ask, confirmDialog, toast } from './bridge.js';
import { commit, driveFresh, ensureDrive } from './cloud.js';
import { downloadFile, pickFiles } from './io.js';
import { pushNav } from './nav.js';
import { pref } from './prefs.js';
import { DEMO, createStore, pause, state } from './store.js';
import { dropFromViewer, editingDirty } from './viewer.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const ROOT_NAME = 'All files';
export const KIND_ICON = { image: 'image', video: 'video', audio: 'audio', pdf: 'file', doc: 'note', sheet: 'sheet', slides: 'slides', code: 'code', text: 'note', archive: 'archive', other: 'file' };

const store = createStore({
  folder: null, // the open folder (null: All files)
  query: '',
  selected: new Set(),
  anchor: null, // where a Shift range starts
  pending: new Map(), // id -> 'deleting' | 'moving' | 'renaming' (#10)
  missing: new Set(), // names of encrypted copies that aren't where the vault is (deleted outside Secure Box, say)
  added: null, // a folder just made: shown and lit up for a moment, not chosen
  transfers: [], // what the uploads tray shows: a row for each upload
  summary: null, // and their totals (snapshot)
  tray: 'open', // 'open' | 'collapsed'
});
const get = () => store.get();
const set = (patch) => store.set((v) => ({ ...v, ...patch }));

/** Lights up `id` for a moment where it now is (a folder just made), without choosing it. */
function markAdded(id) {
  set({ added: id });
  setTimeout(() => {
    if (get().added === id) set({ added: null });
  }, 1800);
}

const vault = () => state.vault;
const isLocal = () => state.backend?.kind === 'local';
// Found by id at once, however big the vault (core/vault.js, vaultIndex).
const index = () => (vault() ? vaultIndex(vault()) : null);
const folderById = (id) => (id ? index()?.folders.get(id) : undefined);
const fileById = (id) => (id ? index()?.files.get(id) : undefined);
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
  const { foldersIn, filesIn } = vaultIndex(v);
  return {
    folders: [...foldersIn(folder)].sort((a, b) => collator.compare(a.name, b.name)),
    files: sortFiles([...filesIn(folder)], sort),
  };
}

/** What a folder holds at any depth: { folders, files, bytes } (worked out once per vault). */
export const folderStats = (folderId) => vaultIndex(vault()).totals(folderId);

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
  const stream = await state.backend.readRange(file.blob, 0, end);
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
    if (!res.ok) throw Object.assign(new Error(await readError(res)), { status: res.status });
    return res.arrayBuffer();
  }
  return new Blob(await decryptHere(file)).arrayBuffer();
}

/** Plaintext bytes [start, end] of a file (to sniff unknown types). */
export async function fetchRange(file, start, end) {
  if (state.streaming) {
    const res = await fetch(fileUrl(file.id), { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(await readError(res)), { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await new Blob(await decryptHere(file)).arrayBuffer()).subarray(start, end + 1);
}

// ===========================================================================
// Encrypted copies that went missing (deleted outside Secure Box, say)
// ===========================================================================
/** A "not found" for a file's encrypted copy, from wherever it was read. */
export const isMissingCopy = (err) => err?.code === 'not-found' || err?.status === 404;

/** Notes that a file's encrypted copy is missing (`there` false), or there after all. */
export function noteCopy(file, there) {
  const missing = get().missing;
  if (missing.has(file.blob) !== there) return;
  const next = new Set(missing);
  if (there) next.delete(file.blob);
  else next.add(file.blob);
  set({ missing: next });
}

/**
 * Looks for files whose encrypted copy isn't where the vault is: deleted by hand from the
 * vault's folder, say, or in the cloud's own app. Their entries stay (only an entry can open a
 * copy that's put back), marked missing, so they can be put back or removed. A file added or
 * changed in the last few minutes isn't counted yet: a sync service, or a cloud's search, may
 * still be catching up with it.
 */
export async function checkCopies() {
  const backend = state.backend;
  const v = vault();
  if (!backend?.absent || !v?.files.length) return;
  const settled = Date.now() - 2 * 60_000;
  const names = v.files.filter((f) => timeOf(f) < settled).map((f) => f.blob);
  let gone;
  try {
    gone = await backend.absent(names);
  } catch (err) {
    console.warn('Checking the encrypted copies:', err);
    return;
  }
  if (state.backend !== backend) return;
  const checked = new Set(names);
  set({ missing: new Set([...[...get().missing].filter((name) => !checked.has(name)), ...gone]) });
}

/** Is this file's encrypted copy missing? One found missing before is asked about afresh: it may be back. */
export async function copyGone(file) {
  const backend = state.backend;
  if (!backend?.absent) return false;
  const gone = (await backend.absent([file.blob], { fresh: get().missing.has(file.blob) }).catch(() => [])).length > 0;
  if (state.backend === backend) noteCopy(file, !gone);
  return gone;
}

/** What to say about a file whose encrypted copy is missing, for where the vault is. */
export function missingCopyText() {
  const folder = state.backend?.where === 'folder';
  const [where, back] =
    DEMO && state.provider !== 'local'
      ? ['in the demo vault', 'put it back']
      : state.provider === 'microsoft'
        ? ['in your OneDrive', 'restore it from the OneDrive recycle bin']
        : state.provider === 'local'
          ? folder
            ? ['in the vault’s folder', 'put it back from the Recycle Bin or Trash, or restore a backup']
            : ['in this browser', 'restore a backup']
          : ['in your Google Drive', 'take it out of the bin there'];
  return `It isn’t ${where} any more, so it can’t be opened. If it was deleted by mistake, ${back}, then try again. Otherwise, remove the file from your vault.`;
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
    const { foldersIn, filesIn } = vaultIndex(v);
    for (const sub of [...foldersIn(folder.id)].sort(byName)) addFolder(sub, here, inner);
    for (const file of [...filesIn(folder.id)].sort(byName)) addFile(file, here, inner);
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
  const siblings = index().foldersIn(parent).map((f) => f.name);
  const folder = makeFolder({ name: uniqueName(name, siblings, { isFolder: true }), parent });
  await commit({ op: 'folder-put', folder });
  markAdded(folder.id); // shown where it landed; choosing stays the checkbox's job
}

export async function renameEntry(entry, isFolder) {
  const name = await ask('prompt', { title: isFolder ? 'Rename folder' : 'Rename file', label: 'Name', value: entry.name, confirmLabel: 'Rename', selectStem: !isFolder });
  if (!name || name === entry.name) return;
  setPending([entry.id], 'renaming');
  try {
    await ensureDrive();
    // Only the new name goes: it applies to the folder or file as it is now (another device may
    // have changed it meanwhile), and is kept apart from the names already beside it there.
    if (isFolder) await commit({ op: 'folder-update', id: entry.id, fields: { name, updated: Date.now() } });
    else await commit({ op: 'file-update', id: entry.id, fields: { name, type: guessType(name, entry.type), updated: Date.now() } });
    if (!(isFolder ? folderById(entry.id) : fileById(entry.id))) toast(`“${entry.name}” was deleted on another device or in another window.`, 'error');
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
    // Each move applies to the folder or file as it is now (another device may have renamed,
    // edited or deleted it meanwhile); names are kept apart from those already in the target.
    const now = Date.now();
    const changes = [
      ...folderIds.filter((id) => folderById(id) && folderById(id).parent !== target).map((id) => ({ op: 'folder-update', id, fields: { parent: target, updated: now } })),
      ...fileIds.filter((id) => fileById(id) && fileById(id).folder !== target).map((id) => ({ op: 'file-update', id, fields: { folder: target, updated: now } })),
    ];
    if (!changes.length) return;
    await commit({ op: 'batch', changes });
    clearSelection();
    const gone = changes.filter((c) => !(c.op === 'file-update' ? fileById(c.id) : folderById(c.id))).length;
    if (target && !folderById(target)) toast(`That folder was deleted on another device or in another window, so they went to ${ROOT_NAME}.`, 'error');
    else if (gone) toast(`${gone === 1 ? 'One of them was' : `${gone} of them were`} deleted on another device or in another window meanwhile.`, 'error');
    else toast(`Moved to ${target ? folderById(target).name : ROOT_NAME}`);
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
  // Files whose encrypted copy is missing just come off the vault's list: there's nothing else to delete.
  const gone = !folderIds.length && allFiles.length > 0 && allFiles.every((f) => get().missing.has(f.blob));
  const one = allFiles.length === 1;
  const inside = folderIds.length && allFiles.length ? ` and the ${allFiles.length} ${allFiles.length === 1 ? 'file' : 'files'} inside` : '';
  const ok = await confirmDialog({
    title: gone ? `Remove ${label} from your vault?` : `Delete ${label}?`,
    message: gone
      ? `${one ? 'Its encrypted copy is' : 'Their encrypted copies are'} missing, so ${one ? 'it' : 'they'} can’t be opened. This takes ${one ? 'it' : 'them'} off your vault${isLocal() ? '' : ' on every device'}. It can’t be undone.`
      : isLocal()
        ? `This deletes ${label}${inside} from the vault on this device. It can’t be undone.`
        : `This removes ${label}${inside} from Secure Box on every device. ${trashNote()}`,
    confirmLabel: gone ? 'Remove' : 'Delete',
    danger: true,
  });
  if (!ok) return;
  // The viewer moves on from them now: they're deleted here, not "deleted elsewhere".
  for (const f of allFiles) dropFromViewer(f.id);
  const ids = [...folderIds, ...fileIds];
  setPending(ids, 'deleting');
  const copies = allFiles.map((f) => f.blob);
  try {
    await ensureDrive();
    // Out of the vault first, with a note of the encrypted copies still to delete: if deleting
    // them fails now, a later sync finishes the job.
    await commit({ op: 'batch', changes: [{ op: 'remove', folders: allFolders, files: allFiles.map((f) => f.id) }, ...(copies.length ? [{ op: 'trash-add', names: copies }] : [])] });
  } catch (err) {
    setPending(ids, null);
    throw err;
  }
  setPending(ids, null);
  clearSelection();
  toast(gone ? 'Removed from your vault' : allFiles.length + allFolders.length === 1 ? 'Deleted' : `Deleted ${allFiles.length + allFolders.length} items`);
  const left = await deleteCopies(copies);
  if (left.length) toast(`Deleted from Secure Box. ${left.length === 1 ? 'Its encrypted copy' : `${left.length} encrypted copies`} couldn’t be removed yet: Secure Box tries again on the next sync.`, 'error');
}

/** Deletes encrypted copies, by name; returns the ones that couldn't be deleted (they stay on the vault's list). */
async function deleteCopies(names) {
  if (!names.length) return [];
  const backend = state.backend;
  // A copy a file uses again (restored from a backup, or brought back by a change from another
  // device) is never deleted: it just comes off the list.
  const inUse = copiesInUse(vault());
  const done = names.filter((name) => inUse.has(name));
  const left = [];
  // A few at a time, as many as uploads (thousands of files deleted at once don't take hours).
  const todo = names.filter((n) => !inUse.has(n));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const name = todo[next++];
      try {
        await backend.trash(name);
        done.push(name);
      } catch (err) {
        // Gone already counts as done.
        if (err?.status === 404 || err?.code === 'not-found') done.push(name);
        else {
          console.warn('Delete: the encrypted copy stayed', name, err);
          left.push(name);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel(), todo.length) }, worker));
  if (done.length && state.backend === backend) await commit({ op: 'trash-done', names: done }).catch((err) => console.warn('Trash list:', err));
  return left;
}

let retrying = false;

/** Encrypted copies left over from earlier deletes: try again (after unlocking and syncing). */
export async function retryTrash() {
  const names = vault()?.trash || [];
  if (!names.length || retrying || !state.unlocked || !driveFresh(60_000)) return;
  retrying = true;
  try {
    await deleteCopies([...names]);
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
// Saving an edited text file: in memory only, never on disk
// ===========================================================================
/**
 * Saves new contents (`bytes`) for the text file `base`. They're encrypted here with a fresh key
 * under the file's own id, into a new encrypted copy with a storage name of its own, so the old
 * copy is never overwritten in place. The file then points to the new copy, and the old one is
 * deleted like any deleted file (a later sync finishes the job if that fails now).
 * With `asNew` (the file changed or went away elsewhere meanwhile) the text becomes a new file in
 * the same folder. Resolves with the saved file's entry. If an edit was saved elsewhere at the
 * very same moment, nothing is replaced: this fails with code 'changed' (textedit.js asks).
 */
export async function saveTextFile(base, bytes, { asNew = false } = {}) {
  await ensureDrive();
  const current = asNew ? null : fileById(base.id);
  const folder = current ? current.folder : folderById(base.folder) ? base.folder : null;
  const id = current ? current.id : crypto.randomUUID();
  const name = current ? current.name : uniqueName(base.name, index().filesIn(folder).map((f) => f.name));
  const type = base.type || 'text/plain';
  const file = new File([bytes], name, { type, lastModified: Date.now() });
  const plan = layout({ size: file.size, thumbBytes: 0 });
  const backend = state.backend;
  const blob = crypto.randomUUID(); // the new copy's name, recorded in the vault (vault.js, cleanFile)
  const send = await backend.openUpload({ name: blob, size: plan.total });
  const writer = createPieceWriter({ total: plan.total, send, pieceSize: send.pieceSize });
  let meta;
  try {
    meta = await encryptFile({ file, fileId: id, thumbnail: null, write: (piece) => writer.write(piece) });
  } catch (err) {
    await send.abort?.();
    throw err;
  }
  const entry = makeFileEntry({ id, name, type, size: file.size, folder, blob, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes }, current);
  const old = current?.blob;
  // The new copy goes into the file as it is now (a rename elsewhere meanwhile stays), and only if
  // its copy is still the one this edit started from; one deleted meanwhile comes back with it.
  const change = current
    ? { op: 'file-update', id, ifBlob: old, fields: { type, size: file.size, blob, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes, updated: entry.updated }, orAdd: entry }
    : { op: 'file-put', file: entry };
  try {
    await commit({ op: 'batch', changes: [change, ...(old ? [{ op: 'trash-add', names: [old] }] : [])] });
  } catch (err) {
    // Not saved: the new copy goes again, and the file stays as it was.
    if (state.backend === backend) await backend.trash(blob).catch(() => {});
    throw err;
  }
  if (fileById(id)?.blob !== blob) {
    // Another edit was saved elsewhere at the same moment, and stays: this copy goes again.
    if (state.backend === backend) await backend.trash(blob).catch(() => {});
    throw Object.assign(new Error('This file was saved on another device or in another window at the same moment.'), { code: 'changed' });
  }
  forgetStreams(); // the open file now reads from its new copy
  if (old) deleteCopies([old]).catch((err) => console.warn('Old copy:', err));
  return entry;
}

// ===========================================================================
// Uploads
// ===========================================================================
const tasks = [];
const ACTIVE = new Set(['queued', 'preparing', 'uploading', 'saving', 'paused']);
const RUNNING = new Set(['queued', 'preparing', 'uploading', 'saving']);
let running = 0; // uploads sending their encrypted copy right now (not the ones going into the vault)
let reading = 0; // dropped folders still being read: their files are queued as they're found
let drops = 0; // bumped by Stop all: a dropped folder still being read stops there
let stoppedFor = ''; // the storage is full: nothing else starts until you retry
const parallel = () => (state.backend?.kind === 'local' ? 2 : 3);

// What's waiting to start, oldest first, taken from the front, so starting the next of thousands
// doesn't go through all of them each time. It may still hold some that were cancelled since.
let waiting = [];
let head = 0;
const queueUp = (task) => waiting.push(task);
function nextWaiting() {
  while (head < waiting.length) {
    const task = waiting[head++];
    if (task.status === 'queued') return task;
  }
  waiting = [];
  head = 0;
  return null;
}

// What the tray shows: a row for each upload, made again only when that upload changed, and the
// totals, at most every 150 ms however many files are going.
let snapTimer = 0;
function rowOf(task) {
  const row = task.row;
  if (row && row.status === task.status && row.progress === task.progress && row.error === task.error) return row;
  task.type ??= guessType(task.file.name, task.file.type);
  task.row = { id: task.id, name: task.file.name, size: task.file.size, type: task.type, status: task.status, progress: task.progress, error: task.error, local: task.local };
  return task.row;
}
function snapshot() {
  clearTimeout(snapTimer);
  snapTimer = 0;
  const sum = { files: 0, active: 0, failed: 0, paused: 0, stopped: 0, finished: 0, bytes: 0, sent: 0, local: tasks.length > 0, reading: reading > 0 };
  const transfers = tasks.map((task) => {
    const row = rowOf(task);
    if (!row.local) sum.local = false;
    if (row.status === 'cancelled') {
      sum.stopped++;
      return row;
    }
    sum.files++;
    sum.bytes += row.size;
    sum.sent += row.size * (row.status === 'done' ? 1 : row.progress);
    if (row.status === 'done') sum.finished++;
    else if (row.status === 'error') sum.failed++;
    else if (row.status === 'paused') sum.paused++;
    else sum.active++;
    return row;
  });
  set({ transfers, summary: sum });
}
const snapSoon = () => {
  snapTimer ||= setTimeout(snapshot, 150);
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

/**
 * Files and folders dropped on the Files tab (or on a folder), with their folders. A dropped
 * folder of thousands starts uploading at once: its files are queued a batch at a time as
 * they're found, instead of after the whole folder has been read.
 */
export function uploadFromDrop(dataTransfer, target = get().folder) {
  // Entries must be read before the drop event finishes.
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...dataTransfer.files];
  if (!entries.length) {
    enqueue(plain.map((file) => ({ file, path: [] })), target);
    return;
  }
  reading++;
  const drop = drops;
  let found = [];
  let more = false; // a later batch of the same drop
  let sentAt = performance.now();
  const send = () => {
    if (drop !== drops) found = []; // stopped meanwhile
    if (found.length) enqueue(found, target, { more });
    more ||= found.length > 0;
    found = [];
    sentAt = performance.now();
  };
  const walk = async (entry, path) => {
    if (drop !== drops) throw new DOMException('Stopped.', 'AbortError');
    if (entry.isFile) {
      found.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path });
      if (found.length >= 200 || performance.now() - sentAt > 250) send();
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, [...path, entry.name]);
      }
    }
  };
  (async () => {
    for (const entry of entries) await walk(entry, []);
  })()
    .catch((err) => {
      if (err?.name !== 'AbortError') toast(err.message, 'error');
    })
    .finally(() => {
      send();
      reading--;
      snapSoon();
      pump(); // nothing more is coming from this drop
    });
}

/**
 * Queues files for the open vault. An item may carry `after()`, run once it's encrypted and
 * saved. Resolves when every item has finished, failed or stopped. `more`: another batch of
 * files from the same drop (when the storage filled up meanwhile, they stop too).
 */
export function enqueue(items, target = get().folder, { more = false } = {}) {
  if (!items.length) return Promise.resolve([]);
  if (!more) stoppedFor = '';
  const added = items.map(({ file, path, after }) => {
    const task = { id: crypto.randomUUID(), file, path, target, after, backend: state.backend, local: state.backend?.kind === 'local', progress: 0, status: 'queued', error: '', abort: new AbortController() };
    task.finished = new Promise((resolve) => {
      task.settle = resolve;
    });
    if (stoppedFor) {
      task.status = 'error';
      task.error = stoppedFor;
      task.settle('error');
    } else queueUp(task);
    return task;
  });
  for (const task of added) tasks.push(task);
  set({ tray: 'open' });
  snapshot();
  pump();
  return Promise.all(added.map((t) => t.finished));
}

function pump() {
  while (running < parallel()) {
    const task = nextWaiting();
    if (!task) break;
    if (task.backend !== state.backend) {
      // The vault changed: what's still waiting belonged to the one that closed.
      task.status = 'cancelled';
      task.settle('cancelled');
      continue;
    }
    if (!task.local && !driveFresh(2 * 60_000)) {
      task.status = 'paused';
      for (const t of tasks) if (t.status === 'queued') t.status = 'paused';
      snapSoon();
      break;
    }
    run(task);
  }
  if (!reading && !tasks.some((t) => ACTIVE.has(t.status))) {
    pathJobs.clear();
    if (tasks.length && tasks.every((t) => t.status === 'done')) setTimeout(clearFinished, 4000);
  }
}

/** An upload: its encrypted copy is sent, then it goes into the vault with others that finish about then. */
async function run(task) {
  running++;
  task.status = 'preparing';
  snapSoon();
  let entry = null;
  try {
    entry = await uploadOne(task);
  } catch (err) {
    failed(task, err);
  }
  running--;
  if (entry) {
    // The encrypted copy is stored: the next file starts while this one is saved to the vault.
    task.status = 'saving';
    task.progress = 1;
    snapSoon();
    pump();
    try {
      await saveEntry(entry, task.backend);
      task.status = 'done';
      if (task.after) await Promise.resolve().then(task.after).catch((err) => console.warn('After saving:', err));
    } catch (err) {
      failed(task, err);
    }
  }
  if (task.status !== 'paused') task.settle?.(task.status);
  snapSoon();
  pump();
}

/** An upload that didn't go through: stopped, waiting for a fresh sign-in, or failed. */
function failed(task, err) {
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
    const existing = index().foldersIn(parent).find((f) => f.name.toLowerCase() === name.toLowerCase());
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

/** Encrypts and stores one file's copy; resolves with its vault entry (not saved to the vault yet). */
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
  snapSoon();
  const { backend } = task;
  const send = await backend.openUpload({ name: id, size: plan.total, signal: task.abort.signal }); // stored under the file's own id
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
  return makeFileEntry({ id, name: file.name, type, size: file.size, folder, blob: id, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes });
}

// Saved to the vault together: while one save is under way, the files that finish meanwhile
// wait for the next one, so thousands of files make a few dozen vault saves instead of
// thousands (each save writes the whole vault, which grows with every file).
let batch = [];
let batchTimer = 0;
let saving = null; // the save under way

function saveEntry(entry, backend) {
  return new Promise((resolve, reject) => {
    batch.push({ entry, backend, resolve, reject });
    saveSoon();
  });
}

/** Saves what's waiting: now if nothing else is uploading, else within a second, to take in more. */
function saveSoon() {
  if (saving || !batch.length) return; // the next save goes once this one is done
  if (!running || batch.length >= 1000) flush();
  else batchTimer ||= setTimeout(flush, 1000);
}

/** Saves everything waiting to go into the vault now; resolves when the save under way is done. */
function flush() {
  clearTimeout(batchTimer);
  batchTimer = 0;
  if (saving || !batch.length) return saving || Promise.resolve();
  const items = batch;
  batch = [];
  saving = saveBatch(items)
    .catch((err) => {
      // Something unexpected: none of them is left waiting for ever.
      console.warn('Saving uploads:', err);
      for (const { reject } of items) reject(err);
    })
    .finally(() => {
      saving = null;
      saveSoon();
    });
  return saving;
}

async function saveBatch(items) {
  // Copies stored for a vault that's closed since (another one opened) never go into this one.
  const elsewhere = items.filter((it) => it.backend !== state.backend);
  for (const { entry, backend, reject } of elsewhere) {
    backend.trash(entry.blob).catch(() => {});
    reject(new Error('Another vault was opened before this file was saved.'));
  }
  items = items.filter((it) => it.backend === state.backend);
  if (!items.length) return;
  const { filesIn } = index();
  const names = new Map(); // folder -> { taken, counters }: the names there, as each file takes one
  const changes = items.map(({ entry }) => {
    let here = names.get(entry.folder);
    if (!here) names.set(entry.folder, (here = { taken: new Set(filesIn(entry.folder).map((f) => f.name.toLowerCase())), counters: new Map() }));
    const name = uniqueNameWhere(entry.name, (lower) => here.taken.has(lower), { counters: here.counters });
    here.taken.add(name.toLowerCase());
    return { op: 'file-put', file: { ...entry, name } };
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await commit({ op: 'batch', changes });
      break;
    } catch (err) {
      // A passing failure (offline for a moment, the cloud busy): tried again before giving up,
      // as a save holds many files.
      if (transient(err) && attempt < 3 && state.backend === items[0].backend) {
        await pause(backoff(attempt));
        continue;
      }
      for (const { entry, backend, reject } of items) {
        backend.trash(entry.blob).catch(() => {});
        reject(err);
      }
      return;
    }
  }
  // A folder deleted meanwhile in another window or device: those files are in All files now.
  const moved = changes.filter((c) => c.file.folder && fileById(c.file.id)?.folder !== c.file.folder);
  if (moved.length) toast(`${moved.length === 1 ? `“${moved[0].file.name}” was` : `${moved.length} files were`} saved in ${ROOT_NAME}: the folder ${moved.length === 1 ? 'it was going to' : 'they were going to'} was deleted meanwhile.`);
  for (const { resolve } of items) resolve();
}

function requeue(task) {
  Object.assign(task, { status: 'queued', progress: 0, error: '', abort: new AbortController(), backend: state.backend });
  task.finished = new Promise((resolve) => {
    task.settle = resolve;
  });
  queueUp(task);
}

export function retryTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  requeue(task);
  stoppedFor = '';
  snapshot();
  pump();
}

/** The tray's Retry all: every upload that failed goes again. */
export function retryFailed() {
  for (const task of tasks) if (task.status === 'error') requeue(task);
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
      queueUp(t);
    }
  }
  snapshot();
  pump();
}

export function clearFinished() {
  if (reading || tasks.some((t) => ACTIVE.has(t.status))) return;
  const keep = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  tasks.length = 0;
  for (const task of keep) tasks.push(task);
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
  waiting = [];
  head = 0;
  snapshot();
}

export const toggleTray = () => set({ tray: get().tray === 'open' ? 'collapsed' : 'open' });

/** Stops every upload, and resolves once all of them have stopped. */
export async function stopAll() {
  drops++;
  const live = tasks.filter((t) => ACTIVE.has(t.status));
  for (const task of live) cancelTask(task.id);
  await Promise.all(live.map((t) => t.finished));
}

const unfinished = () => reading > 0 || tasks.some((t) => ACTIVE.has(t.status));

// Leaving the page while files are still uploading or downloading (or saving here), or with a
// text file's changes unsaved, asks first: a download needs a Secure Box window for its keys
// (and, from a vault on this device, for its bytes), so closing the last one stops it. A lock
// never asks: it must always go through, and the lock button has asked already when it should.
window.addEventListener('beforeunload', (event) => {
  if (state.unlocked && (unfinished() || downloadsUnderWay() > 0 || state.device.busy || state.moving || editingDirty())) event.preventDefault();
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
  /** Uploads whose encrypted copy is stored, saved to the vault now (before locking, say). */
  async saveWaiting() {
    for (let i = 0; i < 3 && (saving || batch.length); i++) await (saving || flush());
  },
  checkCopies,
  /** Another vault opened: start at the top, nothing chosen. */
  reset() {
    set({ folder: null, query: '', selected: new Set(), anchor: null, pending: new Map(), missing: new Set() });
    releaseUrls();
    forgetThumbs();
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
