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
  normalizePlan, probePlan, facingProbe, SIZE_PRESETS, DEFAULT_MODEL, describeKitReport, bytesToBase64, ClaudeError,
} from '../core/index.js';

const HELP = `TaleForge -- AI board builder for TaleSpire

Usage:
  taleforge generate "<description>" [options]     plan with Claude, build slabs
  taleforge refine <plan.json> "<change>" [options] edit an existing plan with Claude
  taleforge build <plan.json> [options]            build slabs from a plan (no AI)
  taleforge trace <map.png> [options]              turn a top-down map image into slabs
  taleforge catalog [--talespire DIR] [--out f]    export your asset catalog as JSON
  taleforge catalog search <words> [--kind tile|prop]
  taleforge kit [--style s]                        show which asset fills each role
  taleforge decode <slab.txt>                      list what a slab contains
  taleforge probe house|tower|facing [--role bed]  calibration slabs to check in-game
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
  --model ID          default ${DEFAULT_MODEL}
  --effort E          low | medium | high (default) | xhigh | max
  --api-key KEY       or set ANTHROPIC_API_KEY
  --base-url URL      API base URL (e.g. a proxy)

Trace:
  --size WxH          grid size (default: 48 tiles on the long side)
  --colors N          colour clusters (default 8)
  --setting S         auto | outdoor | dungeon (offline labelling)
  --ai                let Claude label the clusters and count the battle grid

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

async function writeBuild(plan, catalog, flags, extraWarnings = []) {
  const outDir = resolve(flags.out || 'out');
  mkdirSync(outDir, { recursive: true });
  const stem = stemOf(plan.title, flags);
  writeFileSync(join(outDir, `${stem}.plan.json`), JSON.stringify(plan, null, 2));
  if (flags['plan-only']) {
    log(`plan: ${join(outDir, `${stem}.plan.json`)}`);
    return;
  }
  const kit = loadKit(catalog, flags, plan.style);
  const build = await buildSlabs(plan, kit, {
    seed: flags.seed, multiSlab: !flags['no-multislab'], furnitureFacing: flags.facing ? Number(flags.facing) : 0,
  });
  build.warnings.unshift(...extraWarnings);
  writeFileSync(join(outDir, `${stem}.svg`), build.svg);
  writeFileSync(join(outDir, `${stem}.report.md`), textReport(build));
  const written = [`${stem}.plan.json`, `${stem}.svg`, `${stem}.report.md`];
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
    if (ev.phase === 'connecting') line = 'asking Claude...';
    else if (ev.phase === 'retrying') line = `retrying (attempt ${ev.attempt})...`;
    else if (ev.phase === 'thinking') line = `thinking... ${secs}s`;
    else if (ev.phase === 'writing') line = `drawing the plan... ${ev.textChars} chars, ${secs}s`;
    else if (ev.phase === 'fallback') line = `continuing on fallback model ${ev.model}`;
    if (line && line !== last) {
      process.stderr.write(`\r${line.padEnd(60)}`);
      last = line;
    }
  };
}

function apiOptions(flags) {
  const apiKey = flags['api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) fail('set ANTHROPIC_API_KEY (or pass --api-key) to use Claude. Get a key at https://console.anthropic.com/');
  return { apiKey, baseUrl: flags['base-url'] || process.env.ANTHROPIC_BASE_URL || undefined, model: flags.model || DEFAULT_MODEL, effort: flags.effort || 'high' };
}

async function withClaude(fn) {
  try {
    return await fn();
  } catch (e) {
    process.stderr.write('\n');
    if (e instanceof ClaudeError) fail(e.message);
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
  const res = await withClaude(() => generatePlan({
    ...apiOptions(flags), prompt, size: parseSize(flags.size), style: flags.style, image,
    imageMode: flags['image-mode'] === 'layout' ? 'layout' : 'reference', catalog, onProgress: progress(),
  }));
  log(`plan "${res.plan.title}" from ${res.model} (${res.usage.output_tokens} output tokens)`);
  await writeBuild(res.plan, catalog, flags, res.warnings);
}

async function cmdRefine(args) {
  const { flags } = args;
  const [, planFile, change] = args._;
  if (!planFile || !change) fail('usage: taleforge refine <plan.json> "<what to change>"');
  const catalog = loadCatalog(flags);
  const previousPlan = JSON.parse(readFileSync(planFile, 'utf8'));
  const res = await withClaude(() => generatePlan({ ...apiOptions(flags), prompt: change, previousPlan, catalog, onProgress: progress() }));
  await writeBuild(res.plan, catalog, flags, res.warnings);
}

async function cmdBuild(args) {
  const { flags } = args;
  const planFile = args._[1];
  if (!planFile) fail('usage: taleforge build <plan.json>');
  const catalog = loadCatalog(flags);
  const { plan, warnings } = normalizePlan(JSON.parse(readFileSync(planFile, 'utf8')));
  await writeBuild(plan, catalog, flags, warnings);
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
    const res = await withClaude(() => labelTrace({ ...apiOptions(flags), effort: flags.effort || 'medium', trace, image, prompt: args._[2], catalog, onProgress: progress() }));
    labels = res.labels;
    extras = res.extras;
    if (res.grid && !flags.size && (Math.abs(res.grid[0] - size[0]) > 1 || Math.abs(res.grid[1] - size[1]) > 1)) {
      log(`Claude counted a ${res.grid[0]}x${res.grid[1]} battle grid; re-tracing at that size`);
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

function cmdProxy(args) {
  const { flags } = args;
  const port = Number(flags.port) || 8787;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) fail('set ANTHROPIC_API_KEY for the proxy to use');
  const upstream = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      res.writeHead(404, cors);
      res.end('{"error":{"type":"not_found","message":"only POST /v1/messages"}}');
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    try {
      const up = await fetch(`${upstream}/v1/messages`, { method: 'POST', headers, body: Buffer.concat(chunks) });
      res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') || 'application/json' });
      for await (const c of up.body) res.write(c);
      res.end();
    } catch (e) {
      res.writeHead(502, cors);
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    log(`TaleForge proxy on http://127.0.0.1:${port} -> ${upstream}`);
    log(`In the Symbiote settings set "API base URL" to http://127.0.0.1:${port} and the API key to "proxy".`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const commands = { generate: cmdGenerate, refine: cmdRefine, build: cmdBuild, trace: cmdTrace, catalog: cmdCatalog, kit: cmdKit, decode: cmdDecode, probe: cmdProbe, proxy: cmdProxy };
  const fn = commands[cmd];
  if (!fn) fail(`unknown command "${cmd}". Run taleforge --help.`);
  await fn(args);
}

main().catch((e) => {
  log(`error: ${e.stack || e.message}`);
  process.exit(1);
});
