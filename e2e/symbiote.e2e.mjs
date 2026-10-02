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
import { decodeSlab } from '../src/core/slab.js';

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
    icon: { atlasIndex: 0, region: { x: 0, y: 0, width: 0, height: 0 } },
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

await page.addInitScript((packs) => {
  const store = { global: '', campaign: '' };
  window.__sent = [];
  window.__clip = [];
  window.TS = {
    debug: { log: async () => {} },
    contentPacks: {
      getContentPacks: async () => packs.map((p) => ({ id: p.id, optionalName: p.optionalName })),
      getMoreInfo: async () => packs,
      findBoardObjectInPacks: async (id) => {
        for (const p of packs) for (const k of ['tiles', 'props']) {
          const b = p[k].find((x) => x.id === id);
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
}, contentPacks());

await page.goto('file://' + join(root, 'symbiote/index.html'));
await page.evaluate(() => window.handleStateChange({ kind: 'hasInitialized', payload: {} }));
await page.waitForFunction(() => document.getElementById('catalog-status').textContent.includes('assets'));
const chip = await page.textContent('#catalog-status');
assert.match(chip, /assets/);
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

assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
await browser.close();
writeFileSync(join(outDir, 'last-slab.txt'), sent);
console.log(`symbiote e2e passed: ${slab.placements.length} placements sent to hand; screenshots in ${outDir}`);
