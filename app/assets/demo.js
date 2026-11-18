/**
 * In-memory stand-in for Google Drive, used when the page is opened with ?demo.
 * It runs the real encryption code end to end; nothing ever leaves this browser tab.
 */
import { generatePassword } from './crypto.js';
import { createPieceWriter, encryptFile, layout } from './fileformat.js';
import { canThumbnail, guessType } from './filetypes.js';
import { createKeyring, serializeKeyring } from './keyring.js';
import { makeThumbnail } from './thumbs.js';
import { VaultCipher, applyChange, emptyVault, makeFileEntry, makeFolder, makeItem } from './vault.js';
import { zipStore } from './zip.js';

export const DEMO_PASSWORD = 'secure box demo vault';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = (text) => new TextEncoder().encode(text);

const ITEMS = [
  { type: 'login', title: 'GitHub', username: 'jane@example.com', url: 'https://github.com', notes: 'Recovery codes are in the “GitHub recovery codes” note.' },
  { type: 'login', title: 'AWS root account', username: 'admin@example.com', url: 'https://console.aws.amazon.com', notes: 'MFA: hardware key in the desk drawer.' },
  { type: 'login', title: 'Gmail', username: 'jane.doe@example.com', url: 'https://mail.google.com' },
  { type: 'login', title: 'Northwind Bank', username: 'jdoe-1987', url: 'https://bank.example.com', notes: 'Security question (first pet): Biscuit' },
  { type: 'login', title: 'Netflix', username: 'jane.doe@example.com', url: 'https://www.netflix.com' },
  { type: 'note', title: 'Home Wi-Fi', notes: 'Network: Lighthouse-5G\nPassword: tidal-amber-quiet-lantern' },
  { type: 'note', title: 'GitHub recovery codes', notes: '4f2a1-9c3be\n7d0e2-b18c4\n0a9f3-6e2d1\nc51b7-3f8a0' },
  { type: 'note', title: 'Passport', notes: 'Number: X1234567\nIssued: 2021-04-30\nExpires: 2031-04-29' },
];

// ---------------------------------------------------------------------------
// Sample documents, generated on the fly
// ---------------------------------------------------------------------------
const WELCOME = `# Welcome to Secure Box Files

Everything here was **encrypted in your browser** before it reached Google Drive.

- Every file has its own random 256-bit key, kept inside your encrypted vault
- File names and folders never leave the vault — Drive only sees random ids
- Videos, audio and PDFs are decrypted *while they stream*; nothing is saved to disk

| Format | Built-in viewer |
|---|---|
| Photos | Zoom, rotate, slideshow |
| Video & audio | Players with seeking |
| PDF, Word, Excel, PowerPoint | Readers |

> Tip: drag files or whole folders onto this window to upload them.
`;

function docx() {
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const li = (text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
  const body = [
    p('Rental agreement', 'Title'),
    `<w:p><w:r><w:t xml:space="preserve">This agreement is made between </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Jane Doe</w:t></w:r><w:r><w:t xml:space="preserve"> (tenant) and </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Northwind Homes</w:t></w:r><w:r><w:t xml:space="preserve"> (landlord), effective </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>1 March 2026</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>`,
    p('Terms', 'Heading1'),
    li('Monthly rent: 1,850 EUR, due on the 1st'),
    li('Deposit: two months of rent'),
    li('Notice period: three months'),
    p('Payment schedule', 'Heading2'),
    `<w:tbl>${row('Month', 'Amount', 'Status')}${row('March', '1,850 EUR', 'Paid')}${row('April', '1,850 EUR', 'Paid')}${row('May', '1,850 EUR', 'Due')}</w:tbl>`,
    p('Signed electronically by both parties.'),
  ].join('');
  return zipStore([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ]);
}

function xlsx() {
  const rows = [['Category', 'January', 'February', 'March'], ['Rent', 1850, 1850, 1850], ['Groceries', 412.5, 389.9, 455.2], ['Transport', 96, 120, 88], ['Utilities', 140, 152, 131]];
  const cell = (v, r, c) => {
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  };
  const sheet = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c)).join('')}</row>`).join('');
  return zipStore([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Expenses" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>` },
  ]);
}

function pdf() {
  const content = 'BT /F1 26 Tf 72 760 Td (Secure Box demo document) Tj ET\nBT /F1 13 Tf 72 726 Td (This PDF is stored encrypted and decrypted while it streams into the viewer.) Tj ET\nBT /F1 13 Tf 72 706 Td (Nothing is written to disk.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((obj, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

function wav() {
  const rate = 22050;
  const samples = Math.floor(rate * 1.6);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buffer);
  const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const note = t < 0.5 ? 523.25 : t < 1 ? 659.25 : 783.99;
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * note * t) * Math.exp(-3 * (t % 0.5)) * 9000, true);
  }
  return new Uint8Array(buffer);
}

function paint(ctx, w, h, t = 0) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#2a2580');
  sky.addColorStop(0.55, '#c2477a');
  sky.addColorStop(1, '#f6a65a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffe3a3';
  ctx.beginPath();
  ctx.arc(w * 0.5, h * (0.62 - 0.05 * Math.sin(t * 3)), h * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b1b3a';
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += w / 8) ctx.lineTo(x, h * (0.72 + 0.06 * Math.sin(x / 90 + t)));
  ctx.lineTo(w, h);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = `600 ${Math.round(h / 12)}px system-ui, sans-serif`;
  ctx.fillText('Secure Box', w * 0.06, h * 0.14);
}

async function png() {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
  paint(canvas.getContext('2d'), 1280, 800);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function webm() {
  if (typeof MediaRecorder !== 'function') return null;
  const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(24);
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return null;
  const recorder = new MediaRecorder(stream, { mimeType: type });
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const started = performance.now();
  const timer = setInterval(() => paint(ctx, 640, 360, (performance.now() - started) / 1000), 40);
  recorder.start(250);
  await pause(2000);
  recorder.stop();
  await new Promise((resolve) => (recorder.onstop = resolve));
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

async function sampleFiles() {
  const [image, video] = await Promise.all([png(), Promise.race([webm().catch(() => null), pause(6000).then(() => null)])]);
  return [
    { path: [], name: 'Welcome to Secure Box Files.md', bytes: enc(WELCOME) },
    { path: ['Documents'], name: 'Rental agreement.docx', bytes: docx() },
    { path: ['Documents'], name: 'Secure Box guide.pdf', bytes: pdf() },
    { path: ['Documents'], name: 'Notes.txt', bytes: enc('Spare key: with the neighbour at no. 12.\nBike lock: 4 8 1 5\n') },
    { path: ['Finance', '2026'], name: 'Budget 2026.csv', bytes: enc('Month,Income,Spending,Saved\nJanuary,5200,3910,1290\nFebruary,5200,4105,1095\nMarch,5350,3820,1530\n') },
    { path: ['Finance', '2026'], name: 'Expenses.xlsx', bytes: xlsx() },
    { path: ['Photos & media'], name: 'Sunset.png', bytes: image },
    { path: ['Photos & media'], name: 'Chime.wav', bytes: wav() },
    video && { path: ['Photos & media'], name: 'Evening clip.webm', bytes: video },
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// The in-memory "Drive"
// ---------------------------------------------------------------------------
export async function createDemoBackend() {
  const blobs = new Map();
  let counter = 0;
  const store = {
    async open({ size }) {
      const parts = [];
      return async (piece, offset, total) => {
        parts.push(piece);
        if (offset + piece.length < total) return null;
        const all = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        const id = `demo-${++counter}`;
        blobs.set(id, all);
        return id;
      };
    },
  };

  // A fixed key for the sample data, so demo windows can share an unlocked session like real ones.
  const demoKey = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Secure Box demo master key')));
  const { doc, master } = await createKeyring(DEMO_PASSWORD, { kid: 'de30de30de30de30', key: demoKey });
  const cipher = await VaultCipher.create(master);
  let vault = emptyVault();
  for (const item of ITEMS) vault = applyChange(vault, { op: 'put', item: makeItem({ ...item, password: item.type === 'login' ? generatePassword({ length: 18 }) : '' }) });

  const folders = new Map();
  const folderFor = (path) => {
    let parent = null;
    path.forEach((name, i) => {
      const key = path.slice(0, i + 1).join('/');
      if (!folders.has(key)) {
        const folder = makeFolder({ name, parent });
        folders.set(key, folder);
        vault = applyChange(vault, { op: 'folder-put', folder });
      }
      parent = folders.get(key).id;
    });
    return parent;
  };
  for (const sample of await sampleFiles()) {
    const id = crypto.randomUUID();
    const type = guessType(sample.name);
    const file = new File([sample.bytes], sample.name, { type });
    const thumbnail = canThumbnail({ name: sample.name, type }) ? await makeThumbnail(file, type) : null;
    const plan = layout({ size: file.size, thumbBytes: thumbnail?.length || 0 });
    const writer = createPieceWriter({ total: plan.total, send: await store.open({ size: plan.total }) });
    const meta = await encryptFile({ file, fileId: id, thumbnail, write: (bytes) => writer.write(bytes) });
    const folder = folderFor(sample.path); // creates folders first, so they aren't lost below
    vault = applyChange(vault, {
      op: 'file-put',
      file: makeFileEntry({ id, name: sample.name, type, size: file.size, folder, driveId: writer.result, key: meta.key, chunk: meta.chunk, thumbBytes: meta.thumbBytes }),
    });
  }

  let keyringText = serializeKeyring(doc);
  let current = { text: await cipher.seal(vault), rev: '1' };
  let revision = 1;

  return {
    kind: 'demo',
    identity: { email: 'demo@example.com', sub: 'demo' },
    tokenExpiresAt: () => Infinity,
    describe: () => ({ source: 'page' }),
    async load() {
      await pause(250);
      return { keyring: keyringText, vault: { ...current } };
    },
    async create({ keyringText: text, vaultText }) {
      keyringText = text;
      current = { text: vaultText, rev: String(++revision) };
      return current.rev;
    },
    async createVault(vaultText) {
      current = { text: vaultText, rev: String(++revision) };
      return current.rev;
    },
    async saveKeyring(text) {
      await pause(120);
      keyringText = text;
    },
    vaultRevision: async () => current.rev,
    readVault: async () => ({ ...current }),
    async writeVault(text) {
      await pause(150);
      current = { text, rev: String(++revision) };
      return current.rev;
    },
    openUpload: ({ size }) => store.open({ size }),
    async trash(id) {
      blobs.delete(id);
    },
    async readRange(id, start, end) {
      return new Blob([blobs.get(id).subarray(start, end + 1)]).stream();
    },
    async readBytes(id, start, end) {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error('Missing demo file.');
      return bytes.slice(start, Math.min(end + 1, bytes.length)).buffer;
    },
  };
}
