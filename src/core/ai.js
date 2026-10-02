// One entry point for every AI call, whichever provider the user picked.

import { callClaude } from './claude.js';
import { callOpenAI } from './openai.js';
import { ApiError } from './http.js';
import { PROVIDERS, providerOf, normalizeUsage, costOf } from './providers.js';

// opts: { provider?, model?, apiKey, baseUrl?, system, messages, schema,
//         schemaName?, effort?, onProgress?, signal?, fetchImpl?, fallbacks? }
// -> { text, provider, model, usage (normalized), usageRaw, cost (USD or null) }
export async function callModel(opts) {
  const provider = opts.provider || providerOf(opts.model) || 'anthropic';
  const info = PROVIDERS[provider];
  if (!info) throw new ApiError(`Unknown AI provider "${provider}"`, { type: 'config_error' });
  const model = opts.model || info.defaultModel;
  const call = provider === 'openai' ? callOpenAI : callClaude;
  const out = await call({ ...opts, model, baseUrl: opts.baseUrl || info.baseUrl });
  const served = out.model || model;
  const usage = normalizeUsage(provider, out.usage);
  return { text: out.text, provider, model: served, requestedModel: model, usage, usageRaw: out.usage, cost: costOf(served, usage), schemaMode: out.schemaMode || null };
}
