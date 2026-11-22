/**
 * Bringing a vault over from Secure Box's previous connection to a cloud.
 *
 * What Secure Box can see in a cloud depends on the app it connects as: Google Drive shows an
 * app only the files its own Google Cloud project made, and OneDrive only its own app
 * registration's folder. So if Secure Box ever switches to a new project or app registration,
 * every vault looks gone to it, though nothing was deleted. While the old one still works,
 * config.json names it as the previous connection, and Secure Box brings each vault over itself:
 * it signs in through the previous connection too (the person only approves that sign-in), and
 * copies the vault across exactly as stored: its encrypted copies, key ring and vault, nothing
 * decrypted. The old copy stays where it was until you delete it. On Google Drive its folder is
 * renamed, as Drive would otherwise show two folders called “Secure Box”.
 *
 * When the previous connection is gone for good, the cloud's own website is the way back: the
 * vault's folder, downloaded there, restores like a backup (localstore.js readBackup).
 */
import { parseKeyring } from '../core/keyring.js';
import { copyFiles } from '../core/transfer.js';
import { movedNote } from '../core/vault.js';
import { toast } from './bridge.js';
import * as memory from './memory.js';
import { backendFor, companyName, previousClientId, providerName } from './places.js';
import { DEMO, state } from './store.js';
import { openAccount, showError, showPanel, showStart, showWorking, signInPopup } from './vaults.js';

/** The old copy's folder on Google Drive, once its vault was brought over. */
export const OLD_COPY_NAME = 'Secure Box (old copy)';

/** Vault-missing card → Bring it over. Must come from a click: it opens a sign-in pop-up. */
export async function bringOver() {
  const provider = state.provider;
  const clientId = previousClientId(provider);
  if (!clientId) return openAccount();
  let old;
  try {
    old = await previousBackend(provider, clientId);
  } catch (err) {
    if (err?.code === 'cancelled') return undefined;
    // It doesn't work any more (or the window was closed): the download is the other way back.
    return showPanel('vault-missing', { kind: 'app', failed: err?.message || String(err) });
  }
  showWorking('Looking for your vault through Secure Box’s previous connection…');
  try {
    const loaded = await old.load();
    const note = loaded.vault && movedNote(loaded.vault.text);
    if (note) {
      return showError({
        title: 'Your vault moved from there',
        message: `Through Secure Box’s previous connection, your ${providerName(provider)} only has a note that the vault moved to another place. Open it from that place.`,
        action: 'show-welcome',
        actionLabel: 'Open another vault',
      });
    }
    if (!loaded.keyring || !loaded.vault) {
      // Nothing there either: deleted, if this browser had a vault in this account.
      if (memory.hadCloudVault(provider, state.identity?.email)) return showPanel('vault-missing', { kind: 'cloud' });
      toast(`Secure Box’s previous connection has no vault in this ${companyName(provider)} account either.`);
      return showStart();
    }
    const { kid } = parseKeyring(loaded.keyring);
    const listed = await old.listBlobs();
    const items = [...listed].map(([blob, { size }]) => ({ blob, name: blob, bytes: size }));
    let shown = -1;
    const { missing } = await copyFiles({
      from: old,
      to: state.backend,
      files: items,
      onProgress: ({ done, total }) => {
        const percent = total ? Math.floor((done / total) * 100) : 100;
        if (percent !== shown) showWorking(`Bringing your vault over… ${(shown = percent)}%`);
      },
    });
    // Then its key ring and vault (once every copy is there, so the vault never names one that isn't),
    // and only the part a try that stopped didn't write yet.
    const there = await state.backend.load();
    if (!there.keyring && !there.vault) await state.backend.create({ keyringText: loaded.keyring, vaultText: loaded.vault.text, kid });
    else if (!there.vault) await state.backend.createVault(loaded.vault.text, kid);
    // Read back: the same key ring and vault, and every copy whole.
    const here = await state.backend.load();
    if (here.keyring !== loaded.keyring || here.vault?.text !== loaded.vault.text) throw new Error('Your vault didn’t arrive whole.');
    const arrived = await state.backend.listBlobs();
    const lost = new Set(missing.map((m) => m.blob));
    if (items.some((item) => !lost.has(item.blob) && arrived.get(item.blob)?.size !== item.bytes)) throw new Error('Not every encrypted file arrived whole.');
    // The old copy stays, under a name of its own on Google Drive (OneDrive gives each app its own folder anyway).
    await old.renameFolder?.(OLD_COPY_NAME).catch(() => {});
    const kept = provider === 'google' ? `The old copy stays in your Google Drive as “${OLD_COPY_NAME}” until you delete it.` : 'The old copy stays in your OneDrive until you delete it.';
    const holes = missing.length ? ` ${missing.length === 1 ? 'One encrypted file' : `${missing.length} encrypted files`} couldn’t be read there, so ${missing.length === 1 ? 'it shows' : 'they show'} as missing.` : '';
    toast(`Your vault is here now. ${kept}${holes}`, holes ? 'error' : 'info');
    return openAccount();
  } catch (err) {
    return showError({
      title: 'Your vault wasn’t brought over yet',
      message: `${err?.message || err} Choose Bring it over to try again: it picks up where it stopped.`,
      action: 'bring-over',
      actionLabel: 'Bring it over',
    });
  }
}

/** A backend for the same account, through Secure Box's previous connection (a sign-in pop-up). */
async function previousBackend(provider, clientId) {
  if (DEMO) {
    // As Google answers when the app behind a connection was deleted.
    if (state.demoPrevious.gone) throw new Error('The demo’s previous connection was deleted.');
    return state.demoPrevious.backend;
  }
  const auth = await signInPopup(provider, { clientId, loginHint: state.identity?.email, expectedSub: state.identity?.sub, previous: { identity: state.identity } });
  if (!auth.driveGranted) throw new Error(`Secure Box’s previous connection needs access to your ${providerName(provider)}. Try again and allow it.`);
  return backendFor({ ...auth, provider });
}
