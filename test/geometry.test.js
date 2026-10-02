import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAsset, Catalog, assetsFromIndexJson, assetsFromContentPacks, inferBoundsScale } from '../src/core/catalog.js';
import {
  placeCentered, placeInCell, placeOnEdge, rotatedFootprint, placedBounds, edgeRotation, boxesOverlap,
} from '../src/core/geometry.js';

const tile = (name, sx, sy, sz, extra = {}) =>
  makeAsset({ id: crypto.randomUUID(), name, kind: 'tile', size: { x: sx, y: sy, z: sz }, ...extra });

test('reproduces two walls TaleSpire placed itself', () => {
  // Ground truth copied out of the game (recorded by the citysmith project):
  // 'Wall Only With Window', 0.5 x 2.0 footprint, rot 0 -> (0.50, 0.00), rot 270 -> (0.00, 3.50).
  const wall = tile('Wall Only With Window', 0.5, 2.0, 2.0);
  const a = placeCentered(wall, 0.75, 1.0, 0, 0);
  assert.deepEqual([a.x, a.z], [0.5, 0]);
  const b = placeCentered(wall, 1.0, 3.75, 0, 18);
  assert.deepEqual([b.x, b.z], [0, 3.5]);
});

test('footprints swap axes on odd quarter turns only', () => {
  const wall = tile('castle wall 1x1', 1, 2, 0.5);
  assert.deepEqual(rotatedFootprint(wall, 0), [1, 0.5]);
  assert.deepEqual(rotatedFootprint(wall, 6), [0.5, 1]);
  assert.deepEqual(rotatedFootprint(wall, 12), [1, 0.5]);
  assert.deepEqual(rotatedFootprint(wall, 18), [0.5, 1]);
});

test('a tile placed in a cell occupies exactly that cell at every quarter turn', () => {
  const floor = tile('Floor 2x1', 2, 0.25, 1);
  for (const rot of [0, 6, 12, 18]) {
    const p = placeInCell(floor, 5, 7, 0, rot);
    const [x0, z0, x1, z1] = placedBounds(floor, p);
    const [fx, fz] = rotatedFootprint(floor, rot);
    assert.deepEqual([x0, z0, x1, z1], [5, 7, 5 + fx, 7 + fz]);
    assert.deepEqual([p.x, p.z], [5, 7], 'tiles store the min corner');
  }
});

test('walls sit inside the cell against the named edge', () => {
  const xWall = tile('castle wall 1x1', 1, 2, 0.5); // authored along x
  const zWall = tile('Rural Wall 01', 0.5, 2, 1); // authored along z
  for (const wall of [xWall, zWall]) {
    const box = (edge) => placedBounds(wall, placeOnEdge(wall, 3, 4, edge, 0.5));
    assert.deepEqual(box('zMin'), [3, 4, 4, 4.5]);
    assert.deepEqual(box('zMax'), [3, 4.5, 4, 5]);
    assert.deepEqual(box('xMin'), [3, 4, 3.5, 5]);
    assert.deepEqual(box('xMax'), [3.5, 4, 4, 5]);
    assert.equal(placeOnEdge(wall, 3, 4, 'zMin', 0.5).y, 0.5);
  }
  assert.equal(edgeRotation(xWall, 'zMin'), 0);
  assert.equal(edgeRotation(zWall, 'zMin'), 6, 'z-authored pieces get a quarter turn');
  assert.equal(edgeRotation(xWall, 'xMin'), 18);
});

test('a two-cell wall piece spans its run', () => {
  const long = tile('castle wall 2x2', 2, 2, 0.5);
  const box = placedBounds(long, placeOnEdge(long, 0, 0, 'xMax', 0, { span: 2 }));
  assert.deepEqual(box, [0.5, 0, 1, 2]);
});

test('props are centred on their origin', () => {
  const barrel = makeAsset({ id: crypto.randomUUID(), name: 'Barrel', kind: 'prop', size: { x: 0.6, y: 0.9, z: 0.6 }, center: { x: 0, y: 0.45, z: 0 } });
  const p = placeCentered(barrel, 2.5, 3.5, 0.5, 5);
  assert.deepEqual([p.x, p.y, p.z, p.rot], [2.5, 0.5, 3.5, 5]);
  const b = placedBounds(barrel, p);
  assert.ok(b[0] > 2 && b[2] < 3 && b[1] > 3 && b[3] < 4);
  assert.ok(!boxesOverlap(b, [3, 3, 4, 4]));
});

test('install index.json entries use half extents', () => {
  const index = {
    Name: 'TaleSpire',
    Tiles: [{ Id: 'AAAAAAAA-0000-0000-0000-000000000001', Name: 'castle wall 1x1', GroupTag: 'Wall', Tags: ['Stone', 'Wall'],
      ColliderBoundsBound: { m_Center: { x: 0.5, y: 1, z: 0.25 }, m_Extent: { x: 0.5, y: 1, z: 0.25 } } }],
    Props: [{ Id: 'aaaaaaaa-0000-0000-0000-000000000002', Name: 'Barrel', GroupTag: 'Container', Tags: [],
      ColliderBoundsBound: { m_Center: { x: 0, y: 0.45, z: 0 }, m_Extent: { x: 0.3, y: 0.45, z: 0.3 } }, IsDeprecated: false }],
  };
  const [wall, barrel] = assetsFromIndexJson(index);
  assert.deepEqual(wall.size, { x: 1, y: 2, z: 0.5 });
  assert.equal(wall.id, 'aaaaaaaa-0000-0000-0000-000000000001');
  assert.deepEqual(wall.tags, ['stone', 'wall']);
  assert.deepEqual(barrel.center, { x: 0, y: 0.45, z: 0 });
});

test('symbiote bounds: full-size vs half-extent is inferred from the tiles', () => {
  const mk = (w, d, cx, cz) => ({ id: crypto.randomUUID(), name: 'T', groupTag: 'Floor', tags: [], colliderBoundsBound: { center: { x: cx, y: 0.1, z: cz }, width: w, height: 0.25, depth: d } });
  const fullSize = [mk(1, 1, 0.5, 0.5), mk(2, 2, 1, 1), mk(1, 0.5, 0.5, 0.25)];
  const halfExt = [mk(0.5, 0.5, 0.5, 0.5), mk(1, 1, 1, 1), mk(0.5, 0.25, 0.5, 0.25)];
  assert.equal(inferBoundsScale(fullSize), 1);
  assert.equal(inferBoundsScale(halfExt), 2);
  const { assets, boundsScale } = assetsFromContentPacks([{ id: 'p', optionalName: 'Core', tiles: halfExt, props: [] }]);
  assert.equal(boundsScale, 2);
  assert.deepEqual(assets[1].size, { x: 2, y: 0.5, z: 2 });
});

test('catalog queries and compact export', () => {
  const cat = new Catalog([
    tile('castle floor 1x1', 1, 0.5, 1, { group: 'Floor', tags: ['stone', 'floor'] }),
    tile('castle wall 1x1', 1, 2, 0.5, { group: 'Wall', tags: ['stone', 'wall'] }),
    tile('castle wall 1x1 window', 1, 2, 0.5, { group: 'Wall', tags: ['stone', 'wall', 'window'] }),
    tile('Old Wall', 1, 2, 0.5, { group: 'Wall', tags: ['stone'], deprecated: true }),
    makeAsset({ id: crypto.randomUUID(), name: 'Barrel, Wine', kind: 'prop', group: 'Containers', tags: ['barrel'], size: { x: 0.6, y: 1, z: 0.6 } }),
  ]);
  assert.equal(cat.byName('  CASTLE   wall 1x1 ').name, 'castle wall 1x1');
  assert.equal(cat.find({ group: 'wall', thin: true, length: 1 }).length, 2, 'deprecated assets are skipped');
  assert.equal(cat.find({ group: 'wall', tags: ['window'] })[0].name, 'castle wall 1x1 window');
  assert.equal(cat.find({ group: 'wall', excludeTerms: ['window'] }).length, 1);
  assert.equal(cat.find({ footprint: [1, 1] })[0].name, 'castle floor 1x1');
  assert.equal(cat.fuzzy('a wine barrel')[0].name, 'Barrel, Wine');
  const back = Catalog.fromJSON(JSON.parse(JSON.stringify(cat.toJSON())));
  assert.equal(back.size, cat.size);
  assert.deepEqual(back.byName('castle wall 1x1').size, { x: 1, y: 2, z: 0.5 });
});
