// Minimal zip reader: enough to open the archives mod.io hosts (every mod.io
// upload is a zip). Reads the central directory, including ZIP64 (which .NET
// zip writers use even for small files: 0xFFFFFFFF in the size fields, the real
// sizes in an extra record), supports stored and deflated entries, and
// inflates with the platform's DecompressionStream, so it runs unchanged in a
// Symbiote and in Node 18+. If the directory can't be read, it walks the
// local file headers instead.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const MAX32 = 0xffffffff;

const u64 = (view, off) => view.getUint32(off + 4, true) * 2 ** 32 + view.getUint32(off, true);

// Replace 0xFFFFFFFF fields with the ZIP64 extra record's values, in the order
// the spec gives: uncompressed size, compressed size, local header offset.
function applyZip64(view, extraStart, extraLen, fields) {
  let p = extraStart;
  const end = extraStart + extraLen;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const len = view.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      for (const k of ['size', 'compressedSize', 'offset']) {
        if (k in fields && fields[k] === MAX32 && q + 8 <= p + 4 + len) {
          fields[k] = u64(view, q);
          q += 8;
        }
      }
      return fields;
    }
    p += 4 + len;
  }
  return fields;
}

export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// -> [{ name, method, compressedSize, size, offset }]
export function zipEntries(bytes) {
  try {
    return centralEntries(bytes);
  } catch (e) {
    const local = localEntries(bytes);
    if (local.length) return local;
    throw e;
  }
}

function centralEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  let count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  // ZIP64 end of central directory, found through the locator just before
  const loc = eocd - 20;
  if (loc >= 0 && view.getUint32(loc, true) === ZIP64_LOCATOR_SIG) {
    const z = u64(view, loc + 8);
    if (z + 56 <= bytes.length && view.getUint32(z, true) === ZIP64_EOCD_SIG) {
      count = u64(view, z + 32);
      off = u64(view, z + 48);
    }
  }
  const out = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.length || view.getUint32(off, true) !== CENTRAL_SIG) throw new Error('corrupt zip central directory');
    const method = view.getUint16(off + 10, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    const f = applyZip64(view, off + 46 + nameLen, extraLen, {
      size: view.getUint32(off + 24, true),
      compressedSize: view.getUint32(off + 20, true),
      offset: view.getUint32(off + 42, true),
    });
    out.push({ name, method, compressedSize: f.compressedSize, size: f.size, offset: f.offset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Fallback: walk local file headers from the start. Entries whose sizes are
// only in a trailing data descriptor can't be walked past.
function localEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = [];
  let off = 0;
  while (off + 30 <= bytes.length && view.getUint32(off, true) === LOCAL_SIG) {
    const flags = view.getUint16(off + 6, true);
    const method = view.getUint16(off + 8, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = dec.decode(bytes.subarray(off + 30, off + 30 + nameLen));
    const f = applyZip64(view, off + 30 + nameLen, extraLen, { size: view.getUint32(off + 22, true), compressedSize: view.getUint32(off + 18, true) });
    if ((flags & 8) && f.compressedSize === 0) break;
    out.push({ name, method, compressedSize: f.compressedSize, size: f.size, offset: off });
    off += 30 + nameLen + extraLen + f.compressedSize;
    if (flags & 8) off += view.getUint32(off, true) === 0x08074b50 ? 16 : 12;
  }
  return out;
}

// -> Uint8Array of the entry's uncompressed content.
export async function zipEntryData(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LOCAL_SIG) throw new Error(`corrupt zip entry ${entry.name}`);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`zip entry ${entry.name} uses unsupported compression method ${entry.method}`);
}

// -> [{ name, data }] for every file (not directories), smallest first.
// Entries that are too big (or unreadable) are skipped, not fatal: a slab
// next to a large preview image still comes through.
export async function unzip(bytes, { maxEntries = 64, maxBytes = 32 * 1024 * 1024 } = {}) {
  const entries = zipEntries(bytes).filter((e) => !e.name.endsWith('/'));
  if (entries.length > maxEntries) throw new Error(`zip has ${entries.length} files; too many`);
  const out = [];
  let total = 0;
  for (const e of entries.sort((a, b) => a.size - b.size)) {
    if (total + e.size > maxBytes || e.compressedSize > bytes.length) continue;
    try {
      const data = await zipEntryData(bytes, e);
      total += data.length;
      out.push({ name: e.name, data });
    } catch {
      // unreadable entry: try the others
    }
  }
  if (!out.length && entries.length) throw new Error(`none of its ${entries.length} file(s) could be read`);
  return out;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- writing (tests and exports): stored or deflated entries ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// files: [{ name, data: Uint8Array|string }]
// zip64: write the sizes and offsets the way .NET writers do (0xFFFFFFFF in
// the fields, real values in ZIP64 extra records and end records).
export async function zip(files, { deflate = true, zip64 = false } = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const comp = deflate ? await deflateRaw(raw) : raw;
    const name = enc.encode(f.name);
    const crc = crc32(raw);
    const z64 = (vals) => {
      const x = new Uint8Array(4 + 8 * vals.length);
      const xv = new DataView(x.buffer);
      xv.setUint16(0, 1, true);
      xv.setUint16(2, 8 * vals.length, true);
      vals.forEach((v, i) => {
        xv.setUint32(4 + 8 * i, v % 2 ** 32, true);
        xv.setUint32(8 + 8 * i, Math.floor(v / 2 ** 32), true);
      });
      return x;
    };
    const lx = zip64 ? z64([raw.length, comp.length]) : new Uint8Array(0);
    const local = new Uint8Array(30 + name.length + lx.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, zip64 ? 45 : 20, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, zip64 ? MAX32 : comp.length, true);
    lv.setUint32(22, zip64 ? MAX32 : raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, lx.length, true);
    local.set(name, 30);
    local.set(lx, 30 + name.length);
    const cx = zip64 ? z64([raw.length, comp.length, offset]) : new Uint8Array(0);
    const central = new Uint8Array(46 + name.length + cx.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, zip64 ? 45 : 20, true);
    cv.setUint16(6, zip64 ? 45 : 20, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, zip64 ? MAX32 : comp.length, true);
    cv.setUint32(24, zip64 ? MAX32 : raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, cx.length, true);
    cv.setUint32(42, zip64 ? MAX32 : offset, true);
    central.set(name, 46);
    central.set(cx, 46 + name.length);
    locals.push(local, comp);
    centrals.push(central);
    offset += local.length + comp.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const tail = [];
  if (zip64) {
    const rec = new Uint8Array(56);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, ZIP64_EOCD_SIG, true);
    rv.setUint32(4, 44, true);
    rv.setUint16(12, 45, true);
    rv.setUint32(24, files.length, true);
    rv.setUint32(32, files.length, true);
    rv.setUint32(40, cdSize, true);
    rv.setUint32(48, offset, true);
    const locator = new Uint8Array(20);
    const xv = new DataView(locator.buffer);
    xv.setUint32(0, ZIP64_LOCATOR_SIG, true);
    xv.setUint32(8, offset + cdSize, true);
    xv.setUint32(16, 1, true);
    tail.push(rec, locator);
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, zip64 ? 0xffff : files.length, true);
  ev.setUint16(10, zip64 ? 0xffff : files.length, true);
  ev.setUint32(12, zip64 ? MAX32 : cdSize, true);
  ev.setUint32(16, zip64 ? MAX32 : offset, true);
  const parts = [...locals, ...centrals, ...tail, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
