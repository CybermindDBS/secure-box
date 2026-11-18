/**
 * Built-in document readers. Everything is rendered with createElement/textContent from
 * parsed data — document content can never inject markup or run code.
 */
import { h } from './ui.js';
import { parseCsv } from './vault.js';
import { find, findAll, kids, parseXml, textOf } from './xml.js';
import { readZipDirectory, readZipText } from './zip.js';

const MAX_ROWS = 1000;
const MAX_COLS = 60;
const on = (el) => Boolean(el) && !['0', 'false', 'none'].includes(el.attrs['w:val'] ?? '');

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------
function docxRuns(node, runs = [], fmt = {}) {
  for (const child of node.children || []) {
    if (typeof child === 'string') continue;
    switch (child.name) {
      case 'w:r': {
        const pr = find(child, 'w:rPr');
        const style = {
          b: on(pr && kids(pr, 'w:b')[0]),
          i: on(pr && kids(pr, 'w:i')[0]),
          u: on(pr && kids(pr, 'w:u')[0]),
          s: on(pr && kids(pr, 'w:strike')[0]),
          ...fmt,
        };
        for (const part of child.children) {
          if (typeof part === 'string') continue;
          if (part.name === 'w:t') runs.push({ text: textOf(part), ...style });
          else if (part.name === 'w:tab') runs.push({ text: '\t', ...style });
          else if (part.name === 'w:br' || part.name === 'w:cr') runs.push({ text: '\n', ...style });
          else if (part.name === 'w:drawing' || part.name === 'w:pict') runs.push({ text: '[image]', image: true });
        }
        break;
      }
      case 'w:hyperlink':
        docxRuns(child, runs, { ...fmt, u: true });
        break;
      case 'w:del':
      case 'w:pPr':
        break;
      default:
        docxRuns(child, runs, fmt); // w:ins, w:smartTag, w:sdt, w:sdtContent, w:fldSimple ...
    }
  }
  return runs;
}

function docxParagraph(p) {
  const pr = kids(p, 'w:pPr')[0];
  const style = (find(pr, 'w:pStyle')?.attrs['w:val'] || '').toLowerCase();
  const heading = /^heading\s*(\d)/.exec(style);
  const level = heading ? Number(heading[1]) : style === 'title' ? 1 : style === 'subtitle' ? 2 : 0;
  return { type: level ? 'h' : 'p', level, list: Boolean(find(pr, 'w:numPr')), runs: docxRuns(p) };
}

export function extractDocx(xml) {
  const body = find(parseXml(xml), 'w:body');
  const blocks = [];
  const walk = (node) => {
    for (const child of kids(node)) {
      if (child.name === 'w:p') blocks.push(docxParagraph(child));
      else if (child.name === 'w:tbl') {
        const rows = kids(child, 'w:tr').map((tr) =>
          kids(tr, 'w:tc').map((tc) => findAll(tc, 'w:p').map((p) => docxRuns(p).map((r) => r.text).join('')).join('\n')),
        );
        blocks.push({ type: 'table', rows });
      } else if (child.name === 'w:sdt' || child.name === 'w:sdtContent') walk(child);
    }
  };
  walk(body);
  return blocks;
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------
const colIndex = (ref) => {
  const letters = /^[A-Z]+/.exec(ref || '')?.[0] || 'A';
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
};
export const colName = (index) => {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function relTargets(relsXml, base) {
  const map = new Map();
  for (const rel of findAll(parseXml(relsXml || ''), 'Relationship')) {
    const target = rel.attrs.Target || '';
    map.set(rel.attrs.Id, target.startsWith('/') ? target.slice(1) : `${base}${target}`);
  }
  return map;
}

function tidyNumber(value) {
  if (!/^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(value)) return value;
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

export function extractSheet(xml, shared) {
  const rows = [];
  let truncated = false;
  for (const row of findAll(parseXml(xml), 'row')) {
    const r = Number(row.attrs.r || rows.length + 1) - 1;
    if (r >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const cells = [];
    for (const c of kids(row, 'c')) {
      const col = colIndex(c.attrs.r);
      if (col >= MAX_COLS) {
        truncated = true;
        continue;
      }
      const v = textOf(kids(c, 'v')[0]);
      const t = c.attrs.t;
      cells[col] =
        t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? findAll(c, 't').map(textOf).join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : t ? v : tidyNumber(v);
    }
    rows[r] = cells;
  }
  return { rows, truncated };
}

async function readXlsx(zip) {
  const shared = findAll(parseXml((await readZipText(zip, 'xl/sharedStrings.xml')) || ''), 'si').map((si) =>
    kids(si).filter((k) => k.name === 't' || k.name === 'r').map((k) => (k.name === 't' ? textOf(k) : findAll(k, 't').map(textOf).join(''))).join(''),
  );
  const rels = relTargets(await readZipText(zip, 'xl/_rels/workbook.xml.rels'), 'xl/');
  const sheets = [];
  for (const sheet of findAll(parseXml((await readZipText(zip, 'xl/workbook.xml')) || ''), 'sheet')) {
    const path = rels.get(sheet.attrs['r:id']);
    const xml = path && (await readZipText(zip, path));
    if (xml) sheets.push({ name: sheet.attrs.name || `Sheet ${sheets.length + 1}`, ...extractSheet(xml, shared) });
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------
export function extractSlide(xml) {
  const slide = { title: '', lines: [] };
  for (const sp of findAll(parseXml(xml), 'p:sp')) {
    const type = find(sp, 'p:ph')?.attrs.type;
    const lines = findAll(sp, 'a:p').map((p) => findAll(p, 'a:t').map(textOf).join('')).filter((t) => t.trim());
    if ((type === 'title' || type === 'ctrTitle') && !slide.title) slide.title = lines.join(' ');
    else slide.lines.push(...lines);
  }
  return slide;
}

async function readPptx(zip) {
  const rels = relTargets(await readZipText(zip, 'ppt/_rels/presentation.xml.rels'), 'ppt/');
  const slides = [];
  for (const id of findAll(parseXml((await readZipText(zip, 'ppt/presentation.xml')) || ''), 'p:sldId')) {
    const xml = await readZipText(zip, rels.get(id.attrs['r:id']) || '');
    if (xml) slides.push(extractSlide(xml));
  }
  return slides;
}

// ---------------------------------------------------------------------------
// OpenDocument (.odt / .ods / .odp)
// ---------------------------------------------------------------------------
function odfText(node) {
  if (typeof node === 'string') return node;
  if (node.name === 'text:s') return ' '.repeat(Number(node.attrs['text:c'] || 1));
  if (node.name === 'text:tab') return '\t';
  if (node.name === 'text:line-break') return '\n';
  if (node.name === 'text:note' || node.name === 'office:annotation') return '';
  return (node.children || []).map(odfText).join('');
}

function odfTable(table) {
  const rows = [];
  for (const row of findAll(table, 'table:table-row')) {
    const cells = [];
    for (const cell of kids(row).filter((c) => c.name === 'table:table-cell' || c.name === 'table:covered-table-cell')) {
      const repeat = Math.min(Number(cell.attrs['table:number-columns-repeated'] || 1), MAX_COLS);
      const text = kids(cell, 'text:p').map(odfText).join('\n');
      for (let i = 0; i < repeat && cells.length < MAX_COLS; i++) cells.push(text);
    }
    const repeatRows = Math.min(Number(row.attrs['table:number-rows-repeated'] || 1), 50);
    for (let i = 0; i < repeatRows && rows.length < MAX_ROWS; i++) rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop(); // drop trailing empty rows
  return rows.map((r) => {
    const copy = [...r];
    while (copy.length && !copy[copy.length - 1]) copy.pop();
    return copy;
  });
}

export function extractOdf(xml) {
  const body = find(parseXml(xml), 'office:body');
  const text = find(body, 'office:text');
  if (text) {
    const blocks = [];
    const walk = (node, list = false) => {
      for (const child of kids(node)) {
        if (child.name === 'text:h') blocks.push({ type: 'h', level: Number(child.attrs['text:outline-level'] || 1), runs: [{ text: odfText(child) }] });
        else if (child.name === 'text:p') blocks.push({ type: 'p', list, runs: [{ text: odfText(child) }] });
        else if (child.name === 'text:list' || child.name === 'text:list-item') walk(child, true);
        else if (child.name === 'table:table') blocks.push({ type: 'table', rows: odfTable(child) });
        else if (child.name === 'text:section') walk(child, list);
      }
    };
    walk(text);
    return { kind: 'text', blocks };
  }
  const spreadsheet = find(body, 'office:spreadsheet');
  if (spreadsheet) {
    return { kind: 'sheets', sheets: findAll(spreadsheet, 'table:table').map((t) => ({ name: t.attrs['table:name'] || 'Sheet', rows: odfTable(t) })) };
  }
  const slides = findAll(find(body, 'office:presentation'), 'draw:page').map((page) => {
    const lines = findAll(page, 'text:p').map(odfText).filter((t) => t.trim());
    return { title: lines.shift() || page.attrs['draw:name'] || '', lines };
  });
  return { kind: 'slides', slides };
}

// ---------------------------------------------------------------------------
// RTF (plain text only)
// ---------------------------------------------------------------------------
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'header', 'footer']);

export function rtfToText(rtf) {
  let out = '';
  const stack = [{ skip: false, uc: 1 }];
  let pendingSkip = 0;
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    const state = stack[stack.length - 1];
    if (ch === '{') {
      stack.push({ ...state });
      continue;
    }
    if (ch === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (ch === '\\') {
      const word = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 40));
      if (word) {
        i += word[0].length - 1;
        const [, name, arg] = word;
        if (RTF_SKIP.has(name)) state.skip = true;
        else if (name === 'uc') state.uc = Number(arg) || 0;
        else if (!state.skip) {
          if (name === 'par' || name === 'line') out += '\n';
          else if (name === 'tab') out += '\t';
          else if (name === 'u') {
            out += String.fromCharCode(Number(arg) < 0 ? Number(arg) + 65536 : Number(arg));
            pendingSkip = state.uc;
          }
        }
        continue;
      }
      const next = rtf[i + 1];
      if (next === '*') state.skip = true;
      else if (next === "'") {
        if (!state.skip && !pendingSkip) out += String.fromCharCode(parseInt(rtf.slice(i + 2, i + 4), 16));
        else if (pendingSkip) pendingSkip--;
        i += 2;
      } else if (!state.skip && (next === '\\' || next === '{' || next === '}')) out += next;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (pendingSkip) {
      pendingSkip--;
      continue;
    }
    if (!state.skip) out += ch;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function runNodes(runs) {
  return runs.map((run) => {
    if (run.image) return h('span', { class: 'doc-image', text: 'image' });
    const parts = run.text.split('\n');
    let node = h('span', {}, parts.flatMap((part, i) => (i ? [h('br'), part] : [part])));
    if (run.b) node = h('strong', {}, node);
    if (run.i) node = h('em', {}, node);
    if (run.u) node = h('u', {}, node);
    if (run.s) node = h('s', {}, node);
    return node;
  });
}

function renderTable(rows, { header = false, numbered = false } = {}) {
  const width = Math.max(0, ...rows.map((r) => (r ? r.length : 0)));
  const body = [];
  rows.forEach((row, index) => {
    const cells = [];
    if (numbered) cells.push(h('th', { class: 'doc-rownum', text: String(index + 1) }));
    for (let c = 0; c < width; c++) cells.push(h(header && index === 0 ? 'th' : 'td', { text: (row && row[c]) ?? '' }));
    body.push(h('tr', {}, cells));
  });
  const head = numbered ? h('thead', {}, h('tr', {}, h('th', {}), Array.from({ length: width }, (_, c) => h('th', { text: colName(c) })))) : null;
  return h('div', { class: 'doc-table-wrap' }, h('table', { class: `doc-table${numbered ? ' doc-grid' : ''}` }, head, h('tbody', {}, body)));
}

function renderBlocks(blocks) {
  const page = h('article', { class: 'doc-page' });
  let list = null;
  for (const block of blocks) {
    if (block.type === 'p' && block.list) {
      if (!list) page.append((list = h('ul')));
      list.append(h('li', {}, runNodes(block.runs)));
      continue;
    }
    list = null;
    if (block.type === 'table') page.append(renderTable(block.rows));
    else if (block.type === 'h') page.append(h(`h${Math.min(4, Math.max(1, block.level))}`, {}, runNodes(block.runs)));
    else if (block.runs.some((r) => r.text.trim() || r.image)) page.append(h('p', {}, runNodes(block.runs)));
  }
  if (!page.childNodes.length) page.append(h('p', { class: 'muted', text: 'This document has no text.' }));
  return page;
}

function renderSheets(sheets) {
  if (!sheets.length) return h('p', { class: 'doc-empty', text: 'This spreadsheet is empty.' });
  const stage = h('div', { class: 'sheet-stage' });
  const tabs = h('div', { class: 'sheet-tabs', role: 'tablist' });
  const show = (index) => {
    const sheet = sheets[index];
    stage.replaceChildren(
      renderTable(sheet.rows, { numbered: true }),
      sheet.truncated ? h('p', { class: 'doc-note', text: `Showing the first ${MAX_ROWS} rows and ${MAX_COLS} columns.` }) : null,
    );
    [...tabs.children].forEach((t, i) => t.setAttribute('aria-selected', String(i === index)));
  };
  sheets.forEach((sheet, index) => tabs.append(h('button', { type: 'button', role: 'tab', class: 'sheet-tab', text: sheet.name, onclick: () => show(index) })));
  const wrap = h('div', { class: 'doc-sheets' }, stage, sheets.length > 1 ? tabs : null);
  show(0);
  return wrap;
}

function renderSlides(slides) {
  if (!slides.length) return h('p', { class: 'doc-empty', text: 'This presentation has no slides.' });
  return h('div', { class: 'doc-slides' },
    slides.map((slide, i) =>
      h('section', { class: 'doc-slide' },
        h('span', { class: 'doc-slide-num', text: `Slide ${i + 1}` }),
        slide.title ? h('h2', { text: slide.title }) : null,
        slide.lines.length ? h('ul', {}, slide.lines.map((line) => h('li', { text: line }))) : null,
      ),
    ),
  );
}

// Markdown (safe subset): headings, lists, quotes, code, tables, links, emphasis.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<)]+)/;

function inline(text) {
  const nodes = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      nodes.push(rest);
      break;
    }
    if (m.index) nodes.push(rest.slice(0, m.index));
    const token = m[0];
    if (m[1]) nodes.push(h('code', { text: token.slice(1, -1) }));
    else if (m[2]) nodes.push(h('strong', {}, inline(token.slice(2, -2))));
    else if (m[3]) nodes.push(h('em', {}, inline(token.slice(1, -1))));
    else if (m[4]) nodes.push(h('s', {}, inline(token.slice(2, -2))));
    else {
      const link = m[5] ? /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token) : null;
      const label = link ? link[1] : token;
      const href = link ? link[2] : token;
      nodes.push(/^https?:\/\//i.test(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, link ? inline(label) : label) : label);
    }
    rest = rest.slice(m.index + token.length);
  }
  return nodes;
}

export function renderMarkdown(text) {
  const page = h('article', { class: 'doc-page doc-markdown' });
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      page.append(h('pre', {}, h('code', { text: code.join('\n') })));
    } else if (/^#{1,6}\s/.test(line)) {
      const level = /^#+/.exec(line)[0].length;
      page.append(h(`h${Math.min(level, 4)}`, {}, inline(line.replace(/^#+\s*/, '').replace(/\s*#+\s*$/, ''))));
      i++;
    } else if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      page.append(h('hr'));
      i++;
    } else if (/^>\s?/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      page.append(h('blockquote', {}, inline(quote.join(' '))));
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        const task = /^\[([ xX])\]\s+/.exec(item);
        list.append(h('li', {}, task ? [h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ' ', ...inline(item.slice(task[0].length))] : inline(item)));
      }
      page.append(list);
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|?\s*:?-+/.test(lines[i]) && rows.length === 1) continue;
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      }
      page.append(renderTable(rows, { header: true }));
    } else if (!line.trim()) i++;
    else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) para.push(lines[i].trim());
      page.append(h('p', {}, inline(para.join(' '))));
    }
  }
  return page;
}

function renderText(text, { mono = true } = {}) {
  return h('pre', { class: `doc-text${mono ? '' : ' doc-text-prose'}`, text });
}

const MAX_TEXT_CHARS = 2_000_000;

/** Plain text in a document page; `mono` switches to a fixed-width font. */
function renderPlain(text, { mono }) {
  const shown = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  return h('article', { class: `doc-page doc-plain${mono ? ' is-mono' : ''}` },
    shown.trim() ? h('div', { class: 'doc-plain-text', text: shown }) : h('p', { class: 'muted', text: 'This file is empty.' }),
    shown.length < text.length ? h('p', { class: 'doc-note', text: `Showing the first ${MAX_TEXT_CHARS.toLocaleString()} characters.` }) : null);
}

/** UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252 for older files. */
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Heuristic: no NUL bytes and almost no control characters in the first 64 KB. */
export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 65536);
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return true;
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control <= sample.length * 0.02;
}

const decode = decodeText;

/**
 * Builds the reader view for a decrypted document. `kind` comes from filetypes.viewerFor();
 * for 'text' and 'code', `mono` picks the font (the viewer's Monospace switch).
 */
export async function renderDocument(kind, buffer, { mono = kind === 'code' } = {}) {
  const bytes = new Uint8Array(buffer);
  if ((kind === 'text' || kind === 'code') && !looksLikeText(bytes)) throw new Error('This file doesn’t contain readable text.');
  switch (kind) {
    case 'text':
    case 'code':
      return renderPlain(decode(bytes), { mono });
    case 'docx': {
      const xml = await readZipText(readZipDirectory(bytes), 'word/document.xml');
      if (!xml) throw new Error('This Word document has no readable content.');
      return renderBlocks(extractDocx(xml));
    }
    case 'xlsx':
      return renderSheets(await readXlsx(readZipDirectory(bytes)));
    case 'pptx':
      return renderSlides(await readPptx(readZipDirectory(bytes)));
    case 'odt':
    case 'ods':
    case 'odp': {
      const xml = await readZipText(readZipDirectory(bytes), 'content.xml');
      if (!xml) throw new Error('This document has no readable content.');
      const doc = extractOdf(xml);
      return doc.kind === 'text' ? renderBlocks(doc.blocks) : doc.kind === 'sheets' ? renderSheets(doc.sheets) : renderSlides(doc.slides);
    }
    case 'rtf':
      return renderText(rtfToText(new TextDecoder('latin1').decode(bytes)), { mono: false });
    case 'markdown':
      return renderMarkdown(decode(bytes));
    case 'csv': {
      const text = decode(bytes);
      const tsv = !text.includes(',') && text.includes('\t');
      const rows = tsv ? text.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')) : parseCsv(text);
      return h('div', { class: 'doc-sheets' },
        renderTable(rows.slice(0, MAX_ROWS), { header: true }),
        rows.length > MAX_ROWS ? h('p', { class: 'doc-note', text: `Showing the first ${MAX_ROWS} of ${rows.length} rows.` }) : null);
    }
    case 'json': {
      const text = decode(bytes);
      try {
        return renderText(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        return renderText(text);
      }
    }
    default:
      return renderText(decode(bytes));
  }
}
