import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callOpenAI, toResponsesInput } from '../src/core/openai.js';
import { callModel } from '../src/core/ai.js';
import { ApiError } from '../src/core/http.js';
import { generatePlan, labelTrace, traceSchema } from '../src/core/planner.js';
import { PLAN_SCHEMA, planSchema } from '../src/core/plan.js';
import { demoCatalog } from '../src/core/demo-catalog.js';
import {
  PROVIDERS, providerOf, findModel, normalizeUsage, costOf, estimateBuildCost, formatCost, modelOptionLabel,
} from '../src/core/providers.js';

const tavern = readFileSync(new URL('../examples/plans/tavern.json', import.meta.url), 'utf8');

// Responses API stream, event shapes as in the openai-node SDK types.
function responsesStream(text, { model = 'gpt-6-astra-2026-09-03', usage, refusal = null, incomplete = null, errorEvent = null } = {}) {
  let seq = 0;
  const ev = [
    { type: 'response.created', response: { id: 'resp_1', model, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  ];
  if (errorEvent) ev.push({ type: 'error', ...errorEvent });
  if (refusal) ev.push({ type: 'response.refusal.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: refusal });
  for (let i = 0; i < text.length; i += 64) {
    ev.push({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(i, i + 64), logprobs: [] });
  }
  const response = {
    id: 'resp_1', model, status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: incomplete } : null,
    usage: usage || { input_tokens: 9000, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 0 }, output_tokens: 15000, output_tokens_details: { reasoning_tokens: 6000 }, total_tokens: 24000 },
  };
  ev.push({ type: incomplete ? 'response.incomplete' : 'response.completed', response });
  const body = ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: seq++ })}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 53) c.enqueue(bytes.slice(i, i + 53));
      c.close();
    },
  });
}

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r.status) return { ok: false, status: r.status, headers: new Map([['retry-after', '0']]), json: async () => r.body };
    return { ok: true, status: 200, headers: new Map(), body: r.stream };
  };
}

test('OpenAI request: Responses API, bearer auth, strict JSON schema, reasoning effort, not stored', async () => {
  const calls = [];
  const res = await generatePlan({
    provider: 'openai', apiKey: 'sk-test', prompt: 'a tavern', size: [24, 20],
    image: { mediaType: 'image/jpeg', data: 'QUJD' }, imageMode: 'layout',
    fetchImpl: fakeFetch([{ stream: responsesStream(tavern) }], calls),
  });
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  assert.ok(!init.headers['x-api-key'], 'no Anthropic headers to OpenAI');
  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'build_plan', strict: true, schema: PLAN_SCHEMA });
  assert.match(body.instructions, /You are TaleForge/);
  assert.deepEqual(body.input[0].content[0], { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'high' });
  assert.equal(body.input[0].content[1].type, 'input_text');
  assert.ok(!('fallbacks' in body) && !('thinking' in body) && !('output_config' in body));

  assert.equal(res.provider, 'openai');
  assert.equal(res.plan.title, 'The Prancing Gryphon');
  assert.equal(res.model, 'gpt-6-astra-2026-09-03');
  assert.deepEqual(res.usage, { inputTokens: 7000, cachedInputTokens: 2000, cacheWriteTokens: 0, outputTokens: 15000, reasoningTokens: 6000 });
  // dated snapshot priced as gpt-6-astra: 7000 x $10 + 2000 x $1 + 15000 x $50, per million
  assert.ok(Math.abs(res.cost - 0.822) < 1e-9, `cost ${res.cost}`);
});

test('a model that rejects an effort level is retried one step lower', async () => {
  const calls = [];
  const out = await callOpenAI({
    apiKey: 'k', system: 's', messages: [{ role: 'user', content: 'x' }], effort: 'xhigh',
    fetchImpl: fakeFetch([
      { status: 400, body: { error: { message: "Unsupported value: 'xhigh' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' } } },
      { stream: responsesStream('{"ok":true}') },
    ], calls),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.reasoning.effort, 'xhigh');
  assert.equal(calls[1].body.reasoning.effort, 'high');
  assert.equal(out.text, '{"ok":true}');
});

test('out of budget is reported, not retried; rate limits are retried', async () => {
  const calls = [];
  await assert.rejects(
    callOpenAI({ apiKey: 'k', system: 's', messages: [], fetchImpl: fakeFetch([{ status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } }], calls) }),
    (e) => e instanceof ApiError && /out of credit or over its budget/.test(e.message) && e.provider === 'openai',
  );
  assert.equal(calls.length, 1);
  const calls2 = [];
  const out = await callOpenAI({ apiKey: 'k', system: 's', messages: [], fetchImpl: fakeFetch([{ status: 429, body: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } }, { stream: responsesStream('{}') }], calls2) });
  assert.equal(calls2.length, 2);
  assert.equal(out.text, '{}');
});

test('bad key, refusal, truncation and stream errors become clear messages', async () => {
  const one = (r) => callOpenAI({ apiKey: 'k', system: 's', messages: [], retries: 0, fetchImpl: fakeFetch([r], []) });
  await assert.rejects(one({ status: 401, body: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } } }), /OpenAI API key was rejected/);
  await assert.rejects(one({ stream: responsesStream('', { refusal: "I can't help with that." }) }), (e) => e.type === 'refusal');
  await assert.rejects(one({ stream: responsesStream('{"partial":', { incomplete: 'max_output_tokens' }) }), (e) => e.type === 'max_tokens');
  await assert.rejects(one({ stream: responsesStream('', { errorEvent: { code: 'server_error', message: 'boom', param: null } }) }), /OpenAI API error \(server_error\)/);
  await assert.rejects(callOpenAI({ system: 's', messages: [] }), /No OpenAI API key/);
});

test('trace labelling works through OpenAI too', async () => {
  const trace = { gridW: 4, gridH: 2, rows: ['0011', '0011'], clusters: [{ index: 0, char: '0', hex: '#111111', share: 0.5 }, { index: 1, char: '1', hex: '#999999', share: 0.5 }] };
  const reply = { title: 't', summary: 's', notes: 'n', style: 'dungeon', gridColumns: 0, gridRows: 0, clusters: [{ index: 0, meaning: 'wall', material: 'none', wall: 'none', label: 'rock' }, { index: 1, meaning: 'floor', material: 'stone_floor', wall: 'stone', label: 'floor' }], props: [] };
  const calls = [];
  const res = await labelTrace({ provider: 'openai', model: 'gpt-6-luna', apiKey: 'k', trace, fetchImpl: fakeFetch([{ stream: responsesStream(JSON.stringify(reply), { model: 'gpt-6-luna' }) }], calls) });
  assert.equal(calls[0].body.text.format.name, 'trace_labels');
  assert.equal(calls[0].body.reasoning.effort, 'medium');
  assert.deepEqual(res.labels.map((l) => l.meaning), ['wall', 'floor']);
  assert.equal(res.provider, 'openai');
  assert.ok(res.cost > 0 && res.cost < 0.01);
});

test('callModel infers the provider from the model id', async () => {
  const calls = [];
  const out = await callModel({ model: 'gpt-6.1-sol', apiKey: 'k', system: 's', messages: [], fetchImpl: fakeFetch([{ stream: responsesStream('{}', { model: 'gpt-6.1-sol' }) }], calls) });
  assert.equal(out.provider, 'openai');
  assert.match(calls[0].url, /api\.openai\.com\/v1\/responses$/);
});

test('content blocks convert to Responses input', () => {
  assert.deepEqual(toResponsesInput([{ role: 'user', content: 'hi' }]), [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
});

test('provider registry, usage normalization, cost and labels', () => {
  assert.equal(providerOf('claude-opus-5-5'), 'anthropic');
  assert.equal(providerOf('gpt-6-astra'), 'openai');
  assert.equal(providerOf('mystery-model'), null);
  for (const p of Object.values(PROVIDERS)) {
    assert.ok(p.models.some((m) => m.id === p.defaultModel), `${p.id} default model is listed`);
    for (const m of p.models) assert.ok(m.price.input > 0 && m.price.output > 0 && m.price.cachedInput > 0, m.id);
  }
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 }),
    { inputTokens: 100, cachedInputTokens: 900, cacheWriteTokens: 10, outputTokens: 50, reasoningTokens: 0 });
  assert.equal(costOf('claude-opus-5-5', { inputTokens: 1e6, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1e6 }), 24);
  assert.equal(costOf('unknown-model', { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }), null);
  // estimates scale with effort and model price
  assert.ok(estimateBuildCost('gpt-6-astra', { effort: 'xhigh' }) > estimateBuildCost('gpt-6-astra', { effort: 'medium' }));
  assert.ok(estimateBuildCost('gpt-6-luna') < estimateBuildCost('gpt-6.1-sol'));
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0.284), '$0.28');
  assert.equal(formatCost(null), '?');
  assert.equal(findModel('gpt-6-astra-2026-09-03').id, 'gpt-6-astra', 'dated snapshots resolve to the listed model');
  const astra = findModel('gpt-6-astra');
  assert.equal(modelOptionLabel(astra), 'GPT-6 Astra · best · ~$0.70 per build');
  assert.equal(modelOptionLabel(astra, { stats: { n: 4, total: 1.6 } }), 'GPT-6 Astra · best · ~$0.40 your avg');
});

// OpenAI strict mode rejects these keywords (list from the openai-node SDK's
// strict-schema transform) and requires closed objects with every property
// required. Also stay well inside OpenAI's documented size limits.
const OPENAI_UNSUPPORTED = ['$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveAnchor', '$recursiveRef', 'allOf', 'contains',
  'contentEncoding', 'contentMediaType', 'contentSchema', 'dependentRequired', 'dependentSchemas', 'dependencies', 'else', 'if',
  'maxContains', 'maxProperties', 'minContains', 'minProperties', 'not', 'oneOf', 'patternProperties', 'prefixItems',
  'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties', 'uniqueItems'];

for (const [name, schema] of [['plan', PLAN_SCHEMA], ['plan with library kits', planSchema(demoCatalog().buildingKits())], ['trace', traceSchema()]]) {
  test(`${name} schema is valid for OpenAI strict structured outputs`, () => {
    let enumValues = 0;
    let properties = 0;
    let depth = 0;
    const walk = (s, path, d) => {
      depth = Math.max(depth, d);
      for (const k of OPENAI_UNSUPPORTED) assert.ok(!(k in s), `${k} at ${path}`);
      if (s.enum) enumValues += s.enum.length;
      if (s.type === 'object') {
        assert.equal(s.additionalProperties, false, path);
        assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), path);
        properties += Object.keys(s.properties).length;
        for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`, d + 1);
      }
      if (s.type === 'array') walk(s.items, `${path}[]`, d + 1);
    };
    assert.equal(schema.type, 'object', 'root must be an object');
    walk(schema, name, 0);
    assert.ok(enumValues <= 1000, `${enumValues} enum values`);
    assert.ok(properties <= 5000, `${properties} properties`);
    assert.ok(depth <= 10, `nesting depth ${depth}`);
  });
}
