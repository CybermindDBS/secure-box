/**
 * The viewer: which file is open, and the files around it (next and previous). A .txt file can
 * be edited in place (textedit.js): its unsaved changes are never dropped without asking.
 */
import { confirmDialog } from './bridge.js';
import { viewerClosed, viewerOpened } from './nav.js';
import { createStore } from './store.js';

/**
 * `editing`: the text file being edited, or null: { id, base (its entry when editing began or it
 * was last saved), original (that text), style (how the file is written), dirty }.
 */
export const viewerStore = createStore({ ids: [], index: -1, info: false, editing: null });
const get = () => viewerStore.get();

export const viewerFileId = () => get().ids[get().index] ?? null;
export const viewerIsOpen = () => get().index >= 0;

/** Opens `id`, with `ids` (the files shown, in order) for next and previous. */
export function openViewer(id, ids) {
  const index = Math.max(0, ids.indexOf(id));
  viewerStore.set({ ids: ids.length ? ids : [id], index, info: get().info, editing: null });
  viewerOpened();
}

export function closeViewer({ fromHistory = false } = {}) {
  if (!viewerIsOpen()) return;
  viewerStore.set({ ...get(), ids: [], index: -1, editing: null });
  if (!fromHistory) viewerClosed();
}

export function stepViewer(step) {
  const { ids, index } = get();
  const next = index + step;
  if (next < 0 || next >= ids.length) return;
  viewerStore.set({ ...get(), index: next, editing: null });
}

export const toggleViewerInfo = () => viewerStore.set({ ...get(), info: !get().info });

/** A file was deleted or moved out of the list: the viewer shows the next one, or closes. */
export function dropFromViewer(id) {
  const { ids, index } = get();
  const at = ids.indexOf(id);
  if (at < 0) return;
  const rest = ids.filter((x) => x !== id);
  if (!rest.length) return closeViewer();
  viewerStore.set({ ...get(), ids: rest, index: Math.min(at <= index ? index - (at < index ? 1 : 0) : index, rest.length - 1), editing: null });
}

/** The viewer's list with `id` shown: in place of `instead`, or right after `after`. */
function placed({ ids, index }, id, { instead = null, after = null } = {}) {
  if (ids.includes(id)) return { ids, index: ids.indexOf(id) };
  const at = ids.indexOf(instead ?? after);
  if (at < 0) return { ids: [...ids, id], index: ids.length };
  if (instead) return { ids: ids.map((x) => (x === instead ? id : x)), index: at };
  return { ids: [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)], index: at + 1 };
}

// ---------------------------------------------------------------------------
// Editing a .txt file
// ---------------------------------------------------------------------------
export const editingDirty = () => Boolean(get().editing?.dirty);
export const editingName = () => get().editing?.base.name || '';

/** Starts editing `file`, whose text and way of writing it are `style` (textfile.js). */
export function startEditing(file, style) {
  const { text, ...rest } = style;
  viewerStore.set({ ...get(), editing: { id: file.id, base: file, original: text, style: rest, dirty: false } });
}

export function setEditingDirty(dirty) {
  const editing = get().editing;
  if (editing && editing.dirty !== dirty) viewerStore.set({ ...get(), editing: { ...editing, dirty } });
}

/**
 * Saved: editing goes on from the saved file and text. A copy saved beside it (`place.after`) or
 * in its place (`place.instead`) is what the viewer shows from now on.
 */
export function editingSaved(entry, text, place = null) {
  const now = get();
  if (!now.editing) return;
  viewerStore.set({ ...now, ...(place ? placed(now, entry.id, place) : {}), editing: { ...now.editing, id: entry.id, base: entry, original: text, dirty: false } });
}

export function stopEditing() {
  if (get().editing) viewerStore.set({ ...get(), editing: null });
}

/**
 * Before leaving the text being edited (closing the viewer or the editor, another file, Back,
 * locking, another vault): true to go ahead. Unsaved changes are only dropped once confirmed.
 */
export async function leaveEditing() {
  const editing = get().editing;
  if (!editing) return true;
  if (editing.dirty) {
    const ok = await confirmDialog({
      title: 'Discard your changes?',
      message: `Your changes to “${editing.base.name}” aren’t saved yet.`,
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!ok) return false;
  }
  stopEditing();
  return true;
}

/** The viewer's ✕, Esc and Back: closes it, once any edits are saved or let go. */
export async function requestCloseViewer() {
  if (await leaveEditing()) closeViewer();
}

/** Previous or next file, once any edits are saved or let go. */
export async function requestStepViewer(step) {
  if (await leaveEditing()) stepViewer(step);
}
