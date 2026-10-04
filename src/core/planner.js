// Prompting: description (+ optional reference image) -> build plan.

import { callModel } from './ai.js';
import { parseJsonText } from './http.js';
import { PLAN_SCHEMA, normalizePlan, MAX_MAP_TILES } from './plan.js';
import { STYLES, SURFACES, WALL_MATERIALS } from './kit.js';
import { TRACE_MEANINGS } from './trace.js';

export const SIZE_PRESETS = {
  auto: null,
  room: [16, 16],
  building: [28, 24],
  compound: [40, 32],
  village: [64, 48],
  town: [110, 90],
};

export const SYSTEM_PROMPT = `You are TaleForge, a master cartographer who designs battle maps, buildings and settlements for TaleSpire, a 3D virtual tabletop. You do not place 3D assets yourself: you draw a plan on a tile grid, and a deterministic builder turns it into TaleSpire tiles and props from the GM's own asset library.

# The grid
- 1 tile = 5 feet = one creature's space. A door is 1 tile wide. Two characters walk side by side in a 2-tile corridor.
- Coordinates are tiles. (0,0) is the top-left corner; x grows right (east), y grows down (south). North is the top of the map.
- Rectangles {x, y, w, h} cover tiles x..x+w-1 and y..y+h-1.
- Points [x, y] may be fractional: the centre of tile (3, 4) is [3.5, 4.5]. Area polygons use tile corners: a 10x5 field at the origin is [[0,0],[10,0],[10,5],[0,5]].
- Keep everything inside width x height.

# How the builder works -- design for it
- ground fills the whole map; areas paint over it in order; paths paint over areas; structures paint their floors over everything. Use ground 'none' for dungeons and interiors so only rooms have floors.
- Every structure gets walls automatically around the outline of its parts. Never draw a building's walls yourself.
- One building is ONE structure. Everything inside it (a bar, a stage, a kitchen, a dais) is a room of that structure, never a second structure: a structure drawn inside or across another becomes a separate building with its own outside walls.
  - interiorWalls true: walls between different rooms (houses, inns, manors, keeps). Rooms should tile the footprint; any footprint not covered by a room becomes a hallway.
  - open: true on a room removes its walls even when interiorWalls is true. Use it for an area that is part of a bigger room rather than a room of its own: the bar counter area or the bard's stage in a taproom (kind 'bar' or 'stage', placed inside the taproom against a wall), a dais in a hall, an alcove, a seating nook. A tavern is typically a big open taproom (kind 'common') holding an open bar and an open stage, plus walled kitchen and storerooms with doors.
  - interiorWalls false: rooms are open to each other. Build a dungeon or cave as ONE structure whose parts are its rooms and corridors, touching edge to edge where they connect (a corridor part must share an edge with the rooms it joins). Name each part as a room so it gets the right furniture.
- doors: {x, y, side} names a tile inside the structure and the side of that tile the door is on. Put an exterior door on the side facing a road or yard. With interiorWalls true, interior doors sit on the wall between two rooms. In an open dungeon a door may stand where a corridor meets a room. The builder adds doors where a room would otherwise be unreachable, but place the important ones yourself.
- Floors: a building with more than one storey lists every floor above the ground in upperFloors, bottom to top, each with its own parts (footprint), rooms and doors; storeys is 1 + their count. Give every upper floor real rooms (bedrooms, bunk rooms, a study, storage) so it gets walls and furniture. Floors need not match: an upper floor can be smaller (a tower room over a hall), shifted, turned 90 degrees, or overhanging (a ramshackle stack like shipping containers piled askew, jettied upper storeys), as long as it overlaps the floor below by at least 2x2 tiles, where the builder puts the stairs. Parts of a lower floor left uncovered get a flat roof you can walk on; a door on an upper floor's outer wall may open onto it. Footprints stay on the grid: floors turn in right angles, never at odd angles.
- roof: 'pitched' for houses, taverns and most buildings, 'flat' for towers, keeps and desert houses, 'none' only for dungeons, caves, ruins and open pavilions, or when the user asks for no roof. Buildings get roofs by default.
- furnish fills every room with furniture suited to its kind (bar, kitchen, bedroom, forge, shrine, library, crypt, treasury...). Add explicit props only for things that matter to the scene: a throne, an altar, a well, market stalls, a boat, a statue, a campfire, a cart, a sign.
- barriers are free-standing walls along grid lines (integer coordinates): town walls ('fortification', towers at the corners, gates given as points on the line), palisades, fences, hedges.
- scatter fills a polygon with natural clutter: forests (tree/conifer, density 0.25-0.45), rocky ground (rock/boulder 0.05-0.15), fields of crops or hay, graveyards (tombstone 0.2). The builder keeps scatter out of buildings and water.
- Props never overlap; the builder nudges or skips ones that collide.

# Good maps
- Plan for play: clear routes between areas, doors where people would walk, room for a party of 4-6 to fight (combat rooms at least 5x5), cover and points of interest.
- Realistic sizes: cottage 5x5 to 7x6, house 6x8, tavern or inn 12x10 to 16x12, smithy 6x7, chapel 7x12, temple 10x16, keep 14x14 or more, tower 4x4 to 6x6, market square 10x10 or more. Streets 2-3 tiles wide, lanes 1-2, trails 1, rivers 3-8.
- Interiors: rooms 3x3 or larger; dungeon corridors 1-2 wide.
- Every floor tile, wall segment and prop is one asset. Prefer fewer, richer features over blanket clutter. Maps up to about 120x120 are fine.
- Match materials to the theme: wood walls and wood_floor for cottages and inns, stone or castle walls for keeps and temples, cave walls and cave_floor for caverns, carpet for manors, plank for docks.
- Write a title, a summary (a line of read-aloud flavour, then the layout in one or two sentences) and notes with GM tips: hidden doors, encounters, hazards, where the party enters.`;

function assetSection(catalog) {
  if (!catalog || !catalog.size || (catalog.meta && catalog.meta.synthetic)) return '';
  const groups = catalog.propNamesByGroup({ maxPerGroup: 50, maxTotal: 1400, exclude: ['festive', 'christmas', 'cyber', 'neon', 'robot', 'scifi'] });
  if (!groups.length) return '';
  const lines = groups.map((g) => `${g.group}: ${g.names.join('; ')}`);
  return `\n\n# Props in this GM's library\nWhen you want a specific object, put its exact name from this list in "asset"; otherwise leave "asset" empty and choose the closest "role".\n${lines.join('\n')}`;
}

export function systemPrompt(catalog) {
  return SYSTEM_PROMPT + assetSection(catalog);
}

export function sizeLine(size) {
  if (!size) return 'Map size: choose what suits the request (most single buildings fit in 20-30 tiles a side, villages 50-70, towns 90-120).';
  const [w, h] = size;
  return `Map size: about ${w} x ${h} tiles (adjust by up to 25% if the design needs it; never above ${MAX_MAP_TILES}).`;
}

export function imageGuidance(imageMode) {
  if (imageMode === 'layout') {
    return 'The attached image is a top-down map, floor plan or sketch. Reproduce its layout faithfully: same rooms, buildings, roads and water in the same places and proportions. If it shows a battle grid, one grid square is one tile. Read labels in the image for room names.';
  }
  return 'The attached image is a reference for mood and content (concept art, a photo or a scene). Design a top-down layout that a player would recognise as that place: its main structures, materials, terrain and landmark objects.';
}

// image: { mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif', data: base64 }
export function buildUserContent({ prompt, size, style, image, imageMode, previousPlan }) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  const lines = [];
  if (previousPlan) {
    lines.push('Here is the current plan:');
    lines.push(JSON.stringify(stripForPrompt(previousPlan)));
    lines.push('');
    lines.push(`Change request: ${prompt}`);
    lines.push('Return the complete updated plan. Keep everything the change request does not mention as it is (same ids, positions and sizes).');
  } else {
    lines.push(`Request: ${prompt || 'Surprise me with an interesting adventure location.'}`);
    lines.push(sizeLine(size));
    lines.push(style && STYLES.includes(style) ? `Style: ${style}.` : 'Style: choose the best fit.');
    if (image) lines.push(imageGuidance(imageMode));
  }
  content.push({ type: 'text', text: lines.join('\n') });
  return content;
}

function stripForPrompt(plan) {
  const rest = { ...plan };
  delete rest.version;
  delete rest.raster;
  return rest;
}

// The one call most callers need.
//   opts: { provider, apiKey, baseUrl, model, effort, prompt, size, style, image,
//           imageMode, previousPlan, catalog, onProgress, signal, fetchImpl }
// provider is 'anthropic' (default) or 'openai'; model defaults per provider.
// -> { plan, warnings, provider, model, usage (normalized), cost (USD|null), raw }
export async function generatePlan(opts) {
  const system = systemPrompt(opts.catalog);
  const messages = [{ role: 'user', content: buildUserContent(opts) }];
  const out = await callModel({
    provider: opts.provider,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    effort: opts.effort || 'high',
    schemaName: 'build_plan',
    system,
    messages,
    schema: PLAN_SCHEMA,
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    fallbacks: opts.fallbacks !== false,
  });
  const raw = parseJsonText(out.text);
  const { plan, warnings } = normalizePlan(raw);
  return { plan, warnings, provider: out.provider, model: out.model, usage: out.usage, cost: out.cost, schemaMode: out.schemaMode, raw };
}

// ---- trace mode: label colour clusters of a traced map image ----------------

const tStr = (description) => ({ type: 'string', description });
const tInt = (description) => ({ type: 'integer', description });
const tObj = (properties, description) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties, ...(description ? { description } : {}) });

export function traceSchema() {
  const planProps = PLAN_SCHEMA.properties.props;
  return tObj({
    title: tStr('short name of the place'),
    summary: tStr('2-4 sentences describing the place for the GM'),
    notes: tStr('GM notes'),
    style: { type: 'string', enum: STYLES, description: 'overall look' },
    gridColumns: tInt('if the image shows a battle grid, how many grid squares across; otherwise 0'),
    gridRows: tInt('if the image shows a battle grid, how many grid squares down; otherwise 0'),
    clusters: {
      type: 'array',
      description: 'one entry per colour cluster',
      items: tObj({
        index: tInt('cluster index from the table'),
        meaning: { type: 'string', enum: TRACE_MEANINGS, description: 'what the cluster represents' },
        material: { type: 'string', enum: [...SURFACES, 'none'], description: "surface for ground/road/floor/building/forest; 'none' for wall/void" },
        wall: { type: 'string', enum: [...WALL_MATERIALS, 'none'], description: "wall material for floor/building clusters, else 'none'" },
        label: tStr('short description'),
      }),
    },
    props: planProps,
  });
}

export function traceUserText(trace, prompt) {
  const table = trace.clusters.map((c) => `${c.index} | ${c.char} | ${c.hex} | ${(c.share * 100).toFixed(1)}%`).join('\n');
  return [
    `This image is a top-down map. I reduced it to a ${trace.gridW} x ${trace.gridH} tile grid and grouped its colours into clusters.`,
    'index | map char | colour | share of map',
    table,
    '',
    "Cluster map (one character per tile, '.' = transparent):",
    trace.rows.join('\n'),
    '',
    'For each cluster, say what it represents:',
    '- ground, road, water, forest, rubble: open terrain (choose a surface material)',
    '- floor: walkable floor inside a dungeon, cave or building interior; walls are generated where floor meets wall or void',
    '- wall: solid wall or rock (left empty; walls are built along its edges)',
    '- void: background outside the map',
    '- building: a roofed building seen from above (becomes a walled building with a roof)',
    '- door: doors or doorways',
    'If the image has a battle grid, count its squares into gridColumns/gridRows (1 square = 1 tile); otherwise 0.',
    'Add props (up to about 40) for important features you can see -- statues, altars, tables, wells, boats -- positioned in the tile grid above.',
    prompt ? `GM notes: ${prompt}` : '',
  ].join('\n');
}

// -> { labels, extras: {title, summary, notes, style, props}, grid: [cols, rows]|null, provider, model, usage, cost }
export async function labelTrace(opts) {
  const { trace, image, prompt } = opts;
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  content.push({ type: 'text', text: traceUserText(trace, prompt) });
  const out = await callModel({
    provider: opts.provider,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    effort: opts.effort || 'medium',
    schemaName: 'trace_labels',
    system: systemPrompt(opts.catalog),
    messages: [{ role: 'user', content }],
    schema: traceSchema(),
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    fallbacks: opts.fallbacks !== false,
  });
  const raw = parseJsonText(out.text);
  const labels = (Array.isArray(raw.clusters) ? raw.clusters : [])
    .filter((l) => l && Number.isInteger(l.index) && l.index >= 0 && l.index < trace.clusters.length)
    .map((l) => ({ index: l.index, meaning: TRACE_MEANINGS.includes(l.meaning) ? l.meaning : 'ground', material: l.material, wall: l.wall, label: String(l.label || '') }));
  const cols = Number(raw.gridColumns) | 0;
  const rows = Number(raw.gridRows) | 0;
  return {
    labels,
    extras: { title: raw.title, summary: raw.summary, notes: raw.notes, style: raw.style, props: Array.isArray(raw.props) ? raw.props : [] },
    grid: cols >= 4 && rows >= 4 && cols <= MAX_MAP_TILES && rows <= MAX_MAP_TILES ? [cols, rows] : null,
    provider: out.provider,
    model: out.model,
    usage: out.usage,
    cost: out.cost,
  };
}

// After re-tracing at the grid size the model counted, carry labels across by
// nearest cluster colour and rescale prop positions.
export function remapTraceLabels(oldTrace, newTrace, labels, props = []) {
  const byOld = new Map(labels.map((l) => [l.index, l]));
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const newLabels = newTrace.clusters.map((c) => {
    let best = null;
    let bd = Infinity;
    for (const o of oldTrace.clusters) {
      const dd = d2(c.lab, o.lab);
      if (dd < bd) {
        bd = dd;
        best = o;
      }
    }
    const l = (best && byOld.get(best.index)) || { meaning: 'ground' };
    return { ...l, index: c.index };
  });
  const sx = newTrace.gridW / oldTrace.gridW;
  const sy = newTrace.gridH / oldTrace.gridH;
  return { labels: newLabels, props: props.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })) };
}
