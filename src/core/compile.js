// Plan -> placements. Deterministic: the same plan, kit and seed always give
// the same slab.
//
// Pipeline:
//   1. rasterize ground, areas, paths, trace rasters and structure footprints
//      onto a tile grid (plan coordinates: x right, y down)
//   2. derive wall edges around every structure, partitions between rooms,
//      doors (guaranteeing every room is reachable) and windows
//   3. emit surfaces (merging into 2x2 tiles where the game has them), walls
//      per storey, upper floors, stairs, roofs, barriers
//   4. place props: the plan's explicit props, then furniture, then scatter,
//      never letting two props overlap (TaleSpire silently drops overlapping
//      props on paste) and never inside a wall or a doorway
//
// World space: tile (x, y) maps to world cell (x, H-1-y); see geometry.js.

import { normalizePlan } from './plan.js';
import {
  placeInCell, placeOnEdge, placeCentered, placedBounds, boxesOverlap, rotatedFootprint, edgeRotation, EDGE_ROT,
} from './geometry.js';
import { ROOF_EDGE_ROT, ROOF_CORNER_ROT } from './kit.js';
import { furnitureRules, ruleCount, STRUCTURE_ROOM, UPPER_ROOM, UPPER_MAIN } from './furnish.js';
import { makeRng, polygonCells, polylineCells, gridLineEdges } from './util.js';
import { normalizePlacements, round2 } from './slab.js';
import { rotatedSize, rotatedGround, rotatedEntrances, transformPrefab } from './prefab.js';
import { tileClass } from './catalog.js';

const SIDES4 = ['n', 'e', 's', 'w'];
const SIDE_EDGE = { n: 'zMax', s: 'zMin', e: 'xMax', w: 'xMin' };
const SIDE_DELTA = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const NATURAL = new Set(['grass', 'dirt', 'mud', 'gravel', 'sand', 'snow', 'swamp', 'cave_floor', 'field', 'ice', 'lava']);
const UNWALKABLE = new Set(['water', 'deep_water', 'lava']);
const ROADLIKE = new Set(['cobblestone', 'flagstone', 'gravel', 'dirt', 'plank', 'stone_floor']);
const NATURE_ROLES = new Set(['tree', 'conifer', 'dead_tree', 'bush', 'rock', 'boulder', 'flowers', 'tall_grass', 'log', 'stump', 'mushroom', 'crystal']);
const FLOATING_ROLES = new Set(['boat']);

// Spatial hash of ground boxes [x0, z0, x1, z1] in world units.
class Occupancy {
  constructor() {
    this.cells = new Map();
  }
  *keys(b) {
    for (let x = Math.floor(b[0]); x <= Math.floor(b[2] - 1e-6); x++) {
      for (let z = Math.floor(b[1]); z <= Math.floor(b[3] - 1e-6); z++) yield `${x},${z}`;
    }
  }
  fits(b) {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) for (const o of list) if (boxesOverlap(o, b)) return false;
    }
    return true;
  }
  add(b) {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) list.push(b);
      else this.cells.set(k, [b]);
    }
  }
}

export function compilePlan(planInput, kit, options = {}) {
  const { plan, warnings } = planInput.version === 1 && options.normalized ? { plan: planInput, warnings: [] } : normalizePlan(planInput);
  const b = new Builder(plan, kit, options, warnings);
  return b.run();
}

class Builder {
  constructor(plan, kit, options, warnings) {
    // Barrier towers and traced structures are appended; never touch the caller's plan.
    this.plan = { ...plan, structures: plan.structures.slice(), props: plan.props.slice() };
    this.kit = kit;
    this.opts = { seed: options.seed ?? plan.title ?? 'taleforge', furnitureFacing: options.furnitureFacing ?? 0, ...options };
    this.warnings = warnings;
    this.W = plan.width;
    this.H = plan.height;
    this.rng = makeRng(`${this.opts.seed}`);
    const n = this.W * this.H;
    this.surf = new Array(n).fill(null);
    this.struct = new Int32Array(n).fill(-1);
    this.room = new Int32Array(n).fill(-1);
    this.structures = [];
    this.rooms = [];
    this.edges = new Map(); // `${cell}:${side}` -> { s, type, partition, inset }
    this.placements = [];
    this.props = new Occupancy();
    this.doorClear = new Occupancy();
    this.preview = { props: [], barriers: [], doors: [], windows: [], stairs: [], prefabs: [] };
    this.prefabAt = new Int32Array(n).fill(-1); // community slab footprints, by placed index
    this.placedPrefabs = [];
    this.missing = new Set();
    this.top = 0;
    this.floors = []; // previews of upper floors: { structure, label, level, grid }
  }

  warn(m) {
    if (!this.warnings.includes(m)) this.warnings.push(m);
  }

  idx(x, y) {
    return y * this.W + x;
  }
  inMap(x, y) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }
  tz(y) {
    return this.H - 1 - y;
  }
  emit(p, layer, extra) {
    p.meta = { layer, ...(extra || {}) };
    this.placements.push(p);
    return p;
  }

  run() {
    this.prepareBarriers();
    this.rasterizeGround();
    this.applyRaster();
    this.rasterizeAreasAndPaths();
    this.reservePrefabs();
    this.rasterizeStructures();
    this.computeEdges();
    this.computeTop();
    this.emitSurfaces();
    this.emitPrefabs();
    this.emitStructures();
    this.emitBarriers();
    this.emitPlanProps();
    this.emitFurniture();
    this.emitScatter();
    return this.result();
  }

  // ---- 1. rasterize ------------------------------------------------------

  prepareBarriers() {
    this.barrierEdges = [];
    for (const bar of this.plan.barriers) {
      const { edges, corners } = gridLineEdges(bar.points, bar.closed);
      this.barrierEdges.push({ bar, edges, corners });
      if (bar.kind === 'fortification' && bar.towers) {
        const seen = new Set();
        const list = bar.closed ? corners.slice(0, -1) : corners;
        for (const [cx, cy] of list) {
          const k = `${cx},${cy}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const x0 = Math.max(0, cx - 1);
          const y0 = Math.max(0, cy - 1);
          const x1 = Math.min(this.W, cx + 1);
          const y1 = Math.min(this.H, cy + 1);
          if (x1 - x0 < 1 || y1 - y0 < 1) continue;
          this.plan.structures.push({
            id: `tower_${cx}_${cy}`, label: `${bar.label || 'Wall'} tower`, kind: 'tower', synthetic: true,
            parts: [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }], rooms: [], doors: [], wall: bar.material,
            floor: 'stone_floor', storeys: 3, roof: 'flat', windows: 'none', interiorWalls: false, furnish: 'none',
          });
        }
      }
    }
  }

  rasterizeGround() {
    if (this.plan.ground !== 'none') this.surf.fill(this.plan.ground);
  }

  rasterizeAreasAndPaths() {
    for (const a of this.plan.areas) {
      for (const [x, y] of polygonCells(a.points, this.W, this.H)) this.surf[this.idx(x, y)] = a.material === 'none' ? null : a.material;
    }
    for (const p of this.plan.paths) {
      for (const [x, y] of polylineCells(p.points, p.width, this.W, this.H)) this.surf[this.idx(x, y)] = p.material;
    }
  }

  // Trace-mode raster: characters -> surfaces; structure characters form
  // connected components, each a structure with generated walls.
  applyRaster() {
    const r = this.plan.raster;
    if (!r) return;
    const { legend, rows } = r;
    const cls = new Array(this.W * this.H).fill(null);
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const L = legend[rows[y][x]];
        if (!L) continue;
        const i = this.idx(x, y);
        cls[i] = L;
        if (L.material !== 'none') this.surf[i] = L.material;
        else if (!L.structure) this.surf[i] = null;
        if (L.prop && this.rng.chance(L.propDensity ?? 1)) this.plan.props.push({ role: L.prop, asset: '', x: x + 0.5, y: y + 0.5, rotation: this.rng.int(0, 23) * 15 });
      }
    }
    const seen = new Uint8Array(this.W * this.H);
    for (let i = 0; i < cls.length; i++) {
      const L = cls[i];
      if (seen[i] || !L || !L.structure) continue;
      const key = `${L.structure}|${L.wall}`;
      const cells = [];
      const doorCells = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        if (cls[c].door) doorCells.push(c);
        const cx = c % this.W;
        const cy = (c / this.W) | 0;
        for (const s of SIDES4) {
          const [dx, dy] = SIDE_DELTA[s];
          if (!this.inMap(cx + dx, cy + dy)) continue;
          const n = this.idx(cx + dx, cy + dy);
          const Ln = cls[n];
          if (!seen[n] && Ln && Ln.structure && `${Ln.structure}|${Ln.wall}` === key) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      if (cells.length < 2) continue;
      const floor = L.material === 'none' ? 'stone_floor' : L.material;
      this.plan.structures.push({
        id: `traced_${this.plan.structures.length + 1}`, label: L.label || L.structure, kind: L.structure, cells,
        rasterDoors: doorCells, parts: [], rooms: [], doors: [], wall: L.wall || 'none', floor, storeys: L.storeys || r.storeys,
        roof: L.roof || r.roof, windows: 'none', interiorWalls: false, furnish: L.furnish || r.furnish,
      });
    }
  }

  rasterizeStructures() {
    this.plan.structures.forEach((def, s) => {
      let cells = def.cells ? def.cells.slice() : [];
      for (const part of def.parts) {
        for (let y = part.y; y < part.y + part.h; y++) for (let x = part.x; x < part.x + part.w; x++) cells.push(this.idx(x, y));
      }
      cells = [...new Set(cells)];
      const free = cells.filter((c) => this.prefabAt[c] < 0);
      if (free.length < cells.length) this.warn(`${def.label} overlapped a community slab; the overlapping part was left out`);
      cells = free;
      for (const c of cells) {
        this.struct[c] = s;
        this.surf[c] = def.floor;
      }
      this.structures.push({ def, index: s, cells: [], wall: null, height: 0, doorCount: 0 });
    });
    for (let c = 0; c < this.struct.length; c++) if (this.struct[c] >= 0) this.structures[this.struct[c]].cells.push(c);

    for (const S of this.structures) {
      const def = S.def;
      S.rooms = [];
      // Smaller rooms first, so a room drawn inside a bigger one (a bar in a
      // taproom) keeps its tiles instead of losing them all to the bigger one.
      const byArea = def.rooms.map((r, i) => ({ r, i })).sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h || a.i - b.i);
      for (const { r } of byArea) {
        const room = { id: this.rooms.length, s: S.index, label: r.label, kind: r.kind, open: !!r.open, cells: [] };
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const c = this.idx(x, y);
            if (this.struct[c] === S.index && this.room[c] < 0) {
              this.room[c] = room.id;
              room.cells.push(c);
            }
          }
        }
        if (room.cells.length) {
          this.rooms.push(room);
          S.rooms.push(room);
        }
      }
      const rest = S.cells.filter((c) => this.room[c] < 0);
      if (rest.length) {
        const main = { id: this.rooms.length, s: S.index, label: def.label, kind: def.mainKind || STRUCTURE_ROOM[def.kind] || 'other', cells: rest, main: true };
        if (def.rooms.length && def.interiorWalls) main.kind = 'corridor';
        for (const c of rest) this.room[c] = main.id;
        this.rooms.push(main);
        S.rooms.push(main);
      }
      this.resolveOpenRooms(S);
      S.wall = def.wall === 'none' ? null : this.kit.wall(def.wall);
      if (def.wall !== 'none' && !S.wall) this.warn(`no wall pieces found for "${def.wall}"; ${def.label} has no walls`);
      S.height = S.wall ? S.wall.height : 2;
    }
  }

  // ---- community slabs (prefabs) ----------------------------------------------
  // options.prefabs: Map or object ref -> analyzed prefab (see prefab.js).
  // Reserve each placed slab's footprint so generated structures, barriers,
  // scatter and props keep out, and drop generated ground where the slab
  // brings its own floor.
  reservePrefabs() {
    const lib = this.opts.prefabs || {};
    const get = (ref) => (lib instanceof Map ? lib.get(ref) : lib[ref]);
    for (const pp of this.plan.prefabs || []) {
      const pf = get(pp.ref);
      if (!pf) {
        this.warn(`community slab ${pp.ref} is not loaded; skipped`);
        continue;
      }
      const q = Math.round((pp.rotation || 0) / 90) % 4;
      const [w, d] = rotatedSize(pf, q);
      if (w > this.W || d > this.H) {
        this.warn(`"${pf.name || pp.ref}" (${w}x${d}) does not fit the map; skipped`);
        continue;
      }
      const x = Math.max(0, Math.min(this.W - w, pp.x));
      const y = Math.max(0, Math.min(this.H - d, pp.y));
      if (x !== pp.x || y !== pp.y) this.warn(`"${pf.name || pp.ref}" was moved to fit inside the map`);
      const cells = [];
      for (let yy = y; yy < y + d; yy++) for (let xx = x; xx < x + w; xx++) cells.push(this.idx(xx, yy));
      const clash = cells.find((c) => this.prefabAt[c] >= 0);
      if (clash !== undefined) {
        this.warn(`"${pf.name || pp.ref}" overlaps "${this.placedPrefabs[this.prefabAt[clash]].pf.name}"; skipped`);
        continue;
      }
      const index = this.placedPrefabs.length;
      for (const c of cells) this.prefabAt[c] = index;
      if (pf.hasGround) {
        for (const k of rotatedGround(pf, q)) {
          const [gx, gz] = k.split(',').map(Number);
          if (gx >= 0 && gz >= 0 && gx < w && gz < d) this.surf[this.idx(x + gx, y + d - 1 - gz)] = null;
        }
      }
      this.placedPrefabs.push({ pf, q, x, y, w, d, ref: pp.ref });
      this.preview.prefabs.push({ x, y, w, h: d, label: pf.name || pp.ref, creator: pf.creator || '', entrances: rotatedEntrances(pf, q) });
    }
  }

  emitPrefabs() {
    for (const P of this.placedPrefabs) {
      const { pf, q, x, y, w, d } = P;
      // walking surfaces level with the generated ground
      const dy = pf.hasGround ? this.top - pf.groundTop : this.top;
      const z0 = this.H - y - d;
      let unknown = 0;
      for (const p of transformPrefab(pf, this.kit.catalog, { quarter: q, x0: x, z0, dy })) {
        if (!this.kit.catalog.get(p.assetId)) {
          unknown++;
          continue;
        }
        this.emit({ assetId: p.assetId, x: p.x, y: p.y, z: p.z, rot: p.rot }, 'prefab', { ref: P.ref });
        this.previewPrefabPiece(p);
      }
      if (unknown) this.warn(`"${pf.name || P.ref}" uses ${unknown} asset(s) your TaleSpire doesn't have; they were left out`);
      this.props.add([x, z0, x + w, z0 + d]);
    }
  }

  // A top-down sketch of a placed slab for the preview: its ground-level
  // floors as coloured cells, wall pieces and doors as boxes, props as dots.
  previewPrefabPiece(p) {
    const a = this.kit.catalog.get(p.assetId);
    const cls = tileClass(a);
    const b = placedBounds(a, p);
    const plan = [b[0], this.H - b[3], b[2] - b[0], b[3] - b[1]]; // x, y, w, h in plan coordinates
    const pv = this.preview;
    if (!pv.prefabTiles) Object.assign(pv, { prefabTiles: [], prefabWalls: [] });
    if (a.kind === 'prop') pv.props.push({ x: plan[0] + plan[2] / 2, y: plan[1] + plan[3] / 2, role: 'other', name: a.name });
    else if (cls === 'floors' && p.y < this.top + 1) pv.prefabTiles.push({ x: plan[0], y: plan[1], w: plan[2], h: plan[3], m: surfaceLike(a.name) });
    else if (cls === 'walls' || cls === 'windows' || cls === 'doors' || (Math.min(plan[2], plan[3]) <= 0.6 && a.size.y >= 1.2)) {
      if (p.y < this.top + 1) pv.prefabWalls.push({ x: plan[0], y: plan[1], w: plan[2], h: plan[3], door: cls === 'doors' || /door/i.test(a.name), window: cls === 'windows' });
    }
  }

  // An open room has no walls of its own: for walls it counts as the room it
  // sits in (the walled room it shares the most edge with). wallRoom maps every
  // room id to the id that decides walls.
  resolveOpenRooms(S) {
    this.wallRoom = this.wallRoom || new Map();
    for (const r of S.rooms) this.wallRoom.set(r.id, r.id);
    for (const r of S.rooms) {
      if (!r.open) continue;
      const counts = new Map();
      const mine = new Set(r.cells);
      for (const c of r.cells) {
        for (const side of SIDES4) {
          const n = this.neighbor(c, side);
          if (n < 0 || mine.has(n) || this.struct[n] !== S.index) continue;
          const other = this.rooms[this.room[n]];
          if (other && !other.open) counts.set(other.id, (counts.get(other.id) || 0) + 1);
        }
      }
      const host = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (host) this.wallRoom.set(r.id, host[0]);
    }
    // open rooms that only touch other open rooms follow them to a walled host
    for (let k = 0; k < S.rooms.length; k++) {
      for (const r of S.rooms) if (r.open) {
        const h = this.wallRoom.get(r.id);
        if (h !== r.id && this.rooms[h].open) this.wallRoom.set(r.id, this.wallRoom.get(h));
      }
    }
  }

  sameWallRoom(c, n) {
    const a = this.room[c];
    const b = this.room[n];
    return a === b || (this.wallRoom && this.wallRoom.get(a) === this.wallRoom.get(b));
  }

  // ---- 2. edges, doors, windows -------------------------------------------

  neighbor(c, side) {
    const x = c % this.W;
    const y = (c / this.W) | 0;
    const [dx, dy] = SIDE_DELTA[side];
    return this.inMap(x + dx, y + dy) ? this.idx(x + dx, y + dy) : -1;
  }

  // Pools of water (or lava) wholly inside one structure are part of its
  // interior: no walls around them. Returns Map(cell -> structure index).
  enclosedFeatures() {
    const out = new Map();
    const seen = new Uint8Array(this.W * this.H);
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] || this.struct[i] >= 0 || !UNWALKABLE.has(this.surf[i])) continue;
      const comp = [];
      const owners = new Set();
      let open = false;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const c = stack.pop();
        comp.push(c);
        if (!UNWALKABLE.has(this.surf[c])) open = true;
        for (const side of SIDES4) {
          const n = this.neighbor(c, side);
          if (n < 0) {
            open = true;
            continue;
          }
          if (this.struct[n] >= 0) owners.add(this.struct[n]);
          else if (!seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      if (!open && owners.size === 1) {
        const s = [...owners][0];
        for (const c of comp) out.set(c, s);
      }
    }
    return out;
  }

  computeEdges() {
    const inner = this.enclosedFeatures();
    for (const S of this.structures) {
      if (!S.wall) continue;
      for (const c of S.cells) {
        for (const side of SIDES4) {
          const n = this.neighbor(c, side);
          if (n >= 0 && inner.get(n) === S.index) continue;
          if (n < 0 || this.struct[n] !== S.index) {
            this.edges.set(`${c}:${side}`, { s: S.index, type: 'wall', partition: false });
          } else if (S.def.interiorWalls && !this.sameWallRoom(c, n) && c < n) {
            this.edges.set(`${c}:${side}`, { s: S.index, type: 'wall', partition: true, other: n });
          }
        }
      }
      this.placeDoors(S);
      this.connectRooms(S);
      this.placeWindows(S);
    }
  }

  setDoor(c, side, S) {
    const e = this.edges.get(`${c}:${side}`);
    if (e) {
      e.type = 'door';
      if (!e.partition) S.doorCount++;
      return true;
    }
    // A partition edge is stored once, on the lower-index cell.
    const n = this.neighbor(c, side);
    if (n >= 0) {
      const back = this.edges.get(`${n}:${{ n: 's', s: 'n', e: 'w', w: 'e' }[side]}`);
      if (back) {
        back.type = 'door';
        return true;
      }
      // The edge of an open room inside a walled building: nothing to put a
      // door in, and none needed.
      if (this.struct[n] === S.index && this.struct[c] === S.index && S.def.interiorWalls && this.sameWallRoom(c, n)) return true;
      // Open plan (dungeon rooms joined by passages): a door asked for on an
      // open edge inside the structure stands in the opening.
      if (this.struct[n] === S.index && this.struct[c] === S.index) {
        const [owner, ownerSide] = c < n ? [c, side] : [n, { n: 's', s: 'n', e: 'w', w: 'e' }[side]];
        this.edges.set(`${owner}:${ownerSide}`, { s: S.index, type: 'door', partition: true, freestanding: true });
        return true;
      }
    }
    return false;
  }

  exteriorEdges(S) {
    const out = [];
    for (const c of S.cells) for (const side of SIDES4) {
      const e = this.edges.get(`${c}:${side}`);
      if (e && !e.partition) out.push({ c, side, e });
    }
    return out;
  }

  // An upper floor's outer door must open onto the flat roof of the floor below.
  upperDoorOk(S, c, side) {
    const n = this.neighbor(c, side);
    if (n < 0) return false;
    return this.struct[n] === S.index || S.def.upper.terrace.has(n);
  }

  placeDoors(S) {
    const def = S.def;
    for (const d of def.doors) {
      const c = this.idx(d.x, d.y);
      if (def.upper) {
        if (this.struct[c] !== S.index || !this.upperDoorOk(S, c, d.side) || !this.setDoor(c, d.side, S)) this.warn(`a door on ${def.label} at (${d.x},${d.y}) leads nowhere; skipped`);
        continue;
      }
      if (this.setDoor(c, d.side, S)) continue;
      // Snap to the nearest wall edge of this structure, preferring the same side.
      let best = null;
      for (const { c: ec, side } of this.exteriorEdges(S)) {
        const dist = Math.abs((ec % this.W) - d.x) + Math.abs(((ec / this.W) | 0) - d.y) + (side === d.side ? 0 : 1.5);
        if (!best || dist < best.dist) best = { ec, side, dist };
      }
      if (best && best.dist <= 4) this.setDoor(best.ec, best.side, S);
      else this.warn(`door at (${d.x},${d.y}) of ${def.label} is not on a wall; skipped`);
    }
    for (const c of def.rasterDoors || []) {
      for (const side of SIDES4) {
        const e = this.edges.get(`${c}:${side}`);
        if (e && !e.partition && this.neighborWalkable(c, side)) {
          this.setDoor(c, side, S);
          break;
        }
      }
    }
    if (S.doorCount === 0 && !def.synthetic && !def.upper) {
      let best = null;
      const ext = this.exteriorEdges(S);
      for (const { c, side } of ext) {
        const n = this.neighbor(c, side);
        if (n < 0 || this.struct[n] >= 0 || !this.surf[n] || UNWALKABLE.has(this.surf[n])) continue;
        let score = 1;
        if (ROADLIKE.has(this.surf[n]) && this.surf[n] !== this.plan.ground) score += 3;
        if (this.edges.has(`${this.neighbor(c, SIDES4[(SIDES4.indexOf(side) + 1) % 4])}:${side}`) &&
            this.edges.has(`${this.neighbor(c, SIDES4[(SIDES4.indexOf(side) + 3) % 4])}:${side}`)) score += 1;
        score += this.rng.next() * 0.5;
        if (!best || score > best.score) best = { c, side, score };
      }
      if (best) this.setDoor(best.c, best.side, S);
    }
  }

  neighborWalkable(c, side) {
    const n = this.neighbor(c, side);
    return n >= 0 && this.struct[n] < 0 && this.surf[n] && !UNWALKABLE.has(this.surf[n]);
  }

  // Make every room reachable: add doors on shared walls until connected.
  connectRooms(S) {
    if (S.rooms.length < 2) return;
    for (let guard = 0; guard < S.rooms.length * 2; guard++) {
      const adj = new Map(S.rooms.map((r) => [r.id, new Set()]));
      const shared = new Map();
      for (const c of S.cells) {
        for (const side of ['e', 's']) {
          const n = this.neighbor(c, side);
          if (n < 0 || this.struct[n] !== S.index) continue;
          const ra = this.room[c];
          const rb = this.room[n];
          if (ra === rb) continue;
          const e = this.edges.get(`${c}:${side}`);
          if (!e || e.type === 'door' || e.type === 'open') {
            adj.get(ra).add(rb);
            adj.get(rb).add(ra);
          } else {
            const key = ra < rb ? `${ra}-${rb}` : `${rb}-${ra}`;
            if (!shared.has(key)) shared.set(key, []);
            shared.get(key).push({ c, side });
          }
        }
      }
      const startRooms = new Set();
      if (S.def.upper) for (const c of S.def.upper.entry) if (this.room[c] >= 0) startRooms.add(this.room[c]);
      for (const { c, e } of this.exteriorEdges(S)) if (e.type === 'door') startRooms.add(this.room[c]);
      if (startRooms.size === 0) startRooms.add(S.rooms[0].id);
      const reached = new Set(startRooms);
      const queue = [...startRooms];
      while (queue.length) {
        const r = queue.shift();
        for (const n of adj.get(r) || []) if (!reached.has(n)) {
          reached.add(n);
          queue.push(n);
        }
      }
      if (reached.size === S.rooms.length) return;
      let fixed = false;
      for (const [key, list] of shared) {
        const [ra, rb] = key.split('-').map(Number);
        if (reached.has(ra) !== reached.has(rb)) {
          const mid = list[Math.floor(list.length / 2)];
          this.edges.get(`${mid.c}:${mid.side}`).type = 'door';
          fixed = true;
          break;
        }
      }
      if (!fixed) return;
    }
  }

  placeWindows(S) {
    const level = S.def.windows;
    if (level === 'none' || !S.wall || !S.wall.window) return;
    const every = level === 'many' ? 2 : 4;
    const runs = groupRuns(this.exteriorEdges(S).map(({ c, side, e }) => ({ c, side, e, x: c % this.W, y: (c / this.W) | 0 })));
    for (const run of runs) {
      if (run.length < 3) continue;
      run.forEach((ed, i) => {
        if (i === 0 || i === run.length - 1) return;
        if (ed.e.type !== 'wall') return;
        if (run[i - 1].e.type === 'door' || run[i + 1].e.type === 'door') return;
        if ((i % every) === Math.floor(every / 2)) ed.e.type = 'window';
      });
    }
  }

  // ---- 3. emit geometry ----------------------------------------------------

  computeTop() {
    const used = new Set(this.surf.filter(Boolean));
    let top = 0;
    for (const m of used) {
      const r = this.kit.surface(m);
      if (!r) {
        this.warn(`no tile found for surface "${m}"; those tiles are left empty`);
        continue;
      }
      if (r.material !== m) this.warn(`surface "${m}" not in your asset packs; using "${r.material}"`);
      top = Math.max(top, r.base.size.y);
    }
    this.top = Math.min(1.5, round2(top));
  }

  emitSurfaces() {
    const assigned = new Uint8Array(this.W * this.H);
    const byMat = new Map();
    for (let i = 0; i < this.surf.length; i++) {
      const m = this.surf[i];
      if (!m) continue;
      const r = this.kit.surface(m);
      if (!r) continue;
      if (!byMat.has(r)) byMat.set(r, []);
      byMat.get(r).push(i);
    }
    for (const [r, cells] of byMat) {
      const set = new Set(cells);
      for (const { asset, n } of r.big) {
        for (const c of cells) {
          if (assigned[c]) continue;
          const x = c % this.W;
          const y = (c / this.W) | 0;
          if (x + n > this.W || y + n > this.H) continue;
          let ok = true;
          for (let dy = 0; dy < n && ok; dy++) for (let dx = 0; dx < n && ok; dx++) {
            const k = this.idx(x + dx, y + dy);
            if (assigned[k] || !set.has(k) || this.struct[k] !== this.struct[c]) ok = false;
          }
          if (!ok) continue;
          for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) assigned[this.idx(x + dx, y + dy)] = 1;
          this.emit(placeInCell(asset, x, this.H - n - y, this.top - asset.size.y, 0), 'ground', { cell: [x, y] });
        }
      }
      const natural = NATURAL.has(r.material);
      for (const c of cells) {
        if (assigned[c]) continue;
        assigned[c] = 1;
        const x = c % this.W;
        const y = (c / this.W) | 0;
        const rot = natural ? this.rng.int(0, 3) * 6 : 0;
        this.emit(placeInCell(r.base, x, this.tz(y), this.top - r.base.size.y, rot), 'ground', { cell: [x, y] });
      }
    }
  }

  // Place one storey of wall-like pieces along runs of edges.
  // edges: [{ x, y, side, type }] in plan coordinates.
  emitWallEdges(edges, wallKit, baseY, layer, { door = null, gate = null, crenel = null, skipChance = 0 } = {}) {
    const runs = groupRuns(edges);
    for (const run of runs) {
      let i = 0;
      while (i < run.length) {
        const ed = run[i];
        if (skipChance && this.rng.chance(skipChance)) {
          i++;
          continue;
        }
        if (ed.type === 'door' || ed.type === 'gate') {
          const piece = ed.type === 'gate' ? gate || door : door;
          if (piece) {
            const len = Math.max(1, Math.round(Math.max(piece.size.x, piece.size.z)));
            if (len === 1) this.placeEdgePiece(piece, [ed], baseY, layer, 'door');
            else if (len === 2 && i + 1 < run.length && run[i + 1].type === ed.type) {
              this.placeEdgePiece(piece, [ed, run[i + 1]], baseY, layer, 'door');
              i += 2;
              continue;
            }
          }
          i++;
          continue;
        }
        if (ed.type === 'open') {
          i++;
          continue;
        }
        if (ed.type === 'window' && wallKit.window) {
          this.placeEdgePiece(wallKit.window, [ed], baseY, layer, 'window');
          i++;
          continue;
        }
        const next = run[i + 1];
        if (wallKit.plain2 && next && (next.type === 'wall' || (next.type === 'window' && !wallKit.window))) {
          this.placeEdgePiece(wallKit.plain2, [ed, next], baseY, layer, 'wall');
          i += 2;
          continue;
        }
        this.placeEdgePiece(wallKit.plain1, [ed], baseY, layer, 'wall');
        i++;
      }
      if (crenel) {
        for (const ed of run) if (ed.type !== 'gate') this.placeEdgePiece(crenel, [ed], baseY + wallKit.height, layer, 'crenel');
      }
    }
  }

  // run: 1 or more consecutive edges on the same side/line, sorted along it.
  placeEdgePiece(asset, run, y, layer, what) {
    const first = run[0];
    const span = run.length;
    const edge = SIDE_EDGE[first.side];
    let tx;
    let tzz;
    if (first.side === 'n' || first.side === 's') {
      tx = first.x;
      tzz = this.tz(first.y);
    } else {
      tx = first.x;
      tzz = this.H - first.y - span;
    }
    const p = this.emit(placeOnEdge(asset, tx, tzz, edge, y, { span }), layer, { cell: [first.x, first.y], what });
    if (layer !== 'roof') this.props.add(placedBounds(asset, p));
    if (what === 'door') this.preview.doors.push({ x: first.x, y: first.y, side: first.side, span });
    if (what === 'window') this.preview.windows.push({ x: first.x, y: first.y, side: first.side });
    return p;
  }

  emitStructures() {
    const flat = this.kit.flatRoof();
    for (const S of this.structures) {
      const def = S.def;
      const door = this.kit.door(def.wall);
      const floors = this.upperFloorsFor(S);
      if (S.wall) {
        const all = [];
        for (const c of S.cells) for (const side of SIDES4) {
          const e = this.edges.get(`${c}:${side}`);
          if (e) all.push({ x: c % this.W, y: (c / this.W) | 0, side, type: e.type, partition: e.partition });
        }
        if (!door && all.some((e) => e.type === 'door')) this.missing.add('door');
        this.emitWallEdges(all, S.wall, this.top, 'structure', { door });
        const topFloor = !floors.length && (!def.upper || def.upper.top);
        const crenel = topFloor && def.roof === 'flat' && ['tower', 'keep', 'castle'].includes(def.kind) ? this.kit.crenellation() : null;
        if (crenel) {
          const parapet = all.filter((e) => !e.partition).map((e) => ({ ...e, type: 'wall' }));
          this.emitWallEdges(parapet, { plain1: crenel, height: 0 }, this.top + S.height + (flat ? flat.size.y : 0), 'roof');
        }
      }
      if (def.upper && def.upper.stairs) {
        const p = this.emitStairs(def.upper.stairs, this.top);
        if (p) this.props.add(placedBounds(this.kit.stairs(), p));
      }
      const floorR = this.kit.surface(def.floor);
      if (!floors.length) {
        this.emitRoof(S, flat, floorR, def.upper && def.upper.roofCells);
        continue;
      }
      this.emitUpperFloors(S, floors, flat, floorR);
    }
  }

  // Floors above the ground: the plan's upperFloors, or the ground floor
  // repeated (same footprint, its walled rooms, upstairs kinds) for a plan or
  // traced structure that only gives a storey count.
  upperFloorsFor(S) {
    const def = S.def;
    if (def.upper) return [];
    if (def.upperFloors && def.upperFloors.length) {
      return def.upperFloors.map((f, i) => ({ label: f.label || `floor ${i + 2}`, parts: f.parts, cells: null, rooms: f.rooms, doors: f.doors, mainKind: UPPER_MAIN[def.kind] }));
    }
    const out = [];
    const inside = new Set(S.cells);
    const interiorDoors = def.doors.filter((d) => this.inMap(d.x, d.y) && inside.has(this.neighbor(this.idx(d.x, d.y), d.side)));
    for (let k = 1; k < def.storeys; k++) {
      out.push({
        label: `floor ${k + 1}`, parts: [], cells: S.cells.slice(),
        rooms: def.rooms.filter((r) => !r.open).map((r) => {
          const kind = UPPER_ROOM[r.kind] || r.kind;
          return { ...r, kind: kind === 'bedroom' && r.w * r.h > 30 ? 'dormitory' : kind };
        }),
        doors: interiorDoors, mainKind: def.rooms.length ? null : UPPER_MAIN[def.kind],
      });
    }
    return out;
  }

  floorCells(f) {
    const set = new Set(f.cells || []);
    for (const r of f.parts) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (this.inMap(x, y)) set.add(this.idx(x, y));
    return set;
  }

  // Room of every cell of a floor, as rasterizeStructures will assign it
  // (smaller rooms first; -1 for the leftover main room).
  floorRooms(f, cells) {
    const map = new Map();
    const byArea = f.rooms.map((r, i) => ({ r, i })).sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h || a.i - b.i);
    for (const { r, i } of byArea) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const c = this.inMap(x, y) ? this.idx(x, y) : -1;
        if (cells.has(c) && !map.has(c)) map.set(c, i);
      }
    }
    for (const c of cells) if (!map.has(c)) map.set(c, -1);
    return map;
  }

  emitUpperFloors(S, floors, flat, floorR) {
    const def = S.def;
    const Hs = S.height;
    const levels = [{ cells: new Set(S.cells), rooms: new Map(S.cells.map((c) => [c, this.room[c]])), doorCells: this.doorCellsOf(S) }];
    for (const f of floors) {
      const cells = this.floorCells(f);
      const doorCells = new Set();
      for (const d of f.doors) {
        if (!this.inMap(d.x, d.y)) continue;
        const c = this.idx(d.x, d.y);
        doorCells.add(c);
        const n = this.neighbor(c, d.side);
        if (n >= 0) doorCells.add(n);
      }
      levels.push({ cells, rooms: this.floorRooms(f, cells), doorCells });
    }
    const stairs = this.planStairs(S, levels);
    if (stairs[0]) {
      const p = this.emitStairs(stairs[0], this.top);
      if (p) this.props.add(placedBounds(this.kit.stairs(), p));
    }
    // the ground floor's roof is the floor above, except where it sticks out
    const exposed = [...levels[0].cells].filter((c) => !levels[1].cells.has(c));
    if (def.roof !== 'none' && S.wall) this.emitFlatRoof(exposed, this.top + Hs, flat, floorR);

    floors.forEach((f, i) => {
      const level = i + 1;
      const top = level === floors.length;
      const below = levels[level - 1].cells;
      const cells = levels[level].cells;
      const arrive = stairs[level - 1] ? stairs[level - 1].cells : new Set();
      const sub = {
        id: `${def.id}_f${level + 1}`, label: `${def.label} (${f.label})`, kind: def.kind,
        parts: f.parts, cells: f.cells, rooms: f.rooms, doors: f.doors, mainKind: f.mainKind,
        wall: def.wall, floor: def.floor, storeys: 1, roof: top ? def.roof : def.roof === 'none' ? 'none' : 'flat',
        windows: def.windows, interiorWalls: def.interiorWalls, furnish: def.furnish,
        upper: {
          top, entry: arrive, holes: arrive, arrive: stairs[level - 1] || null,
          terrace: new Set([...below].filter((c) => !cells.has(c))),
          stairs: stairs[level] || null,
          roofCells: top ? null : [...cells].filter((c) => !levels[level + 1].cells.has(c)),
        },
      };
      this.compileUpperFloor(sub, this.top + level * Hs, level + 1, def.label);
    });
  }

  doorCellsOf(S) {
    const out = new Set();
    for (const c of S.cells) for (const side of SIDES4) {
      const e = this.edges.get(`${c}:${side}`);
      if (e && e.type === 'door') {
        out.add(c);
        const n = this.neighbor(c, side);
        if (n >= 0) out.add(n);
      }
    }
    return out;
  }

  // One stair flight per pair of floors, in cells both floors cover, within one
  // room on each, clear of doors and of the flight arriving from below. Stacks
  // flights in one stairwell when it fits; otherwise prefers corners.
  planStairs(S, levels) {
    const stairs = this.kit.stairs();
    const out = [];
    if (!stairs) {
      this.missing.add('stairs');
      return out;
    }
    const fx = Math.max(1, Math.round(stairs.size.x));
    const fz = Math.max(1, Math.round(stairs.size.z));
    const fits = (x, y, rot, lower, upper, avoid) => {
      const w = rot === 0 ? fx : fz;
      const h = rot === 0 ? fz : fx;
      const cells = new Set();
      let roomLo = null;
      let roomUp = null;
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        if (!this.inMap(x + dx, y + dy)) return null;
        const k = this.idx(x + dx, y + dy);
        if (!lower.cells.has(k) || !upper.cells.has(k) || lower.doorCells.has(k) || upper.doorCells.has(k) || avoid.has(k)) return null;
        const a = lower.rooms.get(k);
        const b = upper.rooms.get(k);
        if (roomLo === null) {
          roomLo = a;
          roomUp = b;
        } else if (a !== roomLo || b !== roomUp) return null;
        cells.add(k);
      }
      return { x, y, rot, w, h, cells };
    };
    for (let t = 0; t + 1 < levels.length; t++) {
      const lower = levels[t];
      const upper = levels[t + 1];
      const prev = out[t - 1];
      let found = prev ? fits(prev.x, prev.y, prev.rot, lower, upper, new Set()) : null;
      if (!found) {
        const avoid = prev ? prev.cells : new Set();
        const ranked = [...lower.cells]
          .filter((c) => upper.cells.has(c))
          .map((c) => [SIDES4.filter((sd) => !lower.cells.has(this.neighbor(c, sd)) || !upper.cells.has(this.neighbor(c, sd))).length, c])
          .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
        for (const [, c] of ranked) {
          for (const rot of [0, 6]) {
            found = fits(c % this.W, (c / this.W) | 0, rot, lower, upper, avoid);
            if (found) break;
          }
          if (found) break;
        }
      }
      if (!found) this.warn(`no room for stairs from floor ${t + 1} to floor ${t + 2} of ${S.def.label} (the floors need to overlap)`);
      out.push(found);
    }
    return out;
  }

  emitStairs(st, baseY) {
    const stairs = this.kit.stairs();
    if (!stairs || !st) return null;
    this.preview.stairs.push({ x: st.x, y: st.y, w: st.w, h: st.h });
    return this.emit(placeInCell(stairs, st.x, this.H - st.h - st.y, baseY, st.rot), 'structure', { cell: [st.x, st.y], what: 'stairs' });
  }

  emitFlatRoof(cells, baseY, flat, floorR) {
    const piece = flat || (floorR && floorR.base);
    if (!piece) return;
    for (const c of cells) {
      const x = c % this.W;
      const y = (c / this.W) | 0;
      this.emit(placeInCell(piece, x, this.tz(y), baseY, 0), 'roof', { cell: [x, y] });
    }
  }

  // Build one upper floor with its own builder (rooms, walls, doors, windows,
  // reachability, furniture), then lift it to its height.
  compileUpperFloor(sub, baseY, floorNo, structureLabel) {
    const plan = { ...this.plan, ground: 'none', areas: [], paths: [], barriers: [], props: [], scatter: [], raster: null, structures: [sub] };
    const b = new Builder(plan, this.kit, { ...this.opts, seed: `${this.opts.seed}:${sub.id}` }, []);
    b.barrierEdges = [];
    b.rasterizeStructures();
    for (const c of sub.upper.holes) b.surf[c] = null;
    b.computeEdges();
    b.computeTop();
    b.emitSurfaces();
    b.emitStructures();
    for (const c of sub.upper.holes) {
      const x = c % b.W;
      const z = b.tz((c / b.W) | 0);
      b.props.add([x + 0.02, z + 0.02, x + 0.98, z + 0.98]);
    }
    if (sub.upper.arrive) {
      const a = sub.upper.arrive;
      b.preview.stairs.push({ x: a.x, y: a.y, w: a.w, h: a.h, arrive: true });
    }
    b.markDoorways();
    b.emitFurniture();
    const dy = baseY - b.top;
    for (const p of b.placements) {
      p.y = round2(p.y + dy);
      p.meta.floor = floorNo;
      this.placements.push(p);
    }
    for (const w of b.warnings) this.warn(w);
    for (const m of b.missing) this.missing.add(m);
    const r = b.gridSnapshot();
    this.floors.push({ structure: structureLabel, label: sub.label, level: floorNo, grid: r });
  }

  emitRoof(S, flat, floorR, cells = null) {
    const def = S.def;
    if (def.roof === 'none' || !S.wall) return;
    const baseY = this.top + S.height;
    if (cells) {
      this.emitFlatRoof(cells, baseY, flat, floorR);
      return;
    }
    const kit = def.roof === 'pitched' ? this.kit.roofKit() : null;
    if (def.roof === 'pitched' && !kit) this.missing.add('pitched roof kit');
    if (kit) {
      this.emitPitchedRoof(S, kit, baseY);
      return;
    }
    this.emitFlatRoof(S.cells, baseY, flat, floorR);
  }

  // Hip roof by rings: each course steps one cell in and one piece up.
  emitPitchedRoof(S, kit, baseY) {
    const cells = new Set(S.cells);
    const rings = new Map();
    let frontier = S.cells.filter((c) => SIDES4.some((s) => {
      const n = this.neighbor(c, s);
      return n < 0 || !cells.has(n);
    }));
    let depth = 0;
    while (frontier.length) {
      const next = [];
      for (const c of frontier) {
        if (rings.has(c)) continue;
        rings.set(c, depth);
        for (const s of SIDES4) {
          const n = this.neighbor(c, s);
          if (n >= 0 && cells.has(n) && !rings.has(n)) next.push(n);
        }
      }
      frontier = next;
      depth++;
    }
    const ringOf = (c) => (c >= 0 && cells.has(c) ? rings.get(c) : -1);
    const diag = { 'n,e': [1, -1], 'e,n': [1, -1], 'n,w': [-1, -1], 'w,n': [-1, -1], 's,e': [1, 1], 'e,s': [1, 1], 's,w': [-1, 1], 'w,s': [-1, 1] };
    const cornerKey = (a, b) => {
      const set = new Set([a, b]);
      const xs = set.has('e') ? 'xMax' : 'xMin';
      const zs = set.has('n') ? 'zMax' : 'zMin';
      return `${xs},${zs}`;
    };
    const opposite = { 'xMin,zMin': 'xMax,zMax', 'xMax,zMax': 'xMin,zMin', 'xMin,zMax': 'xMax,zMin', 'xMax,zMin': 'xMin,zMax' };
    for (const c of S.cells) {
      const here = rings.get(c);
      const x = c % this.W;
      const y = (c / this.W) | 0;
      const falls = SIDES4.filter((s) => ringOf(this.neighbor(c, s)) < here);
      let piece = kit.cap;
      let rot = 0;
      if (falls.length === 1 || (falls.length === 2 && SIDE_DELTA[falls[0]][0] + SIDE_DELTA[falls[1]][0] === 0 && SIDE_DELTA[falls[0]][1] + SIDE_DELTA[falls[1]][1] === 0)) {
        piece = kit.side;
        rot = ROOF_EDGE_ROT[SIDE_EDGE[falls[0]]];
      } else if (falls.length === 2) {
        const [dx, dy] = diag[`${falls[0]},${falls[1]}`];
        const d = this.inMap(x + dx, y + dy) ? this.idx(x + dx, y + dy) : -1;
        const reflex = ringOf(d) >= here;
        const key = cornerKey(falls[0], falls[1]);
        if (reflex) {
          piece = kit.inner;
          rot = ROOF_CORNER_ROT[opposite[key]];
        } else {
          piece = kit.corner;
          rot = ROOF_CORNER_ROT[key];
        }
      }
      this.emit(placeInCell(piece, x, this.tz(y), baseY + here * kit.rise, rot), 'roof', { cell: [x, y] });
    }
  }

  emitBarriers() {
    const door = this.kit.door();
    for (const { bar, edges } of this.barrierEdges) {
      const owned = [];
      for (const ed of edges) {
        let cell;
        let side;
        const below = [ed.x, ed.y];
        const above = [ed.x, ed.y - 1];
        const right = [ed.x, ed.y];
        const left = [ed.x - 1, ed.y];
        const pick = (a, sa, bb, sb) => {
          let first = [a, sa];
          let second = [bb, sb];
          if (bar.closed) {
            const inside = (p) => insidePoly(p[0] + 0.5, p[1] + 0.5, bar.points);
            if (!inside(a) && inside(bb)) [first, second] = [second, first];
          }
          for (const [p, s] of [first, second]) if (this.inMap(p[0], p[1])) return [p, s];
          return null;
        };
        const got = ed.dir === 'h' ? pick(below, 'n', above, 's') : pick(right, 'w', left, 'e');
        if (!got) continue;
        [cell, side] = got;
        const c = this.idx(cell[0], cell[1]);
        if (this.struct[c] >= 0 || this.prefabAt[c] >= 0) continue;
        owned.push({ x: cell[0], y: cell[1], side, type: 'wall', mid: ed.dir === 'h' ? [ed.x + 0.5, ed.y] : [ed.x, ed.y + 0.5] });
      }
      for (const g of bar.gates) {
        let best = -1;
        let bd = Infinity;
        owned.forEach((o, i) => {
          const d = Math.hypot(o.mid[0] - g[0], o.mid[1] - g[1]);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        if (best < 0 || bd > 2) continue;
        owned[best].type = 'gate';
        // gates are two tiles wide when the line allows
        const o = owned[best];
        const mate = owned.find((q) => q !== o && q.side === o.side && q.type === 'wall' &&
          ((o.side === 'n' || o.side === 's') ? q.y === o.y && Math.abs(q.x - o.x) === 1 : q.x === o.x && Math.abs(q.y - o.y) === 1));
        if (mate && bar.kind !== 'fence' && bar.kind !== 'hedge') mate.type = 'gate';
      }
      this.preview.barriers.push({ kind: bar.kind, points: bar.points, closed: bar.closed, edges: owned.map(({ x, y, side, type }) => ({ x, y, side, type })) });
      if (bar.kind === 'fence' || bar.kind === 'hedge') {
        this.emitLinearProps(bar, owned);
        continue;
      }
      const material = bar.kind === 'palisade' ? 'wood' : bar.kind === 'ruined_wall' ? 'ruined' : bar.material;
      const wk = this.kit.wall(material);
      if (!wk) {
        this.warn(`no wall pieces for barrier "${bar.label}"`);
        continue;
      }
      const courses = bar.kind === 'fortification' ? 2 : 1;
      const gate = this.kit.gate();
      for (let k = 0; k < courses; k++) {
        const crenel = bar.kind === 'fortification' && k === courses - 1 ? this.kit.crenellation() : null;
        // The gate fills the bottom course; masonry continues over it.
        this.emitWallEdges(owned.map((o) => ({ ...o, type: o.type === 'gate' ? (k === 0 ? 'gate' : 'wall') : o.type })), wk, this.top + k * wk.height, 'barrier', {
          door, gate, crenel, skipChance: bar.kind === 'ruined_wall' ? 0.25 : 0,
        });
      }
    }
  }

  emitLinearProps(bar, owned) {
    const role = bar.kind === 'hedge' ? 'bush' : 'fence';
    const cands = this.kit.props(role);
    if (!cands.length) {
      this.missing.add(`prop:${role}`);
      return;
    }
    const asset = cands[0];
    const len = Math.max(1, Math.round(Math.max(asset.size.x, asset.size.z)));
    for (const run of groupRuns(owned)) {
      for (let i = 0; i < run.length; i += len) {
        const seg = run.slice(i, i + len).filter((e) => e.type !== 'gate');
        if (seg.length === 0 || (len > 1 && seg.length < len)) continue;
        this.placeEdgePiece(asset, seg, this.top, 'barrier', 'fence');
        this.preview.props.push({ x: seg[0].x + 0.5, y: seg[0].y + 0.5, role, name: asset.name });
      }
    }
  }

  // ---- 4. props --------------------------------------------------------------

  // Try to put a prop's collider centre at world (cx, cz); returns the
  // placement or null. Never overlaps another prop, a wall, or a doorway.
  tryProp(asset, cx, cz, y, rot, { layer = 'prop', respectDoors = true, within = null, meta } = {}) {
    const p = placeCentered(asset, cx, cz, y, rot);
    const box = placedBounds(asset, p);
    if (box[0] < 0 || box[1] < 0 || box[2] > this.W || box[3] > this.H) return null;
    if (!this.props.fits(box)) return null;
    if (respectDoors && !this.doorClear.fits(box)) return null;
    if (within && !within(box)) return null;
    this.props.add(box);
    return this.emit(p, layer, meta);
  }

  markDoorways() {
    for (const [key, e] of this.edges) {
      if (e.type !== 'door') continue;
      const [c, side] = key.split(':');
      for (const k of [Number(c), this.neighbor(Number(c), side)]) {
        if (k < 0) continue;
        const x = k % this.W;
        const tzz = this.tz((k / this.W) | 0);
        this.doorClear.add([x + 0.05, tzz + 0.05, x + 0.95, tzz + 0.95]);
      }
    }
  }

  surfaceTopAt() {
    return this.top;
  }

  emitPlanProps() {
    this.markDoorways();
    for (const pr of this.plan.props) {
      const cands = this.kit.props(pr.role, pr.asset);
      if (!cands.length) {
        this.missing.add(`prop:${pr.role}`);
        continue;
      }
      const asset = cands[0];
      const rot = Math.round(pr.rotation / 15) % 24;
      const cx = pr.x;
      const cz = this.H - pr.y;
      let placed = null;
      const y = this.surfaceTopAt();
      for (const [dx, dz] of spiralOffsets(1.5, 0.25)) {
        placed = this.tryProp(asset, cx + dx, cz + dz, y, rot, { meta: { role: pr.role } });
        if (placed) break;
      }
      if (placed) this.preview.props.push({ x: pr.x, y: pr.y, role: pr.role, name: asset.name });
      else this.warn(`some props had no free spot and were skipped (e.g. ${pr.role} at ${pr.x.toFixed(1)},${pr.y.toFixed(1)})`);
    }
  }

  emitFurniture() {
    for (const room of this.rooms) {
      const S = this.structures[room.s];
      if (S.def.furnish === 'none' || room.cells.length === 0) continue;
      this.furnishRoom(S, room);
    }
  }

  furnishRoom(S, room) {
    const rules = furnitureRules(room.kind);
    const area = room.cells.length;
    const roomSet = new Set(room.cells);
    const within = (box) => {
      for (const [bx, bz] of [[box[0] + 0.01, box[1] + 0.01], [box[2] - 0.01, box[1] + 0.01], [box[0] + 0.01, box[3] - 0.01], [box[2] - 0.01, box[3] - 0.01]]) {
        const x = Math.floor(bx);
        const y = this.H - 1 - Math.floor(bz);
        if (!this.inMap(x, y) || !roomSet.has(this.idx(x, y))) return false;
      }
      return true;
    };
    const wallSlots = [];
    const centerCells = [];
    for (const c of room.cells) {
      let walls = 0;
      for (const side of SIDES4) {
        const own = this.edges.get(`${c}:${side}`);
        const n = this.neighbor(c, side);
        const back = n >= 0 ? this.edges.get(`${n}:${{ n: 's', s: 'n', e: 'w', w: 'e' }[side]}`) : null;
        const e = own || (back && back.partition ? back : null);
        if (!e) continue;
        walls++;
        if (e.type === 'wall' || e.type === 'window') wallSlots.push({ c, side, inset: own ? S.wall.thickness : 0 });
      }
      if (walls === 0) centerCells.push(c);
    }
    const shuffledSlots = this.rng.shuffle(wallSlots);
    const xs = room.cells.map((c) => c % this.W);
    const ys = room.cells.map((c) => (c / this.W) | 0);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const my = (Math.min(...ys) + Math.max(...ys)) / 2;
    const centers = centerCells.length
      ? centerCells.slice().sort((a, b) => Math.hypot((a % this.W) - mx, ((a / this.W) | 0) - my) - Math.hypot((b % this.W) - mx, ((b / this.W) | 0) - my) || a - b)
      : this.rng.shuffle(room.cells);
    let lastCenter = null;
    const y = this.surfaceTopAt();
    for (const rule of rules) {
      const n = ruleCount(rule, area, S.def.furnish);
      if (n === 0) continue;
      const cands = this.kit.props(rule.role);
      if (!cands.length) {
        this.missing.add(`prop:${rule.role}`);
        continue;
      }
      for (let attempt = 0; attempt < n; attempt++) {
        const asset = cands[this.rng.int(0, Math.min(cands.length, 3) - 1)];
        let p = null;
        if (rule.at === 'wall') {
          while (!p && shuffledSlots.length) {
            const slot = shuffledSlots.shift();
            p = this.propAgainstWall(asset, slot, y, within, rule.role);
          }
        } else if (rule.at === 'center') {
          for (let i = 0; i < centers.length && !p; i++) {
            const c = centers[i];
            const rot = this.rng.int(0, 1) * 6;
            p = this.tryProp(asset, (c % this.W) + 0.5, this.tz((c / this.W) | 0) + 0.5, y, rot, { within, meta: { role: rule.role } });
            if (p) {
              centers.splice(i, 1);
              lastCenter = { asset, p };
            }
          }
        } else if (rule.at === 'around' && lastCenter) {
          const box = placedBounds(lastCenter.asset, lastCenter.p);
          const cx = (box[0] + box[2]) / 2;
          const cz = (box[1] + box[3]) / 2;
          const order = this.rng.shuffle([['xMin', -1, 0], ['xMax', 1, 0], ['zMin', 0, -1], ['zMax', 0, 1]]);
          for (const [edge, dx, dz] of order) {
            if (p) break;
            const rot = (EDGE_ROT[edge] + this.opts.furnitureFacing + 12) % 24;
            const [fx, fz] = rotatedFootprint(asset, rot);
            const ox = dx ? dx * ((box[2] - box[0]) / 2 + fx / 2 + 0.05) : 0;
            const oz = dz ? dz * ((box[3] - box[1]) / 2 + fz / 2 + 0.05) : 0;
            p = this.tryProp(asset, cx + ox, cz + oz, y, rot, { within, meta: { role: rule.role } });
          }
        }
        if (!p) break;
        const bx = placedBounds(asset, p);
        this.preview.props.push({ x: (bx[0] + bx[2]) / 2, y: this.H - (bx[1] + bx[3]) / 2, role: rule.role, name: asset.name });
      }
    }
  }

  propAgainstWall(asset, slot, y, within, role) {
    const { c, side, inset } = slot;
    const edge = SIDE_EDGE[side];
    const rot = edgeRotation(asset, edge, this.opts.furnitureFacing);
    const [fx, fz] = rotatedFootprint(asset, rot);
    const tx = c % this.W;
    const tzz = this.tz((c / this.W) | 0);
    const gap = 0.03;
    let cx = tx + 0.5;
    let cz = tzz + 0.5;
    if (edge === 'zMin') cz = tzz + inset + fz / 2 + gap;
    else if (edge === 'zMax') cz = tzz + 1 - inset - fz / 2 - gap;
    else if (edge === 'xMin') cx = tx + inset + fx / 2 + gap;
    else cx = tx + 1 - inset - fx / 2 - gap;
    return this.tryProp(asset, cx, cz, y, rot, { within, meta: { role } });
  }

  emitScatter() {
    for (const sc of this.plan.scatter) {
      const cands = this.kit.props(sc.role, sc.asset);
      if (!cands.length) {
        this.missing.add(`prop:${sc.role}`);
        continue;
      }
      const cells = this.rng.shuffle(polygonCells(sc.points, this.W, this.H));
      const natural = NATURE_ROLES.has(sc.role);
      for (const [x, y] of cells) {
        if (!this.rng.chance(sc.density)) continue;
        const c = this.idx(x, y);
        if (this.struct[c] >= 0 || this.prefabAt[c] >= 0) continue;
        const m = this.surf[c];
        if (!m) continue;
        if (UNWALKABLE.has(m) !== FLOATING_ROLES.has(sc.role)) continue;
        const asset = cands[this.rng.int(0, Math.min(cands.length, 4) - 1)];
        const jitter = Math.max(0, 1 - Math.max(asset.size.x, asset.size.z)) / 2;
        const cx = x + 0.5 + (this.rng.next() * 2 - 1) * jitter;
        const cz = this.tz(y) + 0.5 + (this.rng.next() * 2 - 1) * jitter;
        const rot = natural ? this.rng.int(0, 23) : this.rng.int(0, 3) * 6;
        const p = this.tryProp(asset, cx, cz, this.surfaceTopAt(), rot, { meta: { role: sc.role } });
        if (p) this.preview.props.push({ x: cx, y: this.H - cz, role: sc.role, name: asset.name });
      }
    }
  }

  // ---- result ----------------------------------------------------------------

  result() {
    for (const m of this.missing) this.warn(`no asset found for ${m}; skipped (override it in the kit to fix)`);
    const placements = normalizePlacements(this.placements);
    const byLayer = {};
    let tiles = 0;
    let props = 0;
    const distinct = new Set();
    for (const p of placements) {
      byLayer[p.meta.layer] = (byLayer[p.meta.layer] || 0) + 1;
      distinct.add(p.assetId);
      const a = this.kit.catalog.get(p.assetId);
      if (a && a.kind === 'prop') props++;
      else tiles++;
    }
    return {
      plan: this.plan,
      placements,
      warnings: this.warnings,
      kitReport: this.kit.report(),
      stats: { total: placements.length, tiles, props, distinctAssets: distinct.size, byLayer, top: this.top },
      grid: this.gridSnapshot(),
      floors: this.floors,
      credits: [...new Map(this.placedPrefabs.map(({ pf, ref }) => [ref, { ref, name: pf.name || ref, creator: pf.creator || '', url: pf.url || '' }])).values()],
    };
  }

  gridSnapshot() {
    return {
      width: this.W,
      height: this.H,
      surf: this.surf,
      struct: Array.from(this.struct),
      room: Array.from(this.room),
      structures: this.structures.map((S) => ({ id: S.def.id, label: S.def.label, kind: S.def.kind, storeys: S.def.storeys, roof: S.def.roof, cells: S.cells, synthetic: !!S.def.synthetic })),
      rooms: this.rooms.map((r) => ({ id: r.id, label: r.label, kind: r.kind, s: r.s, cells: r.cells.length, ...(r.open ? { open: true } : {}) })),
      edges: [...this.edges].map(([k, e]) => {
        const [c, side] = k.split(':');
        return { x: Number(c) % this.W, y: (Number(c) / this.W) | 0, side, type: e.type, partition: e.partition };
      }),
      ...this.preview,
    };
  }
}

// The preview colour family of a community slab's floor tile, by name.
function surfaceLike(name) {
  const n = name.toLowerCase();
  for (const [re, m] of [[/water/, 'water'], [/grass|meadow/, 'grass'], [/dirt|earth|mud|soil/, 'dirt'], [/sand|desert/, 'sand'], [/snow/, 'snow'], [/cobble/, 'cobblestone'], [/carpet|rug/, 'carpet'], [/marble/, 'marble'], [/wood|plank|tavern|rural|deck/, 'wood_floor'], [/concrete|asphalt|road|street/, 'concrete'], [/metal|hull|steel/, 'metal_floor'], [/stone|castle|flag|brick|ruin/, 'stone_floor']]) if (re.test(n)) return m;
  return 'tile';
}

function insidePoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Group edges into runs: same side, same line, consecutive along it, sorted.
export function groupRuns(edges) {
  const lines = new Map();
  for (const e of edges) {
    const horiz = e.side === 'n' || e.side === 's';
    const key = `${e.side}:${horiz ? e.y : e.x}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(e);
  }
  const runs = [];
  for (const [key, list] of lines) {
    const horiz = key[0] === 'n' || key[0] === 's';
    list.sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
    let run = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const prev = run[run.length - 1];
      const along = horiz ? list[i].x - prev.x : list[i].y - prev.y;
      if (along === 1) run.push(list[i]);
      else {
        runs.push(run);
        run = [list[i]];
      }
    }
    runs.push(run);
  }
  return runs;
}

function spiralOffsets(maxR, step) {
  const out = [[0, 0]];
  for (let r = step; r <= maxR + 1e-9; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push([round2(r * Math.cos(a)), round2(r * Math.sin(a))]);
    }
  }
  return out;
}
