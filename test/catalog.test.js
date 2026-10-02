import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContentPacks, Catalog } from '../src/core/catalog.js';

const tile = (id, name) => ({
  id, name, isDeprecated: false, groupTag: 'Floors', tags: [],
  colliderBoundsBound: { center: { x: 1, y: 0.25, z: 1 }, width: 2, height: 0.5, depth: 2 },
});
const pack = (id, n = 2) => ({ id, optionalName: id, tiles: Array.from({ length: n }, (_, i) => tile(`${id}-${i}`, `${id} floor ${i}`)), props: [] });
const frag = (p) => ({ id: p.id, optionalName: p.optionalName });

// A fake TS.contentPacks where some packs can't be described, like TaleSpire
// with a mod pack loaded: asking for them (alone or with others) fails.
function fakeApi(packs, { bad = [], rateLimitOnce = [] } = {}) {
  const calls = [];
  const limited = new Set(rateLimitOnce);
  return {
    calls,
    getContentPacks: async () => packs.map(frag),
    getMoreInfo: async (frags) => {
      calls.push(frags.map((f) => f.id));
      for (const f of frags) {
        if (limited.delete(f.id)) throw Object.assign(new Error('rate limited'), { code: 'rateLimited' });
        if (bad.includes(f.id)) throw new Error(`TaleSpire: internalError`);
      }
      return frags.map((f) => packs.find((p) => p.id === f.id));
    },
  };
}

test('content packs: one call when TaleSpire can describe every pack', async () => {
  const api = fakeApi([pack('core'), pack('extra')]);
  const res = await readContentPacks(api);
  assert.deepEqual(res.infos.map((p) => p.id), ['core', 'extra']);
  assert.deepEqual(res.skipped, []);
  assert.equal(api.calls.length, 1);
});

test('content packs: a pack TaleSpire cannot describe is skipped, the rest load', async () => {
  const api = fakeApi([pack('core', 3), pack('ModPack'), pack('extra')], { bad: ['ModPack'] });
  const logs = [];
  const res = await readContentPacks(api, { log: (m) => logs.push(m) });
  assert.deepEqual(res.infos.map((p) => p.id), ['core', 'extra']);
  assert.deepEqual(res.skipped, [{ name: 'ModPack', error: 'TaleSpire: internalError' }]);
  assert.deepEqual(api.calls, [['core', 'ModPack', 'extra'], ['core'], ['ModPack'], ['extra']]);
  assert.ok(logs.some((m) => /one pack at a time/.test(m)));
  assert.equal(Catalog.fromContentPacks(res.infos).size, 5);
});

test('content packs: rate limits while asking pack by pack are waited out', async () => {
  const api = fakeApi([pack('core'), pack('ModPack'), pack('extra')], { bad: ['ModPack'], rateLimitOnce: ['extra'] });
  const waits = [];
  const res = await readContentPacks(api, { wait: async (ms) => waits.push(ms) });
  assert.deepEqual(res.infos.map((p) => p.id), ['core', 'extra']);
  assert.equal(res.skipped.length, 1);
  assert.deepEqual(waits, [1000]);
});

test('content packs: clear errors when nothing can be read', async () => {
  await assert.rejects(readContentPacks(fakeApi([pack('a'), pack('b')], { bad: ['a', 'b'] })), /could not describe any of your 2 asset pack\(s\)\. First error: TaleSpire: internalError/);
  await assert.rejects(readContentPacks({ getContentPacks: async () => [], getMoreInfo: async () => [] }), /no loaded asset packs/);
  await assert.rejects(readContentPacks({ getContentPacks: async () => ({ oops: 1 }), getMoreInfo: async () => [] }), /unexpected pack list \(\{"oops":1\}\)/);
  // details in an unexpected shape for every pack
  await assert.rejects(readContentPacks({ getContentPacks: async () => [{ id: 'a' }], getMoreInfo: async () => 'nope' }), /First error: TaleSpire sent unexpected pack details \(string nope\)/);
});

test('content packs: a single pack object instead of a list is accepted', async () => {
  const p = pack('core');
  const res = await readContentPacks({ getContentPacks: async () => [frag(p)], getMoreInfo: async () => p });
  assert.deepEqual(res.infos.map((x) => x.id), ['core']);
});

test('content packs: tiles and props in shapes other than an array still load', async () => {
  const { assetsFromContentPacks, listOf, describePackShapes } = await import('../src/core/catalog.js');
  const [a, b, c] = pack('p', 3).tiles;
  // The shape that broke the first in-game test: an object where the docs say array.
  const keyed = { id: 'keyed', tiles: { [a.id]: a, [b.id]: b }, props: { x: { ...c, id: undefined, name: 'Crate' } } };
  assert.throws(() => { for (const t of keyed.tiles || []) t; }, /object is not iterable \(cannot read property Symbol\(Symbol\.iterator\)\)/);
  const res = assetsFromContentPacks([keyed]);
  assert.deepEqual(res.assets.map((x) => `${x.kind}:${x.name}`), ['tile:p floor 0', 'tile:p floor 1']);
  // .NET wrappers, array-likes and single-array wrappers
  assert.equal(listOf({ $id: '1', $values: [a, b] }).length, 2);
  assert.equal(listOf({ 0: a, 1: b, length: 2 }).length, 2);
  assert.equal(listOf({ count: 3, items: [a, b, c] }).length, 3);
  assert.deepEqual(listOf('nope'), []);
  assert.deepEqual(listOf(null), []);
  // keyed by GUID without an id field: the key becomes the id
  const guid = '01234567-89ab-cdef-0123-456789abcdef';
  const noId = { ...a };
  delete noId.id;
  assert.equal(listOf({ [guid]: noId })[0].id, guid);
  // tags as an object, a wrapper or a comma list
  const tagged = assetsFromContentPacks([{ id: 't', tiles: [{ ...a, tags: { $values: ['Stone', 'Floor'] } }, { ...b, tags: 'wood, floor' }], props: [] }]);
  assert.deepEqual(tagged.assets.map((x) => x.tags), [['stone', 'floor'], ['wood', 'floor']]);
  // the diagnostics describe shapes, not contents
  const d = describePackShapes([keyed]);
  assert.equal(d.packInfos, 'array(1)');
  assert.deepEqual(d.packs[0].tiles.type, 'object');
  assert.equal(d.packs[0].tiles.keyCount, 2);
  assert.equal(d.packs[0].tiles.first.colliderBoundsBound, 'object{center,width,height,depth}');
  assert.ok(JSON.stringify(d).length < 2000);
});

test('content packs: the real TaleSpire shape (keyed by GUID, no pack id) loads with pack names', async () => {
  // As reported from TaleSpire: pack details have no id, and tiles/props are
  // objects keyed by asset GUID. Names come from the pack list instead.
  const real = (p) => ({ optionalName: undefined, tiles: Object.fromEntries(p.tiles.map((t) => [t.id, t])), props: {}, creatures: {}, music: [] });
  const core = pack('core', 3);
  const empty = pack('creatures', 0);
  const packs = [core, empty];
  const api = {
    getContentPacks: async () => packs.map(frag),
    getMoreInfo: async (frags) => frags.map((f) => real(packs.find((p) => p.id === f.id))),
  };
  const res = await readContentPacks(api);
  assert.deepEqual(res.names, ['core', 'creatures']);
  const cat = Catalog.fromContentPacks(res.infos, res.names);
  assert.equal(cat.size, 3);
  assert.equal(cat.get(core.tiles[0].id).pack, 'core');
  assert.deepEqual(cat.meta.packs, ['core'], 'only packs that contributed assets');
  assert.equal(cat.meta.packsLoaded, 2);
  // one pack at a time keeps the names too
  const bad = { ...api, getMoreInfo: async (frags) => (frags.length > 1 ? Promise.reject(new Error('boom')) : api.getMoreInfo(frags)) };
  assert.deepEqual((await readContentPacks(bad)).names, ['core', 'creatures']);
});
