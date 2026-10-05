import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateNpcs, layoutSummary, miniSection, resolveMini, assignMinis, npcCreatureInfo, npcNotesText } from '../src/core/npcs.js';
import { normalizePlan, cleanNpcs } from '../src/core/plan.js';
import { generatePlan } from '../src/core/planner.js';
import { buildSlabs, textReport } from '../src/core/build.js';
import { Kit } from '../src/core/kit.js';
import { Catalog } from '../src/core/catalog.js';
import { demoCatalog } from '../src/core/demo-catalog.js';
import { readFileSync } from 'node:fs';

const catalog = demoCatalog();
const minis = catalog.minis;
const tavern = normalizePlan(JSON.parse(readFileSync(new URL('../examples/plans/tavern.json', import.meta.url), 'utf8'))).plan;

function sseFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const text = JSON.stringify(typeof replies === 'function' ? replies(body) : replies);
    const ev = [
      { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2000, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 800 } },
      { type: 'message_stop' },
    ];
    const bytes = new TextEncoder().encode(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    return { ok: true, status: 200, headers: new Map(), body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
  };
  return { fetchImpl, calls };
}

const npcReply = {
  npcs: [
    { name: 'Borin Ironhand', race: 'dwarf', role: 'blacksmith', mini: 'Dwarf Blacksmith', x: 5, y: 6, floor: 1, where: 'at the forge', about: 'Soot-black beard, short temper. Owes the guild more than he admits.', hp: 18, hostile: false },
    { name: 'Mira Vale', race: 'human', role: 'barkeep', mini: 'Human Commoner', x: 200, y: -3, floor: 9, where: 'behind the bar', about: 'Hears everything. Sells rumours for a drink.', hp: 0, hostile: false },
    { name: 'Tam Reed', race: 'human', role: 'farmhand', mini: 'Human Commoner', x: 2, y: 2, floor: 1, where: 'by the door', about: 'Nervous. Saw lights in the woods.', hp: 4, hostile: false },
    { name: 'Snik', race: 'goblin', role: 'thief', mini: 'Sneaky Gob', x: 3, y: 3, floor: 1, where: 'under a table', about: 'Picks pockets, flees when seen.', hp: 7, hostile: true },
  ],
  notes: 'Borin and Mira are old friends; Snik works for someone in town.',
};

test('npcs: cleaned onto the map, matched to minis, variants take turns', () => {
  const clean = cleanNpcs(npcReply.npcs, 20, 16);
  assert.deepEqual([clean[1].x, clean[1].y, clean[1].floor], [19, 0, 6], 'clamped to the map and storeys');
  const out = assignMinis(clean, minis);
  assert.equal(out[0].miniName, 'Dwarf Blacksmith', 'exact name');
  assert.deepEqual([out[1].miniName, out[2].miniName], ['Human Commoner 01', 'Human Commoner 02'], 'variants of "Human Commoner" take turns');
  assert.equal(out[3].miniName, 'Goblin', 'unknown mini name: matched by race');
  assert.ok(out.every((n) => minis.some((m) => m.id === n.miniId)));
  // by race and job when the name is free text
  assert.equal(resolveMini({ mini: 'a stern guard', race: 'human', role: 'town guard' }, minis).name, 'Human Guard');
  assert.equal(resolveMini({ mini: '', race: 'elf', role: 'wizard' }, minis).name, 'Elf Wizard');
  assert.equal(resolveMini({ mini: '', race: '', role: '' }, []), null);
});

test('npcs: what the model sees, and what it sends back', async () => {
  const layout = layoutSummary(tavern);
  assert.match(layout, /^Map: \d+ x \d+ tiles\. The Prancing Gryphon/);
  assert.match(layout, /Buildings:\n- ".+" \(tavern, 2 storeys\) at x \d+-\d+, y \d+-\d+; rooms: /);
  const list = miniSection(minis);
  assert.match(list, /Townsfolk: Bard, Barkeep, Farmer, Human Commoner \(2 variants\), Human Guard/);
  const ai = sseFetch(npcReply);
  const res = await generateNpcs({ apiKey: 'sk', plan: tavern, minis, prompt: 'a roadside tavern', fetchImpl: ai.fetchImpl });
  const body = ai.calls[0];
  assert.ok(body.output_config.format.schema.properties.npcs, 'structured output with the NPC schema');
  assert.match(body.messages[0].content, /Request: a roadside tavern/);
  assert.match(body.messages[0].content, /# Minis the GM has\n/);
  assert.equal(res.npcs.length, 4);
  assert.equal(res.npcs[0].miniName, 'Dwarf Blacksmith');
  assert.match(res.notes, /old friends/);
  assert.ok(res.cost > 0);
});

test('npcs: blueprints, notes, preview markers and the report', async () => {
  const npcs = assignMinis(cleanNpcs(npcReply.npcs, tavern.width, tavern.height), minis);
  const info = npcCreatureInfo(npcs[0], ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA', 'AC', 'Speed'], { hidden: true });
  assert.equal(info.name, 'Borin Ironhand');
  assert.deepEqual(info.morphs, [{ boardAssetId: npcs[0].miniId, scale: 1 }]);
  assert.deepEqual(info.hp, { name: 'HP', value: 18, max: 18 });
  assert.equal(info.stats.length, 8);
  assert.equal(info.isExplicitlyHidden, true);
  assert.equal(npcCreatureInfo(npcs[1]).stats.length, 8, 'eight stats even without the campaign\'s names');
  const plan = { ...tavern, npcs, npcNotes: npcReply.notes };
  assert.match(npcNotesText(plan), /^NPCs \(numbers match the markers on the preview\):\n1\. Borin Ironhand \(dwarf blacksmith\), at the forge\. Soot-black beard.+\[HP 18, mini: Dwarf Blacksmith\]/);
  const b = await buildSlabs(plan, new Kit(catalog, { style: 'medieval' }));
  assert.equal((b.svg.match(/<title>\d+\. /g) || []).length, 4, 'one marker per NPC');
  assert.match(b.svg, /<title>4\. Snik \(goblin thief\)<\/title><circle[^>]+fill="#c0392b"/, 'hostile ones are red');
  const report = textReport(b);
  assert.match(report, /## NPCs\n.+\n\n1\. Borin Ironhand/);
  assert.match(report, /Snik works for someone in town/);
});

test('npcs: a refine keeps them, and the catalog keeps minis apart from building pieces', async () => {
  const withNpcs = { ...tavern, npcs: cleanNpcs(npcReply.npcs, tavern.width, tavern.height), npcNotes: 'x' };
  const ai = sseFetch({ ...tavern, title: 'Renamed' });
  const res = await generatePlan({ apiKey: 'sk', prompt: 'rename it', previousPlan: withNpcs, catalog, fetchImpl: ai.fetchImpl });
  assert.equal(res.plan.title, 'Renamed');
  assert.equal(res.plan.npcs.length, 4);
  assert.doesNotMatch(ai.calls[0].messages[0].content.at(-1).text, /Borin/, 'NPCs are not sent to the plan call');
  // Symbiote-shaped packs with creatures
  const packs = [{
    tiles: { a: { id: '00000000-0000-4000-8000-000000000001', name: 'Floor', groupTag: 'Floors', tags: [], colliderBoundsBound: { center: { x: 0.5, y: 0.1, z: 0.5 }, width: 1, height: 0.2, depth: 1 } } },
    props: {},
    creatures: { c: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Halfling Bard', groupTag: 'Humanoid', tags: ['halfling'], defaultScale: 0.8 } },
  }];
  const cat = Catalog.fromContentPacks(packs, ['Core']);
  assert.equal(cat.size, 1, 'minis are not counted as assets');
  assert.deepEqual(cat.minis.map((m) => [m.name, m.scale]), [['Halfling Bard', 0.8]]);
  assert.equal(cat.get('00000000-0000-4000-8000-0000000000c1'), null, 'and are never building pieces');
  const round = Catalog.fromJSON(JSON.parse(JSON.stringify(cat.toJSON())));
  assert.deepEqual(round.minis.map((m) => [m.name, m.scale]), [['Halfling Bard', 0.8]]);
});
