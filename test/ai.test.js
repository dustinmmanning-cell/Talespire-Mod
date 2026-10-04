import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callClaude, collectStream, ClaudeError, FALLBACK_BETA } from '../src/core/claude.js';
import { generatePlan, buildUserContent, systemPrompt, labelTrace, remapTraceLabels } from '../src/core/planner.js';
import { traceImage, heuristicLabels, traceToPlan, autoGridSize } from '../src/core/trace.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { normalizePlan, PLAN_SCHEMA } from '../src/core/plan.js';
import { compilePlan } from '../src/core/compile.js';
import { Kit } from '../src/core/kit.js';
import { demoCatalog } from '../src/core/demo-catalog.js';

const tavern = JSON.parse(readFileSync(new URL('../examples/plans/tavern.json', import.meta.url), 'utf8'));

function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  // deliver in awkward chunk sizes to exercise the parser
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37));
      c.close();
    },
  });
}

function messageEvents(jsonText, { stop = 'end_turn', model = 'claude-opus-5-5', fallbackAt = -1 } = {}) {
  const ev = [{ type: 'message_start', message: { model, usage: { input_tokens: 1200, output_tokens: 1 } } }];
  ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } });
  ev.push({ type: 'content_block_stop', index: 0 });
  if (fallbackAt >= 0) {
    ev.push({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    ev.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"partial": tru' } });
    ev.push({ type: 'content_block_stop', index: 1 });
    ev.push({ type: 'content_block_start', index: 2, content_block: { type: 'fallback', from: { model }, to: { model: 'claude-opus-4-8' } } });
    ev.push({ type: 'content_block_stop', index: 2 });
  }
  ev.push({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < jsonText.length; i += 50) ev.push({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: jsonText.slice(i, i + 50) } });
  ev.push({ type: 'content_block_stop', index: 3 });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 4321 } });
  ev.push({ type: 'message_stop' });
  return ev;
}

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r.status && r.status !== 200) {
      return { ok: false, status: r.status, headers: new Map([['retry-after', '0']]), json: async () => r.body };
    }
    return { ok: true, status: 200, headers: new Map(), body: sse(r.events) };
  };
}

test('request shape: model, streaming, structured output, adaptive thinking, fallbacks, cached system prompt', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([{ events: messageEvents(JSON.stringify(tavern)) }], calls);
  const res = await generatePlan({ apiKey: 'sk-test', prompt: 'a tavern', size: [24, 20], style: 'medieval', fetchImpl });
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-test');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-beta'], FALLBACK_BETA);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.ok(!('temperature' in body), 'sampling parameters are rejected by current models');
  assert.match(body.messages[0].content.at(-1).text, /about 24 x 20 tiles/);
  assert.equal(res.plan.title, 'The Prancing Gryphon');
  assert.equal(res.provider, 'anthropic');
  assert.equal(res.usage.outputTokens, 4321);
  // Opus 5.5: 1200 in x $4/M + 4321 out x $20/M
  assert.ok(Math.abs(res.cost - (1200 * 4 + 4321 * 20) / 1e6) < 1e-9);
});

// What the first Anthropic call in TaleSpire hit: "The compiled grammar is too
// large, which would cause performance issues."
const GRAMMAR_ERROR = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.' } } };
const enumCount = (schema) => (JSON.stringify(schema).match(/"enum":\[[^\]]*\]/g) || []).reduce((n, e) => n + e.split(',').length, 0);

test('anthropic: long enums are sent as described strings; the plan still normalizes', async () => {
  const calls = [];
  const res = await generatePlan({ apiKey: 'k', prompt: 'a tavern', fetchImpl: fakeFetch([{ events: messageEvents(JSON.stringify(tavern)) }], calls) });
  const sent = calls[0].body.output_config.format.schema;
  assert.ok(enumCount(sent) < 60, `enum values sent: ${enumCount(sent)} (full schema: ${enumCount(PLAN_SCHEMA)})`);
  const role = sent.properties.props.items.properties.role;
  assert.equal(role.type, 'string');
  assert.ok(!role.enum);
  assert.match(role.description, /One of: tree, conifer, .*instrument, .*other$/);
  assert.deepEqual(sent.properties.structures.items.properties.roof.enum, ['pitched', 'flat', 'none'], 'short enums stay');
  assert.equal(res.schemaMode, 'compact');
  // free-text near misses map onto the allowed values
  const loose = normalizePlan({ ...tavern, ground: 'Cobble Stone', props: [{ role: 'Barrels', asset: '', x: 2, y: 2, rotation: 0 }, { role: 'wine-rack', asset: '', x: 3, y: 3, rotation: 0 }] }).plan;
  assert.deepEqual(loose.props.map((p) => p.role), ['barrel', 'other']);
});

test('anthropic: a grammar-too-large error steps down to no enums, then to no schema', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([GRAMMAR_ERROR, GRAMMAR_ERROR, { events: messageEvents(JSON.stringify(tavern)) }], calls);
  const res = await generatePlan({ apiKey: 'k', prompt: 'a tavern', fetchImpl });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.output_config.format && enumCount(calls[0].body.output_config.format.schema) > 0);
  assert.equal(enumCount(calls[1].body.output_config.format.schema), 0);
  assert.ok(!calls[2].body.output_config.format, 'last resort: no structured output');
  assert.equal(calls[2].body.output_config.effort, 'high');
  assert.match(calls[2].body.system[0].text, /Reply with one JSON object and nothing else[\s\S]*"structures"/);
  assert.equal(res.plan.title, 'The Prancing Gryphon');
  assert.equal(res.schemaMode, 'none');
});

test('anthropic: other 400 errors are not retried with a smaller schema', async () => {
  const calls = [];
  const bad = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } } };
  await assert.rejects(generatePlan({ apiKey: 'k', prompt: 'x', fetchImpl: fakeFetch([bad], calls) }), /max_tokens: too large/);
  assert.equal(calls.length, 1);
});

test('haiku requests omit thinking, effort and fallbacks', async () => {
  const calls = [];
  await callClaude({ apiKey: 'k', model: 'claude-haiku-4-5', system: 's', messages: [{ role: 'user', content: 'x' }], fetchImpl: fakeFetch([{ events: messageEvents('{}') }], calls) });
  const { body, init } = calls[0];
  assert.ok(!body.thinking);
  assert.ok(!body.fallbacks);
  assert.ok(!('effort' in body.output_config));
  assert.ok(!init.headers['anthropic-beta']);
});

test('text written before a mid-stream fallback is discarded', async () => {
  const body = sse(messageEvents('{"ok":1}', { fallbackAt: 1 }));
  const out = await collectStream(body);
  assert.equal(out.text, '{"ok":1}');
  assert.equal(out.model, 'claude-opus-4-8');
});

test('refusal and max_tokens stops become clear errors', async () => {
  for (const [stop, type] of [['refusal', 'refusal'], ['max_tokens', 'max_tokens']]) {
    const fetchImpl = fakeFetch([{ events: messageEvents('{}', { stop }) }], []);
    await assert.rejects(callClaude({ apiKey: 'k', system: 's', messages: [], fetchImpl }), (e) => e instanceof ClaudeError && e.type === type);
  }
});

test('overloaded responses are retried, auth errors are not', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([{ status: 529, body: { error: { type: 'overloaded_error', message: 'busy' } } }, { events: messageEvents('{"a":1}') }], calls);
  const out = await callClaude({ apiKey: 'k', system: 's', messages: [], fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(out.text, '{"a":1}');
  const bad = fakeFetch([{ status: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }], []);
  await assert.rejects(callClaude({ apiKey: 'k', system: 's', messages: [], fetchImpl: bad }), /API key was rejected/);
});

test('missing API key fails before any request', async () => {
  await assert.rejects(callClaude({ system: 's', messages: [] }), /No Anthropic API key/);
});

test('user content: image first, then instructions; refine sends the current plan', () => {
  const content = buildUserContent({ prompt: 'a ruined abbey', image: { mediaType: 'image/png', data: 'AAAA' }, imageMode: 'layout' });
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.match(content[1].text, /Reproduce its layout faithfully/);
  const refine = buildUserContent({ prompt: 'add a stable', previousPlan: normalizePlan(tavern).plan });
  assert.match(refine[0].text, /current plan/);
  assert.match(refine[0].text, /Change request: add a stable/);
  assert.ok(!refine[0].text.includes('"version"'));
});

test('the system prompt lists the GM\'s real prop names when a catalog is loaded', () => {
  const cat = demoCatalog();
  cat.meta.synthetic = false;
  const s = systemPrompt(cat);
  assert.match(s, /Props in this GM's library/);
  assert.match(s, /Barrel, Wine/);
  assert.ok(!s.includes('Tree, Festive'), 'off-theme assets are not offered');
  assert.ok(!systemPrompt(demoCatalog()).includes("GM's library"), 'synthetic catalogs are not advertised');
});

async function syntheticMap() {
  const cell = 16;
  const W = 20;
  const H = 12;
  const w = W * cell;
  const h = H * cell;
  const data = new Uint8Array(w * h * 4);
  const fill = (x0, y0, x1, y1, rgb) => {
    for (let y = y0 * cell; y < y1 * cell; y++) for (let x = x0 * cell; x < x1 * cell; x++) data.set([...rgb, 255], (y * w + x) * 4);
  };
  fill(0, 0, W, H, [18, 18, 20]);
  fill(1, 1, 8, 8, [150, 145, 140]);
  fill(8, 3, 12, 5, [150, 145, 140]);
  fill(12, 1, 19, 11, [150, 145, 140]);
  fill(14, 4, 16, 6, [40, 90, 200]);
  return { width: w, height: h, data, png: await encodePng({ width: w, height: h, data }) };
}

test('PNG encode/decode round trip', async () => {
  const m = await syntheticMap();
  const back = await decodePng(m.png);
  assert.equal(back.width, m.width);
  assert.equal(back.height, m.height);
  assert.deepEqual(back.data, m.data);
});

test('trace: image -> grid -> labelled raster -> walled rooms', async () => {
  const m = await syntheticMap();
  assert.deepEqual(autoGridSize(m.width, m.height, 20), [20, 12]);
  const trace = traceImage(m, { gridW: 20, gridH: 12, colors: 6 });
  assert.equal(trace.clusters.length, 3, 'rock, floor, water');
  const labels = heuristicLabels(trace);
  const meanings = Object.fromEntries(labels.map((l) => [trace.clusters[l.index].hex, l.meaning]));
  assert.deepEqual(Object.values(meanings).sort(), ['floor', 'wall', 'water']);
  const { plan } = normalizePlan(traceToPlan(trace, labels, { title: 'Test' }));
  const r = compilePlan(plan, new Kit(demoCatalog(), { style: plan.style }));
  assert.equal(r.grid.structures.length, 1, 'all connected floor is one structure');
  const s = r.grid.structures[0];
  assert.equal(s.cells.length, 7 * 7 + 4 * 2 + 7 * 10 - 4, 'floor cells (the pool is not floor)');
  // walls along the outer outline but none around the pool inside the big room
  const poolEdges = r.grid.edges.filter((e) => e.x >= 13 && e.x <= 16 && e.y >= 3 && e.y <= 6 &&
    ((e.side === 'e' && e.x === 13) || (e.side === 'w' && e.x === 16) || (e.side === 's' && e.y === 3) || (e.side === 'n' && e.y === 6)));
  assert.equal(poolEdges.length, 0);
});

test('trace labelling with Claude and re-trace at the counted grid size', async () => {
  const m = await syntheticMap();
  const trace = traceImage(m, { gridW: 10, gridH: 6, colors: 6 });
  const reply = {
    title: 'Flooded vault', summary: 's', notes: 'n', style: 'dungeon', gridColumns: 20, gridRows: 12,
    clusters: trace.clusters.map((c) => ({ index: c.index, meaning: c.lab[0] < 25 ? 'wall' : c.lab[2] < -20 ? 'water' : 'floor', material: 'stone_floor', wall: 'stone', label: 'x' })),
    props: [{ role: 'statue', asset: '', x: 5, y: 3, rotation: 0 }],
  };
  const calls = [];
  const res = await labelTrace({ apiKey: 'k', trace, image: { mediaType: 'image/png', data: 'AA' }, fetchImpl: fakeFetch([{ events: messageEvents(JSON.stringify(reply)) }], calls) });
  assert.deepEqual(res.grid, [20, 12]);
  assert.equal(calls[0].body.output_config.effort, 'medium');
  assert.match(calls[0].body.messages[0].content[1].text, /Cluster map/);
  const again = traceImage(m, { gridW: 20, gridH: 12, colors: 6 });
  const moved = remapTraceLabels(trace, again, res.labels, res.extras.props);
  assert.deepEqual(moved.props[0], { role: 'statue', asset: '', x: 10, y: 6, rotation: 0 });
  assert.equal(moved.labels.length, again.clusters.length);
});
