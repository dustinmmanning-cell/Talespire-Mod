#!/usr/bin/env node
// TaleForge command line: describe a place (or show it a map) and get slabs to
// paste into TaleSpire.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import {
  Catalog, Kit, STYLES, buildSlabs, textReport, generatePlan, labelTrace, remapTraceLabels, traceImage, heuristicLabels,
  traceToPlan, autoGridSize, resizeRgba, decodePng, encodePng, sniffImageType, decodeSlab, encodeSlab, demoCatalog,
  normalizePlan, probePlan, facingProbe, SIZE_PRESETS, describeKitReport, bytesToBase64, ApiError,
  PROVIDERS, PROVIDER_IDS, PRICES_AS_OF, TYPICAL_BUILD, providerOf, estimateBuildCost, formatCost,
  ModioClient, MODIO_BASE, generateCommunityPlan, prefabFromSlab, describePrefab,
} from '../core/index.js';

const HELP = `TaleForge -- AI board builder for TaleSpire

Usage:
  taleforge generate "<description>" [options]     plan with AI (Claude or GPT), build slabs
  taleforge community "<description>" [options]    build with community slabs from mod.io
  taleforge modio search <words>                   list TaleSpire slabs on mod.io
  taleforge refine <plan.json> "<change>" [options] edit an existing plan with AI
  taleforge build <plan.json> [options]            build slabs from a plan (no AI)
  taleforge trace <map.png> [options]              turn a top-down map image into slabs
  taleforge catalog [--talespire DIR] [--out f]    export your asset catalog as JSON
  taleforge catalog search <words> [--kind tile|prop]
  taleforge kit [--style s]                        show which asset fills each role
  taleforge decode <slab.txt>                      list what a slab contains
  taleforge probe house|tower|facing [--role bed]  calibration slabs to check in-game
  taleforge models [--effort high]                 AI models, prices and estimated cost per build
  taleforge proxy [--port 8787]                    local API proxy for the Symbiote

Asset catalog (needed for real slabs; GUIDs come from YOUR install):
  --talespire DIR     TaleSpire install folder (or set TALESPIRE_PATH); auto-detected on Steam
  --catalog FILE      catalog JSON exported by the TaleForge Symbiote or 'taleforge catalog'
  --demo              synthetic catalog: previews only, no slabs are written

Generation:
  --image FILE        reference image (png, jpg, webp, gif)
  --image-mode M      'reference' (mood, default) or 'layout' (reproduce a top-down map)
  --size WxH|PRESET   e.g. 40x30, or ${Object.keys(SIZE_PRESETS).join(', ')}
  --style S           ${STYLES.join(', ')}
  --provider P        anthropic or openai (default: whichever API key is set, Anthropic first)
  --model ID          default ${PROVIDERS.anthropic.defaultModel} / ${PROVIDERS.openai.defaultModel}; see 'taleforge models'
  --effort E          low | medium | high (default) | xhigh | max
  --api-key KEY       or set ANTHROPIC_API_KEY / OPENAI_API_KEY
  --base-url URL      API base URL, e.g. a proxy (or TALEFORGE_ANTHROPIC_BASE / TALEFORGE_OPENAI_BASE)

Community slabs (mod.io):
  --modio-key KEY     your read-only mod.io API key (or set MODIO_API_KEY)
  --modio-base URL    mod.io API base URL (or TALEFORGE_MODIO_BASE; default ${MODIO_BASE})
  --search WORDS      comma-separated searches instead of letting the AI choose
  The slabs a plan uses are saved next to it as NAME.community.json, which
  build and refine read back.

Trace:
  --size WxH          grid size (default: 48 tiles on the long side)
  --colors N          colour clusters (default 8)
  --setting S         auto | outdoor | dungeon (offline labelling)
  --ai                let the AI label the clusters and count the battle grid

Output:
  --out DIR           output folder (default ./out)
  --name STEM         file name stem (default from the title)
  --seed N            randomness seed for furniture and scatter
  --kit FILE          JSON of role overrides, e.g. {"wall:wood": "Rural Wall 01"}
  --facing N          furniture facing offset in steps (0, 6, 12, 18); see 'probe facing'
  --plan-only         stop after writing the plan
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const bool = new Set(['demo', 'ai', 'plan-only', 'help', 'no-multislab', 'json']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bool.has(key)) out.flags[key] = true;
      else out.flags[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const log = (...m) => process.stderr.write(m.join(' ') + '\n');

function fail(msg) {
  log(`error: ${msg}`);
  process.exit(1);
}

// ---- catalog -----------------------------------------------------------------

const STEAM_GUESSES = [
  'C:/Program Files (x86)/Steam/steamapps/common/TaleSpire',
  'C:/Program Files/Steam/steamapps/common/TaleSpire',
  'D:/SteamLibrary/steamapps/common/TaleSpire',
  'D:/Steam/steamapps/common/TaleSpire',
  'E:/SteamLibrary/steamapps/common/TaleSpire',
  join(homedir(), '.steam/steam/steamapps/common/TaleSpire'),
  join(homedir(), '.local/share/Steam/steamapps/common/TaleSpire'),
];

function findIndexFiles(dir) {
  const out = [];
  for (const sub of ['Taleweaver', 'TaleSpire_Data/Taleweaver']) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    for (const pack of readdirSync(root)) {
      const f = join(root, pack, 'index.json');
      if (existsSync(f)) out.push({ file: f, pack });
    }
  }
  return out;
}

function loadCatalog(flags, { required = true } = {}) {
  if (flags.demo) {
    log('using the SYNTHETIC demo catalog: previews only, slabs will not be written');
    return demoCatalog();
  }
  if (flags.catalog) {
    const cat = Catalog.fromJSON(JSON.parse(readFileSync(flags.catalog, 'utf8')));
    log(`catalog: ${cat.size} assets from ${flags.catalog}`);
    return cat;
  }
  const dirs = [flags.talespire, process.env.TALESPIRE_PATH, ...STEAM_GUESSES].filter(Boolean);
  for (const dir of dirs) {
    const files = findIndexFiles(dir);
    if (files.length) {
      const cat = Catalog.fromIndexJsons(files.map(({ file, pack }) => {
        const index = JSON.parse(readFileSync(file, 'utf8'));
        return { index, name: index.Name || pack };
      }));
      log(`catalog: ${cat.size} assets from ${files.length} pack(s) in ${dir}`);
      return cat;
    }
  }
  if (!required) return null;
  fail('no asset catalog. Pass --talespire <install dir>, --catalog <file.json> (export it from the Symbiote), or --demo for previews.');
  return null;
}

function loadKit(catalog, flags, style) {
  let overrides = {};
  if (flags.kit) overrides = JSON.parse(readFileSync(flags.kit, 'utf8'));
  return new Kit(catalog, { style: style || flags.style, overrides });
}

// ---- images ------------------------------------------------------------------

async function loadImageForApi(file) {
  const bytes = new Uint8Array(readFileSync(file));
  const type = sniffImageType(bytes);
  if (!type) fail(`${file}: not a png, jpeg, gif or webp image`);
  if (type === 'image/png') {
    let img = await decodePng(bytes);
    if (Math.max(img.width, img.height) > 1568 || bytes.length > 3.5e6) {
      img = resizeRgba(img, 1568);
      return { mediaType: 'image/png', data: bytesToBase64(await encodePng(img)) };
    }
  } else if (bytes.length > 5e6) {
    fail(`${file} is over 5 MB; shrink it or convert it to PNG so TaleForge can resize it`);
  }
  return { mediaType: type, data: bytesToBase64(bytes) };
}

function parseSize(v) {
  if (!v) return null;
  if (SIZE_PRESETS[v] !== undefined) return SIZE_PRESETS[v];
  const m = /^(\d+)x(\d+)$/i.exec(v);
  if (!m) fail(`--size must look like 40x30 or be one of ${Object.keys(SIZE_PRESETS).join(', ')}`);
  return [Number(m[1]), Number(m[2])];
}

// ---- output -------------------------------------------------------------------

function stemOf(title, flags) {
  if (flags.name) return flags.name;
  return (title || 'build').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'build';
}

// community: { prefabs: Map ref -> prefab, candidates?: [prefab] } for plans that place community slabs.
async function writeBuild(plan, catalog, flags, extraWarnings = [], { prefabs = new Map(), candidates = null } = {}) {
  const outDir = resolve(flags.out || 'out');
  mkdirSync(outDir, { recursive: true });
  const stem = stemOf(plan.title, flags);
  writeFileSync(join(outDir, `${stem}.plan.json`), JSON.stringify(plan, null, 2));
  if (candidates && candidates.length) {
    const slabs = candidates.map((c) => ({ ref: c.ref, name: c.name, creator: c.creator, url: c.url, summary: c.summary, tags: c.tags, how: c.how, size: describePrefab(c), text: c.slab }));
    writeFileSync(join(outDir, `${stem}.community.json`), JSON.stringify({ note: 'Community slabs from mod.io; they belong to their creators.', slabs }, null, 1));
  }
  if (flags['plan-only']) {
    log(`plan: ${join(outDir, `${stem}.plan.json`)}`);
    return;
  }
  const kit = loadKit(catalog, flags, plan.style);
  const build = await buildSlabs(plan, kit, {
    seed: flags.seed, multiSlab: !flags['no-multislab'], furnitureFacing: flags.facing ? Number(flags.facing) : 0, prefabs,
  });
  build.warnings.unshift(...extraWarnings);
  writeFileSync(join(outDir, `${stem}.svg`), build.svg);
  writeFileSync(join(outDir, `${stem}.report.md`), textReport(build));
  const written = [`${stem}.plan.json`, ...(candidates && candidates.length ? [`${stem}.community.json`] : []), `${stem}.svg`, `${stem}.report.md`];
  for (const c of build.credits || []) log(`  community slab: ${c.name}${c.creator ? ` by ${c.creator}` : ''} ${c.url}`);
  if (catalog.meta && catalog.meta.synthetic) {
    log('demo catalog: skipping slab files (their asset ids are not real)');
  } else {
    build.chunks.forEach((c, i) => {
      const name = build.chunks.length > 1 ? `${stem}-part-${String(i + 1).padStart(2, '0')}.slab.txt` : `${stem}.slab.txt`;
      writeFileSync(join(outDir, name), c.text + '\n');
      written.push(name);
    });
    if (build.multiSlab) {
      writeFileSync(join(outDir, `${stem}.multislab.slab`), build.multiSlab);
      written.push(`${stem}.multislab.slab`);
    }
  }
  log('');
  log(`${plan.title}: ${build.stats.total} assets in ${build.chunks.length} slab(s) (largest ${Math.max(...build.chunks.map((c) => c.compressedBytes))} bytes)`);
  for (const w of build.warnings) log(`  ! ${w}`);
  log(`wrote to ${outDir}:`);
  for (const f of written) log(`  ${f}`);
  log(`see ${stem}.report.md for paste instructions`);
}

function progress() {
  const t0 = Date.now();
  let last = '';
  return (ev) => {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    let line = '';
    if (ev.phase === 'connecting') line = 'asking the model...';
    else if (ev.phase === 'retrying') line = `retrying (attempt ${ev.attempt})...`;
    else if (ev.phase === 'thinking') line = `thinking... ${secs}s`;
    else if (ev.phase === 'writing') line = `drawing the plan... ${ev.textChars} chars, ${secs}s`;
    else if (ev.phase === 'fallback') line = `continuing on fallback model ${ev.model}`;
    else if (ev.phase === 'scouting') line = 'asking the model what to search mod.io for...';
    else if (ev.phase === 'searching') line = `searching mod.io for "${ev.query}"...`;
    else if (ev.phase === 'downloading') line = `reading community slabs ${ev.done}/${ev.total}...`;
    else if (ev.phase === 'composing') line = `arranging ${ev.count} community slab(s)...`;
    if (line && line !== last) {
      process.stderr.write(`\r${line.padEnd(60)}`);
      last = line;
    }
  };
}

function apiOptions(flags) {
  let provider = flags.provider || providerOf(flags.model);
  if (!provider) provider = !process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY ? 'openai' : 'anthropic';
  const info = PROVIDERS[provider];
  if (!info) fail(`--provider must be one of ${PROVIDER_IDS.join(', ')}`);
  const apiKey = flags['api-key'] || process.env[info.envKey];
  if (!apiKey) fail(`set ${info.envKey} (or pass --api-key) to use ${info.label}. Get a key at https://${info.keySite}/`);
  // Deliberately not ANTHROPIC_BASE_URL / OPENAI_BASE_URL: tools and hosted
  // environments set those for their own routing, and the user's key must not
  // follow them by accident.
  const baseEnv = provider === 'openai' ? process.env.TALEFORGE_OPENAI_BASE : process.env.TALEFORGE_ANTHROPIC_BASE || process.env.TALEFORGE_API_BASE;
  return { provider, apiKey, baseUrl: flags['base-url'] || baseEnv || undefined, model: flags.model || info.defaultModel, effort: flags.effort || 'high' };
}

function usageLine(res) {
  return `${res.model}: ${res.usage.inputTokens + res.usage.cachedInputTokens} in / ${res.usage.outputTokens} out tokens, about ${formatCost(res.cost)}`;
}

async function withAi(fn) {
  try {
    return await fn();
  } catch (e) {
    process.stderr.write('\n');
    if (e instanceof ApiError) fail(e.message);
    throw e;
  } finally {
    process.stderr.write('\n');
  }
}

// ---- commands -------------------------------------------------------------------

async function cmdGenerate(args) {
  const { flags } = args;
  const prompt = args._[1];
  if (!prompt && !flags.image) fail('describe what to build, e.g. taleforge generate "a smugglers\' cove with a hidden dock"');
  const catalog = loadCatalog(flags);
  const image = flags.image ? await loadImageForApi(flags.image) : null;
  const res = await withAi(() => generatePlan({
    ...apiOptions(flags), prompt, size: parseSize(flags.size), style: flags.style, image,
    imageMode: flags['image-mode'] === 'layout' ? 'layout' : 'reference', catalog, onProgress: progress(),
  }));
  log(`plan "${res.plan.title}" from ${usageLine(res)}`);
  await writeBuild(res.plan, catalog, flags, res.warnings);
}

function modioFrom(flags) {
  const apiKey = flags['modio-key'] || process.env.MODIO_API_KEY;
  if (!apiKey) fail('set MODIO_API_KEY (or --modio-key): a free read-only key from mod.io > Account > API access');
  return new ModioClient({ apiKey, baseUrl: flags['modio-base'] || process.env.TALEFORGE_MODIO_BASE || MODIO_BASE });
}

// NAME.community.json next to a plan: the community slabs it may use.
function communityFile(planFile) {
  return planFile.replace(/(\.plan)?\.json$/i, '') + '.community.json';
}

async function loadCommunity(planFile, catalog, flags) {
  const file = flags.community || communityFile(planFile);
  if (!existsSync(file)) return new Map();
  const out = new Map();
  for (const e of JSON.parse(readFileSync(file, 'utf8')).slabs || []) {
    try {
      out.set(e.ref, await prefabFromSlab(e.text, catalog, { ref: e.ref, name: e.name, creator: e.creator, url: e.url, summary: e.summary, tags: e.tags, how: e.how }));
    } catch (err) {
      log(`  ! ${e.ref}: ${err.message}`);
    }
  }
  return out;
}

async function cmdCommunity(args) {
  const { flags } = args;
  const prompt = args._[1];
  if (!prompt) fail('describe what to build, e.g. taleforge community "a harbour village with a tavern and a lighthouse"');
  const catalog = loadCatalog(flags);
  if (catalog.meta && catalog.meta.synthetic) fail('community slabs need your real asset catalog (--talespire DIR or --catalog FILE), to check every slab uses assets you have');
  const searches = flags.search ? String(flags.search).split(',').map((q) => ({ query: q.trim(), purpose: '' })).filter((q) => q.query) : undefined;
  const res = await withAi(() => generateCommunityPlan({
    ...apiOptions(flags), prompt, size: parseSize(flags.size), style: flags.style, catalog, modio: modioFrom(flags), searches, onProgress: progress(),
  }));
  log(`searched mod.io for ${res.searches.map((x) => `"${x.query}"`).join(', ')}: ${res.found} found, ${res.candidates.length} usable`);
  for (const r of res.rejected) log(`  - not usable: ${r.name} by ${r.creator || '?'} (${r.reason})`);
  log(`plan "${res.plan.title}" from ${usageLine(res)}`);
  await writeBuild(res.plan, catalog, flags, res.warnings, { prefabs: res.prefabs, candidates: res.candidates });
}

async function cmdModio(args) {
  const { flags } = args;
  const [, sub, ...words] = args._;
  if (sub !== 'search') fail('usage: taleforge modio search <words>');
  const res = await withAi(() => modioFrom(flags).searchSlabs(words.join(' '), { limit: Number(flags.limit) || 20 }));
  log(`${res.total} TaleSpire slab(s) on mod.io${res.tag ? ` tagged ${res.tag}` : ''} for "${words.join(' ')}":`);
  for (const it of res.items) log(`  ${it.ref.padEnd(14)} ${it.name}${it.creator ? ` by ${it.creator}` : ''}  ${it.url}`);
}

async function cmdRefine(args) {
  const { flags } = args;
  const [, planFile, change] = args._;
  if (!planFile || !change) fail('usage: taleforge refine <plan.json> "<what to change>"');
  const catalog = loadCatalog(flags);
  const previousPlan = JSON.parse(readFileSync(planFile, 'utf8'));
  const prefabs = await loadCommunity(planFile, catalog, flags);
  const res = await withAi(() => generatePlan({ ...apiOptions(flags), prompt: change, previousPlan, catalog, prefabs: [...prefabs.values()], onProgress: progress() }));
  log(`plan "${res.plan.title}" from ${usageLine(res)}`);
  await writeBuild(res.plan, catalog, flags, res.warnings, { prefabs, candidates: [...prefabs.values()] });
}

async function cmdBuild(args) {
  const { flags } = args;
  const planFile = args._[1];
  if (!planFile) fail('usage: taleforge build <plan.json>');
  const catalog = loadCatalog(flags);
  const { plan, warnings } = normalizePlan(JSON.parse(readFileSync(planFile, 'utf8')));
  const prefabs = plan.prefabs.length ? await loadCommunity(planFile, catalog, flags) : new Map();
  await writeBuild(plan, catalog, flags, warnings, { prefabs });
}

async function cmdTrace(args) {
  const { flags } = args;
  const file = args._[1];
  if (!file) fail('usage: taleforge trace <map.png>');
  const bytes = new Uint8Array(readFileSync(file));
  if (sniffImageType(bytes) !== 'image/png') fail('trace reads PNG files; convert the image to PNG first (the Symbiote accepts any format)');
  const img = await decodePng(bytes);
  let size = parseSize(flags.size) || autoGridSize(img.width, img.height, 48);
  const colors = Number(flags.colors) || 8;
  let trace = traceImage(img, { gridW: size[0], gridH: size[1], colors });
  log(`traced ${img.width}x${img.height} px onto ${size[0]}x${size[1]} tiles, ${trace.clusters.length} colour clusters`);
  const catalog = loadCatalog(flags);
  let labels;
  let extras = { title: basename(file, extname(file)) };
  if (flags.ai) {
    const small = resizeRgba(img, 1568);
    const image = { mediaType: 'image/png', data: bytesToBase64(await encodePng(small)) };
    const res = await withAi(() => labelTrace({ ...apiOptions(flags), effort: flags.effort || 'medium', trace, image, prompt: args._[2], catalog, onProgress: progress() }));
    log(`labels from ${usageLine(res)}`);
    labels = res.labels;
    extras = res.extras;
    if (res.grid && !flags.size && (Math.abs(res.grid[0] - size[0]) > 1 || Math.abs(res.grid[1] - size[1]) > 1)) {
      log(`the model counted a ${res.grid[0]}x${res.grid[1]} battle grid; re-tracing at that size`);
      size = res.grid;
      const again = traceImage(img, { gridW: size[0], gridH: size[1], colors });
      const moved = remapTraceLabels(trace, again, labels, extras.props);
      trace = again;
      labels = moved.labels;
      extras.props = moved.props;
    }
  } else {
    labels = heuristicLabels(trace, { setting: flags.setting || 'auto' });
  }
  for (const l of labels) log(`  cluster ${trace.clusters[l.index].char} ${trace.clusters[l.index].hex} -> ${l.meaning}${l.material ? ` (${l.material})` : ''}`);
  const { plan, warnings } = normalizePlan(traceToPlan(trace, labels, extras));
  await writeBuild(plan, catalog, flags, warnings);
}

async function cmdCatalog(args) {
  const { flags } = args;
  if (args._[1] === 'search') {
    const catalog = loadCatalog(flags);
    const words = args._.slice(2).join(' ');
    const hits = catalog.fuzzy(words, { kind: flags.kind || null, limit: Number(flags.limit) || 25 });
    for (const a of hits) log(`${a.kind.padEnd(5)} ${a.name.padEnd(42)} ${a.group.padEnd(16)} ${a.size.x}x${a.size.y}x${a.size.z}  ${a.id}`);
    return;
  }
  const catalog = loadCatalog(flags);
  const out = flags.out || 'taleforge-catalog.json';
  writeFileSync(out, JSON.stringify(catalog.toJSON()));
  log(`wrote ${catalog.size} assets to ${out}`);
}

function cmdKit(args) {
  const { flags } = args;
  const catalog = loadCatalog(flags);
  const kit = loadKit(catalog, flags);
  for (const m of ['grass', 'dirt', 'cobblestone', 'stone_floor', 'wood_floor', 'water', 'cave_floor', 'sand', 'snow', 'field']) kit.surface(m);
  for (const w of ['wood', 'stone', 'castle', 'plaster', 'ruined', 'cave']) kit.wall(w);
  kit.door();
  kit.gate();
  kit.stairs();
  kit.flatRoof();
  kit.roofKit();
  kit.crenellation();
  for (const r of ['tree', 'rock', 'barrel', 'crate', 'table', 'chair', 'bed', 'chest', 'bookshelf', 'anvil', 'altar', 'torch', 'well', 'fence']) kit.props(r);
  log(describeKitReport(kit.report()));
}

async function cmdDecode(args) {
  const { flags } = args;
  const file = args._[1];
  if (!file) fail('usage: taleforge decode <slab.txt>');
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const slab = await decodeSlab(text);
  const catalog = loadCatalog(flags, { required: false });
  const counts = new Map();
  for (const p of slab.placements) counts.set(p.assetId, (counts.get(p.assetId) || 0) + 1);
  log(`${slab.placements.length} assets, ${slab.layouts.length} distinct, ${slab.compressedBytes} bytes compressed`);
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const a = catalog && catalog.get(id);
    log(`  ${String(n).padStart(5)}  ${a ? a.name : id}`);
  }
  if (flags.json) process.stdout.write(JSON.stringify(slab.placements) + '\n');
}

async function cmdProbe(args) {
  const { flags } = args;
  const kind = args._[1] || 'house';
  const catalog = loadCatalog(flags);
  if (kind === 'facing') {
    if (catalog.meta && catalog.meta.synthetic) fail('the facing probe is a slab for your game; it needs your real catalog, not --demo');
    const kit = loadKit(catalog, flags);
    const placements = facingProbe(kit, flags.role || 'bed');
    const { text } = await encodeSlab(placements);
    const outDir = resolve(flags.out || 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'probe-facing.slab.txt'), text + '\n');
    log(`wrote ${join(outDir, 'probe-facing.slab.txt')}: four pads, left to right facing offsets 0, 6, 12, 18 (one to four marker tiles in front). Use the one that looks right as --facing.`);
    return;
  }
  await writeBuild(probePlan(kind), catalog, { ...flags, name: flags.name || `probe-${kind}` });
}

function cmdModels(args) {
  const effort = args.flags.effort || 'high';
  log(`Estimated cost of one typical building at '${effort}' effort (${TYPICAL_BUILD.inputTokens.toLocaleString()} tokens in, ~${TYPICAL_BUILD.outputTokens.toLocaleString()} out); prices per million tokens as of ${PRICES_AS_OF}.`);
  for (const p of Object.values(PROVIDERS)) {
    log('');
    log(`${p.label}  (--provider ${p.id}, key: ${p.envKey})`);
    for (const m of p.models) {
      const def = m.id === p.defaultModel ? ' (default)' : '';
      const price = `$${m.price.input} in / $${m.price.output} out`;
      log(`  ${(m.id + def).padEnd(28)} ${m.label.padEnd(18)} ${m.note.padEnd(13)} ${price.padEnd(20)} ~${formatCost(estimateBuildCost(m.id, { effort }))} per build`);
    }
  }
}

// Relays the Symbiote's API calls so keys stay in environment variables:
//   POST /v1/messages  -> Anthropic, with ANTHROPIC_API_KEY
//   POST /v1/responses -> OpenAI, with OPENAI_API_KEY
function cmdProxy(args) {
  const { flags } = args;
  const port = Number(flags.port) || 8787;
  const routes = {
    '/v1/messages': { key: process.env.ANTHROPIC_API_KEY, base: process.env.TALEFORGE_ANTHROPIC_BASE || process.env.TALEFORGE_API_BASE || PROVIDERS.anthropic.baseUrl, provider: 'anthropic' },
    '/v1/responses': { key: process.env.OPENAI_API_KEY, base: process.env.TALEFORGE_OPENAI_BASE || PROVIDERS.openai.baseUrl, provider: 'openai' },
  };
  if (!routes['/v1/messages'].key && !routes['/v1/responses'].key) log('no ANTHROPIC_API_KEY or OPENAI_API_KEY: relaying mod.io only');
  const modioBase = (process.env.TALEFORGE_MODIO_BASE || MODIO_BASE).replace(/\/v1\/?$/, '');
  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    // mod.io: GET /modio/v1/... -> the mod.io API (with the Symbiote's key, or
    // MODIO_API_KEY when it sends "proxy"); GET /modio/download?url= -> a mod.io file.
    if (req.method === 'GET' && req.url.startsWith('/modio/')) {
      try {
        const u = new URL(req.url, 'http://proxy');
        let target;
        if (u.pathname === '/modio/download') {
          target = new URL(u.searchParams.get('url') || '');
          if (target.protocol !== 'https:' || !/(^|\.)(mod\.io|modapi\.io|modcdn\.io)$/.test(target.hostname)) throw new Error('only mod.io file URLs');
        } else {
          target = new URL(`${modioBase}${u.pathname.slice('/modio'.length)}${u.search}`);
          if (target.searchParams.get('api_key') === 'proxy' && process.env.MODIO_API_KEY) target.searchParams.set('api_key', process.env.MODIO_API_KEY);
        }
        const up = await fetch(target);
        res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') || 'application/octet-stream' });
        for await (const c of up.body) res.write(c);
        res.end();
      } catch (e) {
        res.writeHead(502, cors);
        res.end(JSON.stringify({ error: { code: 502, error_ref: 0, message: `proxy: ${e.message}` } }));
      }
      return;
    }
    const route = routes[req.url];
    if (req.method !== 'POST' || !route) {
      res.writeHead(404, cors);
      res.end('{"error":{"type":"not_found","message":"only POST /v1/messages and /v1/responses"}}');
      return;
    }
    if (!route.key) {
      res.writeHead(401, cors);
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: `the proxy has no ${route.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}` } }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { 'content-type': 'application/json' };
    if (route.provider === 'openai') headers.authorization = `Bearer ${route.key}`;
    else {
      headers['x-api-key'] = route.key;
      headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    }
    try {
      const up = await fetch(`${route.base.replace(/\/$/, '')}${req.url}`, { method: 'POST', headers, body: Buffer.concat(chunks) });
      res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') || 'application/json' });
      for await (const c of up.body) res.write(c);
      res.end();
    } catch (e) {
      res.writeHead(502, cors);
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    for (const [path, r] of Object.entries(routes)) log(`${r.key ? 'relaying' : 'no key for'} ${path} -> ${r.base}`);
    log(`TaleForge proxy on http://127.0.0.1:${port}`);
    log(`In the Symbiote settings set the provider's "API base URL" to http://127.0.0.1:${port} and its API key to "proxy".`);
    log(`For mod.io, set "mod.io API base URL" to http://127.0.0.1:${port}/modio/v1 (key "proxy" uses MODIO_API_KEY).`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const commands = { community: cmdCommunity, modio: cmdModio, generate: cmdGenerate, refine: cmdRefine, build: cmdBuild, trace: cmdTrace, catalog: cmdCatalog, kit: cmdKit, decode: cmdDecode, probe: cmdProbe, models: cmdModels, proxy: cmdProxy };
  const fn = commands[cmd];
  if (!fn) fail(`unknown command "${cmd}". Run taleforge --help.`);
  await fn(args);
}

main().catch((e) => {
  log(`error: ${e.stack || e.message}`);
  process.exit(1);
});
