/**
 * Page side of streaming decryption. Registers sw.js and answers its questions
 * ("which key/token for file X?", and in demo mode "give me these encrypted bytes").
 */
let swPolicy = null;
let ready = false;
const zipJobs = new Map(); // id -> { job, expires }: what a ZIP download contains (paths and file ids, no keys)

function trustedScriptUrl(url) {
  if (!window.trustedTypes) return url;
  swPolicy ??= window.trustedTypes.createPolicy('unibox-sw', {
    createScriptURL: (value) => {
      if (value !== 'sw.js') throw new TypeError('Only the Secure Box service worker may be registered.');
      return value;
    },
  });
  return swPolicy.createScriptURL(url);
}

/**
 * `describe(fileId, { fresh })` -> { entry, source: 'drive'|'link'|'page', token?, links? } or null when
 * locked; `fresh` asks for new addresses when the old ones stopped working.
 * `read(driveId, start, end)` -> ArrayBuffer (demo mode only).
 */
export async function startStreaming({ describe, read }) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const port = event.ports?.[0];
    const msg = event.data;
    if (!port || !msg) return;
    try {
      if (msg.type === 'unibox-describe') {
        port.postMessage((await describe(msg.fileId, { fresh: Boolean(msg.fresh) })) || { error: 'locked' });
      } else if (msg.type === 'unibox-zip') {
        const hit = zipJobs.get(msg.jobId);
        port.postMessage(hit && hit.expires > Date.now() ? hit.job : { error: 'expired' });
      } else if (msg.type === 'unibox-read') {
        const bytes = await read(msg.driveId, msg.start, msg.end);
        port.postMessage({ bytes }, [bytes]);
      }
    } catch (err) {
      port.postMessage({ error: String(err?.message || err) });
    }
  });
  try {
    await navigator.serviceWorker.register(trustedScriptUrl('sw.js'), { scope: './' });
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    }
  } catch (err) {
    console.warn('Streaming service worker unavailable:', err);
  }
  ready = Boolean(navigator.serviceWorker.controller);
  return ready;
}

export const streamingReady = () => ready;

export function fileUrl(fileId, { thumb = false, download = false } = {}) {
  const query = thumb ? '?part=thumb' : download ? '?download=1' : '';
  return `__unibox/file/${encodeURIComponent(fileId)}${query}`;
}

/**
 * A download URL for one ZIP of `job` = { name, entries: [{ path, dir?, size, mtime, fileId }] }.
 * The worker asks for the job when the download starts; it is forgotten after two minutes.
 */
export function zipUrl(job) {
  const now = Date.now();
  for (const [id, hit] of zipJobs) if (hit.expires <= now) zipJobs.delete(id);
  const id = crypto.randomUUID();
  zipJobs.set(id, { job, expires: now + 120_000 });
  return `__unibox/zip/${id}/${encodeURIComponent(job.name)}`;
}

/** Drops every key and token the service worker may still hold. */
export function forgetStreams() {
  zipJobs.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: 'unibox-forget' });
}
