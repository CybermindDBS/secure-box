/**
 * Trying again after a passing failure: offline for a moment, or the cloud busy or failing on
 * its side. Used by uploads, piece by piece, so one hiccup doesn't fail a whole file (#20).
 */

/** Whether `err` is worth trying again: a network failure, "too many requests" or a server error. */
export function transient(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err.code === 'network') return true;
  const status = Number(err.status) || 0;
  return status === 408 || status === 429 || (status >= 500 && status !== 501 && status !== 507);
}

/** How long to wait before attempt `attempt + 1`: growing, with a little jitter, at most 30 s. */
export function backoff(attempt, retryAfterSeconds = 0) {
  if (retryAfterSeconds > 0) return Math.min(30_000, retryAfterSeconds * 1000);
  return Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 400);
}

/** Waits `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Stopped.', 'AbortError'));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => {
      done();
      reject(new DOMException('Stopped.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
    return undefined;
  });
}

export const MAX_PIECE_ATTEMPTS = 6;
