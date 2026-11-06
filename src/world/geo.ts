import type { Rect, Vec } from '../core/math';

/** Polygon & polyline helpers used by the real-world map importer, nav grid and renderer. */

export function polyArea(p: Vec[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return a / 2; // sign = winding
}

export function polyBounds(p: Vec[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const v of p) {
    if (v.x < x0) x0 = v.x;
    if (v.y < y0) y0 = v.y;
    if (v.x > x1) x1 = v.x;
    if (v.y > y1) y1 = v.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pointInPoly(p: Vec[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i];
    const b = p[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function centroid(p: Vec[]): Vec {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j].x * p[i].y - p[i].x * p[j].y;
    cx += (p[j].x + p[i].x) * f;
    cy += (p[j].y + p[i].y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-6) {
    const b = polyBounds(p);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Closest point to (x, y) on segment a-b. */
export function closestOnSeg(ax: number, ay: number, bx: number, by: number, x: number, y: number): Vec {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  return { x: ax + dx * t, y: ay + dy * t };
}

/** Closest point on a closed polygon's boundary. */
export function closestOnPoly(p: Vec[], x: number, y: number): Vec {
  let best = p[0];
  let bd = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const c = closestOnSeg(p[j].x, p[j].y, p[i].x, p[i].y, x, y);
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Douglas-Peucker simplification (open polyline). */
export function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let md = -1;
    let mi = -1;
    for (let i = a + 1; i < b; i++) {
      const c = closestOnSeg(pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[i].x, pts[i].y);
      const d = (c.x - pts[i].x) ** 2 + (c.y - pts[i].y) ** 2;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol * tol) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed ring (no repeated closing vertex). */
export function simplifyRing(ring: Vec[], tol: number): Vec[] {
  if (ring.length <= 4) return ring;
  // split at the vertex farthest from the first one so both halves are well defined
  let far = 0;
  let fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i].x - ring[0].x) ** 2 + (ring[i].y - ring[0].y) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = simplify(ring.slice(0, far + 1), tol);
  const b = simplify([...ring.slice(far), ring[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : ring;
}

/** Direction (radians) of the longest edge: used as a building's main axis. */
export function mainAxis(p: Vec[]): number {
  let best = 0;
  let bl = -1;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const l = (p[i].x - p[j].x) ** 2 + (p[i].y - p[j].y) ** 2;
    if (l > bl) {
      bl = l;
      best = Math.atan2(p[i].y - p[j].y, p[i].x - p[j].x);
    }
  }
  return best;
}

export function polyPath(g: CanvasRenderingContext2D | Path2D, p: Vec[], dx = 0, dy = 0): void {
  g.moveTo(p[0].x + dx, p[0].y + dy);
  for (let i = 1; i < p.length; i++) g.lineTo(p[i].x + dx, p[i].y + dy);
  g.closePath();
}

export function linePath(g: CanvasRenderingContext2D | Path2D, p: Vec[]): void {
  g.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
}

/** Clip a polyline or ring roughly to a rect by dropping far-away vertices (cheap, render-safe). */
export function inRect(p: Vec, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

/** Sutherland-Hodgman clip of a polygon against an axis-aligned rect. */
export function clipPolyRect(p: Vec[], r: Rect): Vec[] {
  const edges: [(v: Vec) => boolean, (a: Vec, b: Vec) => Vec][] = [
    [(v) => v.x >= r.x, (a, b) => ({ x: r.x, y: a.y + ((b.y - a.y) * (r.x - a.x)) / (b.x - a.x) })],
    [(v) => v.x <= r.x + r.w, (a, b) => ({ x: r.x + r.w, y: a.y + ((b.y - a.y) * (r.x + r.w - a.x)) / (b.x - a.x) })],
    [(v) => v.y >= r.y, (a, b) => ({ x: a.x + ((b.x - a.x) * (r.y - a.y)) / (b.y - a.y), y: r.y })],
    [(v) => v.y <= r.y + r.h, (a, b) => ({ x: a.x + ((b.x - a.x) * (r.y + r.h - a.y)) / (b.y - a.y), y: r.y + r.h })],
  ];
  let out = p;
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    if (!src.length) break;
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length];
      const b = src[i];
      const ia = inside(a);
      const ib = inside(b);
      if (ib) {
        if (!ia) out.push(cut(a, b));
        out.push(b);
      } else if (ia) out.push(cut(a, b));
    }
  }
  return out;
}

/** Joins open polylines that share endpoints into rings (multipolygon outers). */
export function assembleRings(lines: Vec[][]): Vec[][] {
  const near = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05;
  const open = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const rings: Vec[][] = [];
  while (open.length) {
    let cur = open.pop()!;
    for (let guard = 0; guard < 2000 && !(cur.length > 3 && near(cur[0], cur[cur.length - 1])); guard++) {
      const end = cur[cur.length - 1];
      const i = open.findIndex((l) => near(l[0], end) || near(l[l.length - 1], end));
      if (i < 0) break;
      let l = open.splice(i, 1)[0];
      if (!near(l[0], end)) l = l.reverse();
      cur = cur.concat(l.slice(1));
    }
    if (cur.length >= 3) rings.push(near(cur[0], cur[cur.length - 1]) ? cur.slice(0, -1) : cur);
  }
  return rings;
}

/**
 * Even-odd scanline fill of a set of rings (outer ring plus holes): calls `span(y, x0, x1)` for
 * every horizontal run inside, sampling rows at y0 + step/2, y0 + 3step/2, ...
 */
export function scanRings(rings: Vec[][], y0: number, y1: number, step: number, span: (y: number, x0: number, x1: number) => void): void {
  const xs: number[] = [];
  for (let y = y0 + step / 2; y < y1; y += step) {
    xs.length = 0;
    for (const p of rings)
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i];
        const b = p[j];
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) span(y, xs[k], xs[k + 1]);
  }
}

/**
 * Sea areas inside the square [0, W]² built from OpenStreetMap coastline ways. Coastlines are
 * drawn with the land on their left and the water on their right, so each piece that crosses the
 * map is closed by walking clockwise along the map edge to the next piece. Islands that lie fully
 * inside the map become holes.
 */
export function seaPolygons(lines: Vec[][], W: number): { poly: Vec[]; holes: Vec[][] }[] {
  const near = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05;
  const isClosed = (c: Vec[]) => c.length > 3 && near(c[0], c[c.length - 1]);
  // 1. join ways head to tail into chains, keeping their direction
  const open = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const chains: Vec[][] = [];
  while (open.length) {
    let cur = open.pop()!;
    for (let guard = 0; guard < 5000 && !isClosed(cur); guard++) {
      const end = cur[cur.length - 1];
      const i = open.findIndex((l) => near(l[0], end));
      if (i >= 0) {
        cur = cur.concat(open.splice(i, 1)[0].slice(1));
        continue;
      }
      const start = cur[0];
      const j = open.findIndex((l) => near(l[l.length - 1], start));
      if (j < 0) break;
      cur = open.splice(j, 1)[0].concat(cur.slice(1));
    }
    chains.push(cur);
  }
  const inside = (p: Vec) => p.x > 0 && p.x < W && p.y > 0 && p.y < W;
  // an unfinished chain (data cut off) is extended straight to the nearest map edge
  const toEdge = (p: Vec): Vec => {
    const d = [p.y, W - p.x, W - p.y, p.x];
    const k = d.indexOf(Math.min(...d));
    return k === 0 ? { x: p.x, y: -1 } : k === 1 ? { x: W + 1, y: p.y } : k === 2 ? { x: p.x, y: W + 1 } : { x: -1, y: p.y };
  };
  // 2. clip chains to the map: pieces that enter and leave, and islands fully inside
  const pieces: Vec[][] = [];
  const islands: Vec[][] = [];
  for (let c of chains) {
    if (isClosed(c)) {
      if (c.every(inside)) {
        islands.push(c.slice(0, -1));
        continue;
      }
    } else {
      if (inside(c[0])) c = [toEdge(c[0]), ...c];
      if (inside(c[c.length - 1])) c = [...c, toEdge(c[c.length - 1])];
    }
    let cur: Vec[] | null = null;
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1];
      const b = c[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let t0 = 0;
      let t1 = 1;
      let ok = true;
      const pp = [-dx, dx, -dy, dy];
      const qq = [a.x, W - a.x, a.y, W - a.y];
      for (let k = 0; k < 4 && ok; k++) {
        if (pp[k] === 0) {
          if (qq[k] < 0) ok = false;
        } else {
          const r = qq[k] / pp[k];
          if (pp[k] < 0) {
            if (r > t1) ok = false;
            else if (r > t0) t0 = r;
          } else if (r < t0) ok = false;
          else if (r < t1) t1 = r;
        }
      }
      if (!ok) {
        if (cur) pieces.push(cur);
        cur = null;
        continue;
      }
      if (!cur) cur = [{ x: a.x + dx * t0, y: a.y + dy * t0 }];
      cur.push({ x: a.x + dx * t1, y: a.y + dy * t1 });
      if (t1 < 1) {
        pieces.push(cur);
        cur = null;
      }
    }
    if (cur) pieces.push(cur);
  }
  // 3. position along the map edge, clockwise from the top-left corner
  const tOf = (p: Vec) => {
    const d = [Math.abs(p.y), Math.abs(W - p.x), Math.abs(W - p.y), Math.abs(p.x)];
    const k = d.indexOf(Math.min(...d));
    return k === 0 ? p.x : k === 1 ? W + p.y : k === 2 ? 3 * W - p.x : 4 * W - p.y;
  };
  const P = 4 * W;
  const corners = [
    { t: 0, p: { x: 0, y: 0 } },
    { t: W, p: { x: W, y: 0 } },
    { t: 2 * W, p: { x: W, y: W } },
    { t: 3 * W, p: { x: 0, y: W } },
  ];
  const segs = pieces.filter((s) => s.length >= 2).map((s) => ({ pts: s, tIn: tOf(s[0]), tOut: tOf(s[s.length - 1]) }));
  const used = new Set<number>();
  const polys: Vec[][] = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used.has(s0)) continue;
    const poly: Vec[] = [];
    let cur = s0;
    for (let guard = 0; guard <= segs.length; guard++) {
      used.add(cur);
      poly.push(...segs[cur].pts);
      const tOut = segs[cur].tOut;
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < segs.length; k++) {
        if (used.has(k) && k !== s0) continue;
        const d = (((segs[k].tIn - tOut) % P) + P) % P;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best < 0) break;
      const passed = corners.map((c) => ({ ...c, d: (((c.t - tOut) % P) + P) % P })).filter((c) => c.d > 1e-6 && c.d < bd).sort((a, b) => a.d - b.d);
      for (const c of passed) poly.push(c.p);
      if (best === s0) break;
      cur = best;
    }
    if (poly.length >= 3) polys.push(poly);
  }
  // 4. a map with islands but no coastline crossing it lies entirely at sea
  if (!polys.length && islands.length) polys.push(corners.map((c) => c.p));
  return polys.map((poly) => ({ poly, holes: islands.filter((h) => pointInPoly(poly, h[0].x, h[0].y)) }));
}
