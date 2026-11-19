/**
 * Files section: a file manager over the encrypted index in the vault. File names and folders
 * only exist inside the vault; Google Drive just holds opaque, randomly named blobs.
 */
import { MAX_FILE_SIZE, createPieceWriter, decryptFile, encryptFile, layout } from './fileformat.js';
import { canThumbnail, formatBytes, guessType, kindOf, typeLabel } from './filetypes.js';
import { fileUrl, zipUrl } from './stream.js';
import { makeThumbnail } from './thumbs.js';
import { $, $$, confirmDialog, downloadFile, h, icon, relativeTime, toast } from './ui.js';
import { collectTree, folderChain, makeFileEntry, makeFolder, uniqueName } from './vault.js';
import { createViewer } from './viewer.js';

export const KIND_ICON = { image: 'image', video: 'video', audio: 'audio', pdf: 'file', doc: 'note', sheet: 'sheet', slides: 'slides', code: 'code', text: 'note', archive: 'archive', other: 'file' };
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function pref(key, fallback, allowed) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
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

/** `name`, or "name (2).ext", "name (3).ext"… if a sibling in the ZIP already has it. */
function uniqueZipName(taken, name, isFile) {
  const dot = isFile ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let pick = name;
  for (let n = 2; taken.has(pick.toLowerCase()); n++) pick = `${stem} (${n})${ext}`;
  taken.add(pick.toLowerCase());
  return pick;
}

const timeOf = (item) => {
  const t = new Date(item.updated || item.created || Date.now()).getTime();
  return Number.isFinite(t) ? t : Date.now();
};

/**
 * `ctx.cloud` is the Google Drive store; the local vault's store can be switched in with
 * useStore(). A store is { kind: 'cloud'|'local', getVault(), commit(change), backend(),
 * ensure(), fresh(ms) }, and each one keeps its own folder, search and selection.
 */
export function createFilesView(ctx) {
  let store = ctx.cloud;
  const navs = new WeakMap();
  const view = {
    folder: null,
    query: '',
    selected: new Set(),
    anchor: null,
    layout: pref('unibox.filesLayout', 'grid', ['grid', 'list']),
    sort: pref('unibox.filesSort', 'name', ['name', 'updated', 'size', 'type']),
    // Off by default: while off, no thumbnail is fetched or decrypted at all.
    thumbs: pref('unibox.thumbnails', 'off', ['on', 'off']) === 'on',
  };
  const transfers = [];
  let processing = false;
  const vault = () => store.getVault();
  const isLocal = () => store.kind === 'local';
  const rootName = () => (isLocal() ? 'Local vault' : 'All files');
  const folderById = (id) => vault().folders.find((f) => f.id === id);
  const fileById = (id) => vault().files.find((f) => f.id === id);

  // ---------------------------------------------------------------------------
  // Reading files (streamed through the service worker, or decrypted in the page)
  // ---------------------------------------------------------------------------
  const objectUrls = new Map();

  async function decryptHere(file, part = 'content') {
    const plan = layout({ size: file.size, thumbBytes: file.thumbBytes, chunk: file.chunk });
    const end = part === 'thumb' ? plan.contentStart - 1 : plan.total - 1;
    const stream = await store.backend().readRange(file.driveId, 0, end);
    return decryptFile(stream, file, { part });
  }

  async function sourceUrl(file) {
    if (ctx.streaming()) return fileUrl(file.id);
    if (!objectUrls.has(file.id)) objectUrls.set(file.id, URL.createObjectURL(new Blob(await decryptHere(file), { type: file.type })));
    return objectUrls.get(file.id);
  }

  async function fetchBytes(file) {
    if (ctx.streaming()) {
      const res = await fetch(fileUrl(file.id), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 401 ? 'Google access expired. Reconnect and try again.' : await res.text());
      return res.arrayBuffer();
    }
    return new Blob(await decryptHere(file)).arrayBuffer();
  }

  /** Plaintext bytes [start, end] of a file (used to sniff unknown types). */
  async function fetchRange(file, start, end) {
    if (ctx.streaming()) {
      const res = await fetch(fileUrl(file.id), { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 401 ? 'Google access expired. Reconnect and try again.' : await res.text());
      return new Uint8Array(await res.arrayBuffer());
    }
    return new Uint8Array(await new Blob(await decryptHere(file)).arrayBuffer()).subarray(start, end + 1);
  }

  function releaseUrls() {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  /**
   * Hands a service-worker URL to the browser as a download. Chrome can send <a download>
   * clicks straight to the web server, skipping the worker (and so failing with "File wasn't
   * available on site"); a navigation in a hidden frame always reaches the worker. If the
   * worker answers with an error instead of a file, the frame shows its text: pass it on.
   */
  function downloadViaWorker(url) {
    const frame = h('iframe', { hidden: true, title: 'Download', 'aria-hidden': 'true', tabindex: '-1' });
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

  async function download(file) {
    await store.ensure();
    // The worker streams the decrypted file straight into the browser's download.
    if (ctx.streaming()) downloadViaWorker(fileUrl(file.id, { download: true }));
    else downloadFile(file.name, new Blob(await decryptHere(file), { type: file.type }), file.type);
  }

  async function downloadEach(list) {
    if (list.length > 10 && !(await confirmDialog({ title: `Download ${list.length} files?`, message: 'Each file is decrypted and saved separately. Your browser may ask to allow multiple downloads.', confirmLabel: 'Download' }))) return;
    for (const file of list) {
      await download(file);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** ZIP entries for selected folders (with everything inside) and files, in a stable order. */
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
    // A folder or file that is already inside another selected folder isn't added twice.
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
  async function downloadZip(folderIds, fileIds) {
    const entries = zipEntries(folderIds, fileIds);
    const files = entries.filter((e) => !e.dir);
    if (!files.length) return toast('Nothing to download: the selected folders are empty.');
    // Without the streaming worker (for example in a private window), fall back to one file each.
    if (!ctx.streaming()) return downloadEach(files.map((e) => fileById(e.fileId)));
    await store.ensure();
    const single = folderIds.length === 1 && !fileIds.length ? folderById(folderIds[0]) : null;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = single ? `${zipName(single.name)}.zip` : `Secure Box ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
    downloadViaWorker(zipUrl({ name, entries }));
    const bytes = files.reduce((n, e) => n + e.size, 0);
    toast(`Downloading ${name}: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ${formatBytes(bytes)}`);
  }

  const viewer = createViewer({
    file: fileById,
    sourceUrl,
    fetchBytes,
    fetchRange,
    download,
    ensureDrive: () => store.ensure(),
    driveFresh: (ms) => store.fresh(ms),
    releaseUrls,
    folderPath: (file) => [rootName(), ...folderChain(vault(), file.folder).map((f) => f.name)].join(' / '),
    rename: (file) => renameEntry(file, false),
    move: (file) => moveEntries([], [file.id]),
    remove: (file) => deleteEntries([], [file.id]),
  });

  // ---------------------------------------------------------------------------
  // What is visible
  // ---------------------------------------------------------------------------
  function sortFiles(list) {
    const byName = (a, b) => collator.compare(a.name, b.name);
    const order = {
      name: byName,
      updated: (a, b) => b.updated - a.updated || byName(a, b),
      size: (a, b) => b.size - a.size || byName(a, b),
      type: (a, b) => collator.compare(kindOf(a), kindOf(b)) || byName(a, b),
    }[view.sort];
    return list.sort(order);
  }

  function visible() {
    const v = vault();
    const terms = view.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) {
      const match = (name) => terms.every((t) => name.toLowerCase().includes(t));
      return {
        folders: v.folders.filter((f) => match(f.name)).sort((a, b) => collator.compare(a.name, b.name)),
        files: sortFiles(v.files.filter((f) => match(f.name))),
      };
    }
    return {
      folders: v.folders.filter((f) => f.parent === view.folder).sort((a, b) => collator.compare(a.name, b.name)),
      files: sortFiles(v.files.filter((f) => f.folder === view.folder)),
    };
  }

  function folderStats(folderId) {
    const { folderIds, files } = collectTree(vault(), folderId);
    return { folders: folderIds.length - 1, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render() {
    if (view.folder && !folderById(view.folder)) view.folder = null;
    for (const id of [...view.selected]) if (!fileById(id) && !folderById(id)) view.selected.delete(id);
    renderCrumbs();
    renderBody();
    renderSelection();
    for (const radio of $$('input[name="files-layout"]')) radio.checked = radio.value === view.layout;
    $('#files-sort').value = view.sort;
    $('#thumbs-toggle').checked = view.thumbs;
  }

  function dropTarget(el, folderId) {
    el.addEventListener('dragover', (event) => {
      if (![...event.dataTransfer.types].includes('application/x-unibox') && ![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      el.classList.add('is-drop');
      $('#drop-overlay').hidden = true;
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.classList.remove('is-drop');
      $('#drop-overlay').hidden = true;
      const moving = event.dataTransfer.getData('application/x-unibox');
      if (moving) {
        const { folders, files } = JSON.parse(moving);
        moveEntries(folders, files, folderId).catch((err) => toast(err.message, 'error'));
      } else uploadFromDrop(event.dataTransfer, folderId);
    });
  }

  function renderCrumbs() {
    const nav = $('#crumbs');
    const chain = view.query ? [] : folderChain(vault(), view.folder);
    const crumb = (label, id, current) => {
      const b = h('button', { type: 'button', class: `crumb${current ? ' is-current' : ''}`, 'aria-current': current ? 'page' : null, onclick: () => openFolder(id) }, id === null ? icon('home', 16) : null, h('span', { text: label }));
      dropTarget(b, id);
      return b;
    };
    const parts = [crumb(rootName(), null, !view.query && !view.folder)];
    chain.forEach((folder, i) => {
      parts.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevronRight', 14)));
      parts.push(crumb(folder.name, folder.id, i === chain.length - 1));
    });
    if (view.query) parts.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevronRight', 14)), h('span', { class: 'crumb is-current', text: `Search “${view.query.trim()}”` }));
    nav.replaceChildren(...parts);
    nav.title = view.query ? `Search “${view.query.trim()}”` : [rootName(), ...chain.map((f) => f.name)].join(' › ');
    nav.scrollLeft = nav.scrollWidth; // a long path keeps its current folder in view
    updateCrumbFades();
  }

  /** Soft fades show that a long path carries on past the left or right edge. */
  function updateCrumbFades() {
    const nav = $('#crumbs');
    const hidden = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle('fade-start', hidden > 1 && nav.scrollLeft > 1);
    nav.classList.toggle('fade-end', hidden > 1 && hidden - nav.scrollLeft > 1);
  }

  function art(entry, isFolder, size = 'lg') {
    if (isFolder) return h('span', { class: `file-art kind-folder art-${size}` }, icon('folder', size === 'lg' ? 40 : 20));
    const kind = kindOf(entry);
    const box = h('span', { class: `file-art kind-${kind} art-${size}` }, icon(KIND_ICON[kind], size === 'lg' ? 34 : 18));
    if (view.thumbs && entry.thumbBytes && ctx.streaming()) {
      const img = h('img', { src: fileUrl(entry.id, { thumb: true }), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      img.addEventListener('load', () => box.classList.add('has-thumb'));
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    if (kind === 'video' && size === 'lg') box.append(h('span', { class: 'play-badge', 'aria-hidden': 'true' }, icon('play', 14)));
    return box;
  }

  function itemNode(entry, isFolder) {
    const selected = view.selected.has(entry.id);
    const stats = isFolder ? folderStats(entry.id) : null;
    const meta = isFolder
      ? `${stats.files + stats.folders} ${stats.files + stats.folders === 1 ? 'item' : 'items'}`
      : `${formatBytes(entry.size)} · ${relativeTime(entry.updated)}`;
    const check = h('span', { class: 'item-check', role: 'checkbox', 'aria-checked': String(selected), 'aria-label': `Select ${entry.name}`, tabindex: '-1' }, icon('check', 14));
    const more = h('button', { type: 'button', class: 'icon-btn item-more', 'aria-label': `Actions for ${entry.name}`, title: 'Actions' }, icon('more'));
    const node =
      view.layout === 'grid'
        ? h('div', { class: `tile${selected ? ' is-selected' : ''}`, tabindex: '0', role: 'gridcell', draggable: 'true', dataset: { id: entry.id, folder: isFolder ? '1' : '' } },
            check, more, art(entry, isFolder),
            h('span', { class: 'tile-name', text: entry.name, title: entry.name }),
            h('span', { class: 'tile-meta', text: meta }))
        : h('div', { class: `frow${selected ? ' is-selected' : ''}`, tabindex: '0', role: 'row', draggable: 'true', dataset: { id: entry.id, folder: isFolder ? '1' : '' } },
            check, art(entry, isFolder, 'sm'),
            h('span', { class: 'frow-name', text: entry.name, title: entry.name }),
            h('span', { class: 'frow-kind', text: isFolder ? 'Folder' : typeLabel(entry) }),
            h('span', { class: 'frow-size', text: isFolder ? `${stats.files} ${stats.files === 1 ? 'file' : 'files'}` : formatBytes(entry.size) }),
            h('span', { class: 'frow-date', text: relativeTime(entry.updated) }),
            more);
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSelect(entry.id);
    });
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      openItemMenu(more, entry, isFolder);
    });
    node.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) toggleSelect(entry.id);
      else if (event.shiftKey) selectRange(entry.id);
      else if (view.selected.size) toggleSelect(entry.id);
      else openEntry(entry, isFolder);
    });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openEntry(entry, isFolder);
      else if (event.key === ' ') {
        event.preventDefault();
        toggleSelect(entry.id);
      } else if (event.key === 'F2') renameEntry(entry, isFolder);
      else if (event.key === 'Delete') deleteSelectionOr(entry, isFolder);
      else if (event.key.startsWith('Arrow')) moveFocus(node, event);
    });
    node.addEventListener('dragstart', (event) => {
      const ids = view.selected.has(entry.id) ? [...view.selected] : [entry.id];
      const payload = { folders: ids.filter((id) => folderById(id)), files: ids.filter((id) => fileById(id)) };
      event.dataTransfer.setData('application/x-unibox', JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'move';
      node.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('is-dragging'));
    if (isFolder) dropTarget(node, entry.id);
    return node;
  }

  function renderBody() {
    const body = $('#files-body');
    const { folders, files } = visible();
    body.className = `files-body layout-${view.layout}`;
    const count = folders.length + files.length;
    const bytes = files.reduce((n, f) => n + f.size, 0);
    $('#files-count').textContent = `${count} ${count === 1 ? 'item' : 'items'}${files.length ? ` · ${formatBytes(bytes)}` : ''}`;
    if (!count) {
      body.replaceChildren(
        h('div', { class: 'files-empty' },
          h('div', { class: 'empty-icon' }, icon(view.query ? 'search' : 'upload', 22)),
          h('p', { class: 'empty-title', text: view.query ? 'No matching files' : view.folder ? 'This folder is empty' : 'No files yet' }),
          h('p', {
            text: view.query
              ? 'Try another name.'
              : isLocal()
                ? 'Drop files or folders here, or use Upload. They’re encrypted and kept on this device only.'
                : 'Drop files or folders here, or use Upload. They are encrypted before they leave this browser.',
          }),
          view.query ? null : h('div', { class: 'files-empty-actions' },
            h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { action: 'upload-files' } }, icon('upload', 16), h('span', { text: 'Upload files' })),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { action: 'new-folder' } }, icon('folderPlus', 16), h('span', { text: 'New folder' })))),
      );
      return;
    }
    const nodes = [...folders.map((f) => itemNode(f, true)), ...files.map((f) => itemNode(f, false))];
    if (view.layout === 'list') {
      nodes.unshift(
        h('div', { class: 'frow frow-head', role: 'row' }, h('span'), h('span'), h('span', { text: 'Name' }), h('span', { class: 'frow-kind', text: 'Kind' }), h('span', { class: 'frow-size', text: 'Size' }), h('span', { class: 'frow-date', text: 'Modified' }), h('span')),
      );
    }
    body.replaceChildren(...nodes);
  }

  function renderSelection() {
    const bar = $('#selection-bar');
    bar.hidden = view.selected.size === 0;
    $('#selection-count').textContent = `${view.selected.size} selected`;
    $('#files-view').classList.toggle('has-selection', view.selected.size > 0);
  }

  function moveFocus(node, event) {
    const items = $$('#files-body [data-id]');
    const index = items.indexOf(node);
    let step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    if (view.layout === 'grid' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const columns = Math.max(1, Math.round($('#files-body').clientWidth / node.offsetWidth));
      step *= columns;
    }
    const next = items[Math.min(items.length - 1, Math.max(0, index + step))];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation & selection
  // ---------------------------------------------------------------------------
  /** `push: false` when the browser's Back or Forward brought us here (no new history entry). */
  function openFolder(id, { push = true } = {}) {
    const moved = view.folder !== id || view.query;
    view.folder = id;
    view.query = '';
    $('#search').value = '';
    view.selected.clear();
    render();
    $('#files-body').scrollTop = 0;
    if (push && moved) ctx.onNavigate?.();
  }

  function openEntry(entry, isFolder) {
    if (isFolder) return openFolder(entry.id);
    const { files } = visible();
    viewer.open(entry.id, files.map((f) => f.id));
  }

  function toggleSelect(id) {
    if (view.selected.has(id)) view.selected.delete(id);
    else view.selected.add(id);
    view.anchor = id;
    render();
  }

  function selectRange(id) {
    const ids = $$('#files-body [data-id]').map((n) => n.dataset.id);
    const a = ids.indexOf(view.anchor ?? id);
    const b = ids.indexOf(id);
    for (const pick of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) view.selected.add(pick);
    render();
  }

  function selection() {
    const ids = [...view.selected];
    return { folders: ids.filter((id) => folderById(id)), files: ids.filter((id) => fileById(id)) };
  }

  function openItemMenu(anchor, entry, isFolder) {
    const menu = $('#item-menu');
    const item = (label, iconName, run, danger = false) =>
      h('button', { type: 'button', class: `menu-item${danger ? ' menu-danger' : ''}`, onclick: () => { menu.hidePopover(); run(); } }, icon(iconName), h('span', { text: label }));
    menu.replaceChildren(
      item(isFolder ? 'Open' : 'Open in viewer', isFolder ? 'folder' : 'eye', () => openEntry(entry, isFolder)),
      isFolder
        ? item('Download as .zip', 'download', () => downloadZip([entry.id], []).catch((e) => toast(e.message, 'error')))
        : item('Download', 'download', () => download(entry).catch((e) => toast(e.message, 'error'))),
      item('Rename', 'edit', () => renameEntry(entry, isFolder)),
      item('Move to…', 'move', () => moveEntries(isFolder ? [entry.id] : [], isFolder ? [] : [entry.id])),
      h('div', { class: 'menu-sep', role: 'separator' }),
      item('Delete', 'trash', () => deleteEntries(isFolder ? [entry.id] : [], isFolder ? [] : [entry.id]), true),
    );
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(Math.min(rect.bottom + 6, window.innerHeight - 240))}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)))}px`;
    menu.showPopover();
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------
  function promptDialog({ title, label, value = '', confirmLabel = 'Save', selectStem = false }) {
    const dialog = $('#prompt');
    const input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    $('#prompt-label').textContent = label;
    $('#prompt-ok').textContent = confirmLabel;
    input.value = value;
    return new Promise((resolve) => {
      dialog.returnValue = '';
      const onKey = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          dialog.close('ok');
        }
      };
      input.addEventListener('keydown', onKey);
      dialog.addEventListener(
        'close',
        () => {
          input.removeEventListener('keydown', onKey);
          resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
        },
        { once: true },
      );
      dialog.showModal();
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
    });
  }

  function chooseFolder({ title, exclude }) {
    const dialog = $('#move');
    const tree = $('#move-tree');
    $('#move-title').textContent = title;
    let choice = view.folder;
    const rows = [];
    const add = (folder, depth) => {
      const id = folder ? folder.id : null;
      const blocked = folder && exclude.has(folder.id);
      const row = h('button', {
        type: 'button',
        class: `tree-row${id === choice ? ' is-selected' : ''}`,
        disabled: blocked || null,
        dataset: { id: id ?? '' },
        onclick: () => {
          choice = id;
          for (const r of rows) r.classList.toggle('is-selected', r === row);
        },
      }, icon(folder ? 'folder' : 'home', 16), h('span', { text: folder ? folder.name : rootName() }));
      row.style.setProperty('--depth', String(depth));
      rows.push(row);
      if (blocked) return;
      for (const child of vault().folders.filter((f) => f.parent === id).sort((a, b) => collator.compare(a.name, b.name))) add(child, depth + 1);
    };
    add(null, 0);
    tree.replaceChildren(...rows);
    return new Promise((resolve) => {
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? choice : undefined), { once: true });
      dialog.showModal();
    });
  }

  // ---------------------------------------------------------------------------
  // Changes
  // ---------------------------------------------------------------------------
  async function newFolder() {
    const name = await promptDialog({ title: 'New folder', label: 'Folder name', value: 'Untitled folder', confirmLabel: 'Create' });
    if (!name) return;
    await store.ensure();
    const siblings = vault().folders.filter((f) => f.parent === view.folder).map((f) => f.name);
    await store.commit({ op: 'folder-put', folder: makeFolder({ name: uniqueName(name, siblings, { isFolder: true }), parent: view.folder }) });
    render();
  }

  async function renameEntry(entry, isFolder) {
    const name = await promptDialog({ title: isFolder ? 'Rename folder' : 'Rename file', label: 'Name', value: entry.name, confirmLabel: 'Rename', selectStem: !isFolder });
    if (!name || name === entry.name) return;
    await store.ensure();
    if (isFolder) {
      const siblings = vault().folders.filter((f) => f.parent === entry.parent && f.id !== entry.id).map((f) => f.name);
      await store.commit({ op: 'folder-put', folder: makeFolder({ name: uniqueName(name, siblings, { isFolder: true }), parent: entry.parent }, entry) });
    } else {
      const siblings = vault().files.filter((f) => f.folder === entry.folder && f.id !== entry.id).map((f) => f.name);
      await store.commit({ op: 'file-put', file: makeFileEntry({ name: uniqueName(name, siblings), type: guessType(name, entry.type) }, entry) });
    }
    ctx.onChange();
  }

  async function moveEntries(folderIds, fileIds, target) {
    if (!folderIds.length && !fileIds.length) return;
    const blocked = new Set(folderIds.flatMap((id) => collectTree(vault(), id).folderIds));
    if (target === undefined) {
      const count = folderIds.length + fileIds.length;
      const only = count === 1 ? (folderById(folderIds[0]) || fileById(fileIds[0])).name : `${count} items`;
      target = await chooseFolder({ title: `Move “${only}” to…`, exclude: blocked });
      if (target === undefined) return;
    }
    if (target !== null && blocked.has(target)) return toast('A folder can’t be moved into itself.', 'error');
    await store.ensure();
    const v = vault();
    const changes = [];
    const takenFolders = v.folders.filter((f) => f.parent === target && !folderIds.includes(f.id)).map((f) => f.name);
    for (const id of folderIds) {
      const folder = folderById(id);
      if (folder.parent === target) continue;
      const name = uniqueName(folder.name, takenFolders, { isFolder: true });
      takenFolders.push(name);
      changes.push({ op: 'folder-put', folder: makeFolder({ name, parent: target }, folder) });
    }
    const takenFiles = v.files.filter((f) => f.folder === target && !fileIds.includes(f.id)).map((f) => f.name);
    for (const id of fileIds) {
      const file = fileById(id);
      if (file.folder === target) continue;
      const name = uniqueName(file.name, takenFiles);
      takenFiles.push(name);
      changes.push({ op: 'file-put', file: makeFileEntry({ name, folder: target }, file) });
    }
    if (!changes.length) return;
    await store.commit({ op: 'batch', changes });
    view.selected.clear();
    ctx.onChange();
    toast(`Moved to ${target ? folderById(target).name : rootName()}`);
  }

  async function deleteEntries(folderIds, fileIds) {
    const trees = folderIds.map((id) => collectTree(vault(), id));
    const allFolders = [...new Set(trees.flatMap((t) => t.folderIds))];
    const allFiles = [...new Map([...trees.flatMap((t) => t.files), ...fileIds.map(fileById)].map((f) => [f.id, f])).values()];
    const label =
      folderIds.length + fileIds.length === 1
        ? `“${(folderById(folderIds[0]) || fileById(fileIds[0])).name}”`
        : `${folderIds.length + fileIds.length} items`;
    const inside = folderIds.length && allFiles.length ? ` and the ${allFiles.length} ${allFiles.length === 1 ? 'file' : 'files'} inside` : '';
    const ok = await confirmDialog({
      title: `Delete ${label}?`,
      message: isLocal()
        ? `This deletes ${label}${inside} from the local vault on this device. It can’t be undone.`
        : `This removes ${label}${inside} from Secure Box on every device. The encrypted copies go to your Google Drive trash.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await store.ensure();
    await store.commit({ op: 'remove', folders: allFolders, files: allFiles.map((f) => f.id) });
    view.selected.clear();
    ctx.onChange();
    toast(allFiles.length + allFolders.length === 1 ? 'Deleted' : `Deleted ${allFiles.length + allFolders.length} items`);
    for (const file of allFiles) await store.backend().trash(file.driveId).catch(() => {});
  }

  function deleteSelectionOr(entry, isFolder) {
    const sel = selection();
    if (sel.folders.length || sel.files.length) return deleteEntries(sel.folders, sel.files);
    return deleteEntries(isFolder ? [entry.id] : [], isFolder ? [] : [entry.id]);
  }

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------
  function pickMany({ directory = false } = {}) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', multiple: true, hidden: true });
      if (directory) input.webkitdirectory = true;
      const finish = () => {
        resolve([...(input.files || [])]);
        input.remove();
      };
      input.addEventListener('change', finish, { once: true });
      input.addEventListener('cancel', finish, { once: true });
      document.body.append(input);
      input.click();
    });
  }

  async function upload({ directory = false } = {}) {
    if (!store.fresh(10 * 60_000)) {
      await store.ensure(); // reconnect first; the file picker needs a fresh click
      return toast('Reconnected — choose Upload again.');
    }
    const target = view.folder;
    const picked = await pickMany({ directory });
    enqueue(picked.map((file) => ({ file, path: directory ? file.webkitRelativePath.split('/').slice(0, -1) : [] })), target);
  }

  function uploadFromDrop(dataTransfer, target = view.folder) {
    // Entries must be read synchronously, before the drop event finishes.
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
   * Queues files for store `s` (the one showing, by default). An item may carry `after()`, run
   * once it's encrypted and saved. Resolves when every item has finished, failed or stopped.
   */
  function enqueue(items, target, s = store) {
    if (!items.length) return Promise.resolve([]);
    const added = items.map(({ file, path, after }) => {
      const task = { id: crypto.randomUUID(), file, path, target, store: s, after, progress: 0, status: 'queued', error: '', abort: new AbortController() };
      task.finished = new Promise((resolve) => {
        task.settle = resolve;
      });
      return task;
    });
    transfers.push(...added);
    renderTransfers();
    processQueue();
    return Promise.all(added.map((t) => t.finished));
  }

  const folderCache = new Map();
  async function ensurePath(s, target, path) {
    let parent = target;
    for (const name of path) {
      const key = `${s.kind}:${parent}/${name.toLowerCase()}`;
      const folders = () => s.getVault().folders;
      let folder = folders().find((f) => f.parent === parent && f.name.toLowerCase() === name.toLowerCase());
      if (!folder && folderCache.has(key)) folder = folders().find((f) => f.id === folderCache.get(key));
      if (!folder) {
        folder = makeFolder({ name, parent });
        await s.commit({ op: 'folder-put', folder });
        folderCache.set(key, folder.id);
      }
      parent = folder.id;
    }
    return parent;
  }

  async function uploadOne(task) {
    const { file, store: s } = task;
    if (file.size > MAX_FILE_SIZE) throw new Error(`Files up to ${formatBytes(MAX_FILE_SIZE)} are supported.`);
    const folder = await ensurePath(s, task.target, task.path);
    const id = crypto.randomUUID();
    const type = guessType(file.name, file.type);
    task.status = 'preparing';
    renderTransfers();
    const thumbnail = canThumbnail({ name: file.name, type }) ? await makeThumbnail(file, type) : null;
    const plan = layout({ size: file.size, thumbBytes: thumbnail?.length || 0 });
    task.status = 'uploading';
    const send = await s.backend().openUpload({ fid: id, size: plan.total });
    const writer = createPieceWriter({
      total: plan.total,
      send,
      onProgress: (p) => {
        task.progress = p;
        updateTransfer(task);
      },
    });
    let meta;
    try {
      meta = await encryptFile({ file, fileId: id, thumbnail, write: (bytes) => writer.write(bytes), signal: task.abort.signal });
    } catch (err) {
      await send.abort?.(); // the local vault drops its half-written file
      throw err;
    }
    const driveId = writer.result;
    const siblings = s.getVault().files.filter((f) => f.folder === folder).map((f) => f.name);
    const entry = makeFileEntry({ id, name: uniqueName(file.name, siblings), type, size: file.size, folder, driveId, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes });
    try {
      await s.commit({ op: 'file-put', file: entry });
    } catch (err) {
      s.backend().trash(driveId).catch(() => {});
      throw err;
    }
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      for (let task = transfers.find((t) => t.status === 'queued'); task; task = transfers.find((t) => t.status === 'queued')) {
        if (!task.store.fresh(2 * 60_000)) {
          for (const t of transfers) if (t.status === 'queued' && t.store === task.store) t.status = 'paused';
          renderTransfers();
          continue;
        }
        try {
          await uploadOne(task);
          task.status = 'done';
          task.progress = 1;
        } catch (err) {
          task.status = err?.name === 'AbortError' ? 'cancelled' : 'error';
          task.error = err?.name === 'AbortError' ? '' : err.message;
        }
        if (task.status === 'done' && task.after) await Promise.resolve().then(task.after).catch((err) => console.warn('After saving:', err));
        task.settle?.(task.status);
        renderTransfers();
        ctx.onChange();
      }
    } finally {
      processing = false;
      folderCache.clear();
    }
    const active = transfers.some((t) => ['queued', 'preparing', 'uploading', 'paused'].includes(t.status));
    if (!active && transfers.every((t) => t.status === 'done')) setTimeout(() => clearFinished(), 4000);
  }

  function clearFinished() {
    if (transfers.some((t) => ['queued', 'preparing', 'uploading', 'paused'].includes(t.status))) return;
    for (let i = transfers.length - 1; i >= 0; i--) if (['done', 'cancelled'].includes(transfers[i].status)) transfers.splice(i, 1);
    renderTransfers();
  }

  const STATUS = { queued: 'Waiting', preparing: 'Preparing…', uploading: 'Encrypting & uploading', done: 'Encrypted & saved', error: 'Failed', cancelled: 'Cancelled', paused: 'Paused — Google access expired' };
  const statusText = (task) => (task.status === 'uploading' && task.store.kind === 'local' ? 'Encrypting & saving' : STATUS[task.status]);

  function transferRow(task) {
    const kind = kindOf({ name: task.file.name, type: guessType(task.file.name, task.file.type) });
    const action =
      task.status === 'error' || task.status === 'cancelled'
        ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Retry', title: 'Retry', onclick: () => retryTask(task) }, icon('refresh', 16))
        : ['queued', 'preparing', 'uploading', 'paused'].includes(task.status)
          ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cancel', title: 'Cancel', onclick: () => cancelTask(task) }, icon('x', 16))
          : h('span', { class: 'transfer-done' }, icon('check', 16));
    return h('li', { class: `transfer is-${task.status}`, dataset: { id: task.id } },
      h('span', { class: `file-art kind-${kind} art-sm` }, icon(KIND_ICON[kind], 16)),
      h('div', { class: 'transfer-main' },
        h('span', { class: 'transfer-name', text: task.file.name }),
        h('span', { class: 'transfer-status', text: task.error || `${statusText(task)}${task.status === 'uploading' ? ` · ${Math.round(task.progress * 100)}%` : ''} · ${formatBytes(task.file.size)}` }),
        h('span', { class: 'transfer-bar' }, h('span', { class: 'transfer-fill' }))),
      action);
  }

  function updateTransfer(task) {
    const row = $(`#transfer-list [data-id="${task.id}"]`);
    if (!row) return renderTransfers();
    row.querySelector('.transfer-fill').style.setProperty('--progress', String(task.progress));
    row.querySelector('.transfer-status').textContent = `${statusText(task)} · ${Math.round(task.progress * 100)}% · ${formatBytes(task.file.size)}`;
    renderTotal();
  }

  /** The whole batch at a glance: files done, bytes done, and one bar (also in the tab's title). */
  function renderTotal() {
    const counted = transfers.filter((t) => t.status !== 'cancelled');
    const bytes = counted.reduce((n, t) => n + t.file.size, 0);
    const done = counted.reduce((n, t) => n + t.file.size * (t.status === 'done' ? 1 : t.progress), 0);
    const finished = counted.filter((t) => t.status === 'done').length;
    const share = bytes ? done / bytes : counted.length ? finished / counted.length : 0;
    const active = counted.some((t) => ['queued', 'preparing', 'uploading'].includes(t.status));
    $('#transfers-summary').hidden = counted.length < 2 && !active;
    $('#transfers-total').textContent = `${finished} of ${counted.length} ${counted.length === 1 ? 'file' : 'files'} · ${formatBytes(Math.round(done))} of ${formatBytes(bytes)}`;
    $('#transfers-percent').textContent = `${Math.floor(share * 100)}%`;
    $('#transfers-total-fill').style.setProperty('--progress', String(share));
    document.title = active ? `${Math.floor(share * 100)}% · Secure Box` : 'Secure Box';
  }

  function renderTransfers() {
    const tray = $('#transfers');
    tray.hidden = transfers.length === 0;
    const active = transfers.filter((t) => ['queued', 'preparing', 'uploading'].includes(t.status)).length;
    const failed = transfers.filter((t) => t.status === 'error').length;
    const paused = transfers.some((t) => t.status === 'paused');
    const saving = transfers.length > 0 && transfers.every((t) => t.store.kind === 'local');
    $('#transfers-title').textContent = active
      ? `${saving ? 'Saving' : 'Uploading'} ${active} ${active === 1 ? 'file' : 'files'}`
      : paused ? 'Uploads paused' : failed ? `${failed} ${failed === 1 ? 'file' : 'files'} failed` : saving ? 'All saved' : 'Uploads complete';
    $('#transfers-resume').hidden = !paused;
    $('#transfer-list').replaceChildren(...transfers.map(transferRow));
    for (const task of transfers) $(`#transfer-list [data-id="${task.id}"] .transfer-fill`)?.style.setProperty('--progress', String(task.progress));
    renderTotal();
  }

  function retryTask(task) {
    Object.assign(task, { status: 'queued', progress: 0, error: '', abort: new AbortController() });
    renderTransfers();
    processQueue();
  }

  function cancelTask(task) {
    task.abort.abort();
    if (['queued', 'paused'].includes(task.status)) {
      task.status = 'cancelled';
      task.settle?.('cancelled');
    }
    renderTransfers();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  // The path bar scrolls sideways with its scrollbar hidden: keep its fades current, and let a
  // mouse wheel scroll it (most mice only scroll up and down).
  const crumbsNav = $('#crumbs');
  crumbsNav.addEventListener('scroll', updateCrumbFades, { passive: true });
  new ResizeObserver(updateCrumbFades).observe(crumbsNav);
  crumbsNav.addEventListener('wheel', (event) => {
    if (crumbsNav.scrollWidth <= crumbsNav.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? crumbsNav.clientWidth : 1;
    crumbsNav.scrollLeft += event.deltaY * step;
    updateCrumbFades();
    event.preventDefault();
  }, { passive: false });

  const filesView = $('#files-view');
  filesView.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    $('#drop-verb').textContent = isLocal() ? 'save to' : 'upload to';
    $('#drop-target').textContent = view.folder ? folderById(view.folder)?.name : rootName();
    $('#drop-overlay').hidden = false;
  });
  filesView.addEventListener('dragleave', (event) => {
    if (!filesView.contains(event.relatedTarget)) $('#drop-overlay').hidden = true;
  });
  filesView.addEventListener('drop', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    $('#drop-overlay').hidden = true;
    uploadFromDrop(event.dataTransfer);
  });
  for (const radio of $$('input[name="files-layout"]')) {
    radio.addEventListener('change', () => {
      view.layout = radio.value;
      savePref('unibox.filesLayout', view.layout);
      render();
    });
  }
  $('#thumbs-toggle').addEventListener('change', (event) => {
    view.thumbs = event.target.checked;
    savePref('unibox.thumbnails', view.thumbs ? 'on' : 'off');
    render();
  });
  $('#files-sort').addEventListener('change', (event) => {
    view.sort = event.target.value;
    savePref('unibox.filesSort', view.sort);
    render();
  });

  const actions = {
    'new-folder': () => newFolder(),
    'upload-folder': () => upload({ directory: true }),
    'sel-clear': () => {
      view.selected.clear();
      render();
    },
    'sel-move': () => {
      const s = selection();
      return moveEntries(s.folders, s.files);
    },
    'sel-delete': () => {
      const s = selection();
      return deleteEntries(s.folders, s.files);
    },
    'sel-download': async () => {
      const s = selection();
      // One file downloads as itself; anything more becomes one ZIP that keeps the folders.
      if (!s.folders.length && s.files.length === 1) return download(fileById(s.files[0]));
      return downloadZip(s.folders, s.files);
    },
    'transfers-close': () => {
      for (const t of transfers) {
        if (['queued', 'paused', 'preparing', 'uploading'].includes(t.status)) t.abort.abort();
        t.settle?.('cancelled');
      }
      transfers.length = 0;
      renderTransfers();
    },
    'transfers-resume': async () => {
      await ctx.cloud.ensure(); // only Google Drive uploads pause (its access lasts an hour)
      for (const t of transfers) if (t.status === 'paused') t.status = 'queued';
      renderTransfers();
      processQueue();
    },
    'transfers-toggle': (button) => {
      const collapsed = $('#transfers').classList.toggle('is-collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
      button.title = collapsed ? 'Show files' : 'Hide files';
    },
    'upload-files': () => upload(),
    ...viewer.actions,
  };

  return {
    actions,
    render,
    get query() {
      return view.query;
    },
    get folder() {
      return view.folder;
    },
    get store() {
      return store;
    },
    setQuery(q) {
      view.query = q;
      render();
    },
    /** Shows another store's files (Google Drive or the local vault), each where it was left. */
    useStore(next) {
      if (next === store) return;
      navs.set(store, { folder: view.folder, query: view.query, selected: view.selected, anchor: view.anchor });
      releaseUrls();
      store = next;
      Object.assign(view, navs.get(next) || { folder: null, query: '', selected: new Set(), anchor: null });
    },
    goTo: (folder, options) => openFolder(folder && folderById(folder) ? folder : null, options),
    enqueue: (items, target, s) => enqueue(items, target, s),
    upload: () => upload(),
    busy: () => transfers.some((t) => ['queued', 'preparing', 'uploading'].includes(t.status)),
    searchKey(event) {
      if (event.key === 'Escape' && view.query) {
        event.preventDefault();
        $('#search').value = '';
        this.setQuery('');
      } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
        const first = $('#files-body [data-id]');
        if (first) {
          event.preventDefault();
          if (event.key === 'Enter') first.click();
          else first.focus();
        }
      }
    },
    key(event, { typing, plain }) {
      if (typing) return;
      const k = event.key.toLowerCase();
      if (k === 'u' && plain) {
        event.preventDefault();
        upload();
      } else if (k === 'n' && plain) {
        event.preventDefault();
        newFolder();
      } else if (event.key === 'Backspace' && view.folder) {
        event.preventDefault();
        openFolder(folderById(view.folder)?.parent ?? null);
      } else if (event.key === 'Escape' && view.selected.size) {
        view.selected.clear();
        render();
      } else if (k === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        for (const n of $$('#files-body [data-id]')) view.selected.add(n.dataset.id);
        render();
      } else if (event.key === 'Delete' && view.selected.size) {
        const s = selection();
        deleteEntries(s.folders, s.files);
      }
    },
  };
}
