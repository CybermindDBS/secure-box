// Run with: npm test   (Node 20+, no dependencies)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';
import '../src/core/stream-core.js';
import '../src/core/zip-core.js';
import { CHARSETS, generatePassword, padme, passwordEntropyBits } from '../src/core/crypto.js';
import { CHUNK_SIZE, HEADER_BYTES, createPieceWriter, decryptFile, encryptFile, layout } from '../src/core/fileformat.js';
import { formatBytes, kindOf, viewerFor } from '../src/core/filetypes.js';
import {
  createKeyring,
  decodeRecoveryKey,
  emergencyKitText,
  encodeRecoveryKey,
  parseKeyring,
  passwordProblem,
  recoveryKeyFromKit,
  serializeKeyring,
  trustedRevision,
  unlockWithPassword,
  unlockWithRecovery,
  verifyRevision,
  withNewPassword,
  withNewRecovery,
} from '../src/core/keyring.js';
import { looksLikeMessage, messageAccess, openMessage, readMessage, sealText } from '../src/core/textbox.js';
import { OneDrive } from '../src/core/microsoft.js';
import { createOneDriveBackend } from '../src/core/backend.js';
import { decodeText, extractDocx, extractOdf, extractSheet, extractSlide, looksLikeText, rtfToText } from '../src/core/readers.js';
import {
  VaultCipher,
  applyChange,
  collectTree,
  compareVaults,
  copiesInUse,
  emptyVault,
  folderChain,
  itemsFromCsv,
  itemsToCsv,
  makeFileEntry,
  makeFolder,
  makeItem,
  mergeVaults,
  movedNoteText,
  parseCsv,
  parseEnvelope,
  safeHref,
  uniqueName,
} from '../src/core/vault.js';
import { find, parseXml, textOf } from '../src/core/xml.js';
import { readZipDirectory, readZipEntry, readZipText, zipStore } from '../src/core/zip.js';
import { boxAccess, openContent, readBox, unlockBox, writeBox, zipEntries, zipEntryData, zipFolder } from '../src/core/localbox.js';
import { createLocalBackend, readBackup, vaultIn } from '../src/core/localstore.js';
import { checkPlace, copyFiles, encryptedSize, lookAt } from '../src/core/transfer.js';

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
  const file = makeFileEntry({ name: 'return.pdf', type: 'application/pdf', size: 10, folder: taxes.id, blob: crypto.randomUUID(), key: 'A'.repeat(43), chunk: CHUNK_SIZE });
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

test('files, vaults and key rings carry the Secure Box names', async () => {
  const { blob, entry } = await encryptBytes(bigRandom(3000));
  assert.equal(Buffer.from(blob.subarray(0, 8)).toString('latin1'), 'SECBOXF1');
  S.checkHeader(blob.subarray(0, S.HEADER), entry); // the service worker takes it
  const stranger = blob.slice();
  stranger.set(Buffer.from('NOTABOX1'), 0);
  await assert.rejects(plainOf(stranger, entry), /not a Secure Box encrypted file/);
  assert.throws(() => S.checkHeader(stranger.subarray(0, S.HEADER), entry), /Not a Secure Box encrypted file/);

  const master = { kid: 'abcdef0123456789', key: random(32) };
  assert.equal(JSON.parse(await (await VaultCipher.create(master)).seal(emptyVault())).format, 'secure-box-vault');
  const { doc } = await createKeyring('a fresh master password', master);
  assert.equal(doc.format, 'secure-box-keyring');
  assert.ok(!serializeKeyring(doc).includes('unibox'));
  // A key ring in another version's format says so, rather than "damaged".
  assert.throws(() => parseKeyring(JSON.stringify({ ...doc, format: 'unibox-keyring' })), { code: 'other-version', message: /another version of Secure Box/ });
  assert.throws(() => parseKeyring('{"format": "secure-box-keyring", "kid": 1'), { code: 'bad-keyring' });
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

test('a ZIP download fetches small files ahead, a few at a time and within its memory budget, in order', async () => {
  const MB = 1024 * 1024;
  // Folders and empty files (0) have nothing to fetch; 20 MB is too big to fetch ahead.
  const sizes = [0, MB, MB, 0, 20 * MB, MB, MB, MB, MB, 3 * MB, 3 * MB, 3 * MB, MB];
  let running = 0;
  let most = 0;
  const started = [];
  const finish = new Map();
  const ahead = Z.fetchAhead(
    sizes,
    (i) => {
      started.push(i);
      running++;
      most = Math.max(most, running);
      return new Promise((resolve, reject) => finish.set(i, (ok = true) => (running--, ok ? resolve(`file ${i}`) : reject(new Error(`file ${i} failed`)))));
    },
    { count: 3, budget: 5 * MB, small: 8 * MB },
  );
  const got = [];
  for (let i = 0; i < sizes.length; i++) {
    const p = ahead.take(i);
    if (!p) {
      got.push(sizes[i] ? `streamed ${i}` : '-');
      continue;
    }
    // The file being written finishes; the ones fetched ahead meanwhile finish in any order.
    finish.get(i)();
    got.push(await p);
  }
  assert.deepEqual(got, ['-', 'file 1', 'file 2', '-', 'streamed 4', 'file 5', 'file 6', 'file 7', 'file 8', 'file 9', 'file 10', 'file 11', 'file 12']);
  assert.deepEqual(started, [1, 2, 5, 6, 7, 8, 9, 10, 11, 12], 'each small file once, in order; the big one never');
  assert.ok(most <= 4 && most >= 3, `the one being written and up to three ahead (${most})`);

  // At most the budget held: three 3 MB files ahead don't all fit in 5 MB.
  const held = [];
  const tight = Z.fetchAhead([3 * MB, 3 * MB, 3 * MB], (i) => (held.push(i), Promise.resolve(i)), { count: 3, budget: 5 * MB, small: 8 * MB });
  assert.equal(await tight.take(0), 0);
  assert.deepEqual(held, [0, 1], 'the third waits until the first is taken');
  assert.equal(await tight.take(1), 1);
  assert.deepEqual(held, [0, 1, 2]);

  // A file that fails fetched ahead fails when its turn comes, not before.
  const failing = Z.fetchAhead([MB, MB], (i) => (i === 1 ? Promise.reject(new Error('file 1 failed')) : Promise.resolve('file 0')), { count: 2, budget: 5 * MB, small: 8 * MB });
  assert.equal(await failing.take(0), 'file 0');
  await assert.rejects(failing.take(1), /file 1 failed/);
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

test('local boxes made with one password each get a salt of their own, so nothing links them', async () => {
  const password = 'correct horse battery staple';
  const boxes = [];
  for (const name of ['one.txt', 'two.txt', 'three.txt']) boxes.push(await readBox(await makeBox(new File([`text of ${name}`], name), { kind: 'file', name }, { password })));
  const slots = boxes.map((box) => box.header.slots.find((s) => s.type === 'password'));
  assert.equal(new Set(slots.map((s) => s.salt)).size, 3, 'a salt of its own for each');
  assert.equal(new Set(slots.map((s) => s.iv)).size, 3);
  const opened = [];
  for (const box of boxes) opened.push(await unlockBox(box, { password }));
  assert.deepEqual(opened.map((o) => o.meta.name), ['one.txt', 'two.txt', 'three.txt']);
  assert.equal(new Set(opened.map((o) => Buffer.from(o.fileKey).toString('hex'))).size, 3, 'and a file key of its own');
  // A locked copy of one box's key doesn't open another box made with the same password.
  const swapped = { ...boxes[1], header: { ...boxes[1].header, slots: [slots[0]] } };
  await assert.rejects(unlockBox(swapped, { password }), (e) => e.code === 'wrong-password');
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

test('key ring revisions: every change counts up, and an old copy can’t pose as newer', async () => {
  const { doc, master } = await createKeyring('correct horse battery staple');
  assert.equal(trustedRevision(doc), 1);
  const changed = await withNewPassword(doc, master, 'another long master password');
  assert.equal(trustedRevision(changed), 2);
  const { doc: kitted } = await withNewRecovery(changed, master);
  assert.equal(trustedRevision(kitted), 3);
  // A copy read back from storage is trusted only after checking its signature.
  const stored = parseKeyring(serializeKeyring(kitted));
  assert.equal(trustedRevision(stored), 0);
  assert.equal(await verifyRevision(stored, master), 3);
  // Replaying the old copy with a bigger number fails the check, and counts as 0.
  const replay = parseKeyring(serializeKeyring({ ...doc, revision: 99 }));
  assert.equal(await verifyRevision(replay, master), 0);
  // Another account's key can't vouch for it either; an unsigned (older) key ring is 0.
  const other = await createKeyring('a different master password');
  assert.equal(await verifyRevision(parseKeyring(serializeKeyring(kitted)), other.master), 0);
  const { revision, revisionMac, ...unsigned } = kitted;
  assert.equal(await verifyRevision(parseKeyring(serializeKeyring(unsigned)), master), 0);
  // The new password still opens it; the old one doesn't.
  assert.deepEqual((await unlockWithPassword(stored, 'another long master password')).key, master.key);
  await assert.rejects(unlockWithPassword(stored, 'correct horse battery staple'));
});

test('a backup carries the vault exactly as stored, with its key ring, and only version 1 is read', async () => {
  const manifest = { format: 'secure-box-backup', version: 1, kid: 'abcdef0123456789' };
  const sealed = { format: 'secure-box-vault', version: 3, kid: manifest.kid, salt: 's', iv: 'i', ct: 'c' };
  const backup = (m, { keyring = true, vault = sealed } = {}) =>
    new Blob([
      zipStore([
        { name: 'backup.json', data: JSON.stringify(m) },
        ...(keyring ? [{ name: 'Secure Box Key Ring.json', data: '{"format":"secure-box-keyring"}' }] : []),
        { name: 'Secure Box Vault.json', data: JSON.stringify(vault) },
        { name: 'Encrypted files/0f8fad5b-d9cb-469f-a165-70867728950e', data: 'copy' },
        { name: 'Encrypted files/notes.txt', data: 'not one of the vault’s copies' },
      ]),
    ]);
  const read = await readBackup(backup(manifest));
  assert.equal(read.manifest.kid, manifest.kid);
  assert.match(read.keyring, /secure-box-keyring/);
  assert.match(read.vault, /secure-box-vault/);
  assert.deepEqual(read.names(), ['0f8fad5b-d9cb-469f-a165-70867728950e']);
  await assert.rejects(readBackup(backup(manifest, { keyring: false })), { code: 'not-backup' });
  await assert.rejects(readBackup(backup({ ...manifest, format: 'something-else' })), { code: 'not-backup', message: /isn’t a Secure Box backup/ });
  await assert.rejects(readBackup(new Blob(['not a zip at all'])), { code: 'not-backup' });
  // Backups an earlier version made say so, rather than seem damaged: the older backup format,
  // an older version of this one, or a vault inside in an older format.
  const earlier = { code: 'other-version', message: /another version of Secure Box/ };
  await assert.rejects(readBackup(backup({ ...manifest, format: 'secure-box-local-backup', version: 2 })), earlier);
  await assert.rejects(readBackup(backup({ ...manifest, version: 0 })), earlier);
  await assert.rejects(readBackup(backup(manifest, { vault: { ...sealed, version: 2 } })), earlier);
  await assert.rejects(readBackup(backup(manifest, { vault: { ...sealed, format: 'secure-box-local-index' } })), earlier);
  await assert.rejects(readBackup(backup(manifest, { vault: { ...sealed, ct: '' } })), { code: 'not-backup' });
  await assert.rejects(readBackup(backup({ ...manifest, version: 2 })), { code: 'newer' });
});

// --- The vault on this device: moving and deleting -----------------------------------------
// An in-memory stand-in for the browser's folder handles (File System Access API).
const fsError = (name, message) => Object.assign(new Error(message), { name });
// Like the browser's: once deleted, everything on a handle fails with NotFoundError.
const ensureThere = (entry) => {
  if (entry.removed) throw fsError('NotFoundError', `${entry.name} was deleted`);
};
const markRemoved = (entry) => {
  entry.removed = true;
  for (const child of entry.children?.values() || []) markRemoved(child);
};
class MemFile {
  constructor(name, opts) {
    Object.assign(this, { kind: 'file', name, opts, data: new Uint8Array(0) });
  }
  async getFile() {
    ensureThere(this);
    return new File([this.data], this.name, this.opts.clock ? { lastModified: this.opts.clock } : undefined); // `clock`: a disk that shows every file at one time
  }
  async createWritable() {
    ensureThere(this);
    const parts = [];
    return {
      write: async (chunk) => {
        if (this.opts.failWrite?.(this.name)) throw new Error(`Disk full while writing ${this.name}`);
        parts.push(Buffer.from(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk));
      },
      close: async () => {
        this.data = new Uint8Array(Buffer.concat(parts));
      },
      abort: async () => {},
    };
  }
  async isSameEntry(other) {
    return other === this;
  }
}
class MemDir {
  constructor(name, opts = {}) {
    Object.assign(this, { kind: 'directory', name, opts, children: new Map() });
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    ensureThere(this);
    if (!this.children.has(name) && create) this.children.set(name, new MemDir(name, this.opts));
    const entry = this.children.get(name);
    if (!entry) throw fsError('NotFoundError', `${name} not found`);
    if (entry.kind !== 'directory') throw fsError('TypeMismatchError', `${name} is a file`);
    return entry;
  }
  async getFileHandle(name, { create = false } = {}) {
    ensureThere(this);
    if (!this.children.has(name) && create) this.children.set(name, new MemFile(name, this.opts));
    const entry = this.children.get(name);
    if (!entry) throw fsError('NotFoundError', `${name} not found`);
    if (entry.kind !== 'file') throw fsError('TypeMismatchError', `${name} is a folder`);
    return entry;
  }
  async removeEntry(name, { recursive = false } = {}) {
    ensureThere(this);
    const entry = this.children.get(name);
    if (!entry) throw fsError('NotFoundError', `${name} not found`);
    if (entry.kind === 'directory' && entry.children.size && !recursive) throw fsError('InvalidModificationError', `${name} isn’t empty`);
    this.children.delete(name);
    markRemoved(entry);
  }
  async *entries() {
    ensureThere(this);
    yield* [...this.children.entries()];
  }
  async isSameEntry(other) {
    return other === this;
  }
  async resolve(other) {
    if (other === this) return [];
    for (const [name, entry] of this.children) {
      const below = entry.kind === 'directory' ? await entry.resolve(other) : null;
      if (below) return [name, ...below];
    }
    return null;
  }
}
/** Every file under a folder as { 'path/name': base64 bytes }, to compare places. */
function snapshot(dir, prefix = '') {
  const out = {};
  for (const [name, entry] of dir.children) {
    if (entry.kind === 'file') out[prefix + name] = Buffer.from(entry.data).toString('base64');
    else Object.assign(out, snapshot(entry, `${prefix}${name}/`));
  }
  return out;
}
const deviceKid = '0123456789abcdef';
const inFolder = (handle) => createLocalBackend({ where: 'folder', handle, kid: deviceKid });
async function writeText(dir, name, text) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
}
/** A vault in a chosen folder (in its "Secure Box" folder), with a few encrypted-file stand-ins. */
async function folderVault(picked, blobs = 3) {
  const backend = inFolder(picked);
  await backend.create({ keyringText: JSON.stringify({ format: 'secure-box-keyring', kid: deviceKid }), vaultText: JSON.stringify({ format: 'secure-box-vault', version: 3, kid: deviceKid, salt: 's', iv: 'i', ct: 'c' }), kid: deviceKid });
  for (let i = 0; i < blobs; i++) {
    const bytes = random(1000 + 700 * i);
    await (await backend.openUpload({ name: crypto.randomUUID() }))(bytes, 0, bytes.length);
  }
  return backend;
}

/** A file encrypted into `backend` as an upload would be; resolves with its vault entry. */
async function addFile(backend, name, bytes) {
  const id = crypto.randomUUID();
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  const plan = layout({ size: file.size, thumbBytes: 0 });
  const send = await backend.openUpload({ name: id, size: plan.total });
  const writer = createPieceWriter({ total: plan.total, send, pieceSize: send.pieceSize });
  const meta = await encryptFile({ file, fileId: id, write: (b) => writer.write(b) });
  return makeFileEntry({ id, name, type: file.type, size: file.size, folder: null, blob: id, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes });
}

test('a transfer copies encrypted copies by name, picks up where it stopped, and reads it all back', async () => {
  const cipher = await VaultCipher.create(masterA);
  const keyringText = serializeKeyring((await createKeyring('transfer test password', { kid: masterA.kid, key: masterA.key })).doc);
  const from = inFolder(new MemDir('From'));
  await from.create({ keyringText, vaultText: await cipher.seal(emptyVault()), kid: masterA.kid });
  const entries = [];
  for (const [name, size] of [['notes.txt', 3000], ['photo.jpg', 2_500_000], ['gone.txt', 10]]) entries.push(await addFile(from, name, (size > 65536 ? bigRandom : random)(size)));
  const vault = applyChange(emptyVault(), { op: 'batch', changes: entries.map((file) => ({ op: 'file-put', file })) });
  const to = createLocalBackend({ where: 'folder', handle: new MemDir('To') });
  assert.equal(lookAt(await to.load(), masterA.kid).kind, 'empty');

  // A transfer that stopped after its first copy, with the next one cut short...
  await copyFiles({ from, to, files: [entries[0]] });
  const cut = random(100);
  await (await to.openUpload({ name: entries[1].blob }))(cut, 0, cut.length);
  // ...picks up where it was: a whole copy stays, a short one goes again, one missing at the source is left out.
  await from.trash(entries[2].blob);
  const progress = [];
  const made = [];
  const result = await copyFiles({ from, to, files: entries, onProgress: (p) => progress.push(p), onCopied: (name) => made.push(name) });
  assert.deepEqual([result.copied, result.kept, result.missing.map((f) => f.name)], [1, 1, ['gone.txt']]);
  assert.deepEqual(made, [entries[1].blob], 'only the copy it made is reported, for removing if the transfer is given up');
  assert.equal(progress.at(-1).done, progress.at(-1).total);
  const photo = entries[1];
  const back = await new Blob(await decryptFile(await to.readRange(photo.blob, 0, encryptedSize(photo) - 1), photo)).arrayBuffer();
  assert.equal(back.byteLength, photo.size, 'the copy opens there, whole');

  // Then the vault and key ring; reading back finds a copy that isn't there.
  await to.create({ keyringText, vaultText: await cipher.seal(vault), kid: masterA.kid });
  await assert.rejects(checkPlace({ backend: to, cipher, kid: masterA.kid, files: entries }), /gone\.txt/);
  const checked = await checkPlace({ backend: to, cipher, kid: masterA.kid, files: entries, skip: new Set([entries[2].id]) });
  assert.equal(checked.vault.files.length, 3);
  assert.equal(lookAt(await to.load(), masterA.kid).kind, 'same');
});

test('a transfer copies a few files at once, and one copy failing stops the rest before it ends', async () => {
  const cipher = await VaultCipher.create(masterA);
  const from = inFolder(new MemDir('From'));
  await from.create({ keyringText: JSON.stringify({ format: 'secure-box-keyring', kid: masterA.kid }), vaultText: await cipher.seal(emptyVault()), kid: masterA.kid });
  const entries = [];
  for (let i = 0; i < 7; i++) entries.push(await addFile(from, `file ${i}.txt`, random(5000 + i)));
  // A destination whose uploads take a while, like a cloud's: how many go at once?
  const slow = (to, { failOn = null } = {}) => {
    let open = 0;
    const seen = { most: 0, after: 0 };
    let failed = false;
    return Object.assign(Object.create(to), {
      seen,
      async openUpload(options) {
        const send = await to.openUpload(options);
        open++;
        seen.most = Math.max(seen.most, open);
        return Object.assign(
          async (piece, offset, total) => {
            await new Promise((r) => setTimeout(r, 15));
            if (failed) seen.after++;
            if (options.name === failOn) {
              failed = true;
              throw new Error('The cloud refused it.');
            }
            const id = await send(piece, offset, total);
            if (id) open--;
            return id;
          },
          { pieceSize: send.pieceSize, abort: async () => (open--, send.abort?.()) },
        );
      },
    });
  };
  // A new, empty folder to copy into, looked at first (as Move or copy does).
  const place = async (name, options) => {
    const to = createLocalBackend({ where: 'folder', handle: new MemDir(name) });
    await to.load();
    return slow(to, options);
  };
  const fast = await place('To');
  const result = await copyFiles({ from, to: fast, files: entries });
  assert.deepEqual([result.copied, result.missing.length], [7, 0]);
  assert.equal(fast.seen.most, 3, 'three copies at once');
  const one = await place('To one');
  await copyFiles({ from, to: one, files: entries, parallel: 1 });
  assert.equal(one.seen.most, 1);

  // One failing: the others stop, and nothing is still going once it throws.
  const failing = await place('To failing', { failOn: entries[1].blob });
  const made = [];
  await assert.rejects(copyFiles({ from, to: failing, files: entries, onCopied: (name) => made.push(name) }), /refused/);
  const settled = failing.seen.after;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(failing.seen.after, settled, 'nothing still going after it ended');
  assert.ok(made.length < entries.length - 1, 'the rest weren’t copied');

  // Stopped from outside: an AbortError, once every copy under way has stopped.
  const stop = new AbortController();
  const stopping = await place('To stopped');
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(copyFiles({ from, to: stopping, files: entries, signal: stop.signal }), { name: 'AbortError' });
});

test('a place is seen for what it holds: nothing, a note, the same vault, another, or what can’t be read', async () => {
  const mine = await createKeyring('look test one', { kid: masterA.kid, key: masterA.key });
  const theirs = await createKeyring('look test two');
  const sealedMine = await (await VaultCipher.create(masterA)).seal(emptyVault());
  const sealedTheirs = await (await VaultCipher.create(theirs.master)).seal(emptyVault());
  const look = (keyring, vault, extra = {}) => lookAt({ keyring: keyring && serializeKeyring(keyring.doc), vault: vault && { text: vault, rev: 'r1' }, ...extra }, masterA.kid);
  assert.equal(look(null, null).kind, 'empty');
  assert.equal(look(null, null, { inBin: true }).inBin, true);
  assert.equal(look(null, movedNoteText('microsoft')).note.to, 'microsoft', 'a note that a vault moved away: nothing there');
  assert.equal(look(mine, sealedMine).kind, 'same');
  assert.equal(look(mine, null).kind, 'same', 'its vault file missing: the key ring is enough');
  assert.equal(look(null, sealedMine).kind, 'same', 'its key ring missing: this master key opens it anyway');
  assert.equal(look(theirs, sealedTheirs).kind, 'other');
  assert.equal(look(null, sealedTheirs).kind, 'unreadable', 'another key, and no key ring to open it');
  assert.equal(look(mine, sealedTheirs).kind, 'unreadable', 'a key ring and vault of different keys');
  assert.equal(look(mine, JSON.stringify({ ...JSON.parse(sealedMine), version: 2 })).code, 'other-version');
});

test('two vaults are combined with nothing lost: the latest version of the same thing, folders of one name as one', () => {
  const file = (name, folder) => makeFileEntry({ name, type: 'text/plain', size: 1, folder, blob: crypto.randomUUID(), key: 'A'.repeat(43), chunk: CHUNK_SIZE });
  // "there": a copy of this vault made earlier, then changed on its own; "here": this vault.
  const bank = makeItem({ title: 'Bank', password: 'old' });
  const there = applyChange(emptyVault(), { op: 'put', item: bank });
  const here = applyChange(there, { op: 'put', item: makeItem({ title: 'Mail' }) });
  assert.ok(compareVaults(there, here).earlierCopy, 'nothing there that isn’t here: an earlier copy');
  const changed = applyChange(there, { op: 'put', item: { ...bank, password: 'new', updated: bank.updated + 1000 } });
  const compare = compareVaults(changed, here);
  assert.deepEqual([compare.earlierCopy, compare.newerThere.items, compare.onlyThere.items], [false, 1, 0]);
  const merged = mergeVaults(changed, here);
  assert.deepEqual(merged.items.map((it) => [it.title, it.password]).sort(), [['Bank', 'new'], ['Mail', '']], 'the version changed last wins');

  // A folder of the same name in the same place becomes one; a clashing file name is kept apart.
  const scansThere = makeFolder({ name: 'Scans' });
  const scansHere = makeFolder({ name: 'scans' });
  const inner = makeFolder({ name: 'Old', parent: scansHere.id });
  const a = applyChange(emptyVault(), { op: 'batch', changes: [{ op: 'folder-put', folder: scansThere }, { op: 'file-put', file: file('a.pdf', scansThere.id) }] });
  const b = applyChange(emptyVault(), { op: 'batch', changes: [{ op: 'folder-put', folder: scansHere }, { op: 'folder-put', folder: inner }, { op: 'file-put', file: file('a.pdf', scansHere.id) }, { op: 'file-put', file: file('b.pdf', inner.id) }] });
  const both = mergeVaults(a, b);
  assert.deepEqual(both.folders.map((f) => [f.name, f.parent === scansThere.id]), [['Scans', false], ['Old', true]]);
  assert.deepEqual(both.files.map((f) => [f.name, f.folder === scansThere.id]), [['a.pdf', true], ['a (2).pdf', true], ['b.pdf', false]]);
  assert.equal(both.files.find((f) => f.name === 'b.pdf').folder, inner.id);
  // Its list of copies to delete is the one there, never naming a copy in use.
  const listed = { ...a, trash: [a.files[0].blob, crypto.randomUUID()] };
  assert.deepEqual(mergeVaults(listed, b).trash, [listed.trash[1]]);
});

test('a folder vault moved or deleted outside Secure Box says so, and is never quietly made again', async () => {
  const home = new MemDir('Home');
  const documents = await home.getDirectoryHandle('Documents', { create: true });
  await folderVault(documents);
  assert.equal(await vaultIn(documents), deviceKid, 'a folder holding a vault is recognised');
  assert.equal(await vaultIn(new MemDir('Empty')), null);

  // Its "Secure Box" folder deleted by hand: the chosen folder is still there, the vault isn't.
  await documents.removeEntry('Secure Box', { recursive: true });
  const known = inFolder(documents);
  await assert.rejects(known.load(), { code: 'gone', message: /isn’t in “Documents” any more/ });
  await assert.rejects(known.saveKeyring('{}'), { code: 'gone' });
  assert.equal(documents.children.size, 0, 'no new, empty vault appeared in its place');

  // The chosen folder itself deleted by hand.
  await home.removeEntry('Documents', { recursive: true });
  await assert.rejects(inFolder(documents).load(), { code: 'gone', message: /“Documents” that held your vault .* isn’t there any more/ });

  // A newly chosen folder (no key id yet) is a new vault, not a missing one.
  assert.deepEqual(await createLocalBackend({ where: 'folder', handle: new MemDir('New') }).load(), { keyring: null, vault: null });
});

test('deleting the vault on this device removes only its own files, and its folder once empty', async () => {
  const documents = new MemDir('Documents');
  await (await folderVault(documents)).removeAll();
  assert.equal(documents.children.size, 0, 'its "Secure Box" folder went too');

  const photos = new MemDir('Photos');
  const vault = await folderVault(photos);
  await writeText(await photos.getDirectoryHandle('Secure Box'), 'notes.txt', 'put here by hand');
  await vault.removeAll();
  assert.deepEqual(Object.keys(snapshot(photos)), ['Secure Box/notes.txt'], 'what someone else put there stays');
});

test('a vault is the same in every place: one format and key, and files named, never a place’s own ids', async () => {
  const name = crypto.randomUUID();
  const file = makeFileEntry({ name: 'a.txt', type: 'text/plain', size: 3, folder: null, blob: name, driveId: 'GOOGLE-ID', key: 'A'.repeat(43), chunk: CHUNK_SIZE });
  assert.equal(file.blob, name);
  assert.ok(!('driveId' in file), 'a place’s own file id is never kept');
  const vault = applyChange(emptyVault(), { op: 'batch', changes: [{ op: 'file-put', file }, { op: 'trash-add', names: [crypto.randomUUID()] }] });
  // What any place seals, any other opens: there's one format and one key for the vault.
  const sealed = await (await VaultCipher.create(masterA)).seal(vault);
  assert.equal(JSON.parse(sealed).format, 'secure-box-vault');
  assert.equal(JSON.parse(sealed).version, 3);
  assert.deepEqual(await (await VaultCipher.create(masterA)).open(parseEnvelope(sealed)), vault);
  // Entries without a stored name (or with one that isn't a random id) aren't files of the vault.
  const reopened = await (await VaultCipher.create(masterA)).open(parseEnvelope(await (await VaultCipher.create(masterA)).seal({ ...vault, files: [{ ...file, blob: undefined }, { ...file, id: 'x', blob: '../../key ring' }] })));
  assert.deepEqual(reopened.files, []);
  // Vaults from earlier builds are refused plainly, not half read.
  assert.throws(() => parseEnvelope(JSON.stringify({ ...JSON.parse(sealed), format: 'secure-box-local-index' })), { code: 'other-version' });
  assert.throws(() => parseEnvelope(JSON.stringify({ ...JSON.parse(sealed), version: 2 })), { code: 'other-version', message: /another version of Secure Box/ });
  assert.throws(() => parseEnvelope(JSON.stringify({ ...JSON.parse(sealed), version: 4 })), { code: 'bad-vault', message: /newer version/ });
  assert.throws(() => parseEnvelope(JSON.stringify({ ...JSON.parse(sealed), format: 'something-else' })), { code: 'bad-vault' });
});

/** A ZIP whose entries are deflated, as Google Drive and OneDrive pack the downloads of a folder. */
function zipDeflated(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const bytes = Buffer.from(typeof data === 'string' ? Buffer.from(data) : data);
    const packed = deflateRawSync(bytes);
    const path = Buffer.from(name);
    const crc = zlibCrc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    parts.push(local, path, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(path.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, path);
    offset += 30 + path.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Blob([...parts, directory, end]);
}

test('a vault’s folder downloaded from a cloud’s website restores like a backup, in one ZIP or several', async () => {
  const keyringText = serializeKeyring((await createKeyring('download test password', { kid: masterA.kid, key: masterA.key })).doc);
  const vaultText = await (await VaultCipher.create(masterA)).seal(emptyVault());
  const copies = [0, 1, 2].map((i) => ({ name: crypto.randomUUID(), data: random(3000 + i * 1000) }));
  const at = (prefix) => [
    { name: `${prefix}Secure Box Key Ring.json`, data: keyringText },
    { name: `${prefix}Secure Box Vault.json`, data: vaultText },
    ...copies.map((c) => ({ name: `${prefix}Encrypted files/${c.name}`, data: c.data })),
  ];
  const file = (blob, name) => new File([blob], name);

  // Google Drive: the folder itself, deflated.
  const download = await readBackup(file(zipDeflated(at('Secure Box/')), 'Secure Box-20261122T101530Z-001.zip'));
  assert.equal(download.from, 'download');
  assert.equal(download.manifest.kid, masterA.kid);
  assert.equal(download.keyring, keyringText);
  assert.equal(download.vault, vaultText);
  assert.deepEqual(download.names().sort(), copies.map((c) => c.name).sort());

  // ...restored into a vault on this device, byte for byte (unpacked on the way).
  const target = inFolder(new MemDir('Restored'));
  await target.create({ keyringText: download.keyring, vaultText: download.vault, kid: masterA.kid });
  for (const name of download.names()) assert.equal(await target.restoreBlob(download, name), true);
  for (const c of copies) assert.ok(Buffer.from(await target.readBytes(c.name, 0, c.data.length - 1)).equals(Buffer.from(c.data)), 'the same bytes');

  // Split over several ZIP files, as Google Drive does with big folders: all of them together.
  const all = at('Secure Box/');
  const first = file(zipDeflated(all.slice(0, 3)), 'part-001.zip');
  const second = file(zipStore(all.slice(3)), 'part-002.zip');
  assert.deepEqual((await readBackup([first, second])).names().sort(), copies.map((c) => c.name).sort());
  // Only a part without the key ring: says what to do.
  await assert.rejects(readBackup([second]), { code: 'no-keyring', message: /choose all of them/ });
  // The key ring without the vault.
  await assert.rejects(readBackup(file(zipDeflated(all.filter((e) => !e.name.endsWith('Vault.json'))), 'x.zip')), { code: 'no-vault' });

  // OneDrive, or a folder's contents chosen one by one: everything at the top of the ZIP.
  assert.deepEqual((await readBackup(file(zipStore(at('')), 'OneDrive.zip'))).names().length, 3);

  // A vault an earlier version made, a key ring of another vault, and anything else: each says so.
  const older = JSON.stringify({ ...JSON.parse(vaultText), version: 2 });
  await assert.rejects(readBackup(file(zipDeflated(at('Secure Box/').map((e) => (e.name.endsWith('Vault.json') ? { ...e, data: older } : e))), 'old.zip')), {
    code: 'other-version',
    message: /That vault was made by another version/,
  });
  const otherRing = serializeKeyring((await createKeyring('another test password')).doc);
  await assert.rejects(readBackup(file(zipDeflated(at('').map((e) => (e.name.endsWith('Ring.json') ? { ...e, data: otherRing } : e))), 'mixed.zip')), { code: 'mismatch' });
  await assert.rejects(readBackup(file(zipDeflated([{ name: 'holiday.jpg', data: 'not a vault' }]), 'photos.zip')), { code: 'not-backup' });
  await assert.rejects(readBackup([file(new Blob(['not a zip at all']), 'notes.txt'), first]), { code: 'not-backup', message: /“notes\.txt”/ });

  // Copies listed where they are (the vault not open to say what's in them) copy by their size.
  const onward = createLocalBackend({ where: 'folder', handle: new MemDir('Onward') });
  await onward.load();
  const listed = await target.listBlobs();
  const result = await copyFiles({ from: target, to: onward, files: [...listed].map(([blob, { size }]) => ({ blob, name: blob, bytes: size })) });
  assert.deepEqual([result.copied, result.kept, result.missing.length], [3, 0, 0]);
  assert.deepEqual(new Map([...(await onward.listBlobs())].sort()), new Map([...listed].sort()));
});

test('a backup holds the vault exactly as stored, and restores it elsewhere byte for byte', async () => {
  const documents = new MemDir('Documents');
  const source = await folderVault(documents, 2);
  const names = [...(await source.listBlobs()).keys()];
  const { blob, missing } = await source.backup(names.map((name) => ({ blob: name })));
  assert.deepEqual(missing, []);
  // Packed elsewhere (in a worker, in the app), or here when that can't be done: the same ZIP.
  let packedThere = 0;
  const there = await source.backup(names.map((name) => ({ blob: name })), { pack: async (items, options) => (packedThere++, zipFolder(items, options)) });
  const fallback = await source.backup(names.map((name) => ({ blob: name })), { pack: async () => Promise.reject(new Error('no workers here')) });
  assert.equal(packedThere, 1);
  assert.deepEqual((await readBackup(new File([there.blob], 'a.zip'))).names().sort(), [...names].sort());
  assert.deepEqual((await readBackup(new File([fallback.blob], 'b.zip'))).names().sort(), [...names].sort());
  const backup = await readBackup(new File([blob], 'backup.zip'));
  assert.equal(backup.manifest.format, 'secure-box-backup');
  assert.deepEqual(backup.names().sort(), [...names].sort());

  const elsewhere = new MemDir('Elsewhere');
  const target = inFolder(elsewhere);
  await target.create({ keyringText: backup.keyring, vaultText: backup.vault, kid: deviceKid });
  for (const name of backup.names()) assert.equal(await target.restoreBlob(backup, name), true);
  assert.equal(await target.restoreBlob(backup, crypto.randomUUID()), false, 'a copy the backup lacks');
  const own = (dir) => snapshot(dir.children.get('Secure Box'));
  assert.deepEqual(own(elsewhere), own(documents), 'key ring, vault and every copy, the same bytes under the same names');
});

test('encrypted copies deleted outside Secure Box are found missing on this device, left out of backups, and put back from one', async () => {
  const documents = new MemDir('Documents');
  const vault = await folderVault(documents, 3);
  const names = [...(await vault.listBlobs()).keys()];
  const entries = names.map((name, i) => ({ id: `f${i}`, name: `File ${i}.jpg`, blob: name }));
  const { blob: whole } = await vault.backup(entries);
  assert.deepEqual(await vault.absent(names), []);
  assert.deepEqual(await vault.absent([...names, ...names].slice(0, 9)), [], 'many names: one listing');

  // One copy deleted by hand, in the vault's "Encrypted files" folder.
  const files = documents.children.get('Secure Box').children.get('Encrypted files');
  await files.removeEntry(names[1]);
  assert.deepEqual(await vault.absent(names), [names[1]]);
  assert.deepEqual(await vault.absent([...names, ...names, ...names]), [names[1], names[1], names[1]], 'many names: one listing');
  await assert.rejects(vault.readBytes(names[1], 0, 9), { code: 'not-found' });
  // The vault itself is still there, so this is no "vault gone".
  const { missing } = await vault.backup(entries);
  assert.deepEqual(missing.map((e) => e.name), ['File 1.jpg'], 'a backup says what it couldn’t hold');

  // A backup from before has that very copy: it goes back, byte for byte.
  const backup = await readBackup(new File([whole], 'backup.zip'));
  assert.equal(await vault.restoreBlob(backup, names[1]), true);
  assert.deepEqual(await vault.absent(names), []);

  // The whole folder of encrypted copies deleted: every copy is missing, and the vault stays.
  await documents.children.get('Secure Box').removeEntry('Encrypted files', { recursive: true });
  assert.deepEqual(await vault.absent(names), names);
  assert.deepEqual(await vault.absent([...names, ...names, ...names]).then((n) => n.length), 9);
  assert.ok((await vault.load()).vault, 'the vault itself is still there');
});

test('a change made from an out-of-date view applies to things as they are now', () => {
  const [b1, b2, b3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const docs = makeFolder({ name: 'Docs' });
  const notes = makeFileEntry({ name: 'Notes.txt', type: 'text/plain', size: 10, folder: docs.id, blob: b1, key: 'A'.repeat(43), chunk: CHUNK_SIZE });
  const start = applyChange(emptyVault(), { op: 'batch', changes: [{ op: 'folder-put', folder: docs }, { op: 'file-put', file: notes }] });
  const rename = { op: 'file-update', id: notes.id, fields: { name: 'Renamed.txt' } };

  // Deleted on another device, then renamed or moved here: it stays deleted.
  const deleted = applyChange(start, { op: 'batch', changes: [{ op: 'remove', files: [notes.id] }, { op: 'trash-add', names: [b1] }] });
  assert.deepEqual(applyChange(deleted, rename).files, []);
  assert.deepEqual(applyChange(deleted, { op: 'file-update', id: notes.id, fields: { folder: null } }).files, []);

  // Edited on another device (a new copy), renamed here: the rename lands on the edit.
  const edited = applyChange(start, { op: 'batch', changes: [{ op: 'file-update', id: notes.id, fields: { blob: b2, key: 'B'.repeat(43), size: 20 } }, { op: 'trash-add', names: [b1] }] });
  const both = applyChange(edited, rename).files[0];
  assert.deepEqual([both.name, both.blob, both.size], ['Renamed.txt', b2, 20]);

  // A saved edit never replaces one saved elsewhere meanwhile; over a file deleted meanwhile, it comes back.
  const mine = { op: 'file-update', id: notes.id, ifBlob: b1, fields: { blob: b3 }, orAdd: { ...notes, blob: b3 } };
  assert.equal(applyChange(edited, mine).files[0].blob, b2);
  assert.equal(applyChange(deleted, mine).files[0].blob, b3);
  assert.ok(!applyChange(deleted, mine).trash.includes(b3));

  // Names stay apart from what's there now; a move into a folder deleted meanwhile goes to the top.
  const crowded = applyChange(start, { op: 'file-put', file: makeFileEntry({ name: 'Renamed.txt', folder: docs.id, blob: b2, key: 'B'.repeat(43), size: 1, chunk: CHUNK_SIZE }) });
  assert.equal(applyChange(crowded, rename).files.find((f) => f.id === notes.id).name, 'Renamed (2).txt');
  const noDocs = applyChange(start, { op: 'remove', folders: [docs.id] });
  assert.equal(applyChange(noDocs, { op: 'file-update', id: notes.id, fields: { folder: docs.id } }).files[0].folder, null);

  // A folder moved into one of its own folders (after a move elsewhere meanwhile) stays put.
  const inner = makeFolder({ name: 'Inner', parent: docs.id });
  const nested = applyChange(start, { op: 'folder-put', folder: inner });
  assert.equal(applyChange(nested, { op: 'folder-update', id: docs.id, fields: { parent: inner.id } }).folders.find((f) => f.id === docs.id).parent, null);
  assert.equal(applyChange(nested, { op: 'folder-update', id: inner.id, fields: { name: 'Docs 2' } }).folders.find((f) => f.id === inner.id).name, 'Docs 2');
});

test('a password edit sends only what changed, so edits to other fields elsewhere stay', () => {
  const login = makeItem({ type: 'login', title: 'Bank', username: 'jane', password: 'old secret', url: 'https://bank.example' });
  const start = applyChange(emptyVault(), { op: 'put', item: login });
  // The phone changed the password; this window, behind, changes the notes.
  const phone = applyChange(start, { op: 'item-update', item: makeItem({ ...login, password: 'new secret' }, login), fields: { password: 'new secret' } });
  const here = makeItem({ ...login, notes: 'Branch: Main St.' }, login);
  const merged = applyChange(phone, { op: 'item-update', item: here, fields: { notes: 'Branch: Main St.' } }).items[0];
  assert.deepEqual([merged.password, merged.notes], ['new secret', 'Branch: Main St.']);
  // Deleted elsewhere meanwhile: the edit brings it back, so nothing typed is lost.
  assert.deepEqual(applyChange(applyChange(start, { op: 'delete', id: login.id }), { op: 'item-update', item: here, fields: { notes: here.notes } }).items, [here]);
});

test('the list of copies to delete never holds one a file uses', () => {
  const name = crypto.randomUUID();
  const file = makeFileEntry({ name: 'a.pdf', type: 'application/pdf', size: 1, folder: null, blob: name, key: 'A'.repeat(43), chunk: CHUNK_SIZE });
  const live = applyChange(emptyVault(), { op: 'file-put', file });
  assert.deepEqual(applyChange(live, { op: 'trash-add', names: [name] }).trash, [], 'a copy in use isn’t listed');
  // Deleted (its copy listed), then restored from a backup before the copy went: it comes off the list.
  const listed = applyChange(live, { op: 'batch', changes: [{ op: 'remove', files: [file.id] }, { op: 'trash-add', names: [name] }] });
  assert.deepEqual(listed.trash, [name]);
  const restored = applyChange(listed, { op: 'file-put', file });
  assert.deepEqual(restored.trash, []);
  assert.ok(copiesInUse(restored).has(name));
});

test('files that are Secure Box’s own are never taken for files put in by hand', async () => {
  const picked = new MemDir('Documents');
  await folderVault(picked, 0);
  const own = picked.children.get('Secure Box');
  const encrypted = new Uint8Array(64);
  encrypted.set(new TextEncoder().encode('SECBOXF1'));
  await writeText(own, 'notes.txt', 'put here by hand');
  await writeText(own, 'Secure Box Vault (1).json', '{"format":"secure-box-vault"}'); // a sync service's copy
  await writeText(own, 'Secure Box Key Ring-LAPTOP.json', '{}');
  await writeText(own, crypto.randomUUID(), encrypted); // an encrypted copy moved out of its folder
  await writeText(own, 'renamed.bin', encrypted); // and one renamed
  await writeText(await own.getDirectoryHandle('Scans', { create: true }), 'receipt.pdf', 'also by hand');
  const strays = await inFolder(picked).strays();
  assert.deepEqual(strays.map((s) => [...s.path, s.name].join('/')).sort(), ['Scans/receipt.pdf', 'notes.txt']);
});

test('two saves to the vault on this device are told apart, however coarse the disk’s clock', async () => {
  // FAT32 keeps 2-second times, and vault sizes are padded: two saves can match in both.
  const usb = new MemDir('USB', { clock: 1_700_000_000_000 });
  const sealed = (salt) => JSON.stringify({ format: 'secure-box-vault', version: 3, kid: deviceKid, salt, iv: 'iv', ct: 'x'.repeat(64) });
  const one = inFolder(usb);
  await one.create({ keyringText: JSON.stringify({ format: 'secure-box-keyring', kid: deviceKid }), vaultText: sealed('salt-one'), kid: deviceKid });
  const two = inFolder(usb);
  const seen = (await two.load()).vault.rev;
  await one.writeVault(sealed('salt-two'), await one.vaultRevision()); // the same size, at the same time
  await assert.rejects(two.writeVault(sealed('salt-xyz'), seen), { code: 'conflict' });
  assert.equal(String(seen).split(':')[0], '1700000000000', 'it still starts with when it was saved');
});

test('the vault on this device stores and finds encrypted copies by their names', async () => {
  const backend = await folderVault(new MemDir('Documents'), 0);
  const name = crypto.randomUUID();
  const bytes = random(5000);
  assert.equal(await (await backend.openUpload({ name }))(bytes, 0, bytes.length), name);
  assert.deepEqual([...(await backend.listBlobs())], [[name, { size: 5000 }]]);
  assert.deepEqual(new Uint8Array(await backend.readBytes(name, 10, 19)), bytes.slice(10, 20));
  await backend.trash(name);
  await backend.trash(name); // gone already counts as deleted
  assert.equal((await backend.listBlobs()).size, 0);
  await assert.rejects(backend.openUpload({ name: '../Secure Box Key Ring.json' }), /Not a file of this device/);
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

/** Runs `body` with a fake fetch answering from `routes` ([url part, handler], first match wins), recording each call. */
async function withFakeFetch(routes, body) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({ url, headers, method: init.method || 'GET', body: init.body });
    const route = routes.find(([part]) => url.includes(part));
    if (!route) throw new TypeError('Failed to fetch'); // how a blocked or unreachable request looks
    return route[1](headers, url);
  };
  console.warn = () => {};
  try {
    await body(calls);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}
const graphFailure = (status) => new Response(JSON.stringify({ error: { code: 'x', message: `status ${status}` } }), { status });
const jsonReply = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const bytesReply = (headers, data) => {
  const range = /bytes=(d+)-(d+)/.exec(headers.Range || '');
  return range ? new Response(data.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(data);
};
const bodyText = async (res) => new TextDecoder().decode(await res.arrayBuffer());

test('OneDrive reads go straight to Graph with the token, ranges included', async () => {
  const data = new TextEncoder().encode('0123456789');
  await withFakeFetch([['/beta/me/drive/items/F1/contentStream', (h) => bytesReply(h, data)]], async (calls) => {
    const od = new OneDrive(() => 'token-1');
    assert.equal(await od.readText('F1'), '0123456789');
    assert.equal(await bodyText(await od.readRange('F1', 2, 5)), '2345');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer token-1'));
    assert.equal(calls[1].headers.Range, 'bytes=2-5');
    assert.equal(od.way, 'stream');
  });
});

test('OneDrive reads fall back to the download link (sent without the token), then to /content, and remember what works', async () => {
  const data = new TextEncoder().encode('secret bytes');
  const link = 'https://public.example.1drv.com/F2';
  await withFakeFetch(
    [
      ['/contentStream', () => graphFailure(400)],
      ['/v1.0/me/drive/items/F2', () => jsonReply({ id: 'F2', '@microsoft.graph.downloadUrl': link })],
      [link, (h) => bytesReply(h, data)],
    ],
    async (calls) => {
      const od = new OneDrive(() => 'token-2');
      assert.equal(await od.readText('F2'), 'secret bytes');
      assert.equal(od.way, 'link');
      assert.ok(!calls.some((c) => c.url.includes('$select')), 'the whole item is asked for: a selected one often lacks the link');
      assert.deepEqual(calls.filter((c) => c.url === link).map((c) => c.headers.Authorization), [undefined]);
      calls.length = 0;
      assert.equal(await bodyText(await od.readRange('F2', 0, 5)), 'secret');
      assert.deepEqual(calls.map((c) => c.url), [link]); // the remembered way first, and its link reused
    },
  );
  await withFakeFetch(
    [
      ['/contentStream', () => graphFailure(404)],
      ['/v1.0/me/drive/items/F3/content', (h) => bytesReply(h, data)],
      ['/v1.0/me/drive/items/F3', () => jsonReply({ id: 'F3' })], // no link offered
    ],
    async () => {
      const od = new OneDrive(() => 'token-3');
      assert.equal(await od.readText('F3'), 'secret bytes');
      assert.equal(od.way, 'redirect');
    },
  );
});

test('OneDrive reads: an expired sign-in stops at once, and a browser that can’t ask for a range reads whole files', async () => {
  await withFakeFetch([['/contentStream', () => graphFailure(401)]], async (calls) => {
    await assert.rejects(new OneDrive(() => 'old').readText('F4'), (err) => err.code === 'expired');
    assert.equal(calls.length, 1);
  });
  const data = new TextEncoder().encode('abcdefgh');
  const noRanges = (h) => {
    if (h.Range) throw new TypeError('Failed to fetch');
    return new Response(data);
  };
  await withFakeFetch([['/contentStream', noRanges]], async () => {
    const od = new OneDrive(() => 'token-5');
    assert.equal(await bodyText(await od.readRange('F5', 2, 4)), 'cde');
    assert.equal(od.wholeOnly, true);
    assert.equal(await bodyText(await od.readRange('F5', 6, 7)), 'gh');
  });
  // A download link OneDrive refuses, even fresh, moves on to /content: it doesn't ask to sign in again.
  const refused = 'https://public.example.1drv.com/F6';
  await withFakeFetch(
    [
      ['/contentStream', () => graphFailure(400)],
      [refused, () => graphFailure(403)],
      ['/v1.0/me/drive/items/F6/content', (h) => bytesReply(h, data)],
      ['/v1.0/me/drive/items/F6', () => jsonReply({ id: 'F6', '@microsoft.graph.downloadUrl': refused })],
    ],
    async (calls) => {
      const od = new OneDrive(() => 'token-6');
      assert.equal(await od.readText('F6'), 'abcdefgh');
      assert.equal(od.way, 'redirect');
      assert.equal(calls.filter((c) => c.url === refused).length, 2);
    },
  );
});

test('OneDrive folders are found or made safely: by the folder id, never replaced, and one made meanwhile is found', async () => {
  let made = false;
  await withFakeFetch(
    [
      ['/special/approot/children?', () => jsonReply({ value: made ? [{ id: 'D1', name: 'Encrypted files', folder: {} }] : [] })],
      ['/me/drive/special/approot', () => jsonReply({ id: 'ROOT!1', name: 'Secure Box', folder: {} })],
      [
        '/me/drive/items/ROOT!1/children',
        () => {
          made = true; // another device got there first
          return graphFailure(409);
        },
      ],
    ],
    async (calls) => {
      assert.equal(await new OneDrive(() => 't').folder('Encrypted files'), 'D1');
      const post = calls.find((c) => c.method === 'POST');
      assert.ok(post.url.endsWith('/me/drive/items/ROOT!1/children'), 'made inside the folder id, not the approot alias');
      assert.deepEqual(JSON.parse(post.body), { name: 'Encrypted files', folder: {} }); // no 'replace', ever
    },
  );
  await withFakeFetch(
    [
      ['/special/approot/children?', () => jsonReply({ value: [{ id: 'F', name: 'Encrypted files', file: {} }] })], // a file, not a folder
      ['/me/drive/special/approot', () => jsonReply({ id: 'ROOT!1' })],
      ['/me/drive/items/ROOT!1/children', () => jsonReply({ id: 'D2', name: 'Encrypted files 1', folder: {} })],
    ],
    async () => assert.equal(await new OneDrive(() => 't').folder('Encrypted files'), 'D2'),
  );
});

test('OneDrive: if making the files folder is refused, the first upload goes in by the folder name', async () => {
  const link = 'https://my.microsoftpersonalcontent.com/personal/abc/_api/v2.0/uploadSession?guid=2&tempauth=K';
  await withFakeFetch(
    [
      ['/special/approot/children?', () => jsonReply({ value: [] })],
      ['/special/approot:/Encrypted%20files/0f8fad5b-d9cb-469f-a165-70867728950e:/createUploadSession', () => jsonReply({ uploadUrl: link })],
      ['/me/drive/special/approot', () => jsonReply({ id: 'ROOT!1' })],
      ['/me/drive/items/ROOT!1/children', () => new Response(JSON.stringify({ error: { code: 'invalidRequest', message: 'Invalid request' } }), { status: 400 })],
      [link, () => jsonReply({ id: 'NEW' })],
    ],
    async (calls) => {
      const backend = createOneDriveBackend({ accessToken: 't' });
      const send = await backend.openUpload({ name: '0f8fad5b-d9cb-469f-a165-70867728950e', size: 4 });
      assert.equal(await send(new Uint8Array(4), 0, 4), 'NEW');
      const session = calls.find((c) => c.url.includes('createUploadSession'));
      assert.deepEqual(JSON.parse(session.body), { item: { '@microsoft.graph.conflictBehavior': 'fail', name: '0f8fad5b-d9cb-469f-a165-70867728950e' } });
    },
  );
});

test('OneDrive uploads: the session names the file, pieces go without the token, and errors say which request failed', async () => {
  const link = 'https://my.microsoftpersonalcontent.com/personal/abc/_api/v2.0/uploadSession?guid=1&tempauth=SECRET';
  await withFakeFetch(
    [
      [':/createUploadSession', () => jsonReply({ uploadUrl: link })],
      [link, (h) => (h['Content-Range'] === 'bytes 10-19/20' ? jsonReply({ id: 'NEW' }) : new Response('{}', { status: 202 }))],
    ],
    async (calls) => {
      const send = await new OneDrive(() => 't').startUpload({ parentId: 'P!1', name: 'file-id' });
      assert.equal(await send(new Uint8Array(10), 0, 20), null);
      assert.equal(await send(new Uint8Array(10), 10, 20), 'NEW');
      const session = calls.find((c) => c.url.includes('createUploadSession'));
      assert.deepEqual(JSON.parse(session.body), { item: { '@microsoft.graph.conflictBehavior': 'fail', name: 'file-id' } });
      const pieces = calls.filter((c) => c.url === link);
      assert.deepEqual(pieces.map((c) => c.headers['Content-Range']), ['bytes 0-9/20', 'bytes 10-19/20']);
      assert.ok(pieces.every((c) => !c.headers.Authorization));
    },
  );
  const invalid = () => new Response(JSON.stringify({ error: { code: 'invalidRequest', message: 'Invalid request' } }), { status: 400 });
  await withFakeFetch([[':/createUploadSession', invalid]], async () => {
    await assert.rejects(new OneDrive(() => 't').startUpload({ parentId: 'P!1', name: 'f' }), {
      message: 'Invalid request (OneDrive: POST createUploadSession, 400 invalidRequest)',
    });
  });
  await withFakeFetch(
    [
      ['_api/v2.0/uploadSession', invalid],
      [':/createUploadSession', () => jsonReply({ uploadUrl: link })],
    ],
    async () => {
      const send = await new OneDrive(() => 't').startUpload({ parentId: 'P!1', name: 'f' });
      // Only the host: the link's key never shows up in a message.
      await assert.rejects(send(new Uint8Array(4), 0, 4), { message: 'Invalid request (OneDrive: PUT my.microsoftpersonalcontent.com, 400 invalidRequest)' });
    },
  );
});

test('OneDrive streaming addresses: the download address first (via /content when not listed), then contentStream with the token', async () => {
  const stream = (id) => ({ url: `https://graph.microsoft.com/beta/me/drive/items/${id}/contentStream`, token: 'tok' });
  await withFakeFetch([['/v1.0/me/drive/items/S1', () => jsonReply({ id: 'S1', '@microsoft.graph.downloadUrl': 'https://dl.example.1drv.com/S1' })]], async () => {
    assert.deepEqual(await new OneDrive(() => 'tok').streamSources('S1'), [{ url: 'https://dl.example.1drv.com/S1' }, stream('S1')]);
  });
  const final = 'https://my.microsoftpersonalcontent.com/personal/x/_layouts/15/download.aspx?UniqueId=1&tempauth=T';
  await withFakeFetch(
    [
      ['/v1.0/me/drive/items/S2/content', () => ({ ok: true, status: 206, url: final, headers: new Headers(), body: { cancel: async () => {} } })],
      ['/v1.0/me/drive/items/S2', () => jsonReply({ id: 'S2' })], // no link listed
    ],
    async (calls) => {
      const od = new OneDrive(() => 'tok');
      assert.deepEqual(await od.streamSources('S2'), [{ url: final }, stream('S2')]);
      assert.equal(calls.find((c) => c.url.endsWith('/content')).headers.Range, 'bytes=0-0'); // one byte, not the file
      calls.length = 0;
      assert.equal((await od.streamSources('S2'))[0].url, final);
      assert.equal(calls.length, 0, 'the address is kept for a while');
      assert.equal((await od.streamSources('S2', { fresh: true }))[0].url, final);
      assert.ok(calls.length > 0, 'fresh asks OneDrive again');
    },
  );
  // No link, and /content can't be followed (the fake fetch throws for it, as a blocked redirect does).
  await withFakeFetch([['/v1.0/me/drive/items/S3', (h, url) => (url.endsWith('/content') ? Promise.reject(new TypeError('Failed to fetch')) : jsonReply({ id: 'S3' }))]], async () => {
    assert.deepEqual(await new OneDrive(() => 'tok').streamSources('S3'), [stream('S3')]);
  });
});

test('OneDrive pieces: when OneDrive sends the whole file instead of a range, it is fetched once, not for every piece', async () => {
  const data = new TextEncoder().encode('0123456789abcdef');
  await withFakeFetch([['/contentStream', () => new Response(data)]], async (calls) => {
    const od = new OneDrive(() => 't');
    assert.equal(await bodyText(await od.readRange('W1', 0, 3)), '0123');
    assert.equal(await bodyText(await od.readRange('W1', 4, 7)), '4567');
    assert.equal(await bodyText(await od.readRange('W1', 12, 15)), 'cdef');
    assert.equal(calls.length, 1);
  });
});

