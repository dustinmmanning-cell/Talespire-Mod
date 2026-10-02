// TaleForge Symbiote UI. Uses window.TaleForge (taleforge.js, bundled from
// src/core) and the TaleSpire Symbiote API (TS.*) when running in the game.
// Outside TaleSpire (a normal browser) it falls back to a synthetic demo
// catalog and the clipboard, which is handy for development.
'use strict';

const TF = window.TaleForge;

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: TF.DEFAULT_MODEL,
  effort: 'high',
  baseUrl: '',
  facing: 0,
  overrides: {},
};

const EXAMPLES = [
  ['Roadside tavern', 'A two-storey roadside tavern with a common room, kitchen and storeroom, a stable yard and a well, beside a cobbled road.', 'building', 'medieval'],
  ['Goblin cave', 'A goblin warren in a hillside cave: a guarded entrance tunnel, a smoky common cavern with a fire pit, a chieftain\'s chamber with a crude throne, and a flooded storage pit.', 'compound', 'cave'],
  ['Walled village', 'A small walled village on a river bend: a chapel, a smithy, an inn and a handful of cottages around a market square, with fields outside the east gate.', 'village', 'medieval'],
  ['Wizard tower', 'A three-storey wizard\'s tower in a clearing: a library and study on the ground floor, a garden with standing stones around it.', 'building', 'castle'],
  ['Haunted crypt', 'A haunted family crypt: an entry hall with statues, narrow corridors, a burial chamber full of coffins, and a sealed treasury behind a secret door.', 'compound', 'dungeon'],
];

const TRACE_MEANINGS = ['ground', 'road', 'floor', 'wall', 'void', 'water', 'forest', 'building', 'door', 'rubble'];

const state = {
  booted: false,
  inTS: false,
  settings: { ...DEFAULT_SETTINGS },
  catalog: null,
  packInfos: null,
  maxSlabBytes: TF.MAX_SLAB_BYTES,
  build: null,
  plan: null,
  seed: 1,
  abort: null,
  image: null,
  traceImage: null,
  trace: null,
  traceLabels: null,
  traceExtras: null,
  history: [],
};

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on);

// ---------------------------------------------------------------------------
// TaleSpire bridge

function ts() {
  return typeof TS !== 'undefined' ? TS : null;
}

const CAUSES = {
  notInBoard: 'Open a board first.',
  clientIsNotInGmMode: 'Switch to GM mode first: only a GM can place slabs.',
  invalidSlabString: 'TaleSpire rejected the slab data.',
  dataOversized: 'This part is larger than TaleSpire allows for one slab.',
  spawnFailed: 'TaleSpire could not put the slab in your hand.',
  rateLimited: 'TaleSpire is rate limiting this Symbiote; wait a moment.',
};

// TS calls report failure either by rejecting or by resolving to { cause }.
async function tsCall(fn) {
  let r;
  try {
    r = await fn();
  } catch (e) {
    const cause = (e && (e.cause || (e.payload && e.payload.cause))) || null;
    throw new Error(CAUSES[cause] || (cause ? `TaleSpire: ${cause}` : e && e.message ? e.message : String(e)));
  }
  if (r && typeof r === 'object' && r.cause !== undefined) throw new Error(CAUSES[r.cause] || `TaleSpire: ${r.cause}`);
  return r;
}

function debug(msg) {
  if (ts() && TS.debug && TS.debug.log) TS.debug.log(String(msg)).catch(() => {});
  else console.log(msg);
}

// Called by TaleSpire (see manifest.json subscriptions). Must be global.
function handleStateChange(event) {
  if (event && event.kind === 'hasInitialized') boot(true);
}

function handleContentPackChange() {
  if (state.booted && state.inTS) loadCatalog();
}
window.handleStateChange = handleStateChange;
window.handleContentPackChange = handleContentPackChange;

// ---------------------------------------------------------------------------
// storage

async function loadBlob(scope) {
  if (state.inTS) {
    try {
      const s = await tsCall(() => TS.localStorage[scope].getBlob());
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }
  try {
    const s = localStorage.getItem(`taleforge:${scope}`);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

async function saveBlob(scope, value) {
  const s = JSON.stringify(value);
  if (state.inTS) {
    try {
      await tsCall(() => TS.localStorage[scope].setBlob(s));
    } catch (e) {
      if (scope === 'campaign') return saveBlob('global', value);
      debug(`save failed: ${e.message}`);
    }
    return;
  }
  try {
    localStorage.setItem(`taleforge:${scope}`, s);
  } catch {
    // storage unavailable
  }
}

async function saveSettings() {
  const stored = (await loadBlob('global')) || {};
  await saveBlob('global', { ...stored, settings: state.settings });
}

async function saveHistory() {
  await saveBlob('campaign', { history: state.history.slice(0, 12) });
}

// ---------------------------------------------------------------------------
// boot

async function boot(inTS) {
  if (state.booted) return;
  state.booted = true;
  wireUi();
  state.inTS = inTS && !!ts();
  $('version').textContent = '0.1.0';
  const stored = await loadBlob('global');
  if (stored && stored.settings) state.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  const camp = await loadBlob('campaign');
  state.history = (camp && camp.history) || [];
  renderSettings();
  renderHistory();
  if (!state.inTS) {
    banner('demo', 'Running outside TaleSpire: using a synthetic demo catalog. Builds preview fine, but slabs only work inside the game.');
  }
  if (!state.settings.apiKey) banner('key', 'Add your Anthropic API key in Settings to generate with Claude. Plan JSON and probes work without one.');
  await loadCatalog();
  if (state.inTS) {
    try {
      const max = await tsCall(() => TS.slabs.getMaxSlabSizeInBytes());
      if (Number.isFinite(max) && max > 4000) state.maxSlabBytes = max;
    } catch {
      // keep the documented default
    }
  }
}

async function loadCatalog() {
  const chip = $('catalog-status');
  chip.textContent = 'loading assets…';
  chip.className = 'chip';
  try {
    if (state.inTS) {
      const frags = await tsCall(() => TS.contentPacks.getContentPacks());
      const infos = await tsCall(() => TS.contentPacks.getMoreInfo(frags));
      state.packInfos = infos;
      state.catalog = TF.Catalog.fromContentPacks(infos);
    } else {
      state.catalog = TF.demoCatalog();
    }
    const tiles = state.catalog.assets.filter((a) => a.kind === 'tile').length;
    chip.textContent = `${state.catalog.size.toLocaleString()} assets`;
    chip.title = `${tiles} tiles, ${state.catalog.size - tiles} props from ${(state.catalog.meta.packs || []).length} pack(s)`;
    chip.className = state.catalog.meta.synthetic ? 'chip warn' : 'chip ok';
    fillAssetNames();
    renderKit();
  } catch (e) {
    chip.textContent = 'assets unavailable';
    chip.className = 'chip warn';
    banner('catalog', `Could not read your asset packs: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// UI helpers

const banners = new Map();
function banner(key, text) {
  if (text) banners.set(key, text);
  else banners.delete(key);
  const b = $('banner');
  b.textContent = [...banners.values()].join('\n');
  show(b, banners.size > 0);
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), 4200);
}

function setError(id, err) {
  const el = $(id);
  if (!err) {
    show(el, false);
    return;
  }
  el.textContent = err.message || String(err);
  show(el);
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab')) show(s, s.id === `tab-${name}`);
  if (name === 'kit') renderKit();
}

function progressReporter(boxId, textId) {
  const t0 = Date.now();
  show(boxId);
  const el = $(textId);
  el.textContent = 'Asking Claude…';
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    el.textContent = el.dataset.phase ? `${el.dataset.phase} ${s}s` : `Waiting for Claude… ${s}s`;
  }, 1000);
  return {
    update(ev) {
      if (ev.phase === 'thinking') el.dataset.phase = 'Claude is planning…';
      else if (ev.phase === 'writing') el.dataset.phase = `Drawing the map (${Math.round(ev.textChars / 1000)}k chars)…`;
      else if (ev.phase === 'retrying') el.dataset.phase = `Retrying (attempt ${ev.attempt})…`;
      else if (ev.phase === 'fallback') el.dataset.phase = `Continuing on ${ev.model}…`;
    },
    done() {
      clearInterval(timer);
      delete el.dataset.phase;
      show(boxId, false);
    },
  };
}

function apiOpts() {
  const s = state.settings;
  if (!s.apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  return { apiKey: s.apiKey, model: s.model, effort: s.effort, baseUrl: s.baseUrl || undefined };
}

function busy(on) {
  for (const id of ['generate', 'refine', 'trace-run', 'reseed', 'plan-rebuild', 'trace-apply']) $(id).disabled = on;
  show('cancel', on && !!state.abort);
}

// ---------------------------------------------------------------------------
// images

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => reject(new Error('That file is not an image the browser can read.'));
    img.src = url;
  });
}

// For the API: longest side at most 1568 px, JPEG on a white background.
function imageForApi(img) {
  const s = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.9);
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

function imageRgba(img, maxSide = 1400) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: new Uint8Array(d.data.buffer) };
}

function wireDrop(zoneId, inputId, pickId, onFile) {
  const zone = $(zoneId);
  const input = $(inputId);
  $(pickId).addEventListener('click', (e) => {
    e.preventDefault();
    input.click();
  });
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) onFile(f);
  });
  zone.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData.items || [])].find((x) => x.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      onFile(item.getAsFile());
    }
  });
}

async function setReferenceImage(file) {
  try {
    const { img, url } = await readImage(file);
    state.image = { img, api: imageForApi(img) };
    $('image-thumb').src = url;
    show('image-empty', false);
    show('image-full');
  } catch (e) {
    toast(e.message);
  }
}

function clearReferenceImage() {
  state.image = null;
  $('image-file').value = '';
  show('image-empty');
  show('image-full', false);
}

async function setTraceImage(file) {
  try {
    const { img, url } = await readImage(file);
    state.traceImage = { img, rgba: imageRgba(img), api: imageForApi(img) };
    $('trace-thumb').src = url;
    show('trace-empty', false);
    show('trace-full');
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------------------
// build pipeline

function currentKit(style) {
  return new TF.Kit(state.catalog, { style, overrides: state.settings.overrides });
}

async function buildAndShow(plan, { warnings = [], remember = true } = {}) {
  if (!state.catalog) throw new Error('The asset library is not loaded yet.');
  const build = await TF.buildSlabs(plan, currentKit(plan.style), {
    seed: state.seed,
    furnitureFacing: Number(state.settings.facing) || 0,
    maxBytes: Math.min(TF.DEFAULT_CHUNK_BUDGET, state.maxSlabBytes - 1500),
  });
  build.warnings.unshift(...warnings);
  state.build = build;
  state.plan = build.plan;
  renderResult();
  selectTab('result');
  if (remember) {
    state.history.unshift({ title: plan.title, at: Date.now(), plan });
    state.history = state.history.slice(0, 12);
    renderHistory();
    saveHistory();
  }
}

async function onGenerate() {
  setError('create-error', null);
  let opts;
  try {
    opts = apiOpts();
  } catch (e) {
    setError('create-error', e);
    return;
  }
  const sizeKey = $('size').value;
  const size = sizeKey === 'custom' ? [Number($('size-w').value) || 40, Number($('size-h').value) || 30] : TF.SIZE_PRESETS[sizeKey] || null;
  const imageMode = (document.querySelector('input[name="image-mode"]:checked') || {}).value || 'reference';
  state.abort = new AbortController();
  busy(true);
  const p = progressReporter('progress', 'progress-text');
  try {
    const res = await TF.generatePlan({
      ...opts,
      prompt: $('prompt').value.trim(),
      size,
      style: $('style').value || undefined,
      image: state.image ? state.image.api : null,
      imageMode,
      catalog: state.catalog,
      onProgress: p.update,
      signal: state.abort.signal,
    });
    state.seed = 1;
    debug(`plan from ${res.model}: ${res.usage.output_tokens} output tokens`);
    await buildAndShow(res.plan, { warnings: res.warnings });
  } catch (e) {
    setError('create-error', e);
  } finally {
    p.done();
    state.abort = null;
    busy(false);
  }
}

async function onRefine() {
  setError('refine-error', null);
  const change = $('refine-prompt').value.trim();
  if (!change || !state.plan) return;
  let opts;
  try {
    opts = apiOpts();
  } catch (e) {
    setError('refine-error', e);
    return;
  }
  state.abort = new AbortController();
  busy(true);
  const p = progressReporter('refine-progress', 'refine-progress-text');
  try {
    const res = await TF.generatePlan({ ...opts, prompt: change, previousPlan: state.plan, catalog: state.catalog, onProgress: p.update, signal: state.abort.signal });
    $('refine-prompt').value = '';
    await buildAndShow(res.plan, { warnings: res.warnings });
  } catch (e) {
    setError('refine-error', e);
  } finally {
    p.done();
    state.abort = null;
    busy(false);
  }
}

async function onReseed() {
  if (!state.plan) return;
  state.seed += 1;
  try {
    await buildAndShow(state.plan, { remember: false });
  } catch (e) {
    setError('refine-error', e);
  }
}

async function onPlanRebuild() {
  setError('plan-error', null);
  try {
    const { plan, warnings } = TF.normalizePlan(JSON.parse($('plan-json').value));
    await buildAndShow(plan, { warnings });
  } catch (e) {
    setError('plan-error', e);
  }
}

// ---- trace ----

async function onTrace() {
  setError('trace-error', null);
  if (!state.traceImage) {
    setError('trace-error', new Error('Choose a map image first.'));
    return;
  }
  const img = state.traceImage.rgba;
  const colors = Math.max(2, Math.min(16, Number($('trace-colors').value) || 8));
  const w = Number($('trace-w').value);
  const h = Number($('trace-h').value);
  let size = w >= 4 && h >= 4 ? [w, h] : TF.autoGridSize(img.width, img.height, 48);
  let trace = TF.traceImage(img, { gridW: size[0], gridH: size[1], colors });
  let labels;
  let extras = { title: 'Traced map', props: [] };
  busy(true);
  const p = progressReporter('trace-progress', 'trace-progress-text');
  try {
    if ($('trace-ai').checked) {
      state.abort = new AbortController();
      const res = await TF.labelTrace({
        ...apiOpts(), effort: 'medium', trace, image: state.traceImage.api, prompt: $('trace-prompt').value.trim(),
        catalog: state.catalog, onProgress: p.update, signal: state.abort.signal,
      });
      labels = res.labels;
      extras = res.extras;
      if (res.grid && !(w >= 4 && h >= 4) && (Math.abs(res.grid[0] - size[0]) > 1 || Math.abs(res.grid[1] - size[1]) > 1)) {
        size = res.grid;
        const again = TF.traceImage(img, { gridW: size[0], gridH: size[1], colors });
        const moved = TF.remapTraceLabels(trace, again, labels, extras.props);
        trace = again;
        labels = moved.labels;
        extras.props = moved.props;
        toast(`Claude counted a ${size[0]}×${size[1]} grid; traced at that size.`);
      }
    } else {
      labels = TF.heuristicLabels(trace);
    }
    state.trace = trace;
    state.traceLabels = labels;
    state.traceExtras = extras;
    renderClusters();
    await rebuildTrace();
  } catch (e) {
    setError('trace-error', e);
  } finally {
    p.done();
    state.abort = null;
    busy(false);
  }
}

async function rebuildTrace() {
  const { plan, warnings } = TF.normalizePlan(TF.traceToPlan(state.trace, state.traceLabels, state.traceExtras));
  await buildAndShow(plan, { warnings });
}

function renderClusters() {
  const body = $('cluster-rows');
  body.replaceChildren();
  for (const c of state.trace.clusters) {
    const l = state.traceLabels.find((x) => x.index === c.index) || { index: c.index, meaning: 'ground' };
    const tr = document.createElement('tr');
    const sw = document.createElement('td');
    const box = document.createElement('div');
    box.className = 'swatch';
    box.style.background = c.hex;
    sw.appendChild(box);
    const share = document.createElement('td');
    share.textContent = `${(c.share * 100).toFixed(0)}%`;
    share.className = 'muted';
    const sel = document.createElement('td');
    const s1 = document.createElement('select');
    for (const m of TRACE_MEANINGS) s1.add(new Option(m, m, false, m === l.meaning));
    s1.addEventListener('change', () => setLabel(c.index, { meaning: s1.value }));
    sel.appendChild(s1);
    const mat = document.createElement('td');
    const s2 = document.createElement('select');
    s2.add(new Option('(auto)', ''));
    for (const m of TF.SURFACES) s2.add(new Option(m.replace('_', ' '), m, false, m === l.material));
    s2.addEventListener('change', () => setLabel(c.index, { material: s2.value || null }));
    mat.appendChild(s2);
    tr.append(sw, share, sel, mat);
    body.appendChild(tr);
  }
  show('trace-clusters');
}

function setLabel(index, patch) {
  const i = state.traceLabels.findIndex((x) => x.index === index);
  if (i >= 0) state.traceLabels[i] = { ...state.traceLabels[i], ...patch };
  else state.traceLabels.push({ index, meaning: 'ground', ...patch });
}

// ---- result ----

function renderResult() {
  const b = state.build;
  show('result-empty', false);
  show('result');
  $('r-title').textContent = b.plan.title;
  $('r-summary').textContent = b.plan.summary || '';
  $('r-preview').innerHTML = b.svg; // generated by TaleForge; all text in it is escaped
  $('r-stats').textContent = `${b.plan.width}×${b.plan.height} tiles (${b.plan.width * 5}×${b.plan.height * 5} ft) · ${b.stats.total.toLocaleString()} assets (${b.stats.tiles.toLocaleString()} tiles, ${b.stats.props.toLocaleString()} props)`;
  const steps = $('r-steps');
  steps.replaceChildren();
  const multi = b.chunks.length > 1;
  const lines = multi
    ? ['Enter GM mode on a board and point the camera straight down. Don\'t move it until all parts are placed.',
      'Send part 1 to your hand and place it with a short left-click hold. Right-click to empty your hand.',
      'Send each remaining part and place it on exactly the same grid cell. The matching corner markers make them line up.',
      'Delete the stacked marker tiles at the two corners afterwards.']
    : ['Enter GM mode on a board.', 'Send the build to your hand, then click to place it. Right-click to empty your hand.'];
  for (const l of lines) {
    const li = document.createElement('li');
    li.textContent = l;
    steps.appendChild(li);
  }
  $('r-parts-title').textContent = multi ? `Place it (${b.chunks.length} parts)` : 'Place it';
  const parts = $('r-parts');
  parts.replaceChildren();
  b.chunks.forEach((c, i) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = multi ? `Part ${i + 1}` : b.plan.title;
    const small = document.createElement('small');
    small.textContent = `${c.count.toLocaleString()} assets · ${(c.compressedBytes / 1024).toFixed(1)} KB`;
    label.appendChild(small);
    const send = document.createElement('button');
    send.className = 'primary';
    send.textContent = 'Send to hand';
    send.addEventListener('click', () => sendToHand(c, li));
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyText(c.text, 'Slab copied. Press Ctrl+V on a board.'));
    li.append(label, send, copy);
    parts.appendChild(li);
  });
  show('r-multislab', !!b.multiSlab);
  $('r-notes').textContent = b.plan.notes || '';
  show('r-notes-box', !!b.plan.notes);
  const warn = $('r-warnings');
  warn.replaceChildren();
  for (const w of b.warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    warn.appendChild(li);
  }
  $('r-warn-title').textContent = `Warnings (${b.warnings.length})`;
  show('r-warn-box', b.warnings.length > 0);
  $('plan-json').value = JSON.stringify(b.plan, null, 2);
  renderKit();
}

async function sendToHand(chunk, li) {
  if (!state.inTS) {
    copyText(chunk.text, 'Not in TaleSpire: slab copied to the clipboard instead.');
    return;
  }
  if (state.catalog && state.catalog.meta.synthetic) {
    toast('This build uses the demo catalog; its assets do not exist in your game.');
    return;
  }
  try {
    await tsCall(() => TS.slabs.sendSlabToHand(chunk.text));
    li.classList.add('done');
    toast('In your hand: click on the board to place it, right-click to clear.');
  } catch (e) {
    toast(e.message);
  }
}

async function copyText(text, message) {
  try {
    if (state.inTS) await tsCall(() => TS.system.clipboard.setText(text));
    else await navigator.clipboard.writeText(text);
    toast(message);
  } catch (e) {
    toast(`Could not copy: ${e.message}`);
  }
}

function openZoom() {
  if (!state.build) return;
  $('zoom-inner').innerHTML = state.build.svg;
  const svg = $('zoom-inner').querySelector('svg');
  if (svg) {
    svg.style.width = `${Math.max(800, Number(svg.getAttribute('width')) * 1.4)}px`;
    svg.style.height = 'auto';
  }
  show('zoom');
}

// ---- history ----

function renderHistory() {
  const ul = $('history');
  ul.replaceChildren();
  if (!state.history.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing yet.';
    ul.appendChild(li);
    return;
  }
  for (const h of state.history) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${h.title} · ${new Date(h.at).toLocaleDateString()}`;
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.addEventListener('click', async () => {
      try {
        const { plan, warnings } = TF.normalizePlan(h.plan);
        await buildAndShow(plan, { warnings, remember: false });
      } catch (e) {
        toast(e.message);
      }
    });
    li.append(name, open);
    ul.appendChild(li);
  }
}

// ---- kit ----

function fillAssetNames() {
  const dl = $('asset-names');
  dl.replaceChildren();
  const names = [...new Set(state.catalog.assets.filter((a) => !a.deprecated).map((a) => a.name))].sort();
  for (const n of names.slice(0, 6000)) dl.appendChild(new Option(n));
}

function kitRolesFor(style) {
  const kit = currentKit(style);
  const preset = TF.STYLE_PRESETS[style];
  for (const m of new Set([preset.ground, preset.path, preset.floor, 'grass', 'dirt', 'water', 'stone_floor', 'wood_floor'])) if (m && m !== 'none') kit.surface(m);
  for (const w of new Set([preset.wall, 'wood', 'stone'])) kit.wall(w);
  kit.door();
  kit.stairs();
  kit.flatRoof();
  kit.roofKit();
  for (const r of ['tree', 'rock', 'barrel', 'crate', 'table', 'chair', 'bed', 'chest', 'torch']) kit.props(r);
  return kit.report();
}

function renderKit() {
  if (!state.catalog) return;
  const sel = $('kit-style');
  if (!sel.options.length) {
    for (const s of TF.STYLES) sel.add(new Option(s, s));
  }
  const report = state.build && sel.dataset.followBuild !== 'no' ? state.build.kitReport : kitRolesFor(sel.value || 'medieval');
  const ul = $('kit-list');
  ul.replaceChildren();
  for (const r of report) {
    if (/:(long|window|2x2)$/.test(r.role) && !r.asset) continue;
    const li = document.createElement('li');
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (r.id) addThumb(thumb, r.id);
    const role = document.createElement('div');
    role.className = 'role';
    const b = document.createElement('b');
    b.textContent = r.asset || 'not found';
    if (!r.asset) b.className = 'missing';
    role.append(`${r.role.replace(/:/g, ' › ')}: `, b);
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = r.source;
    role.appendChild(src);
    const input = document.createElement('input');
    input.setAttribute('list', 'asset-names');
    input.placeholder = 'override with asset name…';
    input.value = state.settings.overrides[r.role] || '';
    input.addEventListener('change', async () => {
      const v = input.value.trim();
      if (v) state.settings.overrides[r.role] = v;
      else delete state.settings.overrides[r.role];
      await saveSettings();
      if (state.plan) await buildAndShow(state.plan, { remember: false });
      else renderKit();
      toast(v ? `${r.role} now uses ${v}` : `${r.role} override cleared`);
    });
    li.append(thumb, role, input);
    ul.appendChild(li);
  }
}

async function addThumb(el, id) {
  if (!state.inTS || !state.packInfos) return;
  try {
    const found = await TS.contentPacks.findBoardObjectInPacks(id, state.packInfos);
    if (!found || !found.boardObject) return;
    const t = await TS.contentPacks.createThumbnailElementForBoardObject(found.boardObject, 40);
    if (t && t.nodeType) el.appendChild(t);
  } catch {
    // thumbnails are decoration
  }
}

// ---- settings & probes ----

function renderSettings() {
  const s = state.settings;
  $('api-key').value = s.apiKey;
  $('model').value = s.model;
  $('effort').value = s.effort;
  $('base-url').value = s.baseUrl;
  $('facing').value = String(s.facing || 0);
}

async function onSaveSettings() {
  state.settings.apiKey = $('api-key').value.trim();
  state.settings.model = $('model').value;
  state.settings.effort = $('effort').value;
  state.settings.baseUrl = $('base-url').value.trim();
  state.settings.facing = Number($('facing').value) || 0;
  await saveSettings();
  banner('key', state.settings.apiKey ? null : 'Add your Anthropic API key in Settings to generate with Claude. Plan JSON and probes work without one.');
  show('settings-saved');
  setTimeout(() => show('settings-saved', false), 2000);
  if (state.plan) await buildAndShow(state.plan, { remember: false });
}

async function onProbe(kind) {
  setError('probe-error', null);
  try {
    if (kind === 'facing') {
      const kit = currentKit('medieval');
      const placements = TF.facingProbe(kit, 'bed');
      const { text, compressedBytes } = await TF.encodeSlab(placements);
      await sendToHand({ text, compressedBytes, count: placements.length }, document.createElement('li'));
      return;
    }
    await buildAndShow(TF.probePlan(kind), { remember: false });
  } catch (e) {
    setError('probe-error', e);
  }
}

// ---------------------------------------------------------------------------
// wiring

let wired = false;
function wireUi() {
  if (wired) return;
  wired = true;
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  const ex = $('examples');
  for (const [label, text, size, style] of EXAMPLES) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      $('prompt').value = text;
      $('size').value = size;
      $('style').value = style;
      show('custom-size', false);
    });
    ex.appendChild(b);
  }
  for (const s of TF.STYLES) $('style').add(new Option(s[0].toUpperCase() + s.slice(1), s));
  $('size').addEventListener('change', () => show('custom-size', $('size').value === 'custom'));
  wireDrop('image-drop', 'image-file', 'image-pick', setReferenceImage);
  wireDrop('trace-drop', 'trace-file', 'trace-pick', setTraceImage);
  $('image-clear').addEventListener('click', (e) => {
    e.preventDefault();
    clearReferenceImage();
  });
  $('generate').addEventListener('click', onGenerate);
  $('cancel').addEventListener('click', () => state.abort && state.abort.abort());
  $('refine').addEventListener('click', onRefine);
  $('reseed').addEventListener('click', onReseed);
  $('plan-rebuild').addEventListener('click', onPlanRebuild);
  $('plan-copy').addEventListener('click', () => copyText($('plan-json').value, 'Plan copied.'));
  $('r-multislab').addEventListener('click', () => state.build && copyText(state.build.multiSlab, 'Multi-slab JSON copied.'));
  $('r-preview').addEventListener('click', openZoom);
  $('zoom').addEventListener('click', () => show('zoom', false));
  $('trace-run').addEventListener('click', onTrace);
  $('trace-apply').addEventListener('click', async () => {
    setError('trace-error', null);
    try {
      await rebuildTrace();
    } catch (e) {
      setError('trace-error', e);
    }
  });
  $('kit-style').addEventListener('change', () => {
    $('kit-style').dataset.followBuild = 'no';
    renderKit();
  });
  $('kit-reset').addEventListener('click', async () => {
    state.settings.overrides = {};
    await saveSettings();
    if (state.plan) await buildAndShow(state.plan, { remember: false });
    else renderKit();
  });
  $('catalog-export').addEventListener('click', () => state.catalog && copyText(JSON.stringify(state.catalog.toJSON()), `Catalog copied (${state.catalog.size} assets). Save it as a .json file for the CLI.`));
  $('settings-save').addEventListener('click', onSaveSettings);
  for (const b of document.querySelectorAll('[data-probe]')) b.addEventListener('click', () => onProbe(b.dataset.probe));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') show('zoom', false);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && document.activeElement === $('prompt')) onGenerate();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireUi();
  // In TaleSpire the API arrives with hasInitialized; in a normal browser it never does.
  setTimeout(() => {
    if (!state.booted && !ts()) boot(false);
  }, 400);
});
