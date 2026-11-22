// Big vaults: changes applied in one pass, and lookups worked out once per vault.
// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyChange, collectTree, emptyVault, folderChain, makeFileEntry, makeFolder, mergeVaults, uniqueName, vaultIndex } from '../src/core/vault.js';

// ---------------------------------------------------------------------------
// The way changes were applied before, one whole pass over the vault per change: what
// applyChange must still give, exactly, for any change.
// ---------------------------------------------------------------------------
const LIMITS = { title: 200, username: 500, password: 1000, url: 2048, notes: 50000 };
const text = (value, max) => (typeof value === 'string' ? value : value == null ? '' : String(value)).slice(0, max);
const cleanName = (value) => text(value, 255).replace(/[\u0000-\u001f\u007f]/g, '').trim();
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;
const fingerprint = (it) => JSON.stringify([it.type, it.title, it.username, it.password, it.url, it.notes]);
function cleanItem(raw) {
  const type = raw.type === 'note' ? 'note' : 'login';
  const login = type === 'login';
  const now = Date.now();
  return {
    id: raw.id,
    type,
    title: text(raw.title, LIMITS.title) || 'Untitled',
    username: login ? text(raw.username, LIMITS.username) : '',
    password: login ? text(raw.password, LIMITS.password) : '',
    url: login ? text(raw.url, LIMITS.url) : '',
    notes: text(raw.notes, LIMITS.notes),
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}
function cleanFolder(raw) {
  const now = Date.now();
  return { id: raw.id, name: cleanName(raw.name) || 'Untitled folder', parent: isId(raw.parent) ? raw.parent : null, created: Number.isFinite(raw.created) ? raw.created : now, updated: Number.isFinite(raw.updated) ? raw.updated : now };
}
function cleanFile(raw) {
  const now = Date.now();
  return {
    id: raw.id,
    name: cleanName(raw.name) || 'Untitled file',
    type: text(raw.type, 200),
    size: raw.size,
    folder: isId(raw.folder) ? raw.folder : null,
    blob: raw.blob,
    key: raw.key,
    chunk: raw.chunk,
    thumbBytes: Number.isInteger(raw.thumbBytes) && raw.thumbBytes > 0 ? raw.thumbBytes : 0,
    created: Number.isFinite(raw.created) ? raw.created : now,
    updated: Number.isFinite(raw.updated) ? raw.updated : now,
  };
}
function oldCollectTree(vault, folderId) {
  const folderIds = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of vault.folders) {
      if (f.parent && folderIds.has(f.parent) && !folderIds.has(f.id)) {
        folderIds.add(f.id);
        grew = true;
      }
    }
  }
  return { folderIds: [...folderIds], files: vault.files.filter((f) => f.folder && folderIds.has(f.folder)) };
}
const keepCopy = (vault, name) => (vault.trash?.includes(name) ? { ...vault, trash: vault.trash.filter((n) => n !== name) } : vault);
function reference(vault, change) {
  switch (change.op) {
    case 'put':
      return { ...vault, items: vault.items.filter((it) => it.id !== change.item.id).concat(change.item) };
    case 'item-update': {
      const current = vault.items.find((it) => it.id === change.item.id);
      if (!current) return { ...vault, items: vault.items.concat(change.item) };
      const item = cleanItem({ ...current, ...change.fields, updated: change.item.updated });
      return { ...vault, items: vault.items.map((it) => (it.id === item.id ? item : it)) };
    }
    case 'delete':
      return { ...vault, items: vault.items.filter((it) => it.id !== change.id) };
    case 'folder-put':
      return { ...vault, folders: vault.folders.filter((f) => f.id !== change.folder.id).concat(change.folder) };
    case 'folder-update': {
      const current = vault.folders.find((f) => f.id === change.id);
      if (!current) return vault;
      const fields = { ...change.fields };
      if (fields.parent && !vault.folders.some((f) => f.id === fields.parent)) fields.parent = null;
      if (fields.parent && oldCollectTree(vault, current.id).folderIds.includes(fields.parent)) return vault;
      if ('name' in fields || 'parent' in fields) {
        const parent = 'parent' in fields ? fields.parent : current.parent;
        fields.name = uniqueName(fields.name ?? current.name, vault.folders.filter((f) => f.parent === parent && f.id !== current.id).map((f) => f.name), { isFolder: true });
      }
      const folder = cleanFolder({ ...current, ...fields });
      return { ...vault, folders: vault.folders.map((f) => (f.id === folder.id ? folder : f)) };
    }
    case 'file-put': {
      const lost = change.file.folder && !vault.folders.some((f) => f.id === change.file.folder);
      const file = lost ? { ...change.file, folder: null } : change.file;
      return keepCopy({ ...vault, files: vault.files.filter((f) => f.id !== file.id).concat(file) }, file.blob);
    }
    case 'file-update': {
      const current = vault.files.find((f) => f.id === change.id);
      if (!current) return change.orAdd ? reference(vault, { op: 'file-put', file: change.orAdd }) : vault;
      if (change.ifBlob && current.blob !== change.ifBlob) return vault;
      const fields = { ...change.fields };
      if (fields.folder && !vault.folders.some((f) => f.id === fields.folder)) fields.folder = null;
      if ('name' in fields || 'folder' in fields) {
        const folder = 'folder' in fields ? fields.folder : current.folder;
        fields.name = uniqueName(fields.name ?? current.name, vault.files.filter((f) => f.folder === folder && f.id !== current.id).map((f) => f.name));
      }
      const file = cleanFile({ ...current, ...fields });
      return keepCopy({ ...vault, files: vault.files.map((f) => (f.id === file.id ? file : f)) }, file.blob);
    }
    case 'remove': {
      const folders = new Set(change.folders || []);
      const files = new Set(change.files || []);
      return { ...vault, folders: vault.folders.filter((f) => !folders.has(f.id)), files: vault.files.filter((f) => !files.has(f.id)) };
    }
    case 'batch':
      return change.changes.reduce((acc, next) => reference(acc, next), vault);
    case 'trash-add': {
      const inUse = new Set(vault.files.map((f) => f.blob));
      return { ...vault, trash: [...new Set([...(vault.trash || []), ...change.names.filter((name) => !inUse.has(name))])] };
    }
    case 'trash-done': {
      const done = new Set(change.names);
      return { ...vault, trash: (vault.trash || []).filter((name) => !done.has(name)) };
    }
    case 'import': {
      const seen = new Set(vault.items.map(fingerprint));
      const fresh = change.items.filter((it) => {
        const key = fingerprint(it);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...vault, items: vault.items.concat(fresh) };
    }
    default:
      throw new Error(`Unknown change: ${change.op}`);
  }
}

// ---------------------------------------------------------------------------
// Random changes, repeatable (a fixed seed)
// ---------------------------------------------------------------------------
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  const chance = (p) => next() < p;
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join('');
  const id = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
  return { int, pick, chance, id };
}

// Few names, so they clash often (case too), and "(2)" names that are taken already.
const FILE_NAMES = ['a.txt', 'A.TXT', 'a (2).txt', 'b', 'B', 'photo.jpg', 'Photo.JPG', 'notes.md', '.hidden', 'x.tar.gz'];
const FOLDER_NAMES = ['Docs', 'docs', 'Docs (2)', 'Photos', 'a.b', 'Taxes'];

function changes(r, vault, depth = 0) {
  const folders = vault.folders.map((f) => f.id);
  const files = vault.files.map((f) => f.id);
  const items = vault.items.map((it) => it.id);
  const blobs = [...vault.files.map((f) => f.blob), ...(vault.trash || [])];
  const someFolder = () => (r.chance(0.15) ? null : r.chance(0.1) || !folders.length ? r.id() : r.pick(folders));
  const someFile = () => (r.chance(0.15) || !files.length ? r.id() : r.pick(files));
  const someItem = () => (r.chance(0.2) || !items.length ? r.id() : r.pick(items));
  const someBlob = () => (r.chance(0.5) || !blobs.length ? r.id() : r.pick(blobs));
  const updated = () => 1_700_000_000_000 + r.int(1_000_000);
  const newFile = (id = r.id()) => makeFileEntry({ id, name: r.pick(FILE_NAMES), type: 'text/plain', size: r.int(5000), folder: someFolder(), blob: someBlob(), key: 'K'.repeat(43), chunk: 65536, thumbBytes: r.int(3) * 100, created: 1, updated: updated() });
  const newItem = (id = r.id()) => ({ id, type: r.chance(0.3) ? 'note' : 'login', title: r.pick(['Bank', 'Mail', 'Bank', 'Wi-Fi']), username: r.pick(['', 'me']), password: r.pick(['', 'pw']), url: '', notes: '', created: 1, updated: updated() });
  const one = () => {
    switch (r.int(depth < 2 ? 12 : 11)) {
      case 0:
        return { op: 'put', item: newItem(someItem()) };
      case 1:
        return { op: 'item-update', item: newItem(someItem()), fields: r.chance(0.5) ? { title: r.pick(['Bank', 'Shop']) } : { notes: 'n', password: 'p2' } };
      case 2:
        return { op: 'delete', id: someItem() };
      case 3:
        return { op: 'folder-put', folder: { ...makeFolder({ name: r.pick(FOLDER_NAMES), parent: someFolder() }), id: r.chance(0.2) && folders.length ? r.pick(folders) : r.id(), created: 1, updated: updated() } };
      case 4: {
        const fields = { updated: updated() };
        if (r.chance(0.6)) fields.name = r.pick(FOLDER_NAMES);
        if (r.chance(0.6)) fields.parent = someFolder();
        return { op: 'folder-update', id: r.chance(0.1) ? r.id() : r.pick(folders.length ? folders : [r.id()]), fields };
      }
      case 5:
        return { op: 'file-put', file: newFile(r.chance(0.2) ? someFile() : r.id()) };
      case 6: {
        const id = someFile();
        const fields = { updated: updated() };
        if (r.chance(0.5)) fields.name = r.pick(FILE_NAMES);
        if (r.chance(0.5)) fields.folder = someFolder();
        if (r.chance(0.3)) Object.assign(fields, { blob: someBlob(), size: r.int(100) });
        const change = { op: 'file-update', id, fields };
        if (r.chance(0.3)) change.ifBlob = r.chance(0.5) ? vault.files.find((f) => f.id === id)?.blob : someBlob();
        if (r.chance(0.3)) change.orAdd = newFile(id);
        return change;
      }
      case 7:
        return { op: 'remove', folders: folders.filter(() => r.chance(0.15)).concat(r.chance(0.3) ? [r.id()] : []), files: files.filter(() => r.chance(0.15)).concat(r.chance(0.3) ? [r.id()] : []) };
      case 8:
        return { op: 'trash-add', names: Array.from({ length: r.int(4) }, someBlob) };
      case 9:
        return { op: 'trash-done', names: Array.from({ length: r.int(4) }, someBlob) };
      case 10:
        return { op: 'import', items: Array.from({ length: r.int(4) }, () => newItem()) };
      default:
        return { op: 'batch', changes: Array.from({ length: r.int(25) }, () => changes(r, vault, depth + 1)) };
    }
  };
  return one();
}

function startingVault(r) {
  let v = emptyVault();
  if (r.chance(0.5)) v.trash = [r.id()];
  for (let i = 0; i < 40; i++) v = reference(v, changes(r, v, 2));
  return v;
}

test('one-pass changes: the same vault as before, for thousands of random changes and batches', () => {
  let steps = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const r = random(seed);
    let v = startingVault(r);
    for (let i = 0; i < 40; i++) {
      const change = changes(r, v);
      const expected = reference(v, change);
      const got = applyChange(v, change);
      assert.deepEqual(got, expected, `seed ${seed}, change ${i}: ${JSON.stringify(change).slice(0, 300)}`);
      v = got;
      steps++;
    }
  }
  assert.ok(steps >= 4800);
});

test('numbering picks up a number freed in the same batch, as before', () => {
  const docs = makeFolder({ name: 'Docs' });
  const file = (name, folder = null) => {
    const id = crypto.randomUUID();
    return makeFileEntry({ id, name, type: 'text/plain', size: 1, folder, blob: id, key: 'K'.repeat(43), chunk: 65536 });
  };
  const there = file('a.txt', docs.id);
  const loose = Array.from({ length: 5 }, () => file('a.txt'));
  const start = applyChange(emptyVault(), { op: 'batch', changes: [{ op: 'folder-put', folder: docs }, { op: 'file-put', file: there }, ...loose.map((f) => ({ op: 'file-put', file: f }))] });
  const into = (f) => ({ op: 'file-update', id: f.id, fields: { folder: docs.id } });
  const steps = [
    into(loose[0]),
    into(loose[1]),
    { op: 'remove', files: [loose[0].id] }, // "a (2).txt" is free again
    into(loose[2]),
    { op: 'file-update', id: loose[1].id, fields: { name: 'a.txt' } }, // renamed in its own folder: "a (3).txt" stays its own
    into(loose[3]),
    { op: 'file-update', id: there.id, fields: { folder: null } }, // "a.txt" leaves
    into(loose[4]),
  ];
  for (let i = 1; i <= steps.length; i++) {
    const change = { op: 'batch', changes: steps.slice(0, i) };
    assert.deepEqual(applyChange(start, change), reference(start, change), `after ${i} steps`);
  }
  const names = applyChange(start, { op: 'batch', changes: steps }).files.filter((f) => f.folder === docs.id).map((f) => f.name);
  assert.deepEqual(names.sort(), ['a (2).txt', 'a (3).txt', 'a (4).txt', 'a.txt']);
});

test('lookups worked out once per vault match going through the whole vault', () => {
  for (let seed = 200; seed < 260; seed++) {
    const r = random(seed);
    let v = startingVault(r);
    for (let i = 0; i < 20; i++) v = applyChange(v, changes(r, v));
    const index = vaultIndex(v);
    assert.equal(vaultIndex(v), index, 'worked out once');
    for (const id of [null, ...v.folders.map((f) => f.id)]) {
      assert.deepEqual(index.foldersIn(id), v.folders.filter((f) => (f.parent ?? null) === id));
      assert.deepEqual(index.filesIn(id), v.files.filter((f) => (f.folder ?? null) === id));
      if (!id) continue;
      const old = oldCollectTree(v, id);
      const now = collectTree(v, id);
      assert.deepEqual(new Set(now.folderIds), new Set(old.folderIds));
      assert.deepEqual(new Set(now.files), new Set(old.files));
      assert.deepEqual(index.totals(id), { folders: old.folderIds.length - 1, files: old.files.length, bytes: old.files.reduce((n, f) => n + f.size, 0) });
      assert.deepEqual(folderChain(v, id).at(-1), index.folders.get(id));
    }
    for (const f of v.files) assert.equal(index.files.get(f.id), f);
  }
});

// ---------------------------------------------------------------------------
// Thousands of files: fast enough to never hold up the page
// ---------------------------------------------------------------------------
function bigVault(n) {
  const v = emptyVault();
  v.folders = Array.from({ length: 50 }, (_, i) => makeFolder({ name: `Folder ${i}` }));
  v.files = Array.from({ length: n }, (_, i) => {
    const id = crypto.randomUUID();
    return makeFileEntry({ id, name: `Photo ${i}.jpg`, type: 'image/jpeg', size: i, folder: i % 2 ? v.folders[i % 50].id : null, blob: id, key: 'K'.repeat(43), chunk: 65536 });
  });
  return v;
}

test('20,000 files: 5,000 uploads saved, 5,000 files moved and a whole vault merged, each in well under a second', () => {
  const v = bigVault(20_000);
  const puts = Array.from({ length: 5000 }, (_, i) => {
    const id = crypto.randomUUID();
    return { op: 'file-put', file: makeFileEntry({ id, name: `New ${i}.jpg`, type: 'image/jpeg', size: 1, folder: null, blob: id, key: 'K'.repeat(43), chunk: 65536 }) };
  });
  let t = performance.now();
  const uploaded = applyChange(v, { op: 'batch', changes: puts });
  assert.equal(uploaded.files.length, 25_000);
  assert.ok(performance.now() - t < 1000, `uploads took ${Math.round(performance.now() - t)} ms`);

  // 5,000 files from all over the vault into one folder: some names clash with what's there.
  const target = v.folders[7].id;
  const moving = v.files.filter((f) => f.folder !== target).slice(0, 5000);
  t = performance.now();
  const moved = applyChange(v, { op: 'batch', changes: moving.map((f, i) => ({ op: 'file-update', id: f.id, fields: { folder: target, name: `Photo ${i % 4000}.jpg`, updated: 2 } })) });
  assert.ok(performance.now() - t < 1000, `moving took ${Math.round(performance.now() - t)} ms`);
  const names = moved.files.filter((f) => f.folder === target).map((f) => f.name.toLowerCase());
  assert.equal(names.length, 5000 + v.files.filter((f) => f.folder === target).length);
  assert.equal(new Set(names).size, names.length, 'every name in the folder is kept apart');

  // Hundreds of files with the very same name in one folder: numbered in order.
  const same = applyChange(v, { op: 'batch', changes: moving.slice(0, 300).map((f) => ({ op: 'file-update', id: f.id, fields: { folder: target, name: 'Same.jpg' } })) });
  const numbered = same.files.filter((f) => f.folder === target && f.name.startsWith('Same')).map((f) => f.name);
  assert.deepEqual(numbered, ['Same.jpg', ...Array.from({ length: 299 }, (_, i) => `Same (${i + 2}).jpg`)]);

  // Everything arriving at a place that has a copy of it already, renamed where names clash.
  const there = bigVault(20_000);
  t = performance.now();
  const merged = mergeVaults(there, { ...v, files: v.files.map((f) => ({ ...f, name: 'Clash.jpg' })) });
  assert.ok(performance.now() - t < 2000, `merging took ${Math.round(performance.now() - t)} ms`);
  assert.equal(merged.files.length, 40_000);
});

test('a change that changes nothing hands back the same vault', () => {
  const v = bigVault(10);
  assert.equal(applyChange(v, { op: 'folder-update', id: crypto.randomUUID(), fields: { name: 'x' } }), v);
  assert.equal(applyChange(v, { op: 'file-update', id: v.files[0].id, ifBlob: crypto.randomUUID(), fields: { name: 'x' } }), v);
  assert.equal(applyChange(v, { op: 'batch', changes: [] }), v);
  assert.notEqual(applyChange(v, { op: 'file-update', id: v.files[0].id, fields: { name: 'x' } }), v);
});
