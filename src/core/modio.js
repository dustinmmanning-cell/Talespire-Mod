// mod.io client for TaleSpire's official slab repository.
//
// Since late 2023 TaleSpire's in-game slab browser searches and publishes
// slabs on mod.io. This reads that repository with the GM's own read-only
// mod.io API key (mod.io > Account > API access), as the mod.io API terms
// require. Shapes are from the mod.io REST API v1 (cross-checked against the
// open-source modio-rs client):
//   GET /games?name_id=talespire                 -> { data: [game] }, game.tag_options
//   GET /games/{id}/mods?_q=&tags=&_sort=&_limit= -> { data: [mod], result_total }
//   mod.modfile.download.binary_url              -> the uploaded file (a zip)
// Errors are { error: { code, error_ref, message } }; 429 carries Retry-After.
//
// What a TaleSpire slab file contains is not documented, so slabFromBytes()
// sniffs: a zip, gzip, base64 slab text, a raw slab binary, or JSON holding
// one. describeSlabFile() reports what it found, for bug reports.

import { ApiError, sleep } from './http.js';
import { isZip, unzip } from './zip.js';
import { decodeSlab, gzipBytes, gunzipBytes, bytesToBase64, cleanSlabText } from './slab.js';

export const MODIO_BASE = 'https://api.mod.io/v1';
export const TALESPIRE_NAME_ID = 'talespire';
const SLAB_MAGIC_LE = [0xce, 0xfa, 0xce, 0xd1];

export class ModioClient {
  constructor({ apiKey, baseUrl = MODIO_BASE, fetchImpl, retries = 2, wait = sleep } = {}) {
    if (!apiKey) throw new ApiError('No mod.io API key configured. Add one in Settings (mod.io > Account > API access).', { type: 'authentication_error', provider: 'modio' });
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.retries = retries;
    this.wait = wait;
    this._game = null;
  }

  // Through a TaleForge proxy (any base URL other than mod.io's own), file
  // downloads go through it too.
  get proxied() {
    return !/^https:\/\/(api\.mod\.io|g-\d+\.modapi\.io)\//.test(`${this.baseUrl}/`);
  }

  async request(path, params = {}, { signal } = {}) {
    const q = new URLSearchParams({ ...params, api_key: this.apiKey });
    const url = `${this.baseUrl}${path}?${q}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, { headers: { accept: 'application/json' }, signal });
      } catch (e) {
        if (signal && signal.aborted) throw new ApiError('Cancelled', { type: 'cancelled', provider: 'modio' });
        throw new ApiError(`Could not reach mod.io (${e.message}). If the TaleSpire panel blocks it, run the TaleForge proxy and set the mod.io base URL to it.`, { type: 'network_error', provider: 'modio' });
      }
      if (res.ok) return res.json();
      let body = {};
      try {
        body = await res.json();
      } catch {
        // not JSON
      }
      const err = body.error || {};
      if (res.status === 429 && attempt < this.retries) {
        const after = Number(res.headers.get && res.headers.get('retry-after'));
        await this.wait(Math.min(30, Number.isFinite(after) && after > 0 ? after : 5 * (attempt + 1)) * 1000);
        continue;
      }
      throw new ApiError(friendlyModioError(res.status, err), { status: res.status, type: `modio_${err.error_ref || res.status}`, provider: 'modio', details: err });
    }
  }

  async game(opts) {
    if (!this._game) {
      const list = await this.request('/games', { name_id: TALESPIRE_NAME_ID }, opts);
      const g = (list.data || [])[0];
      if (!g) throw new ApiError('TaleSpire was not found on mod.io.', { type: 'not_found', provider: 'modio' });
      this._game = g;
    }
    return this._game;
  }

  // The tag TaleSpire puts on slabs ("Slab"), from the game's tag options.
  async slabTag(opts) {
    const g = await this.game(opts);
    const all = (g.tag_options || []).flatMap((o) => (o.tags || []).map((t) => ({ group: o.name, tag: t })));
    return all.find((t) => /^slabs?$/i.test(t.tag)) || all.find((t) => /slab/i.test(t.tag)) || null;
  }

  // -> { total, items: [summary] }
  async searchSlabs(query, { limit = 8, offset = 0, sort = '-popular', signal } = {}) {
    const g = await this.game({ signal });
    const tag = await this.slabTag({ signal });
    const params = { _limit: String(limit), _offset: String(offset), _sort: sort };
    if (query) params._q = query;
    if (tag) params.tags = tag.tag;
    const res = await this.request(`/games/${g.id}/mods`, params, { signal });
    return { total: res.result_total ?? (res.data || []).length, items: (res.data || []).map(summarizeMod), tag: tag ? tag.tag : null };
  }

  async getMod(id, opts) {
    const g = await this.game(opts);
    return summarizeMod(await this.request(`/games/${g.id}/mods/${id}`, {}, opts));
  }

  async downloadFile(item, { signal } = {}) {
    const url = item.file && item.file.url;
    if (!url) throw new ApiError(`"${item.name}" has no file to download.`, { type: 'no_file', provider: 'modio' });
    const target = this.proxied ? `${this.baseUrl.replace(/\/v1$/, '')}/download?url=${encodeURIComponent(url)}` : url;
    let res;
    try {
      res = await this.fetch(target, { signal });
    } catch (e) {
      throw new ApiError(`Could not download "${item.name}" from mod.io (${e.message}).`, { type: 'network_error', provider: 'modio' });
    }
    if (!res.ok) throw new ApiError(`Downloading "${item.name}" failed: HTTP ${res.status}.`, { status: res.status, type: 'download_error', provider: 'modio' });
    return new Uint8Array(await res.arrayBuffer());
  }

  // -> { text, how, item } where text is slab text TaleSpire can paste.
  async fetchSlab(item, opts) {
    for (const [blob, how] of [[item.metadataBlob, 'mod metadata'], [item.file && item.file.metadataBlob, 'file metadata']]) {
      const text = blob && (await slabFromText(blob));
      if (text) return { text, how, item };
    }
    const bytes = await this.downloadFile(item, opts);
    const found = await slabFromBytes(bytes, item.file && item.file.filename);
    if (!found) {
      const d = await describeSlabFile(bytes, item.file && item.file.filename);
      throw new ApiError(`No slab found in "${item.name}" (${d.summary}).`, { type: 'no_slab', provider: 'modio', details: d });
    }
    return { ...found, item };
  }
}

function friendlyModioError(status, err) {
  if (status === 401) return 'The mod.io API key was rejected. Check it in Settings.';
  if (status === 403) return `mod.io refused the request: ${err.message || 'forbidden'}`;
  if (status === 404) return `Not found on mod.io: ${err.message || ''}`.trim();
  if (status === 429) return 'mod.io rate limit reached. Wait a minute and try again.';
  return `mod.io error ${status}${err.message ? `: ${err.message}` : ''}`;
}

// mod.io returns names and summaries HTML-escaped ("Shop &amp; BlackSmith").
export function unescapeHtml(s) {
  return String(s || '').replace(/&(amp|lt|gt|quot|apos|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" }[name.toLowerCase()] || m;
  });
}

// The parts of a mod.io mod object TaleForge uses.
export function summarizeMod(m) {
  const kvp = {};
  for (const e of m.metadata_kvp || []) if (e && e.metakey) kvp[e.metakey] = e.metavalue;
  const f = m.modfile && m.modfile.id ? m.modfile : null;
  return {
    ref: `modio:${m.id}`,
    id: m.id,
    name: unescapeHtml(m.name) || `mod ${m.id}`,
    summary: unescapeHtml(m.summary),
    url: m.profile_url || '',
    creator: unescapeHtml(m.submitted_by && m.submitted_by.username),
    creatorUrl: (m.submitted_by && m.submitted_by.profile_url) || '',
    thumb: (m.logo && (m.logo.thumb_320x180 || m.logo.original)) || '',
    tags: (m.tags || []).map((t) => unescapeHtml(t.name)).filter(Boolean),
    kvp,
    metadataBlob: m.metadata_blob || '',
    stats: m.stats ? { downloads: m.stats.downloads_total || 0, subscribers: m.stats.subscribers_total || 0, rating: m.stats.ratings_display_text || '' } : null,
    file: f ? { id: f.id, filename: f.filename || '', size: f.filesize || 0, url: (f.download && f.download.binary_url) || '', metadataBlob: f.metadata_blob || '' } : null,
  };
}

// ---- finding the slab in whatever was uploaded ------------------------------

const startsWith = (b, sig) => sig.every((v, i) => b[i] === v);

// Slab text (base64 of gzip) if `text` is or contains one that decodes.
export async function slabFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const tries = [cleanSlabText(text)];
  const embedded = text.match(/H4sI[A-Za-z0-9+/=\s]{20,}/);
  if (embedded) tries.push(cleanSlabText(embedded[0]));
  if (/^\s*[[{]/.test(text)) {
    try {
      const strings = [];
      const walk = (v) => {
        if (typeof v === 'string') strings.push(v);
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
      };
      walk(JSON.parse(text));
      tries.push(...strings.filter((s) => s.length > 20).map(cleanSlabText));
    } catch {
      // not JSON
    }
  }
  for (const t of tries) {
    if (!/^[A-Za-z0-9+/]+=*$/.test(t)) continue;
    try {
      await decodeSlab(t);
      return t;
    } catch {
      // not a slab
    }
  }
  return null;
}

// -> { text, how } or null
export async function slabFromBytes(bytes, name = '', depth = 0) {
  if (!bytes || !bytes.length || depth > 3) return null;
  if (isZip(bytes)) {
    let files;
    try {
      files = await unzip(bytes);
    } catch {
      return null;
    }
    // likely slab files first
    files.sort((a, b) => score(b.name) - score(a.name));
    for (const f of files) {
      const r = await slabFromBytes(f.data, f.name, depth + 1);
      if (r) return { ...r, how: `zip entry "${f.name}" (${r.how})` };
    }
    return null;
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const raw = await gunzipBytes(bytes);
      if (startsWith(raw, SLAB_MAGIC_LE)) return { text: bytesToBase64(bytes), how: 'gzip slab binary' };
      const inner = await slabFromBytes(raw, name, depth + 1);
      if (inner) return { ...inner, how: `gzip (${inner.how})` };
    } catch {
      // not gzip after all
    }
    return null;
  }
  if (startsWith(bytes, SLAB_MAGIC_LE)) return { text: bytesToBase64(await gzipBytes(bytes)), how: 'raw slab binary' };
  if (bytes.length < 8 * 1024 * 1024) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const t = await slabFromText(text);
    if (t) return { text: t, how: /^\s*[[{]/.test(text) ? 'JSON' : 'slab text' };
  }
  return null;
}

function score(name) {
  const n = name.toLowerCase();
  if (/slab/.test(n)) return 3;
  if (/\.(txt|json|bin|slab)$/.test(n)) return 2;
  if (/\.(png|jpe?g|webp|gif)$/.test(n)) return -1;
  return 0;
}

// What a downloaded file looks like, without its contents (for diagnostics).
export async function describeSlabFile(bytes, name = '') {
  const head = Array.from(bytes.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const out = { filename: name, size: bytes.length, head };
  if (isZip(bytes)) {
    try {
      const files = await unzip(bytes);
      out.entries = await Promise.all(files.slice(0, 20).map(async (f) => ({
        name: f.name,
        size: f.data.length,
        head: Array.from(f.data.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' '),
        slab: (await slabFromBytes(f.data, f.name, 1)) ? 'yes' : 'no',
      })));
      out.summary = `zip of ${files.length} file(s): ${files.map((f) => f.name).slice(0, 5).join(', ')}`;
    } catch (e) {
      out.summary = `zip that could not be read: ${e.message}`;
    }
  } else {
    out.summary = `${bytes.length} bytes starting ${head}`;
  }
  return out;
}
