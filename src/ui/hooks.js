import { startTransition, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { prefs } from '../session/prefs.js';
import { getVersion, state, subscribe } from '../session/store.js';

/** Reads from the session state; re-renders when what `select` returns changes (by identity). */
export function useSession(select) {
  return useSyncExternalStore(subscribe, () => select(state));
}

/** Re-renders on every change to the session state (for components that read many fields). */
export const useVersion = () => useSyncExternalStore(subscribe, getVersion);

/** Reads a small store (toasts, dialogs, prefs…), optionally through `select`. */
export function useStore(store, select = (value) => value) {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export const usePref = (name) => useStore(prefs, (all) => all[name]);

/** Whether a media query matches right now, following it as it changes. */
export function useMedia(query) {
  const subscribeMedia = useCallback(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribeMedia, () => window.matchMedia(query).matches);
}

export const useNarrow = () => useMedia('(max-width: 760px)');

/**
 * Runs an action from a button: tracks that it's busy, and shows what went wrong as a toast
 * when the action throws (actions that report their own errors don't throw).
 */
export function useAction(action, { onError } = {}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  const run = useCallback(
    async (...args) => {
      setBusy(true);
      try {
        return await action(...args);
      } catch (err) {
        console.error(err);
        if (err?.code !== 'cancelled') onError?.(err);
        return undefined;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [action, onError],
  );
  return [run, busy];
}

/** Calls `handler` for keydown on the whole page while mounted. */
export function useKeydown(handler, deps = []) {
  useEffect(() => {
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** The nearest element around `el` that scrolls (null: the page itself). */
function scrollerOf(el) {
  for (let node = el?.parentElement; node && node !== document.body; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * A long list drawn a batch at a time: the first `first` things at once, then `step` more each
 * time the end of what's drawn comes within two screens of view, so a folder of thousands opens
 * as fast as one of a hundred, and what's never scrolled to is never drawn. Put `sentinel` (a
 * ref) on an empty element right after the last thing drawn. Another list (`key` changes)
 * starts again from the first batch; `reveal(i)` draws at least up to the i-th thing (a key
 * press moving there, say).
 */
export function useIncremental(total, { key, first = 120, step = 240 } = {}) {
  const [shown, setShown] = useState({ key, count: first });
  let count = shown.count;
  if (shown.key !== key) {
    count = first;
    setShown({ key, count });
  }
  if (typeof IntersectionObserver === 'undefined') count = total; // nothing to tell when: everything
  const more = count < total;
  const sentinel = useRef(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!more || !el) return undefined;
    // A new observer each time more is drawn, so a sentinel that's still in view asks again.
    // More is drawn in the background (a transition): scrolling never waits for it.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) startTransition(() => setShown((s) => (s.key === key ? { key, count: s.count + step } : s)));
      },
      { root: scrollerOf(el), rootMargin: '0px 0px 200% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [count, more, key, step]);
  const reveal = useCallback((index) => setShown((s) => (index < s.count ? s : { key: s.key, count: Math.ceil((index + 1) / step) * step })), [step]);
  return { count: Math.min(count, total), more, sentinel, reveal };
}

/** A value that's true for `ms` after `trigger` changes to something truthy (for brief animations). */
export function useFlash(trigger, ms = 900) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!trigger) return undefined;
    setOn(true);
    const timer = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(timer);
  }, [trigger, ms]);
  return on;
}
