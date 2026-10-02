// Live smoke test against a real AI provider. Spends real money (a few cents
// to about a dollar with the defaults); stops at the first failure and at a
// hard cost cap.
//
//   ANTHROPIC_API_KEY=... npm run test:live
//   OPENAI_API_KEY=...    npm run test:live -- --provider openai
//   node e2e/live.mjs --provider openai --model gpt-6.1-sol --only schema,tavern --cap 0.5
//
// Steps (each builds on the previous one passing):
//   schema    a tiny room at low effort: is the request shape (structured
//             output schema, reasoning/effort, fallbacks) accepted?
//   tavern    a furnished two-storey tavern at the default effort
//   refine    change the tavern plan ("add a stable")
//   trace     label the clusters of a traced dungeon map (image input)
//   cheap     the provider's cheapest listed model (Claude Haiku 4.5 takes a
//             different request shape: no thinking, effort or fallbacks)
// Outputs go to e2e/out/live/<provider>/: plans, previews, slabs, a summary.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generatePlan, labelTrace, buildSlabs, Kit, demoCatalog, traceImage, traceToPlan, normalizePlan, decodePng,
  bytesToBase64, decodeSlab, PROVIDERS, formatCost,
} from '../src/core/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const only = flag('only', 'schema,tavern,refine,trace,cheap').split(',');
const cap = Number(flag('cap', '1.5'));
const provider = flag('provider', !process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
const info = PROVIDERS[provider];
if (!info) {
  console.log(`unknown provider ${provider}`);
  process.exit(1);
}
const model = flag('model', info.defaultModel);
const cheapModel = info.models[info.models.length - 1].id;
const apiKey = process.env[info.envKey];
// For dry runs against a mock server only; the real test talks to the provider.
const baseUrl = (provider === 'openai' ? process.env.TALEFORGE_OPENAI_BASE : process.env.TALEFORGE_ANTHROPIC_BASE || process.env.TALEFORGE_API_BASE) || undefined;
if (!apiKey) {
  console.log(`SKIP: set ${info.envKey} to run the live test against ${info.label}`);
  process.exit(0);
}
const outDir = join(here, 'out/live', provider);
mkdirSync(outDir, { recursive: true });
console.log(`live test: ${info.label}, model ${model}, cost cap $${cap}`);

let spent = 0;
const log = [];
function record(step, res, extra = {}) {
  const c = res.cost ?? 0;
  spent += c;
  const u = res.usage;
  log.push({ step, model: res.model, usage: u, cost: Number(c.toFixed(4)), ...extra });
  console.log(`  ${step}: ${res.model}, ${u.inputTokens} in + ${u.cachedInputTokens} cached / ${u.outputTokens} out (${u.reasoningTokens} reasoning), ${formatCost(res.cost)} (total ${formatCost(spent)})${res.schemaMode ? `, schema ${res.schemaMode}` : ''}`);
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
    const res = await generatePlan({ provider, apiKey, baseUrl, model, effort: 'low', prompt: 'A 6x5 stone storeroom with one door, three barrels and a crate.', size: [10, 8], style: 'dungeon', catalog, onProgress: progress('schema') });
    process.stderr.write('\n');
    record('schema', res);
    results.schema = await save('schema', res.plan, res.warnings);
  }
  if (only.includes('tavern')) {
    console.log('tavern: furnished two-storey tavern, default effort');
    const res = await generatePlan({ provider, apiKey, baseUrl, model, prompt: 'A two-storey roadside tavern with a common room, a kitchen and a storeroom, a stable yard with a well, beside a cobbled road. Include a few trees.', size: [28, 24], style: 'medieval', catalog, onProgress: progress('tavern') });
    process.stderr.write('\n');
    record('tavern', res);
    results.tavern = await save('tavern', res.plan, res.warnings);
  }
  if (only.includes('refine') && results.tavern) {
    console.log('refine: add a stable');
    const res = await generatePlan({ provider, apiKey, baseUrl, model, prompt: 'Add a small wooden stable with two stalls on the east side of the yard.', previousPlan: results.tavern.plan, catalog, onProgress: progress('refine') });
    process.stderr.write('\n');
    record('refine', res);
    const before = results.tavern.plan.structures.length;
    results.refine = await save('refine', res.plan, res.warnings);
    console.log(`    structures ${before} -> ${res.plan.structures.length}; title kept: ${res.plan.title === results.tavern.plan.title}`);
  }
  if (only.includes('trace')) {
    console.log('trace: label a traced dungeon map (image input)');
    const png = new Uint8Array(readFileSync(join(here, 'fixtures/dungeon-map.png')));
    const img = await decodePng(png);
    const trace = traceImage(img, { gridW: 15, gridH: 10, colors: 6 });
    const res = await labelTrace({ provider, apiKey, baseUrl, model, trace, image: { mediaType: 'image/png', data: bytesToBase64(png) }, catalog, onProgress: progress('trace') });
    process.stderr.write('\n');
    record('trace', res, { grid: res.grid, labels: res.labels.map((l) => `${l.index}:${l.meaning}`) });
    console.log(`    labels: ${res.labels.map((l) => `${trace.clusters[l.index].hex}=${l.meaning}`).join(', ')}; grid counted: ${res.grid ? res.grid.join('x') : 'none'} (true grid is 30x20)`);
    const { plan, warnings } = normalizePlan(traceToPlan(trace, res.labels, res.extras));
    results.trace = await save('trace', plan, warnings);
  }
  if (only.includes('cheap')) {
    console.log(`cheap: ${cheapModel}`);
    const res = await generatePlan({ provider, apiKey, baseUrl, model: cheapModel, prompt: 'A small woodcutter\'s hut in a forest clearing.', size: [16, 16], style: 'wilderness', catalog, onProgress: progress('cheap') });
    process.stderr.write('\n');
    record('cheap', res);
    results.cheap = await save('cheap', res.plan, res.warnings);
  }
  console.log(`\nLIVE TEST PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s, ~$${spent.toFixed(3)} spent`);
} catch (e) {
  process.stderr.write('\n');
  console.log(`\nLIVE TEST FAILED: ${e.name}: ${e.message}${e.status ? ` (HTTP ${e.status}, ${e.type})` : ''}`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ provider, model, spent: Number(spent.toFixed(4)), log }, null, 2));
  console.log(`outputs in ${outDir}`);
}
