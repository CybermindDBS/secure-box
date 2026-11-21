import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
