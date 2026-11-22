/**
 * Moving or copying a vault from one place to another: Google Drive, OneDrive, or this device.
 * A vault is the same in every place (vault.js): its key ring, its vault, and one encrypted copy
 * per file, named in the vault. So a transfer copies the encrypted copies exactly as they are, by
 * name (nothing is decrypted or encrypted again), then writes the vault and key ring, then reads
 * back what's there. The session (migrate.js) decides what's written, and changes nothing at the
 * old place until the vault is open from the new one.
 */
import { createPieceWriter, layout } from './fileformat.js';
import { parseKeyring } from './keyring.js';
import { movedNote, parseEnvelope } from './vault.js';

/** How big a file's encrypted copy is. */
export const encryptedSize = (file) => layout({ size: file.size, thumbBytes: file.thumbBytes, chunk: file.chunk }).total;

/**
 * What's at a place (its backend's load()), for a vault arriving with master key id `kid`:
 *   empty       no vault: nothing at all, a note that a vault moved away (`note`), or encrypted
 *               copies left by a transfer that stopped (picked up again). `inBin`: Google Drive
 *               has one in its bin, which stays there.
 *   same        a vault with this master key (`doc`, `env`, `rev`): a copy of this one from before,
 *               or one set up with the same master password. Either can be missing its key ring
 *               or its vault file.
 *   other       a vault with a master key of its own (`doc`, `env`, `rev`)
 *   unreadable  something that can't be read (`reason`): another version, damaged, half there
 */
export function lookAt(loaded, kid) {
  if (loaded.vault && movedNote(loaded.vault.text)) return { kind: 'empty', note: movedNote(loaded.vault.text) };
  let doc = null;
  let env = null;
  try {
    doc = loaded.keyring ? parseKeyring(loaded.keyring) : null;
  } catch (err) {
    return { kind: 'unreadable', code: err.code || '', reason: err.message };
  }
  try {
    env = loaded.vault ? parseEnvelope(loaded.vault.text) : null;
  } catch (err) {
    return { kind: 'unreadable', code: err.code || '', reason: err.message };
  }
  if (!doc && !env) return { kind: 'empty', inBin: Boolean(loaded.inBin) };
  if (doc && env && doc.kid !== env.kid) return { kind: 'unreadable', reason: 'Its key ring and its vault belong to different master keys.' };
  const rev = loaded.vault?.rev ?? null;
  if ((doc || env).kid === kid) return { kind: 'same', doc, env, rev };
  // A vault of another master key, without its key ring: nothing can open it.
  if (!doc) return { kind: 'unreadable', reason: 'Its key ring is missing, and it was made with another master key.' };
  return { kind: 'other', doc, env, rev };
}

const isMissing = (err) => err?.code === 'not-found' || err?.status === 404;

/**
 * Copies one encrypted copy from `from` to `to`, by name. Resolves true once it's there whole,
 * false if it isn't at `from` (or isn't whole there). `onBytes(n)`: bytes of it sent so far.
 */
async function copyOne({ from, to }, file, size, signal, onBytes) {
  let stream;
  try {
    stream = await from.readRange(file.blob, 0, size - 1);
  } catch (err) {
    if (!isMissing(err)) throw err;
    return false;
  }
  const reader = stream.getReader();
  let send;
  let read = 0;
  try {
    send = await to.openUpload({ name: file.blob, size, signal });
    const writer = createPieceWriter({ total: size, send, pieceSize: send.pieceSize, onProgress: (p) => onBytes(p * size) });
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      signal.throwIfAborted();
      read += next.value.length;
      if (read > size) break;
      await writer.write(next.value);
    }
    if (read === size && writer.result) return true;
  } catch (err) {
    await reader.cancel().catch(() => {});
    await send?.abort?.();
    throw err;
  }
  // The copy there isn't whole (cut short, or longer than its record says): left out.
  await reader.cancel().catch(() => {});
  await send.abort?.();
  return false;
}

/**
 * Copies the encrypted copies of `files` (vault file entries) from `from` to `to`, by name. One
 * already there with the right size is kept, so a transfer that stopped picks up where it was.
 * An item can give its copy's size as `bytes` instead ({ blob, name, bytes }: copies listed where
 * they are, when the vault isn't open to say what's in them).
 * `parallel` copies go at once: with many small files a copy is mostly waiting on the network,
 * so waits that overlap finish sooner (uploads do the same). `onProgress({ done, total, name })`
 * counts bytes; `onCopied(name)` hears of each copy made. Resolves with { copied, kept, missing }:
 * `missing` lists the files whose copy isn't at `from` (or isn't whole there): nothing can bring
 * those back, so they're left out rather than stopping everything. One copy failing stops the
 * others; this resolves or throws only once none is still going.
 */
export async function copyFiles({ from, to, files, signal, onProgress, onCopied, parallel = 3 }) {
  const there = await to.listBlobs();
  const todo = [];
  let kept = 0;
  for (const file of files) {
    const size = file.bytes ?? encryptedSize(file);
    if (there.get(file.blob)?.size === size) kept++;
    else todo.push({ file, size });
  }
  const total = todo.reduce((sum, t) => sum + t.size, 0);
  const missing = [];
  const going = new Map(); // file -> bytes of it sent so far, while it's being copied
  let done = 0;
  let copied = 0;
  const report = () => {
    let sent = done;
    for (const n of going.values()) sent += n;
    const name = [...going.keys()].at(-1)?.name || '';
    onProgress?.({ done: sent, total, name, files: todo.length, copied });
  };
  report();
  signal?.throwIfAborted();
  // Stops every copy under way: when you stop, or when one of them fails.
  const stop = new AbortController();
  const stopped = stop.signal;
  const forward = () => stop.abort(signal.reason);
  signal?.addEventListener('abort', forward, { once: true });
  let failure = null;
  let next = 0;
  const copier = async () => {
    while (next < todo.length && !stopped.aborted) {
      const { file, size } = todo[next++];
      going.set(file, 0);
      report();
      try {
        const whole = await copyOne({ from, to }, file, size, stopped, (n) => {
          going.set(file, n);
          report();
        });
        if (whole) {
          copied++;
          onCopied?.(file.blob);
        } else missing.push(file);
      } catch (err) {
        failure ||= err;
        stop.abort(err);
        return;
      } finally {
        going.delete(file);
        done += size;
      }
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, todo.length)) }, copier));
  } finally {
    signal?.removeEventListener('abort', forward);
  }
  if (failure) throw failure;
  signal?.throwIfAborted();
  report();
  return { copied, kept, missing };
}

/**
 * Reads back what a transfer wrote to `backend`: the key ring of master key `kid`, a vault that
 * `cipher` opens, and every encrypted copy `files` need, whole (except `skip`, the ids of files
 * whose copy was missing anyway). Resolves with { doc, vault, rev }; throws what isn't right.
 */
export async function checkPlace({ backend, cipher, kid, files, skip = new Set() }) {
  const loaded = await backend.load();
  const doc = loaded.keyring ? parseKeyring(loaded.keyring) : null;
  if (!doc || doc.kid !== kid) throw new Error('The key ring there isn’t the one just written.');
  if (!loaded.vault) throw new Error('The vault there wasn’t written.');
  const vault = await cipher.open(parseEnvelope(loaded.vault.text));
  const ids = new Set(vault.files.map((f) => f.id));
  const blobs = await backend.listBlobs();
  for (const file of files) {
    if (skip.has(file.id)) continue;
    if (!ids.has(file.id)) throw new Error(`“${file.name}” is missing from the vault there.`);
    if (blobs.get(file.blob)?.size !== encryptedSize(file)) throw new Error(`“${file.name}” didn’t copy completely.`);
  }
  return { doc, vault, rev: loaded.vault.rev };
}
