// The build plan: the contract between the AI and the deterministic builder.
//
// Claude never emits asset ids, coordinates in world space, or slab bytes. It
// emits this plan -- a map drawn in tiles, with semantic materials and roles --
// and the compiler turns it into placements. The schema below is sent to the
// Messages API as a structured-output format, so every response parses; the
// normalizer then clamps and repairs anything that is valid JSON but not a
// sensible map (out-of-bounds rects, a door on a wall that does not exist...).
//
// Coordinates: tiles (1 tile = 5 ft). (0,0) is the top-left corner of the map;
// x grows to the right (east), y grows downward (south), like an image.
// Rectangles are {x, y, w, h} in whole tiles. Points are [x, y] and may be
// fractional; the centre of tile (3, 4) is [3.5, 4.5].

import { SURFACES, WALL_MATERIALS, PROP_ROLES, STYLES, STYLE_PRESETS, KIT_PREFIX, isKitMaterial } from './kit.js';

export const PLAN_VERSION = 1;
export const MAX_MAP_TILES = 240;

export const STRUCTURE_KINDS = [
  'house', 'cottage', 'tavern', 'inn', 'shop', 'smithy', 'temple', 'chapel', 'tower', 'keep', 'castle', 'barracks',
  'barn', 'stable', 'warehouse', 'hall', 'library', 'guildhall', 'manor', 'mill', 'ruin', 'dungeon', 'cave', 'crypt',
  'mine', 'room', 'apartment', 'office', 'factory', 'garage', 'bunker', 'station', 'starship', 'other',
];
export const ROOM_KINDS = [
  'common', 'bar', 'kitchen', 'bedroom', 'dormitory', 'storage', 'cellar', 'shop', 'workshop', 'forge', 'shrine',
  'chapel', 'library', 'study', 'throne', 'hall', 'dining', 'armory', 'barracks', 'treasury', 'prison', 'crypt',
  'corridor', 'stable', 'lair', 'cavern', 'stage', 'office', 'lab', 'bridge', 'quarters', 'cargo_bay', 'engine_room',
  'medbay', 'empty', 'other',
];
export const ROOF_KINDS = ['pitched', 'flat', 'none'];
export const FURNISH_LEVELS = ['none', 'sparse', 'normal', 'dense'];
export const WINDOW_LEVELS = ['none', 'few', 'many'];
export const SIDES = ['n', 'e', 's', 'w'];
export const BARRIER_KINDS = ['fortification', 'palisade', 'fence', 'hedge', 'ruined_wall'];

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const num = (description) => ({ type: 'number', description });
const en = (values, description) => ({ type: 'string', enum: values, description });
const point = { type: 'array', items: { type: 'number' }, description: 'exactly two numbers: [x, y] in tiles' };
const obj = (properties, description) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
});
const rectProps = {
  x: int('left edge, tiles from the map left'),
  y: int('top edge, tiles from the map top'),
  w: int('width in tiles (>= 1)'),
  h: int('height in tiles (>= 1)'),
};

export const MAX_STOREYS = 6;

const roomItem = obj({
  label: str('room name'),
  kind: en(ROOM_KINDS, 'room purpose; drives furniture'),
  ...rectProps,
  open: { type: 'boolean', description: 'true: no walls around this room, even with interiorWalls true. Use for an area that is part of a bigger room: a bar counter area or a stage in a taproom, a dais in a hall, an alcove, a seating nook. Put it inside the bigger room.' },
});
const doorItem = obj({ x: int('tile x inside the structure'), y: int('tile y inside the structure'), side: en(SIDES, 'which side of that tile') });

// JSON Schema for structured outputs: closed objects, every property required,
// no numeric/length constraints (unsupported) -- ranges are enforced by the
// normalizer instead.
export const PLAN_SCHEMA = obj({
  title: str('short name of the place'),
  summary: str('2-4 sentences describing the place for the GM'),
  width: int(`map width in tiles, 4..${MAX_MAP_TILES} (1 tile = 5 ft)`),
  height: int(`map height in tiles, 4..${MAX_MAP_TILES}`),
  style: en(STYLES, 'overall look; picks default materials'),
  ground: en([...SURFACES, 'none'], "base surface under the whole map; 'none' for interiors and dungeons where only rooms have floors"),
  areas: {
    type: 'array',
    description: 'surface regions painted over the ground in order (later wins): lakes, fields, plazas, courtyards',
    items: obj({
      label: str('what this area is'),
      material: en([...SURFACES, 'none'], "'none' punches a hole (chasm, void)"),
      points: { type: 'array', items: point, description: 'polygon corners in tiles (>= 3); a rectangle is its 4 corners' },
    }),
  },
  paths: {
    type: 'array',
    description: 'roads, streets, trails and rivers as polylines',
    items: obj({
      label: str('what this path is'),
      material: en(SURFACES, 'surface, e.g. cobblestone for streets, dirt for trails, water for rivers'),
      width: int('width in tiles (1..12)'),
      points: { type: 'array', items: point, description: 'polyline through tile centres, e.g. [[0.5, 10.5], [30.5, 10.5]]' },
    }),
  },
  structures: {
    type: 'array',
    description: 'walled spaces: buildings, towers, dungeon complexes, caves. Walls are generated around the outline automatically.',
    items: obj({
      id: str('unique short id'),
      label: str('name shown to the GM'),
      kind: en(STRUCTURE_KINDS, 'what the structure is'),
      parts: {
        type: 'array',
        description: 'footprint as a union of rectangles (one for a simple building; several for L-shapes, or rooms + corridors of a dungeon)',
        items: obj(rectProps),
      },
      rooms: {
        type: 'array',
        description: 'named rooms of the ground floor (may be empty). With interiorWalls true, walls separate rooms, except around open rooms.',
        items: roomItem,
      },
      doors: {
        type: 'array',
        description: 'ground-floor doors, each on one side of a tile inside the footprint; exterior doors face outside, interior doors sit between two rooms',
        items: doorItem,
      },
      upperFloors: {
        type: 'array',
        description: 'floors above the ground floor, bottom to top (empty for a one-storey building). Each has its own footprint, rooms and doors, so floors can differ: smaller, shifted, turned 90 degrees, overhanging. Each must overlap the floor below by at least 2x2 tiles; stairs go in the overlap.',
        items: obj({
          label: str('what this floor is, e.g. "guest rooms"'),
          parts: { type: 'array', description: 'footprint of this floor as a union of rectangles, in the same map coordinates as the ground floor', items: obj(rectProps) },
          rooms: { type: 'array', description: 'rooms on this floor', items: roomItem },
          doors: { type: 'array', description: 'doors on this floor: between its rooms, or on an outer wall onto the flat roof of the floor below (a terrace)', items: doorItem },
        }),
      },
      wall: en([...WALL_MATERIALS, 'none'], "wall material; 'none' for open pavilions"),
      floor: en(SURFACES, 'floor surface inside'),
      storeys: int(`number of floors including the ground floor, 1..${MAX_STOREYS}; with upperFloors it is 1 + their count`),
      roof: en(ROOF_KINDS, "'pitched' for most buildings, 'flat' for towers, keeps and desert houses; 'none' only for dungeons, caves, ruins, open pavilions, or when asked for no roof"),
      windows: en(WINDOW_LEVELS, 'how many exterior windows'),
      interiorWalls: { type: 'boolean', description: 'true: walls between rooms (houses, inns). false: rooms are open to each other (dungeon rooms + corridors joined by doorways)' },
      furnish: en(FURNISH_LEVELS, 'how much furniture to place automatically'),
    }),
  },
  barriers: {
    type: 'array',
    description: 'free-standing linear walls: town walls, palisades, fences, hedges',
    items: obj({
      label: str('what this barrier is'),
      kind: en(BARRIER_KINDS, 'barrier type'),
      material: en(WALL_MATERIALS, 'material for fortification/palisade/ruined walls'),
      points: { type: 'array', items: point, description: 'polyline along tile corners (integer coordinates), e.g. [[2,2],[40,2],[40,30]]' },
      closed: { type: 'boolean', description: 'true to join the last point back to the first' },
      gates: { type: 'array', items: point, description: 'points on the barrier where a gate/opening goes' },
      towers: { type: 'boolean', description: 'true to add towers at the corners (fortifications only)' },
    }),
  },
  props: {
    type: 'array',
    description: 'individually placed objects',
    items: obj({
      role: en(PROP_ROLES, 'what kind of object'),
      asset: str("exact asset name from the provided asset list, or '' to let the builder choose"),
      x: num('x position of the object centre in tiles'),
      y: num('y position of the object centre in tiles'),
      rotation: int('degrees clockwise, multiple of 15'),
    }),
  },
  scatter: {
    type: 'array',
    description: 'natural clutter spread over a region: forests, rocks, crops, graveyards',
    items: obj({
      role: en(PROP_ROLES, 'what to scatter'),
      asset: str("exact asset name from the list, or ''"),
      points: { type: 'array', items: point, description: 'polygon corners in tiles (>= 3)' },
      density: num('0.0-1.0: fraction of tiles that get one'),
    }),
  },
  notes: str('anything the GM should know (secret doors, encounter ideas, how to place the build)'),
});

// ---------------------------------------------------------------------------

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};
// Exact value, or a near miss ("Stone Floor", "barrels", "wood-floor") of one;
// otherwise the default. Some providers get these fields as free text.
const pick = (v, allowed, dflt) => {
  if (allowed.includes(v)) return v;
  if (typeof v !== 'string') return dflt;
  const c = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const cand of [c, c.replace(/es$/, ''), c.replace(/s$/, '')]) if (allowed.includes(cand)) return cand;
  return dflt;
};
const text = (v, dflt = '') => (typeof v === 'string' ? v.slice(0, 2000) : dflt);
const arr = (v) => (Array.isArray(v) ? v : []);

const kitName = (v) => `${KIT_PREFIX}${v.slice(KIT_PREFIX.length).trim().slice(0, 60)}`;

// The plan schema with this library's building kits added to the wall and
// floor choices ("kit:Concrete Building"). kits: Catalog.buildingKits().
export function planSchema(kits = []) {
  if (!kits.length) return PLAN_SCHEMA;
  const schema = JSON.parse(JSON.stringify(PLAN_SCHEMA));
  const st = schema.properties.structures.items.properties;
  st.wall.enum = [...st.wall.enum, ...kits.map((k) => `${KIT_PREFIX}${k.group}`)];
  st.wall.description += '; or one of the library\'s own building kits, "kit:<group>"';
  const floors = kits.filter((k) => k.floors > 0).map((k) => `${KIT_PREFIX}${k.group}`);
  if (floors.length) {
    st.floor.enum = [...st.floor.enum, ...floors];
    st.floor.description += '; or a building kit\'s floor, "kit:<group>"';
  }
  return schema;
}

function cleanRooms(list, W, H) {
  return arr(list)
    .map((r) => {
      const rect = r && typeof r === 'object' ? cleanRect(r, W, H) : null;
      return rect ? { label: text(r.label), kind: pick(r.kind, ROOM_KINDS, 'other'), ...rect, open: r.open === true } : null;
    })
    .filter(Boolean);
}

function cleanDoors(list, W, H) {
  return arr(list)
    .map((d) => (d && typeof d === 'object' ? { x: clampInt(d.x, 0, W - 1, 0), y: clampInt(d.y, 0, H - 1, 0), side: pick(d.side, SIDES, 's') } : null))
    .filter(Boolean);
}

function cleanPoint(p, W, H, pad = 0) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const x = Number(p[0]);
  const y = Number(p[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(-pad, Math.min(W + pad, x)), Math.max(-pad, Math.min(H + pad, y))];
}

function cleanRect(r, W, H) {
  if (!r || typeof r !== 'object') return null;
  let x = Math.round(Number(r.x));
  let y = Math.round(Number(r.y));
  let w = Math.round(Number(r.w));
  let h = Math.round(Number(r.h));
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w < 0) [x, w] = [x + w, -w];
  if (h < 0) [y, h] = [y + h, -h];
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(W, x + w);
  const y1 = Math.min(H, y + h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Returns { plan, warnings }. Never throws on content, only on non-objects.
export function normalizePlan(input, { maxTiles = MAX_MAP_TILES } = {}) {
  if (!input || typeof input !== 'object') throw new Error('plan must be an object');
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const W = clampInt(input.width, 4, maxTiles, 32);
  const H = clampInt(input.height, 4, maxTiles, 32);
  if (W !== input.width || H !== input.height) warn(`map size adjusted to ${W}x${H}`);
  const style = pick(input.style, STYLES, 'medieval');
  const preset = STYLE_PRESETS[style];
  const plan = {
    version: PLAN_VERSION,
    title: text(input.title, 'Untitled build'),
    summary: text(input.summary),
    width: W,
    height: H,
    style,
    ground: pick(input.ground, [...SURFACES, 'none'], preset.ground),
    areas: [],
    paths: [],
    structures: [],
    barriers: [],
    props: [],
    scatter: [],
    notes: text(input.notes),
  };

  for (const a of arr(input.areas)) {
    const points = arr(a && a.points).map((p) => cleanPoint(p, W, H)).filter(Boolean);
    if (points.length < 3) {
      warn(`area "${a && a.label}" dropped: needs 3+ points`);
      continue;
    }
    plan.areas.push({ label: text(a.label), material: pick(a.material, [...SURFACES, 'none'], preset.ground === 'none' ? 'stone_floor' : preset.ground), points });
  }

  for (const p of arr(input.paths)) {
    const points = arr(p && p.points).map((q) => cleanPoint(q, W, H, 2)).filter(Boolean);
    if (points.length < 2) {
      warn(`path "${p && p.label}" dropped: needs 2+ points`);
      continue;
    }
    plan.paths.push({ label: text(p.label), material: pick(p.material, SURFACES, preset.path), width: clampInt(p.width, 1, 12, 2), points });
  }

  const ids = new Set();
  for (const s of arr(input.structures)) {
    if (!s || typeof s !== 'object') continue;
    const parts = arr(s.parts).map((r) => cleanRect(r, W, H)).filter(Boolean);
    if (parts.length === 0) {
      warn(`structure "${s.label || s.id}" dropped: no part inside the map`);
      continue;
    }
    let id = text(s.id).replace(/[^\w-]/g, '').slice(0, 40) || `s${plan.structures.length + 1}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    const kind = pick(s.kind, STRUCTURE_KINDS, 'other');
    const dungeonish = ['dungeon', 'cave', 'crypt', 'mine', 'room'].includes(kind);
    plan.structures.push({
      id,
      label: text(s.label, id),
      kind,
      parts,
      rooms: cleanRooms(s.rooms, W, H),
      doors: cleanDoors(s.doors, W, H),
      upperFloors: arr(s.upperFloors).slice(0, MAX_STOREYS - 1).map((f, i) => {
        const fparts = arr(f && f.parts).map((r) => cleanRect(r, W, H)).filter(Boolean);
        if (!fparts.length) {
          warn(`floor ${i + 2} of "${s.label || id}" dropped: no part inside the map`);
          return null;
        }
        return { label: text(f.label), parts: fparts, rooms: cleanRooms(f.rooms, W, H), doors: cleanDoors(f.doors, W, H) };
      }).filter(Boolean),
      wall: isKitMaterial(s.wall) ? kitName(s.wall) : pick(s.wall, [...WALL_MATERIALS, 'none'], preset.wall),
      floor: isKitMaterial(s.floor) ? kitName(s.floor) : pick(s.floor, SURFACES, preset.floor),
      storeys: clampInt(s.storeys, 1, MAX_STOREYS, 1),
      roof: pick(s.roof, ROOF_KINDS, dungeonish ? 'none' : preset.roof),
      windows: pick(s.windows, WINDOW_LEVELS, dungeonish ? 'none' : 'few'),
      interiorWalls: typeof s.interiorWalls === 'boolean' ? s.interiorWalls : !dungeonish,
      furnish: pick(s.furnish, FURNISH_LEVELS, 'normal'),
    });
  }

  for (const st of plan.structures) if (st.upperFloors.length) st.storeys = 1 + st.upperFloors.length;
  mergeNestedStructures(plan, warn);

  for (const b of arr(input.barriers)) {
    const points = arr(b && b.points).map((p) => cleanPoint(p, W, H)).filter(Boolean);
    if (points.length < 2) {
      warn(`barrier "${b && b.label}" dropped: needs 2+ points`);
      continue;
    }
    plan.barriers.push({
      label: text(b.label),
      kind: pick(b.kind, BARRIER_KINDS, 'fortification'),
      material: pick(b.material, WALL_MATERIALS, 'castle'),
      points,
      closed: !!b.closed,
      gates: arr(b.gates).map((p) => cleanPoint(p, W, H)).filter(Boolean),
      towers: !!b.towers,
    });
  }

  for (const p of arr(input.props).slice(0, 3000)) {
    if (!p || typeof p !== 'object') continue;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > W || y > H) continue;
    plan.props.push({ role: pick(p.role, PROP_ROLES, 'other'), asset: text(p.asset).slice(0, 120), x, y, rotation: (clampInt(p.rotation, -3600, 3600, 0) % 360 + 360) % 360 });
  }
  const droppedProps = arr(input.props).length - plan.props.length;
  if (droppedProps > 0) warn(`${droppedProps} props dropped (outside the map or malformed)`);

  for (const s of arr(input.scatter).slice(0, 200)) {
    const points = arr(s && s.points).map((p) => cleanPoint(p, W, H)).filter(Boolean);
    if (points.length < 3) continue;
    plan.scatter.push({ role: pick(s.role, PROP_ROLES, 'tree'), asset: text(s.asset).slice(0, 120), points, density: clampNum(s.density, 0, 1, 0.2) });
  }

  if (input.raster) plan.raster = cleanRaster(input.raster, W, H, warn);
  return { plan, warnings };
}

// Trace-mode raster: rows of characters plus a legend. Produced by the image
// tracer, not by the AI schema.
//   legend[char] = { material: surface|'none', structure: kind|null, wall: material|null,
//                    door: bool, prop: role|null }
function cleanRaster(r, W, H, warn) {
  const rows = arr(r.rows).slice(0, H).map((row) => String(row).slice(0, W).padEnd(W, ' '));
  while (rows.length < H) rows.push(' '.repeat(W));
  const legend = {};
  for (const [ch, v] of Object.entries(r.legend || {})) {
    if (ch.length !== 1 || !v) continue;
    legend[ch] = {
      material: pick(v.material, [...SURFACES, 'none'], 'none'),
      structure: v.structure ? pick(v.structure, STRUCTURE_KINDS, 'other') : null,
      wall: v.wall ? pick(v.wall, WALL_MATERIALS, 'stone') : null,
      door: !!v.door,
      prop: v.prop ? pick(v.prop, PROP_ROLES, 'other') : null,
      propDensity: clampNum(v.propDensity, 0, 1, 1),
      roof: v.roof ? pick(v.roof, ROOF_KINDS, 'none') : null,
      furnish: v.furnish ? pick(v.furnish, FURNISH_LEVELS, 'none') : null,
      storeys: v.storeys ? clampInt(v.storeys, 1, MAX_STOREYS, 1) : null,
      label: text(v.label),
    };
  }
  if (Object.keys(legend).length === 0) warn('raster has no legend; ignored');
  return { rows, legend, storeys: clampInt(r.storeys, 1, MAX_STOREYS, 1), roof: pick(r.roof, ROOF_KINDS, 'none'), furnish: pick(r.furnish, FURNISH_LEVELS, 'none') };
}

export function planStats(plan) {
  return {
    size: `${plan.width}x${plan.height}`,
    areas: plan.areas.length,
    paths: plan.paths.length,
    structures: plan.structures.length,
    rooms: plan.structures.reduce((n, s) => n + s.rooms.length + (s.upperFloors || []).reduce((k, f) => k + f.rooms.length, 0), 0),
    floors: plan.structures.reduce((n, s) => n + (s.storeys || 1), 0),
    barriers: plan.barriers.length,
    props: plan.props.length,
    scatter: plan.scatter.length,
  };
}

// A building drawn inside another roofed building (a stage, a bar or a room
// drawn as its own structure) would cut a hole in it and get its own outside
// walls and roof. Make it an open room of the building around it instead.
const ROOM_WORDS = [
  [/\b(stage|dais|platform|bandstand|podium)\b/i, 'stage'],
  [/\b(bar|counter|taproom|tap room)\b/i, 'bar'],
  [/\b(kitchen|galley)\b/i, 'kitchen'],
  [/\b(altar|shrine)\b/i, 'shrine'],
  [/\b(throne)\b/i, 'throne'],
  [/\b(storage|store ?room|pantry)\b/i, 'storage'],
];

function partCells(st) {
  const cells = new Set();
  for (const r of st.parts) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.add(`${x},${y}`);
  return cells;
}

export function mergeNestedStructures(plan, warn = () => {}) {
  const cells = plan.structures.map(partCells);
  const merged = new Set();
  plan.structures.forEach((inner, i) => {
    let host = -1;
    plan.structures.forEach((outer, j) => {
      if (i === j || merged.has(j) || outer.roof === 'none' || outer.wall === 'none') return;
      if (cells[j].size <= cells[i].size) return;
      for (const c of cells[i]) if (!cells[j].has(c)) return;
      if (host < 0 || cells[j].size < cells[host].size) host = j;
    });
    if (host < 0) return;
    const outer = plan.structures[host];
    const words = `${inner.label} ${inner.id}`;
    const kind = (ROOM_WORDS.find(([re]) => re.test(words)) || [])[1] || (ROOM_KINDS.includes(inner.kind) ? inner.kind : 'other');
    for (const r of inner.parts) outer.rooms.push({ label: inner.label, kind, ...r, open: true });
    for (const r of inner.rooms) outer.rooms.push({ ...r });
    merged.add(i);
    warn(`"${inner.label}" was drawn as a separate building inside "${outer.label}"; made it an open area of that building`);
  });
  if (merged.size) plan.structures = plan.structures.filter((_, i) => !merged.has(i));
  return merged.size;
}
