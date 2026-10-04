// Prefabs: community slabs used whole, as pieces of a larger build.
//
// A slab is just placements. analyzePrefab() works out what it is for the AI
// and the compiler: its footprint in tiles, storeys, which sides have doors,
// whether every asset exists in this GM's library, and the base cells it
// covers with its own floor (so generated ground is left out under it).
//
// transformPrefab() turns it in quarter turns and moves it. Rotation sense is
// from conventions measured in-game: +6 steps (90 degrees) is clockwise seen
// from above with north (+z) up, the same sense as the pitched-roof tables
// (east edge 0 -> south edge 6). A placement stores its asset's origin, which
// for tiles is the min corner of the rotated footprint and for props the
// centre; turning goes through the collider centre so both stay right.

import { colliderOffset, placedBounds, QUARTER } from './geometry.js';
import { tileClass } from './catalog.js';
import { decodeSlab, round2 } from './slab.js';

function centreOffset(asset, rot) {
  const steps = ((rot % 24) + 24) % 24;
  if (steps % QUARTER === 0) return colliderOffset(asset, steps);
  return [asset.center.x, asset.center.z];
}

const box = (asset, p) => (asset ? placedBounds(asset, p) : [p.x, p.z, p.x, p.z]);

export async function prefabFromSlab(text, catalog, meta = {}) {
  const { placements } = await decodeSlab(text);
  return { ...analyzePrefab(placements, catalog), ...meta, slab: text };
}

// -> { placements (normalized), w, d, height, floors, entrances, genre, groups,
//      missing, missingIds, count, ground (Set 'x,z' world cells), groundTop, hasGround }
export function analyzePrefab(placements, catalog) {
  if (!placements.length) throw new Error('the slab is empty');
  let minX = Infinity;
  let minZ = Infinity;
  let minY = Infinity;
  const missingIds = new Set();
  for (const p of placements) {
    const a = catalog.get(p.assetId);
    if (!a) missingIds.add(p.assetId);
    const b = box(a, p);
    minX = Math.min(minX, b[0]);
    minZ = Math.min(minZ, b[1]);
    minY = Math.min(minY, p.y);
  }
  // keep the slab's own grid: shift by whole tiles only
  const sx = -Math.floor(minX + 1e-6);
  const sz = -Math.floor(minZ + 1e-6);
  const sy = -minY;
  const norm = placements.map((p) => ({ ...p, x: round2(p.x + sx), z: round2(p.z + sz), y: round2(p.y + sy) }));
  let maxX = 0;
  let maxZ = 0;
  let maxY = 0;
  const genres = { fantasy: 0, scifi: 0 };
  const groups = new Map();
  const floorLevels = new Map();
  const doors = [];
  const base = [];
  // the building inside the slab: everything but its ground tiles and props
  const core = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of norm) {
    const a = catalog.get(p.assetId);
    const b = box(a, p);
    maxX = Math.max(maxX, b[2]);
    maxZ = Math.max(maxZ, b[3]);
    if (!a) continue;
    const isBase = tileClass(a) === 'floors' && p.y < 0.3;
    if (a.kind === 'tile' && !isBase) {
      core[0] = Math.min(core[0], b[0]);
      core[1] = Math.min(core[1], b[1]);
      core[2] = Math.max(core[2], b[2]);
      core[3] = Math.max(core[3], b[3]);
    }
    maxY = Math.max(maxY, p.y + a.size.y);
    genres[a.genre === 'scifi' ? 'scifi' : 'fantasy']++;
    if (a.group) groups.set(a.group, (groups.get(a.group) || 0) + 1);
    const cls = tileClass(a);
    if (cls === 'floors') {
      const lvl = Math.round((p.y + a.size.y) * 4) / 4;
      floorLevels.set(lvl, (floorLevels.get(lvl) || 0) + 1);
      if (p.y < 0.3) base.push({ b, top: p.y + a.size.y });
    }
    if (a.kind === 'tile' && (cls === 'doors' || /door/i.test(a.name)) && p.y < 1) doors.push(b);
  }
  const w = Math.max(1, Math.ceil(maxX - 1e-6));
  const d = Math.max(1, Math.ceil(maxZ - 1e-6));
  // storeys: floor levels with a real number of tiles, at least a storey apart
  const levels = [...floorLevels].filter(([, n]) => n >= 4).map(([l]) => l).sort((a, b) => a - b);
  let floors = 0;
  let last = -Infinity;
  for (const l of levels) {
    if (l - last >= 1.5) {
      floors++;
      last = l;
    }
  }
  if (core[0] === Infinity) core.splice(0, 4, 0, 0, w, d);
  const entrances = new Set();
  for (const b of doors) {
    if (b[1] < core[1] + 0.75) entrances.add('s');
    if (b[3] > core[3] - 0.75) entrances.add('n');
    if (b[0] < core[0] + 0.75) entrances.add('w');
    if (b[2] > core[2] - 0.75) entrances.add('e');
  }
  const ground = new Set();
  let groundTop = 0;
  for (const { b, top } of base) {
    for (let x = Math.floor(b[0] + 0.01); x < Math.ceil(b[2] - 0.01); x++) for (let z = Math.floor(b[1] + 0.01); z < Math.ceil(b[3] - 0.01); z++) ground.add(`${x},${z}`);
    groundTop = Math.max(groundTop, top);
  }
  return {
    placements: norm,
    w,
    d,
    height: round2(maxY),
    floors: Math.max(1, floors),
    entrances: ['n', 'e', 's', 'w'].filter((s) => entrances.has(s)),
    genre: genres.scifi > genres.fantasy ? 'scifi' : 'fantasy',
    groups: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 5),
    missing: placements.filter((p) => missingIds.has(p.assetId)).length,
    missingIds: [...missingIds],
    count: placements.length,
    ground,
    groundTop: round2(groundTop),
    hasGround: ground.size >= 0.5 * w * d,
    core: { w: Math.max(1, Math.round(core[2] - core[0])), d: Math.max(1, Math.round(core[3] - core[1])) },
  };
}

// Footprint and entrances after `quarter` clockwise turns.
export function rotatedSize(prefab, quarter) {
  return quarter % 2 ? [prefab.d, prefab.w] : [prefab.w, prefab.d];
}

const TURN = { n: 'e', e: 's', s: 'w', w: 'n' };
export function rotatedEntrances(prefab, quarter) {
  let e = prefab.entrances.slice();
  for (let k = 0; k < quarter; k++) e = e.map((s) => TURN[s]);
  return ['n', 'e', 's', 'w'].filter((s) => e.includes(s));
}

// Ground cells after rotation, in prefab-local world cells 'x,z'.
export function rotatedGround(prefab, quarter) {
  let w = prefab.w;
  let d = prefab.d;
  let cells = [...prefab.ground].map((k) => k.split(',').map(Number));
  for (let k = 0; k < quarter; k++) {
    cells = cells.map(([x, z]) => [z, w - 1 - x]);
    [w, d] = [d, w];
  }
  return new Set(cells.map(([x, z]) => `${x},${z}`));
}

// Turn `quarter` times clockwise, then put the footprint's min corner at world
// (x0, z0) and lift by dy.
export function transformPrefab(prefab, catalog, { quarter = 0, x0 = 0, z0 = 0, dy = 0 } = {}) {
  const q = ((quarter % 4) + 4) % 4;
  return prefab.placements.map((p) => {
    const a = catalog.get(p.assetId);
    const [ox, oz] = a ? centreOffset(a, p.rot) : [0, 0];
    let cx = p.x + ox;
    let cz = p.z + oz;
    let rot = p.rot;
    let w = prefab.w;
    let d = prefab.d;
    for (let k = 0; k < q; k++) {
      [cx, cz] = [cz, w - cx];
      rot = (rot + QUARTER) % 24;
      [w, d] = [d, w];
    }
    const [nx, nz] = a ? centreOffset(a, rot) : [0, 0];
    return { ...p, x: round2(cx - nx + x0), z: round2(cz - nz + z0), y: round2(p.y + dy), rot };
  });
}

// A one-line description for the AI.
export function describePrefab(pf) {
  const inner = pf.core && (pf.core.w < pf.w - 1 || pf.core.d < pf.d - 1) ? ` (building ${pf.core.w}x${pf.core.d} on its own ground)` : '';
  const parts = [`${pf.w}x${pf.d} tiles${inner}`, pf.floors > 1 ? `${pf.floors} storeys` : '1 storey'];
  if (pf.entrances.length) parts.push(`doors on ${pf.entrances.join('/')}`);
  parts.push(pf.genre === 'scifi' ? 'sci-fi' : 'fantasy');
  if (pf.groups.length) parts.push(`mostly ${pf.groups.slice(0, 3).map(([g]) => g).join(', ')}`);
  return parts.join('; ');
}
