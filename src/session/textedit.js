/**
 * Saving a .txt file edited in the viewer (viewer.js holds what's being edited). The text never
 * touches the disk: it's encrypted in memory and uploaded as the file's new encrypted copy
 * (files.js, saveTextFile). If the file changed or was deleted elsewhere while it was being
 * edited, nothing is overwritten: the text is saved beside it instead, once confirmed.
 */
import { encodeText } from '../core/textfile.js';
import { confirmDialog, toast } from './bridge.js';
import { saveTextFile } from './files.js';
import { state } from './store.js';
import { editingSaved, viewerStore } from './viewer.js';

/** Saves `text` for the file being edited. Resolves with the saved entry, or null if not saved. */
export async function saveEditing(text) {
  const editing = viewerStore.get().editing;
  if (!editing) return null;
  const current = state.vault?.files.find((f) => f.id === editing.id) || null;
  let asNew = false;
  if (!current) {
    const ok = await confirmDialog({
      title: 'This file was deleted',
      message: `“${editing.base.name}” was deleted on another device or in another window while you were editing it. Save your text as a new file?`,
      confirmLabel: 'Save as a new file',
      cancelLabel: 'Keep editing',
    });
    if (!ok) return null;
    asNew = true;
  } else if (current.blob !== editing.base.blob) {
    const ok = await confirmDialog({
      title: 'This file changed meanwhile',
      message: `“${current.name}” was saved on another device or in another window while you were editing it. Save yours as a copy beside it, so neither is lost?`,
      confirmLabel: 'Save as a copy',
      cancelLabel: 'Keep editing',
    });
    if (!ok) return null;
    asNew = true;
  }
  const base = current ? { ...editing.base, folder: current.folder } : editing.base;
  let entry;
  try {
    entry = await saveTextFile(base, encodeText(text, editing.style), { asNew });
  } catch (err) {
    // Saved elsewhere at the very same moment: ask again, now that the vault shows that save.
    if (err?.code === 'changed') return saveEditing(text);
    throw err;
  }
  // A copy is shown beside the file that changed meanwhile, or in place of the one deleted.
  const place = entry.id === editing.id ? null : current ? { after: editing.id } : { instead: editing.id };
  editingSaved(entry, text, place);
  toast(place ? `Saved as “${entry.name}”` : 'Saved');
  return entry;
}
