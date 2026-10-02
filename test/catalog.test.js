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
