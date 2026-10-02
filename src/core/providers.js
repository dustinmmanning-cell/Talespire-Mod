// AI providers and models TaleForge can use, with prices for cost estimates.
//
// Prices are US dollars per million tokens on each provider's standard tier,
// as of PRICES_AS_OF. Sources: Anthropic's published API pricing, and for
// OpenAI the model list in the official openai-node SDK cross-checked against
// LiteLLM's model price table. Prices change; the real cost of every build is
// computed from the usage the API reports, and the Symbiote shows that too.

export const PRICES_AS_OF = '2026-10-02';

export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyHint: 'sk-ant-…',
    keySite: 'console.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'best', price: { input: 4, cachedInput: 0.2, output: 20 } },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'faster', price: { input: 2, cachedInput: 0.2, output: 10 } },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'most capable', price: { input: 10, cachedInput: 0.25, output: 50 } },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'cheapest', price: { input: 1, cachedInput: 0.1, output: 5 }, noReasoning: true },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (GPT)',
    keyHint: 'sk-…',
    keySite: 'platform.openai.com',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-6-astra',
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'best', price: { input: 10, cachedInput: 1, output: 50 } },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'balanced', price: { input: 2, cachedInput: 0.1, output: 10 } },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'cheapest', price: { input: 0.1, cachedInput: 0.01, output: 0.5 } },
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function providerOf(modelId) {
  if (/^claude-/i.test(modelId || '')) return 'anthropic';
  if (/^(gpt-|o\d|chatgpt-)/i.test(modelId || '')) return 'openai';
  return null;
}

// Exact id, or a dated snapshot of a listed model ("gpt-6-astra-2026-09-03").
export function findModel(modelId) {
  for (const id of [modelId, baseModelId(modelId)]) {
    for (const p of Object.values(PROVIDERS)) {
      const m = p.models.find((x) => x.id === id);
      if (m) return { ...m, provider: p.id };
    }
  }
  return null;
}

// Usage as each API reports it -> one shape:
//   { inputTokens (uncached), cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens }
// Anthropic reports cache reads/writes separately from input_tokens; OpenAI
// includes cached tokens in input_tokens and reasoning tokens in output_tokens.
export function normalizeUsage(provider, raw = {}) {
  if (provider === 'openai') {
    const inDet = raw.input_tokens_details || {};
    const outDet = raw.output_tokens_details || {};
    const cached = inDet.cached_tokens || 0;
    const writes = inDet.cache_write_tokens || 0;
    return {
      inputTokens: Math.max(0, (raw.input_tokens || 0) - cached - writes),
      cachedInputTokens: cached,
      cacheWriteTokens: writes,
      outputTokens: raw.output_tokens || 0,
      reasoningTokens: outDet.reasoning_tokens || 0,
    };
  }
  return {
    inputTokens: raw.input_tokens || 0,
    cachedInputTokens: raw.cache_read_input_tokens || 0,
    cacheWriteTokens: raw.cache_creation_input_tokens || 0,
    outputTokens: raw.output_tokens || 0,
    reasoningTokens: 0,
  };
}

// Dollars for a normalized usage on a model, or null when the price is unknown.
export function costOf(modelId, usage) {
  const m = findModel(modelId);
  if (!m || !usage) return null;
  const p = m.price;
  return (
    (usage.inputTokens * p.input +
      usage.cachedInputTokens * p.cachedInput +
      usage.cacheWriteTokens * p.input * 1.25 +
      usage.outputTokens * p.output) /
    1e6
  );
}

// "gpt-6-astra-2026-09-03" -> "gpt-6-astra" for dated snapshots.
function baseModelId(id) {
  return String(id || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

// What a typical single-building generation uses at 'high' effort: the system
// prompt with the GM's prop list in, the plan (plus reasoning) out. A guess,
// replaced by the user's own measured average once they have built with a model.
export const TYPICAL_BUILD = { inputTokens: 10000, outputTokens: 12000 };
const EFFORT_SCALE = { low: 0.45, medium: 0.7, high: 1, xhigh: 1.5, max: 2 };

export function estimateBuildCost(modelId, { effort = 'high' } = {}) {
  const m = findModel(modelId);
  if (!m) return null;
  const scale = m.noReasoning ? 0.6 : EFFORT_SCALE[effort] || 1;
  return costOf(modelId, {
    inputTokens: TYPICAL_BUILD.inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: Math.round(TYPICAL_BUILD.outputTokens * scale),
    reasoningTokens: 0,
  });
}

export function formatCost(dollars) {
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return '?';
  if (dollars < 0.01) return '<$0.01';
  if (dollars < 10) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(0)}`;
}

// Label for a model picker, e.g. "GPT-6 Astra · best · ~$0.70 per build".
// stats: { n, total } measured from the user's own builds, if any.
export function modelOptionLabel(model, { effort = 'high', stats = null } = {}) {
  const est = stats && stats.n > 0 ? stats.total / stats.n : estimateBuildCost(model.id, { effort });
  const basis = stats && stats.n > 0 ? 'your avg' : 'per build';
  return `${model.label} · ${model.note} · ~${formatCost(est)} ${basis}`;
}
