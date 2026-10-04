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
import { renderPreviewSvg } from '../src/core/preview.js';

const catalog = demoCatalog();
const loadPlan = (name) => JSON.parse(readFileSync(new URL(`../examples/plans/${name}.json`, import.meta.url), 'utf8'));
const kitFor = (plan) => new Kit(catalog, { style: plan.style });

// Props on the same floor whose footprints overlap (props on different floors
// are at different heights).
function propOverlaps(result) {
  const boxes = result.placements
    .filter((p) => catalog.get(p.assetId).kind === 'prop')
    .map((p) => ({ b: placedBounds(catalog.get(p.assetId), p), f: p.meta.floor || 1 }));
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxes[i].f === boxes[j].f && boxesOverlap(boxes[i].b, boxes[j].b)) n++;
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
  assert.equal(plan.structures[0].storeys, 6);
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

// The first in-game tavern: the AI drew the bard's stage as a second building
// inside the tavern (so it got its own outside walls), and had no way to keep
// a bar area open to the taproom while the kitchen stayed walled.
function tavern() {
  const s = (extra) => ({ wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'pitched', windows: 'none', furnish: 'normal', ...extra });
  return {
    title: 'The Copper Lute', summary: '', width: 16, height: 16, style: 'tavern', ground: 'grass', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
    structures: [
      s({
        id: 'tavern', label: 'The Copper Lute Tavern', kind: 'tavern', parts: [{ x: 1, y: 1, w: 14, h: 14 }], interiorWalls: true,
        rooms: [
          { label: 'Taproom', kind: 'common', x: 1, y: 1, w: 14, h: 8, open: false },
          { label: 'Bar', kind: 'bar', x: 2, y: 1, w: 6, h: 2, open: true },
          { label: 'Kitchen', kind: 'kitchen', x: 1, y: 9, w: 5, h: 6, open: false },
          { label: 'Stores', kind: 'storage', x: 6, y: 9, w: 4, h: 6, open: false },
          { label: 'Vestibule', kind: 'corridor', x: 10, y: 9, w: 5, h: 6, open: false },
        ],
        doors: [{ x: 12, y: 14, side: 's' }, { x: 3, y: 9, side: 'n' }, { x: 7, y: 9, side: 'n' }, { x: 12, y: 9, side: 'n' }, { x: 4, y: 2, side: 's' }],
      }),
      s({ id: 'stage', label: "Raised bard's stage inside the tavern", kind: 'other', parts: [{ x: 11, y: 1, w: 4, h: 3 }], rooms: [], doors: [], interiorWalls: false }),
    ],
  };
}

test('a building drawn inside another becomes an open room of it', () => {
  const { plan, warnings } = normalizePlan(tavern());
  assert.equal(plan.structures.length, 1);
  assert.ok(warnings.some((w) => /drawn as a separate building inside "The Copper Lute Tavern"/.test(w)));
  const stage = plan.structures[0].rooms.find((r) => /stage/.test(r.label));
  assert.deepEqual({ kind: stage.kind, open: stage.open, x: stage.x, y: stage.y, w: stage.w, h: stage.h }, { kind: 'stage', open: true, x: 11, y: 1, w: 4, h: 3 });
  // an unroofed outer structure (a walled yard) keeps buildings inside it separate
  const yard = tavern();
  yard.structures[0].roof = 'none';
  assert.equal(normalizePlan(yard).plan.structures.length, 2);
});

test('open rooms get no walls; walled rooms keep theirs; nested rooms keep their tiles', () => {
  const r = compilePlan(tavern(), kitFor(tavern()));
  const edges = r.grid.edges;
  const at = (x, y, side) => edges.find((e) => e.x === x && e.y === y && e.side === side);
  // bar (x 2..7, y 1..2) is open to the taproom: nothing on its south or west/east sides
  for (let x = 2; x <= 7; x++) assert.equal(at(x, 2, 's'), undefined, `bar south edge at x=${x}`);
  for (const y of [1, 2]) {
    assert.equal(at(1, y, 'e'), undefined, `bar west edge at y=${y}`);
    assert.equal(at(7, y, 'e'), undefined, `bar east edge at y=${y}`);
  }
  // the stage (x 11..14, y 1..3) too
  for (const y of [1, 2, 3]) assert.equal(at(10, y, 'e'), undefined, `stage west edge at y=${y}`);
  for (let x = 11; x <= 14; x++) assert.equal(at(x, 3, 's'), undefined, `stage south edge at x=${x}`);
  // the door asked for on the bar's open edge is dropped, not stood in the open
  assert.ok(!edges.some((e) => e.freestanding));
  assert.ok(!r.warnings.some((w) => /door at \(4,2\)/.test(w)));
  // kitchen, stores and vestibule are still walled off from the taproom, with their doors
  const kitchenTop = [1, 2, 3, 4, 5].map((x) => at(x, 8, 's'));
  assert.ok(kitchenTop.every(Boolean), 'kitchen north wall');
  assert.equal(kitchenTop.filter((e) => e.type === 'door').length, 1);
  // one building, and the bar and stage keep all their tiles despite being listed after the taproom
  assert.equal(r.grid.structures.length, 1);
  const room = (label) => r.grid.rooms.find((x) => x.label === label || x.label.startsWith(label));
  assert.equal(room('Bar').cells, 12);
  assert.equal(room('Raised').cells, 12);
  assert.equal(room('Taproom').cells, 14 * 8 - 12 - 12);
});

// "A shanty-town halfway house with a soup kitchen, 4 storeys, like 4 cargo
// containers stacked haphazardly": every floor has its own footprint, rooms
// and furniture, stairs join each floor to the next where they overlap, and
// uncovered parts of a lower floor get a flat roof.
function containerStack() {
  return {
    title: 'The Rusted Ladle', summary: '', width: 20, height: 16, style: 'medieval', ground: 'dirt', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
    structures: [{
      id: 'ladle', label: 'Halfway house', kind: 'inn', parts: [{ x: 2, y: 8, w: 10, h: 4 }], interiorWalls: true,
      rooms: [{ label: 'Soup kitchen', kind: 'kitchen', x: 2, y: 8, w: 4, h: 4 }, { label: 'Mess', kind: 'dining', x: 6, y: 8, w: 6, h: 4 }],
      doors: [{ x: 8, y: 11, side: 's' }, { x: 5, y: 9, side: 'e' }],
      upperFloors: [
        // shifted right and up a tile; a door onto the kitchen's roof
        { label: 'bunks', parts: [{ x: 4, y: 7, w: 10, h: 4 }], rooms: [{ label: 'Bunk room', kind: 'dormitory', x: 4, y: 7, w: 6, h: 4 }, { label: 'Store', kind: 'storage', x: 10, y: 7, w: 4, h: 4 }], doors: [{ x: 9, y: 8, side: 'e' }, { x: 5, y: 10, side: 's' }, { x: 13, y: 10, side: 'e' }] },
        // turned 90 degrees
        { label: 'crooked box', parts: [{ x: 6, y: 2, w: 4, h: 10 }], rooms: [{ label: 'Cell A', kind: 'bedroom', x: 6, y: 2, w: 4, h: 4 }, { label: 'Cell B', kind: 'bedroom', x: 6, y: 6, w: 4, h: 6 }], doors: [{ x: 7, y: 5, side: 's' }] },
        { label: 'lookout', parts: [{ x: 3, y: 3, w: 10, h: 4 }], rooms: [], doors: [] },
      ],
      wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'flat', windows: 'few', furnish: 'normal',
    }],
  };
}

test('upper floors: own footprints, rooms, furniture, stairs and terrace roofs', () => {
  const plan = containerStack();
  const { plan: norm } = normalizePlan(plan);
  assert.equal(norm.structures[0].storeys, 4, 'storeys follows upperFloors');
  const r = compilePlan(plan, kitFor(plan));
  const on = (f) => r.placements.filter((p) => (p.meta.floor || 1) === f);
  const cellOf = (p) => (p.meta.cell ? `${p.meta.cell[0]},${p.meta.cell[1]}` : null);
  const footprint = (parts) => new Set(parts.flatMap((q) => Array.from({ length: q.w * q.h }, (_, i) => `${q.x + (i % q.w)},${q.y + Math.floor(i / q.w)}`)));
  const floorsParts = [plan.structures[0].parts, ...plan.structures[0].upperFloors.map((f) => f.parts)];
  const wallH = Math.max(...on(1).filter((p) => p.meta.what === 'wall').map((p) => catalog.get(p.assetId).size.y));
  for (let f = 1; f <= 4; f++) {
    const ps = on(f);
    assert.ok(ps.filter((p) => catalog.get(p.assetId).kind === 'prop').length >= 5, `floor ${f} is furnished`);
    if (f > 1) {
      // floor tiles cover this floor's footprint (minus the stairs hole) and nothing else
      const fp = footprint(floorsParts[f - 1]);
      const tiles = ps.filter((p) => p.meta.layer === 'ground');
      assert.ok(tiles.every((p) => fp.has(cellOf(p))), `floor ${f} tiles inside its footprint`);
      assert.ok(tiles.length >= fp.size - 2 && tiles.length < fp.size, `floor ${f}: ${tiles.length} tiles for ${fp.size} cells, minus the stairs hole`);
      // walls start one storey up per floor
      const minY = Math.min(...ps.filter((p) => p.meta.what === 'wall').map((p) => p.y));
      const groundMinY = Math.min(...on(1).filter((p) => p.meta.what === 'wall').map((p) => p.y));
      assert.ok(Math.abs(minY - groundMinY - (f - 1) * wallH) < 0.3, `floor ${f} walls at storey height (${minY} vs ${groundMinY} + ${(f - 1) * wallH})`);
    }
  }
  // one flight per pair of floors
  assert.equal(r.placements.filter((p) => p.meta.what === 'stairs').length, 3);
  // flat roofs: exposed parts of floors 1-3, and all of the top floor
  const roofs = (f) => on(f).filter((p) => p.meta.layer === 'roof').length;
  assert.deepEqual([1, 2, 3, 4].map(roofs), [16, 24, 24, 40]);
  // the door onto the kitchen roof is kept; the one onto thin air is not
  const f2 = r.floors.find((x) => x.level === 2).grid;
  assert.ok(f2.edges.some((e) => e.type === 'door' && e.x === 5 && e.y === 10 && e.side === 's'));
  assert.ok(!f2.edges.some((e) => e.type === 'door' && e.x === 13 && e.side === 'e'));
  assert.ok(r.warnings.some((w) => /door on Halfway house \(bunks\) at \(13,10\) leads nowhere/.test(w)));
  // every room upstairs is reachable from the stairs, and props never overlap on a floor
  assert.deepEqual(r.floors.map((x) => x.grid.rooms.map((rm) => rm.label)), [['Store', 'Bunk room'], ['Cell A', 'Cell B'], ['Halfway house (lookout)']]);
  assert.equal(propOverlaps(r), 0);
  assert.ok(!r.warnings.some((w) => /stairs/.test(w)), r.warnings.join('; '));
});

test('upper floors: a plain storey count repeats the ground floor with upstairs rooms', () => {
  const plan = loadPlan('tavern');
  const r = compilePlan(plan, kitFor(plan));
  const upstairs = r.floors.map((f) => f.grid.rooms.map((rm) => rm.kind));
  assert.equal(upstairs.length, plan.structures[0].storeys - 1);
  assert.ok(upstairs[0].includes('dormitory') && !upstairs[0].includes('bar') && !upstairs[0].includes('kitchen'), upstairs[0].join());
  assert.ok(r.placements.some((p) => p.meta.floor === 2 && catalog.get(p.assetId).kind === 'prop'), 'upstairs is furnished');
  assert.ok(!r.warnings.some((w) => /leads nowhere/.test(w)), 'outer doors are not copied upstairs');
  // the preview shows each upper floor as its own panel
  const svg = renderPreviewSvg(r, { scale: 10 });
  assert.match(svg, /floor 2<\/tspan>/);
});

test('upper floors: floors that do not overlap get a warning, not a crash', () => {
  const plan = containerStack();
  plan.structures[0].upperFloors[0].parts = [{ x: 14, y: 1, w: 4, h: 3 }];
  const r = compilePlan(plan, kitFor(plan));
  assert.ok(r.warnings.some((w) => /no room for stairs from floor 1 to floor 2/.test(w)));
});
