/**
 * The page's only Trusted Types policy ("secure-box-scripts" in the CSP). Script URLs (the
 * service worker, Secure Box's own workers) must pass through it, and it lets through exactly
 * the ones Secure Box registered: nothing else can become a worker or service worker here.
 */
const allowed = new Set(['sw.js']);
let policy = null;

/** Adds a script URL (a bundled worker's) that may be started. */
export function allowScript(url) {
  allowed.add(String(url));
}

export function trustedScriptUrl(url) {
  const value = String(url);
  if (!globalThis.trustedTypes) {
    if (!allowed.has(value)) throw new TypeError('Only Secure Box’s own scripts may run as workers.');
    return value;
  }
  policy ??= globalThis.trustedTypes.createPolicy('secure-box-scripts', {
    createScriptURL: (candidate) => {
      if (!allowed.has(candidate)) throw new TypeError('Only Secure Box’s own scripts may run as workers.');
      return candidate;
    },
  });
  return policy.createScriptURL(value);
}
