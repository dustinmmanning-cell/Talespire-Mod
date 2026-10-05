// NPCs for a finished build: who lives and works there, written by the model
// from the plan (what stands where) and matched to the closest mini in the
// GM's library.
//
// Slabs can't carry creatures (v2 slabs have no creature data), so minis
// are placed one at a time: the Symbiote turns each NPC into a creature
// blueprint (TS.creatures.createBlueprint: a named mini with its model, HP
// and stats) and passes it to TaleSpire (TS.urls.submit), which puts the
// mini in the GM's hand. The write-ups go in the GM notes and the report,
// with a numbered marker for each NPC on the preview.

import { callModel } from './ai.js';
import { parseJsonText } from './http.js';
import { cleanNpcs, MAX_NPCS } from './plan.js';
import { rotatedSize, rotatedEntrances } from './prefab.js';

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const NPC_SCHEMA = obj({
  npcs: {
    type: 'array',
    description: `the people and creatures in this place, most important first (at most ${MAX_NPCS})`,
    items: obj({
      name: str('a full name that fits the setting, e.g. "Borin Ironhand"; for nameless creatures what they are, e.g. "Goblin lookout"'),
      race: str('e.g. human, dwarf, elf, halfling, gnome, half-orc, tiefling, goblin'),
      role: str('what they do here, e.g. blacksmith, barkeep, town guard, bandit leader'),
      mini: str('the closest mini from the list, by its exact name'),
      x: int('tile column where they stand'),
      y: int('tile row where they stand'),
      floor: int('1 for the ground floor, 2 for the floor above, and so on'),
      where: str('where that is, e.g. "behind the bar of the Green Barrel"'),
      about: str('two sentences for the GM: look and manner, what they want, and a hook, rumour or secret'),
      hp: int('hit points for a typical stat block of this kind of character; 0 for someone who would never fight'),
      hostile: { type: 'boolean', description: 'true for enemies the party may have to fight' },
    }),
  },
  notes: str('2-4 sentences tying them together: relationships, tensions, a rumour the party can pick up'),
});

const SYSTEM = `You write the NPCs for a tabletop RPG location built in TaleSpire. You get the request, the map (tile coordinates: x runs east, y runs south; 1 tile is 5 feet), what stands where, and the minis the GM owns.

Put people and creatures where they belong: the smith at the forge, the barkeep behind the bar and patrons at the tables, a guard at the gate, a priest at the altar, farmers in the fields, children in the square; monsters, their sentries and their leader in a dungeon. Scale to the place: 1 to 3 per shop or home, more in a tavern, market or barracks, a few on the streets; never more than ${MAX_NPCS}.

Stand each NPC on a tile inside the building, room or community slab they belong to (not on its outer wall or in a doorway), or out on the street or square, and set floor for upper storeys. Use the coordinates given.

Names fit the setting and the race and are all different. Mix races where the setting allows. Each "about" is two short sentences the GM can use at the table: something to see or hear, and something to play (a want, a secret, a hook). Hostile creatures get a tactic instead.

For mini, choose the closest name from the list, by race first and job second (a dwarf smith gets a dwarf mini). If nothing fits, pick a plain person of the right race.`;

// ---- what the model sees -----------------------------------------------------

const span = (a, b) => (a === b ? `${a}` : `${a}-${b}`);
const rect = (x, y, w, h) => `x ${span(x, x + w - 1)}, y ${span(y, y + h - 1)}`;

// The plan as a short list of places with tile ranges.
// prefabs: Map ref -> analyzed prefab (community slabs the plan places).
export function layoutSummary(plan, prefabs = new Map()) {
  const lines = [`Map: ${plan.width} x ${plan.height} tiles. ${plan.title}${plan.summary ? `: ${plan.summary}` : ''}`];
  const st = plan.structures || [];
  if (st.length) {
    lines.push('Buildings:');
    for (const s of st) {
      const parts = s.parts.map((p) => rect(p.x, p.y, p.w, p.h)).join(' + ');
      const bits = [`- "${s.label || s.id}" (${s.kind}${s.storeys > 1 ? `, ${s.storeys} storeys` : ''}) at ${parts}`];
      if (s.rooms && s.rooms.length) bits.push(`rooms: ${s.rooms.map((r) => `${r.label || r.kind} (${r.kind}) ${rect(r.x, r.y, r.w, r.h)}`).join('; ')}`);
      if (s.doors && s.doors.length) bits.push(`doors: ${s.doors.map((d) => `${d.side} at (${d.x},${d.y})`).join(', ')}`);
      for (const [i, f] of (s.upperFloors || []).entries()) {
        bits.push(`floor ${i + 2}: ${f.parts.map((p) => rect(p.x, p.y, p.w, p.h)).join(' + ')}${f.rooms && f.rooms.length ? ` (${f.rooms.map((r) => `${r.label || r.kind} ${rect(r.x, r.y, r.w, r.h)}`).join('; ')})` : ''}`);
      }
      lines.push(bits.join('; '));
    }
  }
  const pfs = (plan.prefabs || []).map((pp) => ({ pp, pf: prefabs.get(pp.ref) })).filter((x) => x.pf);
  if (pfs.length) {
    lines.push('Community slabs (finished buildings placed whole):');
    for (const { pp, pf } of pfs) {
      const q = Math.round(pp.rotation / 90) % 4;
      const [w, d] = rotatedSize(pf, q);
      const doors = rotatedEntrances(pf, q);
      lines.push(`- "${pf.name}" at ${rect(pp.x, pp.y, w, d)}${pf.floors > 1 ? `, ${pf.floors} storeys` : ''}${doors.length ? `, doors on ${doors.join('/')}` : ''}`);
    }
  }
  for (const p of plan.paths || []) if (p.label) lines.push(`Path "${p.label}" (${p.material}) through ${p.points.map((q) => `(${Math.round(q[0])},${Math.round(q[1])})`).join(' ')}`);
  for (const a of plan.areas || []) {
    if (!a.label) continue;
    const xs = a.points.map((q) => q[0]);
    const ys = a.points.map((q) => q[1]);
    lines.push(`Area "${a.label}" (${a.material}) around x ${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))}, y ${Math.round(Math.min(...ys))}-${Math.round(Math.max(...ys))}`);
  }
  if (plan.notes) lines.push(`Builder's notes: ${plan.notes}`);
  return lines.join('\n');
}

// "Human Commoner 01" and "Human Commoner 02" read as one entry with variants.
const baseName = (n) => n.replace(/[\s_-]*\(?\d+\)?$/, '').trim();

// Minis grouped by library group, variants collapsed.
export function miniSection(minis, { max = 600 } = {}) {
  const groups = new Map();
  let total = 0;
  for (const m of minis) {
    if (m.deprecated) continue;
    const g = m.group || 'Other';
    if (!groups.has(g)) groups.set(g, new Map());
    const b = baseName(m.name);
    const by = groups.get(g);
    if (!by.has(b)) {
      if (total >= max) continue;
      by.set(b, 0);
      total++;
    }
    by.set(b, by.get(b) + 1);
  }
  const lines = [];
  for (const g of [...groups.keys()].sort()) {
    const names = [...groups.get(g)].sort((a, b) => a[0].localeCompare(b[0])).map(([n, k]) => (k > 1 ? `${n} (${k} variants)` : n));
    if (names.length) lines.push(`${g}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

// ---- matching a mini -----------------------------------------------------------

const words = (s) => (String(s || '').toLowerCase().match(/[a-z]+/g) || []).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
const RACES = ['human', 'dwarf', 'elf', 'halfling', 'gnome', 'orc', 'goblin', 'tiefling', 'dragonborn', 'kobold', 'hobgoblin', 'bugbear', 'lizardfolk', 'tabaxi', 'aasimar', 'genasi', 'firbolg', 'giant', 'android', 'robot'];

// The closest mini for an NPC: the name the model chose, else a variant of
// it, else the best word match on race, job and name. `used` counts picks so
// the variants of one mini take turns.
export function resolveMini(npc, minis, used = new Map()) {
  const live = minis.filter((m) => !m.deprecated);
  if (!live.length) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(npc.mini);
  let pool = [];
  if (want) {
    pool = live.filter((m) => norm(m.name) === want);
    if (!pool.length) pool = live.filter((m) => norm(baseName(m.name)) === norm(baseName(npc.mini)));
  }
  if (!pool.length) pool = byWords(npc, live);
  if (!pool.length) pool = live.filter((m) => /\b(human|commoner|villager|peasant|townsfolk|citizen)\b/i.test(`${m.name} ${m.group}`));
  if (!pool.length) pool = live;
  pool.sort((a, b) => (used.get(a.id) || 0) - (used.get(b.id) || 0) || a.name.localeCompare(b.name));
  const m = pool[0];
  used.set(m.id, (used.get(m.id) || 0) + 1);
  return m;
}

// Minis scoring best on race (4) and on words of the job and the model's
// mini text (2 each).
function byWords(npc, live) {
  const race = words(npc.race).find((w) => RACES.includes(w)) || words(npc.race)[0] || '';
  const job = new Set([...words(npc.role), ...words(npc.mini)].filter((w) => w.length > 2));
  let best = 0;
  let pool = [];
  for (const m of live) {
    const t = new Set([...words(m.name), ...(m.tags || []).flatMap(words), ...words(m.group)]);
    const has = (w) => t.has(w) || [...t].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)));
    let sc = race && has(race) ? 4 : 0;
    for (const w of job) if (has(w)) sc += 2;
    if (sc > best) {
      best = sc;
      pool = [m];
    } else if (sc === best && sc > 0) pool.push(m);
  }
  return pool;
}

// Fill miniId/miniName/scale from the library.
export function assignMinis(npcs, minis) {
  const used = new Map();
  return npcs.map((n) => {
    const known = n.miniId && minis.find((m) => m.id === n.miniId);
    const m = known || resolveMini(n, minis, used);
    return m ? { ...n, miniId: m.id, miniName: m.name, scale: m.scale || 1 } : { ...n, miniId: '', miniName: '' };
  });
}

// ---- the model call ------------------------------------------------------------

// opts: { provider, apiKey, baseUrl, model, effort, plan, prefabs (Map),
//         minis, prompt (the original request), guidance, signal, fetchImpl }
// -> { npcs, notes, usage, cost, model, provider }
export async function generateNpcs(opts) {
  const plan = opts.plan;
  const minis = opts.minis || [];
  const lines = [];
  if (opts.prompt) lines.push(`Request: ${opts.prompt}`);
  if (opts.guidance) lines.push(`The GM asks: ${opts.guidance}`);
  lines.push(`Style: ${plan.style}`, '', '# The location', layoutSummary(plan, opts.prefabs || new Map()), '');
  lines.push('# Minis the GM has', minis.length ? miniSection(minis) : 'none listed: give mini as a short description, e.g. "human guard"');
  const out = await callModel({
    provider: opts.provider,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    effort: opts.effort || 'medium',
    maxTokens: 16000,
    schemaName: 'npcs',
    system: SYSTEM,
    messages: [{ role: 'user', content: lines.join('\n') }],
    schema: NPC_SCHEMA,
    onProgress: opts.onProgress,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    fallbacks: opts.fallbacks !== false,
  });
  const raw = parseJsonText(out.text);
  const npcs = assignMinis(cleanNpcs(raw.npcs, plan.width, plan.height), minis);
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 2000) : '';
  return { npcs, notes, usage: out.usage, cost: out.cost, model: out.model, provider: out.provider };
}

// ---- turning an NPC into a mini --------------------------------------------------

// A creatureInfo for TS.creatures.createBlueprint. statNames: the campaign's
// eight stat names (TS.creatures.getCreatureStatNamesForThisCampaign).
export function npcCreatureInfo(npc, statNames = [], { hidden = false } = {}) {
  const names = statNames.length ? statNames : ['', '', '', '', '', '', '', ''];
  return {
    id: '',
    isUnique: false,
    name: npc.name,
    nameSet: true,
    link: '',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boardId: '',
    morphs: [{ boardAssetId: npc.miniId, scale: npc.scale || 1 }],
    activeMorphIndex: 0,
    hp: { name: 'HP', value: npc.hp || 0, max: npc.hp || 0 },
    stats: names.map((name) => ({ name: String(name || ''), value: 0, max: 0 })),
    torchIsOn: false,
    isExplicitlyHidden: !!hidden,
    isFlying: false,
    idsOfActivePersistentEmotes: [],
    ownerIds: [],
  };
}

// One line per NPC for notes and reports.
export function npcLine(n, i) {
  const who = [n.race, n.role].filter(Boolean).join(' ');
  const where = n.where ? `, ${n.where}${n.floor > 1 ? ` (floor ${n.floor})` : ''}` : n.floor > 1 ? ` (floor ${n.floor})` : '';
  const extra = [n.hp ? `HP ${n.hp}` : '', n.hostile ? 'hostile' : '', n.miniName ? `mini: ${n.miniName}` : ''].filter(Boolean).join(', ');
  return `${i + 1}. ${n.name}${who ? ` (${who})` : ''}${where}. ${n.about}${extra ? ` [${extra}]` : ''}`;
}

export function npcNotesText(plan) {
  if (!plan.npcs || !plan.npcs.length) return '';
  return ['NPCs (numbers match the markers on the preview):', ...plan.npcs.map(npcLine), ...(plan.npcNotes ? ['', plan.npcNotes] : [])].join('\n');
}
