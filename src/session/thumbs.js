/**
 * Thumbnails for the Files tab, loaded only for what's in view or about to be (a screen ahead), a
 * few at a time: first the ones that will be in view by the time they're here (what's on screen
 * while the list is still, what's coming while it scrolls), so a card scrolled into view usually
 * shows its thumbnail already. Scrolling past thousands of photos never sends thousands of
 * requests at once (a cloud would start refusing them), and a thumbnail scrolled away from before
 * its turn isn't loaded at all. Each one is decrypted in this browser (by the streaming worker)
 * and kept in this page's memory while the vault is open, so a folder opened again shows its
 * thumbnails at once. Opening another vault forgets them, and locking reloads the page.
 */
import { fileUrl } from '../core/stream.js';

const AT_ONCE = 32; // thumbnails loading at the same time: a computer screen of them in one go
const KEEP = 600; // thumbnails kept that aren't on screen (a few MB)
const RETRY_AFTER = 60_000; // one that couldn't be loaded isn't asked for again before then

const kept = new Map(); // key -> { url, holders }, the least recently used first
const failedAt = new Map(); // key -> when it couldn't be loaded
const wanted = new Map(); // key -> { entry, waiters, started, nearness }
let loading = 0;
let pumping = false;
let typical = 400; // how long a thumbnail has been taking to arrive, in ms
let held = 0; // kept thumbnails shown right now (never forgotten while shown)
let generation = 0; // loads from before forgetThumbs() are dropped

const keyOf = (entry) => `${entry.id}:${entry.blob}`;

/** `entry`'s thumbnail if it's kept already (an object URL), or null. */
export function keptThumb(entry) {
  const key = keyOf(entry);
  const hit = kept.get(key);
  if (!hit) return null;
  kept.delete(key);
  kept.set(key, hit);
  return hit.url;
}

/**
 * Asks for `entry`'s thumbnail: `done(url)` once it's there, or `done(null)` when it can't be
 * had. `nearness(ms)` says how far its card will be from view in that many ms, when one started
 * now would be here (below zero: in view), so those load first. Returns a function that says it
 * isn't wanted any more (scrolled away before its turn).
 */
export function wantThumb(entry, done, nearness = () => 0) {
  const url = keptThumb(entry);
  const key = keyOf(entry);
  if (url || Date.now() - (failedAt.get(key) ?? -Infinity) < RETRY_AFTER) {
    done(url);
    return () => {};
  }
  let job = wanted.get(key);
  if (!job) wanted.set(key, (job = { entry, waiters: new Set(), started: false, nearness }));
  job.waiters.add(done);
  // Many cards come near at once (a folder opening, a quick scroll): they're ordered together.
  if (!pumping) {
    pumping = true;
    queueMicrotask(() => {
      pumping = false;
      pump();
    });
  }
  return () => {
    job.waiters.delete(done);
    if (!job.waiters.size && !job.started && wanted.get(key) === job) wanted.delete(key);
  };
}

/** Keeps `entry`'s thumbnail while it's shown; returns the function that lets it go. */
export function holdThumb(entry) {
  const hit = kept.get(keyOf(entry));
  if (!hit) return () => {};
  if (hit.holders++ === 0) held++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hit.holders === 0 && kept.get(keyOf(entry)) === hit) {
      held--;
      trim();
    }
  };
}

/** Forgets every thumbnail (another vault opened). */
export function forgetThumbs() {
  generation++;
  for (const { url } of kept.values()) URL.revokeObjectURL(url);
  kept.clear();
  failedAt.clear();
  wanted.clear();
  held = 0;
}

/** Starts the wanted thumbnails that will be in view soonest, as many as there's room for. */
function pump() {
  const room = AT_ONCE - loading;
  if (room <= 0) return;
  const next = [];
  for (const [key, job] of wanted) if (!job.started && job.waiters.size) next.push({ key, job, near: job.nearness(typical) });
  next.sort((a, b) => a.near - b.near);
  for (const { key, job } of next.slice(0, room)) {
    job.started = true;
    load(key, job);
  }
}

async function load(key, job) {
  loading++;
  const at = generation;
  const began = performance.now();
  let url = null;
  try {
    const res = await fetch(fileUrl(job.entry.id, { thumb: true }));
    if (!res.ok) throw new Error(`No thumbnail (${res.status}).`);
    const blob = await res.blob();
    if (at === generation) {
      url = URL.createObjectURL(blob);
      kept.set(key, { url, holders: 0 });
      trim();
    }
  } catch {
    if (at === generation) failedAt.set(key, Date.now());
  } finally {
    loading--;
    typical = Math.min(5000, typical * 0.8 + (performance.now() - began) * 0.2);
    if (at === generation && wanted.get(key) === job) {
      wanted.delete(key);
      for (const done of job.waiters) done(url);
    }
    pump();
  }
}

/** Forgets the least recently used thumbnails beyond KEEP that aren't on screen. */
function trim() {
  for (const [key, hit] of kept) {
    if (kept.size - held <= KEEP) return;
    if (hit.holders > 0) continue;
    URL.revokeObjectURL(hit.url);
    kept.delete(key);
  }
}
