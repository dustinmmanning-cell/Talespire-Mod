// Building from community slabs on mod.io:
//   1. the model turns the request into a few mod.io searches,
//   2. TaleForge searches, downloads and analyzes the slabs found, keeping
//      only those whose every asset is in this GM's library,
//   3. the model lays out the scene, placing slabs whole and drawing the
//      rest (roads, terrain, small buildings) as usual.

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
    items: obj({ query: str('1-3 words, e.g. "tavern", "market stall", "watchtower"'), purpose: str('what this is for in the scene') }),
  },
  style: { type: 'string', enum: STYLES, description: 'the style that fits the request' },
});

const SEARCH_SYSTEM = `You help TaleForge find community-made TaleSpire slabs (finished builds shared by other players) on mod.io for a GM's request. mod.io's full-text search matches slab names and descriptions, so search the way builders name things.
Return 2 to 6 short searches, one per distinct building or landmark the request needs, most important first: "tavern", "blacksmith", "market stall", "watchtower", "ship", "sci-fi bar", "space station". Never search for terrain, roads, floors or generic ground; TaleForge draws those itself. Also pick the style that fits the request.`;

// -> { searches: [{ query, purpose }], style, usage, cost, model }
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
    .map((s) => ({ query: String((s && s.query) || '').trim().slice(0, 60), purpose: String((s && s.purpose) || '').slice(0, 120) }))
    .filter((s) => s.query && !seen.has(s.query.toLowerCase()) && seen.add(s.query.toLowerCase()))
    .slice(0, 6);
  return { searches, style: STYLES.includes(raw.style) ? raw.style : null, usage: out.usage, cost: out.cost, model: out.model };
}

// Search, download and analyze. cache: Map ref -> { text, how, item } of slabs
// already downloaded (kept by the caller across builds).
// -> { candidates: [prefab], rejected: [{ ref, name, creator, reason }], found }
export async function gatherSlabs({ modio, catalog, searches, perSearch = 6, max = 18, maxSide = 80, cache = new Map(), onProgress, signal }) {
  const items = new Map();
  for (const s of searches) {
    if (signal && signal.aborted) break;
    if (onProgress) onProgress({ phase: 'searching', query: s.query });
    const res = await modio.searchSlabs(s.query, { limit: perSearch, signal });
    for (const it of res.items) if (!items.has(it.ref) && items.size < max) items.set(it.ref, { ...it, search: s.query });
  }
  const candidates = [];
  const rejected = [];
  let done = 0;
  const list = [...items.values()];
  const work = async (it) => {
    try {
      let got = cache.get(it.ref);
      if (!got) {
        got = await modio.fetchSlab(it, { signal });
        cache.set(it.ref, { text: got.text, how: got.how, item: it });
      }
      const pf = await prefabFromSlab(got.text, catalog, {
        ref: it.ref, name: it.name, creator: it.creator, url: it.url, summary: it.summary, tags: it.tags, thumb: it.thumb, search: it.search, how: got.how,
      });
      if (pf.missing > 0) rejected.push({ ...credit(it), reason: `uses ${pf.missing} asset(s) your TaleSpire doesn't have` });
      else if (pf.w > maxSide || pf.d > maxSide) rejected.push({ ...credit(it), reason: `too big (${pf.w}x${pf.d} tiles)` });
      else candidates.push(pf);
    } catch (e) {
      rejected.push({ ...credit(it), reason: e.message });
    } finally {
      done++;
      if (onProgress) onProgress({ phase: 'downloading', done, total: list.length });
    }
  };
  // a few at a time: polite to mod.io, quick enough
  for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(work));
  return { candidates, rejected, found: list.length };
}

const credit = (it) => ({ ref: it.ref, name: it.name, creator: it.creator, url: it.url });

const addUsage = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const k of Object.keys(a)) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
};

// The whole flow. opts: generatePlan's options plus { modio, searches?, cache, onProgress }.
// -> generatePlan's result plus { prefabs: Map ref -> prefab, candidates, rejected, searches, searchModel }
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
  const { candidates, rejected, found } = await gatherSlabs({ ...opts, searches });
  if (!candidates.length) {
    const why = rejected.length ? ` ${rejected.length} were found but can't be used here (${[...new Set(rejected.map((r) => r.reason))].slice(0, 2).join('; ')}).` : '';
    throw new Error(`No usable community slabs found on mod.io for: ${searches.map((s) => s.query).join(', ')}.${why} Try other words, or build without community slabs.`);
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
  };
}
