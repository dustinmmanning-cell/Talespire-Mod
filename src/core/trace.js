// Trace mode: a top-down map image -> a tile grid.
//
//   1. sample the image onto the grid, taking each cell's DOMINANT colour (an
//      average would blur a black wall line into grey floor)
//   2. cluster the cell colours with k-means in CIE Lab
//   3. label each cluster (Claude looking at the image, or a colour heuristic
//      offline): floor, wall, water, forest, building, road, door, ...
//   4. emit a plan whose `raster` the compiler turns into surfaces and walled
//      structures (connected floor cells become one structure)
//
// Pure functions over an RGBA byte array, so it runs in Node and the Symbiote.

import { makeRng } from './util.js';

export const TRACE_MEANINGS = ['ground', 'road', 'floor', 'wall', 'void', 'water', 'forest', 'building', 'door', 'rubble'];
export const CLUSTER_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Dominant colour of each grid cell. Returns { colors: [[r,g,b]|null], ... }
// (null = mostly transparent).
export function sampleGrid(rgba, width, height, gridW, gridH) {
  const colors = new Array(gridW * gridH);
  const cw = width / gridW;
  const ch = height / gridH;
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const x0 = Math.floor(gx * cw);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cw));
      const y0 = Math.floor(gy * ch);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * ch));
      // inset a little so grid lines on battle maps do not dominate
      const ix = (x1 - x0) > 6 ? Math.floor((x1 - x0) * 0.12) : 0;
      const iy = (y1 - y0) > 6 ? Math.floor((y1 - y0) * 0.12) : 0;
      const stepX = Math.max(1, Math.floor((x1 - x0 - 2 * ix) / 14));
      const stepY = Math.max(1, Math.floor((y1 - y0 - 2 * iy) / 14));
      const bins = new Map();
      let total = 0;
      let transparent = 0;
      for (let y = y0 + iy; y < y1 - iy; y += stepY) {
        for (let x = x0 + ix; x < x1 - ix; x += stepX) {
          const i = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4;
          total++;
          if (rgba[i + 3] < 128) {
            transparent++;
            continue;
          }
          const key = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
          let bin = bins.get(key);
          if (!bin) bins.set(key, (bin = [0, 0, 0, 0]));
          bin[0] += rgba[i];
          bin[1] += rgba[i + 1];
          bin[2] += rgba[i + 2];
          bin[3]++;
        }
      }
      if (transparent * 2 > total || bins.size === 0) {
        colors[gy * gridW + gx] = null;
        continue;
      }
      let best = null;
      for (const bin of bins.values()) if (!best || bin[3] > best[3]) best = bin;
      colors[gy * gridW + gx] = [best[0] / best[3], best[1] / best[3], best[2] / best[3]];
    }
  }
  return colors;
}

function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// Weighted k-means++ over Lab points. Deterministic for a given seed.
export function kmeans(points, weights, k, seed = 1, iterations = 14) {
  const rng = makeRng(seed);
  const n = points.length;
  k = Math.min(k, n);
  if (k === 0) return { centroids: [], assign: [] };
  const centroids = [];
  let first = 0;
  for (let i = 1; i < n; i++) if (weights[i] > weights[first]) first = i;
  centroids.push(points[first].slice());
  const d = new Float64Array(n).fill(Infinity);
  while (centroids.length < k) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      d[i] = Math.min(d[i], dist2(points[i], centroids[centroids.length - 1]));
      sum += d[i] * weights[i];
    }
    if (sum === 0) break;
    let r = rng.next() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d[i] * weights[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(points[pick].slice());
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dd = dist2(points[i], centroids[c]);
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      assign[i] = best;
    }
    const acc = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const a = acc[assign[i]];
      const w = weights[i];
      a[0] += points[i][0] * w;
      a[1] += points[i][1] * w;
      a[2] += points[i][2] * w;
      a[3] += w;
    }
    acc.forEach((a, c) => {
      if (a[3] > 0) centroids[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    });
  }
  return { centroids, assign };
}

// image: { data: RGBA bytes, width, height }
// -> { gridW, gridH, cells: Int16Array (cluster or -1), clusters: [...], rows: [string] }
export function traceImage(image, { gridW, gridH, colors = 8, seed = 1, minShare = 0.006 } = {}) {
  const cellColors = sampleGrid(image.data, image.width, image.height, gridW, gridH);
  // unique colours (quantised) with weights keep k-means fast on big grids
  const uniq = new Map();
  cellColors.forEach((c, i) => {
    if (!c) return;
    const key = `${Math.round(c[0] / 4)},${Math.round(c[1] / 4)},${Math.round(c[2] / 4)}`;
    let u = uniq.get(key);
    if (!u) uniq.set(key, (u = { rgb: c, lab: rgbToLab(c), w: 0, cells: [] }));
    u.w++;
    u.cells.push(i);
  });
  const list = [...uniq.values()];
  const { centroids, assign } = kmeans(list.map((u) => u.lab), list.map((u) => u.w), colors, seed);
  const cells = new Int16Array(gridW * gridH).fill(-1);
  list.forEach((u, j) => {
    for (const i of u.cells) cells[i] = assign[j];
  });
  // stats + merge tiny clusters into their nearest neighbour
  const total = cellColors.filter(Boolean).length || 1;
  const count = new Array(centroids.length).fill(0);
  for (const c of cells) if (c >= 0) count[c]++;
  const keep = centroids.map((_, c) => count[c] / total >= minShare);
  const remap = centroids.map((lab, c) => {
    if (keep[c]) return c;
    let best = -1;
    let bd = Infinity;
    centroids.forEach((o, j) => {
      if (j !== c && keep[j]) {
        const dd = dist2(lab, o);
        if (dd < bd) {
          bd = dd;
          best = j;
        }
      }
    });
    return best >= 0 ? best : c;
  });
  const order = [...new Set(remap)].sort((a, b) => count[b] - count[a]);
  const finalIndex = new Map(order.map((c, i) => [c, i]));
  const rgbAcc = order.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] < 0) continue;
    const f = finalIndex.get(remap[cells[i]]);
    cells[i] = f;
    const c = cellColors[i];
    rgbAcc[f][0] += c[0];
    rgbAcc[f][1] += c[1];
    rgbAcc[f][2] += c[2];
    rgbAcc[f][3]++;
  }
  const clusters = rgbAcc.map((a, i) => {
    const rgb = a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : [0, 0, 0];
    return { index: i, char: CLUSTER_CHARS[i], rgb: rgb.map(Math.round), hex: hex(rgb), share: a[3] / total, lab: rgbToLab(rgb) };
  });
  const rows = [];
  for (let y = 0; y < gridH; y++) {
    let row = '';
    for (let x = 0; x < gridW; x++) {
      const c = cells[y * gridW + x];
      row += c < 0 ? '.' : CLUSTER_CHARS[c];
    }
    rows.push(row);
  }
  return { gridW, gridH, cells, clusters, rows };
}

// Offline labelling by colour. setting: 'auto' | 'outdoor' | 'dungeon'.
export function heuristicLabels(trace, { setting = 'auto' } = {}) {
  const feats = trace.clusters.map((c) => {
    const [L, a, b] = c.lab;
    const chroma = Math.hypot(a, b);
    const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    return { c, L, chroma, hue };
  });
  const darkShare = feats.filter((f) => f.L < 25).reduce((s, f) => s + f.c.share, 0);
  const greenShare = feats.filter((f) => f.chroma > 15 && f.hue > 95 && f.hue < 175).reduce((s, f) => s + f.c.share, 0);
  const mode = setting !== 'auto' ? setting : greenShare > 0.2 ? 'outdoor' : darkShare > 0.25 ? 'dungeon' : 'outdoor';
  return feats.map(({ c, L, chroma, hue }) => {
    const label = (meaning, material = null, wall = null) => ({ index: c.index, meaning, material, wall, label: `${meaning} ${c.hex}` });
    const blue = chroma > 12 && hue > 190 && hue < 315;
    const green = chroma > 12 && hue > 95 && hue < 175;
    const warm = chroma > 18 && (hue < 80 || hue > 330);
    if (L > 94 && chroma < 6) return label('void');
    if (blue) return label('water', 'water');
    if (mode === 'dungeon') {
      if (L < 25) return label('wall');
      if (green) return label('floor', 'cave_floor', 'cave');
      if (warm && L < 55) return label('floor', 'wood_floor', 'stone');
      return label('floor', 'stone_floor', 'stone');
    }
    if (green) return L < 38 ? label('forest', 'grass') : label('ground', 'grass');
    if (L < 22) return label('building', 'stone_floor', 'stone');
    if (warm && L < 60 && chroma > 25) return label('building', 'wood_floor', 'wood');
    if (warm) return label('road', L > 70 ? 'sand' : 'dirt');
    return label('road', 'cobblestone');
  });
}

// labels: [{ index, meaning, material, wall, label }]
// extras: { title, summary, notes, style, props }
export function traceToPlan(trace, labels, extras = {}) {
  const legend = {};
  const byIndex = new Map(labels.map((l) => [l.index, l]));
  // doors join the most common walled class so they merge into its structures
  let host = null;
  for (const l of labels) {
    if (l.meaning !== 'floor' && l.meaning !== 'building') continue;
    const share = (trace.clusters[l.index] || {}).share || 0;
    if (!host || share > host.share) host = { l, share };
  }
  const structureOf = (l) => (l.meaning === 'building' ? 'house' : 'dungeon');
  for (const c of trace.clusters) {
    const l = byIndex.get(c.index) || { meaning: 'ground' };
    let e;
    switch (l.meaning) {
      case 'road':
        e = { material: l.material || 'cobblestone' };
        break;
      case 'water':
        e = { material: 'water' };
        break;
      case 'forest':
        e = { material: l.material && l.material !== 'none' ? l.material : 'grass', prop: 'tree', propDensity: 0.35 };
        break;
      case 'rubble':
        e = { material: l.material && l.material !== 'none' ? l.material : 'gravel', prop: 'rock', propDensity: 0.3 };
        break;
      case 'wall':
      case 'void':
        e = { material: 'none' };
        break;
      case 'floor':
        e = { material: l.material && l.material !== 'none' ? l.material : 'stone_floor', structure: structureOf(l), wall: l.wall && l.wall !== 'none' ? l.wall : 'stone', roof: 'none', furnish: 'none' };
        break;
      case 'building':
        e = { material: l.material && l.material !== 'none' ? l.material : 'wood_floor', structure: structureOf(l), wall: l.wall && l.wall !== 'none' ? l.wall : 'wood', roof: 'pitched', furnish: 'sparse' };
        break;
      case 'door': {
        const h = host ? host.l : { meaning: 'floor', material: 'stone_floor', wall: 'stone' };
        e = {
          material: h.material && h.material !== 'none' ? h.material : 'stone_floor',
          structure: structureOf(h),
          wall: h.wall && h.wall !== 'none' ? h.wall : h.meaning === 'building' ? 'wood' : 'stone',
          door: true,
          roof: h.meaning === 'building' ? 'pitched' : 'none',
          furnish: h.meaning === 'building' ? 'sparse' : 'none',
        };
        break;
      }
      default:
        e = { material: l.material && l.material !== 'none' ? l.material : 'grass' };
    }
    e.label = l.label || l.meaning;
    legend[c.char] = e;
  }
  const outdoor = labels.some((l) => ['ground', 'road', 'forest'].includes(l.meaning));
  return {
    title: extras.title || 'Traced map',
    summary: extras.summary || '',
    width: trace.gridW,
    height: trace.gridH,
    style: extras.style || (outdoor ? 'medieval' : 'dungeon'),
    ground: 'none',
    areas: [],
    paths: [],
    structures: [],
    barriers: [],
    props: extras.props || [],
    scatter: [],
    notes: extras.notes || '',
    raster: { rows: trace.rows, legend, storeys: 1, roof: 'none', furnish: 'none' },
  };
}

// Pick a grid size for an image: long side `longSide` tiles, aspect preserved.
export function autoGridSize(width, height, longSide = 48) {
  if (width >= height) return [longSide, Math.max(4, Math.round((longSide * height) / width))];
  return [Math.max(4, Math.round((longSide * width) / height)), longSide];
}

// Nearest-neighbour/box downscale of RGBA for sending to the API.
export function resizeRgba(image, maxSide) {
  const { width, height, data } = image;
  const s = Math.min(1, maxSide / Math.max(width, height));
  if (s >= 1) return image;
  const nw = Math.max(1, Math.round(width * s));
  const nh = Math.max(1, Math.round(height * s));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y / s);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / s));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x / s);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / s));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = sy0; yy < Math.min(height, sy1); yy++) {
        for (let xx = sx0; xx < Math.min(width, sx1); xx++) {
          const i = (yy * width + xx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: nw, height: nh, data: out };
}
