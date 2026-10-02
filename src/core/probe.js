// Calibration slabs: small builds that make the game its own oracle.
//
// Geometry conventions here were measured in-game by the community (see
// docs/slab-format.md). Furniture "front" direction is not documented anywhere,
// so it is a setting (furnitureFacing, in rotation steps). Paste a probe and
// look:
//   house   -- a one-room cottage: walls flush at corners, door in the south
//              wall, windows, pitched roof, furniture against walls
//   tower   -- three storeys, upper floors, stairs, flat roof, crenellations
//   facing  -- four pads, each with the same prop against a back wall using
//              facing offsets 0, 6, 12, 18 (left to right). Whichever pad looks
//              right is the furnitureFacing value to use.

import { placeInCell, placeOnEdge, edgeRotation, rotatedFootprint, placeCentered } from './geometry.js';
import { normalizePlacements } from './slab.js';

export function probePlan(kind = 'house') {
  const base = { version: 1, summary: '', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '' };
  if (kind === 'tower') {
    return {
      ...base, title: 'TaleForge probe: tower', width: 8, height: 8, style: 'castle', ground: 'grass',
      structures: [{ id: 'tower', label: 'Probe tower', kind: 'tower', parts: [{ x: 2, y: 2, w: 4, h: 4 }], rooms: [], doors: [{ x: 3, y: 5, side: 's' }],
        wall: 'castle', floor: 'stone_floor', storeys: 3, roof: 'flat', windows: 'few', interiorWalls: false, furnish: 'sparse' }],
    };
  }
  return {
    ...base, title: 'TaleForge probe: cottage', width: 12, height: 10, style: 'medieval', ground: 'grass',
    structures: [{ id: 'cottage', label: 'Probe cottage', kind: 'cottage', parts: [{ x: 3, y: 2, w: 6, h: 5 }], rooms: [], doors: [{ x: 5, y: 6, side: 's' }],
      wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'pitched', windows: 'many', interiorWalls: false, furnish: 'normal' }],
    paths: [{ label: 'path', material: 'dirt', width: 1, points: [[5.5, 7], [5.5, 10]] }],
  };
}

// Four 3x3 pads in a row; each has a back wall on its far (+z) edge and the
// prop against it, rotated by the pad's facing offset.
export function facingProbe(kit, role = 'bed') {
  const floor = (kit.surface('wood_floor') || kit.surface('stone_floor') || kit.surface('grass'));
  const wall = kit.wall('wood') || kit.wall('stone');
  const prop = kit.props(role)[0];
  if (!floor || !wall || !prop) throw new Error(`cannot build a facing probe: missing ${!floor ? 'floor' : !wall ? 'wall' : role}`);
  const out = [];
  const top = floor.base.size.y;
  [0, 6, 12, 18].forEach((offset, i) => {
    const x0 = i * 4;
    for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) out.push(placeInCell(floor.base, x0 + dx, dz, 0, 0));
    for (let dx = 0; dx < 3; dx++) out.push(placeOnEdge(wall.plain1, x0 + dx, 2, 'zMax', top));
    // i+1 extra floor tiles on the near edge so pads can be told apart
    for (let k = 0; k <= i; k++) out.push(placeInCell(floor.base, x0 + k, -1, 0, 0));
    const rot = edgeRotation(prop, 'zMax', offset);
    const [, fz] = rotatedFootprint(prop, rot);
    out.push(placeCentered(prop, x0 + 1.5, 3 - wall.thickness - fz / 2 - 0.03, top, rot));
  });
  return normalizePlacements(out);
}
