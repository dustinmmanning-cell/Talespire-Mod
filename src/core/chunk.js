// Cutting a build into slabs TaleSpire will accept.
//
// One slab may compress to at most 30,720 bytes. A large build is split by
// recursive bisection of its footprint, measuring the real compressed size,
// so every chunk is a contiguous region (paste a subset and you get a
// connected piece of the map).
//
// A vanilla Ctrl+V / sendSlabToHand is cursor-anchored: the slab arrives at the
// cursor relative to its own bounding box. So with `register: true` every chunk
// carries the same two registration tiles, just outside opposite corners of the
// whole build: all chunks then share one bounding box and assemble when each is
// placed at the same cursor cell. (Technique from the citysmith project.)
//
// With `register: false` chunks keep true coordinates and no markers, for
// LordAshes' MultiPasteSlabsPlugin / SlabPlugin_CCM, which place each slab at a
// stated offset.

import { compressedSize, encodeSlab, normalizePlacements, slabBounds, MAX_SLAB_BYTES } from './slab.js';
import { placeInCell, placedBounds } from './geometry.js';

export const DEFAULT_CHUNK_BUDGET = 29000; // keep a margin under the hard limit

function anchor(p) {
  return [Math.floor(p.x + 1e-6), Math.floor(p.z + 1e-6)];
}

function stripMeta(list) {
  return list.map(({ assetId, x, y, z, rot }) => ({ assetId, x, y, z, rot }));
}

// The ground box every placement really occupies (colliders, not origins), so
// registration markers sit outside everything in every chunk.
function extentOf(placements, assetOf) {
  const b = slabBounds(placements);
  const e = { x0: Math.floor(b.minX), z0: Math.floor(b.minZ), x1: Math.floor(b.maxX) + 1, z1: Math.floor(b.maxZ) + 1 };
  for (const p of placements) {
    const a = assetOf && assetOf(p.assetId);
    const box = a ? placedBounds(a, p) : [p.x - 2, p.z - 2, p.x + 3, p.z + 3];
    e.x0 = Math.min(e.x0, Math.floor(box[0]));
    e.z0 = Math.min(e.z0, Math.floor(box[1]));
    e.x1 = Math.max(e.x1, Math.ceil(box[2]));
    e.z1 = Math.max(e.z1, Math.ceil(box[3]));
  }
  return e;
}

// placements: world-space placements (>= 0). gridHeight: plan height (for
// reporting regions in plan coordinates). markerAsset: a 1x1 tile.
// assetOf: id -> catalog asset, for exact extents.
export async function chunkPlacements(placements, { maxBytes = DEFAULT_CHUNK_BUDGET, register = true, markerAsset = null, gridHeight = null, assetOf = null } = {}) {
  if (placements.length === 0) return { chunks: [], registered: false };
  if (maxBytes > MAX_SLAB_BYTES) maxBytes = MAX_SLAB_BYTES;
  const b = slabBounds(placements);
  const world = { x0: Math.floor(b.minX), z0: Math.floor(b.minZ), x1: Math.floor(b.maxX) + 1, z1: Math.floor(b.maxZ) + 1 };

  let markers = [];
  let all = placements;
  const whole = await compressedSize(stripMeta(placements));
  const needSplit = whole > maxBytes;
  if (needSplit && register) {
    if (!markerAsset) throw new Error('a marker tile is needed to register multi-slab builds');
    // Markers just outside the build's corners; shift everything so the low
    // marker sits at the origin. Whole-tile shifts keep the grid intact.
    const ext = extentOf(placements, assetOf);
    markers = [
      placeInCell(markerAsset, ext.x0 - 1, ext.z0 - 1, 0, 0),
      placeInCell(markerAsset, ext.x1, ext.z1, 0, 0),
    ];
    const shifted = normalizePlacements([...markers, ...placements]);
    const dx = shifted[2].x - placements[0].x;
    const dz = shifted[2].z - placements[0].z;
    markers = shifted.slice(0, 2);
    all = shifted.slice(2);
    world.x0 += dx;
    world.z0 += dz;
    world.x1 += dx;
    world.z1 += dz;
    world.shiftX = dx;
    world.shiftZ = dz;
  }

  const regions = [];
  const budget = maxBytes - (markers.length ? 120 : 0);
  async function split(list, rect, depth) {
    const size = await compressedSize(stripMeta(list.length ? list : markers));
    if (size <= budget || depth > 24) {
      regions.push({ list, rect, size });
      return;
    }
    const w = rect.x1 - rect.x0;
    const h = rect.z1 - rect.z0;
    if (w <= 1 && h <= 1) {
      regions.push({ list, rect, size });
      return;
    }
    const alongX = w >= h;
    const mid = alongX ? rect.x0 + Math.floor(w / 2) : rect.z0 + Math.floor(h / 2);
    const a = [];
    const c = [];
    for (const p of list) {
      const [ax, az] = anchor(p);
      ((alongX ? ax : az) < mid ? a : c).push(p);
    }
    const ra = alongX ? { ...rect, x1: mid } : { ...rect, z1: mid };
    const rc = alongX ? { ...rect, x0: mid } : { ...rect, z0: mid };
    if (a.length) await split(a, ra, depth + 1);
    if (c.length) await split(c, rc, depth + 1);
  }
  await split(all, world, 0);

  // Order chunks top-left first in plan terms (high z first), then by x.
  regions.sort((p, q) => q.rect.z1 - p.rect.z1 || p.rect.x0 - q.rect.x0);
  const shiftZ = world.shiftZ || 0;
  const shiftX = world.shiftX || 0;
  const chunks = [];
  for (let i = 0; i < regions.length; i++) {
    const { list, rect } = regions[i];
    const withMarkers = [...markers, ...stripMeta(list)];
    const enc = await encodeSlab(withMarkers, { maxBytes: MAX_SLAB_BYTES });
    const region = gridHeight
      ? { x: rect.x0 - shiftX, y: gridHeight - (rect.z1 - shiftZ), w: rect.x1 - rect.x0, h: rect.z1 - rect.z0 }
      : { x: rect.x0, y: rect.z0, w: rect.x1 - rect.x0, h: rect.z1 - rect.z0 };
    chunks.push({
      index: i,
      label: regions.length > 1 ? `part ${i + 1} of ${regions.length}` : 'whole build',
      region,
      count: list.length,
      text: enc.text,
      compressedBytes: enc.compressedBytes,
      placements: withMarkers,
    });
  }
  return { chunks, registered: markers.length > 0 };
}

// LordAshes' multi-slab document: one JSON holding every chunk with the
// position it belongs at. Chunks must be cut with register: false.
export function multiSlabJson(chunks, { drop = [0, 0, 0], autoDrop = true } = {}) {
  return JSON.stringify({
    autoDrop,
    dropX: drop[0],
    dropY: drop[1],
    dropZ: drop[2],
    slabs: chunks.map((c) => ({ code: c.text, offsetX: 0, offsetY: 0, offsetZ: 0 })),
  }, null, 2);
}
