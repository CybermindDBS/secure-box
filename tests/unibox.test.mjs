// Run with: npm test   (Node 20+, no dependencies)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crc32 as zlibCrc32 } from 'node:zlib';
import '../app/assets/stream-core.js';
import '../app/assets/zip-core.js';
import { CHARSETS, generatePassword, padme, passwordEntropyBits } from '../app/assets/crypto.js';
import { CHUNK_SIZE, HEADER_BYTES, createPieceWriter, decryptFile, encryptFile, layout } from '../app/assets/fileformat.js';
import { formatBytes, kindOf, viewerFor } from '../app/assets/filetypes.js';
import {
  createKeyring,
  decodeRecoveryKey,
  emergencyKitText,
  encodeRecoveryKey,
  parseKeyring,
  passwordProblem,
  recoveryKeyFromKit,
  serializeKeyring,
  unlockWithPassword,
  unlockWithRecovery,
  withNewPassword,
  withNewRecovery,
} from '../app/assets/keyring.js';
import { looksLikeMessage, messageAccess, openMessage, readMessage, sealText } from '../app/assets/textbox.js';
import { decodeText, extractDocx, extractOdf, extractSheet, extractSlide, looksLikeText, rtfToText } from '../app/assets/readers.js';
import {
  LOCAL_INDEX,
  VaultCipher,
  applyChange,
  collectTree,
  emptyVault,
  folderChain,
  itemsFromCsv,
  itemsToCsv,
  makeFileEntry,
  makeFolder,
  makeItem,
  parseCsv,
  parseEnvelope,
  safeHref,
  uniqueName,
} from '../app/assets/vault.js';
import { find, parseXml, textOf } from '../app/assets/xml.js';
import { readZipDirectory, readZipEntry, readZipText, zipStore } from '../app/assets/zip.js';
import { boxAccess, openContent, readBox, unlockBox, writeBox, zipEntries, zipEntryData, zipFolder } from '../app/assets/localbox.js';

const S = globalThis.UniboxStream;
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const bigRandom = (n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) out.set(random(Math.min(65536, n - i)), i);
  return out;
};

// --- Key ring: master password + Emergency Kit -------------------------------------
test('master password and recovery key both unlock the same master key', async () => {
  const { doc, master, recovery } = await createKeyring('correct horse battery staple');
  const parsed = parseKeyring(serializeKeyring(doc));
  assert.ok(!JSON.stringify(parsed).includes(Buffer.from(master.key).toString('base64')), 'the master key is never stored in plain text');
  const viaPassword = await unlockWithPassword(parsed, 'correct horse battery staple');
  const viaKit = await unlockWithRecovery(parsed, recoveryKeyFromKit(emergencyKitText({ email: 'a@b.c', recovery })));
  assert.deepEqual([...viaPassword.key], [...master.key]);
  assert.deepEqual([...viaKit.key], [...master.key]);
  await assert.rejects(unlockWithPassword(parsed, 'correct horse battery stapl'), { code: 'wrong-password' });
});

test('changing the password keeps the kit; a new kit revokes the old one', async () => {
  const { doc, master, recovery } = await createKeyring('first password is long');
  const changed = await withNewPassword(doc, master, 'second password is longer');
  await assert.rejects(unlockWithPassword(changed, 'first password is long'), { code: 'wrong-password' });
  assert.equal((await unlockWithPassword(changed, 'second password is longer')).kid, master.kid);
  assert.equal((await unlockWithRecovery(changed, recovery.text)).kid, master.kid, 'old kit still works after a password change');
  const { doc: rekitted, recovery: fresh } = await withNewRecovery(changed, master);
  await assert.rejects(unlockWithRecovery(rekitted, recovery.text), { code: 'wrong-recovery' });
  assert.equal((await unlockWithRecovery(rekitted, fresh.text)).kid, master.kid);
});

test('recovery keys survive typos in case, spacing and look-alike letters', () => {
  const bytes = random(32);
  const text = encodeRecoveryKey(bytes);
  assert.match(text, /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
  const sloppy = text.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.deepEqual([...decodeRecoveryKey(sloppy)], [...bytes]);
  assert.throws(() => decodeRecoveryKey('ABCD-EFGH'), { code: 'bad-recovery' });
});

test('weak master passwords are refused', () => {
  assert.match(passwordProblem('short'), /at least 12/);
  assert.match(passwordProblem('aaaaaaaaaaaaaaa'), /too easy/);
  assert.match(passwordProblem('a perfectly fine sentence', 'different'), /match/);
  assert.equal(passwordProblem('a perfectly fine sentence', 'a perfectly fine sentence'), '');
});

// --- Vault --------------------------------------------------------------------------
test('vault round-trips, hides plaintext and uses a fresh key per save', async () => {
  const { master } = await createKeyring('vault test password');
  const cipher = await VaultCipher.create(master);
  const vault = applyChange(emptyVault(), { op: 'put', item: makeItem({ title: 'GitHub', password: 'hunter2-SECRET' }) });
  const first = await cipher.seal(vault);
  const second = parseEnvelope(await cipher.seal(vault));
  assert.ok(!first.includes('hunter2') && !first.includes('GitHub'));
  assert.notEqual(parseEnvelope(first).salt, second.salt);
  assert.equal(Buffer.from(parseEnvelope(await cipher.seal(emptyVault())).ct, 'base64').length, 256 + 16, 'Padmé minimum');
  assert.deepEqual(await cipher.open(parseEnvelope(first)), vault);
});

test('tampered or foreign vaults are rejected', async () => {
  const a = await VaultCipher.create((await createKeyring('owner password one')).master);
  const b = await VaultCipher.create({ ...(await createKeyring('owner password two')).master, kid: a.kid });
  const env = parseEnvelope(await a.seal(emptyVault()));
  const flipped = Buffer.from(env.ct, 'base64');
  flipped[3] ^= 1;
  await assert.rejects(a.open({ ...env, ct: flipped.toString('base64') }), { code: 'decrypt-failed' });
  await assert.rejects(b.open(env), { code: 'decrypt-failed' });
  await assert.rejects(a.open({ ...env, kid: 'ffffffffffffffff' }), { code: 'wrong-key' });
  await assert.rejects(a.open({ ...env, version: 1 }), { code: 'decrypt-failed' }, 'version is authenticated');
});

test('folders and files form a repairable tree', async () => {
  const docs = makeFolder({ name: 'Docs' });
  const taxes = makeFolder({ name: 'Taxes', parent: docs.id });
  const file = makeFileEntry({ name: 'return.pdf', type: 'application/pdf', size: 10, folder: taxes.id, driveId: 'd1', key: 'A'.repeat(43), chunk: CHUNK_SIZE });
  let vault = applyChange(emptyVault(), { op: 'batch', changes: [{ op: 'folder-put', folder: docs }, { op: 'folder-put', folder: taxes }, { op: 'file-put', file }] });
  assert.deepEqual(folderChain(vault, taxes.id).map((f) => f.name), ['Docs', 'Taxes']);
  const tree = collectTree(vault, docs.id);
  assert.deepEqual(tree.folderIds.sort(), [docs.id, taxes.id].sort());
  assert.deepEqual(tree.files.map((f) => f.id), [file.id]);
  // An orphaned folder (parent deleted on another device) is re-homed when the vault is reopened.
  vault = applyChange(vault, { op: 'remove', folders: [docs.id] });
  const cipher = await VaultCipher.create((await createKeyring('tree test password')).master);
  const reopened = await cipher.open(parseEnvelope(await cipher.seal(vault)));
  assert.equal(reopened.folders.find((f) => f.id === taxes.id).parent, null);
  assert.equal(uniqueName('return.pdf', ['return.pdf', 'Return (2).pdf']), 'return (3).pdf');
  assert.equal(uniqueName('Docs', ['docs'], { isFolder: true }), 'Docs (2)');
});

test('unknown fields from newer versions are preserved, not dropped', async () => {
  const cipher = await VaultCipher.create((await createKeyring('future proof password')).master);
  const reopened = await cipher.open(parseEnvelope(await cipher.seal({ ...emptyVault(), tags: ['keep me'] })));
  assert.deepEqual(reopened.tags, ['keep me']);
});

// --- Encrypted file format ------------------------------------------------------------
async function encryptBytes(bytes, { thumbnail = null, id = crypto.randomUUID() } = {}) {
  const chunks = [];
  const meta = await encryptFile({ file: new Blob([bytes]), fileId: id, thumbnail, write: async (b) => chunks.push(b) });
  const blob = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    blob.set(c, at);
    at += c.length;
  }
  const entry = { id, size: bytes.length, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes };
  return { blob, entry, meta };
}
const plainOf = async (blob, entry, opts) => Buffer.concat((await decryptFile(new Blob([blob]).stream(), entry, opts)).map((p) => Buffer.from(p)));

test('files of every size round-trip through the streaming format', async () => {
  for (const size of [0, 1, 255, 300, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, Math.floor(2.5 * CHUNK_SIZE)]) {
    const bytes = bigRandom(size);
    const { blob, entry, meta } = await encryptBytes(bytes);
    assert.equal(blob.length, layout({ size }).total, `layout matches for ${size}`);
    assert.equal(meta.encryptedSize, blob.length);
    assert.ok(blob.length >= padme(size) + HEADER_BYTES, 'size is padded');
    assert.ok((await plainOf(blob, entry)).equals(Buffer.from(bytes)), `round-trip ${size}`);
  }
});

test('thumbnails ride inside the same blob and decrypt separately', async () => {
  const bytes = bigRandom(5000);
  const thumb = bigRandom(1200);
  const { blob, entry } = await encryptBytes(bytes, { thumbnail: thumb });
  assert.ok((await plainOf(blob, entry)).equals(Buffer.from(bytes)));
  const plan = layout({ size: bytes.length, thumbBytes: thumb.length });
  assert.ok((await plainOf(blob.subarray(0, plan.contentStart), entry, { part: 'thumb' })).equals(Buffer.from(thumb)));
});

test('tampering, truncation, extension, reordering and swaps are detected', async () => {
  const bytes = bigRandom(Math.floor(2.2 * CHUNK_SIZE));
  const { blob, entry } = await encryptBytes(bytes);
  const flipped = blob.slice();
  flipped[HEADER_BYTES + 10] ^= 1;
  await assert.rejects(plainOf(flipped, entry), /integrity/);
  await assert.rejects(plainOf(blob.subarray(0, blob.length - 100), entry), /incomplete/);
  await assert.rejects(plainOf(Buffer.concat([blob, Buffer.alloc(5)]), entry), /extra data/);
  const chunk = CHUNK_SIZE + 16;
  const swapped = blob.slice();
  swapped.set(blob.subarray(HEADER_BYTES, HEADER_BYTES + chunk), HEADER_BYTES + chunk);
  swapped.set(blob.subarray(HEADER_BYTES + chunk, HEADER_BYTES + 2 * chunk), HEADER_BYTES);
  await assert.rejects(plainOf(swapped, entry), /integrity/);
  await assert.rejects(plainOf(blob, { ...entry, id: crypto.randomUUID() }), /different record/);
  const other = await encryptBytes(bytes);
  await assert.rejects(plainOf(blob, { ...entry, key: other.entry.key }), /integrity/);
});

test('upload pieces are 256 KiB multiples except the last', async () => {
  const sent = [];
  const total = 3 * 256 * 1024 + 123;
  const writer = createPieceWriter({ total, pieceSize: 512 * 1024, send: async (piece, offset) => (sent.push([offset, piece.length]), offset + piece.length === total ? 'id' : null) });
  for (let i = 0; i < total; i += 70_000) await writer.write(new Uint8Array(Math.min(70_000, total - i)));
  assert.deepEqual(sent, [[0, 524288], [524288, 262267]]);
  assert.equal(writer.result, 'id');
});

// --- Service-worker random access ------------------------------------------------------
test('the service worker decrypts any byte range exactly', async () => {
  const bytes = bigRandom(Math.floor(3.3 * CHUNK_SIZE));
  const { blob, entry } = await encryptBytes(bytes, { thumbnail: bigRandom(900) });
  const plan = S.plan(entry);
  const l = layout({ size: entry.size, thumbBytes: entry.thumbBytes });
  assert.equal(plan.total, l.total);
  assert.equal(plan.contentStart, l.contentStart);
  const header = blob.subarray(0, S.HEADER);
  const prefix = S.checkHeader(header, entry);
  const key = await S.importKey(entry);
  for (const [from, to] of [[0, 0], [0, 99], [CHUNK_SIZE - 5, CHUNK_SIZE + 5], [123456, 2_900_000], [bytes.length - 1, bytes.length - 1], [0, bytes.length - 1]]) {
    const span = S.span(plan, from, to);
    let at = span.start;
    const out = [];
    for (let i = span.first; i <= span.last; i++) {
      const len = S.chunkLength(plan, i);
      const plain = await S.decryptChunk(key, prefix, i, i === plan.contentChunks - 1 ? 1 : 0, header, blob.subarray(at, at + len));
      at += len;
      const start = i * plan.chunk;
      out.push(plain.subarray(Math.max(from, start) - start, Math.min(to + 1, start + plain.length) - start));
    }
    assert.equal(at - 1, span.end);
    assert.ok(Buffer.concat(out.map((p) => Buffer.from(p))).equals(Buffer.from(bytes.subarray(from, to + 1))), `range ${from}-${to}`);
  }
});

test('Padmé padding leaks little and costs at most ~12%', () => {
  let previous = 0;
  for (let L = 0; L < 5_000_000; L += 997) {
    const p = padme(L);
    assert.ok(p >= Math.max(L, 256) && p >= previous);
    if (L >= 256) assert.ok(p / L <= 1.12 + 1e-9, `${L} -> ${p}`);
    previous = p;
  }
});

// --- ZIP, XML and document readers -----------------------------------------------------
async function deflatedZip(entries) {
  // Build with stored entries, then re-encode the bodies with deflate (method 8).
  const parts = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const { name, data } of entries) {
    const raw = enc.encode(data);
    const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const n = enc.encode(name);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.set(n, 30);
    const c = Buffer.alloc(46 + n.length);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    c.set(n, 46);
    parts.push(local, packed);
    central.push(c);
    offset += local.length + packed.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

test('ZIP reader handles stored and deflated entries', async () => {
  const stored = readZipDirectory(zipStore([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: '<x/>' }]));
  assert.equal(await readZipText(stored, 'a.txt'), 'hello');
  assert.equal(await readZipText(stored, 'missing'), null);
  const deflated = readZipDirectory(await deflatedZip([{ name: 'word/document.xml', data: 'x'.repeat(5000) + 'end' }]));
  assert.equal((await readZipText(deflated, 'word/document.xml')).slice(-3), 'end');
});

test('XML parser handles entities, CDATA, attributes and self-closing tags', () => {
  const doc = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><b>Tom &lt;&#x41;&gt;</b><c/><d><![CDATA[<raw>]]></d></a>');
  assert.equal(find(doc, 'a').attrs.x, '1 & 2');
  assert.equal(textOf(find(doc, 'b')), 'Tom <A>');
  assert.equal(textOf(find(doc, 'd')), '<raw>');
  assert.ok(find(doc, 'c'));
});

test('Word, Excel, PowerPoint, OpenDocument and RTF readers extract content', () => {
  const docx = extractDocx(
    '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> text</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  );
  assert.deepEqual(docx.map((b) => b.type), ['h', 'p', 'p', 'table']);
  assert.equal(docx[0].level, 1);
  assert.deepEqual(docx[1].runs.map((r) => [r.text, r.b]), [['Bold', true], [' text', false]]);
  assert.ok(docx[2].list);
  assert.deepEqual(docx[3].rows, [['A1', 'B1']]);

  const sheet = extractSheet('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>0.30000000000000004</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>hi</t></is></c><c r="C2" t="b"><v>1</v></c></row></sheetData></worksheet>', ['Name']);
  assert.deepEqual(sheet.rows.map((r) => Array.from(r, (v) => v ?? '')), [['Name', '', '0.3'], ['', 'hi', 'TRUE']]);

  const slide = extractSlide('<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><a:p><a:r><a:t>Quarterly</a:t></a:r></a:p></p:sp><p:sp><a:p><a:t>Point one</a:t></a:p><a:p><a:t>Point two</a:t></a:p></p:sp></p:sld>');
  assert.deepEqual(slide, { title: 'Quarterly', lines: ['Point one', 'Point two'] });

  const odt = extractOdf('<office:document-content><office:body><office:text><text:h text:outline-level="2">Hello</text:h><text:p>a<text:s text:c="2"/>b</text:p></office:text></office:body></office:document-content>');
  assert.equal(odt.kind, 'text');
  assert.equal(odt.blocks[1].runs[0].text, 'a  b');

  assert.equal(rtfToText('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello \\b bold\\b0 \\par World \\u8364?\\\'e9}'), 'Hello bold\nWorld €é');
});

test('the right viewer is chosen for each file type', () => {
  const v = (name, size = 1000) => viewerFor({ name, size });
  assert.deepEqual(
    ['a.jpg', 'a.HEIC', 'b.mp4', 'c.mov', 'd.mp3', 'e.pdf', 'f.docx', 'g.xlsx', 'h.pptx', 'i.md', 'j.csv', 'k.json', 'l.py', 'm.zip', 'n.exe'].map((n) => v(n)),
    ['image', 'image', 'video', 'video', 'audio', 'pdf', 'docx', 'xlsx', 'pptx', 'markdown', 'csv', 'json', 'code', null, null],
  );
  // Plain text opens as a document; config/log files monospace; unknown names get sniffed (null).
  assert.deepEqual(
    ['notes.txt', 'Subtitles.SRT', 'paper.tex', 'server.log', 'app.ini', 'site.yaml', 'README', '.bashrc', 'LICENSE'].map((n) => v(n)),
    ['text', 'text', 'text', 'code', 'code', 'code', null, null, null],
  );
  assert.equal(v('big.txt', 50 * 1024 * 1024), null);
  assert.equal(kindOf({ name: 'x.xlsx' }), 'sheet');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('text detection and decoding handle UTF-8, UTF-16 and legacy encodings', () => {
  const enc = new TextEncoder();
  assert.ok(looksLikeText(enc.encode('Hello\tworld\r\nLine 2 — ünïcode ✓')));
  assert.ok(!looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), 'binary with NUL bytes');
  assert.ok(looksLikeText(new Uint8Array([0xff, 0xfe, 0x48, 0x00])), 'UTF-16 with BOM');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('café')])), 'café', 'UTF-8 BOM stripped');
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])), 'Hi', 'UTF-16LE');
  assert.equal(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'café', 'Windows-1252 fallback');
});

// --- ZIP downloads (zip-core.js, as the service worker uses it) ---------------------------
const Z = globalThis.UniboxZip;

/** Builds a ZIP the way the worker streams it, feeding each file's CRC in uneven pieces. */
function buildZip(entries, data, options) {
  const layout = Z.plan(entries, options);
  const parts = [];
  const crcs = [];
  for (const item of layout.items) {
    parts.push(Z.localHeader(item));
    if (item.dir) {
      crcs.push(0);
      continue;
    }
    const body = data[item.path];
    let crc = 0;
    for (let at = 0; at < body.length; at += 7) crc = Z.crc32(crc, body.subarray(at, at + 7));
    crcs.push(crc);
    parts.push(body, Z.dataDescriptor(item, crc));
  }
  parts.push(Z.centralDirectory(layout, crcs));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { layout, bytes };
}

test('ZIP downloads: CRC-32 matches zlib, also when fed in pieces', () => {
  const data = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(40));
  let crc = 0;
  for (let at = 0; at < data.length; at += 13) crc = Z.crc32(crc, data.subarray(at, at + 13));
  assert.equal(crc, zlibCrc32(data));
  assert.equal(Z.crc32(0, new Uint8Array(0)), 0);
});

test('ZIP downloads: folders, Unicode names and empty files round-trip with exact sizes', async () => {
  const enc = new TextEncoder();
  const data = {
    'Trips/Japan 2026/notes.txt': enc.encode('Kyoto in spring'),
    'Trips/empty.txt': new Uint8Array(0),
    'Résumé ✓.pdf': crypto.getRandomValues(new Uint8Array(5000)),
  };
  const entries = [
    { path: 'Trips/', dir: true, mtime: new Date(2026, 10, 19, 10, 30).getTime() },
    { path: 'Trips/Japan 2026/', dir: true },
    { path: 'Trips/Japan 2026/notes.txt', size: data['Trips/Japan 2026/notes.txt'].length, fileId: 'a' },
    { path: 'Trips/empty.txt', size: 0, fileId: 'b' },
    { path: 'Résumé ✓.pdf', size: 5000, fileId: 'c', mtime: new Date(2026, 0, 2).getTime() },
  ];
  const { layout, bytes } = buildZip(entries, data);
  assert.equal(bytes.length, layout.total, 'Content-Length is known before the download starts');
  assert.equal(layout.zip64, false);
  const zip = readZipDirectory(bytes);
  assert.deepEqual([...zip.entries.keys()], entries.map((e) => e.path));
  for (const [path, body] of Object.entries(data)) assert.deepEqual(await readZipEntry(zip, path), body);
  // Central directory: real CRCs, UTF-8 flag, folder attribute, DOS time of the first folder.
  const v = new DataView(bytes.buffer);
  let at = layout.cdStart;
  for (const item of layout.items) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    assert.ok(v.getUint16(at + 8, true) & 0x0800);
    assert.equal(v.getUint32(at + 16, true), item.dir ? 0 : zlibCrc32(data[item.path]));
    assert.equal(v.getUint32(at + 38, true), item.dir ? 0x10 : 0);
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true);
  }
  const first = layout.cdStart;
  assert.equal(v.getUint16(first + 12, true), (10 << 11) | (30 << 5)); // 10:30:00
  assert.equal(v.getUint16(first + 14, true), ((2026 - 1980) << 9) | (11 << 5) | 19); // 19 Nov 2026
});

test('ZIP downloads: ZIP64 records once offsets pass the 4 GB limit', () => {
  const enc = new TextEncoder();
  const data = { 'a.txt': enc.encode('first'), 'b.txt': enc.encode('second file'), 'c.txt': enc.encode('third') };
  const entries = Object.keys(data).map((path, i) => ({ path, size: data[path].length, fileId: String(i) }));
  const { layout, bytes } = buildZip(entries, data, { limit32: 60 }); // pretend 4 GB is 60 bytes
  assert.equal(layout.zip64, true);
  assert.equal(bytes.length, layout.total);
  assert.ok(layout.items.some((i) => i.zip64) && layout.items.some((i) => !i.zip64));
  const v = new DataView(bytes.buffer);
  const eocd = bytes.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  assert.equal(v.getUint16(eocd + 10, true), 0xffff);
  assert.equal(v.getUint32(eocd + 16, true), 0xffffffff);
  const locator = eocd - 20;
  assert.equal(v.getUint32(locator, true), 0x07064b50);
  const end64 = Number(v.getBigUint64(locator + 8, true));
  assert.equal(v.getUint32(end64, true), 0x06064b50);
  assert.equal(Number(v.getBigUint64(end64 + 32, true)), 3);
  assert.equal(Number(v.getBigUint64(end64 + 40, true)), layout.cdSize);
  assert.equal(Number(v.getBigUint64(end64 + 48, true)), layout.cdStart);
  let at = layout.cdStart;
  for (const item of layout.items) {
    const nameLength = v.getUint16(at + 28, true);
    const marked = v.getUint32(at + 42, true) === 0xffffffff;
    assert.equal(marked, item.zip64);
    const offset = marked ? Number(v.getBigUint64(at + 46 + nameLength + 4, true)) : v.getUint32(at + 42, true);
    assert.equal(offset, item.offset);
    assert.equal(v.getUint32(offset, true), 0x04034b50);
    at += 46 + nameLength + v.getUint16(at + 30, true);
  }
});

test('ZIP downloads: paths that could escape the target folder are refused', () => {
  for (const bad of ['../evil.txt', 'a/../../b', '/abs', 'a\\b', 'a//b', '', 'bad\u0001name']) assert.throws(() => Z.checkPath(bad, false), bad);
  assert.throws(() => Z.checkPath('folder', true));
  assert.doesNotThrow(() => Z.checkPath('Trips/Japan 2026/notes.txt', false));
  assert.doesNotThrow(() => Z.checkPath('Trips/', true));
});

// --- Local boxes (.sbox, Tools menu) ------------------------------------------------------
const masterA = { kid: 'aaaaaaaaaaaaaaaa', key: crypto.getRandomValues(new Uint8Array(32)) };
const masterB = { kid: 'bbbbbbbbbbbbbbbb', key: crypto.getRandomValues(new Uint8Array(32)) };

async function makeBox(source, meta, keys) {
  const parts = [];
  const { size } = await writeBox({ source, meta, ...keys, write: (bytes) => parts.push(bytes.slice()) });
  const blob = new Blob(parts);
  assert.equal(blob.size, size, 'the box size is known before writing');
  return blob;
}

async function bytesOf(iterable) {
  const parts = [];
  for await (const part of iterable) parts.push(part);
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

/** Random test data of any size (getRandomValues fills at most 64 KiB per call). */
function randomData(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 65_536) crypto.getRandomValues(out.subarray(i, i + 65_536));
  return out;
}

test('local boxes: the account opens them, names stay hidden, ranges decrypt exactly', async () => {
  const data = randomData(3 * 1024 * 1024 + 123);
  const file = new File([data], 'Holiday video.mp4', { type: 'video/mp4', lastModified: 1_700_000_000_000 });
  const blob = await makeBox(file, { kind: 'file', name: file.name, type: file.type, mtime: file.lastModified }, { master: masterA });
  assert.ok(!Buffer.from(await blob.arrayBuffer()).includes('Holiday'), 'the real name never appears in the file');
  const box = await readBox(blob);
  assert.deepEqual(boxAccess(box, masterA), { mine: true, otherAccount: false, password: false });
  const unlocked = await unlockBox(box, { master: masterA });
  assert.deepEqual([unlocked.meta.name, unlocked.meta.type, unlocked.meta.size, unlocked.meta.mtime], ['Holiday video.mp4', 'video/mp4', data.length, 1_700_000_000_000]);
  const content = await openContent(blob, box, unlocked);
  assert.deepEqual(await bytesOf(content.stream({ window: 2 })), data);
  assert.deepEqual(await content.read(1_048_570, 1_048_600), data.subarray(1_048_570, 1_048_601), 'a range across a chunk boundary');
  await assert.rejects(unlockBox(box, { master: masterB }), (e) => e.code === 'other-account');
  await assert.rejects(unlockBox(box, {}), (e) => e.code === 'other-account');

  const empty = await makeBox(new File([], 'empty.txt'), { kind: 'file', name: 'empty.txt' }, { master: masterA });
  const emptyBox = await readBox(empty);
  assert.equal((await bytesOf((await openContent(empty, emptyBox, await unlockBox(emptyBox, { master: masterA }))).stream())).length, 0);
});

test('local boxes: a sharing password opens them too, and only that password', async () => {
  const file = new File(['shared secret notes'], 'notes.txt', { type: 'text/plain' });
  const meta = { kind: 'file', name: 'notes.txt', type: 'text/plain' };
  const blob = await makeBox(file, meta, { master: masterA, password: 'correct horse battery staple' });
  const box = await readBox(blob);
  assert.deepEqual(boxAccess(box, masterB), { mine: false, otherAccount: true, password: true });
  await assert.rejects(unlockBox(box, { master: masterB }), (e) => e.code === 'needs-password');
  await assert.rejects(unlockBox(box, { password: 'wrong horse battery staple' }), (e) => e.code === 'wrong-password');
  const byPassword = await unlockBox(box, { password: 'correct horse battery staple' });
  const byAccount = await unlockBox(box, { master: masterA });
  assert.deepEqual(byPassword.fileKey, byAccount.fileKey, 'both copies hold the same file key');
  assert.equal(new TextDecoder().decode(await bytesOf((await openContent(blob, box, byPassword)).stream())), 'shared secret notes');

  const passwordOnly = await readBox(await makeBox(file, meta, { password: 'correct horse battery staple' }));
  assert.deepEqual(boxAccess(passwordOnly, masterA), { mine: false, otherAccount: false, password: true });
  await assert.rejects(writeBox({ source: file, meta, write: () => {} }), (e) => e.code === 'no-key');
});

test('local boxes: tampering, cut-off files, extra data and swapped key copies are caught', async () => {
  const file = new File([randomData(200_000)], 'a.bin');
  const blob = await makeBox(file, { kind: 'file', name: 'a.bin' }, { master: masterA });
  const raw = new Uint8Array(await blob.arrayBuffer());
  const box = await readBox(blob);
  const readAll = async (b) => {
    const bx = await readBox(b);
    return bytesOf((await openContent(b, bx, await unlockBox(bx, { master: masterA }))).stream());
  };

  const flipped = raw.slice();
  flipped[flipped.length - 100] ^= 1;
  await assert.rejects(readAll(new Blob([flipped])), (e) => e.code === 'damaged', 'changed content');
  await assert.rejects(readAll(new Blob([raw.subarray(0, raw.length - 10)])), (e) => e.code === 'damaged', 'cut off');
  await assert.rejects(readAll(new Blob([raw, new Uint8Array(5)])), (e) => e.code === 'damaged', 'extra data');

  const other = await readBox(await makeBox(file, { kind: 'file', name: 'b.bin' }, { master: masterA }));
  await assert.rejects(unlockBox({ ...box, header: { ...box.header, slots: other.header.slots } }, { master: masterA }), (e) => e.code === 'damaged', 'key copy from another box');
  await assert.rejects(unlockBox({ ...box, header: { ...box.header, meta: other.header.meta } }, { master: masterA }), (e) => e.code === 'damaged', 'metadata from another box');
  await assert.rejects(unlockBox({ ...box, header: { ...box.header, kind: 'folder' } }, { master: masterA }), (e) => e.code === 'damaged', 'kind changed');
  await assert.rejects(readBox(new Blob(['hello, this is not a box'])), (e) => e.code === 'not-box');
});

test('local boxes: a folder packs into one box and unpacks file by file', async () => {
  const big = randomData(1_500_000);
  const items = [
    { path: 'Trips/', dir: true },
    { path: 'Trips/Japan 2026/', dir: true },
    { path: 'Trips/Japan 2026/notes ✓.txt', file: new File(['Kyoto in spring'], 'notes ✓.txt') },
    { path: 'Trips/photo.bin', file: new File([big], 'photo.bin') },
    { path: 'Trips/empty.txt', file: new File([], 'empty.txt') },
  ];
  const blob = await makeBox(await zipFolder(items), { kind: 'folder', name: 'Trips', files: 3 }, { master: masterA });
  const box = await readBox(blob);
  const unlocked = await unlockBox(box, { master: masterA });
  assert.deepEqual([unlocked.meta.kind, unlocked.meta.name, unlocked.meta.files], ['folder', 'Trips', 3]);
  const content = await openContent(blob, box, unlocked);
  const entries = await zipEntries(content);
  assert.deepEqual(entries.map((e) => [e.path, e.dir]), items.map((it) => [it.path, Boolean(it.dir)]));
  for (const [i, entry] of entries.entries()) {
    if (!entry.dir) assert.deepEqual(await bytesOf(zipEntryData(content, entry, { window: 300_000 })), new Uint8Array(await items[i].file.arrayBuffer()));
  }
  const zip = readZipDirectory(await bytesOf(content.stream()));
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, 'Trips/Japan 2026/notes ✓.txt')), 'Kyoto in spring', 'the inside is a normal ZIP');
});

// --- Items, CSV, generator --------------------------------------------------------------
test('text messages: the account and a sharing password open them; tampering is caught', async () => {
  const text = 'Gate code 4471 — leave the parcel by the door ✓';
  const both = await sealText({ text, master: masterA, password: 'correct horse battery staple' });
  assert.match(both, /^-----BEGIN SECURE BOX MESSAGE-----\n[A-Za-z0-9+/=\n]+\n-----END SECURE BOX MESSAGE-----$/);
  assert.ok(looksLikeMessage(`Here you go:\n${both}\nbye`));
  assert.ok(!both.includes('Gate'));
  const msg = readMessage(`  > ${both.split('\n').join('\n')}  `.replace('  > ', ''));
  assert.deepEqual(messageAccess(msg, masterA), { mine: true, account: true, password: true });
  assert.deepEqual(messageAccess(msg, masterB), { mine: false, account: true, password: true });
  assert.equal(await openMessage(msg, { master: masterA }), text);
  assert.equal(await openMessage(msg, { password: 'correct horse battery staple' }), text);
  assert.equal(await openMessage(msg, { master: masterB, password: 'correct horse battery staple' }), text);
  await assert.rejects(openMessage(msg, { password: 'wrong' }), { code: 'wrong-password' });
  await assert.rejects(openMessage(msg, {}), { code: 'needs-password' });
  // Account-only: another account can't open it.
  const mine = readMessage(await sealText({ text: '', master: masterA }));
  assert.equal(await openMessage(mine, { master: masterA }), '');
  await assert.rejects(openMessage(mine, { master: masterB }), { code: 'other-account' });
  // Any flipped bit in the body, or a stripped key copy, is caught.
  const raw = both.split('\n').slice(1, -1).join('');
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  for (const at of [5, 30, bytes.length - 3]) {
    const bad = bytes.slice();
    bad[at] ^= 1;
    const armored = `-----BEGIN SECURE BOX MESSAGE-----\n${btoa(String.fromCharCode(...bad))}\n-----END SECURE BOX MESSAGE-----`;
    await assert.rejects(async () => openMessage(readMessage(armored), { master: masterA, password: 'correct horse battery staple' }));
  }
  assert.throws(() => readMessage('hello'), { code: 'not-message' });
  assert.throws(() => readMessage(both.slice(0, -10)), { code: 'damaged' });
  await assert.rejects(sealText({ text: 'x' }), { code: 'no-key' });
});

test('the local vault index has its own key: it can never pass for the vault, or the other way round', async () => {
  const vaultCipher = await VaultCipher.create(masterA);
  const indexCipher = await VaultCipher.create(masterA, LOCAL_INDEX);
  const sealedIndex = await indexCipher.seal(emptyVault());
  const sealedVault = await vaultCipher.seal(emptyVault());
  assert.deepEqual((await indexCipher.open(parseEnvelope(sealedIndex, LOCAL_INDEX.format))).files, []);
  assert.throws(() => parseEnvelope(sealedIndex), { code: 'bad-vault' });
  await assert.rejects(vaultCipher.open({ ...JSON.parse(sealedIndex), format: 'unibox-vault' }), { code: 'decrypt-failed' });
  await assert.rejects(indexCipher.open(JSON.parse(sealedVault)), { code: 'bad-vault' });
  await assert.rejects(indexCipher.open({ ...JSON.parse(sealedVault), format: LOCAL_INDEX.format }), { code: 'decrypt-failed' });
});

test('only http(s) links are clickable', () => {
  assert.equal(safeHref('github.com'), 'https://github.com/');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,hi'), null);
});

test('CSV import/export round-trips and dedupes', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  const items = [makeItem({ title: 'Tricky, "quoted"', username: 'me', password: 'p,a"ss\nword', url: 'https://x.test' }), makeItem({ type: 'note', title: 'Note', notes: 'line 1\nline 2' })];
  const pick = ({ type, title, username, password, url, notes }) => ({ type, title, username, password, url, notes });
  assert.deepEqual(itemsFromCsv(itemsToCsv(items)).map(pick), items.map(pick));
  const once = applyChange(emptyVault(), { op: 'import', items });
  assert.equal(applyChange(once, { op: 'import', items: itemsFromCsv(itemsToCsv(items)) }).items.length, 2);
});

test('generated passwords honour length and character sets', () => {
  for (let i = 0; i < 100; i++) {
    const pw = generatePassword({ length: 16 });
    assert.equal(pw.length, 16);
    for (const set of Object.values(CHARSETS)) assert.ok([...pw].some((c) => set.includes(c)));
  }
  assert.ok(passwordEntropyBits({ length: 20 }) > 110);
});
