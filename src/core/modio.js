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
// sniffs: a zip, gzip, base64 slab text, a raw slab binary, JSON holding one,
// or slab data inside TaleSpire's own slab file ("slabBin", magic 0x51ABFACE).
// describeSlabFile() reports what it found, for bug reports.

import { ApiError, sleep } from './http.js';
import { isZip, unzip } from './zip.js';
import { decodeSlab, decodeSlabBinary, encodeSlab, gzipBytes, gunzipBytes, bytesToBase64, cleanSlabText } from './slab.js';
import { inflateRaw, gunzipAt, zlibAt, lz4BlockAt, lz4FrameAt, isGzipAt, isZlibAt, isLz4FrameAt } from './inflate.js';

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


const IMAGE_SIGS = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46]];
const looksUtf16 = (b) => b.length >= 16 && [1, 3, 5, 7, 9, 11, 13, 15].every((i) => b[i] === 0) && b[0] !== 0;

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
  if (IMAGE_SIGS.some((sig) => startsWith(bytes, sig))) return null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const raw = await gunzipBytes(bytes);
      if (startsWith(raw, SLAB_MAGIC_LE)) return { text: bytesToBase64(bytes), how: 'gzip slab binary' };
      const inner = await slabFromBytes(raw, name, depth + 1);
      if (inner) return { ...inner, how: `gzip (${inner.how})` };
    } catch {
      // not a plain gzip file; the binary search below may still find one
    }
  }
  if (startsWith(bytes, SLAB_MAGIC_LE)) {
    try {
      decodeSlabBinary(bytes);
      return { text: bytesToBase64(await gzipBytes(bytes)), how: 'raw slab binary' };
    } catch {
      // fall through
    }
  }
  if (bytes.length < 8 * 1024 * 1024) {
    const text = new TextDecoder(looksUtf16(bytes) ? 'utf-16le' : 'utf-8', { fatal: false }).decode(bytes);
    const t = await slabFromText(text);
    if (t) return { text: t, how: /^\s*[[{]/.test(text) ? 'JSON' : 'slab text' };
  }
  return (await slabFromBinary(bytes, depth)).slab;
}

function score(name) {
  const n = name.toLowerCase();
  if (/slab/.test(n)) return 3;
  if (/\.(txt|json|bin|slab)$/.test(n)) return 2;
  if (/\.(png|jpe?g|webp|gif)$/.test(n)) return -1;
  return 0;
}

// ---- slab data inside a larger binary ---------------------------------------
//
// The slab browser uploads each slab as a zip holding README.md and "slabBin".
// slabBin is TaleSpire's own, undocumented container:
//
//   u32  magic    0x51ABFACE  (bytes ce fa ab 51)
//   u16  version  1
//   u32? length   of the slab data that follows (the file is almost always
//                 this + 210 bytes)
//
// Rather than trust a guess at the rest, this decodes the ranges the header
// points at with every likely codec, then scans the file for gzip, zlib, LZ4
// and raw slab signatures, and keeps whatever decodes to a valid v2 slab.
// Several slab parts in one file are merged.

export const SLAB_FILE_MAGIC = 0x51abface;
const SLAB_PREFIX = new Uint8Array(SLAB_MAGIC_LE);
const LIMITS = { maxOut: 4 * 1024 * 1024 };
const hex = (b, n = b.length) => Array.from(b.subarray(0, n)).map((v) => v.toString(16).padStart(2, '0')).join(' ');

const DECODERS = {
  gzip: (b, s) => gunzipAt(b, s, LIMITS),
  zlib: (b, s) => zlibAt(b, s, LIMITS),
  deflate: (b, s, len, expect) => inflateRaw(len ? b.subarray(0, s + len) : b, s, { ...LIMITS, expect }),
  lz4: (b, s, len) => lz4BlockAt(b, s, len, LIMITS),
  lz4frame: (b, s) => lz4FrameAt(b, s, LIMITS),
  raw: (b, s) => {
    const r = decodeSlabBinary(b.subarray(s));
    let used = b.length - s - r.trailingBytes;
    if (r.trailingBytes >= 2 && !b[s + used] && !b[s + used + 1]) used += 2;
    return { data: b.subarray(s, s + used), end: s + used };
  },
};

// The header fields, if this is a TaleSpire slab file.
export function slabFileHeader(bytes) {
  if (bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SLAB_FILE_MAGIC) return null;
  return { version: view.getUint16(4, true), length: view.getUint32(6, true), length16: view.getUint16(6, true) };
}

function candidates(bytes) {
  const list = [];
  const seen = new Set();
  const add = (kind, start, len = 0, blind = false) => {
    const key = `${kind}@${start}/${len}`;
    if (start < 0 || start >= bytes.length || seen.has(key)) return;
    seen.add(key);
    list.push({ kind, start, len, blind });
  };
  const sniff = (start, len) => {
    if (isGzipAt(bytes, start)) add('gzip', start);
    else if (isZlibAt(bytes, start)) add('zlib', start);
    else if (startsWith(bytes.subarray(start), SLAB_MAGIC_LE)) add('raw', start);
    else if (isLz4FrameAt(bytes, start)) add('lz4frame', start);
    else {
      add('deflate', start, len);
      if (len) add('lz4', start, len);
    }
  };
  const h = slabFileHeader(bytes);
  if (h) {
    for (const [start, len] of [[10, h.length], [8, h.length16], [bytes.length - h.length, h.length], [14, h.length]]) {
      if (len > 0 && start + len <= bytes.length) sniff(start, len);
    }
  }
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (isGzipAt(bytes, i)) add('gzip', i);
    else if (isLz4FrameAt(bytes, i)) add('lz4frame', i);
    else if (bytes[i] === 0xce && startsWith(bytes.subarray(i), SLAB_MAGIC_LE)) add('raw', i);
    else if (i < 512 && isZlibAt(bytes, i)) add('zlib', i);
  }
  for (let i = 0; i <= Math.min(64, bytes.length - 1); i++) add('deflate', i, 0, true);
  return list;
}

// What decoded bytes hold: a v2 slab binary, or anything slabFromBytes reads.
async function slabFromDecoded(data, depth) {
  if (startsWith(data, SLAB_MAGIC_LE)) {
    try {
      return { placements: decodeSlabBinary(data).placements };
    } catch (e) {
      return { error: e.message };
    }
  }
  const r = await slabFromBytes(data, '', depth + 1);
  return r ? { placements: (await decodeSlab(r.text)).placements, how: r.how } : { error: 'not a slab' };
}

// -> { parts: [{ kind, start, end, placements }], attempts: [string] }
export async function extractSlabs(bytes, depth = 0) {
  const parts = [];
  const attempts = [];
  for (const c of candidates(bytes)) {
    if (parts.some((p) => c.start >= p.start && c.start < p.end)) continue;
    let res;
    try {
      res = DECODERS[c.kind](bytes, c.start, c.len, c.blind ? SLAB_PREFIX : null);
    } catch (e) {
      if (!c.blind) attempts.push(`${c.kind} at ${c.start}${c.len ? ` (${c.len} bytes)` : ''}: ${e.message}`);
      continue;
    }
    const s = await slabFromDecoded(res.data, depth);
    if (s.placements) parts.push({ kind: s.how ? `${c.kind}, then ${s.how}` : c.kind, start: c.start, end: res.end, placements: s.placements });
    else attempts.push(`${c.kind} at ${c.start}: ${res.data.length} bytes starting ${hex(res.data, 8)}, ${s.error}`);
  }
  return { parts, attempts };
}

// -> { slab: { text, how } | null, attempts }
export async function slabFromBinary(bytes, depth = 0) {
  const { parts, attempts } = await extractSlabs(bytes, depth);
  if (!parts.length) return { slab: null, attempts };
  const seen = new Set();
  const placements = [];
  for (const p of parts) {
    for (const q of p.placements) {
      const key = `${q.assetId}|${q.x}|${q.y}|${q.z}|${q.rot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      placements.push(q);
    }
  }
  const { text } = await encodeSlab(placements, { maxBytes: 0 });
  const h = slabFileHeader(bytes);
  const what = h ? `TaleSpire slab file v${h.version}` : 'binary';
  const where = parts.map((p) => `${p.kind} at bytes ${p.start}-${p.end}`).join(', ');
  const after = bytes.length - parts[parts.length - 1].end;
  const merged = parts.length > 1 ? `; ${parts.length} parts merged` : '';
  return { slab: { text, how: `${what}: ${where} of ${bytes.length}${after ? `, ${after} bytes after` : ''}${merged}` }, attempts };
}

// A short look inside a binary nothing could read, for bug reports.
async function probeBinary(bytes) {
  const out = { head: hex(bytes, 48), tail: hex(bytes.subarray(Math.max(0, bytes.length - 24))) };
  const h = slabFileHeader(bytes);
  if (h) {
    out.header = h;
    // where the trailer would start if the header's length is right
    if (10 + h.length < bytes.length) out.afterData = hex(bytes.subarray(10 + h.length), 48);
  }
  const sigs = [];
  for (let i = 0; i + 4 <= bytes.length && sigs.length < 12; i++) {
    if (isGzipAt(bytes, i)) sigs.push(`gzip@${i}`);
    else if (isLz4FrameAt(bytes, i)) sigs.push(`lz4@${i}`);
    else if (startsWith(bytes.subarray(i), SLAB_MAGIC_LE)) sigs.push(`slab@${i}`);
    else if (i < 512 && isZlibAt(bytes, i)) sigs.push(`zlib?@${i}`);
  }
  out.signatures = sigs;
  out.attempts = (await extractSlabs(bytes, 1)).attempts.slice(0, 10);
  const strings = new TextDecoder('latin1').decode(bytes).match(/[A-Za-z0-9 _.,:;'"()\/-]{8,}/g) || [];
  out.strings = strings.slice(0, 8).map((s) => s.slice(0, 48));
  return out;
}

// What a downloaded file looks like, without its contents (for diagnostics).
export async function describeSlabFile(bytes, name = '') {
  const out = { filename: name, size: bytes.length, head: hex(bytes, 8) };
  if (isZip(bytes)) {
    try {
      const files = await unzip(bytes);
      out.entries = await Promise.all(files.slice(0, 20).map(async (f) => {
        const slab = (await slabFromBytes(f.data, f.name, 1)) ? 'yes' : 'no';
        const e = { name: f.name, size: f.data.length, head: hex(f.data, 8), slab };
        if (slab === 'no' && !/\.(md|txt|png|jpe?g|webp|gif)$/i.test(f.name)) e.probe = await probeBinary(f.data);
        return e;
      }));
      out.summary = `zip of ${files.length} file(s): ${files.map((f) => f.name).slice(0, 5).join(', ')}`;
    } catch (e) {
      out.summary = `zip that could not be read: ${e.message}`;
    }
  } else {
    out.summary = `${bytes.length} bytes starting ${out.head}`;
    if (!(await slabFromBytes(bytes, name, 1))) out.probe = await probeBinary(bytes);
  }
  return out;
}
