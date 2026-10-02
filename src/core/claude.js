// Minimal Claude Messages API client over fetch + Server-Sent Events.
//
// Why raw HTTP and not @anthropic-ai/sdk: the same file runs inside a TaleSpire
// Symbiote, which is a Chromium web view loading plain local scripts -- no npm,
// no bundler, no module resolution. fetch + ReadableStream work identically
// there and in Node >= 18.
//
// Requests stream (plans can be tens of thousands of tokens) and use
// structured outputs (output_config.format) so the response is always JSON
// matching the schema. Server-side fallbacks are on by default: if the model
// declines a request, the API retries it on its recommended fallback model.

import { ApiError, isBrowser, sleep, readSse } from './http.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const API_VERSION = '2023-06-01';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Kept as a name for callers that predate OpenAI support; same class as ApiError.
export const ClaudeError = ApiError;

// Collect a streamed message. Returns { text, stopReason, stopDetails, model, usage }.
// onProgress({ phase, outputTokens, textChars }) is called as tokens arrive.
export async function collectStream(body, onProgress) {
  let text = '';
  let stopReason = null;
  let stopDetails = null;
  let model = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const blocks = new Map();
  let lastTick = 0;
  for await (const { event, data } of readSse(body)) {
    if (event === 'ping') continue;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      continue;
    }
    switch (msg.type) {
      case 'message_start':
        model = msg.message && msg.message.model;
        Object.assign(usage, (msg.message && msg.message.usage) || {});
        break;
      case 'content_block_start':
        blocks.set(msg.index, msg.content_block && msg.content_block.type);
        // A fallback block marks a switch to the fallback model mid-stream:
        // whatever the declining model wrote so far is discarded.
        if (msg.content_block && msg.content_block.type === 'fallback') {
          text = '';
          if (msg.content_block.to && msg.content_block.to.model) model = msg.content_block.to.model;
          if (onProgress) onProgress({ phase: 'fallback', model });
        }
        break;
      case 'content_block_delta':
        if (msg.delta && msg.delta.type === 'text_delta') {
          text += msg.delta.text;
          const now = Date.now();
          if (onProgress && now - lastTick > 250) {
            lastTick = now;
            onProgress({ phase: 'writing', textChars: text.length, outputTokens: usage.output_tokens });
          }
        } else if (msg.delta && msg.delta.type === 'thinking_delta' && onProgress) {
          const now = Date.now();
          if (now - lastTick > 500) {
            lastTick = now;
            onProgress({ phase: 'thinking' });
          }
        }
        break;
      case 'message_delta':
        if (msg.delta) {
          stopReason = msg.delta.stop_reason ?? stopReason;
          stopDetails = msg.delta.stop_details ?? stopDetails;
        }
        if (msg.usage) Object.assign(usage, msg.usage);
        break;
      case 'error':
        throw new ClaudeError((msg.error && msg.error.message) || 'stream error', {
          type: (msg.error && msg.error.type) || 'error',
          retryable: msg.error && ['overloaded_error', 'api_error'].includes(msg.error.type),
        });
      default:
        break;
    }
  }
  return { text, stopReason, stopDetails, model, usage };
}

// One streamed Messages API call with retries on transient errors.
//   apiKey, baseUrl, model, system (string), messages, schema (JSON schema for
//   structured output), effort ('low'..'max'), maxTokens, fallbacks (bool),
//   onProgress, signal, fetchImpl (for tests)
export async function callClaude({
  apiKey, baseUrl = 'https://api.anthropic.com', model = DEFAULT_MODEL, system, messages, schema,
  effort = 'high', maxTokens = 64000, fallbacks = true, onProgress, signal, fetchImpl, retries = 2, extraHeaders = {},
}) {
  if (!apiKey) throw new ClaudeError('No Anthropic API key configured', { type: 'authentication_error' });
  const doFetch = fetchImpl || globalThis.fetch;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    ...extraHeaders,
  };
  // Haiku 4.5 takes neither adaptive thinking nor effort, and has no fallbacks.
  const lite = /haiku/i.test(model);
  if (fallbacks && !lite) headers['anthropic-beta'] = FALLBACK_BETA;
  // Required for CORS when calling the API straight from a web page (the
  // Symbiote). The key is the user's own and never leaves their machine
  // except to api.anthropic.com.
  if (isBrowser()) headers['anthropic-dangerous-direct-browser-access'] = 'true';

  const body = {
    model,
    max_tokens: lite ? Math.min(maxTokens, 64000) : maxTokens,
    stream: true,
    output_config: { ...(lite ? {} : { effort }), ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (!lite) body.thinking = { type: 'adaptive' };
  if (fallbacks && !lite) body.fallbacks = 'default';

  let attempt = 0;
  for (;;) {
    attempt++;
    if (onProgress) onProgress({ phase: attempt === 1 ? 'connecting' : 'retrying', attempt });
    let res;
    try {
      res = await doFetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal && signal.aborted) throw new ClaudeError('Cancelled', { type: 'cancelled' });
      if (attempt <= retries) {
        await sleep(1500 * attempt);
        continue;
      }
      throw new ClaudeError(`Network error talking to the Claude API: ${e.message}`, { type: 'network_error' });
    }
    if (!res.ok) {
      let err = {};
      try {
        err = await res.json();
      } catch {
        // not JSON
      }
      const type = (err.error && err.error.type) || `http_${res.status}`;
      const message = (err.error && err.error.message) || `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      if (retryable && attempt <= retries) {
        const after = Number(res.headers.get && res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * attempt);
        continue;
      }
      throw new ClaudeError(friendlyError(res.status, type, message), { status: res.status, type, retryable, provider: 'anthropic' });
    }
    try {
      const out = await collectStream(res.body, onProgress);
      if (out.stopReason === 'refusal') {
        throw new ClaudeError('Claude declined this request. Try rewording the description.', { type: 'refusal', details: out.stopDetails });
      }
      if (out.stopReason === 'max_tokens') {
        throw new ClaudeError('The plan was too long to finish. Ask for a smaller area or fewer details.', { type: 'max_tokens' });
      }
      return out;
    } catch (e) {
      if (e instanceof ClaudeError && e.retryable && attempt <= retries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw e;
    }
  }
}

function friendlyError(status, type, message) {
  if (status === 401) return 'The Anthropic API key was rejected. Check it in Settings.';
  if (status === 403) return `The API key is not allowed to do this: ${message}`;
  if (status === 404) return `Model or endpoint not found: ${message}`;
  if (status === 413) return 'The request is too large (image too big?).';
  if (status === 429) return 'Rate limited by the Claude API. Wait a minute and try again.';
  if (status === 529) return 'The Claude API is overloaded right now. Try again shortly.';
  return `Claude API error (${type}): ${message}`;
}
