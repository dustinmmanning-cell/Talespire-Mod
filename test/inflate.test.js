import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflateRaw, gunzipAt, zlibAt, lz4BlockAt, lz4FrameAt } from '../src/core/inflate.js';

// Deterministic mixed data: runs, repeats of earlier chunks, and noise.
function sample(seed, size) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Uint8Array(size);
  for (let i = 0; i < size;) {
    const k = Math.min(size - i, 1 + Math.floor(rnd() * 900));
    const mode = rnd();
    for (let j = 0; j < k; j++, i++) {
      if (mode < 0.35) out[i] = Math.floor(rnd() * 256);
      else if (mode < 0.7 && i > 300) out[i] = out[i - 300];
      else out[i] = mode * 10;
    }
  }
  return out;
}

const junk = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
const wrap = (pre, body) => {
  const b = new Uint8Array(pre + body.length + junk.length);
  b.set(body, pre);
  b.set(junk, pre + body.length);
  return b;
};

test('inflate: matches zlib for every level and strategy, and finds where the stream ends', () => {
  for (const [i, size] of [0, 1, 100, 5000, 70000, 300000].entries()) {
    const data = sample(i + 1, size);
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE]) {
        for (const [make, read] of [[zlib.deflateRawSync, inflateRaw], [zlib.gzipSync, gunzipAt], [zlib.deflateSync, zlibAt]]) {
          const c = make(data, { level, strategy });
          const r = read(wrap(5, c), 5);
          assert.deepEqual(r.data, data, `${make.name} level ${level} strategy ${strategy} size ${size}`);
          assert.equal(r.end, 5 + c.length, 'end is the first byte after the stream');
        }
      }
    }
  }
});

test('inflate: bad data fails cleanly, checksums are checked, early exit on unexpected output', () => {
  const data = sample(9, 2000);
  const gz = new Uint8Array(zlib.gzipSync(data));
  gz[gz.length - 6] ^= 1;
  assert.throws(() => gunzipAt(gz, 0), /CRC mismatch/);
  const z = new Uint8Array(zlib.deflateSync(data));
  z[z.length - 1] ^= 1;
  assert.throws(() => zlibAt(z, 0), /checksum mismatch/);
  assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 0), /bad block type|ends early|bad code/);
  const full = new Uint8Array(zlib.deflateRawSync(data));
  assert.throws(() => inflateRaw(full.subarray(0, full.length >> 1), 0), /ends early/);
  assert.throws(() => inflateRaw(full, 0, { expect: new Uint8Array([data[0] ^ 1]) }), /not the expected data/);
  assert.throws(() => inflateRaw(full, 0, { maxOut: 100 }), /output over 100 bytes/);
  assert.deepEqual(inflateRaw(full, 0, { expect: data.subarray(0, 4) }).data, data);
});

// A small greedy LZ4 block compressor, enough to exercise the decoder.
function lz4Compress(src) {
  const out = [];
  const table = new Map();
  const len = (v) => {
    for (v -= 15; v >= 255; v -= 255) out.push(255);
    out.push(v);
  };
  const seq = (anchor, end, offset, match) => {
    const lit = end - anchor;
    out.push((Math.min(lit, 15) << 4) | (offset ? Math.min(match - 4, 15) : 0));
    if (lit >= 15) len(lit);
    for (let k = anchor; k < end; k++) out.push(src[k]);
    if (!offset) return;
    out.push(offset & 255, offset >> 8);
    if (match - 4 >= 15) len(match - 4);
  };
  let anchor = 0;
  let i = 0;
  while (i + 4 <= src.length - 5) {
    const key = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
    const ref = table.get(key);
    table.set(key, i);
    if (ref !== undefined && i - ref < 65536) {
      let m = 4;
      while (i + m < src.length - 5 && src[ref + m] === src[i + m]) m++;
      seq(anchor, i, i - ref, m);
      i += m;
      anchor = i;
    } else i++;
  }
  seq(anchor, src.length, 0, 0);
  return new Uint8Array(out);
}

test('LZ4: blocks and frames decode, overlapping matches included', () => {
  for (const [i, size] of [20, 4000, 100000].entries()) {
    const data = sample(i + 20, size);
    const block = lz4Compress(data);
    assert.ok(block.length < size || size < 100);
    const r = lz4BlockAt(wrap(3, block), 3, block.length);
    assert.deepEqual(r.data, data);
    assert.equal(r.end, 3 + block.length);
    // frame: magic, FLG (version 1), BD, HC, one compressed block, end mark
    const frame = new Uint8Array(7 + 4 + block.length + 4);
    frame.set([0x04, 0x22, 0x4d, 0x18, 0x40, 0x70, 0x00]);
    new DataView(frame.buffer).setUint32(7, block.length, true);
    frame.set(block, 11);
    const f = lz4FrameAt(wrap(2, frame), 2);
    assert.deepEqual(f.data, data);
    assert.equal(f.end, 2 + frame.length);
  }
  assert.throws(() => lz4BlockAt(new Uint8Array([0x0f, 1, 0]), 0, 3), /too far back|runs off/);
});
