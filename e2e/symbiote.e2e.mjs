// End-to-end test of the Symbiote in real Chromium, with a fake TaleSpire API
// (TS.*) and a fake Claude endpoint. Run: npm run test:e2e
//
// Needs Playwright (npm i -D playwright, or a global install). Writes
// screenshots to e2e/out/.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { demoCatalog } from '../src/core/demo-catalog.js';
import { decodeSlab, encodeSlab, base64ToBytes } from '../src/core/slab.js';
import { compilePlan } from '../src/core/compile.js';
import { Kit } from '../src/core/kit.js';
import { zip } from '../src/core/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try {
      return await import(spec);
    } catch {
      // try the next one
    }
  }
  console.log('SKIP: Playwright is not installed');
  process.exit(0);
}

// The demo catalog in the Symbiote API's contentPackInfo shape (full sizes).
function contentPacks() {
  const cat = demoCatalog();
  const el = (a) => ({
    id: a.id, name: a.name, isDeprecated: false, groupTag: a.group, tags: a.tags, assets: [], isInteractable: false,
    colliderBoundsBound: { center: { locId: 0, ...a.center }, width: a.size.x, height: a.size.y, depth: a.size.z },
    icon: { atlas: 0, region: { x: 0, y: 0, width: 0, height: 0 } },
  });
  return [{
    id: 'core', optionalName: 'TaleSpire',
    tiles: cat.assets.filter((a) => a.kind === 'tile').map(el),
    props: cat.assets.filter((a) => a.kind === 'prop').map(el),
    creatures: [], music: [], iconsAtlases: [],
  }];
}

function sse(json) {
  const ev = [
    { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 900, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ];
  for (let i = 0; i < json.length; i += 400) ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(i, i + 400) } });
  ev.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2100 } }, { type: 'message_stop' });
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const plan = readFileSync(join(root, 'examples/plans/tavern.json'), 'utf8');
const apiCalls = [];
await page.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  apiCalls.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.parse(JSON.stringify(plan)) && plan) });
});

// OpenAI Responses API stream, event shapes as in the openai-node SDK.
function responsesSse(json) {
  const ev = [{ type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-astra-2026-09-03', status: 'in_progress' } }];
  for (let i = 0; i < json.length; i += 400) ev.push({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: json.slice(i, i + 400) });
  ev.push({ type: 'response.completed', response: { model: 'gpt-6-astra-2026-09-03', status: 'completed', usage: { input_tokens: 9500, input_tokens_details: { cached_tokens: 0 }, output_tokens: 11800, output_tokens_details: { reasoning_tokens: 5000 }, total_tokens: 21300 } } });
  return ev.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('');
}
const openaiCalls = [];
await page.route('https://api.openai.com/**', async (route) => {
  const req = route.request();
  openaiCalls.push({ url: req.url(), headers: req.headers(), body: JSON.parse(req.postData()) });
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: responsesSse(plan) });
});

// A fake TaleSpire API. opts.badPack: a pack id (like a mod's pack) that makes
// getMoreInfo fail whenever it is asked about. opts.packsFailUntilOk: the pack
// list call rejects until the page sets window.__packsOk.
function fakeTs({ packs, opts = {} }) {
  const store = { global: '', campaign: '' };
  window.__sent = [];
  window.__clip = [];
  window.TS = {
    debug: { log: async () => {} },
    contentPacks: {
      getContentPacks: async () => {
        if (opts.packsFailUntilOk && !window.__packsOk) throw { cause: 'internalError', message: 'not ready' };
        return packs.map((p) => ({ id: p.id, optionalName: p.optionalName }));
      },
      // Shaped like real TaleSpire answers (not the docs): no pack id, and
      // tiles/props as objects keyed by asset GUID.
      getMoreInfo: async (frags) => {
        window.__moreInfoCalls = (window.__moreInfoCalls || 0) + 1;
        if (frags.some((f) => f.id === opts.badPack)) return { cause: 'internalError' };
        const keyed = (v) => Object.fromEntries((Array.isArray(v) ? v : Object.values(v || {})).map((e) => [e.id, e]));
        return frags.map((f) => {
          const p = packs.find((x) => x.id === f.id);
          return { optionalName: undefined, tiles: keyed(p.tiles), props: keyed(p.props), creatures: {}, music: [] };
        });
      },
      findBoardObjectInPacks: async (id, infos) => {
        for (const p of infos) for (const k of ['tiles', 'props']) {
          const b = p[k][id];
          if (b) return { contentPackInfo: p, kind: k === 'tiles' ? 'tile' : 'prop', boardObject: b };
        }
        return { cause: 'notFound' };
      },
      createThumbnailElementForBoardObject: async (b) => {
        const d = document.createElement('div');
        d.style.background = '#556';
        d.title = b.name;
        return d;
      },
    },
    slabs: {
      getMaxSlabSizeInBytes: async () => 30720,
      sendSlabToHand: async (s) => {
        window.__sent.push(s);
      },
    },
    system: { clipboard: { setText: async (t) => window.__clip.push(t) } },
    localStorage: {
      global: { getBlob: async () => store.global, setBlob: async (s) => { store.global = s; } },
      campaign: { getBlob: async () => store.campaign, setBlob: async (s) => { store.campaign = s; } },
    },
  };
}
await page.addInitScript(fakeTs, { packs: contentPacks() });

await page.goto('file://' + join(root, 'symbiote/index.html'));
await page.evaluate(() => window.handleStateChange({ kind: 'hasInitialized', payload: {} }));
await page.waitForFunction(() => /assets$/.test(document.getElementById('catalog-status').textContent));
const chip = await page.textContent('#catalog-status');
assert.match(chip, /^\d[\d,]* assets$/);
await page.screenshot({ path: join(outDir, '1-create.png'), fullPage: true });

// settings: save an API key
await page.click('[data-tab="settings"]');
await page.fill('#api-key', 'sk-ant-test');
await page.click('#settings-save');
await page.waitForSelector('#settings-saved:not(.hidden)');
assert.equal(await page.isVisible('#banner'), false, 'the API-key banner clears once a key is saved');
await page.screenshot({ path: join(outDir, '5-settings.png'), fullPage: true });

// generate
await page.click('[data-tab="create"]');
await page.click('.examples button');
await page.click('#generate');
await page.waitForSelector('#result:not(.hidden)', { timeout: 20000 });
assert.equal(apiCalls.length, 1);
assert.equal(apiCalls[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
assert.equal(apiCalls[0].headers['x-api-key'], 'sk-ant-test');
assert.equal(apiCalls[0].body.model, 'claude-opus-5-5');
assert.match(apiCalls[0].body.system[0].text, /Props in this GM's library/);
assert.equal(await page.textContent('#r-title'), 'The Prancing Gryphon');
assert.match(await page.textContent('#r-ai'), /^Generated by Claude Opus 5\.5 · [\d,]+ tokens · \$0\.\d\d$/);
await page.screenshot({ path: join(outDir, '3-result.png'), fullPage: true });

// send to hand -> a valid slab arrives at TS.slabs.sendSlabToHand
await page.click('#r-parts button.primary');
await page.waitForFunction(() => window.__sent.length === 1);
const sent = await page.evaluate(() => window.__sent[0]);
const slab = await decodeSlab(sent);
assert.ok(slab.placements.length > 500, `slab has ${slab.placements.length} placements`);
const ids = new Set(demoCatalog().assets.map((a) => a.id));
assert.ok(slab.placements.every((p) => ids.has(p.assetId)), 'every asset id comes from the loaded catalog');

// kit tab with thumbnails
await page.click('[data-tab="kit"]');
await page.waitForSelector('.kit-list li');
await page.screenshot({ path: join(outDir, '4-kit.png'), fullPage: true });

// plan JSON round trip, no AI
await page.click('[data-tab="result"]');
await page.click('summary:has-text("Plan JSON")');
await page.evaluate(() => {
  const ta = document.getElementById('plan-json');
  const p = JSON.parse(ta.value);
  p.title = 'Edited by hand';
  ta.value = JSON.stringify(p);
});
await page.click('#plan-rebuild');
await page.waitForFunction(() => document.getElementById('r-title').textContent === 'Edited by hand');

// trace tab: synthetic map image, offline labelling
await page.click('[data-tab="trace"]');
await page.setInputFiles('#trace-file', join(root, 'e2e/fixtures/dungeon-map.png'));
await page.waitForSelector('#trace-full:not(.hidden)');
await page.uncheck('#trace-ai');
await page.click('#trace-run');
await page.waitForFunction(() => document.getElementById('r-title').textContent === 'Traced map');
await page.click('[data-tab="trace"]');
await page.screenshot({ path: join(outDir, '2-trace.png'), fullPage: true });

// ---- switch to OpenAI ----
await page.click('[data-tab="settings"]');
await page.selectOption('#provider', 'openai');
assert.equal(await page.textContent('#api-key-label'), 'OpenAI API key');
assert.equal(await page.inputValue('#api-key'), '', 'OpenAI has its own key field');
const options = await page.$$eval('#model option', (os) => os.map((o) => o.textContent));
assert.deepEqual(options, [
  'GPT-6 Astra · best · ~$0.70 per build',
  'GPT-6.1 Sol · balanced · ~$0.14 per build',
  'GPT-6 Luna · cheapest · ~<$0.01 per build',
  'Other model ID…',
]);
await page.selectOption('#effort', 'medium');
assert.match(await page.$eval('#model option', (o) => o.textContent), /~\$0\.52 per build/, 'estimates follow the effort level');
await page.selectOption('#effort', 'high');
await page.fill('#api-key', 'sk-openai-test');
// switching away and back keeps both keys, even before saving
await page.selectOption('#provider', 'anthropic');
assert.equal(await page.inputValue('#api-key'), 'sk-ant-test');
await page.selectOption('#provider', 'openai');
assert.equal(await page.inputValue('#api-key'), 'sk-openai-test');
await page.click('#settings-save');
await page.waitForSelector('#settings-saved:not(.hidden)');
await page.screenshot({ path: join(outDir, '6-settings-openai.png'), fullPage: true });
assert.match(await page.textContent('#model-line'), /^Using GPT-6 Astra \(OpenAI\) · ~\$0\.70 per build/);

await page.click('[data-tab="create"]');
await page.click('#generate');
await page.waitForFunction(() => /GPT-6 Astra/.test(document.getElementById('r-ai').textContent) || !document.getElementById('create-error').classList.contains('hidden'), null, { timeout: 20000 });
const createError = await page.$eval('#create-error', (e) => (e.classList.contains('hidden') ? '' : e.textContent));
assert.equal(createError, '', `generate failed: ${createError}`);
assert.equal(openaiCalls.length, 1);
const oc = openaiCalls[0];
assert.equal(oc.url, 'https://api.openai.com/v1/responses');
assert.equal(oc.headers.authorization, 'Bearer sk-openai-test');
assert.ok(!oc.headers['x-api-key'] && !oc.headers['anthropic-dangerous-direct-browser-access'], 'no Anthropic headers to OpenAI');
assert.equal(oc.body.model, 'gpt-6-astra');
assert.equal(oc.body.text.format.strict, true);
assert.equal(oc.body.store, false);
// 9,500 in x $10 + 11,800 out x $50, per million = $0.685
assert.equal(await page.textContent('#r-ai'), 'Generated by GPT-6 Astra · 21,300 tokens · $0.69');
await page.screenshot({ path: join(outDir, '7-result-openai.png'), fullPage: true });
assert.match(await page.textContent('#model-line'), /~\$0\.69 your average/);
await page.click('[data-tab="settings"]');
assert.match(await page.$eval('#model option', (o) => o.textContent), /^GPT-6 Astra · best · ~\$0\.69 your avg$/);
await page.selectOption('#model', '__custom');
assert.ok(await page.isVisible('#custom-model'));

// A mod's asset pack that TaleSpire can't describe: the rest still load.
const assetCount = Number(chip.replace(/\D/g, ''));
const modPack = { id: 'mod-pack', optionalName: 'Some Mod Pack', tiles: [], props: [], creatures: [], music: [], iconsAtlases: [] };
const page2 = await browser.newPage({ viewport: { width: 460, height: 900 } });
page2.on('pageerror', (e) => errors.push(e.message));
// and a pack whose tiles arrive as an object keyed by id, not an array (what
// broke the first in-game test with "object is not iterable")
const keyedTile = (n) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${n}`, name: `Keyed Floor ${n}`, isDeprecated: false, groupTag: 'Floors', tags: ['floor'],
  colliderBoundsBound: { center: { x: 1, y: 0.25, z: 1 }, width: 2, height: 0.5, depth: 2 },
});
const keyedPack = { id: 'keyed-pack', optionalName: 'Keyed Pack', tiles: Object.fromEntries([1, 2].map((n) => [keyedTile(n).id, keyedTile(n)])), props: {}, creatures: [], music: [], iconsAtlases: [] };
await page2.addInitScript(fakeTs, { packs: [...contentPacks(), modPack, keyedPack], opts: { badPack: 'mod-pack' } });
await page2.goto('file://' + join(root, 'symbiote/index.html'));
await page2.evaluate(() => window.handleStateChange({ kind: 'hasInitialized', payload: {} }));
await page2.waitForFunction(() => /assets$/.test(document.getElementById('catalog-status').textContent));
assert.equal(await page2.textContent('#catalog-status'), `${assetCount + 2} assets`);
assert.match(await page2.getAttribute('#catalog-status', 'title'), /from 2 pack\(s\): TaleSpire, Keyed Pack\nSkipped: Some Mod Pack/);
assert.ok(!(await page2.textContent('#banner')).includes('Could not read'));
await page2.click('[data-tab="kit"]');
await page2.click('details.packs summary');
const packLines = await page2.$$eval('#pack-list li', (els) => els.map((e) => e.textContent));
assert.equal(packLines.length, 2, packLines.join(' | '));
assert.match(packLines[0], /^TaleSpire \(mixed, \d+ sci-fi\): \d+ tiles, \d+ props$/);
assert.match(await page2.textContent('#kit-groups'), /Sci-fi & modern: .*Hull/);
const styleGroups = await page2.$$eval('#style optgroup', (els) => els.map((g) => `${g.label}: ${[...g.children].map((o) => o.value).join(',')}`));
assert.deepEqual(styleGroups, ['Fantasy: medieval,castle,tavern,dungeon,cave,ruins,desert,swamp,winter,wilderness', 'Sci-fi & modern: modern,cyberpunk,scifi']);
assert.match(await page2.textContent('#kit-skipped'), /couldn't describe 1 asset pack\(s\).*Some Mod Pack \(TaleSpire: internalError\)/);
assert.equal(await page2.evaluate(() => window.__moreInfoCalls), 4, 'all packs at once, then one by one');
await page2.click('#pack-diagnostics');
const diag = JSON.parse(await page2.evaluate(() => window.__clip.at(-1)));
assert.equal(diag.assets, assetCount + 2);
assert.deepEqual(diag.skippedPacks, [{ name: 'Some Mod Pack', error: 'TaleSpire: internalError' }]);
assert.equal(diag.shapes.packs.find((x) => x.name === 'Keyed Pack').tiles.type, 'object');
assert.deepEqual(diag.packsWithAssets, ['TaleSpire', 'Keyed Pack']);
assert.equal(diag.boundsScale, 1);
assert.equal(diag.fragments.length, 3);
assert.ok(JSON.stringify(diag).length < 6000, 'diagnostics stay short enough to paste');
await page2.close();

// Packs not readable at start-up: a clear error, then the badge retries.
const page3 = await browser.newPage({ viewport: { width: 460, height: 900 } });
page3.on('pageerror', (e) => errors.push(e.message));
await page3.addInitScript(fakeTs, { packs: contentPacks(), opts: { packsFailUntilOk: true } });
await page3.goto('file://' + join(root, 'symbiote/index.html'));
await page3.evaluate(() => window.handleStateChange({ kind: 'hasInitialized', payload: {} }));
await page3.waitForFunction(() => document.getElementById('catalog-status').textContent === 'assets unavailable', null, { timeout: 10000 });
assert.match(await page3.textContent('#banner'), /Could not read your asset packs: TaleSpire: internalError\nClick "assets unavailable"/);
await page3.screenshot({ path: join(outDir, '8-assets-unavailable.png') });
await page3.evaluate(() => (window.__packsOk = true));
await page3.click('#catalog-status');
await page3.waitForFunction(() => /\d assets$/.test(document.getElementById('catalog-status').textContent));
assert.ok(!(await page3.textContent('#banner')).includes('Could not read'), 'the error clears after a successful retry');
await page3.close();

// Community slabs: the AI plans mod.io searches, TaleForge downloads and reads
// the slabs (a zip, as mod.io stores uploads), the AI places one, the result
// credits its creator.
const cottagePlan = {
  title: 'c', summary: '', width: 10, height: 10, style: 'medieval', ground: 'none', areas: [], paths: [], barriers: [], props: [], scatter: [], notes: '',
  structures: [{ id: 'c', label: 'C', kind: 'cottage', parts: [{ x: 1, y: 1, w: 6, h: 4 }], rooms: [], doors: [{ x: 3, y: 4, side: 's' }], wall: 'wood', floor: 'wood_floor', storeys: 1, roof: 'pitched', windows: 'few', interiorWalls: false, furnish: 'normal' }],
};
const cottageSlab = (await encodeSlab(compilePlan(cottagePlan, new Kit(demoCatalog())).placements)).text;
// Shaped like the real uploads: a ZIP64 zip of README.md and "slabBin", in
// TaleSpire's 0x51ABFACE container (header, gzip slab, 200 more bytes).
const cottageGz = base64ToBytes(cottageSlab);
const slabBin = new Uint8Array(10 + cottageGz.length + 200).fill(7);
new DataView(slabBin.buffer).setUint32(0, 0x51abface, true);
new DataView(slabBin.buffer).setUint16(4, 1, true);
new DataView(slabBin.buffer).setUint32(6, cottageGz.length, true);
slabBin.set(cottageGz, 10);
const cottageZip = Buffer.from(await zip([{ name: 'README.md', data: '![screenshot](thumb)\nA cosy cottage.' }, { name: 'slabBin', data: slabBin }], { zip64: true }));
const lanePlan = {
  title: 'Cottage Lane', summary: 'Two cottages on a lane.', width: 24, height: 16, style: 'medieval', ground: 'grass', areas: [], barriers: [], props: [], scatter: [], notes: '', structures: [],
  paths: [{ label: 'lane', material: 'dirt', width: 2, points: [[0.5, 8], [23.5, 8]] }],
  prefabs: [{ ref: 'modio:1', x: 2, y: 1, rotation: '0' }, { ref: 'modio:1', x: 12, y: 10, rotation: '180' }],
};
const page4 = await browser.newPage({ viewport: { width: 460, height: 900 } });
page4.on('pageerror', (e) => errors.push(e.message));
const modioCalls = [];
const cors = { 'access-control-allow-origin': '*' };
await page4.route('https://api.mod.io/**', async (route) => {
  const u = new URL(route.request().url());
  modioCalls.push(u.pathname + u.search);
  const json = (body) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...cors }, body: JSON.stringify(body) });
  if (u.pathname === '/v1/games') return json({ data: [{ id: 7, name_id: 'talespire', tag_options: [{ name: 'Type', tags: ['Slab', 'Symbiote'] }] }], result_total: 1 });
  // two creators' cottages; _q matches any word, submitted_by filters by creator
  const q = (u.searchParams.get('_q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const by = u.searchParams.get('submitted_by');
  const list = fakeMods.filter((m) => (!q.length || q.some((w) => m.name.toLowerCase().includes(w))) && (!by || String(m.submitted_by.id) === by));
  return json({ data: list, result_total: list.length });
});
const fakeMod = (id, name, uid, username, slug) => ({ id, name, summary: 'A little home', profile_url: `https://mod.io/g/talespire/m/${slug}`, submitted_by: { id: uid, username }, tags: [{ name: 'Slab' }], modfile: { id: id * 10, filename: `${slug}.zip`, download: { binary_url: `https://g-7.modapi.io/v1/games/7/mods/${id}/files/${id * 10}/download` } } });
const fakeMods = [fakeMod(1, 'Cosy Cottage', 51, 'maker1', 'cosy-cottage'), fakeMod(2, 'Cottage Ruin', 52, 'maker2', 'cottage-ruin')];
await page4.route('https://g-7.modapi.io/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/zip', ...cors }, body: cottageZip }));
const aiBodies = [];
await page4.route('https://api.anthropic.com/**', async (route) => {
  const body = JSON.parse(route.request().postData());
  aiBodies.push(body);
  const scout = body.output_config.format && body.output_config.format.schema.properties.searches;
  // compose with whichever slab was offered
  const refs = !scout && body.output_config.format.schema.properties.prefabs.items.properties.ref.enum;
  const reply = scout ? JSON.stringify({ searches: [{ query: 'cottage', words: ['home'], purpose: 'homes' }], style: 'medieval' }) : JSON.stringify({ ...lanePlan, prefabs: lanePlan.prefabs.map((x) => ({ ...x, ref: refs[0] })) });
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', ...cors }, body: sse(reply) });
});
await page4.addInitScript(fakeTs, { packs: contentPacks() });
await page4.goto('file://' + join(root, 'symbiote/index.html'));
await page4.evaluate(() => window.handleStateChange({ kind: 'hasInitialized', payload: {} }));
await page4.waitForFunction(() => /\d assets$/.test(document.getElementById('catalog-status').textContent));
assert.ok(await page4.isDisabled('#use-community'), 'needs a mod.io key first');
await page4.click('[data-tab="settings"]');
await page4.fill('#api-key', 'sk-ant-test');
await page4.fill('#modio-key', 'modio-key-123');
await page4.click('#settings-save');
await page4.click('[data-tab="create"]');
await page4.check('#use-community');
assert.ok(await page4.isVisible('#community-opts'));
assert.ok(await page4.isChecked('#slabs-only'), 'every building from slabs by default');
assert.equal(await page4.inputValue('#slab-creator-mode'), 'one');
assert.ok(!(await page4.isVisible('#slab-creator')));
await page4.fill('#prompt', 'two cottages on a lane');
await page4.click('#generate');
await page4.waitForFunction(() => !document.getElementById('result').classList.contains('hidden') || !document.getElementById('create-error').classList.contains('hidden'), null, { timeout: 20000 });
assert.equal(await page4.$eval('#create-error', (e) => (e.classList.contains('hidden') ? '' : e.textContent)), '');
assert.equal(aiBodies.length, 2, 'one call to plan searches, one to compose');
assert.ok(modioCalls.some((c) => c.startsWith('/v1/games/7/mods?') && c.includes('_q=cottage') && c.includes('tags=Slab') && c.includes('api_key=modio-key-123')), modioCalls.join(' '));
assert.ok(modioCalls.some((c) => c.includes('submitted_by=51')), 'one creator: their catalog is listed');
assert.match(aiBodies[1].messages[0].content.at(-1).text, /modio:1: "Cosy Cottage" by maker1/);
assert.doesNotMatch(aiBodies[1].messages[0].content.at(-1).text, /Cottage Ruin/, 'only the chosen creator\'s slabs are offered');
assert.ok(!aiBodies[1].output_config.format.schema.properties.structures, 'slabs only: no buildings to draw');
assert.equal(await page4.textContent('#r-credits'), 'Cosy Cottage by maker1https://mod.io/g/talespire/m/cosy-cottage');
assert.match(await page4.textContent('#r-community-note'), /Searched mod.io for "cottage": 1 slab\(s\) found, 1 usable, 1 placed\. All slabs by maker1 \(from their 1 slab\)\./);
assert.match(await page4.innerHTML('#r-preview'), /Cosy Cottage/);
await page4.screenshot({ path: join(outDir, '9-community.png'), fullPage: true });
await page4.click('#r-modio-report');
const report = JSON.parse(await page4.evaluate(() => window.__clip.at(-1)));
assert.match(report.usable[0].how, /zip entry "slabBin" \(TaleSpire slab file v1: gzip at bytes 10-\d+ of \d+, 200 bytes after\)/);
assert.equal(report.usable[0].size, '6x4');
assert.equal(report.creator.name, 'maker1');
assert.equal(report.slabsOnly, true);
// rebuild from Plan JSON uses the kept slab without downloading again
const downloadsBefore = modioCalls.length;
await page4.click('details:has(#plan-json) summary');
await page4.click('#plan-rebuild');
await page4.waitForTimeout(300);
assert.match(await page4.innerHTML('#r-preview'), /Cosy Cottage/);
assert.equal(modioCalls.length, downloadsBefore);
// a creator named by the GM; the choice is remembered
await page4.click('[data-tab="create"]');
await page4.selectOption('#slab-creator-mode', 'named');
assert.ok(await page4.isVisible('#slab-creator'));
await page4.fill('#slab-creator', 'MAKER2');
await page4.locator('#community-box').screenshot({ path: join(outDir, '9b-community-options.png') }).catch(() => {});
await page4.screenshot({ path: join(outDir, '9b-community-create.png') });
await page4.dispatchEvent('#slab-creator', 'change');
await page4.click('#generate');
await page4.waitForFunction(() => /maker2/.test(document.getElementById('r-community-note').textContent) || !document.getElementById('create-error').classList.contains('hidden'), null, { timeout: 20000 });
assert.equal(await page4.$eval('#create-error', (e) => (e.classList.contains('hidden') ? '' : e.textContent)), '');
assert.match(aiBodies.at(-1).messages[0].content.at(-1).text, /modio:2: "Cottage Ruin" by maker2/);
assert.doesNotMatch(aiBodies.at(-1).messages[0].content.at(-1).text, /Cosy Cottage/);
assert.equal(await page4.textContent('#r-credits'), 'Cottage Ruin by maker2https://mod.io/g/talespire/m/cottage-ruin');
const saved = await page4.evaluate(() => window.TS.localStorage.global.getBlob());
assert.match(saved, /"creatorMode":"named"/, 'creator settings are saved');
assert.match(saved, /"creatorName":"MAKER2"/);
await page4.close();

assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
await browser.close();
writeFileSync(join(outDir, 'last-slab.txt'), sent);
console.log(`symbiote e2e passed: ${slab.placements.length} placements sent to hand; screenshots in ${outDir}`);
