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
