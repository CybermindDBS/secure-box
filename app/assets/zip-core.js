/*
 * Streaming ZIP writer, shared by the service worker ("Download as .zip") and the tests.
 * A classic script (no import/export) so the worker can importScripts() it.
 *
 * Files are STORED, not compressed: photos, videos and most documents are compressed already,
 * and storing keeps the archive's exact size known before it starts, so the browser can show
 * real download progress. Each file's CRC-32 is computed while it streams through and written
 * in a data descriptor right after it. ZIP64 records appear only past 4 GB or 65,535 entries.
 */
(function () {
  'use strict';

  var LOCAL = 30;
  var DESCRIPTOR = 16;
  var CENTRAL = 46;
  var EXTRA64 = 12; // ZIP64 extra field carrying the local header offset only
  var END64 = 56;
  var LOCATOR64 = 20;
  var END = 22;
  var MAX16 = 0xffff;
  var MAX32 = 0xffffffff;
  var FLAG_DESCRIPTOR = 0x0008;
  var FLAG_UTF8 = 0x0800;

  var table = null;

  /** CRC-32 of `bytes`, continuing from `crc` (start with 0). */
  function crc32(crc, bytes) {
    if (!table) {
      table = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    var x = ~crc;
    for (var i = 0; i < bytes.length; i++) x = table[(x ^ bytes[i]) & 0xff] ^ (x >>> 8);
    return ~x >>> 0;
  }

  /**
   * Refuses paths that could escape the folder they are extracted into. The page builds the
   * paths; this is a second check in the worker.
   */
  function checkPath(path, dir) {
    var parts = String(path).split('/');
    if (dir) {
      if (parts.pop() !== '') throw new Error('Folder entries must end with "/".');
    }
    if (!parts.length) throw new Error('Empty path in ZIP.');
    parts.forEach(function (part) {
      if (!part || part === '.' || part === '..' || /[\\\u0000-\u001f]/.test(part)) throw new Error('Unsafe path in ZIP: ' + path);
    });
  }

  function dosDateTime(ms) {
    var d = new Date(Number.isFinite(ms) ? ms : Date.now());
    var year = Math.min(2107, Math.max(1980, d.getFullYear()));
    if (year !== d.getFullYear()) d = new Date(year, 0, 1);
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function setUint64(view, at, value) {
    view.setUint32(at, value % 0x100000000, true);
    view.setUint32(at + 4, Math.floor(value / 0x100000000), true);
  }

  /**
   * Lays out the archive. `entries`: [{ path, dir?, size, mtime, fileId }] in archive order;
   * folder paths end with "/". `options.limit32` lowers the ZIP64 threshold (tests only).
   */
  function plan(entries, options) {
    var limit32 = (options && options.limit32) || MAX32;
    var encoder = new TextEncoder();
    var items = [];
    var offset = 0;
    entries.forEach(function (entry) {
      var dir = Boolean(entry.dir);
      var size = dir ? 0 : Number(entry.size) || 0;
      if (size >= MAX32) throw new Error('Files over 4 GB cannot be zipped.');
      var name = encoder.encode(entry.path);
      if (name.length > MAX16) throw new Error('A path is too long for a ZIP file.');
      items.push({ path: entry.path, name: name, dir: dir, size: size, mtime: entry.mtime, fileId: entry.fileId, offset: offset, zip64: offset >= limit32 });
      offset += LOCAL + name.length + size + (dir ? 0 : DESCRIPTOR);
    });
    var cdSize = items.reduce(function (n, item) {
      return n + CENTRAL + item.name.length + (item.zip64 ? EXTRA64 : 0);
    }, 0);
    var zip64 = items.length >= MAX16 || offset >= limit32 || cdSize >= limit32;
    return { items: items, cdStart: offset, cdSize: cdSize, zip64: zip64, total: offset + cdSize + (zip64 ? END64 + LOCATOR64 : 0) + END };
  }

  function flags(item) {
    return FLAG_UTF8 | (item.dir ? 0 : FLAG_DESCRIPTOR);
  }

  /** Local file header. CRC and sizes come after the data, in the data descriptor. */
  function localHeader(item) {
    var out = new Uint8Array(LOCAL + item.name.length);
    var v = new DataView(out.buffer);
    var t = dosDateTime(item.mtime);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed: 2.0
    v.setUint16(6, flags(item), true);
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, t.time, true);
    v.setUint16(12, t.date, true);
    v.setUint16(26, item.name.length, true);
    out.set(item.name, LOCAL);
    return out;
  }

  function dataDescriptor(item, crc) {
    var out = new Uint8Array(DESCRIPTOR);
    var v = new DataView(out.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, crc, true);
    v.setUint32(8, item.size, true);
    v.setUint32(12, item.size, true);
    return out;
  }

  /** Central directory plus end records; `crcs[i]` is the CRC-32 of item i. */
  function centralDirectory(layout, crcs) {
    var out = new Uint8Array(layout.total - layout.cdStart);
    var v = new DataView(out.buffer);
    var at = 0;
    layout.items.forEach(function (item, i) {
      var t = dosDateTime(item.mtime);
      var version = item.zip64 ? 45 : 20;
      v.setUint32(at, 0x02014b50, true);
      v.setUint16(at + 4, version, true); // made by: MS-DOS attributes
      v.setUint16(at + 6, version, true);
      v.setUint16(at + 8, flags(item), true);
      v.setUint16(at + 12, t.time, true);
      v.setUint16(at + 14, t.date, true);
      v.setUint32(at + 16, item.dir ? 0 : crcs[i] >>> 0, true);
      v.setUint32(at + 20, item.size, true);
      v.setUint32(at + 24, item.size, true);
      v.setUint16(at + 28, item.name.length, true);
      v.setUint16(at + 30, item.zip64 ? EXTRA64 : 0, true);
      v.setUint32(at + 38, item.dir ? 0x10 : 0, true); // MS-DOS directory attribute
      v.setUint32(at + 42, item.zip64 ? MAX32 : item.offset, true);
      out.set(item.name, at + CENTRAL);
      at += CENTRAL + item.name.length;
      if (item.zip64) {
        v.setUint16(at, 0x0001, true);
        v.setUint16(at + 2, 8, true);
        setUint64(v, at + 4, item.offset);
        at += EXTRA64;
      }
    });
    var count = layout.items.length;
    if (layout.zip64) {
      var end64At = layout.cdStart + layout.cdSize;
      v.setUint32(at, 0x06064b50, true);
      setUint64(v, at + 4, END64 - 12);
      v.setUint16(at + 12, 45, true);
      v.setUint16(at + 14, 45, true);
      setUint64(v, at + 24, count);
      setUint64(v, at + 32, count);
      setUint64(v, at + 40, layout.cdSize);
      setUint64(v, at + 48, layout.cdStart);
      at += END64;
      v.setUint32(at, 0x07064b50, true);
      setUint64(v, at + 8, end64At);
      v.setUint32(at + 16, 1, true);
      at += LOCATOR64;
    }
    v.setUint32(at, 0x06054b50, true);
    v.setUint16(at + 8, layout.zip64 ? MAX16 : count, true);
    v.setUint16(at + 10, layout.zip64 ? MAX16 : count, true);
    v.setUint32(at + 12, layout.zip64 ? MAX32 : layout.cdSize, true);
    v.setUint32(at + 16, layout.zip64 ? MAX32 : layout.cdStart, true);
    return out;
  }

  globalThis.UniboxZip = {
    crc32: crc32,
    checkPath: checkPath,
    plan: plan,
    localHeader: localHeader,
    dataDescriptor: dataDescriptor,
    centralDirectory: centralDirectory,
  };
})();
