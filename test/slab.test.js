import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeSlabBinary, decodeSlabBinary, encodeSlab, decodeSlab, guidToBytes, bytesToGuid,
  gzipBytes, gunzipBytes, bytesToBase64, base64ToBytes, normalizePlacements, SlabError, MAX_SLAB_BYTES,
} from '../src/core/slab.js';

const CASTLE_FLOOR = '32cfd208-c363-4434-b817-8ba59faeed17';
const TAVERN_FLOOR = 'e62c6746-cecf-46bf-8b20-f81738f1d220';

test('guid uses .NET byte order (first three groups little-endian)', () => {
  const bytes = guidToBytes(CASTLE_FLOOR);
  // Documented by reverse engineering in SlabelFish: 08:d2:cf:32:63:c3:34:44:b8:17:8b:a5:9f:ae:ed:17
  assert.deepEqual([...bytes], [0x08, 0xd2, 0xcf, 0x32, 0x63, 0xc3, 0x34, 0x44, 0xb8, 0x17, 0x8b, 0xa5, 0x9f, 0xae, 0xed, 0x17]);
  assert.equal(bytesToGuid(bytes), CASTLE_FLOOR);
});

test('binary layout matches the published v2 spec, built by hand', () => {
  const placements = [
    { assetId: TAVERN_FLOOR, x: 0, y: 1.5, z: 0, rot: 12 },
    { assetId: CASTLE_FLOOR, x: 4.25, y: 0.5, z: 98, rot: 23 },
    { assetId: TAVERN_FLOOR, x: 2621.43, y: 0, z: 0.01, rot: 0 },
  ];
  const got = encodeSlabBinary(placements);

  // header (10) + 2 layouts (40) + 3 placements (24) + trailer (2)
  const want = new Uint8Array(76);
  const v = new DataView(want.buffer);
  v.setUint32(0, 0xd1ceface, true);
  v.setUint16(4, 2, true);
  v.setUint16(6, 2, true);
  v.setUint16(8, 0, true);
  guidToBytes(TAVERN_FLOOR, want, 10);
  v.setUint16(26, 2, true);
  guidToBytes(CASTLE_FLOOR, want, 30);
  v.setUint16(46, 1, true);
  const pack = (x, y, z, rot) => (BigInt(x) | (BigInt(y) << 18n) | (BigInt(z) << 36n) | (BigInt(rot) << 54n));
  v.setBigUint64(50, pack(0, 150, 0, 12), true); // tavern #1
  v.setBigUint64(58, pack(262143, 0, 1, 0), true); // tavern #2 (grouped with #1)
  v.setBigUint64(66, pack(425, 50, 9800, 23), true); // castle
  assert.deepEqual([...got], [...want]);

  const decoded = decodeSlabBinary(got);
  assert.equal(decoded.trailingBytes, 2);
  assert.deepEqual(decoded.layouts, [{ assetId: TAVERN_FLOOR, count: 2 }, { assetId: CASTLE_FLOOR, count: 1 }]);
  assert.deepEqual(decoded.placements.map((p) => [p.x, p.y, p.z, p.rot]), [[0, 1.5, 0, 12], [2621.43, 0, 0.01, 0], [4.25, 0.5, 98, 23]]);
});

test('every bit field survives a round trip at its extremes', () => {
  const cases = [];
  for (const x of [0, 0.01, 163.83, 163.84, 2621.43]) {
    for (const y of [0, 163.83, 163.84, 2621.43]) {
      for (const rot of [0, 1, 6, 23]) cases.push({ assetId: CASTLE_FLOOR, x, y, z: Math.round((2621.43 - x) * 100) / 100, rot });
    }
  }
  const back = decodeSlabBinary(encodeSlabBinary(cases)).placements;
  assert.equal(back.length, cases.length);
  back.forEach((p, i) => {
    assert.equal(p.x, cases[i].x);
    assert.equal(p.y, cases[i].y);
    assert.equal(p.z, cases[i].z);
    assert.equal(p.rot, cases[i].rot);
  });
});

test('rejects coordinates the format cannot hold', () => {
  assert.throws(() => encodeSlabBinary([{ assetId: CASTLE_FLOOR, x: -0.01, y: 0, z: 0, rot: 0 }]), SlabError);
  assert.throws(() => encodeSlabBinary([{ assetId: CASTLE_FLOOR, x: 2621.44, y: 0, z: 0, rot: 0 }]), SlabError);
  assert.throws(() => encodeSlabBinary([{ assetId: 'not-a-guid', x: 0, y: 0, z: 0, rot: 0 }]), SlabError);
  assert.throws(() => encodeSlabBinary([]), SlabError);
});

test('decoder rejects non-slabs', () => {
  assert.throws(() => decodeSlabBinary(new Uint8Array(12)), /bad magic/);
  const wrongVersion = encodeSlabBinary([{ assetId: CASTLE_FLOOR, x: 0, y: 0, z: 0, rot: 0 }]);
  new DataView(wrongVersion.buffer).setUint16(4, 1, true);
  assert.throws(() => decodeSlabBinary(wrongVersion), /version 1/);
});

test('gzip/base64 text round trip, with and without ``` fences', async () => {
  const placements = [];
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) placements.push({ assetId: CASTLE_FLOOR, x, y: 0, z, rot: 0 });
  const { text, compressedBytes, rawBytes } = await encodeSlab(placements);
  assert.equal(rawBytes, 10 + 20 + 400 * 8 + 2);
  assert.ok(compressedBytes < rawBytes / 3, `grid data should compress well (${compressedBytes} of ${rawBytes})`);
  for (const pasted of [text, '```' + text + '```', `  \n${text.slice(0, 10)}\n${text.slice(10)}  `]) {
    const back = await decodeSlab(pasted);
    assert.equal(back.placements.length, 400);
    assert.deepEqual(back.placements[399], { assetId: CASTLE_FLOOR, x: 19, y: 0, z: 19, rot: 0, extra: 0 });
  }
});

test('encodeSlab enforces the 30,720 byte limit on the compressed payload', async () => {
  const placements = [];
  // pseudo-random positions compress poorly
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 9000; i++) placements.push({ assetId: CASTLE_FLOOR, x: rnd() * 2000, y: rnd() * 50, z: rnd() * 2000, rot: (rnd() * 24) | 0 });
  await assert.rejects(encodeSlab(placements), /over TaleSpire's 30720-byte limit/);
  const unlimited = await encodeSlab(placements, { maxBytes: 0 });
  assert.ok(unlimited.compressedBytes > MAX_SLAB_BYTES);
});

test('gzip helpers interoperate with node:zlib', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const data = new TextEncoder().encode('slab slab slab slab');
  assert.deepEqual([...gunzipSync(await gzipBytes(data))], [...data]);
  assert.deepEqual([...(await gunzipBytes(gzipSync(data)))], [...data]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(data))], [...data]);
});

test('normalization shifts x/z by whole tiles and y by quarter tiles', () => {
  const out = normalizePlacements([
    { assetId: CASTLE_FLOOR, x: -0.3, y: -0.1, z: 5.5, rot: 0 },
    { assetId: CASTLE_FLOOR, x: 2, y: 1, z: 7, rot: 0 },
  ]);
  assert.deepEqual(out.map((p) => [p.x, p.y, p.z]), [[0.7, 0.15, 0.5], [3, 1.25, 2]]);
});

// Opt-in: TALEFORGE_SLAB_FIXTURES=/dir/of/slabs node --test
// Each file holds one slab string as copied from TaleSpire. The check is that
// decode -> encode reproduces the game's own binary byte for byte (the base64
// differs because .NET's deflate makes different choices than zlib's).
const fixtureDir = process.env.TALEFORGE_SLAB_FIXTURES;
test('real TaleSpire slabs round-trip byte-exact', { skip: !fixtureDir && 'set TALEFORGE_SLAB_FIXTURES to run' }, async () => {
  const files = [];
  for (const dir of fixtureDir.split(':')) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isFile() && !/\.(geo)?json$/i.test(name)) files.push(path);
    }
  }
  assert.ok(files.length > 0, 'no fixture files found');
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const original = await gunzipBytes(base64ToBytes(text.replace(/```/g, '').replace(/\s+/g, '')));
    const decoded = decodeSlabBinary(original);
    assert.equal(decoded.trailingBytes, 2, `${path}: expected the 2-byte trailer`);
    const reencoded = encodeSlabBinary(decoded.placements);
    assert.deepEqual([...reencoded], [...original], `${path}: binary differs after round trip`);
  }
});
