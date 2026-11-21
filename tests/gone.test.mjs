// A vault deleted outside Secure Box (gone.js): the clouds say so plainly ("trashed" while it's
// in the Google Drive bin, "gone" once deleted), so the app can offer the way back instead of
// failing every save; and a Google Drive vault put in the bin is found there and taken out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudBackend, createOneDriveBackend } from '../src/core/backend.js';

const auth = { accessToken: 'token', expiresAt: Date.now() + 3_600_000, identity: { email: 'you@example.com', sub: 'you' } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json({ error: { code: 404, message: 'File not found.' } }, 404);

/** Runs `body` with fetch answered by `answer(url, init)`. */
async function withFetch(answer, body) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => answer(String(url), init);
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * A Google Drive holding Secure Box's items: `live` and `bin` list [id, kind] (kind: root,
 * keyring, vault…); `head()` answers the vault's revision; `write()` a save; PATCHes are noted.
 */
function googleDrive(drive) {
  drive.patches = [];
  return (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('/files?')) {
      const inBin = new URL(url).searchParams.get('q').includes('trashed = true');
      return json({ files: (inBin ? drive.bin : drive.live).map(([id, kind]) => ({ id, appProperties: { unibox: kind, kid: 'kid1' }, headRevisionId: 'r1', parents: [] })) });
    }
    if (url.includes('alt=media')) return new Response('{}', { status: 200 });
    if (url.includes('fields=headRevisionId,trashed')) return drive.head();
    if (url.includes('/upload/') && method === 'PATCH') return drive.write();
    if (method === 'PATCH') {
      drive.patches.push(`${url.match(/files\/([^?]+)/)[1]}:${JSON.parse(init.body).trashed}`);
      return json({ id: 'ok' });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

test('Google Drive: a vault put in the bin while open is "trashed", one deleted for good is "gone"', async () => {
  const drive = { live: [['k1', 'keyring'], ['v1', 'vault']], bin: [], head: () => json({ headRevisionId: 'r1', trashed: false }) };
  await withFetch(googleDrive(drive), async () => {
    const backend = createCloudBackend(auth);
    await backend.load();
    assert.equal(await backend.vaultRevision(), 'r1');
    // In the bin, Drive would still take saves: Secure Box stops and asks instead.
    drive.head = () => json({ headRevisionId: 'r1', trashed: true });
    await assert.rejects(backend.vaultRevision(), { code: 'trashed' });
    await assert.rejects(backend.readVault(), { code: 'trashed' });
    drive.head = () => notFound();
    await assert.rejects(backend.vaultRevision(), { code: 'gone' });
  });
});

test('Google Drive: saving to a vault deleted for good is "gone"', async () => {
  const drive = { live: [['k1', 'keyring'], ['v1', 'vault']], bin: [], write: () => notFound() };
  await withFetch(googleDrive(drive), async () => {
    const backend = createCloudBackend(auth);
    await backend.load();
    await assert.rejects(backend.writeVault('{}'), { code: 'gone' });
  });
});

test('Google Drive: opening finds a vault put in the bin, and takes it out, its folder first', async () => {
  const drive = { live: [], bin: [['k1', 'keyring'], ['v1', 'vault'], ['f0', 'root']] };
  await withFetch(googleDrive(drive), async () => {
    const backend = createCloudBackend(auth);
    const loaded = await backend.load();
    assert.equal(loaded.inBin, true);
    assert.equal(loaded.keyring, null);
    await backend.restoreFromBin();
  });
  assert.deepEqual(drive.patches, ['f0:false', 'k1:false', 'v1:false']);
});

test('Google Drive: nothing there and nothing in the bin is simply no vault yet', async () => {
  const drive = { live: [], bin: [] };
  await withFetch(googleDrive(drive), async () => {
    const loaded = await createCloudBackend(auth).load();
    assert.deepEqual(loaded, { keyring: null, vault: null });
  });
});

test('OneDrive: a vault deleted outside Secure Box is "gone"', async () => {
  await withFetch(
    () => json({ error: { code: 'itemNotFound', message: 'The resource could not be found.' } }, 404),
    async () => {
      const backend = createOneDriveBackend(auth);
      await assert.rejects(backend.vaultRevision(), { code: 'gone' });
      await assert.rejects(backend.writeVault('{}', 'etag'), { code: 'gone' });
    },
  );
});
