// Small decompressors that report where their stream ends.
//
// The platform's DecompressionStream needs the compressed bytes cut exactly:
// trailing data is an error, and the output decoded so far is lost. Slab data
// inside a TaleSpire slab file sits between other fields, so these decode from
// an offset and return { data, end }, where `end` is the first byte after the
// stream. Plain JS, so they run unchanged in a Symbiote and in Node.
//
//   inflateRaw  DEFLATE (RFC 1951)
//   gunzipAt    gzip member (RFC 1952), CRC and size checked
//   zlibAt      zlib stream (RFC 1950), Adler-32 checked
//   lz4BlockAt  LZ4 block (no frame), for a known compressed length
//   lz4FrameAt  LZ4 frame (magic 0x184D2204)
//
// `expect` (a byte prefix) stops early when the output can't be what the
// caller is looking for, which keeps blind scans of a file cheap.

import { crc32 } from './zip.js';

export class InflateError extends Error {}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const DEFAULT_MAX = 64 * 1024 * 1024;

// Growable output with an early check against `expect`.
class Out {
  constructor(maxOut, expect) {
    this.buf = new Uint8Array(1024);
    this.n = 0;
    this.max = maxOut;
    this.expect = expect;
  }
  grow(need) {
    if (this.n + need > this.max) throw new InflateError(`output over ${this.max} bytes`);
    if (this.n + need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + need) size *= 2;
    const b = new Uint8Array(Math.min(size, this.max));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  check() {
    const e = this.expect;
    if (!e) return;
    const k = Math.min(this.n, e.length);
    for (let i = 0; i < k; i++) if (this.buf[i] !== e[i]) throw new InflateError('not the expected data');
    if (this.n >= e.length) this.expect = null;
  }
  byte(v) {
    this.grow(1);
    this.buf[this.n++] = v;
    if (this.expect) this.check();
  }
  copy(src, start, len) {
    this.grow(len);
    this.buf.set(src.subarray(start, start + len), this.n);
    this.n += len;
    if (this.expect) this.check();
  }
  repeat(dist, len) {
    if (dist > this.n || dist <= 0) throw new InflateError('distance too far back');
    this.grow(len);
    const b = this.buf;
    for (let i = 0; i < len; i++, this.n++) b[this.n] = b[this.n - dist];
    if (this.expect) this.check();
  }
  done() {
    if (this.expect && this.n < this.expect.length) throw new InflateError('output too short');
    return this.buf.slice(0, this.n);
  }
}

// Canonical Huffman table: counts per code length, symbols in code order.
function huffman(lengths, n) {
  const counts = new Uint16Array(16);
  for (let s = 0; s < n; s++) counts[lengths[s]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new InflateError('over-subscribed code');
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Uint16Array(n);
  for (let s = 0; s < n; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: huffman(l, 288), dist: huffman(d, 30) };
  return FIXED;
}

// -> { data, end }
export function inflateRaw(bytes, start = 0, { maxOut = DEFAULT_MAX, expect = null } = {}) {
  let pos = start;
  let bitbuf = 0;
  let bitcnt = 0;
  const bits = (need) => {
    let v = bitbuf;
    while (bitcnt < need) {
      if (pos >= bytes.length) throw new InflateError('compressed data ends early');
      v |= bytes[pos++] << bitcnt;
      bitcnt += 8;
    }
    bitbuf = v >>> need;
    bitcnt -= need;
    return v & ((1 << need) - 1);
  };
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError('bad code');
  };
  const out = new Out(maxOut, expect);
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > bytes.length) throw new InflateError('compressed data ends early');
      const len = bytes[pos] | (bytes[pos + 1] << 8);
      const nlen = bytes[pos + 2] | (bytes[pos + 3] << 8);
      if (len !== (~nlen & 0xffff)) throw new InflateError('bad stored block');
      pos += 4;
      if (pos + len > bytes.length) throw new InflateError('compressed data ends early');
      out.copy(bytes, pos, len);
      pos += len;
      continue;
    }
    let lit;
    let dist;
    if (type === 1) ({ lit, dist } = fixedTables());
    else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new InflateError('bad table sizes');
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
      const lencode = huffman(lengths, 19);
      lengths.fill(0);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(lencode);
        if (sym < 16) lengths[i++] = sym;
        else {
          let len = 0;
          let rep;
          if (sym === 16) {
            if (i === 0) throw new InflateError('repeat with no previous length');
            len = lengths[i - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > nlen + ndist) throw new InflateError('too many lengths');
          while (rep--) lengths[i++] = len;
        }
      }
      if (!lengths[256]) throw new InflateError('no end-of-block code');
      lit = huffman(lengths.subarray(0, nlen), nlen);
      dist = huffman(lengths.subarray(nlen, nlen + ndist), ndist);
    } else throw new InflateError('bad block type');
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) out.byte(sym);
      else if (sym === 256) break;
      else {
        sym -= 257;
        if (sym >= 29) throw new InflateError('bad length code');
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        if (ds >= 30) throw new InflateError('bad distance code');
        out.repeat(DBASE[ds] + bits(DEXT[ds]), len);
      }
    }
  }
  return { data: out.done(), end: pos };
}

export const isGzipAt = (b, i) => b[i] === 0x1f && b[i + 1] === 0x8b && b[i + 2] === 0x08 && (b[i + 3] & 0xe0) === 0;

// -> { data, end }
export function gunzipAt(bytes, start = 0, opts = {}) {
  if (!isGzipAt(bytes, start)) throw new InflateError('no gzip header');
  const flags = bytes[start + 3];
  let p = start + 10;
  if (flags & 4) p += 2 + (bytes[p] | (bytes[p + 1] << 8));
  if (flags & 8) while (p < bytes.length && bytes[p++]);
  if (flags & 16) while (p < bytes.length && bytes[p++]);
  if (flags & 2) p += 2;
  if (p >= bytes.length) throw new InflateError('gzip header runs off the end');
  const { data, end } = inflateRaw(bytes, p, opts);
  if (end + 8 > bytes.length) throw new InflateError('gzip trailer missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(end, true) !== crc32(data)) throw new InflateError('gzip CRC mismatch');
  if (view.getUint32(end + 4, true) !== data.length >>> 0) throw new InflateError('gzip size mismatch');
  return { data, end: end + 8 };
}

export const isZlibAt = (b, i) => (b[i] & 0x0f) === 8 && b[i] >> 4 <= 7 && !(b[i + 1] & 0x20) && ((b[i] << 8) | b[i + 1]) % 31 === 0;

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const stop = Math.min(i + 3800, data.length);
    for (; i < stop; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// -> { data, end }
export function zlibAt(bytes, start = 0, opts = {}) {
  if (!isZlibAt(bytes, start)) throw new InflateError('no zlib header');
  const { data, end } = inflateRaw(bytes, start + 2, opts);
  if (end + 4 > bytes.length) throw new InflateError('zlib checksum missing');
  const sum = ((bytes[end] << 24) | (bytes[end + 1] << 16) | (bytes[end + 2] << 8) | bytes[end + 3]) >>> 0;
  if (sum !== adler32(data)) throw new InflateError('zlib checksum mismatch');
  return { data, end: end + 4 };
}

// One LZ4 block from `start` to `stop` (its compressed length must be known).
function lz4Into(out, bytes, start, stop) {
  let i = start;
  while (i < stop) {
    const token = bytes[i++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        if (i >= stop) throw new InflateError('LZ4 literal length runs off the end');
        b = bytes[i++];
        lit += b;
      } while (b === 255);
    }
    if (i + lit > stop) throw new InflateError('LZ4 literals run off the end');
    out.copy(bytes, i, lit);
    i += lit;
    if (i === stop) return;
    if (i + 2 > stop) throw new InflateError('LZ4 offset runs off the end');
    const off = bytes[i] | (bytes[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) {
      let b;
      do {
        if (i >= stop) throw new InflateError('LZ4 match length runs off the end');
        b = bytes[i++];
        len += b;
      } while (b === 255);
    }
    out.repeat(off, len + 4);
  }
}

export function lz4BlockAt(bytes, start, length, { maxOut = DEFAULT_MAX, expect = null } = {}) {
  const stop = start + length;
  if (length <= 0 || stop > bytes.length) throw new InflateError('LZ4 block outside the data');
  const out = new Out(maxOut, expect);
  lz4Into(out, bytes, start, stop);
  return { data: out.done(), end: stop };
}

export const isLz4FrameAt = (b, i) => b[i] === 0x04 && b[i + 1] === 0x22 && b[i + 2] === 0x4d && b[i + 3] === 0x18;

export function lz4FrameAt(bytes, start = 0, { maxOut = DEFAULT_MAX, expect = null } = {}) {
  if (!isLz4FrameAt(bytes, start)) throw new InflateError('no LZ4 frame header');
  const flg = bytes[start + 4];
  if (flg >> 6 !== 1) throw new InflateError('unknown LZ4 frame version');
  let p = start + 6 + (flg & 8 ? 8 : 0) + (flg & 1 ? 4 : 0) + 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Out(maxOut, expect);
  for (;;) {
    if (p + 4 > bytes.length) throw new InflateError('LZ4 frame ends early');
    const word = view.getUint32(p, true);
    p += 4;
    if (word === 0) break;
    const size = word & 0x7fffffff;
    if (p + size > bytes.length) throw new InflateError('LZ4 block runs off the end');
    if (word & 0x80000000) out.copy(bytes, p, size);
    else lz4Into(out, bytes, p, p + size);
    p += size + (flg & 16 ? 4 : 0);
  }
  if (flg & 4) p += 4;
  return { data: out.done(), end: Math.min(p, bytes.length) };
}
