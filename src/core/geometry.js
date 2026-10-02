// Turning "this asset, in that cell / on that edge" into slab coordinates.
//
// Conventions (measured in-game by the community; see docs/slab-format.md):
//   - 1 world unit = 1 tile = 5 ft. y is up. x/z are the ground plane.
//   - A placement stores the asset's ORIGIN. Tiles are authored with their
//     collider's min corner on the origin, and the game re-anchors a rotated
//     tile to the min corner of its rotated footprint. Props are authored with
//     the collider centred on the origin. Both cases reduce to:
//         stored = desiredColliderCentre - colliderOffset(rot)
//     where the offset's x/z swap on odd quarter turns.
//   - Rotation is a step index 0..23 (15 degrees each). A quarter turn is 6.
//   - Walls along the four edges of a cell use rot 0/6/12/18 for the
//     zMin/xMax/zMax/xMin edges. A piece authored along z (its z size larger
//     than its x size) gets one extra quarter turn so it lies along the run.
//
// TaleForge's own grid uses plan coordinates (x right, y down, like an image)
// and maps them to world x/z with z = depth - 1 - y so the top of a reference
// image is the far (+z) side of the board. That mapping lives in the compiler;
// everything here is world space.

import { round2 } from './slab.js';

export const QUARTER = 6;
export const EDGES = ['zMin', 'xMax', 'zMax', 'xMin'];
export const EDGE_ROT = { zMin: 0, xMax: 6, zMax: 12, xMin: 18 };

export function isOddQuarter(rot) {
  return Math.floor((((rot % 24) + 24) % 24) / QUARTER) % 2 === 1;
}

// Ground footprint after rotation, as [x, z]. Only quarter turns are exact.
export function rotatedFootprint(asset, rot) {
  return isOddQuarter(rot) ? [asset.size.z, asset.size.x] : [asset.size.x, asset.size.z];
}

export function colliderOffset(asset, rot) {
  return isOddQuarter(rot) ? [asset.center.z, asset.center.x] : [asset.center.x, asset.center.z];
}

// True for wall-like pieces modelled along the z axis.
export function authoredAlongZ(asset) {
  return asset.size.z > asset.size.x + 1e-6;
}

export function makePlacement(asset, x, y, z, rot, meta) {
  const p = { assetId: asset.id, x: round2(x), y: round2(y), z: round2(z), rot: ((rot % 24) + 24) % 24 };
  if (meta) p.meta = meta;
  return p;
}

// Put the asset's collider centre at (cx, cz), its base at y.
export function placeCentered(asset, cx, cz, y, rot = 0, meta) {
  const [ox, oz] = colliderOffset(asset, rot);
  return makePlacement(asset, cx - ox, y, cz - oz, rot, meta);
}

// Fill the cell (or block of cells) whose min corner is (tx, tz).
export function placeInCell(asset, tx, tz, y, rot = 0, meta) {
  const [fx, fz] = rotatedFootprint(asset, rot);
  return placeCentered(asset, tx + fx / 2, tz + fz / 2, y, rot, meta);
}

// The rotation that lays a wall piece along `edge`, honouring authoring axis.
export function edgeRotation(asset, edge, extra = 0) {
  let rot = EDGE_ROT[edge];
  if (rot === undefined) throw new Error(`unknown edge ${edge}`);
  if (authoredAlongZ(asset)) rot += QUARTER;
  return (rot + extra) % 24;
}

// Place a wall-like piece on one edge of cell (tx, tz), covering `span` cells
// along the run starting at that cell, inset so its thin axis sits inside the
// cell against the boundary (two buildings sharing a lot line never overlap).
export function placeOnEdge(asset, tx, tz, edge, y, { span = 1, extraRot = 0, meta } = {}) {
  const rot = edgeRotation(asset, edge, extraRot);
  const [fx, fz] = rotatedFootprint(asset, rot);
  const t = Math.min(fx, fz);
  let cx;
  let cz;
  if (edge === 'zMin' || edge === 'zMax') {
    cx = tx + span / 2;
    cz = edge === 'zMin' ? tz + t / 2 : tz + 1 - t / 2;
  } else {
    cz = tz + span / 2;
    cx = edge === 'xMin' ? tx + t / 2 : tx + 1 - t / 2;
  }
  return placeCentered(asset, cx, cz, y, rot, meta);
}

// World-space ground box [x0, z0, x1, z1] a placement occupies (quarter turns exact;
// other rotations use the rotated-rectangle's bounding box).
export function placedBounds(asset, p) {
  const steps = ((p.rot % 24) + 24) % 24;
  if (steps % QUARTER === 0) {
    const [fx, fz] = rotatedFootprint(asset, steps);
    const [ox, oz] = colliderOffset(asset, steps);
    const cx = p.x + ox;
    const cz = p.z + oz;
    return [cx - fx / 2, cz - fz / 2, cx + fx / 2, cz + fz / 2];
  }
  const ang = (steps * 15 * Math.PI) / 180;
  const c = Math.abs(Math.cos(ang));
  const s = Math.abs(Math.sin(ang));
  const hx = (asset.size.x * c + asset.size.z * s) / 2;
  const hz = (asset.size.x * s + asset.size.z * c) / 2;
  const cx = p.x + asset.center.x;
  const cz = p.z + asset.center.z;
  return [cx - hx, cz - hz, cx + hx, cz + hz];
}

export function boxesOverlap(a, b, eps = 1e-3) {
  return a[0] < b[2] - eps && b[0] < a[2] - eps && a[1] < b[3] - eps && b[1] < a[3] - eps;
}
