/*
 * Random-access decryption of the Secure Box file format ("SECBOXF1", see fileformat.js),
 * for the service worker. Classic script (loaded with importScripts) that also works as an
 * ES module in Node for tests. Defines globalThis.UniboxStream.
 */
(function (global) {
  'use strict';
  var TAG = 16;
  var HEADER = 35;
  var MAGIC = 'SECBOXF1';

  function padme(length) {
    var L = Math.max(length, 256);
    var E = Math.floor(Math.log2(L));
    var S = Math.floor(Math.log2(E)) + 1;
    var step = Math.pow(2, E - S);
    return Math.ceil(L / step) * step;
  }

  function plan(entry) {
    var chunk = entry.chunk;
    var padded = padme(entry.size);
    var contentChunks = Math.max(1, Math.ceil(padded / chunk));
    var thumbChunks = entry.thumbBytes ? Math.max(1, Math.ceil(entry.thumbBytes / chunk)) : 0;
    var thumbEncrypted = entry.thumbBytes ? entry.thumbBytes + thumbChunks * TAG : 0;
    return {
      chunk: chunk,
      padded: padded,
      contentChunks: contentChunks,
      thumbChunks: thumbChunks,
      contentStart: HEADER + thumbEncrypted,
      total: HEADER + thumbEncrypted + padded + contentChunks * TAG,
    };
  }

  /** Encrypted byte span [start, end] (inclusive) holding plaintext bytes [from, to]. */
  function span(p, from, to) {
    var first = Math.floor(from / p.chunk);
    var last = Math.floor(to / p.chunk);
    var lastPlain = Math.min(p.chunk, p.padded - last * p.chunk);
    return {
      first: first,
      last: last,
      start: p.contentStart + first * (p.chunk + TAG),
      end: p.contentStart + last * (p.chunk + TAG) + lastPlain + TAG - 1,
    };
  }

  function chunkLength(p, index) {
    return Math.min(p.chunk, p.padded - index * p.chunk) + TAG;
  }

  function nonce(prefix, index, flag) {
    var n = new Uint8Array(12);
    n.set(prefix, 0);
    new DataView(n.buffer).setUint32(7, index);
    n[11] = flag;
    return n;
  }

  function uuidBytes(id) {
    var hex = String(id).replace(/-/g, '');
    var out = new Uint8Array(16);
    for (var i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /** Checks the 35-byte header against the vault record and returns the nonce prefix. */
  function checkHeader(header, entry) {
    if (String.fromCharCode.apply(null, Array.prototype.slice.call(header, 0, 8)) !== MAGIC) throw new Error('Not a Secure Box encrypted file.');
    if (new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8) !== entry.chunk) throw new Error('File does not match its record.');
    var id = uuidBytes(entry.id);
    for (var j = 0; j < 16; j++) if (header[19 + j] !== id[j]) throw new Error('File belongs to a different record.');
    return header.slice(12, 19);
  }

  function base64UrlToBytes(text) {
    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function importKey(entry) {
    return crypto.subtle.importKey('raw', base64UrlToBytes(entry.key), { name: 'AES-GCM' }, false, ['decrypt']);
  }

  function decryptChunk(key, prefix, index, flag, header, sealed) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(prefix, index, flag), additionalData: header }, key, sealed).then(
      function (plain) {
        return new Uint8Array(plain);
      },
      function () {
        throw new Error('Integrity check failed: the file is damaged or was tampered with.');
      },
    );
  }

  /** Pulls exact byte counts out of a ReadableStream. */
  function Reader(stream) {
    this.reader = stream.getReader();
    this.chunks = [];
    this.length = 0;
  }
  Reader.prototype.read = async function (n) {
    while (this.length < n) {
      var r = await this.reader.read();
      if (r.done) throw new Error('The encrypted file ended early.');
      if (r.value && r.value.length) {
        this.chunks.push(r.value);
        this.length += r.value.length;
      }
    }
    var out = new Uint8Array(n);
    var offset = 0;
    while (offset < n) {
      var head = this.chunks[0];
      var take = Math.min(head.length, n - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    return out;
  };
  Reader.prototype.cancel = function () {
    try {
      this.reader.cancel();
    } catch (e) {
      /* ignore */
    }
  };

  global.UniboxStream = {
    HEADER: HEADER,
    TAG: TAG,
    padme: padme,
    plan: plan,
    span: span,
    chunkLength: chunkLength,
    nonce: nonce,
    checkHeader: checkHeader,
    importKey: importKey,
    decryptChunk: decryptChunk,
    Reader: Reader,
  };
})(typeof self !== 'undefined' ? self : globalThis);
