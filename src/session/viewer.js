/**
 * The viewer: which file is open, and the files around it (next and previous).
 */
import { viewerClosed, viewerOpened } from './nav.js';
import { createStore } from './store.js';

export const viewerStore = createStore({ ids: [], index: -1, info: false });
const get = () => viewerStore.get();

export const viewerFileId = () => get().ids[get().index] ?? null;
export const viewerIsOpen = () => get().index >= 0;

/** Opens `id`, with `ids` (the files shown, in order) for next and previous. */
export function openViewer(id, ids) {
  const index = Math.max(0, ids.indexOf(id));
  viewerStore.set({ ids: ids.length ? ids : [id], index, info: get().info });
  viewerOpened();
}

export function closeViewer({ fromHistory = false } = {}) {
  if (!viewerIsOpen()) return;
  viewerStore.set({ ...get(), ids: [], index: -1 });
  if (!fromHistory) viewerClosed();
}

export function stepViewer(step) {
  const { ids, index } = get();
  const next = index + step;
  if (next < 0 || next >= ids.length) return;
  viewerStore.set({ ...get(), index: next });
}

export const toggleViewerInfo = () => viewerStore.set({ ...get(), info: !get().info });

/** A file was deleted or moved out of the list: the viewer shows the next one, or closes. */
export function dropFromViewer(id) {
  const { ids, index } = get();
  const at = ids.indexOf(id);
  if (at < 0) return;
  const rest = ids.filter((x) => x !== id);
  if (!rest.length) return closeViewer();
  viewerStore.set({ ...get(), ids: rest, index: Math.min(at <= index ? index - (at < index ? 1 : 0) : index, rest.length - 1) });
}

