import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip, isZip, crc32 } from '../src/core/zip.js';
import { ModioClient, slabFromBytes, slabFromText, describeSlabFile, summarizeMod } from '../src/core/modio.js';
import { encodeSlab, encodeSlabBinary, decodeSlab, gzipBytes } from '../src/core/slab.js';
import { demoCatalog } from '../src/core/demo-catalog.js';

const catalog = demoCatalog();
const wall = catalog.byName('Tavern Wall - Small 01');
const placements = [0, 1, 2].map((i) => ({ assetId: wall.id, x: i, y: 0, z: 0, rot: 0 }));
const slabText = async () => (await encodeSlab(placements)).text;

test('zip: round trip, stored and deflated, with a known CRC', async () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  for (const deflate of [false, true]) {
    const z = await zip([{ name: 'a.txt', data: 'hello zip' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3, 250]) }], { deflate });
    assert.ok(isZip(z));
    const files = await unzip(z);
    assert.deepEqual(files.map((f) => f.name).sort(), ['a.txt', 'dir/b.bin']);
    assert.equal(new TextDecoder().decode(files.find((f) => f.name === 'a.txt').data), 'hello zip');
    assert.deepEqual([...files.find((f) => f.name === 'dir/b.bin').data], [1, 2, 3, 250]);
  }
});

test('slab sniffing: every likely way a slab is uploaded', async () => {
  const text = await slabText();
  const raw = encodeSlabBinary(placements);
  const gz = await gzipBytes(raw);
  const enc = (s) => new TextEncoder().encode(s);
  const cases = [
    ['zip with slab text', await zip([{ name: 'preview.png', data: new Uint8Array([0x89, 0x50]) }, { name: 'slab.txt', data: text }])],
    ['zip with raw binary', await zip([{ name: 'data.bin', data: raw }])],
    ['zip with gzip binary', await zip([{ name: 'slab', data: gz }])],
    ['zip in zip', await zip([{ name: 'inner.zip', data: await zip([{ name: 'slab.txt', data: text }]) }])],
    ['gzip binary', gz],
    ['raw binary', raw],
    ['slab text with fences', enc(`\`\`\`\n${text}\n\`\`\``)],
    ['JSON', enc(JSON.stringify({ name: 'Tower', slab: text }))],
  ];
  for (const [label, bytes] of cases) {
    const r = await slabFromBytes(bytes);
    assert.ok(r, `${label}: no slab found`);
    const decoded = await decodeSlab(r.text);
    assert.equal(decoded.placements.length, 3, label);
  }
  assert.equal(await slabFromBytes(enc('just a readme')), null);
  assert.equal(await slabFromText('H4sInotreally'), null);
  const d = await describeSlabFile(await zip([{ name: 'readme.md', data: 'hi' }]), 'thing.zip');
  assert.match(d.summary, /zip of 1 file\(s\): readme.md/);
  assert.equal(d.entries[0].slab, 'no');
});

// A fake mod.io: one game with a Slab tag, mods with zip files.
async function fakeModio({ status = 200, rateLimitOnce = false } = {}) {
  const text = await slabText();
  const file = await zip([{ name: 'slab.txt', data: text }]);
  const calls = [];
  let limited = rateLimitOnce;
  const mod = (id, name, extra = {}) => ({
    id, name, name_id: name.toLowerCase().replace(/\W+/g, '-'), summary: `${name} summary`, profile_url: `https://mod.io/g/talespire/m/${id}`,
    submitted_by: { username: 'builder42', profile_url: 'https://mod.io/u/builder42' },
    logo: { thumb_320x180: `https://thumb/${id}.png` }, tags: [{ name: 'Slab' }, { name: 'Building' }],
    metadata_blob: '', metadata_kvp: [{ metakey: 'assets', metavalue: '3' }],
    modfile: { id: id * 10, filename: `${id}.zip`, filesize: file.length, metadata_blob: '', download: { binary_url: `https://g-123.modapi.io/v1/games/123/mods/${id}/files/${id * 10}/download`, date_expires: 0 } },
    stats: { downloads_total: 5, subscribers_total: 1, ratings_display_text: 'Positive' },
    ...extra,
  });
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const json = (body, s = 200, headers = {}) => ({ ok: s < 400, status: s, headers: new Map(Object.entries(headers)), json: async () => body });
    if (u.pathname.endsWith('/download')) return { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
    if (status !== 200) return json({ error: { code: status, error_ref: 11000, message: 'nope' } }, status);
    if (limited && u.pathname.endsWith('/mods')) {
      limited = false;
      return json({ error: { code: 429, error_ref: 11008, message: 'slow down' } }, 429, { 'retry-after': '1' });
    }
    if (u.pathname === '/v1/games') return json({ data: [{ id: 123, name: 'TaleSpire', name_id: 'talespire', tag_options: [{ name: 'Type', type: 'checkboxes', tags: ['Slab', 'Symbiote', 'Creature'] }] }], result_total: 1 });
    if (u.pathname === '/v1/games/123/mods') return json({ data: [mod(1, 'Cosy Tavern'), mod(2, 'Blob Tower', { metadata_blob: text })], result_count: 2, result_total: 2, result_limit: 8, result_offset: 0 });
    return json({ error: { code: 404, error_ref: 14000, message: 'not here' } }, 404);
  };
  return { fetchImpl, calls };
}

test('mod.io: search TaleSpire slabs with the key, tag and query; fetch and decode them', async () => {
  const { fetchImpl, calls } = await fakeModio();
  const client = new ModioClient({ apiKey: 'k123', fetchImpl, wait: async () => {} });
  const res = await client.searchSlabs('tavern', { limit: 8 });
  assert.equal(res.total, 2);
  assert.equal(res.tag, 'Slab');
  const search = new URL(calls.find((c) => c.includes('/mods?')));
  assert.equal(search.searchParams.get('_q'), 'tavern');
  assert.equal(search.searchParams.get('tags'), 'Slab');
  assert.equal(search.searchParams.get('api_key'), 'k123');
  assert.equal(search.searchParams.get('_sort'), '-popular');
  const [tavern, tower] = res.items;
  assert.deepEqual({ ref: tavern.ref, creator: tavern.creator, tags: tavern.tags, kvp: tavern.kvp }, { ref: 'modio:1', creator: 'builder42', tags: ['Slab', 'Building'], kvp: { assets: '3' } });
  const a = await client.fetchSlab(tavern);
  assert.match(a.how, /zip entry "slab.txt"/);
  assert.equal((await decodeSlab(a.text)).placements.length, 3);
  // a slab carried in the mod's metadata needs no download
  const before = calls.length;
  const b = await client.fetchSlab(tower);
  assert.equal(b.how, 'mod metadata');
  assert.equal(calls.length, before);
  // the game is looked up once
  await client.searchSlabs('tower');
  assert.equal(calls.filter((c) => new URL(c).pathname === '/v1/games').length, 1);
});

test('mod.io: errors are plain, rate limits are waited out, proxies relay downloads', async () => {
  const bad = await fakeModio({ status: 401 });
  await assert.rejects(new ModioClient({ apiKey: 'x', fetchImpl: bad.fetchImpl }).searchSlabs('x'), /mod.io API key was rejected/);
  assert.throws(() => new ModioClient({ apiKey: '' }), /No mod.io API key/);
  const slow = await fakeModio({ rateLimitOnce: true });
  const waits = [];
  const res = await new ModioClient({ apiKey: 'k', fetchImpl: slow.fetchImpl, wait: async (ms) => waits.push(ms) }).searchSlabs('inn');
  assert.equal(res.items.length, 2);
  assert.deepEqual(waits, [1000]);
  // through the TaleForge proxy, the file is fetched via /download?url=
  const viaProxy = await fakeModio();
  const proxied = new ModioClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8787/modio/v1', fetchImpl: async (url) => viaProxy.fetchImpl(url.startsWith('http://127.0.0.1') && url.includes('/download?url=') ? decodeURIComponent(url.split('url=')[1]) : url.replace('http://127.0.0.1:8787/modio', 'https://api.mod.io')) });
  assert.ok(proxied.proxied);
  const items = (await proxied.searchSlabs('inn')).items;
  const got = await proxied.fetchSlab(items[0]);
  assert.ok(got.text.startsWith('H4sI'));
  assert.equal(summarizeMod({ id: 9 }).name, 'mod 9');
});
