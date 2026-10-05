// Asset catalog: every tile and prop the user's TaleSpire can place, with the
// collider geometry needed to put it on the grid correctly.
//
// Three sources, one model:
//   - the Symbiote API (TS.contentPacks.getMoreInfo) inside TaleSpire,
//   - the install's own <TaleSpire>/Taleweaver/<pack>/index.json files (CLI),
//   - a compact JSON export of either (to move a catalog between the two).
//
// GUIDs are never hardcoded anywhere in TaleForge: they are looked up here, by
// name and tags, in whatever the user actually owns.

export const CATALOG_FORMAT = 'taleforge-catalog';
export const CATALOG_VERSION = 1;

function r3(v) {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}

export function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenize(s) {
  return normalizeName(s).split(/[^a-z0-9]+/).filter(Boolean);
}

function tagList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',');
  if (v && typeof v === 'object') return Array.isArray(v.$values) ? v.$values : Object.values(v).filter((t) => typeof t === 'string');
  return [];
}

export function makeAsset(fields) {
  const size = fields.size || { x: 1, y: 1, z: 1 };
  const center = fields.center || { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
  return {
    id: String(fields.id).toLowerCase(),
    name: String(fields.name || '').trim(),
    kind: fields.kind,
    group: String(fields.group || '').trim(),
    tags: tagList(fields.tags).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
    size: { x: r3(size.x) || 1, y: r3(size.y) || 1, z: r3(size.z) || 1 },
    center: { x: r3(center.x), y: r3(center.y), z: r3(center.z) },
    pack: fields.pack || '',
    deprecated: !!fields.deprecated,
    ...(fields.kind === 'creature' ? { scale: Number(fields.scale) > 0 ? Number(fields.scale) : 1 } : {}),
  };
}

// ---- source: TaleSpire install index.json -------------------------------
// Entries carry ColliderBoundsBound { m_Center, m_Extent } where extents are
// half sizes (Unity Bounds).
export function assetsFromIndexJson(index, packName) {
  const out = [];
  const pack = packName || index.Name || '';
  for (const [key, kind] of [['Tiles', 'tile'], ['Props', 'prop'], ['Creatures', 'creature']]) {
    for (const e of index[key] || []) {
      if (!e || !e.Id) continue;
      const b = e.ColliderBoundsBound || {};
      const ext = b.m_Extent || {};
      const ctr = b.m_Center || {};
      const size = { x: 2 * (ext.x || 0.5), y: 2 * (ext.y || 0.5), z: 2 * (ext.z || 0.5) };
      out.push(makeAsset({
        id: e.Id, name: e.Name, kind, group: e.GroupTag, tags: e.Tags, pack,
        size,
        center: { x: ctr.x ?? size.x / 2, y: ctr.y ?? size.y / 2, z: ctr.z ?? size.z / 2 },
        deprecated: e.IsDeprecated,
        scale: e.DefaultScale,
      }));
    }
  }
  return out;
}

// ---- source: Symbiote API --------------------------------------------------
// contentPackPlaceableElement.colliderBoundsBound is { center, width, height,
// depth }. The docs do not say whether width/height/depth are full sizes or
// half extents. Tiles are authored with their collider's min corner on the
// origin, so for a tile center.x == size.x / 2. We measure which reading makes
// that true across the whole catalog instead of guessing.
export function inferBoundsScale(elements) {
  let full = 0;
  let half = 0;
  for (const e of elements) {
    const b = e && e.colliderBoundsBound;
    if (!b || !b.center || !(b.width > 0)) continue;
    const cx = Math.abs(b.center.x);
    if (Math.abs(cx - b.width / 2) < 0.02) full++;
    else if (Math.abs(cx - b.width) < 0.02) half++;
  }
  return half > full ? 2 : 1;
}

export function assetsFromContentPacks(packInfos, names = []) {
  const packs = listOf(packInfos);
  const tiles = [];
  for (const p of packs) for (const t of listOf(p && p.tiles)) tiles.push(t);
  const scale = inferBoundsScale(tiles);
  const out = [];
  for (const [i, pack] of packs.entries()) {
    if (!pack || typeof pack !== 'object') continue;
    const packName = names[i] || pack.optionalName || pack.id || '';
    for (const [key, kind] of [['tiles', 'tile'], ['props', 'prop']]) {
      for (const e of listOf(pack[key])) {
        if (!e || typeof e !== 'object' || !e.id || typeof e.id !== 'string') continue;
        const b = e.colliderBoundsBound || {};
        const size = { x: (b.width || 1) * scale, y: (b.height || 1) * scale, z: (b.depth || 1) * scale };
        const c = b.center || {};
        out.push(makeAsset({
          id: e.id, name: e.name, kind, group: e.groupTag, tags: e.tags, pack: packName,
          size,
          center: { x: c.x ?? size.x / 2, y: c.y ?? size.y / 2, z: c.z ?? size.z / 2 },
          deprecated: e.isDeprecated,
        }));
      }
    }
    // minis (contentPackCreatureElement: no collider bounds, a default scale)
    for (const e of listOf(pack.creatures)) {
      if (!e || typeof e !== 'object' || !e.id || typeof e.id !== 'string') continue;
      out.push(makeAsset({ id: e.id, name: e.name, kind: 'creature', group: e.groupTag, tags: e.tags, pack: packName, scale: e.defaultScale, deprecated: e.isDeprecated }));
    }
  }
  return { assets: out, boundsScale: scale };
}

// The docs say tiles and props are arrays. In TaleSpire (seen 2026-10, web
// view Chrome 111) getMoreInfo returns every pack as
//   { optionalName, tiles: { <guid>: element }, props: { <guid>: element }, creatures, music }
// with no pack id, and icon as { atlas, region }. Accept that, arrays, .NET
// style { $values: [...] } wrappers, array-likes and other iterables.
const GUID_KEY = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const isElement = (e) => !!e && typeof e === 'object' && ('id' in e || 'name' in e);
export function listOf(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  if (Array.isArray(v.$values)) return v.$values;
  if (typeof v[Symbol.iterator] === 'function') return [...v];
  if (typeof v.length === 'number') return Array.from(v);
  const entries = Object.entries(v);
  const nested = entries.find(([, x]) => Array.isArray(x) && x.some(isElement));
  if (nested && !entries.some(([, x]) => isElement(x))) return nested[1];
  return entries.filter(([, e]) => isElement(e)).map(([k, e]) => (e.id || !GUID_KEY.test(k) ? e : { ...e, id: k }));
}

// A short description of what TaleSpire sent for each pack, for bug reports:
// the shapes of the fields, never the whole catalog.
export function describePackShapes(packInfos, { maxPacks = 30, names = [] } = {}) {
  const shape = (v) => {
    if (Array.isArray(v)) return { type: 'array', length: v.length, first: v.length ? shapeOfItem(v[0]) : null };
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      return { type: 'object', keyCount: keys.length, firstKeys: keys.slice(0, 4), first: keys.length ? shapeOfItem(v[keys[0]]) : null };
    }
    return { type: v === null ? 'null' : typeof v };
  };
  const shapeOfItem = (x) => {
    if (!x || typeof x !== 'object') return typeof x;
    const out = {};
    for (const [k, val] of Object.entries(x).slice(0, 14)) {
      out[k] = Array.isArray(val) ? `array(${val.length})` : val && typeof val === 'object' ? `object{${Object.keys(val).slice(0, 6).join(',')}}` : typeof val === 'string' ? `string(${val.slice(0, 40)})` : typeof val;
    }
    return out;
  };
  const top = Array.isArray(packInfos) ? packInfos : [packInfos];
  return {
    packInfos: Array.isArray(packInfos) ? `array(${packInfos.length})` : shape(packInfos).type,
    packs: top.slice(0, maxPacks).map((p, i) =>
      p && typeof p === 'object'
        ? { name: names[i] || p.optionalName || p.id || null, keys: Object.keys(p), tiles: shape(p.tiles), props: shape(p.props) }
        : { type: typeof p },
    ),
  };
}

// Reads every loaded content pack through the Symbiote API:
//   api = { getContentPacks(), getMoreInfo(fragments) }, each throwing on failure.
// Asking for all packs at once is fastest, but one pack TaleSpire can't
// describe (for example one added by a BepInEx mod) fails the whole call. Then
// we ask pack by pack and skip the ones that fail.
// Returns { infos, skipped: [{ name, error }] }.
export async function readContentPacks(api, { log = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const frags = await api.getContentPacks();
  if (!Array.isArray(frags)) throw new Error(`TaleSpire sent an unexpected pack list (${describeValue(frags)})`);
  if (!frags.length) throw new Error('TaleSpire reported no loaded asset packs');
  try {
    const infos = packInfoList(await api.getMoreInfo(frags));
    // Assume answers come back in the order asked, but only when the counts match.
    if (infos.length) return { infos, names: infos.length === frags.length ? frags.map(fragName) : infos.map(() => null), skipped: [] };
    log('content packs: details for all packs came back empty; asking one pack at a time');
  } catch (e) {
    log(`content packs: details for all ${frags.length} packs failed (${e.message}); asking one pack at a time`);
  }
  const infos = [];
  const names = [];
  const skipped = [];
  for (const f of frags) {
    const name = fragName(f);
    for (let attempt = 0; ; attempt++) {
      try {
        const got = packInfoList(await api.getMoreInfo([f]));
        if (got.length) {
          infos.push(...got);
          names.push(...got.map(() => name));
        } else skipped.push({ name, error: 'no details' });
        break;
      } catch (e) {
        if (e && e.code === 'rateLimited' && attempt < 2) {
          await wait(1000 * (attempt + 1));
          continue;
        }
        skipped.push({ name, error: (e && e.message) || String(e) });
        log(`content packs: skipped "${name}": ${(e && e.message) || e}`);
        break;
      }
    }
  }
  if (!infos.length) {
    throw new Error(`TaleSpire could not describe any of your ${frags.length} asset pack(s). First error: ${skipped[0].error}`);
  }
  return { infos, names, skipped };
}

function fragName(f) {
  return (f && typeof f === 'object' ? f.optionalName || f.id : f) || null;
}

function packInfoList(v) {
  if (Array.isArray(v)) return v.filter((p) => p && typeof p === 'object');
  if (v && typeof v === 'object' && (v.tiles || v.props || v.creatures)) return [v];
  if (v && typeof v === 'object' && Array.isArray(v.$values)) return packInfoList(v.$values);
  throw new Error(`TaleSpire sent unexpected pack details (${describeValue(v)})`);
}

function describeValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v !== 'object') return `${typeof v} ${String(v).slice(0, 60)}`;
  try {
    return JSON.stringify(v).slice(0, 120);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

// ---- genre ------------------------------------------------------------------
// TaleSpire ships a fantasy library and a "Cyberpunk and Sci-Fi" one. Every
// asset gets a genre, so fantasy builds never pick a neon sign and sci-fi
// builds prefer their own walls. In order:
//   - an asset whose own name says sci-fi is sci-fi;
//   - a pack named as sci-fi, or with most of its groups sci-fi-sounding
//     (Concrete Building, Facility, Hull, Outpost, Doors (Modern)...), is
//     sci-fi throughout, generic group names included;
//   - otherwise each group decides by its name.
const SCIFI_NAME = /\b(sci ?-?fi|cyber|cyberpunk|neon|robot|futuristic|spaceship|hologram|laser)\b/i;
const SCIFI_GROUP = /\b(sci ?-?fi|cyber|modern|futur\w*|facility|hull|interstellar|outpost|industrial|construction|concrete|street|brick building|chamber|space|station|lab|office|apartment|neon)\b/i;
const SCIFI_PACK = /sci ?-?fi|cyber|modern|futur|space/i;
export const GENRES = ['fantasy', 'scifi'];

export function assignGenres(assets) {
  const groupsByPack = new Map();
  for (const a of assets) {
    if (!a.pack) continue;
    if (!groupsByPack.has(a.pack)) groupsByPack.set(a.pack, new Set());
    if (a.group) groupsByPack.get(a.pack).add(a.group);
  }
  const scifiPacks = new Set();
  for (const [pack, set] of groupsByPack) {
    const groups = [...set];
    const sci = groups.filter((g) => SCIFI_GROUP.test(g)).length;
    if (SCIFI_PACK.test(pack) || (groups.length > 0 && sci / groups.length >= 0.5)) scifiPacks.add(pack);
  }
  for (const a of assets) {
    a.genre = SCIFI_NAME.test(a.name) || scifiPacks.has(a.pack) || SCIFI_GROUP.test(a.group || '') ? 'scifi' : 'fantasy';
  }
}

// What a tile is for, judged by its name and collider shape (the same rules
// the kit uses): 'walls', 'windows', 'doors', 'floors', 'stairs' or null.
export function tileClass(a) {
  if (a.kind !== 'tile') return null;
  const n = a.name.toLowerCase();
  const thin = Math.min(a.size.x, a.size.z) <= 0.6;
  const long = Math.max(a.size.x, a.size.z);
  const tall = a.size.y >= 1.2;
  if (/stair/.test(n)) return 'stairs';
  if (thin && tall && near(long, 1) && /door/.test(n)) return 'doors';
  if (thin && tall && (near(long, 1) || near(long, 2)) && /window/.test(n)) return 'windows';
  if (thin && tall && (near(long, 1) || near(long, 2)) && !/door|arch|corner|roof|half|broken|stair|window/.test(n)) return 'walls';
  if (near(a.size.x, 1) && near(a.size.z, 1) && a.size.y <= 0.75 && !/wall|door|roof|stair|corner|window|pillar|column|post/.test(n)) return 'floors';
  return null;
}

// ---- the catalog -----------------------------------------------------------

export class Catalog {
  // Minis (kind 'creature') are kept apart in `minis`: they are never
  // building pieces, and `size` counts tiles and props only.
  constructor(assets = [], meta = {}) {
    this.meta = { source: 'unknown', ...meta };
    this.assets = [];
    this.minis = [];
    this.byIdMap = new Map();
    this.byNameMap = new Map();
    for (const a of assets) this.add(a);
    assignGenres(this.assets);
    assignGenres(this.minis);
  }

  // Library groups that can build a whole structure: wall pieces, and usually
  // floors, windows and doors. A structure's wall or floor can name one as
  // "kit:<group>". -> [{ group, genre, walls, windows, doors, floors, stairs }]
  buildingKits() {
    if (this._kits) return this._kits;
    const by = new Map();
    for (const a of this.assets) {
      if (a.deprecated || !a.group) continue;
      const cls = tileClass(a);
      if (!cls) continue;
      if (!by.has(a.group)) by.set(a.group, { group: a.group, genre: a.genre || 'fantasy', walls: 0, windows: 0, doors: 0, floors: 0, stairs: 0 });
      by.get(a.group)[cls]++;
    }
    this._kits = [...by.values()].filter((k) => k.walls > 0).sort((a, b) => a.genre.localeCompare(b.genre) || a.group.localeCompare(b.group));
    return this._kits;
  }

  // Tiles and props per pack, for the Kit tab and diagnostics.
  // -> [{ pack, tiles, props, scifi (how many of them are sci-fi), genre: 'fantasy'|'scifi'|'mixed' }]
  packSummary() {
    const by = new Map();
    for (const a of this.assets) {
      const k = a.pack || '(unnamed pack)';
      if (!by.has(k)) by.set(k, { pack: k, tiles: 0, props: 0, scifi: 0 });
      const p = by.get(k);
      p[a.kind === 'prop' ? 'props' : 'tiles']++;
      if (a.genre === 'scifi') p.scifi++;
    }
    return [...by.values()].map((p) => ({ ...p, genre: p.scifi === 0 ? 'fantasy' : p.scifi === p.tiles + p.props ? 'scifi' : 'mixed' }));
  }

  add(asset) {
    const a = asset.size && asset.center ? asset : makeAsset(asset);
    if (a.kind === 'creature') {
      this._miniIds = this._miniIds || new Set();
      if (this._miniIds.has(a.id)) return;
      this._miniIds.add(a.id);
      a._tokens = new Set([...tokenize(a.name), ...a.tags.flatMap(tokenize), ...tokenize(a.group)]);
      this.minis.push(a);
      return;
    }
    if (this.byIdMap.has(a.id)) return;
    this.assets.push(a);
    this.byIdMap.set(a.id, a);
    const key = normalizeName(a.name);
    const list = this.byNameMap.get(key);
    if (list) list.push(a);
    else this.byNameMap.set(key, [a]);
    a._tokens = new Set([...tokenize(a.name), ...a.tags.flatMap(tokenize), ...tokenize(a.group)]);
  }

  get size() {
    return this.assets.length;
  }

  get(id) {
    return this.byIdMap.get(String(id).toLowerCase()) || null;
  }

  // Exact (case/space-insensitive) name lookup; non-deprecated first.
  byName(name, kind) {
    const list = this.byNameMap.get(normalizeName(name)) || [];
    const ok = list.filter((a) => !kind || a.kind === kind);
    ok.sort((a, b) => a.deprecated - b.deprecated);
    return ok[0] || null;
  }

  // Structured query. Every field optional:
  //   kind, name (exact), group (string|array, case-insensitive),
  //   tags (all of), anyTags, excludeTags, terms (all name/tag tokens present),
  //   anyTerms, excludeTerms (name substrings), footprint [x, z] (either
  //   orientation, +-0.05), maxFootprint, minHeight, maxHeight, thin (true for
  //   wall-like pieces: one ground axis <= 0.6), length (long ground axis).
  find(q = {}) {
    if (q.name) {
      const a = this.byName(q.name, q.kind);
      return a && matchesQuery(a, { ...q, name: undefined }) ? [a] : [];
    }
    const out = this.assets.filter((a) => matchesQuery(a, q));
    out.sort((a, b) => a.deprecated - b.deprecated || a.name.localeCompare(b.name));
    return out;
  }

  // Free-text match for props the AI asked for by description
  // ("wine barrel", "anvil"). Scores token overlap; kind filters.
  fuzzy(text, { kind = 'prop', limit = 5, exclude = [] } = {}) {
    const want = tokenize(text).filter((t) => !STOP_WORDS.has(t));
    if (want.length === 0) return [];
    const ex = exclude.map(normalizeName);
    const scored = [];
    for (const a of this.assets) {
      if (kind && a.kind !== kind) continue;
      if (a.deprecated) continue;
      const lname = normalizeName(a.name);
      if (ex.some((e) => lname.includes(e))) continue;
      let score = 0;
      for (const t of want) {
        if (a._tokens.has(t)) score += 2;
        else if (t.length > 3 && lname.includes(t)) score += 1;
        else if (t.endsWith('s') && a._tokens.has(t.slice(0, -1))) score += 2;
      }
      if (score === 0) continue;
      score -= Math.max(0, tokenize(a.name).length - want.length) * 0.1;
      scored.push([score, a]);
    }
    scored.sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name));
    return scored.slice(0, limit).map((s) => s[1]);
  }

  toJSON() {
    return {
      format: CATALOG_FORMAT,
      version: CATALOG_VERSION,
      meta: this.meta,
      fields: ['id', 'name', 'kind', 'group', 'tags', 'sx', 'sy', 'sz', 'cx', 'cy', 'cz', 'pack', 'deprecated', 'scale'],
      assets: [...this.assets, ...this.minis].map((a) => [
        a.id, a.name, a.kind, a.group, a.tags.join('|'),
        a.size.x, a.size.y, a.size.z, a.center.x, a.center.y, a.center.z, a.pack, a.deprecated ? 1 : 0, ...(a.kind === 'creature' ? [a.scale] : []),
      ]),
    };
  }

  static fromJSON(data) {
    if (!data || data.format !== CATALOG_FORMAT) throw new Error('not a TaleForge catalog export');
    if (data.version !== CATALOG_VERSION) throw new Error(`catalog version ${data.version} is not supported`);
    const assets = data.assets.map((r) => makeAsset({
      id: r[0], name: r[1], kind: r[2], group: r[3], tags: r[4] ? r[4].split('|') : [],
      size: { x: r[5], y: r[6], z: r[7] }, center: { x: r[8], y: r[9], z: r[10] }, pack: r[11], deprecated: !!r[12], scale: r[13],
    }));
    return new Catalog(assets, data.meta || {});
  }

  static fromIndexJsons(indexes) {
    const assets = [];
    const packs = [];
    for (const { index, name } of indexes) {
      packs.push(name || index.Name || '');
      assets.push(...assetsFromIndexJson(index, name));
    }
    return new Catalog(assets, { source: 'install', packs });
  }

  // names: optional pack names, parallel to packInfos (TaleSpire's pack
  // details carry no id or name; the pack list does).
  static fromContentPacks(packInfos, names = []) {
    const { assets, boundsScale } = assetsFromContentPacks(packInfos, names);
    const used = new Set(assets.map((a) => a.pack));
    return new Catalog(assets, {
      source: 'symbiote',
      packs: [...used].map((n) => n || 'unnamed pack'),
      packsLoaded: listOf(packInfos).length,
      boundsScale,
    });
  }

  // Compact name listing for the AI prompt: prop names grouped by group tag.
  propNamesByGroup({ maxPerGroup = 60, maxTotal = 1500, exclude = [] } = {}) {
    const ex = exclude.map(normalizeName);
    const groups = new Map();
    for (const a of this.assets) {
      if (a.kind !== 'prop' || a.deprecated) continue;
      const lname = normalizeName(a.name);
      if (ex.some((e) => lname.includes(e))) continue;
      const g = a.group || 'Other';
      const key = `${a.genre || 'fantasy'}\u0000${g}`;
      if (!groups.has(key)) groups.set(key, { group: g, genre: a.genre || 'fantasy', names: new Set() });
      groups.get(key).names.add(a.name);
    }
    const out = [];
    let total = 0;
    for (const key of [...groups.keys()].sort()) {
      const { group, genre, names: set } = groups.get(key);
      const names = [...set].sort().slice(0, maxPerGroup);
      if (total + names.length > maxTotal) break;
      total += names.length;
      out.push({ group, genre, names });
    }
    return out;
  }
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'with', 'small', 'large', 'big', 'little', 'old', 'some']);

function asList(v) {
  return v === undefined || v === null ? null : Array.isArray(v) ? v : [v];
}

const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

export function matchesQuery(a, q) {
  if (q.kind && a.kind !== q.kind) return false;
  if (!q.includeDeprecated && a.deprecated && !q.name) return false;
  const groups = asList(q.group);
  if (groups && !groups.some((g) => normalizeName(g) === normalizeName(a.group))) return false;
  const tags = asList(q.tags);
  if (tags && !tags.every((t) => a.tags.includes(normalizeName(t)))) return false;
  const anyTags = asList(q.anyTags);
  if (anyTags && !anyTags.some((t) => a.tags.includes(normalizeName(t)))) return false;
  const excludeTags = asList(q.excludeTags);
  if (excludeTags && excludeTags.some((t) => a.tags.includes(normalizeName(t)))) return false;
  const lname = normalizeName(a.name);
  const terms = asList(q.terms);
  if (terms && !terms.every((t) => a._tokens.has(normalizeName(t)) || lname.includes(normalizeName(t)))) return false;
  const anyTerms = asList(q.anyTerms);
  if (anyTerms && !anyTerms.some((t) => a._tokens.has(normalizeName(t)) || lname.includes(normalizeName(t)))) return false;
  const excludeTerms = asList(q.excludeTerms);
  if (excludeTerms && excludeTerms.some((t) => lname.includes(normalizeName(t)))) return false;
  const sx = a.size.x;
  const sz = a.size.z;
  if (q.footprint) {
    const [fx, fz] = q.footprint;
    if (!((near(sx, fx) && near(sz, fz)) || (near(sx, fz) && near(sz, fx)))) return false;
  }
  if (q.maxFootprint !== undefined && Math.max(sx, sz) > q.maxFootprint + 1e-6) return false;
  if (q.minFootprint !== undefined && Math.max(sx, sz) < q.minFootprint - 1e-6) return false;
  if (q.minHeight !== undefined && a.size.y < q.minHeight - 1e-6) return false;
  if (q.maxHeight !== undefined && a.size.y > q.maxHeight + 1e-6) return false;
  if (q.thin && Math.min(sx, sz) > 0.6) return false;
  if (q.length !== undefined && !near(Math.max(sx, sz), q.length)) return false;
  return true;
}
