import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePlan, groupRuns } from '../src/core/compile.js';
import { Kit } from '../src/core/kit.js';
import { normalizePlan, PLAN_SCHEMA } from '../src/core/plan.js';
import { demoCatalog } from '../src/core/demo-catalog.js';
import { placedBounds, boxesOverlap } from '../src/core/geometry.js';
import { buildSlabs } from '../src/core/build.js';
import { chunkPlacements } from '../src/core/chunk.js';
import { decodeSlab, MAX_SLAB_BYTES } from '../src/core/slab.js';

const catalog = demoCatalog();
const loadPlan = (name) => JSON.parse(readFileSync(new URL(`../examples/plans/${name}.json`, import.meta.url), 'utf8'));
const kitFor = (plan) => new Kit(catalog, { style: plan.style });

function propOverlaps(result) {
  const boxes = result.placements
    .filter((p) => catalog.get(p.assetId).kind === 'prop')
    .map((p) => placedBounds(catalog.get(p.assetId), p));
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i], boxes[j])) n++;
  return n;
}

function house(extra = {}) {
  return {
    title: 'House', summary: '', width: 12, height: 10, style: 'medieval', ground: 'grass', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
    structures: [{
      id: 'h', label: 'House', kind: 'house', parts: [{ x: 3, y: 2, w: 6, h: 5 }], rooms: [], doors: [{ x: 5, y: 6, side: 's' }],
      wall: 'castle', floor: 'stone_floor', storeys: 1, roof: 'none', windows: 'none', interiorWalls: false, furnish: 'none', ...extra,
    }],
  };
}

test('a simple house: walls on every perimeter edge except the door', () => {
  const r = compilePlan(house(), kitFor(house()));
  const walls = r.grid.edges.filter((e) => e.type === 'wall');
  const doors = r.grid.edges.filter((e) => e.type === 'door');
  assert.equal(walls.length + doors.length, 2 * (6 + 5));
  assert.deepEqual(doors.map((d) => [d.x, d.y, d.side]), [[5, 6, 's']]);
  // every wall placement sits inside the building footprint (world x 3..9, z 3..8)
  for (const p of r.placements.filter((q) => q.meta.layer === 'structure')) {
    const b = placedBounds(catalog.get(p.assetId), p);
    assert.ok(b[0] >= 3 - 1e-6 && b[2] <= 9 + 1e-6 && b[1] >= 3 - 1e-6 && b[3] <= 8 + 1e-6, `wall outside footprint: ${b}`);
  }
  // 2-long castle wall pieces are used along runs
  const longWall = catalog.byName('castle wall 2x2');
  assert.ok(r.placements.some((p) => p.assetId === longWall.id));
});

// Floors are the walkable grid minis snap to: exactly on whole tiles. Walls
// hug cell edges, so a piece thinner than half a tile sits on a quarter tile.
test('floors sit exactly on the tile grid; every tile on the quarter-tile grid', () => {
  for (const name of ['tavern', 'dungeon', 'village']) {
    const plan = loadPlan(name);
    const r = compilePlan(plan, kitFor(plan));
    const tiles = r.placements.filter((p) => catalog.get(p.assetId).kind !== 'prop');
    const offGrid = (step) => (p) => [p.x, p.z].some((v) => Math.abs(v / step - Math.round(v / step)) > 0.011);
    const floors = tiles.filter((p) => p.meta.layer === 'ground' || p.meta.what === 'upper-floor');
    assert.equal(floors.filter(offGrid(1)).length, 0, `${name}: floor off the tile grid`);
    const bad = tiles.filter(offGrid(0.25));
    assert.equal(bad.length, 0, `${name}: tile off the quarter grid, e.g. ${JSON.stringify(bad[0])}`);
  }
});

test('props never overlap (TaleSpire drops overlapping props on paste)', () => {
  for (const name of ['tavern', 'dungeon', 'village']) {
    const plan = loadPlan(name);
    assert.equal(propOverlaps(compilePlan(plan, kitFor(plan))), 0, name);
  }
});

test('compilation is deterministic and does not mutate the plan', () => {
  const plan = loadPlan('village');
  const before = JSON.stringify(plan);
  const a = compilePlan(plan, kitFor(plan), { seed: 3 });
  const b = compilePlan(plan, kitFor(plan), { seed: 3 });
  assert.deepEqual(a.placements, b.placements);
  assert.equal(JSON.stringify(plan), before);
  const c = compilePlan(plan, kitFor(plan), { seed: 4 });
  assert.notDeepEqual(a.placements, c.placements, 'seed changes furniture and scatter');
});

test('every room is reachable: missing doors are added', () => {
  const plan = loadPlan('tavern');
  plan.structures[0].doors = [{ x: 11, y: 12, side: 's' }]; // only the front door
  const r = compilePlan(plan, kitFor(plan));
  const doors = r.grid.edges.filter((e) => e.type === 'door');
  assert.ok(doors.length >= 3, `expected doors into kitchen and storeroom, got ${doors.length}`);
});

test('a structure without doors gets one facing walkable ground', () => {
  const plan = house({ doors: [] });
  const r = compilePlan(plan, kitFor(plan));
  assert.equal(r.grid.edges.filter((e) => e.type === 'door').length, 1);
});

test('open-plan dungeon: corridors join rooms without walls; a door can stand in an opening', () => {
  const plan = loadPlan('dungeon');
  const r = compilePlan(plan, kitFor(plan));
  // no wall between the entry hall (x 2..7) and the west passage (x 8..13) at y 10..11
  const between = r.grid.edges.filter((e) => e.x === 7 && (e.y === 10 || e.y === 11) && e.side === 'e');
  assert.equal(between.length, 0);
  const treasuryDoor = r.grid.edges.find((e) => e.type === 'door' && e.x === 25 && e.y === 10 && e.side === 'e');
  assert.ok(treasuryDoor, 'door between passage and treasury stands in the opening');
});

test('pitched roofs: one roof piece per cell, rising by course', () => {
  const plan = house({ roof: 'pitched' });
  const r = compilePlan(plan, kitFor(plan));
  const roof = r.placements.filter((p) => p.meta.layer === 'roof');
  assert.equal(roof.length, 30);
  const ys = [...new Set(roof.map((p) => p.y))].sort();
  assert.equal(ys.length, 3, 'a 6x5 hip roof has three courses');
});

test('fortifications get towers at corners and gates as openings', () => {
  const plan = loadPlan('village');
  const r = compilePlan(plan, kitFor(plan));
  const towers = r.grid.structures.filter((s) => s.kind === 'tower');
  assert.equal(towers.length, 4);
  const wall = r.grid.barriers.find((b) => b.kind === 'fortification');
  assert.ok(wall.edges.filter((e) => e.type === 'gate').length >= 2);
  const portcullis = catalog.byName('Door - Portcullis');
  assert.ok(r.placements.some((p) => p.assetId === portcullis.id));
});

test('plan normalization repairs bad input instead of failing', () => {
  const { plan, warnings } = normalizePlan({
    width: 9999, height: -3, style: 'space', ground: 'lava-ish',
    structures: [
      { id: 'a', parts: [{ x: -5, y: 2, w: 10, h: 4 }], doors: [{ x: 1, y: 1, side: 'up' }], storeys: 9 },
      { id: 'a', parts: [{ x: 500, y: 500, w: 3, h: 3 }] },
    ],
    props: [{ role: 'unicorn', x: 3, y: 3 }, { role: 'barrel', x: -1, y: 2 }],
    areas: [{ material: 'grass', points: [[0, 0], [1, 1]] }],
  });
  assert.equal(plan.width, 240);
  assert.equal(plan.height, 4);
  assert.equal(plan.style, 'medieval');
  assert.equal(plan.structures.length, 1);
  assert.deepEqual(plan.structures[0].parts[0], { x: 0, y: 2, w: 5, h: 2 });
  assert.equal(plan.structures[0].storeys, 4);
  assert.equal(plan.structures[0].doors[0].side, 's');
  assert.equal(plan.props.length, 1);
  assert.equal(plan.props[0].role, 'other');
  assert.ok(warnings.length >= 3);
});

test('the plan schema obeys structured-output rules', () => {
  const walk = (s, path) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, path);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), path);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
    }
    if (s.type === 'array') walk(s.items, `${path}[]`);
    for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) assert.ok(!(k in s), `${k} at ${path}`);
  };
  walk(PLAN_SCHEMA, 'plan');
});

test('groupRuns splits edges into contiguous same-side runs', () => {
  const runs = groupRuns([
    { x: 1, y: 0, side: 'n' }, { x: 2, y: 0, side: 'n' }, { x: 4, y: 0, side: 'n' },
    { x: 0, y: 5, side: 'w' }, { x: 0, y: 6, side: 'w' }, { x: 0, y: 7, side: 'e' },
  ]);
  assert.deepEqual(runs.map((r) => r.length).sort(), [1, 1, 2, 2]);
});

test('large builds split into registered slabs that each fit', async () => {
  // A dense 150x150 forest town compresses past one slab.
  const plan = loadPlan('village');
  const big = { ...plan, width: 150, height: 150, scatter: [{ role: 'tree', asset: '', points: [[0, 0], [150, 0], [150, 150], [0, 150]], density: 0.5 }] };
  const build = await buildSlabs(big, kitFor(big));
  assert.ok(build.chunks.length > 1, `expected several chunks, got ${build.chunks.length}`);
  assert.ok(build.registered);
  assert.ok(build.multiSlab, 'multi-slab JSON for MultiPasteSlabsPlugin');
  const total = build.chunks.reduce((n, c) => n + c.count, 0);
  assert.equal(total, build.placements.length, 'every placement lands in exactly one chunk');
  let bbox = null;
  for (const c of build.chunks) {
    assert.ok(c.compressedBytes <= MAX_SLAB_BYTES);
    const slab = await decodeSlab(c.text);
    // the two registration markers come first and are identical in every chunk
    const markers = JSON.stringify(slab.placements.slice(0, 2));
    if (bbox === null) bbox = markers;
    assert.equal(markers, bbox);
  }
  const doc = JSON.parse(build.multiSlab);
  assert.equal(doc.slabs.length >= 2, true);
  assert.equal(doc.autoDrop, true);
});

test('small builds are a single slab without markers', async () => {
  const plan = house();
  const out = await chunkPlacements(compilePlan(plan, kitFor(plan)).placements, { markerAsset: catalog.byName('castle floor 1x1') });
  assert.equal(out.chunks.length, 1);
  assert.equal(out.registered, false);
});
