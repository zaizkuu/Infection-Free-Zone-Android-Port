import type { MapData, Prop } from './types';
import type { Rect, Vec } from '../core/math';
import { inRiver, vehicleSpots } from './mapgen';
import { pointInPoly, polyBounds, scanRings } from './geo';

export const CELL = 10;

/** Binary min-heap keyed by a Float64Array of priorities. */
class Heap {
  private items: number[] = [];
  constructor(private prio: Float64Array) {}
  get size() {
    return this.items.length;
  }
  clear() {
    this.items.length = 0;
  }
  push(i: number) {
    const a = this.items;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.prio[a[p]] <= this.prio[a[c]]) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < a.length && this.prio[a[l]] < this.prio[a[m]]) m = l;
        if (r < a.length && this.prio[a[r]] < this.prio[a[m]]) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export class NavGrid {
  readonly w: number;
  readonly h: number;
  /** 1 = blocked for walking. */
  readonly blocked: Uint8Array;
  /** 1 = blocks line of sight (buildings). */
  readonly opaque: Uint8Array;
  private g: Float64Array;
  private f: Float64Array;
  private from: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private cur = 0;
  private heap: Heap;

  constructor(map: MapData) {
    this.w = Math.ceil(map.width / CELL);
    this.h = Math.ceil(map.height / CELL);
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.opaque = new Uint8Array(n);
    this.g = new Float64Array(n);
    this.f = new Float64Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Heap(this.f);

    const markRect = (r: Rect, pad: number, opaque: boolean) => {
      const x0 = Math.max(0, Math.floor((r.x - pad) / CELL));
      const y0 = Math.max(0, Math.floor((r.y - pad) / CELL));
      const x1 = Math.min(this.w - 1, Math.floor((r.x + r.w + pad) / CELL));
      const y1 = Math.min(this.h - 1, Math.floor((r.y + r.h + pad) / CELL));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const cx = x * CELL + CELL / 2;
          const cy = y * CELL + CELL / 2;
          if (cx < r.x - pad || cx > r.x + r.w + pad || cy < r.y - pad || cy > r.y + r.h + pad) continue;
          this.blocked[y * this.w + x] = 1;
          if (opaque) this.opaque[y * this.w + x] = 1;
        }
    };
    for (const b of map.buildings) {
      if (b.poly) this.markPoly(b.poly, 1, 1);
      else markRect(b, 1, true);
    }
    // real-world water (lakes, river areas, streams); bridges are opened again below
    for (const wb of map.water ?? []) {
      if (wb.sea && wb.poly) {
        // the sea can be most of the map: fill it row by row, leaving islands (and their buildings) alone
        scanRings([wb.poly, ...(wb.holes ?? [])], 0, this.h * CELL, CELL, (y, x0, x1) => {
          const cy = Math.floor(y / CELL);
          for (let cx = Math.max(0, Math.ceil(x0 / CELL - 0.5)); cx <= Math.min(this.w - 1, Math.floor(x1 / CELL - 0.5)); cx++) this.blocked[cy * this.w + cx] = 1;
        });
      } else if (wb.poly) this.markPoly(wb.poly, 1, 0);
      if (wb.line && (wb.w ?? 0) >= 6) this.markLine(wb.line, (wb.w ?? 4) / 2 - 1, 1);
    }
    for (const wy of map.ways ?? []) if (wy.bridge) this.markLine(wy.pts, wy.w / 2 + 1, 0);
    // river (bridges stay open)
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const cx = x * CELL + CELL / 2;
        const cy = y * CELL + CELL / 2;
        if (!inRiver(map.river, cx, cy, -2)) continue;
        let onBridge = false;
        for (const br of map.bridges) if (cx >= br.x - 4 && cx <= br.x + br.w + 4 && cy >= br.y + 2 && cy <= br.y + br.h - 2) onBridge = true;
        if (!onBridge) this.blocked[y * this.w + x] = 1;
      }
    for (const a of map.areas) if (a.kind === 'pond') markRect({ x: a.x + 4, y: a.y + 4, w: a.w - 8, h: a.h - 8 }, 0, false);
    const vehicles = new Set(vehicleSpots(map));
    for (let pi = 0; pi < map.props.length; pi++) {
      const p = map.props[pi];
      if (!p.solid || vehicles.has(pi)) continue;
      if (p.kind === 'fountain') {
        markRect({ x: p.x - p.r + 3, y: p.y - p.r + 3, w: p.r * 2 - 6, h: p.r * 2 - 6 }, 0, false);
        continue;
      }
      for (const i of this.propCells(p)) this.blocked[i] = 1;
    }
  }

  /** Cells a solid prop (vehicle, container...) occupies: a few cells along its axis. */
  propCells(p: Prop): number[] {
    const L = p.kind === 'bus' ? 40 : p.kind === 'truck' || p.kind === 'container' ? 28 : p.kind === 'firetruck' ? 32 : p.kind === 'dumpster' ? 10 : 15;
    const c = Math.cos(p.a);
    const s = Math.sin(p.a);
    const out: number[] = [];
    for (let t = -L / 2 + 3; t <= L / 2 - 3; t += 5) {
      const x = Math.floor((p.x + c * t) / CELL);
      const y = Math.floor((p.y + s * t) / CELL);
      if (x >= 0 && y >= 0 && x < this.w && y < this.h) out.push(y * this.w + x);
    }
    return out;
  }

  /** Makes a scrapped prop walkable again. */
  clearProp(p: Prop): void {
    for (const i of this.propCells(p)) this.blocked[i] = 0;
  }

  /** Sets blocked (and opaque, for buildings) on cells whose centres lie inside a polygon. */
  markPoly(p: Vec[], blocked: 0 | 1, opaque: 0 | 1): void {
    const b = polyBounds(p);
    const x0 = Math.max(0, Math.floor(b.x / CELL));
    const y0 = Math.max(0, Math.floor(b.y / CELL));
    const x1 = Math.min(this.w - 1, Math.floor((b.x + b.w) / CELL));
    const y1 = Math.min(this.h - 1, Math.floor((b.y + b.h) / CELL));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!pointInPoly(p, x * CELL + CELL / 2, y * CELL + CELL / 2)) continue;
        const i = y * this.w + x;
        this.blocked[i] = blocked;
        if (opaque || !blocked) this.opaque[i] = opaque;
      }
  }

  /** Sets blocked on cells within `r` of a polyline. */
  markLine(pts: Vec[], r: number, blocked: 0 | 1): void {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (let s = 0; s <= len; s += CELL / 2) {
        const px = a.x + ((b.x - a.x) * s) / len;
        const py = a.y + ((b.y - a.y) * s) / len;
        const x0 = Math.max(0, Math.floor((px - r) / CELL));
        const y0 = Math.max(0, Math.floor((py - r) / CELL));
        const x1 = Math.min(this.w - 1, Math.floor((px + r) / CELL));
        const y1 = Math.min(this.h - 1, Math.floor((py + r) / CELL));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const cx = x * CELL + CELL / 2;
            const cy = y * CELL + CELL / 2;
            if ((cx - px) ** 2 + (cy - py) ** 2 <= r * r + CELL * CELL * 0.25) this.blocked[y * this.w + x] = blocked;
          }
      }
    }
  }

  /** Makes a demolished building's footprint walkable and see-through (rubble). */
  clearRect(r: Rect): void {
    const x0 = Math.max(0, Math.floor((r.x - 1) / CELL));
    const y0 = Math.max(0, Math.floor((r.y - 1) / CELL));
    const x1 = Math.min(this.w - 1, Math.floor((r.x + r.w + 1) / CELL));
    const y1 = Math.min(this.h - 1, Math.floor((r.y + r.h + 1) / CELL));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const cx = x * CELL + CELL / 2;
        const cy = y * CELL + CELL / 2;
        if (cx < r.x - 1 || cx > r.x + r.w + 1 || cy < r.y - 1 || cy > r.y + r.h + 1) continue;
        this.blocked[y * this.w + x] = 0;
        this.opaque[y * this.w + x] = 0;
      }
  }

  idx(x: number, y: number): number {
    return Math.floor(y / CELL) * this.w + Math.floor(x / CELL);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h;
  }

  isBlocked(x: number, y: number): boolean {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (!this.inBounds(cx, cy)) return true;
    return this.blocked[cy * this.w + cx] === 1;
  }

  nearestFree(x: number, y: number, maxR = 12): Vec {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (this.inBounds(cx, cy) && !this.blocked[cy * this.w + cx]) return { x, y };
    for (let r = 1; r <= maxR; r++) {
      let best: Vec | null = null;
      let bd = Infinity;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.inBounds(nx, ny) || this.blocked[ny * this.w + nx]) continue;
          const px = nx * CELL + CELL / 2;
          const py = ny * CELL + CELL / 2;
          const d = (px - x) ** 2 + (py - y) ** 2;
          if (d < bd) {
            bd = d;
            best = { x: px, y: py };
          }
        }
      if (best) return best;
    }
    return { x, y };
  }

  /** Walkability line test (for path smoothing). */
  walkLine(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.trace(x0, y0, x1, y1, this.blocked, 3);
  }

  /** Line of sight test against buildings only. */
  sightLine(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.trace(x0, y0, x1, y1, this.opaque, 0);
  }

  private trace(x0: number, y0: number, x1: number, y1: number, grid: Uint8Array, radius: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / (CELL * 0.45));
    const nx = (-(y1 - y0) / (d || 1)) * radius;
    const ny = ((x1 - x0) / (d || 1)) * radius;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (const o of radius ? [-1, 0, 1] : [0]) {
        const cx = Math.floor((x + nx * o) / CELL);
        const cy = Math.floor((y + ny * o) / CELL);
        if (!this.inBounds(cx, cy) || grid[cy * this.w + cx]) return false;
      }
    }
    return true;
  }

  /** A* path from (sx,sy) to (tx,ty). Returns smoothed waypoints (excluding start) or null. */
  findPath(sx: number, sy: number, tx: number, ty: number, maxNodes = 40000): Vec[] | null {
    const s = this.nearestFree(sx, sy, 3);
    const t = this.nearestFree(tx, ty, 20);
    const W = this.w;
    const start = this.idx(s.x, s.y);
    const goal = this.idx(t.x, t.y);
    if (start === goal) return [{ x: t.x, y: t.y }];
    this.cur++;
    const cur = this.cur;
    const gx = goal % W;
    const gy = (goal / W) | 0;
    const hfn = (i: number) => {
      const dx = Math.abs((i % W) - gx);
      const dy = Math.abs(((i / W) | 0) - gy);
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * 1.02;
    };
    this.heap.clear();
    this.g[start] = 0;
    this.f[start] = hfn(start);
    this.stamp[start] = cur;
    this.from[start] = -1;
    this.heap.push(start);
    let found = false;
    let expanded = 0;
    while (this.heap.size) {
      const c = this.heap.pop();
      if (this.closed[c] === cur) continue;
      this.closed[c] = cur;
      if (c === goal) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.h) continue;
        const n = ny * W + nx;
        if (this.blocked[n] || this.closed[n] === cur) continue;
        if (k >= 4 && (this.blocked[cy * W + nx] || this.blocked[ny * W + cx])) continue; // no corner cutting
        const ng = this.g[c] + COST[k];
        if (this.stamp[n] !== cur || ng < this.g[n]) {
          this.stamp[n] = cur;
          this.g[n] = ng;
          this.f[n] = ng + hfn(n);
          this.from[n] = c;
          this.heap.push(n);
        }
      }
    }
    if (!found) return null;
    const cells: Vec[] = [];
    for (let c = goal; c !== -1; c = this.from[c]) cells.push({ x: (c % W) * CELL + CELL / 2, y: ((c / W) | 0) * CELL + CELL / 2 });
    cells.reverse();
    cells[cells.length - 1] = { x: t.x, y: t.y };
    // string-pulling smoothing
    const out: Vec[] = [];
    let anchor = { x: s.x, y: s.y };
    let i = 0;
    while (i < cells.length) {
      let j = cells.length - 1;
      while (j > i && !this.walkLine(anchor.x, anchor.y, cells[j].x, cells[j].y)) j--;
      out.push(cells[j]);
      anchor = cells[j];
      i = j + 1;
    }
    return out;
  }

  /**
   * Dijkstra distance field from a set of target cells (used to steer hordes).
   * Returns distance in cell units (Infinity where unreachable).
   */
  flowField(targets: number[], penalty?: Int32Array): Float32Array {
    const n = this.w * this.h;
    const dist = new Float32Array(n).fill(Infinity);
    const prio = new Float64Array(n);
    const heap = new Heap(prio);
    for (const t of targets) {
      dist[t] = 0;
      prio[t] = 0;
      heap.push(t);
    }
    const W = this.w;
    while (heap.size) {
      const c = heap.pop();
      const d = dist[c];
      if (prio[c] > d) continue;
      const cx = c % W;
      const cy = (c / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.h) continue;
        const ni = ny * W + nx;
        if (this.blocked[ni]) continue;
        if (k >= 4 && (this.blocked[cy * W + nx] || this.blocked[ny * W + cx])) continue;
        const nd = d + COST[k] + (penalty && penalty[ni] >= 0 ? 25 : 0);
        if (nd < dist[ni]) {
          dist[ni] = nd;
          prio[ni] = nd;
          heap.push(ni);
        }
      }
    }
    return dist;
  }

  /** Cells just outside a rect that are walkable. */
  ringCells(r: Rect, pad = 6): number[] {
    const out: number[] = [];
    const x0 = Math.max(0, Math.floor((r.x - pad) / CELL));
    const y0 = Math.max(0, Math.floor((r.y - pad) / CELL));
    const x1 = Math.min(this.w - 1, Math.floor((r.x + r.w + pad) / CELL));
    const y1 = Math.min(this.h - 1, Math.floor((r.y + r.h + pad) / CELL));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * this.w + x;
        if (!this.blocked[i]) out.push(i);
      }
    return out;
  }
}
