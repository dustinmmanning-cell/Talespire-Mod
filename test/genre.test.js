import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoCatalog } from '../src/core/demo-catalog.js';
import { Catalog, makeAsset } from '../src/core/catalog.js';
import { Kit, STYLES, STYLE_PRESETS } from '../src/core/kit.js';
import { compilePlan } from '../src/core/compile.js';
import { normalizePlan, planSchema, PLAN_SCHEMA } from '../src/core/plan.js';
import { systemPrompt } from '../src/core/planner.js';

const catalog = demoCatalog();
const nameOf = (a) => (a ? a.name : null);

test('genre: the sci-fi pack is told apart from the fantasy one', () => {
  const g = (name) => catalog.byName(name).genre;
  assert.equal(g('concrete wall 1x1'), 'scifi');
  assert.equal(g('sci fi chest 02'), 'scifi');
  assert.equal(g('Tavern Wall - Small 01'), 'fantasy');
  assert.equal(g('Chest 01'), 'fantasy');
  // without pack names: by the group, and by the asset's own name
  const loose = new Catalog([
    makeAsset({ id: 'a', name: 'pipe wall', kind: 'tile', group: 'Facility', size: { x: 1, y: 2, z: 0.2 } }),
    makeAsset({ id: 'b', name: 'Neon Sign', kind: 'prop', group: 'Signs', size: { x: 1, y: 1, z: 0.1 } }),
    makeAsset({ id: 'c', name: 'Barrel', kind: 'prop', group: 'Containers', size: { x: 1, y: 1, z: 1 } }),
  ]);
  assert.deepEqual(loose.assets.map((a) => a.genre), ['scifi', 'scifi', 'fantasy']);
  // one pack holding both halves: each group decides
  const mixed = new Catalog([
    makeAsset({ id: 'e', name: 'Tavern Wall', kind: 'tile', group: 'wall', pack: 'TaleSpire', size: { x: 1, y: 2, z: 0.2 } }),
    makeAsset({ id: 'f', name: 'Table', kind: 'prop', group: 'Furniture', pack: 'TaleSpire', size: { x: 1, y: 1, z: 1 } }),
    makeAsset({ id: 'g', name: 'Tree', kind: 'prop', group: 'Trees', pack: 'TaleSpire', size: { x: 1, y: 1, z: 1 } }),
    makeAsset({ id: 'h', name: 'hull wall', kind: 'tile', group: 'Hull', pack: 'TaleSpire', size: { x: 1, y: 2, z: 0.2 } }),
  ]);
  assert.deepEqual(mixed.assets.map((a) => a.genre), ['fantasy', 'fantasy', 'fantasy', 'scifi']);
  // a pack mostly of sci-fi groups is sci-fi throughout, even "Furniture"
  const sciPack = new Catalog(['Hull', 'Facility', 'Outpost', 'Furniture'].map((g, i) => makeAsset({ id: `s${i}`, name: `thing ${i}`, kind: 'prop', group: g, pack: 'Pack B', size: { x: 1, y: 1, z: 1 } })));
  assert.ok(sciPack.assets.every((a) => a.genre === 'scifi'));
  // a pack named as sci-fi decides for all its assets
  const named = new Catalog([makeAsset({ id: 'd', name: 'Table', kind: 'prop', group: 'Furniture', pack: 'Cyberpunk and Sci-Fi', size: { x: 1, y: 1, z: 1 } })]);
  assert.equal(named.assets[0].genre, 'scifi');
});

test('genre: fantasy styles never use sci-fi assets', () => {
  for (const style of STYLES.filter((s) => STYLE_PRESETS[s].genre === 'fantasy')) {
    const kit = new Kit(catalog, { style });
    const picks = [kit.door(), kit.stairs(), kit.flatRoof(), kit.wall('brick') && kit.wall('brick').plain1, kit.surface('concrete') && kit.surface('concrete').base];
    for (const role of ['chest', 'table', 'chair', 'barrel', 'crate', 'bed', 'desk', 'sign']) picks.push(...kit.props(role));
    const sci = picks.filter((a) => a && a.genre === 'scifi');
    assert.deepEqual(sci.map(nameOf), [], `${style} picked sci-fi assets`);
  }
});

test('genre: sci-fi styles prefer sci-fi walls, floors, doors and furniture', () => {
  const kit = new Kit(catalog, { style: 'scifi' });
  assert.equal(nameOf(kit.wall('metal').plain1), 'hull wall 1x1');
  assert.equal(nameOf(kit.wall('metal').window), 'hull wall window');
  assert.equal(nameOf(kit.surface('metal_floor').base), 'hull floor 1x1');
  assert.equal(nameOf(kit.door()), 'sliding door', 'the style\'s door: a modern one');
  assert.equal(nameOf(kit.stairs()), 'metal stairs');
  assert.equal(nameOf(kit.props('chest')[0]), 'sci fi chest 02');
  assert.equal(nameOf(kit.props('table')[0]), 'modern table');
  assert.equal(nameOf(kit.props('computer')[0]), 'computer terminal');
  // nothing sci-fi for a role: the fantasy asset still works
  assert.equal(nameOf(kit.props('tree')[0]), 'Tree 01');
  const city = new Kit(catalog, { style: 'cyberpunk' });
  assert.equal(nameOf(city.wall('concrete').plain1), 'concrete wall 1x1');
  assert.equal(nameOf(city.wall('concrete').plain2), 'concrete wall 2x1');
  assert.equal(nameOf(city.wall('brick').plain1), 'brick wall modern 1x1');
  assert.equal(nameOf(city.surface('asphalt').base), 'road asphalt 1x1');
  assert.equal(nameOf(city.flatRoof()), 'city roof 1x1');
});

test('building kits: library groups with walls, usable as "kit:<group>"', () => {
  const kits = catalog.buildingKits();
  const hull = kits.find((k) => k.group === 'Hull');
  assert.deepEqual(hull, { group: 'Hull', genre: 'scifi', walls: 1, windows: 1, doors: 1, floors: 1, stairs: 0 });
  assert.ok(kits.some((k) => k.group === 'Concrete Building' && k.walls === 2));
  assert.ok(kits.some((k) => k.genre === 'fantasy' && k.group === 'wall'));
  // a kit material resolves inside its group, whatever the style
  const kit = new Kit(catalog, { style: 'medieval' });
  const w = kit.wall('kit:Hull');
  assert.deepEqual([w.plain1, w.window, w.door].map(nameOf), ['hull wall 1x1', 'hull wall window', 'hull door 1x1']);
  assert.equal(nameOf(kit.door('kit:Hull')), 'hull door 1x1');
  assert.equal(nameOf(kit.surface('kit:Hull').base), 'hull floor 1x1');
  // an unknown kit falls back to the style's own material
  assert.equal(kit.wall('kit:Nope').plain1.name, kit.wall('wood').plain1.name);
});

test('plans may name a building kit; the schema lists this library\'s kits', () => {
  const { plan } = normalizePlan({
    width: 12, height: 10, style: 'scifi', structures: [{ id: 'a', parts: [{ x: 2, y: 2, w: 6, h: 5 }], wall: 'kit:Hull', floor: 'kit:Hull ', doors: [{ x: 4, y: 6, side: 's' }] }],
  });
  assert.equal(plan.structures[0].wall, 'kit:Hull');
  assert.equal(plan.structures[0].floor, 'kit:Hull');
  const schema = planSchema(catalog.buildingKits());
  const st = schema.properties.structures.items.properties;
  assert.ok(st.wall.enum.includes('kit:Hull') && st.wall.enum.includes('kit:Concrete Building'));
  assert.ok(st.floor.enum.includes('kit:Hull'));
  assert.ok(!PLAN_SCHEMA.properties.structures.items.properties.wall.enum.includes('kit:Hull'), 'the shared schema is not modified');
  // it compiles with the kit's walls, floor and door
  const r = compilePlan(plan, new Kit(catalog, { style: 'scifi' }), { normalized: true });
  const used = new Set(r.placements.map((p) => catalog.get(p.assetId).name));
  for (const n of ['hull wall 1x1', 'hull floor 1x1', 'hull door 1x1']) assert.ok(used.has(n), `${n} used`);
  assert.ok(![...used].some((n) => /Tavern|castle wall|Door -Peasant/.test(n)), [...used].join());
});

test('a sci-fi plan builds from the sci-fi half; a fantasy one from the fantasy half', () => {
  const base = (style, extra) => ({
    title: 'x', summary: '', width: 16, height: 12, style, ground: 'none', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
    structures: [{ id: 'b', label: 'B', kind: 'office', parts: [{ x: 2, y: 2, w: 10, h: 7 }], interiorWalls: true,
      rooms: [{ label: 'Office', kind: 'office', x: 2, y: 2, w: 5, h: 7 }, { label: 'Lab', kind: 'lab', x: 7, y: 2, w: 5, h: 7 }],
      doors: [{ x: 4, y: 8, side: 's' }], storeys: 1, roof: 'flat', windows: 'few', furnish: 'normal', ...extra }],
  });
  const sci = compilePlan(base('cyberpunk', {}), new Kit(catalog, { style: 'cyberpunk' }));
  const genres = (r) => new Set(r.placements.map((p) => catalog.get(p.assetId).genre));
  const sciTiles = sci.placements.filter((p) => catalog.get(p.assetId).kind === 'tile').map((p) => catalog.get(p.assetId));
  assert.ok(sciTiles.every((a) => a.genre === 'scifi'), sciTiles.filter((a) => a.genre !== 'scifi').map(nameOf).join());
  assert.ok(sci.placements.some((p) => catalog.get(p.assetId).name === 'computer terminal'), 'offices and labs get computers');
  const fan = compilePlan(base('medieval', { kind: 'house' }), new Kit(catalog, { style: 'medieval' }));
  assert.deepEqual([...genres(fan)], ['fantasy']);
});

test('the AI sees the kits and the sci-fi props, labelled', () => {
  const real = new Catalog(catalog.assets, { source: 'symbiote' });
  const prompt = systemPrompt(real);
  assert.match(prompt, /# Building kits in this GM's library/);
  assert.match(prompt, /Sci-fi and modern: .*Hull \(walls, windows, doors, floors\)/);
  assert.match(prompt, /\[sci-fi\] Facility: .*computer terminal; metal locker/);
  assert.match(prompt, /^Containers: .*Barrel/m);
  assert.match(prompt, /Styles modern, cyberpunk, scifi build from the sci-fi half/);
});
