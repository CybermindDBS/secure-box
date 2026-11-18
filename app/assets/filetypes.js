/** File type detection, kinds (for icons) and which built-in viewer can open a file. */

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/apng', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', heic: 'image/heic',
  heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', jxl: 'image/jxl',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', '3gp': 'video/3gpp', mpeg: 'video/mpeg', mpg: 'video/mpeg', wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi', amr: 'audio/amr',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint', rtf: 'application/rtf', epub: 'application/epub+zip',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv',
  tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain', ini: 'text/plain', env: 'text/plain', conf: 'text/plain',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
  gz: 'application/gzip', tgz: 'application/gzip',
};

const CODE = new Set(
  'js mjs cjs jsx ts tsx css scss less py rb php java kt swift go rs c h cc cpp hpp cs vb sh bash zsh ps1 bat cmd sql r lua pl dart scala ex exs hs vue svelte gradle dockerfile makefile tf proto graphql'.split(' '),
);
// Plain-text documents (shown in a readable document page) ...
const PROSE = new Set('txt text nfo srt vtt sub lrc rst adoc asciidoc org tex bib readme me'.split(' '));
// ... and configuration/data formats (shown monospace).
const CONFIG = new Set('log ini cfg conf toml env properties prop gitignore gitattributes editorconfig npmrc yarnrc dockerignore htaccess diff patch asc pem csr'.split(' '));
const IMAGE_VIEW = new Set(['image/jpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/svg+xml', 'image/heic', 'image/heif', 'image/tiff', 'image/jxl']);
const IMAGE_THUMB = new Set(['image/jpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export function extOf(name) {
  const base = String(name || '').toLowerCase().split('/').pop();
  if (base === 'dockerfile' || base === 'makefile') return base;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

export function guessType(name, browserType = '') {
  const ext = extOf(name);
  if (TYPES[ext]) return TYPES[ext];
  if (CODE.has(ext) || PROSE.has(ext) || CONFIG.has(ext)) return 'text/plain';
  return browserType && browserType !== 'application/octet-stream' ? browserType : 'application/octet-stream';
}

/** Broad kind, used for icons and colours. */
export function kindOf({ name, type }) {
  const ext = extOf(name);
  const t = type || guessType(name);
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (['docx', 'doc', 'odt', 'rtf', 'pages', 'epub'].includes(ext)) return 'doc';
  if (['xlsx', 'xls', 'ods', 'csv', 'tsv', 'numbers'].includes(ext)) return 'sheet';
  if (['pptx', 'ppt', 'odp', 'key'].includes(ext)) return 'slides';
  if (CODE.has(ext) || ['json', 'xml', 'html', 'htm', 'yaml', 'yml'].includes(ext)) return 'code';
  if (t.startsWith('text/')) return 'text';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return 'archive';
  return 'other';
}

/** Which built-in viewer opens this file (null = download only). */
export function viewerFor({ name, type, size = 0 }) {
  const ext = extOf(name);
  const t = type || guessType(name);
  if (IMAGE_VIEW.has(t)) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  const office = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', odt: 'odt', ods: 'ods', odp: 'odp', rtf: 'rtf' }[ext];
  if (office) return size <= 100 * 1024 * 1024 ? office : null;
  if (size > 20 * 1024 * 1024) return null;
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'json') return 'json';
  // 'code' = monospace reader, 'text' = document-style reader (both have a Monospace switch).
  if (CODE.has(ext) || CONFIG.has(ext) || ['xml', 'yaml', 'yml', 'html', 'htm', 'svg'].includes(ext)) return 'code';
  if (PROSE.has(ext) || t.startsWith('text/')) return 'text';
  return null; // unknown: the viewer sniffs small files and shows them as text if they are
}

/** Largest file the viewer will try to open as text when its type is unknown. */
export const TEXT_SNIFF_LIMIT = 5 * 1024 * 1024;

export const canThumbnail = ({ name, type }) => {
  const t = type || guessType(name);
  return IMAGE_THUMB.has(t) || t.startsWith('video/');
};

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

export function typeLabel({ name, type }) {
  const ext = extOf(name);
  const kind = kindOf({ name, type });
  const label = { image: 'image', video: 'video', audio: 'audio', doc: 'document', sheet: 'spreadsheet', slides: 'presentation', code: 'code', text: 'text', archive: 'archive' }[kind];
  if (kind === 'pdf') return 'PDF document';
  return ext ? `${ext.toUpperCase()} ${label || 'file'}` : 'File';
}
