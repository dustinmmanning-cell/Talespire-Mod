// Top-down SVG preview of a compiled build: surfaces, walls, doors, windows,
// barriers, props and (optionally) how the build is cut into slabs. Used by
// the Symbiote UI and written next to the slabs by the CLI.

export const MATERIAL_COLORS = {
  grass: '#6d9b4a', dirt: '#8a6a45', mud: '#6b5338', gravel: '#9a9488', sand: '#d8c38e', snow: '#eef2f5',
  ice: '#bfe3f0', cobblestone: '#8c8c8c', flagstone: '#a39e93', stone_floor: '#7d7a76', wood_floor: '#a9773f',
  plank: '#9b6b3b', carpet: '#8e2d3a', marble: '#e6e1d8', tile: '#c9b79c', cave_floor: '#5f5650', water: '#3f7fbf',
  deep_water: '#2a5d91', swamp: '#5b6b3c', lava: '#d2491c', field: '#a58a4f',
};

const PROP_COLORS = {
  nature: '#2f5d27', furniture: '#7a4a1f', light: '#f2c14e', container: '#b07a3c', religious: '#d9d0f0', other: '#e0e0e0',
};
const PROP_CLASS = {
  tree: 'nature', conifer: 'nature', dead_tree: 'nature', bush: 'nature', rock: 'nature', boulder: 'nature', flowers: 'nature',
  tall_grass: 'nature', log: 'nature', stump: 'nature', mushroom: 'nature', crystal: 'nature',
  barrel: 'container', crate: 'container', sack: 'container', chest: 'container', pottery: 'container',
  torch: 'light', lantern: 'light', candle: 'light', brazier: 'light', campfire: 'light', chandelier: 'light',
  altar: 'religious', statue: 'religious', pew: 'religious', coffin: 'religious', tombstone: 'religious',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// result: compilePlan() output. chunks: optional [{ region: {x, y, w, h}, label }].
// Upper floors (result.floors) are drawn as panels below the map, each cropped
// to its floor.
export function renderPreviewSvg(result, { scale = 14, chunks = null, title = true } = {}) {
  const S = scale;
  const g = result.grid;
  const panels = [{
    g, x0: 0, y0: 0, w: g.width, h: g.height, chunks, labels: true, head: title ? 26 : 0,
    title: title ? `${esc(result.plan.title)}  <tspan fill="#9a948a" font-size="11">${g.width}x${g.height} tiles, ${result.stats.total} assets</tspan>` : '',
  }];
  for (const f of result.floors || []) {
    const box = cellsBox(f.grid);
    if (box) panels.push({ g: f.grid, ...box, chunks: null, labels: false, head: 22, title: `${esc(f.label)}  <tspan fill="#9a948a" font-size="11">floor ${f.level}</tspan>` });
  }
  const out = [];
  let y = 0;
  let width = 0;
  panels.forEach((pn, i) => {
    if (i > 0) y += 10;
    if (pn.title) out.push(`<text x="6" y="${y + pn.head - 8}" fill="#f0e6d0" font-size="${i === 0 ? 15 : 13}">${pn.title}</text>`);
    y += pn.head;
    const id = `tf-panel-${i}`;
    out.push(`<clipPath id="${id}"><rect x="${pn.x0 * S}" y="${pn.y0 * S}" width="${pn.w * S}" height="${pn.h * S}"/></clipPath>`);
    out.push(`<g transform="translate(${-pn.x0 * S} ${y - pn.y0 * S})"><g clip-path="url(#${id})">`);
    out.push(...drawGrid(pn.g, S, pn));
    out.push('</g></g>');
    y += pn.h * S;
    width = Math.max(width, pn.w * S);
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${y}" width="${width}" height="${y}" font-family="Georgia, serif">`,
    `<rect x="0" y="0" width="${width}" height="${y}" fill="#1b1b1f"/>`,
    ...out,
    '</svg>',
  ].join('\n');
}

// Bounding box of a floor's structure cells, one tile of margin.
function cellsBox(g) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  g.struct.forEach((s, c) => {
    if (s < 0) return;
    const x = c % g.width;
    const y = Math.floor(c / g.width);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  });
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(g.width - 1, x1 + 1);
  y1 = Math.min(g.height - 1, y1 + 1);
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function drawGrid(g, S, { chunks = null, labels = true } = {}) {
  const W = g.width;
  const H = g.height;
  const out = [];
  // surfaces, merged into horizontal runs to keep the SVG small
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const m = g.surf[y * W + x];
      let x1 = x + 1;
      while (x1 < W && g.surf[y * W + x1] === m) x1++;
      if (m) out.push(`<rect x="${x * S}" y="${y * S}" width="${(x1 - x) * S}" height="${S}" fill="${MATERIAL_COLORS[m] || '#888'}"/>`);
      x = x1;
    }
  }
  // faint 5-tile grid
  const grid = [];
  for (let x = 5; x < W; x += 5) grid.push(`M${x * S} 0V${H * S}`);
  for (let y = 5; y < H; y += 5) grid.push(`M0 ${y * S}H${W * S}`);
  out.push(`<path d="${grid.join('')}" stroke="#000" stroke-opacity="0.12" stroke-width="1"/>`);

  const edgeLine = (x, y, side, inset) => {
    const t = inset * S;
    if (side === 'n') return [x * S, y * S + t, (x + 1) * S, y * S + t];
    if (side === 's') return [x * S, (y + 1) * S - t, (x + 1) * S, (y + 1) * S - t];
    if (side === 'w') return [x * S + t, y * S, x * S + t, (y + 1) * S];
    return [(x + 1) * S - t, y * S, (x + 1) * S - t, (y + 1) * S];
  };
  const walls = [];
  const doors = [];
  const windows = [];
  for (const e of g.edges) {
    const [x1, y1, x2, y2] = edgeLine(e.x, e.y, e.side, 0.12);
    const seg = `M${x1} ${y1}L${x2} ${y2}`;
    if (e.type === 'door') doors.push(seg);
    else if (e.type === 'window') windows.push(seg);
    else if (e.type !== 'open') walls.push(seg);
  }
  for (const b of g.barriers || []) {
    for (const e of b.edges) {
      const [x1, y1, x2, y2] = edgeLine(e.x, e.y, e.side, 0.12);
      const seg = `M${x1} ${y1}L${x2} ${y2}`;
      if (e.type === 'gate') doors.push(seg);
      else if (b.kind === 'fence' || b.kind === 'hedge') windows.push(seg);
      else walls.push(seg);
    }
  }
  out.push(`<path d="${walls.join('')}" stroke="#2a2522" stroke-width="${Math.max(2, S * 0.24)}" stroke-linecap="square"/>`);
  out.push(`<path d="${windows.join('')}" stroke="#9fd3f2" stroke-width="${Math.max(2, S * 0.18)}"/>`);
  out.push(`<path d="${doors.join('')}" stroke="#e8a33d" stroke-width="${Math.max(2, S * 0.3)}"/>`);

  // stairs: a flight with its steps
  for (const st of g.stairs || []) {
    const [x, y, w, h] = [st.x * S, st.y * S, st.w * S, st.h * S];
    const steps = [];
    const n = Math.max(3, Math.round(Math.max(st.w, st.h) * 3));
    for (let k = 1; k < n; k++) {
      if (st.w >= st.h) steps.push(`M${(x + (w * k) / n).toFixed(1)} ${y + 2}V${y + h - 2}`);
      else steps.push(`M${x + 2} ${(y + (h * k) / n).toFixed(1)}H${x + w - 2}`);
    }
    out.push(`<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" fill="#e7dcc2" fill-opacity="0.55" stroke="#2a2522" stroke-width="1"/><path d="${steps.join('')}" stroke="#2a2522" stroke-width="1"/>`);
  }

  // open rooms (a bar area or a stage inside a bigger room): dashed outline
  const openRooms = new Map((g.rooms || []).filter((r) => r.open).map((r) => [r.id, { r, sx: 0, sy: 0, n: 0 }]));
  if (openRooms.size && g.room) {
    const dashes = [];
    for (let c = 0; c < g.room.length; c++) {
      const o = openRooms.get(g.room[c]);
      if (!o) continue;
      const x = c % W;
      const y = Math.floor(c / W);
      o.sx += x + 0.5;
      o.sy += y + 0.5;
      o.n++;
      for (const [side, dx, dy] of [['n', 0, -1], ['s', 0, 1], ['w', -1, 0], ['e', 1, 0]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && g.room[ny * W + nx] === g.room[c]) continue;
        const [x1, y1, x2, y2] = edgeLine(x, y, side, 0.06);
        dashes.push(`M${x1} ${y1}L${x2} ${y2}`);
      }
    }
    out.push(`<path d="${dashes.join('')}" stroke="#f0e6d0" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/>`);
  }

  for (const p of g.props || []) {
    const cls = PROP_CLASS[p.role] || (p.role === 'fence' ? 'furniture' : 'furniture');
    const r = cls === 'nature' && /tree|conifer/.test(p.role) ? S * 0.45 : S * 0.22;
    out.push(`<circle cx="${(p.x * S).toFixed(1)}" cy="${(p.y * S).toFixed(1)}" r="${r.toFixed(1)}" fill="${PROP_COLORS[cls] || PROP_COLORS.other}" stroke="#000" stroke-opacity="0.5"><title>${esc(p.name || p.role)}</title></circle>`);
  }

  for (const s of labels ? g.structures : []) {
    if (s.synthetic || s.cells.length === 0) continue;
    let sx = 0;
    let sy = 0;
    for (const c of s.cells) {
      sx += (c % W) + 0.5;
      sy += Math.floor(c / W) + 0.5;
    }
    const cx = (sx / s.cells.length) * S;
    const cy = (sy / s.cells.length) * S;
    const fs = Math.max(9, Math.min(14, S * 0.85));
    out.push(`<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${esc(s.label)}${s.storeys > 1 ? ` (${s.storeys}F)` : ''}</text>`);
  }

  for (const { r, sx, sy, n } of openRooms.values()) {
    if (!n) continue;
    const fs = Math.max(8, Math.min(11, S * 0.55));
    out.push(`<text x="${((sx / n) * S).toFixed(1)}" y="${((sy / n) * S + fs / 3).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-style="italic" fill="#f0e6d0" stroke="#000" stroke-width="2.5" paint-order="stroke">${esc(r.label)}</text>`);
  }

  if (chunks) {
    chunks.forEach((ch, i) => {
      const r = ch.region;
      out.push(`<rect x="${r.x * S}" y="${r.y * S}" width="${r.w * S}" height="${r.h * S}" fill="none" stroke="#ff4fd8" stroke-width="2" stroke-dasharray="6 4"/>`);
      out.push(`<text x="${r.x * S + 4}" y="${r.y * S + 14}" font-size="12" fill="#ff4fd8" stroke="#000" stroke-width="3" paint-order="stroke">${esc(ch.label || `#${i + 1}`)}</text>`);
    });
  }
  return out;
}
