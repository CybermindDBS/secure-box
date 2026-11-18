/*
 * Secure Box service worker: a private, in-browser "server" for encrypted files.
 *
 * Requests to <app>/__unibox/file/<id> are answered by fetching the encrypted bytes from
 * Google Drive (HTTP Range requests) and decrypting chunk by chunk as they stream in, so
 * videos can seek and nothing is downloaded in full. Responses are marked no-store and
 * nothing is ever written to Cache Storage, IndexedDB or disk by this worker.
 * File keys and the Drive token are asked from the open Secure Box tab when needed and kept in
 * memory for at most a minute.
 */
importScripts('assets/stream-core.js', 'assets/zip-core.js');
var S = self.UniboxStream;
var Z = self.UniboxZip;
var PREFIX = new URL('./__unibox/file/', self.registration.scope).pathname;
var ZIP_PREFIX = new URL('./__unibox/zip/', self.registration.scope).pathname;
var known = new Map(); // file id -> { info, expires }

self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'unibox-forget') known.clear();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  var handler = url.pathname.indexOf(PREFIX) === 0 ? serve : url.pathname.indexOf(ZIP_PREFIX) === 0 ? serveZip : null;
  if (!handler) return;
  event.respondWith(
    handler(event, url).catch(function (err) {
      var status = err && err.status ? err.status : 500;
      return new Response(String((err && err.message) || err), { status: status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }),
  );
});

function httpError(status, message) {
  var err = new Error(message);
  err.status = status;
  return err;
}

async function ask(message, clientId) {
  var answer = await askWindows(message, clientId);
  return answer && answer.data;
}

/** Asks the Secure Box windows in turn; resolves with { data, clientId } of the first that knows. */
async function askWindows(message, clientId) {
  var clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // The asking page first, then focused and visible windows: a frozen background tab answers
  // slowly, and downloads (frame navigations) carry no client id of their own.
  var rank = function (c) {
    return (c.id === clientId ? 4 : 0) + (c.focused ? 2 : 0) + (c.visibilityState === 'visible' ? 1 : 0);
  };
  clients.sort(function (a, b) {
    return rank(b) - rank(a);
  });
  for (var i = 0; i < clients.length; i++) {
    var reply = await new Promise(function (resolve) {
      var channel = new MessageChannel();
      var timer = setTimeout(function () {
        resolve(null);
      }, 4000);
      channel.port1.onmessage = function (e) {
        clearTimeout(timer);
        resolve(e.data);
      };
      clients[i].postMessage(message, [channel.port2]);
    });
    if (reply && !reply.error) return { data: reply, clientId: clients[i].id };
  }
  return null;
}

async function describe(fileId, clientId) {
  var hit = known.get(fileId);
  if (hit && hit.expires > Date.now()) return hit.info;
  var answer = await askWindows({ type: 'unibox-describe', fileId: fileId }, clientId);
  if (!answer) throw httpError(403, 'Secure Box is locked.');
  var info = answer.data;
  info.plan = S.plan(info.entry);
  info.key = await S.importKey(info.entry);
  // Later questions about this file go to the window that knew it (the demo keeps its sample
  // files per window, and downloads arrive without a window of their own).
  info.clientId = answer.clientId;
  known.set(fileId, { info: info, expires: Date.now() + 60000 });
  return info;
}

/** A stream of encrypted bytes [start, end] of the file. */
async function encrypted(info, start, end, signal) {
  if (info.source === 'page') {
    var reply = await ask({ type: 'unibox-read', driveId: info.entry.driveId, start: start, end: end }, info.clientId);
    if (!reply || !reply.bytes) throw httpError(502, 'Could not read the file.');
    return new Blob([reply.bytes]).stream();
  }
  var res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(info.entry.driveId) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + info.token, Range: 'bytes=' + start + '-' + end },
    cache: 'no-store',
    credentials: 'omit',
    signal: signal,
  });
  if (res.status === 401 || res.status === 403) {
    known.delete(info.entry.id);
    throw httpError(401, 'Google Drive access expired. Reconnect in Secure Box.');
  }
  if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, 'Google Drive returned ' + res.status + '.');
  return res.status === 200 ? window_(res.body, start, end - start + 1) : res.body;
}

/** If Drive ever ignores the Range header, cut the wanted window out of the full stream. */
function window_(stream, skip, length) {
  var reader = stream.getReader();
  return new ReadableStream({
    pull: async function (c) {
      for (;;) {
        var r = await reader.read();
        if (r.done) return c.close();
        var chunk = r.value;
        if (skip) {
          if (chunk.length <= skip) {
            skip -= chunk.length;
            continue;
          }
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        if (chunk.length > length) chunk = chunk.subarray(0, length);
        length -= chunk.length;
        c.enqueue(chunk);
        if (!length) {
          reader.cancel();
          c.close();
        }
        return;
      }
    },
    cancel: function () {
      reader.cancel();
    },
  });
}

async function header(info) {
  if (info.prefix) return;
  var reader = new S.Reader(await encrypted(info, 0, S.HEADER - 1));
  var bytes = await reader.read(S.HEADER);
  reader.cancel();
  info.prefix = S.checkHeader(bytes, info.entry);
  info.header = bytes;
}

function headersFor(entry, extra) {
  var h = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  Object.keys(extra).forEach(function (k) {
    h.set(k, extra[k]);
  });
  return h;
}

function inlineType(type) {
  // Never let a stored file act as a web page of this site.
  if (/^(text\/html|application\/xhtml\+xml|application\/xml|text\/xml)/i.test(type)) return 'text/plain; charset=utf-8';
  return type || 'application/octet-stream';
}

async function serve(event, url) {
  var fileId = decodeURIComponent(url.pathname.slice(PREFIX.length));
  var info = await describe(fileId, event.clientId);
  var entry = info.entry;
  var p = info.plan;

  if (url.searchParams.get('part') === 'thumb') {
    if (!p.thumbChunks) throw httpError(404, 'No thumbnail.');
    var thumbReader = new S.Reader(await encrypted(info, 0, p.contentStart - 1));
    var head = await thumbReader.read(S.HEADER);
    if (!info.prefix) {
      info.prefix = S.checkHeader(head, entry);
      info.header = head;
    }
    var parts = [];
    for (var t = 0; t < p.thumbChunks; t++) {
      var len = Math.min(p.chunk, entry.thumbBytes - t * p.chunk);
      var sealedThumb = await thumbReader.read(len + S.TAG);
      parts.push(await S.decryptChunk(info.key, info.prefix, t, t === p.thumbChunks - 1 ? 3 : 2, info.header, sealedThumb));
    }
    thumbReader.cancel();
    return new Response(new Blob(parts, { type: 'image/jpeg' }), { headers: headersFor(entry, { 'Content-Type': 'image/jpeg' }) });
  }

  var download = url.searchParams.has('download');
  var size = entry.size;
  var type = download ? entry.type || 'application/octet-stream' : inlineType(entry.type);
  var disposition = (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(entry.name);
  var base = { 'Content-Type': type, 'Content-Disposition': disposition, 'Accept-Ranges': 'bytes' };
  if (!download && entry.type !== 'application/pdf') base['Content-Security-Policy'] = "default-src 'none'; sandbox";
  if (size === 0) return new Response(new Uint8Array(0), { headers: headersFor(entry, Object.assign(base, { 'Content-Length': '0' })) });

  var from = 0;
  var to = size - 1;
  var status = 200;
  var range = /^bytes=(\d*)-(\d*)$/.exec((event.request.headers.get('range') || '').trim());
  if (range && (range[1] || range[2])) {
    if (range[1] === '') from = Math.max(0, size - Number(range[2]));
    else {
      from = Number(range[1]);
      if (range[2]) to = Math.min(Number(range[2]), size - 1);
    }
    if (from > to || from >= size) {
      return new Response(null, { status: 416, headers: headersFor(entry, { 'Content-Range': 'bytes */' + size }) });
    }
    status = 206;
    base['Content-Range'] = 'bytes ' + from + '-' + to + '/' + size;
  }
  base['Content-Length'] = String(to - from + 1);

  await header(info);
  return new Response(plainStream(info, from, to), { status: status, headers: headersFor(entry, base) });
}

/** Decrypted bytes [from, to] of a file, fetched and decrypted chunk by chunk as they're read. */
function plainStream(info, from, to) {
  var p = info.plan;
  var sp = S.span(p, from, to);
  var abort = new AbortController();
  var reader = null;
  var index = sp.first;
  return new ReadableStream(
    {
      pull: async function (controller) {
        try {
          if (!reader) reader = new S.Reader(await encrypted(info, sp.start, sp.end, abort.signal));
          var sealed = await reader.read(S.chunkLength(p, index));
          var plain = await S.decryptChunk(info.key, info.prefix, index, index === p.contentChunks - 1 ? 1 : 0, info.header, sealed);
          var chunkStart = index * p.chunk;
          var a = Math.max(from, chunkStart) - chunkStart;
          var b = Math.min(to + 1, chunkStart + plain.length) - chunkStart;
          if (b > a) controller.enqueue(plain.subarray(a, b));
          index++;
          if (index > sp.last) {
            reader.cancel();
            controller.close();
          }
        } catch (err) {
          abort.abort();
          controller.error(err);
        }
      },
      cancel: function () {
        abort.abort();
        if (reader) reader.cancel();
      },
    },
    { highWaterMark: 2 },
  );
}

/**
 * <app>/__unibox/zip/<job>/<name>.zip: several files and folders as one ZIP, built while it
 * downloads. The page lists the paths and file ids (no keys); each file's key is then asked
 * for as usual, so a locked Secure Box stops the download.
 */
async function serveZip(event, url) {
  var jobId = decodeURIComponent(url.pathname.slice(ZIP_PREFIX.length).split('/')[0] || '');
  var answer = await askWindows({ type: 'unibox-zip', jobId: jobId }, event.clientId);
  var job = answer && answer.data;
  if (!job || !Array.isArray(job.entries) || typeof job.name !== 'string') throw httpError(410, 'This download has expired. Start it again in Secure Box.');
  job.entries.forEach(function (entry) {
    Z.checkPath(entry.path, entry.dir);
  });
  var layout = Z.plan(job.entries);
  // The window that started the download knows every file in it.
  var parts = zipParts(layout, answer.clientId);
  var body = new ReadableStream(
    {
      pull: async function (controller) {
        try {
          var next = await parts.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: function () {
        parts.return();
      },
    },
    { highWaterMark: 2 },
  );
  return new Response(body, {
    headers: headersFor(null, {
      'Content-Type': 'application/zip',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(job.name),
      'Content-Length': String(layout.total),
    }),
  });
}

async function* zipParts(layout, clientId) {
  var crcs = [];
  for (var i = 0; i < layout.items.length; i++) {
    var item = layout.items[i];
    yield Z.localHeader(item);
    if (item.dir) {
      crcs.push(0);
      continue;
    }
    var crc = 0;
    if (item.size > 0) {
      var info = await describe(item.fileId, clientId);
      if (info.entry.size !== item.size) throw httpError(409, 'A file changed while it was being zipped. Try again.');
      await header(info);
      var reader = plainStream(info, 0, item.size - 1).getReader();
      var sent = 0;
      try {
        for (;;) {
          var next = await reader.read();
          if (next.done) break;
          crc = Z.crc32(crc, next.value);
          sent += next.value.length;
          yield next.value;
        }
      } finally {
        reader.cancel().catch(function () {});
      }
      if (sent !== item.size) throw httpError(502, 'A file ended early while it was being zipped.');
    }
    crcs.push(crc);
    yield Z.dataDescriptor(item, crc);
  }
  yield Z.centralDirectory(layout, crcs);
}
