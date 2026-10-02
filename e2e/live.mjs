// Live smoke test against the real Claude API. Spends real money (a few
// cents to about a dollar with the defaults); stops at the first failure and
// at a hard cost cap.
//
//   ANTHROPIC_API_KEY=... npm run test:live
//   ANTHROPIC_API_KEY=... node e2e/live.mjs --only schema,tavern --cap 0.5
//
// Steps (each builds on the previous one passing):
//   schema    a tiny room at low effort: is the request shape (structured
//             output schema, adaptive thinking, fallbacks beta) accepted?
//   tavern    a furnished two-storey tavern at the default effort
//   refine    change the tavern plan ("add a stable")
//   trace     label the clusters of a traced dungeon map (image input)
//   haiku     the Haiku request variant (no thinking/effort/fallbacks)
// Outputs go to e2e/out/live/: plans, previews, slabs, and a summary.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generatePlan, labelTrace, buildSlabs, Kit, demoCatalog, traceImage, traceToPlan, normalizePlan, decodePng,
  bytesToBase64, decodeSlab, DEFAULT_MODEL,
} from '../src/core/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out/live');
mkdirSync(outDir, { recursive: true });

// $ per million tokens (input, output, cache read) from the API pricing table.
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1],
  'claude-fable-5-1': [10, 50, 0.25],
};

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const only = flag('only', 'schema,tavern,refine,trace,haiku').split(',');
const cap = Number(flag('cap', '1.5'));
const model = flag('model', DEFAULT_MODEL);
const apiKey = process.env.ANTHROPIC_API_KEY;
// For dry runs against a mock server only; the real test talks to api.anthropic.com.
const baseUrl = process.env.TALEFORGE_API_BASE || undefined;
if (!apiKey) {
  console.log('SKIP: set ANTHROPIC_API_KEY to run the live test');
  process.exit(0);
}

let spent = 0;
const log = [];
function cost(usage, m) {
  const [pin, pout, pcache] = PRICES[m] || PRICES['claude-opus-5-5'];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25;
  return (input * pin + (usage.cache_read_input_tokens || 0) * pcache + (usage.output_tokens || 0) * pout) / 1e6;
}
function record(step, res, m, extra = {}) {
  const c = cost(res.usage, m);
  spent += c;
  const entry = { step, model: res.model, usage: res.usage, cost: Number(c.toFixed(4)), ...extra };
  log.push(entry);
  console.log(`  ${step}: ${res.model}, ${res.usage.input_tokens} in / ${res.usage.output_tokens} out, cache read ${res.usage.cache_read_input_tokens || 0}, ~$${c.toFixed(3)} (total ~$${spent.toFixed(3)})`);
  if (spent > cap) throw new Error(`cost cap $${cap} reached`);
}
const progress = (step) => {
  let last = '';
  return (ev) => {
    const p = ev.phase === 'writing' ? `writing ${Math.round(ev.textChars / 1000)}k` : ev.phase;
    if (p !== last) {
      process.stderr.write(`\r    ${step}: ${p}`.padEnd(50));
      last = p;
    }
  };
};

const catalog = demoCatalog();
// Offer the model the prop list as it would see it in-game (names only).
catalog.meta.synthetic = false;

async function save(name, plan, warnings) {
  writeFileSync(join(outDir, `${name}.plan.json`), JSON.stringify(plan, null, 2));
  catalog.meta.synthetic = true;
  try {
    const build = await buildSlabs(plan, new Kit(catalog, { style: plan.style }));
    writeFileSync(join(outDir, `${name}.svg`), build.svg);
    for (const c of build.chunks) await decodeSlab(c.text);
    const structures = build.grid.structures.filter((x) => !x.synthetic && x.cells.length).length;
    console.log(`    -> "${plan.title}" ${plan.width}x${plan.height}: ${structures} structures, ${build.grid.rooms.length} rooms, ${build.stats.total} assets, ${build.chunks.length} slab(s); ${warnings.length + build.warnings.length} warnings`);
    for (const w of [...warnings, ...build.warnings].slice(0, 8)) console.log(`       ! ${w}`);
    return build;
  } finally {
    catalog.meta.synthetic = false;
  }
}

const results = {};
const t0 = Date.now();
try {
  if (only.includes('schema')) {
    console.log('schema: tiny room, low effort');
    const res = await generatePlan({ apiKey, baseUrl, model, effort: 'low', prompt: 'A 6x5 stone storeroom with one door, three barrels and a crate.', size: [10, 8], style: 'dungeon', catalog, onProgress: progress('schema') });
    process.stderr.write('\n');
    record('schema', res, model);
    results.schema = await save('schema', res.plan, res.warnings);
  }
  if (only.includes('tavern')) {
    console.log('tavern: furnished two-storey tavern, default effort');
    const res = await generatePlan({ apiKey, baseUrl, model, prompt: 'A two-storey roadside tavern with a common room, a kitchen and a storeroom, a stable yard with a well, beside a cobbled road. Include a few trees.', size: [28, 24], style: 'medieval', catalog, onProgress: progress('tavern') });
    process.stderr.write('\n');
    record('tavern', res, model);
    results.tavern = await save('tavern', res.plan, res.warnings);
  }
  if (only.includes('refine') && results.tavern) {
    console.log('refine: add a stable');
    const res = await generatePlan({ apiKey, baseUrl, model, prompt: 'Add a small wooden stable with two stalls on the east side of the yard.', previousPlan: results.tavern.plan, catalog, onProgress: progress('refine') });
    process.stderr.write('\n');
    record('refine', res, model);
    const before = results.tavern.plan.structures.length;
    results.refine = await save('refine', res.plan, res.warnings);
    console.log(`    structures ${before} -> ${res.plan.structures.length}; title kept: ${res.plan.title === results.tavern.plan.title}`);
  }
  if (only.includes('trace')) {
    console.log('trace: label a traced dungeon map (image input)');
    const png = new Uint8Array(readFileSync(join(here, 'fixtures/dungeon-map.png')));
    const img = await decodePng(png);
    const trace = traceImage(img, { gridW: 15, gridH: 10, colors: 6 });
    const res = await labelTrace({ apiKey, baseUrl, model, trace, image: { mediaType: 'image/png', data: bytesToBase64(png) }, catalog, onProgress: progress('trace') });
    process.stderr.write('\n');
    record('trace', res, model, { grid: res.grid, labels: res.labels.map((l) => `${l.index}:${l.meaning}`) });
    console.log(`    labels: ${res.labels.map((l) => `${trace.clusters[l.index].hex}=${l.meaning}`).join(', ')}; grid counted: ${res.grid ? res.grid.join('x') : 'none'} (true grid is 30x20)`);
    const { plan, warnings } = normalizePlan(traceToPlan(trace, res.labels, res.extras));
    results.trace = await save('trace', plan, warnings);
  }
  if (only.includes('haiku')) {
    console.log('haiku: lite request variant');
    const res = await generatePlan({ apiKey, baseUrl, model: 'claude-haiku-4-5', prompt: 'A small woodcutter\'s hut in a forest clearing.', size: [16, 16], style: 'wilderness', catalog, onProgress: progress('haiku') });
    process.stderr.write('\n');
    record('haiku', res, 'claude-haiku-4-5');
    results.haiku = await save('haiku', res.plan, res.warnings);
  }
  console.log(`\nLIVE TEST PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s, ~$${spent.toFixed(3)} spent`);
} catch (e) {
  process.stderr.write('\n');
  console.log(`\nLIVE TEST FAILED: ${e.name}: ${e.message}${e.status ? ` (HTTP ${e.status}, ${e.type})` : ''}`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ model, spent: Number(spent.toFixed(4)), log }, null, 2));
  console.log(`outputs in ${outDir}`);
}
