/**
 * The Passwords tab: items (logins and secure notes), CSV import and export, and the account's
 * key ring: master password, Emergency Kit and key ring backup.
 */
import { KeyringError, passwordProblem, serializeKeyring, trustedRevision, unlockWithPassword, withNewPassword, withNewRecovery } from '../core/keyring.js';
import { applyChange, hostnameOf, itemsFromCsv, itemsToCsv, makeItem } from '../core/vault.js';
import { ask, confirmDialog, toast } from './bridge.js';
import { commit, describeSaveError, ensureDrive } from './cloud.js';
import { copyText, downloadFile, pickFile } from './io.js';
import * as memory from './memory.js';
import { pushNav } from './nav.js';
import { PROVIDERS, providerName } from './places.js';
import { publish, state } from './store.js';
import { channel } from './windows.js';
import { freshenOpenKeyring, spreadKeyring } from './vaults.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const narrow = () => window.matchMedia('(max-width: 760px)').matches;

// ===========================================================================
// The list and the open item
// ===========================================================================
export function visibleItems(vault = state.vault, query = state.query) {
  if (!vault) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return vault.items
    .filter((it) => !terms.length || terms.every((t) => `${it.title}\n${it.username}\n${it.url}\n${it.notes}`.toLowerCase().includes(t)))
    .sort((a, b) => collator.compare(a.title, b.title));
}

export const subtitleOf = (item) => (item.type === 'note' ? 'Secure note' : item.username || hostnameOf(item.url) || 'Login');

export function selectItem(id, { push = true } = {}) {
  if (state.selectedId !== id) state.revealed = new Set();
  state.selectedId = id;
  publish();
  if (push && id && narrow()) pushNav(); // on phones the item fills the screen: Back closes it
}

export function moveSelection(step) {
  const items = visibleItems();
  if (!items.length) return;
  const index = items.findIndex((it) => it.id === state.selectedId);
  const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + step));
  selectItem(items[next].id);
}

/** The detail's back arrow on phones goes Back, so the browser's Back button stays in step. */
export function closeDetail() {
  if (history.state?.sb && history.state.item) history.back();
  else selectItem(null);
}

export function setQuery(query) {
  state.query = query;
  publish();
}

/** Shows or hides one secret field ("itemId:field"). */
export function toggleReveal(key) {
  const next = new Set(state.revealed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  state.revealed = next;
  publish();
}

export async function copyValue(value, label, sensitive) {
  try {
    await copyText(value, { sensitive });
    toast(sensitive ? `${label} copied · clears in 30s` : `${label} copied`);
  } catch {
    toast('The browser blocked clipboard access.', 'error');
  }
}

const setPending = (id, what) => {
  const next = new Map(state.pending);
  if (what) next.set(id, what);
  else next.delete(id);
  state.pending = next;
  publish();
};

// ===========================================================================
// Saving and deleting items
// ===========================================================================
/** Saves the editor's values; resolves '' when saved, or what went wrong. */
export async function saveItem(values, previous = null) {
  const loginDetails = values.type === 'login' && (values.username.trim() || values.password || values.url.trim());
  if (!values.title.trim() && !values.notes.trim() && !loginDetails) return 'Add a title or some details first.';
  const item = makeItem(values, previous);
  // An edit sends only the fields that changed, so another device's edits to the rest stay.
  const fields = previous && Object.fromEntries(['type', 'title', 'username', 'password', 'url', 'notes'].filter((key) => item[key] !== previous[key]).map((key) => [key, item[key]]));
  setPending(item.id, 'saving');
  try {
    await ensureDrive();
    await commit(previous ? { op: 'item-update', item, fields } : { op: 'put', item });
    state.selectedId = item.id;
    state.revealed = new Set();
    publish();
    toast(previous ? 'Changes saved' : 'Saved to your vault');
    return '';
  } catch (err) {
    return describeSaveError(err);
  } finally {
    setPending(item.id, null);
  }
}

export async function deleteItem(item) {
  const ok = await confirmDialog({ title: `Delete “${item.title}”?`, message: 'It will be removed from your vault on every device.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  setPending(item.id, 'deleting');
  try {
    await ensureDrive();
    await commit({ op: 'delete', id: item.id });
    if (state.selectedId === item.id) state.selectedId = null;
    publish();
    toast('Item deleted');
  } catch (err) {
    toast(describeSaveError(err), 'error');
  } finally {
    setPending(item.id, null);
  }
}

// ===========================================================================
// CSV
// ===========================================================================
// Today where you are (YYYY-MM-DD), not in UTC, which can still be yesterday or already tomorrow.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function importCsv() {
  const file = await pickFile('.csv,text/csv');
  if (!file) return;
  let items;
  try {
    items = itemsFromCsv(await file.text());
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const added = applyChange(state.vault, { op: 'import', items }).items.length - state.vault.items.length;
  if (!added) return toast('Everything in that file is already in your vault.');
  const plural = added === 1 ? '' : 's';
  const ok = await confirmDialog({
    title: `Import ${added} item${plural}?`,
    message: `From “${file.name}”. They will be encrypted and added to your vault. Delete the CSV afterwards — it is not encrypted.`,
    confirmLabel: 'Import',
  });
  if (!ok) return;
  try {
    await ensureDrive();
    await commit({ op: 'import', items });
    publish();
    toast(`Imported ${added} item${plural}`);
  } catch (err) {
    toast(describeSaveError(err), 'error');
  }
}

export async function exportCsv() {
  const ok = await confirmDialog({
    title: 'Export an unencrypted CSV?',
    message: 'The file will contain every password and note in plain text. Keep it somewhere safe and delete it when you are done.',
    confirmLabel: 'Export',
  });
  if (ok) downloadFile(`secure-box-passwords-${today()}.csv`, itemsToCsv(state.vault.items), 'text/csv;charset=utf-8');
}

// ===========================================================================
// The key ring: master password, Emergency Kit, backup
// ===========================================================================
const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Which vaults a change to the open key ring reaches (#19): every vault that shares it, and a
 * word about the ones with a key ring of their own.
 */
export function keyringScope() {
  const kid = state.master?.kid;
  const shared = PROVIDERS.filter((p) => state.kids[p] === kid).map((p) => (p === 'local' ? 'this device’s' : providerName(p)));
  const own = PROVIDERS.filter((p) => state.kids[p] && state.kids[p] !== kid).map((p) => (p === 'local' ? 'This device’s' : providerName(p)));
  let text = `It changes for your ${joinNames(shared)} ${shared.length === 1 ? 'vault' : 'vaults'}`;
  const others = PROVIDERS.filter((p) => !state.kids[p] && (p === 'local' ? memory.deviceChoice() : memory.readHint(p))).map((p) => (p === 'local' ? 'this device’s' : providerName(p)));
  if (others.length) text += `, and your ${joinNames(others)} ${others.length === 1 ? 'vault gets' : 'vaults get'} it when you next open ${others.length === 1 ? 'it' : 'them'} here`;
  text += '.';
  if (own.length) text += ` ${joinNames(own)} ${own.length === 1 ? 'vault has' : 'vaults have'} a master password of its own and ${own.length === 1 ? 'isn’t' : 'aren’t'} changed.`;
  return text;
}

/** After a key ring change here: the other Secure Box windows read it too. */
const announceKeyring = (kid) => channel?.postMessage({ type: 'keyring-changed', kid });

/** The Change master password dialog: resolves '' when changed, or what went wrong. */
export async function changePassword({ current, next, confirm }) {
  const problem = passwordProblem(next, confirm);
  if (!current) return 'Enter your current master password.';
  if (problem) return problem;
  try {
    // On top of the newest copy, so it never undoes a change made in another window or device.
    const doc = await freshenOpenKeyring();
    try {
      await unlockWithPassword(doc, current);
    } catch (err) {
      if (err instanceof KeyringError) return 'Your current master password is not correct.';
      throw err;
    }
    await ensureDrive();
    const changed = await withNewPassword(doc, state.master, next, { after: memory.keyringMemory(state.master.kid)?.revision || 0 });
    await state.backend.saveKeyring(serializeKeyring(changed));
    state.keyringDoc = changed;
    state.masters.set(state.master.kid, { master: state.master, keyringDoc: changed });
    memory.rememberKeyring(state.master.kid, trustedRevision(changed), { passwordChanged: true });
    announceKeyring(state.master.kid);
    await spreadKeyring(state.backend); // this device's vault and the clouds signed in now
    toast('Master password changed');
    return '';
  } catch (err) {
    return describeSaveError(err);
  }
}

/** A new Emergency Kit: the old one stops working. It's shown so it can be saved more than one way. */
export async function newEmergencyKit() {
  const ok = await confirmDialog({
    title: 'Make a new Emergency Kit?',
    message: `Your current Emergency Kit stops working. ${keyringScope()} Save the new one offline: never in your cloud drive or email.`,
    confirmLabel: 'Make new kit',
  });
  if (!ok) return;
  try {
    await ensureDrive();
    const doc = await freshenOpenKeyring();
    const { doc: changed, recovery } = await withNewRecovery(doc, state.master, { after: memory.keyringMemory(state.master.kid)?.revision || 0 });
    await state.backend.saveKeyring(serializeKeyring(changed));
    state.keyringDoc = changed;
    state.masters.set(state.master.kid, { master: state.master, keyringDoc: changed });
    memory.rememberKeyring(state.master.kid, trustedRevision(changed));
    announceKeyring(state.master.kid);
    await ask('kit', { recovery, email: state.identity?.email || '', fresh: true });
    spreadKeyring(state.backend).catch((err) => console.warn('Key ring update:', err));
    toast('New Emergency Kit ready: the old one no longer works');
  } catch (err) {
    toast(describeSaveError(err), 'error');
  }
}

/** A copy of the key ring: with the master password or the kit, it opens .sbox files and messages anywhere. */
export async function exportKeyring() {
  if (!state.unlocked || !state.keyringDoc) throw new Error('Unlock Secure Box first.');
  const ok = await confirmDialog({
    title: 'Export key ring backup?',
    message:
      'The key ring is your master key, locked with your master password and Emergency Kit. With this copy and your master password or Emergency Kit, you can open your .sbox files and messages on any device, and start a new vault with the same master password. Keep it private: it keeps opening with today’s master password and Emergency Kit, even after you change them.',
    confirmLabel: 'Export',
  });
  if (!ok) return;
  downloadFile(`Secure Box Key Ring backup (${state.keyringDoc.kid}).json`, serializeKeyring(state.keyringDoc), 'application/json');
  toast('Key ring backup downloaded');
}
