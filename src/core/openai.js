// Minimal OpenAI Responses API client over fetch + Server-Sent Events.
//
// Same contract as callClaude: send a system prompt, user content (text and
// images) and a JSON schema; get back the model's JSON text, the model that
// answered, and its usage. Raw HTTP for the same reason as the Claude client:
// it must run inside a Symbiote with no npm or bundler.
//
// Request shape (from the official openai-node SDK types):
//   POST /v1/responses
//   { model, instructions, input: [{ role, content: [input_text | input_image] }],
//     text: { format: { type: 'json_schema', name, strict: true, schema } },
//     reasoning: { effort }, max_output_tokens, stream: true, store: false }
// Streamed events used: response.created, response.output_text.delta,
// response.reasoning_*.delta, response.refusal.delta, response.completed,
// response.incomplete, response.failed, error.

import { ApiError, sleep, readSse } from './http.js';

export const OPENAI_DEFAULT_MODEL = 'gpt-6-astra';

// If a model rejects an effort level, step down one and retry once.
const LOWER_EFFORT = { max: 'xhigh', xhigh: 'high', high: 'medium', medium: 'low', low: null };

// Anthropic-style content blocks (what the planner builds) -> Responses input.
export function toResponsesInput(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).map((b) =>
      b.type === 'image'
        ? { type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}`, detail: 'high' }
        : { type: 'input_text', text: b.text },
    ),
  }));
}

// Collect a streamed response. Returns { text, refusal, model, usage, status, incompleteReason, error }.
export async function collectOpenAIStream(body, onProgress) {
  let text = '';
  let refusal = '';
  let model = null;
  let usage = {};
  let status = null;
  let incompleteReason = null;
  let error = null;
  let lastTick = 0;
  const tick = (ev, every = 250) => {
    const now = Date.now();
    if (onProgress && now - lastTick > every) {
      lastTick = now;
      onProgress(ev);
    }
  };
  for await (const { data } of readSse(body)) {
    if (data === '[DONE]') break;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      continue;
    }
    switch (msg.type) {
      case 'response.created':
      case 'response.in_progress':
        if (msg.response && msg.response.model) model = msg.response.model;
        break;
      case 'response.output_text.delta':
        text += msg.delta || '';
        tick({ phase: 'writing', textChars: text.length });
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        tick({ phase: 'thinking' }, 500);
        break;
      case 'response.output_item.added':
        if (msg.item && msg.item.type === 'reasoning') tick({ phase: 'thinking' }, 0);
        break;
      case 'response.refusal.delta':
        refusal += msg.delta || '';
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const r = msg.response || {};
        model = r.model || model;
        usage = r.usage || usage;
        status = r.status || msg.type.slice('response.'.length);
        if (r.incomplete_details) incompleteReason = r.incomplete_details.reason || null;
        if (r.error) error = r.error;
        break;
      }
      case 'error':
        error = { code: msg.code, message: msg.message, param: msg.param };
        break;
      default:
        break;
    }
  }
  return { text, refusal, model, usage, status, incompleteReason, error };
}

//   apiKey, baseUrl, model, system, messages, schema, schemaName, effort,
//   maxTokens, onProgress, signal, fetchImpl, retries
export async function callOpenAI({
  apiKey, baseUrl = 'https://api.openai.com', model = OPENAI_DEFAULT_MODEL, system, messages, schema, schemaName = 'build_plan',
  effort = 'high', maxTokens = 64000, onProgress, signal, fetchImpl, retries = 2,
}) {
  if (!apiKey) throw new ApiError('No OpenAI API key configured', { type: 'authentication_error', provider: 'openai' });
  const doFetch = fetchImpl || globalThis.fetch;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  const body = {
    model,
    instructions: system,
    input: toResponsesInput(messages),
    stream: true,
    // Don't keep TaleForge prompts on OpenAI's servers for later retrieval.
    store: false,
    max_output_tokens: maxTokens,
    ...(schema ? { text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } } } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
  };

  let attempt = 0;
  let effortRetried = false;
  for (;;) {
    attempt++;
    if (onProgress) onProgress({ phase: attempt === 1 ? 'connecting' : 'retrying', attempt });
    let res;
    try {
      res = await doFetch(`${baseUrl.replace(/\/$/, '')}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal && signal.aborted) throw new ApiError('Cancelled', { type: 'cancelled', provider: 'openai' });
      if (attempt <= retries) {
        await sleep(1500 * attempt);
        continue;
      }
      throw new ApiError(`Network error talking to the OpenAI API: ${e.message}`, { type: 'network_error', provider: 'openai' });
    }
    if (!res.ok) {
      let err = {};
      try {
        err = (await res.json()).error || {};
      } catch {
        // not JSON
      }
      const code = err.code || err.type || `http_${res.status}`;
      const message = err.message || `HTTP ${res.status}`;
      // A model that doesn't take this effort level: step down once.
      if (res.status === 400 && !effortRetried && body.reasoning && (err.param === 'reasoning.effort' || /reasoning\.effort/.test(message))) {
        const lower = LOWER_EFFORT[body.reasoning.effort];
        effortRetried = true;
        if (lower) body.reasoning = { effort: lower };
        else delete body.reasoning;
        attempt--;
        continue;
      }
      const outOfBudget = code === 'insufficient_quota';
      const retryable = !outOfBudget && (res.status === 429 || res.status >= 500);
      if (retryable && attempt <= retries) {
        const after = Number(res.headers.get && res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * attempt);
        continue;
      }
      throw new ApiError(friendlyOpenAIError(res.status, code, message), { status: res.status, type: code, retryable, provider: 'openai' });
    }
    const out = await collectOpenAIStream(res.body, onProgress);
    if (out.error) {
      const retryable = ['server_error', 'rate_limit_exceeded'].includes(out.error.code);
      if (retryable && attempt <= retries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new ApiError(`OpenAI API error (${out.error.code || 'error'}): ${out.error.message || 'the response failed'}`, { type: out.error.code || 'error', provider: 'openai' });
    }
    if (out.refusal && !out.text) {
      throw new ApiError(`The model declined this request: ${out.refusal}`, { type: 'refusal', provider: 'openai' });
    }
    if (out.incompleteReason === 'max_output_tokens') {
      throw new ApiError('The plan was too long to finish. Ask for a smaller area or fewer details.', { type: 'max_tokens', provider: 'openai' });
    }
    if (out.incompleteReason === 'content_filter') {
      throw new ApiError('The model declined this request. Try rewording the description.', { type: 'refusal', provider: 'openai' });
    }
    if (!out.text) throw new ApiError('The model returned no plan text.', { type: 'empty_response', provider: 'openai' });
    return { text: out.text, stopReason: 'end_turn', model: out.model || model, usage: out.usage };
  }
}

function friendlyOpenAIError(status, code, message) {
  if (code === 'insufficient_quota') return 'Your OpenAI account is out of credit or over its budget limit. Check billing at platform.openai.com.';
  if (status === 401) return 'The OpenAI API key was rejected. Check it in Settings.';
  if (status === 403) return `Your OpenAI key is not allowed to do this: ${message}`;
  if (status === 404) return `This model isn't available to your OpenAI key: ${message}`;
  if (status === 413) return 'The request is too large (image too big?).';
  if (status === 429) return 'Rate limited by the OpenAI API. Wait a minute and try again.';
  if (status >= 500) return 'The OpenAI API had a server error. Try again shortly.';
  return `OpenAI API error (${code}): ${message}`;
}
