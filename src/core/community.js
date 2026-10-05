// Building from community slabs on mod.io:
//   1. the model turns the request into a few mod.io searches,
//   2. TaleForge searches, re-ranks the results by their names, picks a fair
//      share for every search (optionally all from one creator, for a
//      consistent look), downloads and analyzes them, keeping only those
//      whose every asset is in this GM's library,
//   3. the model lays out the scene, placing slabs whole and drawing the
//      rest (roads, terrain, and with slabsOnly off, small buildings).

import { callModel } from './ai.js';
import { parseJsonText } from './http.js';
import { prefabFromSlab } from './prefab.js';
import { generatePlan } from './planner.js';
import { STYLES } from './kit.js';

const str = (description) => ({ type: 'string', description });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const SEARCH_SCHEMA = obj({
  searches: {
    type: 'array',
    description: '2 to 6 searches, most important first',
    items: obj({
      query: str('the word that names the thing, e.g. "tavern", "blacksmith", "watchtower" (no adjectives)'),
      words: { type: 'array', items: { type: 'string' }, description: '2 to 6 other single words builders put in slab names for it, e.g. for blacksmith: smithy, forge, anvil' },
      purpose: str('what this is for in the scene'),
    }),
  },
  style: { type: 'string', enum: STYLES, description: 'the style that fits the request' },
});

const SEARCH_SYSTEM = `You help TaleForge find community-made TaleSpire slabs (finished builds shared by other players) on mod.io for a GM's request.
Return 2 to 6 searches, one per distinct building or landmark the request needs, most important first. mod.io matches any word of a search and lists the most popular first, so each query is just the word that names the thing: "tavern", "blacksmith", "house", "watchtower", "ship", "space station". Leave out adjectives and setting words ("large", "small", "village", "old"): they match unrelated slabs.
For each search also give words: other single words builders use in slab names for the same thing (house: home, cottage, townhouse, dwelling; magic shop: arcane, alchemist, apothecary, wizard; tavern: inn, alehouse, pub).
Never search for terrain, roads, floors or generic ground; TaleForge draws those itself. Also pick the style that fits the request.`;

// -> { searches: [{ query, words, purpose }], style, usage, cost, model }
export async function planSearches(opts) {
  const out = await callModel({
    provider: opts.provider,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    effort: 'low',
    maxTokens: 4000,
    schemaName: 'slab_searches',
    system: SEARCH_SYSTEM,
    messages: [{ role: 'user', content: `Request: ${opts.prompt}${opts.style ? `\nStyle: ${opts.style}` : ''}` }],
    schema: SEARCH_SCHEMA,
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    fallbacks: opts.fallbacks !== false,
  });
  const raw = parseJsonText(out.text);
  const seen = new Set();
  const searches = (Array.isArray(raw.searches) ? raw.searches : [])
    .map((s) => ({
      query: String((s && s.query) || '').trim().slice(0, 60),
      words: (Array.isArray(s && s.words) ? s.words : []).map((w) => String(w).trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 6),
      purpose: String((s && s.purpose) || '').slice(0, 120),
    }))
    .filter((s) => s.query && !seen.has(s.query.toLowerCase()) && seen.add(s.query.toLowerCase()))
    .slice(0, 6);
  return { searches, style: STYLES.includes(raw.style) ? raw.style : null, usage: out.usage, cost: out.cost, model: out.model };
}

// ---- how well a slab matches a search ---------------------------------------
//
// mod.io's search matches any word and sorts by popularity, so "large tavern"
// brings back "Large Mountain with Cave". Results are re-ranked by the words
// in their names, tags and summaries. Names are split on case changes too:
// builders write "LemurianTownHouse6x6".

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'with', 'w', 'for', 'in', 'on', 'to', 'by', 'x', 'large', 'small', 'big', 'little', 'tiny', 'huge', 'old', 'new', 'village', 'town', 'city', 'fantasy', 'medieval', 'slab', 'building', 'tile', 'prop']);

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(text) {
  return (String(text || '').match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) || []).map((t) => stem(t.toLowerCase()));
}

function searchTerms(s) {
  const main = tokens(s.query).filter((t) => !STOP.has(t));
  const alt = (s.words || []).flatMap(tokens).filter((t) => !STOP.has(t) && !main.includes(t));
  return { main: [...new Set(main)], alt: [...new Set(alt)] };
}

function fields(item) {
  return {
    name: new Set(tokens(item.name)),
    compact: String(item.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    tags: new Set((item.tags || []).flatMap(tokens)),
    summary: new Set(tokens(item.summary)),
  };
}

// 3 for a word in the name, 2 in the tags, 1 in the summary; query words count
// double. weight(term): rarer words among the slabs at hand count more, so
// "magic" outweighs "shop" in "magic shop".
export function relevance(item, s, weight = () => 1) {
  const { main, alt } = searchTerms(s);
  const f = item.__f || fields(item);
  const hit = (t) => (f.name.has(t) || (t.length >= 5 && f.compact.includes(t)) ? 3 : f.tags.has(t) ? 2 : f.summary.has(t) ? 1 : 0);
  return main.reduce((n, t) => n + 2 * hit(t) * weight(t), 0) + alt.reduce((n, t) => n + hit(t) * weight(t), 0);
}

// For each search, [{ item, search, score }] best first. lists[i] are the
// slabs to rank for searches[i]. A slab that fits another search better
// sinks (a tavern named "...TownHouse..." is not the best house). Without
// `strict`, a search where nothing matches keeps mod.io's own order.
function rankAll(lists, searches, { strict = false } = {}) {
  const all = [...new Map(lists.flat().map((it) => [it.ref, it])).values()];
  const fx = new Map(all.map((it) => [it.ref, fields(it)]));
  const df = new Map();
  const weight = (t) => {
    if (!df.has(t)) {
      let n = 0;
      for (const f of fx.values()) if (f.name.has(t) || f.tags.has(t) || f.summary.has(t) || (t.length >= 5 && f.compact.includes(t))) n++;
      df.set(t, n);
    }
    return 1 + Math.log((1 + all.length) / (1 + df.get(t)));
  };
  const scores = new Map(all.map((it) => [it.ref, searches.map((s) => relevance({ ...it, __f: fx.get(it.ref) }, s, weight))]));
  return searches.map((s, si) => {
    const scored = lists[si].map((item, i) => {
      const sc = scores.get(item.ref);
      const other = Math.max(0, ...sc.filter((_, j) => j !== si));
      return { item, search: s.query, score: sc[si], sort: sc[si] - 0.5 * other, i };
    });
    const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.sort - a.sort || a.i - b.i);
    return hits.length || strict ? hits : scored;
  });
}

// Take from each search in turn, so every search gets its share (the first
// searches used to fill the whole budget). Then up to `extraCount` of `extras`.
function pickFair(sets, max, extras = [], extraCount = 0) {
  const out = new Map();
  const queues = sets.map((l) => l.slice());
  for (let progress = true; progress && out.size < max;) {
    progress = false;
    for (const q of queues) {
      if (out.size >= max) break;
      while (q.length && out.has(q[0].item.ref)) q.shift();
      if (!q.length) continue;
      const { item, search } = q.shift();
      out.set(item.ref, { ...item, search });
      progress = true;
    }
  }
  // note every search a picked slab matched
  for (const list of sets) {
    for (const { item, search } of list) {
      const o = out.get(item.ref);
      if (o && !o.search.split(', ').includes(search)) o.search = o.search ? `${o.search}, ${search}` : search;
    }
  }
  let n = 0;
  for (const it of extras) {
    if (out.size >= max || n >= extraCount) break;
    if (!out.has(it.ref)) {
      out.set(it.ref, { ...it, search: '' });
      n++;
    }
  }
  return [...out.values()];
}

// Creators by how many searches they have matching slabs for.
function creatorsByCoverage(sets) {
  const by = new Map();
  sets.forEach((list, si) => {
    list.forEach(({ item, score }, rankIndex) => {
      if (!score || !(item.creatorId || item.creator)) return;
      const key = item.creatorId || item.creator;
      const e = by.get(key) || { id: item.creatorId || null, name: item.creator || '', searches: new Set(), count: 0, best: Infinity };
      e.searches.add(si);
      e.count++;
      e.best = Math.min(e.best, rankIndex);
      by.set(key, e);
    });
  });
  return [...by.values()].sort((a, b) => b.searches.size - a.searches.size || b.count - a.count || a.best - b.best);
}

async function findCreator(modio, sets, name, signal) {
  const want = name.trim().toLowerCase();
  const match = (items) => {
    const list = items.filter((it) => it.creator);
    const it = list.find((x) => x.creator.toLowerCase() === want) || list.find((x) => x.creator.toLowerCase().includes(want));
    return it ? { id: it.creatorId || null, name: it.creator } : null;
  };
  const seen = match(sets.flat().map((x) => x.item));
  if (seen) return seen;
  return match((await modio.searchSlabs(name, { limit: 40, signal })).items);
}

// All of a creator's slabs that matter here: their catalog (most popular
// first), plus searches inside it when the catalog is too big to list whole.
async function creatorPool(modio, who, searches, sets, signal) {
  const pool = new Map();
  const mine = (it) => (who.id ? it.creatorId === who.id : it.creator === who.name);
  if (who.id) {
    const all = await modio.slabsBy(who.id, { limit: 200, signal });
    for (const it of all) if (mine(it)) pool.set(it.ref, it);
    if (all.length >= 200) {
      for (const s of searches) {
        for (const it of (await modio.searchSlabs(s.query, { limit: 20, submittedBy: who.id, signal })).items) if (mine(it)) pool.set(it.ref, it);
      }
    }
  }
  for (const list of sets) for (const { item } of list) if (mine(item)) pool.set(item.ref, item);
  return [...pool.values()];
}

// Download and analyze. cache: Map ref -> { text, how, item } of slabs
// already downloaded (kept by the caller across builds).
async function fetchAll({ modio, catalog, list, maxSide, cache, onProgress, signal }) {
  const candidates = [];
  const rejected = [];
  let done = 0;
  const work = async (it) => {
    try {
      let got = cache.get(it.ref);
      if (!got) {
        got = await modio.fetchSlab(it, { signal });
        cache.set(it.ref, { text: got.text, how: got.how, item: it });
      }
      const pf = await prefabFromSlab(got.text, catalog, {
        ref: it.ref, name: it.name, creator: it.creator, creatorId: it.creatorId, url: it.url, summary: it.summary, tags: it.tags, thumb: it.thumb, search: it.search, how: got.how,
      });
      if (pf.missing > 0) rejected.push({ ...credit(it), reason: `uses ${pf.missing} asset(s) your TaleSpire doesn't have` });
      else if (pf.w > maxSide || pf.d > maxSide) rejected.push({ ...credit(it), reason: `too big (${pf.w}x${pf.d} tiles)` });
      else candidates.push(pf);
    } catch (e) {
      rejected.push({ ...credit(it), reason: e.message, details: e.details || null });
    } finally {
      done++;
      if (onProgress) onProgress({ phase: 'downloading', done, total: list.length });
    }
  };
  // a few at a time: polite to mod.io, quick enough
  for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(work));
  // keep the order slabs were picked in (best match per search first)
  const order = new Map(list.map((it, i) => [it.ref, i]));
  candidates.sort((a, b) => order.get(a.ref) - order.get(b.ref));
  return { candidates, rejected };
}

// Search, pick, download and analyze.
//   creator: 'any' (best matches from anyone), 'one' (the creator whose slabs
//   cover the most searches, from their whole catalog) or a creator's name.
// -> { candidates: [prefab], rejected: [{ ref, name, creator, reason }], found,
//      creator: { id, name, slabs } | null }
export async function gatherSlabs({ modio, catalog, searches, perSearch = 8, max = 18, maxSide = 80, creator = 'any', cache = new Map(), onProgress, signal }) {
  const results = [];
  for (const s of searches) {
    if (signal && signal.aborted) break;
    if (onProgress) onProgress({ phase: 'searching', query: s.query });
    results.push((await modio.searchSlabs(s.query, { limit: perSearch, signal })).items);
  }
  const sets = rankAll(results, searches.slice(0, results.length));
  const common = { modio, catalog, maxSide, cache, onProgress, signal };
  if (!creator || creator === 'any') {
    const list = pickFair(sets, max);
    return { ...(await fetchAll({ ...common, list })), found: list.length, creator: null };
  }
  const named = creator !== 'one';
  const who = named ? [await findCreator(modio, sets, creator, signal)].filter(Boolean) : creatorsByCoverage(sets).slice(0, 2);
  if (!who.length) {
    throw new Error(named
      ? `No slabs by "${creator}" found on mod.io. Use the creator's name as mod.io shows it, or pick another creator setting.`
      : `None of the slabs found on mod.io match ${searches.map((s) => `"${s.query}"`).join(', ')}. Try other words.`);
  }
  const rejected = [];
  let found = 0;
  for (const w of who) {
    if (onProgress) onProgress({ phase: 'searching', query: `slabs by ${w.name}` });
    const pool = await creatorPool(modio, w, searches, sets, signal);
    const mineSets = rankAll(searches.map(() => pool), searches, { strict: true });
    const list = pickFair(mineSets, max, pool, 4);
    found += list.length;
    const got = await fetchAll({ ...common, list });
    rejected.push(...got.rejected);
    if (got.candidates.length) {
      const missing = searches.filter((s, i) => !mineSets[i].length).map((s) => s.query);
      return { candidates: got.candidates, rejected, found, creator: { id: w.id, name: w.name, slabs: pool.length, missing } };
    }
  }
  return { candidates: [], rejected, found, creator: { id: who[0].id, name: who[0].name, slabs: 0, missing: [] } };
}

const credit = (it) => ({ ref: it.ref, name: it.name, creator: it.creator, url: it.url });

const addUsage = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const k of Object.keys(a)) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
};

// The whole flow. opts: generatePlan's options (slabsOnly included) plus
// { modio, searches?, creator, cache, onProgress, onGathered }.
// -> generatePlan's result plus { prefabs: Map ref -> prefab, candidates, rejected, found, searches, creator }
export async function generateCommunityPlan(opts) {
  const step = (phase, extra) => opts.onProgress && opts.onProgress({ phase, ...extra });
  let searches = opts.searches;
  let scout = null;
  if (!searches || !searches.length) {
    step('scouting');
    scout = await planSearches(opts);
    searches = scout.searches;
  }
  if (!searches.length) throw new Error('Could not work out what to search mod.io for. Describe the buildings you want.');
  const { candidates, rejected, found, creator } = await gatherSlabs({ ...opts, searches });
  if (opts.onGathered) opts.onGathered({ searches, candidates, rejected, found, creator });
  if (!candidates.length) {
    const why = rejected.length ? ` ${rejected.length} were found but can't be used here (${[...new Set(rejected.map((r) => r.reason))].slice(0, 2).join('; ')}).` : '';
    const by = creator ? ` by ${creator.name}` : '';
    throw new Error(`No usable community slabs${by} found on mod.io for: ${searches.map((s) => s.query).join(', ')}.${why} Try other words${by ? ', another creator setting' : ''}, or build without community slabs.`);
  }
  step('composing', { count: candidates.length });
  const res = await generatePlan({ ...opts, style: opts.style || (scout && scout.style) || undefined, prefabs: candidates });
  const cost = res.cost === null || res.cost === undefined || !scout || scout.cost === null ? res.cost : res.cost + scout.cost;
  return {
    ...res,
    usage: addUsage(scout && scout.usage, res.usage),
    cost,
    prefabs: new Map(candidates.map((c) => [c.ref, c])),
    candidates,
    rejected,
    found,
    searches,
    creator,
  };
}
