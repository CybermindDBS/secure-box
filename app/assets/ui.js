/**
 * DOM helpers. Everything is built with createElement/textContent — user data is
 * never parsed as HTML (the page also enforces Trusted Types).
 */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Icons (24px grid, stroked). Built as SVG DOM nodes, never as markup strings.
// ---------------------------------------------------------------------------
const ICONS = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.6-3.6'],
  plus: ['M12 5v14', 'M5 12h14'],
  lock: ['M8 11V8a4 4 0 0 1 8 0v3', 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z'],
  more: ['M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  copy: ['M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: [
    'M3 3l18 18',
    'M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9',
    'M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  edit: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
  key: ['M8 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M10.8 13.2L20 4', 'M16 8l3 3', 'M18.5 5.5l2 2'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  note: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  shield: ['M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z', 'M9 12l2 2 4-4'],
  alert: ['M12 4L2.5 20h19L12 4z', 'M12 10v4', 'M12 17h.01'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],
  folderPlus: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z', 'M12 10.5v6', 'M9 13.5h6'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z', 'M14 3v5h5'],
  image: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 20'],
  video: ['M4 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M17 10l5-3v10l-5-3'],
  audio: ['M9 18V5l11-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  sheet: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 10h18', 'M3 15h18', 'M9 4v16'],
  slides: ['M3 4h18', 'M5 4v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4', 'M12 16v4', 'M8 20h8'],
  code: ['M8 8l-4 4 4 4', 'M16 8l4 4-4 4', 'M14 5l-4 14'],
  archive: ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  chevronLeft: ['M15 18l-6-6 6-6'],
  chevronRight: ['M9 18l6-6-6-6'],
  move: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z', 'M9 13h6', 'M12.5 10.5L15 13l-2.5 2.5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16v-4', 'M12 8h.01'],
  zoomIn: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.6-3.6', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.6-3.6', 'M8 11h6'],
  rotate: ['M4 12a8 8 0 1 0 2.3-5.7', 'M4 4v5h5'],
  sliders: ['M4 7h9', 'M17 7h3', 'M17 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0z', 'M4 17h3', 'M11 17h9', 'M11 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'],
  home: ['M3 11l9-7 9 7', 'M5 10v10h5v-6h4v6h5V10'],
  play: ['M8 5.5v13l11-6.5-11-6.5z'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'icon',
  })) {
    svg.setAttribute(k, String(v));
  }
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function hueOf(text) {
  let hash = 0;
  for (const ch of text.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 360;
}

export function avatar(item, size = '') {
  const el = h('span', { class: `avatar${size ? ` avatar-${size}` : ''}`, 'aria-hidden': 'true' });
  el.style.setProperty('--hue', String(hueOf(item.title || '?')));
  if (item.type === 'note') el.append(icon('note', size === 'lg' ? 22 : 16));
  else el.textContent = ([...item.title.trim()][0] || '?').toUpperCase();
  return el;
}

// ---------------------------------------------------------------------------
// Toasts, confirm dialog, files, clipboard, dates
// ---------------------------------------------------------------------------
export function toast(message, tone = 'info') {
  const host = $('#toasts');
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = h('div', { class: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    icon(tone === 'error' ? 'alert' : 'check', 16),
    h('span', { text: message }));
  host.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 300);
  }, tone === 'error' ? 6000 : 2600);
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = message;
  const ok = $('#confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
    (danger ? $('#confirm-cancel') : ok).focus();
  });
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    const finish = () => {
      resolve(input.files?.[0] || null);
      input.remove();
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function downloadFile(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

let clipboardGeneration = 0;

async function writeClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (err) {
    // Fallback for contexts where the async Clipboard API is unavailable or refuses.
    const previousFocus = document.activeElement;
    const proxy = h('textarea', { class: 'clipboard-proxy', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
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

export const formatDate = (timestamp) =>
  new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
