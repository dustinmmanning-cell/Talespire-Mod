// Provider-neutral plumbing shared by the AI clients: an error type, a
// Server-Sent Events reader, and small helpers. fetch + ReadableStream only,
// so it runs in Node >= 18 and in a Symbiote's Chromium alike.

export class ApiError extends Error {
  constructor(message, { status = 0, type = 'error', retryable = false, details = null, provider = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.details = details;
    this.provider = provider;
  }
}

export function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse an SSE byte stream into { event, data } objects.
export async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

// Structured outputs guarantee JSON; this is only a belt-and-braces parse.
export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new ApiError('The model did not return JSON', { type: 'parse_error' });
  }
}
