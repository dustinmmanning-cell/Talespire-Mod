import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCommunityPlan, gatherSlabs } from '../src/core/community.js';
import { ModioClient } from '../src/core/modio.js';
import { compilePlan } from '../src/core/compile.js';
import { buildSlabs } from '../src/core/build.js';
import { Kit } from '../src/core/kit.js';
import { Catalog } from '../src/core/catalog.js';
import { demoCatalog } from '../src/core/demo-catalog.js';
import { encodeSlab } from '../src/core/slab.js';
import { zip } from '../src/core/zip.js';
import { normalizePlan, planSchema } from '../src/core/plan.js';

// A catalog that looks real (not synthetic) so the planner sends kits and props.
const catalog = new Catalog(demoCatalog().assets, { source: 'symbiote' });
const kit = () => new Kit(catalog, { style: 'medieval' });

async function cottageSlab() {
  const plan = {
    title: 'c', summary: '', width: 10, height: 10, style: 'medieval', ground: 'none', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
    structures: [{ id: 'c', label: 'C', kind: 'cottage', parts: [{ x: 1, y: 1, w: 6, h: 4 }], rooms: [], doors: [{ x: 3, y: 4, side: 's' }], wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'pitched', windows: 'none', interiorWalls: false, furnish: 'normal' }],
  };
  return (await encodeSlab(compilePlan(plan, kit()).placements)).text;
}

// mod.io with two slabs: a usable cottage, and one using an asset nobody has.
async function fakeModio() {
  const good = await zip([{ name: 'slab.txt', data: await cottageSlab() }]);
  const alien = await zip([{ name: 'slab.txt', data: (await encodeSlab([{ assetId: '00000000-0000-4000-8000-0000000000aa', x: 0, y: 0, z: 0, rot: 0 }])).text }]);
  const files = { 1: good, 2: alien };
  const mod = (id, name) => ({
    id, name, summary: `${name} by a community builder`, profile_url: `https://mod.io/g/talespire/m/${id}`, submitted_by: { username: `maker${id}` }, tags: [{ name: 'Slab' }],
    modfile: { id: id * 10, filename: `${id}.zip`, download: { binary_url: `https://g-1.modapi.io/v1/games/1/mods/${id}/files/${id * 10}/download` } },
  });
  const searches = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
    if (u.pathname.endsWith('/download')) {
      const id = Number(u.pathname.split('/mods/')[1].split('/')[0]);
      const f = files[id];
      return { ok: true, status: 200, arrayBuffer: async () => f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) };
    }
    if (u.pathname === '/v1/games') return json({ data: [{ id: 1, name_id: 'talespire', tag_options: [{ name: 'Type', tags: ['Slab'] }] }] });
    searches.push(u.searchParams.get('_q'));
    return json({ data: [mod(1, 'Cosy Cottage'), mod(2, 'Alien Shack')], result_total: 2 });
  };
  return { modio: new ModioClient({ apiKey: 'k', fetchImpl }), searches };
}

// The AI: first call plans searches, second composes the plan.
function fakeAI(plan) {
  const calls = [];
  const sse = (text) => {
    const ev = [
      { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } },
      { type: 'message_stop' },
    ];
    const bytes = new TextEncoder().encode(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const schema = body.output_config.format ? body.output_config.format.schema : null;
    const reply = schema && schema.properties.searches ? { searches: [{ query: 'cottage', purpose: 'homes' }, { query: 'shack', purpose: 'a hut' }], style: 'medieval' } : plan;
    return { ok: true, status: 200, headers: new Map(), body: sse(JSON.stringify(reply)) };
  };
  return { fetchImpl, calls };
}

const villagePlan = {
  title: 'Two Cottages', summary: 'A lane between two cottages.', width: 24, height: 16, style: 'medieval', ground: 'grass', areas: [], barriers: [], props: [], scatter: [], notes: '',
  paths: [{ label: 'lane', material: 'dirt', width: 2, points: [[0.5, 8], [23.5, 8]] }],
  structures: [{ id: 'well', label: 'Well house', kind: 'house', parts: [{ x: 18, y: 2, w: 4, h: 4 }], rooms: [], doors: [{ x: 19, y: 5, side: 's' }], upperFloors: [], wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'pitched', windows: 'few', interiorWalls: false, furnish: 'sparse' }],
  prefabs: [{ ref: 'modio:1', x: 2, y: 1, rotation: '0' }, { ref: 'modio:1', x: 4, y: 10, rotation: '180' }],
};

test('community: plan searches, gather usable slabs, compose with them, build with credits', async () => {
  const { modio, searches } = await fakeModio();
  const ai = fakeAI(villagePlan);
  const steps = [];
  const res = await generateCommunityPlan({ apiKey: 'sk', prompt: 'two cottages by a lane', catalog, modio, fetchImpl: ai.fetchImpl, onProgress: (e) => steps.push(e.phase) });
  assert.deepEqual(searches, ['cottage', 'shack']);
  assert.deepEqual(res.candidates.map((c) => c.ref), ['modio:1']);
  assert.deepEqual(res.rejected.map((r) => [r.ref, r.reason]), [['modio:2', "uses 1 asset(s) your TaleSpire doesn't have"]]);
  assert.ok(['scouting', 'searching', 'downloading', 'composing'].every((s) => steps.includes(s)), steps.join());
  // the compose call saw the slab and could only name usable refs
  const compose = ai.calls[1];
  assert.match(compose.messages[0].content.at(-1).text, /modio:1: "Cosy Cottage" by maker1 \| 6x4 tiles; 1 storey; doors on s; fantasy/);
  assert.deepEqual(compose.output_config.format.schema.properties.prefabs.items.properties.ref.enum, ['modio:1'], 'only usable slabs can be named');
  assert.equal(res.plan.prefabs.length, 2);
  assert.equal(res.usage.outputTokens, 1000, 'both calls are counted');
  // build: the slab is placed twice (once turned), with credits and a preview
  const b = await buildSlabs(res.plan, kit(), { prefabs: res.prefabs });
  const pre = b.placements.filter((p) => p.meta.layer === 'prefab');
  assert.equal(pre.length, 2 * res.candidates[0].count);
  assert.deepEqual(b.credits, [{ ref: 'modio:1', name: 'Cosy Cottage', creator: 'maker1', url: 'https://mod.io/g/talespire/m/1' }]);
  assert.match(b.svg, /Cosy Cottage/);
  assert.match(b.svg, /by maker1/);
  // generated grass stays out from under the slabs (they bring their own floor)
  const grassUnder = b.placements.filter((p) => p.meta.layer === 'ground' && p.meta.cell && p.meta.cell[0] >= 2 && p.meta.cell[0] < 8 && p.meta.cell[1] >= 1 && p.meta.cell[1] < 5);
  assert.equal(grassUnder.length, 0);
  assert.ok(!b.warnings.some((w) => /community slab|overlap/.test(w)), b.warnings.join('; '));
});

test('community: the compiler keeps generated content off slabs and reports bad placements', async () => {
  const { modio } = await fakeModio();
  const { candidates } = await gatherSlabs({ modio, catalog, searches: [{ query: 'cottage' }] });
  const prefabs = new Map(candidates.map((c) => [c.ref, c]));
  const plan = normalizePlan({
    ...villagePlan,
    structures: [{ ...villagePlan.structures[0], parts: [{ x: 4, y: 2, w: 6, h: 3 }] }],
    prefabs: [{ ref: 'modio:1', x: 2, y: 1, rotation: 0 }, { ref: 'modio:1', x: 3, y: 2, rotation: 90 }, { ref: 'modio:9', x: 0, y: 0, rotation: 0 }, { ref: 'modio:1', x: 22, y: 14, rotation: 0 }],
  }).plan;
  const r = compilePlan(plan, kit(), { prefabs, normalized: true });
  assert.ok(r.warnings.some((w) => /overlaps "Cosy Cottage"; skipped/.test(w)));
  assert.ok(r.warnings.some((w) => /modio:9 is not loaded/.test(w)));
  assert.ok(r.warnings.some((w) => /moved to fit inside the map/.test(w)));
  assert.ok(r.warnings.some((w) => /Well house overlapped a community slab/.test(w)));
  assert.equal(r.grid.prefabs.length, 2);
  // the schema lists only the refs offered
  const schema = planSchema([], ['modio:1', 'modio:3']);
  assert.deepEqual(schema.properties.prefabs.items.properties.ref.enum, ['modio:1', 'modio:3']);
  assert.ok(schema.required.includes('prefabs'));
});

test('community: nothing usable gives a clear error', async () => {
  const { modio } = await fakeModio();
  const alienOnly = Object.create(modio);
  alienOnly.searchSlabs = async (q, o) => ({ items: (await modio.searchSlabs(q, o)).items.filter((it) => it.ref === 'modio:2') });
  const ai = fakeAI(villagePlan);
  await assert.rejects(
    generateCommunityPlan({ apiKey: 'sk', prompt: 'x', catalog, modio: alienOnly, fetchImpl: ai.fetchImpl, searches: [{ query: 'shack' }] }),
    /No usable community slabs found on mod.io for: shack\. 1 were found but can't be used here \(uses 1 asset/,
  );
  assert.equal(ai.calls.length, 0, 'no AI call when there is nothing to place');
});

// A fake mod.io with many slabs: _q matches any word of the name (like
// mod.io), submitted_by filters by creator, results come in list order.
async function fakeCatalogModio(mods) {
  const file = await zip([{ name: 'slab.txt', data: await cottageSlab() }]);
  const calls = [];
  const full = (m) => ({
    id: m.id, name: m.name, summary: '', profile_url: `https://mod.io/g/talespire/m/${m.id}`, submitted_by: { id: m.uid, username: m.by }, tags: [{ name: 'Slab' }],
    modfile: { id: m.id * 10, filename: `${m.id}.zip`, download: { binary_url: `https://g-1.modapi.io/v1/games/1/mods/${m.id}/files/${m.id * 10}/download` } },
  });
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
    if (u.pathname.endsWith('/download')) return { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
    if (u.pathname === '/v1/games') return json({ data: [{ id: 1, name_id: 'talespire', tag_options: [{ name: 'Type', tags: ['Slab'] }] }] });
    calls.push(Object.fromEntries(u.searchParams));
    const q = (u.searchParams.get('_q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const by = u.searchParams.get('submitted_by');
    const list = mods.filter((m) => (!q.length || q.some((w) => m.name.toLowerCase().includes(w))) && (!by || String(m.uid) === by));
    const off = Number(u.searchParams.get('_offset') || 0);
    const lim = Number(u.searchParams.get('_limit') || 8);
    return json({ data: list.slice(off, off + lim).map(full), result_total: list.length });
  };
  return { modio: new ModioClient({ apiKey: 'k', fetchImpl }), calls };
}

const mods = [
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: i, name: `Grand Blacksmith ${i}`, uid: 20, by: 'Zed' })),
  ...[7, 8, 9, 10, 11, 12].map((i) => ({ id: i, name: `Tavern of Zed ${i}`, uid: 20, by: 'Zed' })),
  { id: 13, name: 'Large Mountain with Cave', uid: 30, by: 'Rocky' },
  { id: 14, name: 'LemurianTownHouse Cottage Home', uid: 40, by: 'LemurianSettler' },
  { id: 15, name: 'LemurianTownSmithy BlackSmith Forge', uid: 40, by: 'LemurianSettler' },
  { id: 16, name: 'LemurianTownHouse Alehouse Tavern', uid: 40, by: 'LemurianSettler' },
  { id: 17, name: 'LemurianTownHouse Bakery', uid: 40, by: 'LemurianSettler' },
  { id: 18, name: 'Zed House', uid: 20, by: 'Zed' },
];
const villageSearches = [
  { query: 'blacksmith', words: ['smithy', 'forge'] },
  { query: 'large tavern', words: ['inn', 'alehouse'] },
  { query: 'house', words: ['home', 'cottage', 'townhouse'] },
];
const byName = (list) => list.map((c) => c.name);

test('community: every search gets its share, and off-topic matches are dropped', async () => {
  const { modio } = await fakeCatalogModio(mods);
  const r = await gatherSlabs({ modio, catalog, searches: villageSearches, max: 9 });
  const names = byName(r.candidates);
  assert.equal(names.length, 9);
  assert.ok(names.filter((n) => /house|home/i.test(n) && !/tavern|alehouse/i.test(n)).length >= 2, `houses get a share: ${names.join(', ')}`);
  assert.ok(!names.includes('Large Mountain with Cave'), '"large" is not what a tavern search is about');
  assert.equal(r.creator, null);
  assert.ok(r.candidates.find((c) => c.name === 'LemurianTownHouse Cottage Home').search.includes('house'));
});

test('community: one creator\'s set, or a named creator, for a consistent look', async () => {
  // without Zed House, only LemurianSettler covers all three searches (Zed has more slabs)
  const { modio: noZedHouse, calls } = await fakeCatalogModio(mods.filter((m) => m.name !== 'Zed House'));
  const one = await gatherSlabs({ modio: noZedHouse, catalog, searches: villageSearches, creator: 'one' });
  assert.deepEqual([...new Set(one.candidates.map((c) => c.creator))], ['LemurianSettler']);
  assert.equal(one.creator.name, 'LemurianSettler');
  assert.equal(one.creator.slabs, 4);
  assert.deepEqual(one.creator.missing, []);
  assert.ok(byName(one.candidates).includes('LemurianTownHouse Bakery'), 'their other popular slabs come along as extras');
  assert.ok(calls.some((c) => c.submitted_by === '40' && !c._q), 'their catalog is listed with submitted_by');
  // with it, both cover everything and the one with more matching slabs wins
  const { modio } = await fakeCatalogModio(mods);
  assert.equal((await gatherSlabs({ modio, catalog, searches: villageSearches, creator: 'one' })).creator.name, 'Zed');
  // a named creator, any case, partial name
  const zed = await gatherSlabs({ modio, catalog, searches: villageSearches, creator: 'zed' });
  assert.deepEqual([...new Set(zed.candidates.map((c) => c.creator))], ['Zed']);
  assert.ok(byName(zed.candidates).includes('Zed House'));
  const lem = await gatherSlabs({ modio, catalog, searches: [{ query: 'tavern', words: [] }], creator: 'lemurian' });
  assert.equal(lem.creator.name, 'LemurianSettler');
  await assert.rejects(gatherSlabs({ modio, catalog, searches: villageSearches, creator: 'Nobody' }), /No slabs by "Nobody" found on mod.io/);
  // what the chosen creator has nothing for is reported
  const none = await gatherSlabs({ modio, catalog, searches: [...villageSearches, { query: 'lighthouse', words: [] }], creator: 'LemurianSettler' });
  assert.deepEqual(none.creator.missing, ['lighthouse']);
});

test('community: slabs-only builds have no structures to draw', async () => {
  const schema = planSchema([], ['modio:1'], { slabsOnly: true });
  assert.ok(!schema.properties.structures && !schema.required.includes('structures'));
  assert.ok(planSchema([], ['modio:1']).properties.structures, 'mixed builds keep structures');
  const { modio } = await fakeModio();
  const ai = fakeAI(villagePlan);
  const res = await generateCommunityPlan({ apiKey: 'sk', prompt: 'two cottages by a lane', catalog, modio, fetchImpl: ai.fetchImpl, slabsOnly: true });
  const compose = ai.calls[1];
  assert.ok(!compose.output_config.format.schema.properties.structures);
  assert.match(compose.messages[0].content.at(-1).text, /This build has no structures/);
  assert.match(compose.messages[0].content.at(-1).text, /prefer slabs by the same creator/);
  // the fake AI still sends a building: it is left out, with a warning
  assert.equal(res.plan.structures.length, 0);
  assert.ok(res.warnings.some((w) => /Left out 1 building\(s\) the AI drew/.test(w)));
  assert.equal(res.plan.prefabs.length, 2);
});
