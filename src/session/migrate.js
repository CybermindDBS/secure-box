/**
 * ⋯ → Move or copy this vault: takes the open vault to another place (Google Drive, OneDrive, or
 * this device, in a folder you choose, or in this browser where that experiment is on), or to
 * another account of the same cloud.
 *
 *   1. Choose a place. Secure Box signs in there (or asks where on this device), and looks at what
 *      it holds (transfer.js, lookAt).
 *   2. A vault already there is never lost. One with the same master key is combined with this
 *      one (if it's an earlier copy of this one, that simply brings it up to date). One with a
 *      master key of its own is combined once its master password opens it. Or, if you choose, it
 *      goes first: to the bin in a cloud, for good on this device.
 *   3. The encrypted copies go first, as they are, by name (a transfer that stopped picks up where
 *      it was); then the vault and the key ring. Whatever changes meanwhile in the open vault
 *      (another window or device) is taken along.
 *   4. Secure Box reads it all back from there and checks it.
 *   5. Move: the vault opens from its new place, and only then is the old place cleared. A cloud
 *      keeps a short note of where it went, so other devices are told rather than finding it
 *      gone; its key ring and encrypted files go to the bin. This device deletes it.
 *      Copy: both stay, and each changes on its own from then on.
 * Nothing at the old place changes before step 5, so stopping or failing earlier loses nothing.
 */
import { formatBytes } from '../core/filetypes.js';
import { isNewer, serializeKeyring, trustedRevision, verifyRevision } from '../core/keyring.js';
import { allowFolder, findLocalVaults, forgetFolder, localSupport } from '../core/localstore.js';
import { BROWSER_VAULT } from '../experiments.js';
import { refreshMicrosoft } from '../core/microsoft.js';
import { checkPlace, copyFiles, encryptedSize, lookAt } from '../core/transfer.js';
import { compareVaults, emptyVault, mergeVaults, movedNoteText, parseEnvelope } from '../core/vault.js';
import { ask, crossFade } from './bridge.js';
import { counted, ensureDrive, pullLatest, reconnectNow, saveChain } from './cloud.js';
import { chooseDeviceWhere, deviceBackend, deviceVaultGone, forgetDeletedDevice } from './device.js';
import { files } from './files.js';
import * as memory from './memory.js';
import { backendFor, cipherFor, companyName, deviceUnavailable, folderPath, microsoftReady, placeName, providerName } from './places.js';
import { DEMO, publish, state } from './store.js';
import { tools } from './tools.js';
import { leaveEditing } from './viewer.js';
import { enterVault, markArriving, openOwnKeyring, signInPopup } from './vaults.js';
import { channel } from './windows.js';

/** An error a person can act on; `side`: which place it came from ('from' or 'to'), for Reconnect. */
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);
const at = (side, promise) =>
  promise.catch((err) => {
    if (err && typeof err === 'object' && !err.side) err.side = side;
    throw err;
  });

// ---------------------------------------------------------------------------
// Where the open vault is, and where it can go
// ---------------------------------------------------------------------------
/** The open vault's place: "Google Drive", "OneDrive", "this browser", "“Vaults” › Secure Box". */
export function placeOfOpen() {
  if (state.provider !== 'local') return DEMO ? 'the demo vault' : placeName(state.provider);
  return state.backend.where === 'folder' ? folderPath(state.backend.name) : 'this browser';
}

const freshAuth = (provider) => {
  const auth = state.auths[provider];
  return auth && auth.expiresAt - Date.now() > 10 * 60_000 ? auth : null;
};

/**
 * The places the open vault can go, for the dialog's first step: { id, provider, name, detail,
 * icon, disabled, why }. A cloud the vault is in already offers another account of it instead.
 */
export function destinations() {
  const from = state.provider;
  const rows = [];
  const clouds = DEMO ? ['google'] : ['google', ...(microsoftReady() ? ['microsoft'] : [])];
  for (const provider of clouds) {
    if (provider === from) {
      if (DEMO) continue;
      rows.push({ id: `${provider}:other`, provider, other: true, name: `Another ${companyName(provider)} account`, detail: 'You’ll choose the account in a sign-in window', icon: 'cloud' });
      continue;
    }
    const auth = freshAuth(provider);
    const hint = memory.readHint(provider);
    rows.push({
      id: provider,
      provider,
      name: placeName(provider),
      detail: DEMO ? 'Sample data, only in this tab' : auth ? `Signed in · ${auth.identity.email}` : hint ? `${hint} · you’ll sign in` : `Sign in with ${companyName(provider)}`,
      icon: 'cloud',
    });
  }
  const support = localSupport();
  const folderOk = support.folder && !DEMO;
  if (from === 'local') {
    const inBrowser = state.backend.where === 'browser';
    rows.push({
      id: 'local',
      provider: 'local',
      name: 'Another place on this device',
      detail: inBrowser ? 'A folder you choose' : BROWSER_VAULT && support.browser ? 'This browser, or another folder' : 'Another folder you choose',
      icon: 'device',
      disabled: !folderOk,
      why: folderOk ? '' : DEMO ? 'The demo keeps its vault on this device in the browser only.' : inBrowser ? 'This browser can only keep a vault in its own storage, where it is now.' : deviceUnavailable(),
    });
  } else {
    const blocked =
      BROWSER_VAULT && support.browser && support.ios && !support.standalone
        ? 'On iPhone and iPad, a vault on this device needs the Secure Box app on your Home Screen (Share → Add to Home Screen).'
        : deviceUnavailable();
    rows.push({
      id: 'local',
      provider: 'local',
      name: 'This device',
      detail: memory.deviceChoice() ? 'Your vault on this device is there' : !(BROWSER_VAULT && support.browser) ? 'A folder you choose' : folderOk ? 'In this browser, or a folder you choose' : 'In this browser',
      icon: 'device',
      disabled: Boolean(blocked),
      why: blocked,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Step 1: the place, and what it holds
// ---------------------------------------------------------------------------
/** How much is in a vault: { items, folders, files, bytes } (bytes: the files' own sizes). */
export const contentsOf = (vault) => ({ items: vault.items.length, folders: vault.folders.length, files: vault.files.length, bytes: vault.files.reduce((n, f) => n + f.size, 0) });

/** "12 passwords and notes and 3 files": what a vault holds, in words. */
export function describeContents(c) {
  const parts = [counted(c.items, 'password or note', 'passwords and notes'), counted(c.files, 'file', 'files')].filter(Boolean);
  return parts.length ? parts.join(' and ') : 'nothing yet';
}

/** Where a place is, in words: "OneDrive (you@example.com)", "this browser", "“Vaults” › Secure Box". */
function labelOf(dest) {
  if (dest.provider === 'local') return dest.backend.where === 'folder' ? folderPath(dest.backend.name) : 'this browser';
  if (DEMO) return 'the demo vault';
  return `${providerName(dest.provider)} (${dest.auth.identity.email})`;
}

/**
 * Signs in at (or finds, on this device) the place of `row` (from destinations()), and looks at
 * what it holds. Needs a click (a sign-in pop-up, a folder picker). Resolves with the plan the
 * dialog shows: { row, dest, look, there, compare, need, free }, or null if cancelled.
 */
export async function lookThere(row, { signal } = {}) {
  const kid = state.master.kid;
  const dest = { provider: row.provider, auth: null, backend: null, where: null };
  if (row.provider === 'local') {
    const found = await findDeviceDestination();
    if (!found) return null;
    Object.assign(dest, found);
  } else if (DEMO) {
    dest.backend = state.demoBackend;
  } else {
    let auth = row.other ? null : freshAuth(row.provider);
    if (!auth) auth = await signInPopup(row.provider, { signal, chooseAccount: Boolean(row.other) });
    if (!auth.driveGranted) throw fail(`Secure Box needs access to ${providerName(row.provider)}. Try again and allow it.`);
    auth.provider = row.provider;
    if (row.provider === state.provider && auth.identity.sub === state.identity?.sub)
      throw fail(`Your vault is in that ${companyName(row.provider)} account already. Choose another account, or another place.`);
    dest.auth = auth;
    dest.backend = backendFor(auth);
  }
  dest.where = dest.backend.where || null;
  dest.label = labelOf(dest);
  return look(row, dest, kid);
}

/** Looks at what `dest` holds, for the vault with master key `kid`. */
async function look(row, dest, kid) {
  const loaded = await at('to', dest.backend.load());
  const seen = lookAt(loaded, kid);
  const plan = { row, dest, look: seen, there: null, compare: null, their: null, need: 0, free: null };
  if (seen.kind === 'same' && seen.env) {
    plan.there = await state.cipher.open(seen.env);
    plan.compare = compareVaults(plan.there, state.vault);
  }
  plan.free = await dest.backend.freeSpace().catch(() => null);
  plan.need = await spaceNeeded(dest.backend, state.vault);
  return plan;
}

/** Bytes the open vault's encrypted copies need at `backend` (ones already there don't count). */
async function spaceNeeded(backend, vault) {
  const there = await backend.listBlobs().catch(() => new Map());
  return vault.files.reduce((n, f) => (there.get(f.blob)?.size === encryptedSize(f) ? n : n + encryptedSize(f)), 0);
}

/**
 * This device, as a place for the open vault: the vault this device uses already (so it's never
 * hidden behind a new one), or, if there's none, where to make it. From a vault on this device,
 * another place on it. Resolves with { backend } or null when cancelled.
 */
async function findDeviceDestination() {
  const kid = state.master.kid;
  if (state.provider === 'local') {
    const source = state.backend;
    const choice = await chooseDeviceWhere({ moving: source.where });
    if (!choice) return null;
    if (BROWSER_VAULT && choice.where === 'browser') {
      if (source.where === 'browser') throw fail('Your vault is in this browser already.');
      return { backend: deviceBackend({ where: 'browser', kid }) };
    }
    const backend = deviceBackend({ where: 'folder', handle: choice.handle, kid: null });
    const from = await source.root();
    const to = await backend.root(true);
    if (await from.isSameEntry(to)) throw fail(`Your vault is in “${choice.handle.name}” already.`);
    // Clearing the old place afterwards would take a vault inside it along.
    if (await from.resolve?.(to)) {
      await backend.dropIfEmpty().catch(() => {});
      throw fail('That folder is inside your vault’s own folder. Choose one outside it.');
    }
    return { backend };
  }
  const vaults = await findLocalVaults({ demo: DEMO });
  const pick = vaults.find((v) => v.kid === kid) || vaults.find((v) => v.kid === memory.deviceChoice()?.kid) || vaults.find((v) => v.where === 'browser') || vaults[0];
  if (pick) {
    if (pick.where === 'folder' && !pick.ready && !(await allowFolder(pick.handle))) throw fail('Secure Box wasn’t allowed to open the folder of your vault on this device.');
    const backend = deviceBackend({ where: pick.where, handle: pick.handle || null, kid: pick.kid, existing: true });
    try {
      await backend.load();
      return { backend };
    } catch (err) {
      if (err?.code !== 'gone') throw err;
      // Deleted or moved outside Secure Box: this vault can go there instead (or its folder be found).
      if (!(await deviceVaultGone(Object.assign(err, { kid: pick.kid, where: pick.where }), { moving: true }))) return null;
      return findDeviceDestination();
    }
  }
  // The vault this device had is gone already (this site's data cleared, say): said in passing.
  const remembered = memory.deviceChoice();
  const lost = remembered ? (BROWSER_VAULT && remembered.where === 'browser' ? 'this site’s data in the browser was cleared' : 'Secure Box lost track of its folder') : '';
  const choice = await chooseDeviceWhere();
  if (!choice) return null;
  return { backend: deviceBackend({ where: choice.where, handle: choice.handle || null, kid: choice.where === 'browser' ? kid : null }), lost };
}

/**
 * A vault with a master key of its own at the place: its master password (or Emergency Kit
 * recovery key) opens it, so the two can be combined. Resolves with the plan, now knowing it.
 */
export async function openTheirs(plan, secret) {
  const master = await openOwnKeyring(plan.look.doc, secret);
  await verifyRevision(plan.look.doc, master);
  const cipher = await cipherFor(master);
  const there = plan.look.env ? await cipher.open(plan.look.env) : emptyVault();
  return { ...plan, their: { master, cipher }, there, compare: compareVaults(there, state.vault) };
}

/** ⋯ → Move or copy this vault…: the dialog (ui/dialogs/MoveVault.jsx), once nothing is half-done. */
export async function openMoveVault() {
  if (!state.unlocked || state.switching || state.moving) return;
  if (!(await readyToGo())) return;
  await ask('moveVault', {});
}

/** Before a transfer: nothing half-done in the open vault that it would leave behind. Resolves false to stop. */
export async function readyToGo() {
  if (tools.busy()) throw fail('Finish or cancel the encryption that’s running first.');
  if (files.unfinished()) throw fail('Let the uploads finish first: a file still on its way would be left behind.');
  if (!(await leaveEditing())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Steps 2–5: the transfer
// ---------------------------------------------------------------------------
/**
 * Moves or copies the open vault to `plan.dest`. `mode`: 'move' or 'copy'. `replace`: what's
 * there goes first (to its bin; on this device, for good) instead of being combined.
 * `onStep(step)`: 'prepare' | 'clear' | 'copy' | 'write' | 'check' | 'open' | 'tidy';
 * `onProgress({ done, total, name })`: bytes copied. Resolves with what the dialog's last step
 * says: { mode, label, contents, missing, leftover }.
 */
export async function transfer(plan, { mode, replace = false, signal, onStep = () => {}, onProgress }) {
  if (state.moving) throw fail('A move is already under way.');
  const { dest } = plan;
  const source = { provider: state.provider, backend: state.backend, label: placeOfOpen(), email: state.identity?.email || '', sub: state.identity?.sub || '' };
  state.moving = true;
  publish();
  const awake = keepAwake();
  try {
    onStep('prepare');
    if (state.provider !== 'local') await at('from', ensureDrive());
    await saveChain; // a save still on its way goes first
    await at('from', pullLatest()); // and anything another device saved since
    let sourceRev = state.rev;

    let seen = plan.look;
    let there = plan.there;
    let theirRev = seen.rev;
    if (replace && seen.kind !== 'empty') {
      onStep('clear');
      dest.cleared = true; // what was there is gone, as chosen: the dialog says so if this stops
      await at('to', dest.backend.removeAll(there ? there.files.map((f) => f.blob) : []));
      if (dest.provider === 'local') {
        if (seen.doc && seen.doc.kid !== state.master.kid) await forgetDeletedDevice(seen.doc.kid);
        // In this browser each master key has a space of its own: the vault goes in the open one's.
        if (BROWSER_VAULT && dest.backend.where === 'browser') dest.backend = deviceBackend({ where: 'browser', kid: state.master.kid });
      }
      seen = lookAt(await at('to', dest.backend.load()), state.master.kid);
      there = null;
      theirRev = null;
    }
    const combine = seen.kind === 'same' || seen.kind === 'other';
    if (seen.kind === 'other' && !plan.their) throw fail('Its master password is needed to combine the two.');
    if (seen.kind === 'unreadable') throw fail('What’s there can’t be read, so it can only be replaced.');
    const master = seen.kind === 'other' ? plan.their.master : state.master;
    const cipher = seen.kind === 'other' ? plan.their.cipher : state.cipher;
    let base = combine ? there || emptyVault() : null;
    const build = () => (combine ? mergeVaults(base, state.vault) : { ...state.vault, trash: [] });
    const ours = () => new Set(state.vault.files.map((f) => f.blob));

    // The encrypted copies, then whatever the open vault gained meanwhile, then once more.
    let target = build();
    let missing = [];
    for (let round = 0; ; round++) {
      onStep('copy');
      const mine = ours();
      ({ missing } = await copyFiles({
        from: sideOf(source.backend, 'from'),
        to: sideOf(dest.backend, 'to'),
        files: target.files.filter((f) => mine.has(f.blob)),
        signal,
        onProgress,
        onCopied: (name) => copiesMade(dest).add(name),
      }));
      if (round === 2 || (await at('from', source.backend.vaultRevision())) === sourceRev) break;
      await at('from', pullLatest());
      sourceRev = state.rev;
      target = build();
    }

    // The key ring and the vault.
    onStep('write');
    signal?.throwIfAborted();
    let keyringDoc = seen.kind === 'other' ? seen.doc : state.keyringDoc;
    let rev;
    if (!combine) {
      rev = await at('to', dest.backend.create({ keyringText: serializeKeyring(state.keyringDoc), vaultText: await cipher.seal(target), kid: master.kid }));
    } else {
      if (seen.kind === 'same') keyringDoc = await settleKeyring(dest.backend, seen.doc);
      for (let attempt = 0; ; attempt++) {
        try {
          const text = await cipher.seal(target);
          rev = seen.env || theirRev ? await at('to', dest.backend.writeVault(text, theirRev)) : await at('to', dest.backend.createVault(text, master.kid));
          break;
        } catch (err) {
          if (!['conflict', 'overwrote'].includes(err?.code) || attempt === 3) throw err;
          // Saved there meanwhile (on another device): combine with that, and save again.
          if (err.code === 'overwrote') {
            base = await cipher.open(parseEnvelope(await dest.backend.readRevision(err.overwrote)));
            theirRev = err.rev;
          } else {
            const fresh = await at('to', dest.backend.readVault());
            base = await cipher.open(parseEnvelope(fresh.text));
            theirRev = fresh.rev;
          }
          target = build();
        }
      }
    }

    // Read back and checked: the key ring, the vault, and every copy this vault brought.
    onStep('check');
    const mine = ours();
    const checked = await at('to', checkPlace({ backend: dest.backend, cipher, kid: master.kid, files: target.files.filter((f) => mine.has(f.blob)), skip: new Set(missing.map((f) => f.id)) }));
    const result = {
      mode,
      label: dest.label,
      from: source.label,
      contents: contentsOf(checked.vault),
      missing: missing.map((f) => f.name),
      leftover: null,
      combined: combine && !plan.compare?.earlierCopy,
      updated: Boolean(plan.compare?.earlierCopy),
      ownKey: seen.kind === 'other', // combined into a vault with a master key of its own
    };
    made.delete(dest); // the copies are the vault's now
    if (mode === 'copy') return result;

    // Move: the vault opens from its new place...
    onStep('open');
    await crossFade(() => {
      enterVault({ provider: dest.provider, backend: dest.backend, auth: dest.auth, keyringDoc, cipher, vault: checked.vault, rev: checked.rev, master });
      markArriving();
      publish({ now: true });
    });
    if (dest.auth) memory.saveHint(dest.auth.identity.email, dest.provider);
    // ...then the old place is cleared. If that fails, the dialog offers to try again.
    onStep('tidy');
    const tidy = () => clearOldPlace(source, dest, [...mine]);
    result.leftover = await tidy().then(
      () => null,
      (err) => ({ message: err?.message || String(err), retry: tidy }),
    );
    return result;
  } finally {
    awake.release();
    state.moving = false;
    publish();
  }
}

/** The backend `backend`, with its errors marked as coming from `side`, for the copying. */
function sideOf(backend, side) {
  const tag =
    (run) =>
    (...args) =>
      at(side, run(...args));
  return { ...backend, listBlobs: tag(backend.listBlobs.bind(backend)), readRange: tag(backend.readRange.bind(backend)), openUpload: tag(backend.openUpload.bind(backend)) };
}

/** A vault with the same master key there: both copies of the key ring go to the newer one. Resolves with it. */
async function settleKeyring(backend, theirs) {
  const ours = state.keyringDoc;
  if (!theirs || isNewer(ours, theirs)) {
    await at('to', backend.putKeyring(serializeKeyring(ours), state.master.kid));
    return ours;
  }
  if (isNewer(theirs, ours)) {
    // Changed there more recently (a new master password, say): this session takes it too.
    await verifyRevision(theirs, state.master);
    state.keyringDoc = theirs;
    state.masters.set(theirs.kid, { master: state.master, keyringDoc: theirs });
    memory.rememberKeyring(theirs.kid, trustedRevision(theirs));
    return theirs;
  }
  return ours;
}

/**
 * After a move: the old place is cleared. A cloud keeps a note of where the vault went (other
 * devices are told so, rather than finding it gone), and its key ring and encrypted files go to
 * the bin; this device deletes it. Resolves with nothing, or throws what kept the old copy.
 */
async function clearOldPlace(source, dest, names) {
  const kid = state.master.kid;
  if (source.backend.kind === 'local') {
    await source.backend.removeAll();
    if (dest.provider !== 'local') await forgetDeletedDevice(source.backend.kid || kid);
    else if (BROWSER_VAULT && dest.backend.where === 'browser') await forgetFolder(kid, { demo: DEMO }); // the old folder's handle
  } else {
    await source.backend.retire(movedNoteText(dest.provider), names);
    memory.forgetCloudVault(source.provider, source.email);
  }
  // Other windows of this browser with it open lock, and open it in its new place when unlocked.
  channel?.postMessage({ type: 'vault-moved', provider: source.provider, sub: source.sub, kid: source.backend.kid || kid });
}

/** The encrypted copies a transfer made at `dest` so far (kept between tries, so trying again picks up). */
const made = new WeakMap();
const copiesMade = (dest) => made.get(dest) || made.set(dest, new Set()).get(dest);

/**
 * A transfer that stopped (or failed), and isn't tried again: the copies it made there go, as
 * no vault names them. Only those: anything else there is untouched.
 */
export async function dropCopies(plan) {
  const names = [...copiesMade(plan.dest)];
  made.delete(plan.dest);
  for (const name of names) await plan.dest.backend.trash(name).catch((err) => console.warn('A copy stayed:', err));
  await plan.dest.backend.dropIfEmpty?.().catch(() => {}); // on this device, the folders made for it too
}

/** A move's old place that couldn't be cleared: tries again (the dialog's button). */
export const clearAgain = (leftover) => leftover.retry();

// ---------------------------------------------------------------------------
// Reconnecting mid-way, and keeping the screen on
// ---------------------------------------------------------------------------
/** A transfer stopped because a sign-in ran out (`err.side`): signs in again there. Needs a click. */
export async function reconnect(plan, side) {
  if (side === 'from') return reconnectNow();
  const auth = plan.dest.auth;
  if (!auth) return;
  if (auth.refreshToken) {
    const fresh = await refreshMicrosoft(state.config.microsoftClientId, auth).catch(() => null);
    if (fresh) return Object.assign(auth, fresh);
  }
  const fresh = await signInPopup(plan.dest.provider, { loginHint: auth.identity.email, expectedSub: auth.identity.sub });
  if (fresh.identity.sub !== auth.identity.sub) throw fail(`That’s another account. Sign in as ${auth.identity.email}.`);
  Object.assign(auth, fresh, { provider: plan.dest.provider });
}

/** The screen stays on while a transfer runs (a phone would otherwise sleep and stop it). */
function keepAwake() {
  let lock = null;
  let done = false;
  const take = () => {
    if (done || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(
      (l) => {
        if (done) l.release().catch(() => {});
        else lock = l;
      },
      () => {},
    );
  };
  document.addEventListener('visibilitychange', take);
  take();
  return {
    release() {
      done = true;
      document.removeEventListener('visibilitychange', take);
      lock?.release().catch(() => {});
    },
  };
}

/** "3.4 MB of 12.1 MB" and the like, for the dialog. */
export const bytesText = (n) => formatBytes(n);
