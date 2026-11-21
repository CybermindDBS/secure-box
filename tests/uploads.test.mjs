// Uploads survive a passing failure (#20): a piece lost in transit is sent again, from where the
// cloud says it got to, instead of failing the whole file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Drive } from '../src/core/google.js';
import { OneDrive } from '../src/core/microsoft.js';
import { backoff, transient } from '../src/core/retry.js';

test('which failures are worth trying again', () => {
  assert.equal(transient({ code: 'network' }), true);
  assert.equal(transient({ status: 429 }), true);
  assert.equal(transient({ status: 500 }), true);
  assert.equal(transient({ status: 503 }), true);
  assert.equal(transient({ status: 507 }), false); // storage full: trying again won't help
  assert.equal(transient({ status: 401 }), false); // signed out: needs Reconnect
  assert.equal(transient({ status: 403 }), false);
  assert.equal(transient({ name: 'AbortError', code: 'network' }), false); // stopped on purpose
  assert.ok(backoff(0) >= 1000 && backoff(0) < 1400);
  assert.equal(backoff(3, 5), 5000); // Retry-After wins
  assert.equal(backoff(20), 30_000);
});

/** Runs `body` with fetch answered by `answer(url, init)`; returns the requests made. */
async function withFetch(answer, body) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', range: init.headers?.['Content-Range'] });
    return answer(String(url), init);
  };
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

test('Google Drive: a piece lost in transit is resumed from where Drive got to', async () => {
  const SESSION = 'https://upload.example/drive-session';
  let puts = 0;
  let id = null;
  const calls = await withFetch(
    (url, init) => {
      if (url.includes('uploadType=resumable')) return new Response('{}', { status: 200, headers: { Location: SESSION } });
      if (url !== SESSION) throw new Error(`unexpected ${url}`);
      const range = init.headers['Content-Range'];
      if (range === 'bytes */100') return new Response('', { status: 308, headers: { Range: 'bytes=0-59' } }); // Drive has 60 bytes
      puts++;
      if (puts === 1) throw new TypeError('Failed to fetch'); // the first try never got an answer
      if (range === 'bytes 60-99/100') return new Response(JSON.stringify({ id: 'drive-file-1' }), { status: 200 });
      return new Response(`unexpected range ${range}`, { status: 400 });
    },
    async () => {
      const send = await new Drive(() => 'token').startUpload({ name: 'fid', parentId: 'parent', size: 100, appProperties: {} });
      id = await send(new Uint8Array(100), 0, 100);
    },
  );
  assert.equal(id, 'drive-file-1');
  assert.deepEqual(
    calls.filter((c) => c.url === SESSION).map((c) => c.range),
    ['bytes 0-99/100', 'bytes */100', 'bytes 60-99/100'],
  );
});

test('Google Drive: when the whole piece had arrived, only the answer is fetched again', async () => {
  const SESSION = 'https://upload.example/drive-session-2';
  let puts = 0;
  let result = 'unset';
  await withFetch(
    (url, init) => {
      if (url.includes('uploadType=resumable')) return new Response('{}', { status: 200, headers: { Location: SESSION } });
      if (init.headers['Content-Range'] === 'bytes */200') return new Response('', { status: 308, headers: { Range: 'bytes=0-99' } });
      puts++;
      if (puts === 1) return new Response('Service unavailable', { status: 503 });
      throw new Error('the piece must not be sent twice');
    },
    async () => {
      const send = await new Drive(() => 'token').startUpload({ name: 'fid', parentId: 'parent', size: 200, appProperties: {} });
      result = await send(new Uint8Array(100), 0, 200); // the first of two pieces
    },
  );
  assert.equal(result, null); // more to come; nothing sent twice
});

test('OneDrive: a piece lost in transit is resumed from the next byte OneDrive expects', async () => {
  const UPLOAD = 'https://upload.example/onedrive-session';
  let puts = 0;
  let id = null;
  const calls = await withFetch(
    (url, init) => {
      if (url.includes('createUploadSession')) return new Response(JSON.stringify({ uploadUrl: UPLOAD }), { status: 200 });
      if (url !== UPLOAD) throw new Error(`unexpected ${url}`);
      if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ nextExpectedRanges: ['60-'] }), { status: 200 });
      puts++;
      if (puts === 1) throw new TypeError('Failed to fetch');
      if (init.headers['Content-Range'] === 'bytes 60-99/100') return new Response(JSON.stringify({ id: 'onedrive-file-1' }), { status: 201 });
      return new Response('unexpected', { status: 400 });
    },
    async () => {
      const send = await new OneDrive(() => 'token').startUpload({ parentId: 'folder-id', name: 'fid' });
      id = await send(new Uint8Array(100), 0, 100);
    },
  );
  assert.equal(id, 'onedrive-file-1');
  assert.deepEqual(
    calls.filter((c) => c.url === UPLOAD).map((c) => `${c.method} ${c.range || ''}`.trim()),
    ['PUT bytes 0-99/100', 'GET', 'PUT bytes 60-99/100'],
  );
});

test('a failure that won’t pass by itself fails at once', async () => {
  const SESSION = 'https://upload.example/drive-session-3';
  await withFetch(
    (url) => {
      if (url.includes('uploadType=resumable')) return new Response('{}', { status: 200, headers: { Location: SESSION } });
      return new Response(JSON.stringify({ error: { message: 'Insufficient permissions', errors: [{ reason: 'insufficientPermissions' }] } }), { status: 403 });
    },
    async () => {
      const send = await new Drive(() => 'token').startUpload({ name: 'fid', parentId: 'parent', size: 100, appProperties: {} });
      await assert.rejects(send(new Uint8Array(100), 0, 100), { code: 'drive-scope' });
    },
  );
});
