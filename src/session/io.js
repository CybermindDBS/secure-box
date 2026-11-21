/**
 * Small browser helpers the session uses: choosing files, saving a download, the clipboard
 * (sensitive values are wiped after 30 seconds), and dates in words.
 */

/** Opens the browser's file picker for one file; resolves null when cancelled. */
export function pickFile(accept = '') {
  return pickFiles({ accept, multiple: false }).then((files) => files[0] || null);
}

/** Opens the browser's file picker; `folder` picks a whole folder (with relative paths). */
export function pickFiles({ accept = '', multiple = true, folder = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    if (accept) input.accept = accept;
    input.multiple = multiple;
    if (folder) input.webkitdirectory = true;
    const finish = () => {
      resolve([...(input.files || [])]);
      input.remove();
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Saves `contents` (a Blob, string or bytes) as a download named `filename`. */
export function downloadFile(filename, contents, type = 'application/octet-stream') {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let clipboardGeneration = 0;

async function writeClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (err) {
    // Fallback where the async Clipboard API is unavailable or refuses.
    const previousFocus = document.activeElement;
    const proxy = document.createElement('textarea');
    proxy.className = 'clipboard-proxy';
    proxy.readOnly = true;
    proxy.setAttribute('aria-hidden', 'true');
    proxy.tabIndex = -1;
    proxy.value = value;
    document.body.append(proxy);
    proxy.select();
    const copied = document.execCommand('copy');
    proxy.remove();
    previousFocus?.focus?.({ preventScroll: true });
    if (!copied) throw err;
  }
}

/** Copies text; sensitive values are wiped from the clipboard after 30 seconds. */
export async function copyText(value, { sensitive = true } = {}) {
  await writeClipboard(value);
  const generation = ++clipboardGeneration;
  if (!sensitive) return;
  setTimeout(() => {
    const wipe = () => {
      if (generation === clipboardGeneration) navigator.clipboard.writeText('').catch(() => {});
    };
    if (document.hasFocus()) wipe();
    else window.addEventListener('focus', wipe, { once: true });
  }, 30_000);
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

export function relativeTime(timestamp) {
  const seconds = (timestamp - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export const formatDate = (timestamp) => new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
