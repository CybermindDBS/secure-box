/**
 * What the session asks of the screen, without knowing it's React: toasts, dialogs that answer
 * (await ask('confirm', …)), and cross-fades. The UI renders these stores.
 */
import { createStore } from './store.js';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export const toasts = createStore([]);

/**
 * A part of Secure Box loaded only when first needed. If Secure Box was updated since this page
 * opened, that part's old file is gone from the site: say so plainly, rather than "failed to fetch".
 */
export function loadPart(importer) {
  return importer().catch((err) => {
    console.error(err);
    throw new Error('Secure Box was updated while this page was open. Reload the page, then try again.');
  });
}
let toastId = 0;

export function toast(message, tone = 'info') {
  const id = ++toastId;
  toasts.set((list) => [...list.slice(-2), { id, message: String(message), tone }]);
  setTimeout(() => dismissToast(id), tone === 'error' ? 6000 : 2600);
  return id;
}

export function dismissToast(id) {
  toasts.set((list) => list.filter((t) => t.id !== id));
}

// ---------------------------------------------------------------------------
// Dialogs that answer: the session awaits them, the DialogHost shows them.
// ---------------------------------------------------------------------------
export const dialogs = createStore([]);
let dialogId = 0;

/** Opens dialog `kind` with `props`; resolves with what it answers (null when dismissed). */
export function ask(kind, props = {}) {
  return new Promise((resolve) => {
    const id = ++dialogId;
    dialogs.set((list) => [...list, { id, kind, props, resolve }]);
  });
}

/** Called by the dialog when it closes. */
export function answer(id, value) {
  const entry = dialogs.get().find((d) => d.id === id);
  if (!entry) return;
  dialogs.set((list) => list.filter((d) => d.id !== id));
  entry.resolve(value);
}

/** Closes every dialog of `kind` (or all), as dismissed. */
export function dismissDialogs(kind = null) {
  answerAll(kind, null);
}

/** Answers every open dialog of `kind` (or all) with `value`. */
export function answerAll(kind, value) {
  for (const entry of dialogs.get()) if (!kind || entry.kind === kind) answer(entry.id, value);
}

export const confirmDialog = ({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) =>
  ask('confirm', { title, message, confirmLabel, cancelLabel, danger }).then((value) => value === true);

// ---------------------------------------------------------------------------
// Cross-fades: the UI decides how (View Transitions + a synchronous render).
// ---------------------------------------------------------------------------
let runTransition = (update) => update();

export function setTransitionRunner(runner) {
  runTransition = runner;
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Runs `update` as a cross-fade where the browser can, at once elsewhere. If the browser doesn't
 * get to the transition (a tab hidden mid-way, say), the change happens anyway, once: a switch
 * never waits on an animation.
 */
export async function crossFade(update) {
  if (!document.startViewTransition || reducedMotion() || document.hidden) return update();
  let ran = false;
  let result;
  const once = () => {
    if (ran) return result;
    ran = true;
    result = update();
    return result;
  };
  await Promise.race([Promise.resolve(runTransition(once)).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1200))]);
  return once();
}
