import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatBytes, kindOf, typeLabel } from '../../core/filetypes.js';
import {
  KIND_ICON,
  ROOT_NAME,
  clearSelection,
  crumbsOf,
  deleteEntries,
  deleteSelection,
  download,
  downloadEntries,
  downloadZip,
  fileById,
  files,
  folderById,
  goUp,
  moveEntries,
  newFolder,
  openFolder,
  renameEntry,
  selectRange,
  selection,
  setSelection,
  toggleSelected,
  upload,
  uploadFromDrop,
  visibleEntries,
} from '../../session/files.js';
import { relativeTime } from '../../session/io.js';
import { holdThumb, keptThumb, wantThumb } from '../../session/thumbs.js';
import { setPref } from '../../session/prefs.js';
import { state } from '../../session/store.js';
import { openViewer } from '../../session/viewer.js';
import { vaultIndex } from '../../core/vault.js';
import { Icon, Spinner } from '../common/Icon.jsx';
import { Menu, MenuItem } from '../common/Menu.jsx';
import { Segmented } from '../common/Segmented.jsx';
import { useIncremental, useNarrow, usePref, useSession, useStore } from '../hooks.js';
import { SwitchLoader, SyncStatus } from '../passwords/PasswordsView.jsx';
import { run } from '../run.js';

const MOVE_TYPE = 'application/x-secure-box';
const touchLike = (type) => type === 'touch' || type === 'pen';

function openEntry(entry, isFolder, fileIds) {
  if (isFolder) return openFolder(entry.id);
  return openViewer(entry.id, fileIds);
}

/**
 * A click opens. Double-clicking from habit sends a second click to what the first one opened (a
 * card in the folder, the image in the viewer): the rest of that double-click is ignored.
 */
function ignoreRestOfDoubleClick(ms = 1000) {
  const types = ['mousedown', 'click', 'dblclick'];
  const stop = (event) => {
    if (event.detail < 2) return; // a new click of its own
    event.stopPropagation();
    event.preventDefault();
  };
  for (const type of types) document.addEventListener(type, stop, true);
  setTimeout(() => {
    for (const type of types) document.removeEventListener(type, stop, true);
  }, ms);
}

// ---------------------------------------------------------------------------
// The path bar
// ---------------------------------------------------------------------------
/** Folders take drops: items dragged from the list are moved there, files from outside are uploaded there. */
function dropProps(folderId, setOver) {
  return {
    onDragOver(event) {
      const types = [...event.dataTransfer.types];
      if (!types.includes(MOVE_TYPE) && !types.includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = types.includes(MOVE_TYPE) ? 'move' : 'copy';
      setOver(true);
    },
    onDragLeave() {
      setOver(false);
    },
    onDrop(event) {
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      const moving = event.dataTransfer.getData(MOVE_TYPE);
      if (moving) {
        const { folders, files: ids } = JSON.parse(moving);
        run(() => moveEntries(folders, ids, folderId));
      } else uploadFromDrop(event.dataTransfer, folderId);
    },
  };
}

function Crumb({ id, label, current, icon }) {
  const [over, setOver] = useState(false);
  return (
    <button type="button" className={`crumb${current ? ' is-current' : ''}${over ? ' is-drop' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openFolder(id)} {...dropProps(id, setOver)}>
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{label}</span>
    </button>
  );
}

function Crumbs({ folder, query }) {
  const ref = useRef(null);
  const [fades, setFades] = useState('');
  const chain = query ? [] : crumbsOf(folder);
  const measure = useCallback(() => {
    const nav = ref.current;
    if (!nav) return;
    const hidden = nav.scrollWidth - nav.clientWidth;
    setFades(`${hidden > 1 && nav.scrollLeft > 1 ? ' fade-start' : ''}${hidden > 1 && hidden - nav.scrollLeft > 1 ? ' fade-end' : ''}`);
  }, []);
  useLayoutEffect(() => {
    const nav = ref.current;
    nav.scrollLeft = nav.scrollWidth; // a long path keeps its current folder in view
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [folder, query, measure]);
  return (
    <nav
      ref={ref}
      className={`crumbs${fades}`}
      aria-label="Folder path"
      title={query ? `Search “${query.trim()}”` : [ROOT_NAME, ...chain.map((f) => f.name)].join(' › ')}
      onScroll={measure}
      onWheel={(event) => {
        const nav = ref.current;
        if (nav.scrollWidth <= nav.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        nav.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      }}
    >
      <Crumb id={null} label={ROOT_NAME} icon="home" current={!query && !folder} />
      {chain.map((f, i) => (
        <span key={f.id} className="crumb-wrap">
          <span className="crumb-sep" aria-hidden="true">
            <Icon name="chevronRight" size={14} />
          </span>
          <Crumb id={f.id} label={f.name} current={i === chain.length - 1} />
        </span>
      ))}
      {query ? (
        <>
          <span className="crumb-sep" aria-hidden="true">
            <Icon name="chevronRight" size={14} />
          </span>
          <span className="crumb is-current">Search “{query.trim()}”</span>
        </>
      ) : null}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The bar: path, upload, new folder, view options; or what's chosen
// ---------------------------------------------------------------------------
/** Upload ▾: files, or a whole folder (U uploads files straight away). */
function UploadMenu() {
  return (
    <Menu
      label="Upload"
      button={(props) => (
        <button {...props} type="button" className="btn btn-primary btn-sm upload-btn" title="Upload files (U) or a whole folder">
          <Icon name="upload" size={16} />
          <span>Upload</span>
          <Icon name="chevronDown" size={14} className="btn-caret" />
        </button>
      )}
    >
      <MenuItem icon={<Icon name="upload" />} onSelect={() => run(upload)}>
        Files…
      </MenuItem>
      <MenuItem icon={<Icon name="folderUp" />} onSelect={() => run(upload, { directory: true })}>
        A folder…
      </MenuItem>
    </Menu>
  );
}

/** View: thumbnails, sorting and grid or list, in a panel under its button (a sheet on phones). */
function ViewOptions() {
  const thumbnails = usePref('thumbnails');
  const sort = usePref('sort');
  const layout = usePref('layout');
  const toggle = useRef(null);
  const panel = useRef(null);
  useEffect(() => {
    const el = panel.current;
    const place = (event) => {
      if (event.newState !== 'open') return;
      // Phones get a sheet from the bottom of the screen instead (CSS).
      const sheet = window.matchMedia('(max-width: 760px)').matches;
      const rect = toggle.current.getBoundingClientRect();
      el.style.top = sheet ? '' : `${Math.round(rect.bottom + 8)}px`;
      el.style.right = sheet ? '' : `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`;
    };
    el.addEventListener('beforetoggle', place);
    return () => el.removeEventListener('beforetoggle', place);
  }, []);
  return (
    <>
      <button ref={toggle} type="button" className="btn btn-ghost btn-sm view-toggle" popoverTarget="view-options" aria-label="View options" title="View: thumbnails, sorting, grid or list">
        <Icon name="sliders" size={16} />
        <span>View</span>
      </button>
      <div ref={panel} id="view-options" className="view-options" popover="auto">
        <p className="view-options-title">View</p>
        <label className="switch" title="Show thumbnails for photos and videos (decrypted in this browser and kept only in its memory, until you lock)">
          <input type="checkbox" checked={thumbnails} onChange={(e) => setPref('thumbnails', e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">Thumbnails</span>
        </label>
        <div className="view-row">
          <span className="view-options-label">Sort by</span>
          <select className="select" aria-label="Sort by" value={sort} onChange={(e) => setPref('sort', e.target.value)}>
            <option value="name">Name</option>
            <option value="updated">Last modified</option>
            <option value="size">Size</option>
            <option value="type">Type</option>
          </select>
        </div>
        <div className="view-row">
          <span className="view-options-label">Layout</span>
          <Segmented
            label="Layout"
            className="seg-icons"
            value={layout}
            onChange={(value) => setPref('layout', value)}
            options={[
              { id: 'grid', label: 'Grid', icon: 'grid' },
              { id: 'list', label: 'List', icon: 'list' },
            ]}
          />
        </div>
      </div>
    </>
  );
}

function SelectionBar({ order }) {
  const selected = useStore(files.store, (v) => v.selected);
  const count = selected.size;
  const all = count > 0 && order.every((id) => selected.has(id));
  const checkbox = useRef(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = count > 0 && !all;
  }, [count, all]);
  if (!count) return null;
  const s = selection();
  const single = s.folders.length + s.files.length === 1 ? folderById(s.folders[0]) || fileById(s.files[0]) : null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Chosen items">
      <label className="select-all" title={all ? 'Choose nothing' : 'Choose everything here'}>
        <input ref={checkbox} type="checkbox" checked={all} onChange={() => (all ? clearSelection() : setSelection(order))} />
        <span>{count} selected</span>
      </label>
      <button type="button" className="btn btn-ghost btn-sm" title="Download (several items download as one .zip that keeps their folders)" onClick={() => run(downloadEntries, s.folders, s.files)}>
        <Icon name="download" size={16} />
        <span>Download</span>
      </button>
      {single ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(renameEntry, single, Boolean(folderById(single.id)))}>
          <Icon name="edit" size={16} />
          <span>Rename</span>
        </button>
      ) : null}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(moveEntries, s.folders, s.files)}>
        <Icon name="move" size={16} />
        <span>Move</span>
      </button>
      <button type="button" className="btn btn-ghost btn-sm btn-danger-ghost" onClick={() => run(deleteEntries, s.folders, s.files)}>
        <Icon name="trash" size={16} />
        <span>Delete</span>
      </button>
      <button type="button" className="icon-btn" aria-label="Choose nothing" title="Choose nothing (Esc)" onClick={clearSelection}>
        <Icon name="x" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A file or folder
// ---------------------------------------------------------------------------
// One watcher for all the thumbnails in a list: tells each when it comes within half a screen of
// view and when it leaves, so only those are loaded (session/thumbs.js).
const nearWatchers = new WeakMap(); // the list that scrolls -> { observer, calls }
function watchNear(el, onChange) {
  const root = el.closest('.files-body');
  let watcher = nearWatchers.get(root || document);
  if (!watcher) {
    const calls = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) calls.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: '50% 0px' });
    nearWatchers.set(root || document, (watcher = { observer, calls }));
  }
  watcher.calls.set(el, onChange);
  watcher.observer.observe(el);
  return () => {
    watcher.calls.delete(el);
    watcher.observer.unobserve(el);
  };
}

/** A thumbnail for `entry` once it's near the view: { key, url } (url null: none to show). */
function useThumb(entry, wanted, ref) {
  const key = `${entry.id}:${entry.blob}`;
  const [thumb, setThumb] = useState(() => ({ key, url: wanted ? keptThumb(entry) : null }));
  useEffect(() => {
    if (!wanted || typeof IntersectionObserver === 'undefined') return undefined;
    let stopWatching = null;
    let notWanted = null;
    let letGo = null;
    const show = (url) => {
      stopWatching?.();
      stopWatching = null;
      letGo?.();
      letGo = url ? holdThumb(entry) : null;
      setThumb({ key, url, failed: !url });
    };
    const now = keptThumb(entry);
    if (now) show(now);
    else {
      stopWatching = watchNear(ref.current, (near) => {
        notWanted?.();
        notWanted = near ? wantThumb(entry, show) : null;
      });
    }
    return () => {
      stopWatching?.();
      notWanted?.();
      letGo?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key]);
  return thumb.key === key && wanted ? thumb : { key, url: null };
}

function Art({ entry, isFolder, size = 'lg', thumbnails, missing = false }) {
  const ref = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const wanted = Boolean(!isFolder && thumbnails && entry.thumbBytes && state.streaming && !missing);
  const thumb = useThumb(entry, wanted, ref);
  if (isFolder) {
    return (
      <span className={`file-art kind-folder art-${size}`}>
        <Icon name="folder" size={size === 'lg' ? 40 : 20} />
      </span>
    );
  }
  const kind = kindOf(entry);
  const url = broken ? null : thumb.url;
  return (
    <span ref={ref} className={`file-art kind-${kind} art-${size}${url && loaded ? ' has-thumb' : ''}`}>
      <Icon name={KIND_ICON[kind]} size={size === 'lg' ? 34 : 18} />
      {url ? <img src={url} alt="" decoding="async" draggable="false" onLoad={() => setLoaded(true)} onError={() => setBroken(true)} /> : null}
      {kind === 'video' && size === 'lg' && !missing ? (
        <span className="play-badge" aria-hidden="true">
          <Icon name="play" size={14} />
        </span>
      ) : null}
      {missing ? (
        <span className="missing-badge" aria-hidden="true">
          <Icon name="alert" size={size === 'lg' ? 14 : 10} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * A card is drawn again only when what it shows changes (memo): choosing one of thousands redraws
 * that one. A folder's counts come from FilesBody (`inside`, `filesInside`), as they change with
 * what's in it rather than with the folder itself.
 */
const EntryCard = memo(function EntryCard({ entry, isFolder, layout, selected, focused, pending, added = false, missing = false, inside = 0, filesInside = 0, thumbnails, events }) {
  const [over, setOver] = useState(false);
  // A file whose encrypted copy is missing (deleted outside Secure Box) says so where its size was.
  const meta = isFolder ? `${inside} ${inside === 1 ? 'item' : 'items'}` : missing ? 'Encrypted copy missing' : `${formatBytes(entry.size)} · ${relativeTime(entry.updated)}`;
  const busyText = { deleting: 'Deleting…', moving: 'Moving…', renaming: 'Renaming…' }[pending];
  const common = {
    'data-id': entry.id,
    'data-folder': isFolder ? '1' : undefined,
    tabIndex: focused ? 0 : -1,
    'aria-selected': selected,
    'aria-busy': pending ? 'true' : undefined,
    draggable: !pending,
    onPointerDown: (e) => events.pointerDown(e, entry),
    onPointerUp: events.pointerUp,
    onPointerMove: events.pointerMove,
    onPointerCancel: events.pointerUp,
    onClick: (e) => events.click(e, entry, isFolder),
    onContextMenu: (e) => events.contextMenu(e, entry, isFolder),
    onFocus: () => events.focus(entry.id),
    onDragStart: (e) => events.dragStart(e, entry),
    ...(isFolder ? dropProps(entry.id, setOver) : {}),
  };
  const state_ = `${selected ? ' is-selected' : ''}${pending ? ' is-pending' : ''}${over ? ' is-drop' : ''}${added ? ' is-added' : ''}${missing ? ' is-missing' : ''}`;
  const check = (
    <span
      className="item-check"
      role="checkbox"
      aria-checked={selected}
      aria-label={`Choose ${entry.name}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleSelected(entry.id);
      }}
    >
      <Icon name="check" size={14} />
    </span>
  );
  const more = (
    <button
      type="button"
      className="icon-btn item-more"
      aria-label={`Actions for ${entry.name}`}
      title="Actions"
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        events.menu(e.currentTarget.getBoundingClientRect(), entry, isFolder);
      }}
    >
      <Icon name="more" />
    </button>
  );
  const loader = pending ? (
    <span className="item-pending" role="status">
      <Spinner small />
      <span>{busyText}</span>
    </span>
  ) : null;
  if (layout === 'grid') {
    return (
      <div className={`tile${state_}`} role="gridcell" {...common}>
        {check}
        {more}
        <Art entry={entry} isFolder={isFolder} thumbnails={thumbnails} missing={missing} />
        <span className="tile-name" title={entry.name}>
          {entry.name}
        </span>
        <span className="tile-meta">{meta}</span>
        {loader}
      </div>
    );
  }
  return (
    <div className={`frow${state_}`} role="row" {...common}>
      {check}
      <Art entry={entry} isFolder={isFolder} size="sm" thumbnails={thumbnails} missing={missing} />
      <span className="frow-name" title={entry.name}>
        {entry.name}
      </span>
      <span className="frow-kind">{isFolder ? 'Folder' : typeLabel(entry)}</span>
      <span className="frow-size">{isFolder ? `${filesInside} ${filesInside === 1 ? 'file' : 'files'}` : missing ? 'Missing' : formatBytes(entry.size)}</span>
      <span className="frow-date">{relativeTime(entry.updated)}</span>
      {more}
      {loader}
    </div>
  );
});

/** One menu for every card (its ⋯ button, or a right-click): open, download, rename, move, delete. */
function ItemMenu({ menu, onClose, fileIds }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const closed = (event) => {
      if (event.newState === 'closed') onClose();
    };
    el.addEventListener('toggle', closed);
    return () => el.removeEventListener('toggle', closed);
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu) {
      if (el.matches(':popover-open')) el.hidePopover();
      return;
    }
    el.style.top = `${Math.round(Math.min(menu.y, window.innerHeight - 260))}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(menu.x, window.innerWidth - 236)))}px`;
    if (!el.matches(':popover-open')) el.showPopover();
  }, [menu]);
  const { entry, isFolder, many } = menu || {};
  const item = (label, icon, action, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${danger ? ' menu-danger' : ''}`}
      onClick={() => {
        ref.current.hidePopover();
        run(action);
      }}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  return (
    <div ref={ref} className="menu item-menu" popover="auto" role="menu">
      {menu && many ? (
        <>
          {item('Download', 'download', () => downloadEntries(many.folders, many.files))}
          {item('Move to…', 'move', () => moveEntries(many.folders, many.files))}
          <div className="menu-sep" role="separator" />
          {item(`Delete ${many.folders.length + many.files.length} items`, 'trash', () => deleteEntries(many.folders, many.files), true)}
        </>
      ) : menu ? (
        <>
          {item(isFolder ? 'Open' : 'Open in viewer', isFolder ? 'folder' : 'eye', () => openEntry(entry, isFolder, fileIds))}
          {isFolder ? item('Download as .zip', 'download', () => downloadZip([entry.id], [])) : item('Download', 'download', () => download(entry))}
          {item('Rename', 'edit', () => renameEntry(entry, isFolder))}
          {item('Move to…', 'move', () => moveEntries(isFolder ? [entry.id] : [], isFolder ? [] : [entry.id]))}
          <div className="menu-sep" role="separator" />
          {item('Delete', 'trash', () => deleteEntries(isFolder ? [entry.id] : [], isFolder ? [] : [entry.id]), true)}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The grid (or list): choosing like Google Drive (#13)
// ---------------------------------------------------------------------------
// A folder of thousands is drawn a batch at a time as it's scrolled (useIncremental).
const FIRST_CARDS = 120;
const MORE_CARDS = 160;

function FilesBody({ entries, layout, thumbnails, query, folder, sort }) {
  const selected = useStore(files.store, (v) => v.selected);
  const pending = useStore(files.store, (v) => v.pending);
  const added = useStore(files.store, (v) => v.added);
  const missing = useStore(files.store, (v) => v.missing);
  const vault = useSession((s) => s.vault);
  const narrow = useNarrow();
  const bodyRef = useRef(null);
  const [focusId, setFocusId] = useState(null);
  const [menu, setMenu] = useState(null);
  const [box, setBox] = useState(null); // a selection rectangle being drawn
  const press = useRef({ type: 'mouse', timer: 0, x: 0, y: 0, long: false });
  const order = useMemo(() => [...entries.folders.map((f) => f.id), ...entries.files.map((f) => f.id)], [entries]);
  const places = useMemo(() => new Map(order.map((id, i) => [id, i])), [order]); // id -> where it is in the list
  const fileIds = useMemo(() => entries.files.map((f) => f.id), [entries]);
  const isFolderId = (id) => Boolean(folderById(id));
  const selecting = selected.size > 0;
  // Another folder, search or order starts again from the first batch.
  const { count, more, sentinel, reveal } = useIncremental(order.length, { key: `${folder}\u0000${query}\u0000${sort}`, first: FIRST_CARDS, step: MORE_CARDS });
  const shownFolders = count < entries.folders.length ? entries.folders.slice(0, count) : entries.folders;
  const shownFiles = entries.files.slice(0, Math.max(0, count - entries.folders.length));

  // The handlers the cards share, made once: they read what they need when called, so a change
  // (one more card chosen, say) doesn't redraw every card.
  const latest = useRef(null);
  latest.current = { selected, pending, selecting, order, places, fileIds };

  // Focus goes back to a card when the list changes under it.
  useEffect(() => {
    if (focusId && !places.has(focusId)) setFocusId(order[0] || null);
  }, [places, order, focusId]);

  // A folder just made: brought into view, and the keyboard goes on from it (it isn't chosen).
  useEffect(() => {
    if (!added) return;
    setFocusId(added);
    if (places.has(added)) reveal(places.get(added));
    requestAnimationFrame(() => bodyRef.current?.querySelector(`[data-id="${CSS.escape(added)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [added, places, reveal]);

  const focusCard = useCallback(
    (id) => {
      setFocusId(id);
      const at = latest.current.places.get(id);
      if (at !== undefined) reveal(at); // drawn first, if it wasn't yet
      requestAnimationFrame(() => bodyRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));
    },
    [reveal],
  );

  /** How many cards fit on a row of the grid, to move up and down. */
  const columns = () => {
    if (layout !== 'grid') return 1;
    const cards = [...(bodyRef.current?.querySelectorAll('[data-id]') || [])].slice(0, 64);
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    const n = cards.findIndex((c) => c.offsetTop !== top);
    return n < 0 ? cards.length : n;
  };

  const events = useMemo(
    () => ({
      pointerDown(event, entry) {
        press.current.type = event.pointerType;
        press.current.long = false;
        if (!touchLike(event.pointerType)) return;
        press.current.x = event.clientX;
        press.current.y = event.clientY;
        clearTimeout(press.current.timer);
        // Long-press: start (or add to) choosing, like on a phone's file manager.
        press.current.timer = setTimeout(() => {
          press.current.long = true;
          toggleSelected(entry.id);
          navigator.vibrate?.(12);
        }, 450);
      },
      pointerMove(event) {
        if (!press.current.timer) return;
        if (Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) {
          clearTimeout(press.current.timer);
          press.current.timer = 0;
        }
      },
      pointerUp() {
        clearTimeout(press.current.timer);
        press.current.timer = 0;
      },
      click(event, entry, isFolder) {
        const { pending: busy, selecting: choosing, order: list, fileIds: ids } = latest.current;
        if (busy.get(entry.id)) return;
        setFocusId(entry.id);
        if (touchLike(press.current.type)) {
          if (press.current.long) {
            press.current.long = false;
            return;
          }
          // Choosing on a phone: taps add and remove; otherwise a tap opens.
          if (choosing) toggleSelected(entry.id);
          else openEntry(entry, isFolder, ids);
          return;
        }
        // A mouse: a click opens, like a tap. Choosing is the checkbox's job, or Ctrl/⌘ and Shift's.
        if (event.ctrlKey || event.metaKey) toggleSelected(entry.id);
        else if (event.shiftKey) selectRange(entry.id, list);
        else if (event.detail < 2) {
          ignoreRestOfDoubleClick();
          openEntry(entry, isFolder, ids);
        }
      },
      contextMenu(event, entry, isFolder) {
        if (touchLike(press.current.type)) {
          event.preventDefault(); // a long-press chooses instead of the browser's menu
          return;
        }
        event.preventDefault();
        // The menu acts on this item, or on what's chosen when this item is one of them; it
        // chooses nothing itself.
        const chosen = latest.current.selected;
        const many = chosen.has(entry.id) && chosen.size > 1 ? selection() : null;
        setMenu({ x: event.clientX, y: event.clientY, entry, isFolder, many });
      },
      menu(rect, entry, isFolder) {
        setMenu({ x: rect.right - 220, y: rect.bottom + 6, entry, isFolder, many: null });
      },
      focus(id) {
        setFocusId(id);
      },
      dragStart(event, entry) {
        const chosen = latest.current.selected;
        const ids = chosen.has(entry.id) ? [...chosen] : [entry.id];
        event.dataTransfer.setData(MOVE_TYPE, JSON.stringify({ folders: ids.filter((id) => folderById(id)), files: ids.filter((id) => fileById(id)) }));
        event.dataTransfer.effectAllowed = 'move';
      },
    }),
    [],
  );

  // Keys on a card (#13): arrows (by row in the grid), Shift to extend, Home/End, Space, Enter, F2…
  const onKeyDown = (event) => {
    const card = event.target.closest?.('[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    const index = places.get(id) ?? -1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[event.key];
    const jump = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : null;
    if (step !== undefined || jump !== null) {
      event.preventDefault();
      const next = order[jump ?? Math.min(order.length - 1, Math.max(0, index + step))];
      if (!next) return;
      if (event.shiftKey) selectRange(next, order, { add: event.ctrlKey || event.metaKey });
      else if (!(event.ctrlKey || event.metaKey)) setSelection([next], next);
      focusCard(next);
      return;
    }
    const entry = folderById(id) || fileById(id);
    if (event.key === 'Enter') {
      event.preventDefault();
      openEntry(entry, isFolderId(id), fileIds);
    } else if (event.key === ' ') {
      event.preventDefault();
      toggleSelected(id);
    } else if (event.key === 'F2') {
      event.preventDefault();
      run(renameEntry, entry, isFolderId(id));
    } else if (event.key === 'Delete') {
      event.preventDefault();
      // What's chosen, if this card is part of it; else just this card.
      if (selected.has(id)) run(deleteSelection);
      else run(deleteEntries, isFolderId(id) ? [id] : [], isFolderId(id) ? [] : [id]);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      setMenu({ x: rect.left + 16, y: rect.top + 24, entry, isFolder: isFolderId(id), many: selected.has(id) && selected.size > 1 ? selection() : null });
    }
  };

  // Drag a box over cards to choose them (mouse), from an empty spot.
  const onPointerDown = (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('[data-id], button, a, input')) return;
    const body = bodyRef.current;
    const origin = body.getBoundingClientRect();
    const start = { x: event.clientX - origin.left + body.scrollLeft, y: event.clientY - origin.top + body.scrollTop };
    const before = event.ctrlKey || event.metaKey || event.shiftKey ? new Set(selected) : new Set();
    let moved = false;
    let frame = 0;
    let last = null;
    body.setPointerCapture(event.pointerId);
    // Worked out at most once a frame, however fast the pointer moves.
    const choose = () => {
      frame = 0;
      const e = last;
      const now = body.getBoundingClientRect();
      const x = e.clientX - now.left + body.scrollLeft;
      const y = e.clientY - now.top + body.scrollTop;
      const rect = { left: Math.min(x, start.x), top: Math.min(y, start.y), right: Math.max(x, start.x), bottom: Math.max(y, start.y) };
      setBox(rect);
      const chosen = new Set(before);
      for (const card of body.querySelectorAll('[data-id]')) {
        const r = card.getBoundingClientRect();
        const c = { left: r.left - now.left + body.scrollLeft, top: r.top - now.top + body.scrollTop, right: r.right - now.left + body.scrollLeft, bottom: r.bottom - now.top + body.scrollTop };
        if (c.left < rect.right && c.right > rect.left && c.top < rect.bottom && c.bottom > rect.top) chosen.add(card.dataset.id);
      }
      setSelection([...chosen]);
    };
    const onMove = (e) => {
      const now = body.getBoundingClientRect();
      const x = e.clientX - now.left + body.scrollLeft;
      const y = e.clientY - now.top + body.scrollTop;
      if (!moved && Math.hypot(x - start.x, y - start.y) < 6) return;
      moved = true;
      last = e;
      frame ||= requestAnimationFrame(choose);
    };
    const onUp = () => {
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerup', onUp);
      body.removeEventListener('pointercancel', onUp);
      if (frame) {
        cancelAnimationFrame(frame);
        choose();
      }
      setBox(null);
      if (!moved && !before.size) clearSelection(); // a click on an empty spot chooses nothing
    };
    body.addEventListener('pointermove', onMove);
    body.addEventListener('pointerup', onUp);
    body.addEventListener('pointercancel', onUp);
  };

  const empty = !order.length;
  const focusable = focusId && places.has(focusId) ? focusId : order[0];
  const totals = vault ? vaultIndex(vault).totals : null;
  return (
    <div
      ref={bodyRef}
      className={`files-body layout-${layout}${selecting ? ' is-choosing' : ''}${narrow ? ' is-touch-ui' : ''}`}
      role={empty ? undefined : 'grid'}
      aria-multiselectable="true"
      aria-label={query ? `Search results for ${query}` : 'Files'}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      {empty ? (
        <div className="files-empty">
          <div className="empty-icon">
            <Icon name={query ? 'search' : 'upload'} size={22} />
          </div>
          <p className="empty-title">{query ? 'No matching files' : folder ? 'This folder is empty' : 'No files yet'}</p>
          <p>
            {query
              ? 'Try another name.'
              : state.backend?.kind === 'local'
                ? 'Drop files or folders here, or use Upload. They’re encrypted and kept on this device only.'
                : 'Drop files or folders here, or use Upload. They are encrypted before they leave this browser.'}
          </p>
          {!query ? (
            <div className="files-empty-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => run(upload)}>
                <Icon name="upload" size={16} />
                <span>Upload files</span>
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(newFolder)}>
                <Icon name="folderPlus" size={16} />
                <span>New folder</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {layout === 'list' ? (
            <div className="frow frow-head" role="row">
              <span />
              <span />
              <span>Name</span>
              <span className="frow-kind">Kind</span>
              <span className="frow-size">Size</span>
              <span className="frow-date">Modified</span>
              <span />
            </div>
          ) : null}
          {shownFolders.map((f) => {
            const inside = totals(f.id);
            return (
              <EntryCard
                key={f.id}
                entry={f}
                isFolder
                layout={layout}
                selected={selected.has(f.id)}
                focused={f.id === focusable}
                pending={pending.get(f.id)}
                added={f.id === added}
                inside={inside.files + inside.folders}
                filesInside={inside.files}
                thumbnails={thumbnails}
                events={events}
              />
            );
          })}
          {shownFiles.map((f) => (
            <EntryCard key={f.id} entry={f} isFolder={false} layout={layout} selected={selected.has(f.id)} focused={f.id === focusable} pending={pending.get(f.id)} missing={missing.has(f.blob)} thumbnails={thumbnails} events={events} />
          ))}
          {more ? <div ref={sentinel} className="files-more" aria-hidden="true" /> : null}
        </>
      )}
      {box ? <span className="marquee" style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` }} aria-hidden="true" /> : null}
      <ItemMenu menu={menu} onClose={() => setMenu(null)} fileIds={fileIds} />
    </div>
  );
}

// ---------------------------------------------------------------------------
export function FilesView() {
  const vault = useSession((s) => s.vault);
  const switching = useSession((s) => Boolean(s.switching));
  const section = useSession((s) => s.section);
  const folder = useStore(files.store, (v) => v.folder);
  const query = useStore(files.store, (v) => v.query);
  const selectedCount = useStore(files.store, (v) => v.selected.size);
  const layout = usePref('layout');
  const sort = usePref('sort');
  const thumbnails = usePref('thumbnails');
  const [dropping, setDropping] = useState(false);
  // Typing a search shows in the box at once; the list (of thousands, maybe) follows.
  const searching = useDeferredValue(query);
  const entries = useMemo(() => visibleEntries(vault, folder, searching, sort), [vault, folder, searching, sort]);
  const order = useMemo(() => [...entries.folders.map((f) => f.id), ...entries.files.map((f) => f.id)], [entries]);

  // Keys anywhere on the Files tab (not in a field): U, N, Backspace, Esc, Ctrl/⌘+A, Delete.
  useEffect(() => {
    files.key = (event, { typing, plain }) => {
      if (typing || section !== 'files') return;
      const k = event.key.toLowerCase();
      if (k === 'u' && plain) {
        event.preventDefault();
        run(upload);
      } else if (k === 'n' && plain) {
        event.preventDefault();
        run(newFolder);
      } else if (event.key === 'Backspace' && plain && folder) {
        event.preventDefault();
        goUp();
      } else if (event.key === 'Escape' && selectedCount) {
        clearSelection();
      } else if (k === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setSelection(order);
      } else if (event.key === 'Delete' && selectedCount && !event.target.closest?.('[data-id]')) {
        run(deleteSelection);
      }
    };
    files.searchKey = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        const first = document.querySelector('.files-body [data-id]');
        if (!first) return;
        event.preventDefault();
        if (event.key === 'Enter') first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        else first.focus();
      }
    };
    return () => {
      files.key = null;
      files.searchKey = null;
    };
  }, [section, folder, selectedCount, order]);

  if (!state.unlocked) return null;
  const count = order.length;
  const bytes = entries.files.reduce((n, f) => n + f.size, 0);
  return (
    <section
      id="files-view"
      className={`files${selectedCount ? ' has-selection' : ''}`}
      aria-label="Files"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        if (switching) {
          event.dataTransfer.dropEffect = 'none'; // another vault is opening: nothing to drop into yet
          return;
        }
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false);
      }}
      onDrop={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setDropping(false);
        if (!switching) uploadFromDrop(event.dataTransfer);
      }}
    >
      <div className="files-bar">
        {switching ? (
          <nav className="crumbs" aria-label="Folder path">
            <span className="crumb is-current">
              <Icon name="home" size={16} />
              <span>{ROOT_NAME}</span>
            </span>
          </nav>
        ) : (
          <Crumbs folder={folder} query={query} />
        )}
        <div className="files-tools">
          <UploadMenu />
          <button type="button" className="btn btn-ghost btn-sm" title="New folder (N)" onClick={() => run(newFolder)}>
            <Icon name="folderPlus" size={16} />
            <span>New folder</span>
          </button>
          <ViewOptions />
        </div>
      </div>
      {!switching ? <SelectionBar order={order} /> : null}
      {switching ? (
        <div className={`files-body layout-${layout} is-loading`}>
          <SwitchLoader />
        </div>
      ) : (
        <FilesBody entries={entries} layout={layout} thumbnails={thumbnails} query={searching} folder={folder} sort={sort} />
      )}
      <div className="files-foot">
        <span>{switching ? '' : `${count} ${count === 1 ? 'item' : 'items'}${entries.files.length ? ` · ${formatBytes(bytes)}` : ''}`}</span>
        <SyncStatus />
      </div>
      {dropping ? (
        <div className="drop-overlay">
          <div className="drop-card">
            <Icon name="upload" size={28} />
            <p>
              Drop to encrypt and {state.backend?.kind === 'local' ? 'save to' : 'upload to'} <strong>{folder ? folderById(folder)?.name : ROOT_NAME}</strong>
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
