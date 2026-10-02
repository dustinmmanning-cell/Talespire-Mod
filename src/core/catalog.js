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

export function makeAsset(fields) {
  const size = fields.size || { x: 1, y: 1, z: 1 };
  const center = fields.center || { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
  return {
    id: String(fields.id).toLowerCase(),
    name: String(fields.name || '').trim(),
    kind: fields.kind,
    group: String(fields.group || '').trim(),
    tags: (fields.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
    size: { x: r3(size.x) || 1, y: r3(size.y) || 1, z: r3(size.z) || 1 },
    center: { x: r3(center.x), y: r3(center.y), z: r3(center.z) },
    pack: fields.pack || '',
    deprecated: !!fields.deprecated,
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

export function assetsFromContentPacks(packInfos) {
  const tiles = [];
  for (const p of packInfos) for (const t of p.tiles || []) tiles.push(t);
  const scale = inferBoundsScale(tiles);
  const out = [];
  for (const pack of packInfos) {
    const packName = pack.optionalName || pack.id || '';
    for (const [key, kind] of [['tiles', 'tile'], ['props', 'prop']]) {
      for (const e of pack[key] || []) {
        if (!e || !e.id) continue;
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
  }
  return { assets: out, boundsScale: scale };
}

// ---- the catalog -----------------------------------------------------------

export class Catalog {
  constructor(assets = [], meta = {}) {
    this.meta = { source: 'unknown', ...meta };
    this.assets = [];
    this.byIdMap = new Map();
    this.byNameMap = new Map();
    for (const a of assets) this.add(a);
  }

  add(asset) {
    const a = asset.size && asset.center ? asset : makeAsset(asset);
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
      fields: ['id', 'name', 'kind', 'group', 'tags', 'sx', 'sy', 'sz', 'cx', 'cy', 'cz', 'pack', 'deprecated'],
      assets: this.assets.map((a) => [
        a.id, a.name, a.kind, a.group, a.tags.join('|'),
        a.size.x, a.size.y, a.size.z, a.center.x, a.center.y, a.center.z, a.pack, a.deprecated ? 1 : 0,
      ]),
    };
  }

  static fromJSON(data) {
    if (!data || data.format !== CATALOG_FORMAT) throw new Error('not a TaleForge catalog export');
    if (data.version !== CATALOG_VERSION) throw new Error(`catalog version ${data.version} is not supported`);
    const assets = data.assets.map((r) => makeAsset({
      id: r[0], name: r[1], kind: r[2], group: r[3], tags: r[4] ? r[4].split('|') : [],
      size: { x: r[5], y: r[6], z: r[7] }, center: { x: r[8], y: r[9], z: r[10] }, pack: r[11], deprecated: !!r[12],
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

  static fromContentPacks(packInfos) {
    const { assets, boundsScale } = assetsFromContentPacks(packInfos);
    return new Catalog(assets, {
      source: 'symbiote',
      packs: packInfos.map((p) => p.optionalName || p.id),
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
      if (!groups.has(g)) groups.set(g, new Set());
      groups.get(g).add(a.name);
    }
    const out = [];
    let total = 0;
    for (const g of [...groups.keys()].sort()) {
      const names = [...groups.get(g)].sort().slice(0, maxPerGroup);
      if (total + names.length > maxTotal) break;
      total += names.length;
      out.push({ group: g, names });
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
