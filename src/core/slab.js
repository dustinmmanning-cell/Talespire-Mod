// TaleSpire slab codec (format v2).
//
// A slab on the clipboard is base64 text of a gzip stream, sometimes fenced in
// triple backticks. Decompressed, it is:
//
//   u32  magic          0xD1CEFACE
//   u16  version        2
//   u16  layoutCount
//   u16  creatureCount  always 0 in v2
//   layoutCount x { uuid assetKind (16 bytes, .NET Guid byte order), u16 count, u16 reserved }
//   sum(count) x u64 placement, grouped by layout, in layout order
//   u16  trailer        0x0000 (present in every slab the game emits)
//
// Each placement packs into one little-endian u64:
//
//   | 5 bits unused | 5 bits rot | 18 bits z | 18 bits y | 18 bits x |
//
// Coordinates are stored as round(value * 100), so 1/100 tile precision, and
// must be >= 0. y is the vertical axis. rot is a step index 0..23 (15 degrees
// per step). The compressed payload must not exceed 30,720 bytes.
//
// Sources: Bouncyrock/DumbSlabStats format.md (official), verified against
// slabs copied out of the game (see docs/slab-format.md).
//
// Runs unchanged in Node >= 18 and in TaleSpire's embedded Chromium: it only
// uses DataView, CompressionStream/DecompressionStream and btoa/atob.

export const SLAB_MAGIC = 0xd1ceface;
export const SLAB_VERSION = 2;
export const MAX_SLAB_BYTES = 30720;
export const COORD_SCALE = 100;
export const COORD_MAX = (1 << 18) - 1;
export const ROT_STEPS = 24;

const HEADER_BYTES = 10;
const LAYOUT_BYTES = 20;
const PLACEMENT_BYTES = 8;
const TRAILER_BYTES = 2;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SlabError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlabError';
  }
}

export function isGuid(value) {
  return typeof value === 'string' && GUID_RE.test(value);
}

// .NET Guid byte order: the first three groups are little-endian, the last
// two are written as-is. Reading it as a plain big-endian uuid gives a
// valid-looking id that matches no asset.
export function guidToBytes(guid, out = new Uint8Array(16), offset = 0) {
  if (!isGuid(guid)) throw new SlabError(`invalid asset id ${JSON.stringify(guid)}`);
  const hex = guid.replace(/-/g, '');
  const b = new Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
  for (let i = 0; i < 16; i++) out[offset + i] = b[order[i]];
  return out;
}

export function bytesToGuid(bytes, offset = 0) {
  const h = (i) => bytes[offset + i].toString(16).padStart(2, '0');
  return (
    h(3) + h(2) + h(1) + h(0) + '-' +
    h(5) + h(4) + '-' +
    h(7) + h(6) + '-' +
    h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}

function scaleCoord(label, value) {
  if (!Number.isFinite(value)) throw new SlabError(`${label}=${value} is not a finite number`);
  const scaled = Math.round(value * COORD_SCALE);
  if (scaled < 0) {
    throw new SlabError(`${label}=${value} is negative; slab coordinates must be >= 0 (normalize first)`);
  }
  if (scaled > COORD_MAX) {
    throw new SlabError(`${label}=${value} exceeds the 18-bit coordinate range (max ${COORD_MAX / COORD_SCALE})`);
  }
  return scaled;
}

// Write one placement as two little-endian u32 halves so no BigInt is needed.
//   low  = x (bits 0-17) | y bits 0-13 (bits 18-31)
//   high = y bits 14-17 (bits 0-3) | z (bits 4-21) | rot (bits 22-26) | extra (bits 27-31)
export function writePlacement(view, offset, p) {
  const x = scaleCoord('x', p.x);
  const y = scaleCoord('y', p.y);
  const z = scaleCoord('z', p.z);
  const rot = (((p.rot | 0) % ROT_STEPS) + ROT_STEPS) % ROT_STEPS;
  const extra = (p.extra | 0) & 0x1f;
  const low = (x | ((y & 0x3fff) << 18)) >>> 0;
  const high = ((y >>> 14) | (z << 4) | (rot << 22) | (extra << 27)) >>> 0;
  view.setUint32(offset, low, true);
  view.setUint32(offset + 4, high, true);
}

export function readPlacement(view, offset, assetId) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const x = low & COORD_MAX;
  const y = (low >>> 18) | ((high & 0xf) << 14);
  const z = (high >>> 4) & COORD_MAX;
  const rot = (high >>> 22) & 0x1f;
  const extra = high >>> 27;
  return { assetId, x: x / COORD_SCALE, y: y / COORD_SCALE, z: z / COORD_SCALE, rot, extra };
}

// Group placements by asset id in first-appearance order (deterministic, and a
// decode -> encode round trip of a real slab is byte-exact).
function groupByAsset(placements) {
  const groups = new Map();
  for (const p of placements) {
    const id = String(p.assetId).toLowerCase();
    let list = groups.get(id);
    if (!list) groups.set(id, (list = []));
    list.push(p);
  }
  return groups;
}

export function encodeSlabBinary(placements) {
  if (!placements || placements.length === 0) throw new SlabError('cannot encode an empty slab');
  const groups = groupByAsset(placements);
  if (groups.size > 0xffff) throw new SlabError(`too many distinct assets (${groups.size}) for one slab`);
  for (const [id, list] of groups) {
    if (list.length > 0xffff) {
      throw new SlabError(`asset ${id} has ${list.length} instances; one layout holds at most 65535`);
    }
  }
  const total = HEADER_BYTES + groups.size * LAYOUT_BYTES + placements.length * PLACEMENT_BYTES + TRAILER_BYTES;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SLAB_MAGIC, true);
  view.setUint16(4, SLAB_VERSION, true);
  view.setUint16(6, groups.size, true);
  view.setUint16(8, 0, true);
  let off = HEADER_BYTES;
  for (const [id, list] of groups) {
    guidToBytes(id, bytes, off);
    view.setUint16(off + 16, list.length, true);
    view.setUint16(off + 18, 0, true);
    off += LAYOUT_BYTES;
  }
  for (const list of groups.values()) {
    for (const p of list) {
      writePlacement(view, off, p);
      off += PLACEMENT_BYTES;
    }
  }
  // trailer: already zero
  return bytes;
}

export function decodeSlabBinary(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < HEADER_BYTES) throw new SlabError('slab data too short for a header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== SLAB_MAGIC) throw new SlabError(`bad magic 0x${magic.toString(16)}; not a TaleSpire slab`);
  const version = view.getUint16(4, true);
  if (version !== SLAB_VERSION) throw new SlabError(`unsupported slab version ${version} (expected 2)`);
  const layoutCount = view.getUint16(6, true);
  const creatureCount = view.getUint16(8, true);
  if (creatureCount !== 0) throw new SlabError(`creature count is ${creatureCount}; v2 slabs carry none`);
  let off = HEADER_BYTES;
  const layouts = [];
  for (let i = 0; i < layoutCount; i++) {
    if (off + LAYOUT_BYTES > bytes.length) throw new SlabError('slab truncated inside the layout table');
    layouts.push({ assetId: bytesToGuid(bytes, off), count: view.getUint16(off + 16, true) });
    off += LAYOUT_BYTES;
  }
  const placements = [];
  for (const layout of layouts) {
    for (let j = 0; j < layout.count; j++) {
      if (off + PLACEMENT_BYTES > bytes.length) throw new SlabError('slab truncated inside the placement data');
      placements.push(readPlacement(view, off, layout.assetId));
      off += PLACEMENT_BYTES;
    }
  }
  return { version, layouts, placements, trailingBytes: bytes.length - off };
}

// ---- gzip + base64 ---------------------------------------------------------

async function pipeThrough(bytes, stream) {
  const writer = stream.writable.getWriter();
  // Bad input fails both sides; the read below reports it, so the writer's
  // promises must not become unhandled rejections.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const chunks = [];
  let length = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function gzipBytes(bytes) {
  return pipeThrough(bytes, new CompressionStream('gzip'));
}

export function gunzipBytes(bytes) {
  return pipeThrough(bytes, new DecompressionStream('gzip'));
}

export function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToBytes(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Accept what people actually paste: whitespace, ``` fences, line breaks.
export function cleanSlabText(text) {
  let s = String(text).trim();
  if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.replace(/\s+/g, '');
}

// placements: [{ assetId, x, y, z, rot }]. Returns the paste string plus sizes.
export async function encodeSlab(placements, { maxBytes = MAX_SLAB_BYTES } = {}) {
  const raw = encodeSlabBinary(placements);
  const compressed = await gzipBytes(raw);
  if (maxBytes && compressed.length > maxBytes) {
    throw new SlabError(
      `slab compresses to ${compressed.length} bytes, over TaleSpire's ${maxBytes}-byte limit ` +
        `(${placements.length} assets); split it into several slabs`,
    );
  }
  return { text: bytesToBase64(compressed), compressedBytes: compressed.length, rawBytes: raw.length, count: placements.length };
}

export async function decodeSlab(text) {
  const compressed = base64ToBytes(cleanSlabText(text));
  const raw = await gunzipBytes(compressed);
  return { ...decodeSlabBinary(raw), compressedBytes: compressed.length, rawBytes: raw.length };
}

export async function compressedSize(placements) {
  return (await gzipBytes(encodeSlabBinary(placements))).length;
}

// ---- geometry helpers -----------------------------------------------------

export function slabBounds(placements) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const p of placements) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.z < b.minZ) b.minZ = p.z;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
    if (p.z > b.maxZ) b.maxZ = p.z;
  }
  return b;
}

// Shift placements so every coordinate is >= 0, moving x/z by WHOLE tiles only
// and y by quarter tiles. Shifting by a fractional minimum (some prop that
// overhangs its cell) would drag every tile on the board off the grid.
export function normalizePlacements(placements) {
  if (placements.length === 0) return placements;
  const b = slabBounds(placements);
  const dx = -Math.floor(b.minX + 1e-6);
  const dz = -Math.floor(b.minZ + 1e-6);
  const dy = -Math.floor(b.minY * 4 + 1e-6) / 4;
  return placements.map((p) => ({ ...p, x: round2(p.x + dx), y: round2(p.y + dy), z: round2(p.z + dz) }));
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}
