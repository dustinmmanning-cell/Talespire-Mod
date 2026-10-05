import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../src/core/compile.js';
import { Kit } from '../src/core/kit.js';
import { demoCatalog } from '../src/core/demo-catalog.js';
import { Catalog } from '../src/core/catalog.js';
import { analyzePrefab, transformPrefab, rotatedSize, rotatedEntrances, rotatedGround, describePrefab, prefabFromSlab } from '../src/core/prefab.js';
import { encodeSlab } from '../src/core/slab.js';

const catalog = demoCatalog();
const kit = () => new Kit(catalog, { style: 'medieval' });

// A cottage with no 2-long walls, no 2x2 floors and no windows, so the
// compiler's choices don't depend on which way runs are walked.
function cottage(W = 12, H = 10, rect = { x: 2, y: 3, w: 6, h: 4 }, door = { x: 4, y: 6, side: 's' }, extra = {}) {
  return {
    title: 'c', summary: '', width: W, height: H, style: 'medieval', ground: 'none', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
    structures: [{ id: 'c', label: 'C', kind: 'cottage', parts: [rect], rooms: [], doors: [door], wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'pitched', windows: 'none', interiorWalls: false, furnish: 'none', ...extra }],
  };
}

// The same plan turned 90 degrees clockwise (seen from above, north up).
function turnPlan(plan) {
  const H = plan.height;
  const turnRect = (r) => ({ x: H - r.y - r.h, y: r.x, w: r.h, h: r.w });
  const SIDE = { n: 'e', e: 's', s: 'w', w: 'n' };
  return {
    ...plan, width: plan.height, height: plan.width,
    structures: plan.structures.map((s) => ({ ...s, parts: s.parts.map(turnRect), doors: s.doors.map((d) => ({ x: H - 1 - d.y, y: d.x, side: SIDE[d.side] })) })),
  };
}

const key = (p) => {
  const a = catalog.get(p.assetId);
  // Wall and door pieces are laid by edge; a half turn of one is the same piece
  // in the same place, so compare their rotation modulo 12.
  // A square floor tile is the same at any quarter turn. Roof pieces are
  // compared exactly: their slope shows the turn.
  const rot = /floor/i.test(a.name) ? p.rot % 6 : /wall|door/i.test(a.name) ? p.rot % 12 : p.rot;
  return `${a.name}|${p.x.toFixed(2)}|${p.y.toFixed(2)}|${p.z.toFixed(2)}|${rot}`;
};
const norm = (ps) => {
  const mx = Math.min(...ps.map((p) => p.x));
  const mz = Math.min(...ps.map((p) => p.z));
  return ps.map((p) => ({ ...p, x: p.x - Math.floor(mx + 1e-6), z: p.z - Math.floor(mz + 1e-6) })).map(key).sort();
};

test('prefab: a compiled cottage reads back as a 6x4, one-storey building with a south door', () => {
  const r = compilePlan(cottage(), kit());
  const pf = analyzePrefab(r.placements, catalog);
  assert.deepEqual([pf.w, pf.d, pf.floors, pf.missing, pf.genre], [6, 4, 1, 0, 'fantasy']);
  assert.deepEqual(pf.entrances, ['s']);
  assert.equal(pf.ground.size, 24, 'its own floor covers the footprint');
  assert.ok(pf.hasGround);
  assert.match(describePrefab(pf), /^6x4 tiles; 1 storey; doors on s; fantasy; mostly /);
});

test('prefab: turning a slab matches compiling the turned plan (positions and roof rotations)', () => {
  let plan = cottage();
  const pf = analyzePrefab(compilePlan(plan, kit()).placements, catalog);
  for (let q = 1; q <= 3; q++) {
    plan = turnPlan(plan);
    const expected = norm(compilePlan(plan, kit()).placements);
    const got = norm(transformPrefab(pf, catalog, { quarter: q }));
    assert.deepEqual(got, expected, `after ${q} quarter turn(s)`);
    assert.deepEqual(rotatedSize(pf, q), q % 2 ? [4, 6] : [6, 4]);
  }
  assert.deepEqual(rotatedEntrances(pf, 1), ['w']);
  assert.deepEqual(rotatedEntrances(pf, 2), ['n']);
  assert.equal(rotatedGround(pf, 1).size, 24);
  // four turns is the identity
  assert.deepEqual(norm(transformPrefab(pf, catalog, { quarter: 4 })), norm(pf.placements));
});

test('prefab: storeys, moving, and assets this library lacks', async () => {
  const two = analyzePrefab(compilePlan(cottage(12, 10, { x: 2, y: 3, w: 6, h: 4 }, { x: 4, y: 6, side: 's' }, { storeys: 2, roof: 'flat' }), kit()).placements, catalog);
  assert.equal(two.floors, 2);
  const moved = transformPrefab(two, catalog, { x0: 10, z0: 20, dy: 0.5 });
  assert.equal(Math.min(...moved.map((p) => p.x)) >= 10, true);
  assert.equal(Math.min(...moved.map((p) => p.y)), 0.5);
  // a library without the cottage's wall: the slab is flagged, not broken
  const placements = compilePlan(cottage(), kit()).placements;
  const wallId = placements.find((p) => /Tavern Wall/.test(catalog.get(p.assetId).name)).assetId;
  const smaller = new Catalog(catalog.assets.filter((a) => a.id !== wallId));
  const pf = analyzePrefab(placements, smaller);
  assert.ok(pf.missing > 0 && pf.missingIds.includes(wallId));
  // from slab text, with metadata kept
  const { text } = await encodeSlab(placements);
  const fromText = await prefabFromSlab(text, catalog, { ref: 'modio:1', name: 'Cottage' });
  assert.deepEqual([fromText.ref, fromText.w, fromText.d], ['modio:1', 6, 4]);
});

test('prefab: doors of a building set back inside a walled yard are still found', () => {
  for (const side of ['s', 'n']) {
    const plan = {
      ...cottage(14, 14, { x: 4, y: side === 's' ? 7 : 3, w: 6, h: 4 }, side === 's' ? { x: 6, y: 10, side: 's' } : { x: 6, y: 3, side: 'n' }),
      barriers: [{ label: 'wall', kind: 'fortification', material: 'castle', points: [[0.5, 0.5], [13.5, 0.5], [13.5, 13.5], [0.5, 13.5]], closed: true, gates: [], towers: false }],
    };
    const pf = analyzePrefab(compilePlan(plan, kit()).placements, catalog);
    assert.deepEqual(pf.entrances, [side], `door on ${side}`);
  }
});
