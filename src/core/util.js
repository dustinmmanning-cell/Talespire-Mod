// Small shared helpers: a seeded RNG and 2D rasterization.

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32: tiny, fast, deterministic across platforms.
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    shuffle: (list) => {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Cells (x, y) whose centres fall inside the polygon.
export function polygonCells(pts, W, H) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const out = [];
  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(H, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x < Math.min(W, Math.ceil(maxX)); x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, pts)) out.push([x, y]);
    }
  }
  return out;
}

// Cells whose centres are within width/2 of the polyline.
export function polylineCells(pts, width, W, H) {
  const r = width / 2 + 1e-6;
  const seen = new Set();
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = y * W + x;
        if (seen.has(key)) continue;
        if (distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by) <= r) {
          seen.add(key);
          out.push([x, y]);
        }
      }
    }
  }
  return out;
}

// Snap a polyline to grid corners and walk it as unit edges along grid lines.
// Returns [{ x, y, dir }] where dir 'h' is the edge from (x,y) to (x+1,y) and
// 'v' the edge from (x,y) to (x,y+1). Diagonals become staircases.
export function gridLineEdges(pts, closed) {
  const corners = pts.map(([x, y]) => [Math.round(x), Math.round(y)]);
  if (closed && corners.length > 2) corners.push(corners[0]);
  const edges = [];
  const seen = new Set();
  const add = (x, y, dir) => {
    const k = `${x},${y},${dir}`;
    if (!seen.has(k)) {
      seen.add(k);
      edges.push({ x, y, dir });
    }
  };
  for (let i = 0; i + 1 < corners.length; i++) {
    let [x, y] = corners[i];
    const [tx, ty] = corners[i + 1];
    const steps = Math.abs(tx - x) + Math.abs(ty - y);
    const sx = Math.sign(tx - x);
    const sy = Math.sign(ty - y);
    const fx = Math.abs(tx - x);
    const fy = Math.abs(ty - y);
    let ex = 0;
    let ey = 0;
    for (let s = 0; s < steps; s++) {
      // advance along whichever axis is further behind its share of the line
      const moveX = fx > 0 && (fy === 0 || (ex + 1) / fx <= (ey + 1) / fy);
      if (moveX) {
        add(sx > 0 ? x : x - 1, y, 'h');
        x += sx;
        ex++;
      } else {
        add(x, sy > 0 ? y : y - 1, 'v');
        y += sy;
        ey++;
      }
    }
  }
  return { edges, corners };
}
