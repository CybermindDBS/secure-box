// A vault is the same in every place: it names each encrypted copy, and each place finds a copy
// by that name its own way (Google Drive by Secure Box's private tag on the copy, OneDrive by its
// path in the app's folder), remembering where each one is for the session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudBackend, createCopies, createOneDriveBackend } from '../src/core/backend.js';
import { movedNote, movedNoteText } from '../src/core/vault.js';

const auth = { accessToken: 'token', expiresAt: Date.now() + 3_600_000, identity: { email: 'you@example.com', sub: 'you' } };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const bytes = (text, headers = {}) => {
  const data = new TextEncoder().encode(text);
  const range = /bytes=(\d+)-(\d+)/.exec(headers.Range || '');
  return range ? new Response(data.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(data);
};
const textOf = async (body) => new Response(body).text();
const [A, B, C, D] = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7', '16fd2706-8baf-433b-82eb-8c7fada847da', '886313e1-3b8a-5372-9b90-0c9aee199e5d'];

/** Runs `body(calls)` with fetch answered by `answer(url, init)`; calls are noted as "METHOD url". */
async function withFetch(answer, body) {
  const real = globalThis.fetch;
  const realWarn = console.warn;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${decodeURIComponent(String(url))}`);
    return answer(String(url), init);
  };
  console.warn = () => {};
  try {
    await body(calls);
  } finally {
    globalThis.fetch = real;
    console.warn = realWarn;
  }
}

const blobTag = (id, name, size = 10) => ({ id, size: String(size), appProperties: { secureBox: 'blob', blob: name } });

test('Google Drive finds each copy by its tag: all at once when the vault loads, then any newer one alone', async () => {
  const contents = { IDA: 'aaaaaaaaaa', IDB: 'bbbbbbbbbb', OLD: 'stale copy', IDD: 'dddd', K: '{"format":"secure-box-keyring"}', V: '{"format":"secure-box-vault"}' };
  const trashed = [];
  let upload = null;
  const answer = (url, init) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/drive/v3/files' && q.includes("key='secureBox' and value='blob'")) {
      // Two pages; the same name twice: the newer copy (listed later) wins.
      return u.searchParams.get('pageToken') === 'p2' ? json({ files: [blobTag('IDA', A)] }) : json({ files: [blobTag('OLD', A)], nextPageToken: 'p2' });
    }
    if (u.pathname === '/drive/v3/files' && q.includes("key='blob'")) return json({ files: q.includes(B) ? [{ id: 'IDB', size: '10' }] : [] });
    if (u.pathname === '/drive/v3/files') {
      const parts = [['R', 'root'], ['F', 'files'], ['K', 'keyring'], ['V', 'vault']];
      return json({ files: parts.map(([id, kind]) => ({ id, appProperties: { secureBox: kind, kid: 'kid1' }, headRevisionId: 'r1', parents: kind === 'root' ? [] : ['R'] })) });
    }
    if (u.pathname === '/upload/drive/v3/files') {
      upload = JSON.parse(init.body);
      return new Response(null, { status: 200, headers: { Location: 'https://upload.example/session' } });
    }
    if (url === 'https://upload.example/session') return json({ id: 'IDD' });
    const id = /\/files\/([^/?]+)/.exec(u.pathname)?.[1];
    if (init.method === 'PATCH') {
      trashed.push(id);
      return json({ id });
    }
    if (u.searchParams.get('alt') === 'media') return id in contents ? bytes(contents[id], init.headers) : json({ error: { code: 404 } }, 404);
    throw new Error(`unexpected ${init.method || 'GET'} ${url}`);
  };
  await withFetch(answer, async (calls) => {
    const backend = createCloudBackend(auth);
    await backend.load();
    assert.equal(await textOf(await backend.readRange(A, 0, 3)), 'aaaa', 'the newer of two copies with one name');
    assert.equal(await textOf(await backend.readRange(A, 4, 5)), 'aa');
    assert.equal(calls.filter((c) => c.includes("value='blob'")).length, 2, 'one listing (two pages), then remembered');

    // A copy stored since (by another device) is looked up on its own, once.
    assert.equal(await textOf(await backend.readRange(B, 0, 9)), 'bbbbbbbbbb');
    await backend.readRange(B, 0, 0);
    assert.equal(calls.filter((c) => c.includes(`value='${B}'`)).length, 1);
    await assert.rejects(backend.readRange(C, 0, 1), { code: 'not-found', status: 404 });

    // Deleting: a missing copy counts as deleted; a found one goes to the bin by Drive's id.
    await backend.trash(C);
    await backend.trash(A);
    assert.deepEqual(trashed, ['IDA']);

    // A new copy is tagged with its name, and found from the upload's answer without a lookup.
    const send = await backend.openUpload({ name: D, size: 4 });
    assert.equal(await send(new TextEncoder().encode('dddd'), 0, 4), 'IDD');
    assert.deepEqual(upload, { name: D, mimeType: 'application/octet-stream', parents: ['F'], appProperties: { secureBox: 'blob', blob: D } });
    const before = calls.length;
    assert.deepEqual(await backend.describe({ id: 'file', blob: D }), { source: 'drive', token: 'token', id: 'IDD' });
    assert.equal(await textOf(await backend.readRange(D, 1, 2)), 'dd');
    assert.equal(calls.slice(before).filter((c) => c.includes('q=')).length, 0);

    // Only names that are a copy's random id are ever looked up (nothing else reaches a query).
    await assert.rejects(backend.readRange("x' or name contains '", 0, 1), /Not an encrypted copy/);
  });
});

test('OneDrive finds each copy by its name in the files folder, then by its path for one stored since', async () => {
  const contents = { IDA: 'aaaaaaaaaa', IDB: 'bbbbbbbbbb', K: '{"format":"secure-box-keyring"}', V: '{"format":"secure-box-vault"}' };
  const removed = [];
  const answer = (url, init) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    if (path === '/v1.0/me/drive/special/approot/children') {
      return json({ value: [{ id: 'K', name: 'Secure Box Key Ring.json', file: {} }, { id: 'V', name: 'Secure Box Vault.json', file: {}, eTag: 'e1' }, { id: 'F', name: 'Encrypted files', folder: {} }] });
    }
    if (path === '/v1.0/me/drive/items/F/children') return json({ value: [{ id: 'IDA', name: A, size: 10, file: {} }] });
    if (path === `/v1.0/me/drive/special/approot:/Encrypted files/${B}`) return json({ id: 'IDB', size: 10, file: {} });
    if (path.startsWith('/v1.0/me/drive/special/approot:/Encrypted files/')) return json({ error: { code: 'itemNotFound', message: 'Not found' } }, 404);
    const id = /\/items\/([^/]+)/.exec(path)?.[1];
    if (init.method === 'DELETE') {
      removed.push(id);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/contentStream') && id in contents) return bytes(contents[id], init.headers);
    throw new Error(`unexpected ${init.method || 'GET'} ${url}`);
  };
  await withFetch(answer, async (calls) => {
    const backend = createOneDriveBackend(auth);
    const loaded = await backend.load();
    assert.equal(loaded.vault.rev, 'e1');
    assert.equal(await textOf(await backend.readRange(A, 2, 4)), 'aaa');
    assert.equal(await textOf(await backend.readRange(B, 0, 3)), 'bbbb', 'stored since the listing: found by its path');
    await backend.readRange(B, 0, 0);
    assert.equal(calls.filter((c) => c.includes(`Encrypted files/${B}`)).length, 1, 'then remembered');
    await assert.rejects(backend.readRange(C, 0, 1), { code: 'not-found' });
    await backend.trash(C);
    await backend.trash(B);
    assert.deepEqual(removed, ['IDB']);
    assert.deepEqual([...(await backend.listBlobs())], [[A, { size: 10 }]]);
  });
});

/** A Google Drive holding one vault (folder R, key ring K, vault V, files folder F) for the save and delete tests. */
function driveWith({ parts, copies = [], revisions, onWrite = () => {}, trashed = [] }) {
  return (url, init) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/drive/v3/files' && q.includes("value='blob'")) return json({ files: copies.filter(([, , gone]) => !gone?.()).map(([id, name]) => blobTag(id, name)) });
    if (u.pathname === '/drive/v3/files') return json({ files: parts.map(([id, kind, parent, kid = 'kid1']) => ({ id, appProperties: { secureBox: kind, kid }, headRevisionId: revisions.at(-1), parents: parent ? [parent] : [] })) });
    if (u.searchParams.get('fields') === 'headRevisionId,trashed') return json({ headRevisionId: revisions.at(-1), trashed: false });
    if (u.pathname === '/drive/v3/files/V/revisions') return json({ revisions: revisions.map((id) => ({ id })) });
    if (u.pathname.startsWith('/drive/v3/files/V/revisions/')) return new Response(`the vault at ${u.pathname.split('/').pop()}`);
    if (u.searchParams.get('alt') === 'media') return new Response('{}');
    if (u.pathname === '/upload/drive/v3/files/V' && init.method === 'PATCH') return json({ headRevisionId: onWrite(init.body) });
    if (init.method === 'PATCH' && JSON.parse(init.body).trashed) {
      trashed.push(u.pathname.split('/').pop());
      return json({ id: 'ok' });
    }
    throw new Error(`unexpected ${init.method || 'GET'} ${url}`);
  };
}
const oneVault = [['R', 'root'], ['F', 'files', 'R'], ['K', 'keyring', 'R'], ['V', 'vault', 'R']];

test('Google Drive saves only over the version it read, and says when it replaced another device’s save', async () => {
  const revisions = ['r1'];
  let crossing = false;
  const onWrite = () => {
    if (crossing) revisions.push(`r${revisions.length + 1}`); // another device's save lands first
    revisions.push(`r${revisions.length + 1}`);
    return revisions.at(-1);
  };
  await withFetch(driveWith({ parts: oneVault, revisions, onWrite }), async (calls) => {
    const backend = createCloudBackend(auth);
    await backend.load();
    assert.equal(await backend.writeVault('first', 'r1'), 'r2', 'straight after the version it read');

    revisions.push('r3'); // another device saved since this window last read
    const before = calls.length;
    await assert.rejects(backend.writeVault('second', 'r2'), { code: 'conflict' });
    assert.ok(!calls.slice(before).some((c) => c.startsWith('PATCH')), 'nothing was written');

    crossing = true; // another device saves between the check and this write
    await assert.rejects(backend.writeVault('third', 'r3'), (err) => err.code === 'overwrote' && err.overwrote === 'r4' && err.rev === 'r5');
    assert.equal(await backend.readRevision('r4'), 'the vault at r4', 'that save can be read back, to put the change on top of it');
  });
});

test('Google Drive: removing a vault takes only its own parts and copies, never another vault’s in the same Drive', async () => {
  const trashed = [];
  const parts = [['R', 'root'], ['F', 'files', 'R'], ['K', 'keyring', 'elsewhere'], ['V', 'vault', 'R'], ['R2', 'root', null, 'kid2'], ['K2', 'keyring', 'R2', 'kid2'], ['V2', 'vault', 'R2', 'kid2']];
  // A is in this vault's folder (in the bin with it once that goes), B was moved out of it, X is another vault's.
  const copies = [['IDA', A, () => trashed.includes('R')], ['IDB', B], ['IDX', C]];
  await withFetch(driveWith({ parts, copies, revisions: ['r1'], trashed }), async () => {
    const backend = createCloudBackend(auth);
    await backend.load();
    await backend.removeAll([A, B]);
    assert.deepEqual(trashed, ['R', 'K', 'IDB']);
  });
});

test('Google Drive: a vault moved away leaves a note of where it went, and a vault made there later takes its place', async () => {
  const trashed = [];
  let note = '';
  const live = (id) => !trashed.includes(id);
  const answer = (url, init) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/drive/v3/files' && q.includes("value='blob'")) return json({ files: [blobTag('IDA', A), blobTag('IDB', B)].filter((f) => f.id !== 'IDA' || live('F')) });
    if (u.pathname === '/drive/v3/files') return json({ files: oneVault.filter(([id]) => live(id)).map(([id, kind, parent]) => ({ id, appProperties: { secureBox: kind, kid: 'kid1' }, headRevisionId: 'r1', parents: parent ? [parent] : [] })) });
    if (u.searchParams.get('alt') === 'media') return new Response(u.pathname.endsWith('/V') ? note || '{"format":"secure-box-vault"}' : '{"format":"secure-box-keyring"}');
    if (u.pathname === '/upload/drive/v3/files/V' && init.method === 'PATCH') {
      note = init.body;
      return json({ headRevisionId: 'r2' });
    }
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'POST') return json({ id: 'NEW', headRevisionId: 'n1' });
    if (init.method === 'PATCH') {
      trashed.push(u.pathname.split('/').pop());
      return json({ id: 'ok' });
    }
    throw new Error(`unexpected ${init.method || 'GET'} ${url}`);
  };
  await withFetch(answer, async () => {
    const backend = createCloudBackend(auth);
    await backend.load();
    await backend.retire(movedNoteText('microsoft'), [A, B]);
    assert.equal(movedNote(note).to, 'microsoft');
    assert.deepEqual(trashed, ['K', 'F', 'IDB'], 'its key ring, its files folder (copies and all), and a copy moved out of it');
    // Opened again later, from anywhere: the note says where it went; a new vault there replaces it.
    const later = createCloudBackend(auth);
    const loaded = await later.load();
    assert.deepEqual([loaded.keyring, movedNote(loaded.vault.text).to], [null, 'microsoft']);
    await later.create({ keyringText: '{}', vaultText: '{}', kid: 'kid1' });
    assert.ok(trashed.includes('V'), 'the note went to the bin first');
  });
});

test('OneDrive: a vault moved away leaves a note of where it went; its key ring and files go to the recycle bin', async () => {
  const removed = [];
  let note = '';
  const answer = (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname);
    if (path === '/v1.0/me/drive/special/approot/children') return json({ value: [{ id: 'K', name: 'Secure Box Key Ring.json', file: {} }, { id: 'V', name: 'Secure Box Vault.json', file: {}, eTag: 'e1' }, { id: 'F', name: 'Encrypted files', folder: {} }] });
    if (path === '/v1.0/me/drive/items/F/children') return json({ value: [] });
    if (path.endsWith('/contentStream')) return new Response('{"format":"secure-box-vault"}');
    if (path === '/v1.0/me/drive/items/V/content' && init.method === 'PUT') {
      note = init.body;
      return json({ eTag: 'e2' });
    }
    if (init.method === 'DELETE') {
      removed.push(path.split('/').pop());
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${init.method || 'GET'} ${url}`);
  };
  await withFetch(answer, async () => {
    const backend = createOneDriveBackend(auth);
    await backend.load();
    await backend.retire(movedNoteText('google'));
    assert.equal(movedNote(note).to, 'google');
    assert.deepEqual(removed, ['K', 'F']);
  });
});

test('Google Drive: a vault an earlier version made is told apart from one deleted, in the Drive or in its bin', async () => {
  const files = { live: [], bin: [] };
  const answer = (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    if (u.pathname !== '/drive/v3/files') throw new Error(`unexpected ${url}`);
    if (q.includes("key='secureBox'")) return json({ files: [] }); // no vault of this version, here or in the bin
    return json({ files: q.includes('trashed = true') ? files.bin : files.live });
  };
  await withFetch(answer, async () => {
    const look = async () => (await createCloudBackend(auth).load()).otherVersion;
    assert.equal(await look(), undefined, 'nothing at all: no vault, of any version');
    files.live = [blobTag('LEFT', A)];
    assert.equal(await look(), undefined, 'encrypted copies of this version, left by a transfer that stopped, are no vault of another version');
    files.live = [{ id: 'OLD', appProperties: { unibox: 'root' } }, blobTag('LEFT', A)];
    assert.equal(await look(), 'here', 'a vault made by an earlier version (its own tags) is said to be one, never "deleted"');
    files.live = [];
    files.bin = [{ id: 'OLD', appProperties: { unibox: 'vault' } }];
    assert.equal(await look(), 'bin', 'and once it was put in the bin to start over, a new vault can be made');
  });
});

test('a copy deleted outside Secure Box is found missing in a cloud, and one stored since is not', async () => {
  const [A, B, C, D] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const there = new Map([
    [A, { id: 'idA', size: 1 }],
    [B, { id: 'idB', size: 2 }],
  ]);
  let listed = 0;
  const lookups = [];
  const copies = createCopies({
    listAll: async () => {
      listed++;
      return new Map(there);
    },
    findOne: async (name) => {
      lookups.push(name);
      return there.get(name) || null;
    },
    missing: () => new Error('missing'),
  });
  copies.reload(); // as the vault loads
  there.set(C, { id: 'idC', size: 3 }); // stored by another device after the listing
  assert.deepEqual(await copies.absent([A, B, C, D]), [D]);
  assert.equal(listed, 1, 'the listing made when the vault loaded answers for the rest');
  assert.deepEqual(lookups, [C, D], 'only the ones it didn’t have are looked up on their own');

  // Deleted since: the listing still has it; a fresh look finds it gone, then back once put back.
  there.delete(A);
  assert.deepEqual(await copies.absent([A]), []);
  assert.deepEqual(await copies.absent([A], { fresh: true }), [A]);
  there.set(A, { id: 'idA2', size: 1 });
  assert.deepEqual(await copies.absent([A], { fresh: true }), []);

  // A listing that failed is made again, rather than one lookup per copy.
  let offline = true;
  lookups.length = 0;
  const flaky = createCopies({
    listAll: async () => {
      if (offline) {
        offline = false;
        throw new Error('offline');
      }
      return new Map(there);
    },
    findOne: async (name) => {
      lookups.push(name);
      return null;
    },
    missing: () => new Error('missing'),
  });
  flaky.reload();
  assert.deepEqual(await flaky.absent([A, B, C]), []);
  assert.deepEqual(lookups, []);
});
