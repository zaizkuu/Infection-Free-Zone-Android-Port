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
