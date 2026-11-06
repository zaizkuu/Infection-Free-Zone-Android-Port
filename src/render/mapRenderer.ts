import type { Area, BuildingDef, Fence, MapData, Prop, Road } from '../world/types';
import { buildTextures, makeCanvas, worldPattern, type Textures } from './textures';
import { hash2 } from '../core/rng';
import { shade, type Rect } from '../core/math';

const SIDEWALK = 8;
const IDX = 200; // spatial index bucket size in world units
const TILE = 256; // tile size in device pixels
export const LEVELS = [0.25, 0.354, 0.5, 0.707, 1, 1.414, 2, 2.83, 4, 5.66];
const MAX_TILES = 150;

interface Indexed {
  b: Rect; // bounds incl. shadow
}

class SpatialIndex {
  private cols: number;
  private rows: number;
  private buckets: number[][];
  private stamp: Uint32Array;
  private cur = 1;
  constructor(
    private items: Indexed[],
    w: number,
    h: number,
  ) {
    this.cols = Math.ceil(w / IDX) + 1;
    this.rows = Math.ceil(h / IDX) + 1;
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    this.stamp = new Uint32Array(items.length);
    items.forEach((it, i) => {
      const x0 = Math.max(0, Math.floor(it.b.x / IDX));
      const y0 = Math.max(0, Math.floor(it.b.y / IDX));
      const x1 = Math.min(this.cols - 1, Math.floor((it.b.x + it.b.w) / IDX));
      const y1 = Math.min(this.rows - 1, Math.floor((it.b.y + it.b.h) / IDX));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.buckets[y * this.cols + x].push(i);
    });
  }
  query(r: Rect): number[] {
    const out: number[] = [];
    this.cur++;
    const x0 = Math.max(0, Math.floor(r.x / IDX));
    const y0 = Math.max(0, Math.floor(r.y / IDX));
    const x1 = Math.min(this.cols - 1, Math.floor((r.x + r.w) / IDX));
    const y1 = Math.min(this.rows - 1, Math.floor((r.y + r.h) / IDX));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        for (const i of this.buckets[y * this.cols + x]) {
          if (this.stamp[i] === this.cur) continue;
          this.stamp[i] = this.cur;
          const b = this.items[i].b;
          if (b.x > r.x + r.w || b.x + b.w < r.x || b.y > r.y + r.h || b.y + b.h < r.y) continue;
          out.push(i);
        }
      }
    return out.sort((a, b) => a - b);
  }
}

const AREA_ORDER: Record<string, number> = {
  crops: 0,
  dirt: 1,
  lawn: 2,
  park: 2,
  yard: 3,
  graveyard: 3,
  concrete: 4,
  plaza: 5,
  track: 6,
  court: 6,
  parking: 7,
  driveway: 8,
  path: 9,
  pond: 10,
  pool: 11,
  lot: 1,
  field: 2,
};

const GROUND_PROPS = new Set(['debris', 'stone', 'hay', 'bench', 'barrier', 'dumpster', 'container', 'car', 'truck', 'firetruck', 'police', 'bus', 'shed', 'lamp', 'fountain', 'bush']);

interface Tile {
  c: HTMLCanvasElement;
  used: number;
  pinned: boolean;
}

export class MapRenderer {
  readonly tex: Textures;
  private areaIdx: SpatialIndex;
  private propIdx: SpatialIndex;
  private bldIdx: SpatialIndex;
  private fenceIdx: SpatialIndex;
  private areas: Area[];
  private props: Prop[];
  private fences: Fence[];
  private buildings: BuildingDef[];
  private crossings: [number, number][][];
  private tiles = new Map<string, Tile>();
  private frame = 0;
  private riverPoly: Path2D;
  private bankPoly: Path2D;
  private deepPoly: Path2D;
  private riverBounds: Rect;

  constructor(private map: MapData) {
    this.tex = buildTextures(map.seed, map.width, map.height);
    this.areas = [...map.areas].sort((a, b) => (AREA_ORDER[a.kind] ?? 0) - (AREA_ORDER[b.kind] ?? 0));
    this.props = map.props;
    this.fences = map.fences;
    this.buildings = [...map.buildings].sort((a, b) => a.y + a.h - (b.y + b.h));
    const pad = (r: Rect, p: number, sx = 0, sy = 0): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2 + sx, h: r.h + p * 2 + sy });
    this.areaIdx = new SpatialIndex(this.areas.map((a) => ({ b: pad(a, 2) })), map.width, map.height);
    this.propIdx = new SpatialIndex(
      this.props.map((p) => {
        const s = p.kind === 'canopy' ? Math.max(p.w ?? 0, p.h ?? 0) / 2 + 8 : p.kind === 'bus' ? 28 : p.kind === 'container' || p.kind === 'truck' || p.kind === 'firetruck' ? 22 : p.kind === 'fountain' ? p.r + 6 : Math.max(p.r * 2, 14);
        return { b: { x: p.x - s, y: p.y - s, w: s * 2 + 8, h: s * 2 + 8 } };
      }),
      map.width,
      map.height,
    );
    this.bldIdx = new SpatialIndex(this.buildings.map((b) => ({ b: pad(b, 18, b.wallH * 1.4, b.wallH * 1.0) })), map.width, map.height);
    this.fenceIdx = new SpatialIndex(
      this.fences.map((f) => ({ b: { x: Math.min(f.x1, f.x2) - 3, y: Math.min(f.y1, f.y2) - 3, w: Math.abs(f.x2 - f.x1) + 6, h: Math.abs(f.y2 - f.y1) + 6 } })),
      map.width,
      map.height,
    );
    // road crossings for skipping lane markings inside intersections
    this.crossings = map.roads.map((r) => {
      const out: [number, number][] = [];
      const vertical = r.x1 === r.x2;
      for (const o of map.roads) {
        if (o === r) continue;
        const ov = o.x1 === o.x2;
        if (ov === vertical) continue;
        if (vertical) {
          if (o.y1 >= r.y1 - 1 && o.y1 <= r.y2 + 1 && r.x1 >= o.x1 - 1 && r.x1 <= o.x2 + 1) out.push([o.y1 - o.w / 2 - SIDEWALK, o.y1 + o.w / 2 + SIDEWALK]);
        } else if (o.x1 >= r.x1 - 1 && o.x1 <= r.x2 + 1 && r.y1 >= o.y1 - 1 && r.y1 <= o.y2 + 1) out.push([o.x1 - o.w / 2 - SIDEWALK, o.x1 + o.w / 2 + SIDEWALK]);
      }
      return out;
    });
    // river polygons
    const rv = map.river;
    const poly = (half: number) => {
      const p = new Path2D();
      rv.pts.forEach((pt, i) => (i ? p.lineTo(pt.x - half, pt.y) : p.moveTo(pt.x - half, pt.y)));
      for (let i = rv.pts.length - 1; i >= 0; i--) p.lineTo(rv.pts[i].x + half, rv.pts[i].y);
      p.closePath();
      return p;
    };
    this.bankPoly = poly(rv.w / 2 + 7);
    this.riverPoly = poly(rv.w / 2);
    this.deepPoly = poly(rv.w / 2 - 10);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of rv.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    this.riverBounds = { x: minX - rv.w, y: -100, w: maxX - minX + rv.w * 2, h: map.height + 200 };
  }

  /** Pre-render the coarsest level so there is always a fallback to show. */
  warmup(): void {
    const s = LEVELS[0];
    const tw = TILE / s;
    for (let ty = 0; ty * tw < this.map.height; ty++) for (let tx = 0; tx * tw < this.map.width; tx++) this.getTile(0, tx, ty, true);
  }

  private getTile(level: number, tx: number, ty: number, force: boolean): Tile | null {
    const key = `${level}:${tx}:${ty}`;
    let t = this.tiles.get(key);
    if (t) {
      t.used = this.frame;
      return t;
    }
    if (!force) return null;
    const s = LEVELS[level];
    const tw = TILE / s;
    const c = makeCanvas(TILE, TILE);
    const g = c.getContext('2d')!;
    g.setTransform(s, 0, 0, s, -tx * tw * s, -ty * tw * s);
    const region = { x: tx * tw, y: ty * tw, w: tw, h: tw };
    g.beginPath();
    g.rect(region.x, region.y, region.w, region.h);
    g.clip();
    this.drawRegion(g, region, s);
    t = { c, used: this.frame, pinned: level === 0 };
    this.tiles.set(key, t);
    if (this.tiles.size > MAX_TILES) this.evict();
    return t;
  }

  private evict(): void {
    const arr = [...this.tiles.entries()].filter(([, t]) => !t.pinned).sort((a, b) => a[1].used - b[1].used);
    const n = this.tiles.size - MAX_TILES + 16;
    for (let i = 0; i < n && i < arr.length; i++) this.tiles.delete(arr[i][0]);
  }

  /**
   * Draws the static map onto the screen context.
   * camX/camY: world coordinate at the screen's top-left; scale: device px per world unit.
   */
  render(ctx: CanvasRenderingContext2D, camX: number, camY: number, scale: number, vw: number, vh: number, budgetMs = 9): void {
    this.frame++;
    let level = LEVELS.findIndex((l) => l >= scale * 0.97);
    if (level < 0) level = LEVELS.length - 1;
    const s = LEVELS[level];
    const tw = TILE / s;
    const wx1 = camX + vw / scale;
    const wy1 = camY + vh / scale;
    const tx0 = Math.floor(camX / tw);
    const ty0 = Math.floor(camY / tw);
    const tx1 = Math.floor(wx1 / tw);
    const ty1 = Math.floor(wy1 / tw);
    const start = performance.now();
    const missing: [number, number][] = [];
    const ready: [Tile, number, number][] = [];
    // Prioritise tiles near the centre of the screen.
    const cx = (tx0 + tx1) / 2;
    const cy = (ty0 + ty1) / 2;
    const order: [number, number][] = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) order.push([tx, ty]);
    order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const [tx, ty] of order) {
      if (tx < 0 || ty < 0 || tx * tw > this.map.width || ty * tw > this.map.height) continue;
      const canRender = level === 0 || performance.now() - start < budgetMs;
      const t = this.getTile(level, tx, ty, canRender);
      if (t) ready.push([t, tx, ty]);
      else missing.push([tx, ty]);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (missing.length && level > 0) {
      // Fallback: draw the coarsest level under everything.
      const s0 = LEVELS[0];
      const tw0 = TILE / s0;
      for (let ty = Math.floor(camY / tw0); ty <= Math.floor(wy1 / tw0); ty++)
        for (let tx = Math.floor(camX / tw0); tx <= Math.floor(wx1 / tw0); tx++) {
          const t = this.getTile(0, tx, ty, false);
          if (!t) continue;
          const x0 = Math.round((tx * tw0 - camX) * scale);
          const y0 = Math.round((ty * tw0 - camY) * scale);
          const x1 = Math.round(((tx + 1) * tw0 - camX) * scale);
          const y1 = Math.round(((ty + 1) * tw0 - camY) * scale);
          ctx.drawImage(t.c, x0, y0, x1 - x0, y1 - y0);
        }
    }
    for (const [t, tx, ty] of ready) {
      const x0 = Math.round((tx * tw - camX) * scale);
      const y0 = Math.round((ty * tw - camY) * scale);
      const x1 = Math.round(((tx + 1) * tw - camX) * scale);
      const y1 = Math.round(((ty + 1) * tw - camY) * scale);
      ctx.drawImage(t.c, x0, y0, x1 - x0, y1 - y0);
    }
  }

  /** True when every tile needed for this view is cached. */
  get tileCount(): number {
    return this.tiles.size;
  }

  // ---------------------------------------------------------------------------
  // Region drawing (world coordinates)
  // ---------------------------------------------------------------------------

  drawRegion(g: CanvasRenderingContext2D, r: Rect, scale: number): void {
    const T = this.tex;
    // Ground
    g.imageSmoothingEnabled = true;
    g.drawImage(T.ground, 0, 0, T.ground.width, T.ground.height, 0, 0, this.map.width, this.map.height);
    if (scale >= 0.5) {
      g.globalAlpha = 0.55;
      g.fillStyle = worldPattern(g, T.grass);
      g.fillRect(r.x, r.y, r.w, r.h);
      g.globalAlpha = 1;
    }

    // Areas
    for (const i of this.areaIdx.query(r)) this.drawArea(g, this.areas[i], scale);

    // River
    if (r.x < this.riverBounds.x + this.riverBounds.w && r.x + r.w > this.riverBounds.x) this.drawRiver(g, scale);

    // Bridges (deck under roads)
    for (const b of this.map.bridges) {
      if (b.x > r.x + r.w || b.x + b.w < r.x || b.y > r.y + r.h || b.y + b.h < r.y) continue;
      g.fillStyle = 'rgba(10,25,35,0.35)';
      g.fillRect(b.x + 4, b.y + 6, b.w, b.h);
      g.fillStyle = '#8d8a83';
      g.fillRect(b.x, b.y, b.w, b.h);
    }

    // Roads
    const roads = this.map.roads.filter((rd) => this.roadRect(rd, SIDEWALK + 2).x < r.x + r.w && intersects(this.roadRect(rd, SIDEWALK + 2), r));
    for (const rd of roads) {
      const rr = this.roadRect(rd, SIDEWALK);
      g.fillStyle = rd.bridge ? '#9a978f' : '#a9a598';
      g.fillRect(rr.x, rr.y, rr.w, rr.h);
    }
    if (scale >= 0.5)
      for (const rd of roads) {
        if (rd.bridge) continue;
        const rr = this.roadRect(rd, SIDEWALK);
        g.globalAlpha = 0.6;
        g.fillStyle = worldPattern(g, T.concrete);
        g.fillRect(rr.x, rr.y, rr.w, rr.h);
        g.globalAlpha = 1;
        // slab joints
        if (scale >= 1) {
          g.strokeStyle = 'rgba(70,66,58,0.28)';
          g.lineWidth = 0.6;
          g.beginPath();
          const vertical = rd.x1 === rd.x2;
          const len = vertical ? rd.y2 - rd.y1 : rd.x2 - rd.x1;
          for (let s = 0; s < len; s += 10) {
            if (vertical) {
              const y = rd.y1 + s;
              if (y < r.y - 2 || y > r.y + r.h + 2) continue;
              g.moveTo(rr.x, y);
              g.lineTo(rr.x + SIDEWALK, y);
              g.moveTo(rr.x + rr.w - SIDEWALK, y);
              g.lineTo(rr.x + rr.w, y);
            } else {
              const x = rd.x1 + s;
              if (x < r.x - 2 || x > r.x + r.w + 2) continue;
              g.moveTo(x, rr.y);
              g.lineTo(x, rr.y + SIDEWALK);
              g.moveTo(x, rr.y + rr.h - SIDEWALK);
              g.lineTo(x, rr.y + rr.h);
            }
          }
          g.stroke();
        }
      }
    for (const rd of roads) {
      const rr = this.roadRect(rd, 0);
      g.fillStyle = rd.main ? '#3a3e44' : '#41454b';
      g.fillRect(rr.x, rr.y, rr.w, rr.h);
    }
    if (scale >= 0.5) {
      g.fillStyle = worldPattern(g, T.asphalt);
      for (const rd of roads) {
        const rr = this.roadRect(rd, 0);
        g.fillRect(rr.x, rr.y, rr.w, rr.h);
      }
    }
    for (let i = 0; i < roads.length; i++) this.drawRoadDetails(g, roads[i], r, scale);

    // Bridge railings
    for (const b of this.map.bridges) {
      if (b.x > r.x + r.w || b.x + b.w < r.x || b.y > r.y + r.h || b.y + b.h < r.y) continue;
      g.fillStyle = '#c9c5bb';
      g.fillRect(b.x, b.y, b.w, 2);
      g.fillRect(b.x, b.y + b.h - 2, b.w, 2);
      g.fillStyle = '#6f6c66';
      for (let x = b.x; x < b.x + b.w; x += 8) {
        g.fillRect(x, b.y - 0.5, 1.5, 3);
        g.fillRect(x, b.y + b.h - 2.5, 1.5, 3);
      }
    }

    // Fences
    for (const i of this.fenceIdx.query(r)) this.drawFence(g, this.fences[i]);

    // Shadows (single union fill so overlaps don't double-darken)
    const propIds = this.propIdx.query(r);
    const bldIds = this.bldIdx.query(r);
    g.fillStyle = 'rgba(18,24,30,0.32)';
    g.beginPath();
    for (const i of bldIds) {
      const b = this.buildings[i];
      const sx = b.wallH * 1.1;
      const sy = b.wallH * 0.75;
      g.moveTo(b.x, b.y);
      g.lineTo(b.x + b.w, b.y);
      g.lineTo(b.x + b.w + sx, b.y + sy);
      g.lineTo(b.x + b.w + sx, b.y + b.h + sy);
      g.lineTo(b.x + sx, b.y + b.h + sy);
      g.lineTo(b.x, b.y + b.h);
      g.closePath();
      if (b.deco === 'steeple') {
        const t = steepleRect(b);
        g.moveTo(t.x + t.w, t.y);
        g.lineTo(t.x + t.w + 34, t.y + 24);
        g.lineTo(t.x + 34, t.y + t.h + 24);
        g.lineTo(t.x, t.y + t.h);
        g.closePath();
      }
    }
    for (const i of propIds) {
      const p = this.props[i];
      if (p.kind === 'tree' || p.kind === 'pine') {
        const rr = p.r;
        g.moveTo(p.x + rr * 0.55 + rr, p.y + rr * 0.45);
        g.ellipse(p.x + rr * 0.55, p.y + rr * 0.45, rr, rr * 0.92, 0, 0, Math.PI * 2);
      } else if (p.kind === 'canopy') {
        const w = p.w ?? 40;
        const h = p.h ?? 30;
        g.rect(p.x - w / 2 + 6, p.y - h / 2 + 5, w, h);
      } else if (p.kind === 'lamp') {
        g.moveTo(p.x, p.y);
        g.lineTo(p.x + 14, p.y + 10);
        g.lineTo(p.x + 15, p.y + 9);
        g.lineTo(p.x + 1, p.y - 1);
        g.closePath();
      } else {
        const d = propDims(p);
        if (!d) continue;
        rotRect(g, p.x + 1.8, p.y + 1.4, d[0], d[1], p.a);
      }
    }
    g.fill();

    // Ground props
    for (const i of propIds) {
      const p = this.props[i];
      if (GROUND_PROPS.has(p.kind)) this.drawProp(g, p, scale);
    }
    // Buildings
    for (const i of bldIds) this.drawBuilding(g, this.buildings[i], scale);
    // Canopies & trees on top
    for (const i of propIds) {
      const p = this.props[i];
      if (p.kind === 'canopy') this.drawProp(g, p, scale);
    }
    const trees = propIds.filter((i) => this.props[i].kind === 'tree' || this.props[i].kind === 'pine');
    trees.sort((a, b) => this.props[a].y - this.props[b].y);
    for (const i of trees) this.drawTree(g, this.props[i], scale);
  }

  private roadRect(rd: Road, extra: number): Rect {
    if (rd.x1 === rd.x2) return { x: rd.x1 - rd.w / 2 - extra, y: rd.y1 - rd.w / 2 - (rd.y1 < 0 ? 0 : extra), w: rd.w + extra * 2, h: rd.y2 - rd.y1 + rd.w + extra * 2 };
    return { x: rd.x1 - rd.w / 2 - extra, y: rd.y1 - rd.w / 2 - extra, w: rd.x2 - rd.x1 + rd.w + extra * 2, h: rd.w + extra * 2 };
  }

  private drawRoadDetails(g: CanvasRenderingContext2D, rd: Road, r: Rect, scale: number): void {
    const idx = this.map.roads.indexOf(rd);
    const cross = this.crossings[idx];
    const vertical = rd.x1 === rd.x2;
    const a0 = vertical ? rd.y1 : rd.x1;
    const a1 = vertical ? rd.y2 : rd.x2;
    const inCross = (s: number) => cross.some(([c0, c1]) => s > c0 && s < c1);
    const seg = (s0: number, s1: number, off: number, w: number) => {
      if (vertical) g.fillRect(rd.x1 + off - w / 2, s0, w, s1 - s0);
      else g.fillRect(s0, rd.y1 + off - w / 2, s1 - s0, w);
    };
    const lo = vertical ? r.y - 20 : r.x - 20;
    const hi = vertical ? r.y + r.h + 20 : r.x + r.w + 20;
    // patches & cracks
    if (scale >= 0.7) {
      for (let s = Math.max(a0, Math.floor(lo / 40) * 40); s < Math.min(a1, hi); s += 40) {
        const h = hash2(Math.floor(s / 40), idx, 11);
        if (h < 0.35) {
          const off = (hash2(s, idx, 3) - 0.5) * rd.w * 0.6;
          const len = 10 + hash2(s, idx, 5) * 22;
          g.fillStyle = h < 0.15 ? 'rgba(25,27,30,0.18)' : 'rgba(95,98,102,0.12)';
          if (vertical) g.fillRect(rd.x1 + off - 4, s, 8 + hash2(s, idx, 9) * 6, len);
          else g.fillRect(s, rd.y1 + off - 4, len, 8 + hash2(s, idx, 9) * 6);
        }
        if (h > 0.8) {
          g.strokeStyle = 'rgba(20,22,25,0.45)';
          g.lineWidth = 0.6;
          g.beginPath();
          let px = vertical ? rd.x1 + (h - 0.9) * rd.w : s;
          let py = vertical ? s : rd.y1 + (h - 0.9) * rd.w;
          g.moveTo(px, py);
          for (let q = 0; q < 4; q++) {
            px += vertical ? (hash2(q, s, 1) - 0.5) * 6 : 4 + hash2(q, s, 2) * 4;
            py += vertical ? 4 + hash2(q, s, 2) * 4 : (hash2(q, s, 1) - 0.5) * 6;
            g.lineTo(px, py);
          }
          g.stroke();
        }
      }
    }
    // curb edge
    g.fillStyle = 'rgba(30,32,35,0.5)';
    seg(Math.max(a0, lo), Math.min(a1, hi), -rd.w / 2 + 0.5, 1);
    seg(Math.max(a0, lo), Math.min(a1, hi), rd.w / 2 - 0.5, 1);
    if (rd.bridge && !rd.main) {
      // fine
    }
    // lane markings
    if (rd.main) {
      g.fillStyle = 'rgba(214,176,74,0.85)';
      let s = a0;
      const step = 4;
      while (s < a1) {
        if (s > hi) break;
        let e = s;
        while (e < a1 && !inCross(e)) e += step;
        if (e > s && e > lo) {
          seg(s, e, -1.4, 1);
          seg(s, e, 1.4, 1);
        }
        s = e + step;
        while (s < a1 && inCross(s)) s += step;
      }
      g.fillStyle = 'rgba(230,228,220,0.55)';
      for (let d = a0 + 6; d < a1; d += 26) {
        if (d < lo || d > hi || inCross(d) || inCross(d + 12)) continue;
        seg(d, d + 12, -rd.w / 4, 1);
        seg(d, d + 12, rd.w / 4, 1);
      }
      // crosswalks
      g.fillStyle = 'rgba(232,230,222,0.7)';
      for (const [c0, c1] of cross) {
        for (const at of [c0 - 6, c1 + 1]) {
          if (at < a0 || at > a1 || at < lo || at > hi) continue;
          for (let q = -rd.w / 2 + 3; q < rd.w / 2 - 2; q += 4.5) {
            if (vertical) g.fillRect(rd.x1 + q, at, 2.5, 5);
            else g.fillRect(at, rd.y1 + q, 5, 2.5);
          }
        }
      }
    } else {
      g.fillStyle = 'rgba(225,215,170,0.55)';
      for (let d = a0 + 10; d < a1; d += 22) {
        if (d < lo || d > hi || inCross(d) || inCross(d + 10)) continue;
        seg(d, d + 10, 0, 1);
      }
    }
  }

  private drawRiver(g: CanvasRenderingContext2D, scale: number): void {
    g.fillStyle = '#7e7552';
    g.fill(this.bankPoly);
    g.fillStyle = '#4b7a85';
    g.fill(this.riverPoly);
    g.fillStyle = '#356377';
    g.fill(this.deepPoly);
    if (scale >= 0.5) {
      g.save();
      g.clip(this.riverPoly);
      g.fillStyle = worldPattern(g, this.tex.water);
      g.fillRect(this.riverBounds.x, this.riverBounds.y, this.riverBounds.w, this.riverBounds.h);
      g.restore();
    }
    g.strokeStyle = 'rgba(200,225,230,0.25)';
    g.lineWidth = 1;
    g.stroke(this.riverPoly);
  }

  private drawFence(g: CanvasRenderingContext2D, f: Fence): void {
    g.lineCap = 'round';
    switch (f.kind) {
      case 'hedge':
        g.strokeStyle = '#2f4d2a';
        g.lineWidth = 5;
        line(g, f.x1, f.y1, f.x2, f.y2);
        g.strokeStyle = '#4a6e3a';
        g.lineWidth = 3;
        line(g, f.x1 - 0.5, f.y1 - 0.5, f.x2 - 0.5, f.y2 - 0.5);
        break;
      case 'chain':
        g.strokeStyle = 'rgba(150,158,165,0.7)';
        g.lineWidth = 0.8;
        g.setLineDash([2, 1.5]);
        line(g, f.x1, f.y1, f.x2, f.y2);
        g.setLineDash([]);
        break;
      case 'wall':
        g.strokeStyle = '#6e6a62';
        g.lineWidth = 3;
        line(g, f.x1 + 0.6, f.y1 + 0.6, f.x2 + 0.6, f.y2 + 0.6);
        g.strokeStyle = '#a19b90';
        g.lineWidth = 2.2;
        line(g, f.x1, f.y1, f.x2, f.y2);
        break;
      default:
        g.strokeStyle = 'rgba(92,72,52,0.85)';
        g.lineWidth = 1.2;
        line(g, f.x1, f.y1, f.x2, f.y2);
    }
    g.lineCap = 'butt';
  }

  private drawArea(g: CanvasRenderingContext2D, a: Area, scale: number): void {
    const T = this.tex;
    switch (a.kind) {
      case 'lawn':
      case 'yard': {
        const cols = ['#6f8e4b', '#76924f', '#6a8a49', '#7d9254', '#71904d'];
        g.fillStyle = cols[Math.floor(a.v * cols.length)];
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.globalAlpha = 0.5;
          g.fillStyle = worldPattern(g, T.grass);
          g.fillRect(a.x, a.y, a.w, a.h);
          g.globalAlpha = 1;
        }
        break;
      }
      case 'park':
        g.fillStyle = '#668c47';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.globalAlpha = 0.5;
          g.fillStyle = worldPattern(g, T.grass);
          g.fillRect(a.x, a.y, a.w, a.h);
          g.globalAlpha = 1;
        }
        break;
      case 'graveyard':
        g.fillStyle = '#5f7c46';
        g.fillRect(a.x, a.y, a.w, a.h);
        break;
      case 'concrete':
      case 'plaza': {
        g.fillStyle = a.kind === 'plaza' ? '#b3ab9b' : '#999891';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.globalAlpha = 0.7;
          g.fillStyle = worldPattern(g, T.concrete);
          g.fillRect(a.x, a.y, a.w, a.h);
          g.globalAlpha = 1;
        }
        if (scale >= 0.9) {
          const step = a.kind === 'plaza' ? 10 : 22;
          g.strokeStyle = a.kind === 'plaza' ? 'rgba(120,110,95,0.35)' : 'rgba(80,78,72,0.25)';
          g.lineWidth = 0.5;
          g.beginPath();
          for (let x = a.x + step; x < a.x + a.w; x += step) {
            g.moveTo(x, a.y);
            g.lineTo(x, a.y + a.h);
          }
          for (let y = a.y + step; y < a.y + a.h; y += step) {
            g.moveTo(a.x, y);
            g.lineTo(a.x + a.w, y);
          }
          g.stroke();
        }
        // oil stains
        g.fillStyle = 'rgba(40,40,40,0.12)';
        for (let i = 0; i < (a.w * a.h) / 3000; i++) {
          const x = a.x + hash2(i, a.x, 1) * a.w;
          const y = a.y + hash2(i, a.y, 2) * a.h;
          g.beginPath();
          g.ellipse(x, y, 3 + hash2(i, 3, 3) * 6, 2 + hash2(i, 4, 4) * 4, hash2(i, 5, 5) * 3, 0, Math.PI * 2);
          g.fill();
        }
        break;
      }
      case 'parking': {
        g.fillStyle = '#4a4e53';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.fillStyle = worldPattern(g, T.asphalt);
          g.fillRect(a.x, a.y, a.w, a.h);
        }
        g.strokeStyle = 'rgba(225,222,210,0.55)';
        g.lineWidth = 0.8;
        g.beginPath();
        const stallW = 12;
        const stallD = 22;
        if (!a.o) {
          for (let row = 0; row * stallD + stallD <= a.h; row++) {
            if (row % 3 === 2) continue;
            for (let x = a.x + 4; x <= a.x + a.w - 2; x += stallW) {
              g.moveTo(x, a.y + row * stallD + 2);
              g.lineTo(x, a.y + row * stallD + stallD - 2);
            }
          }
        } else {
          for (let col = 0; col * stallD + stallD <= a.w; col++) {
            if (col % 3 === 2) continue;
            for (let y = a.y + 4; y <= a.y + a.h - 2; y += stallW) {
              g.moveTo(a.x + col * stallD + 2, y);
              g.lineTo(a.x + col * stallD + stallD - 2, y);
            }
          }
        }
        g.stroke();
        break;
      }
      case 'driveway':
        g.fillStyle = '#aaa597';
        g.fillRect(a.x, a.y, a.w, a.h);
        break;
      case 'path':
        g.fillStyle = '#bdb39c';
        g.fillRect(a.x, a.y, a.w, a.h);
        break;
      case 'dirt':
      case 'lot':
        g.fillStyle = '#8b7757';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.fillStyle = worldPattern(g, T.dirt);
          g.fillRect(a.x, a.y, a.w, a.h);
        }
        break;
      case 'crops': {
        g.fillStyle = '#7a7442';
        g.fillRect(a.x, a.y, a.w, a.h);
        const rowCol = a.v < 0.5 ? '#5f7436' : '#8f8248';
        g.strokeStyle = rowCol;
        g.lineWidth = 3;
        g.beginPath();
        if (a.o) {
          for (let x = a.x + 3; x < a.x + a.w; x += 7) {
            g.moveTo(x, a.y + 2);
            g.lineTo(x, a.y + a.h - 2);
          }
        } else {
          for (let y = a.y + 3; y < a.y + a.h; y += 7) {
            g.moveTo(a.x + 2, y);
            g.lineTo(a.x + a.w - 2, y);
          }
        }
        g.stroke();
        g.strokeStyle = 'rgba(70,60,35,0.4)';
        g.lineWidth = 2;
        g.strokeRect(a.x, a.y, a.w, a.h);
        break;
      }
      case 'track': {
        g.fillStyle = '#6b9447';
        g.fillRect(a.x, a.y, a.w, a.h);
        const rr = Math.min(a.w, a.h) / 2 - 4;
        g.strokeStyle = '#a65a43';
        g.lineWidth = 10;
        roundRectPath(g, a.x + 9, a.y + 9, a.w - 18, a.h - 18, rr - 5);
        g.stroke();
        g.strokeStyle = 'rgba(240,235,225,0.5)';
        g.lineWidth = 0.6;
        roundRectPath(g, a.x + 9, a.y + 9, a.w - 18, a.h - 18, rr - 5);
        g.stroke();
        g.strokeStyle = 'rgba(245,245,240,0.7)';
        g.lineWidth = 0.8;
        const ix = a.x + 26;
        const iy = a.y + 26;
        const iw = a.w - 52;
        const ih = a.h - 52;
        if (iw > 20 && ih > 20) {
          g.strokeRect(ix, iy, iw, ih);
          g.beginPath();
          g.moveTo(ix + iw / 2, iy);
          g.lineTo(ix + iw / 2, iy + ih);
          g.stroke();
          g.beginPath();
          g.arc(ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.15, 0, Math.PI * 2);
          g.stroke();
        }
        break;
      }
      case 'court':
        g.fillStyle = '#3f6a80';
        g.fillRect(a.x, a.y, a.w, a.h);
        g.fillStyle = '#b8643f';
        g.fillRect(a.x + 4, a.y + 4, a.w - 8, a.h - 8);
        g.strokeStyle = 'rgba(245,245,240,0.8)';
        g.lineWidth = 0.7;
        g.strokeRect(a.x + 4, a.y + 4, a.w - 8, a.h - 8);
        g.beginPath();
        g.moveTo(a.x + a.w / 2, a.y + 4);
        g.lineTo(a.x + a.w / 2, a.y + a.h - 4);
        g.stroke();
        g.beginPath();
        g.arc(a.x + a.w / 2, a.y + a.h / 2, 5, 0, Math.PI * 2);
        g.stroke();
        break;
      case 'pond': {
        const cx = a.x + a.w / 2;
        const cy = a.y + a.h / 2;
        g.fillStyle = '#7e7552';
        g.beginPath();
        g.ellipse(cx, cy, a.w / 2 + 4, a.h / 2 + 4, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#4b7a85';
        g.beginPath();
        g.ellipse(cx, cy, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#386679';
        g.beginPath();
        g.ellipse(cx + 2, cy + 2, a.w / 2 - 7, a.h / 2 - 6, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(210,235,240,0.35)';
        g.lineWidth = 0.8;
        g.beginPath();
        g.ellipse(cx - a.w * 0.12, cy - a.h * 0.1, a.w * 0.18, a.h * 0.08, 0, Math.PI, Math.PI * 1.8);
        g.stroke();
        break;
      }
      case 'pool': {
        g.fillStyle = '#d7d3c8';
        g.fillRect(a.x - 2, a.y - 2, a.w + 4, a.h + 4);
        // abandoned pools turn green
        g.fillStyle = a.v < 0.5 ? '#5e9d8e' : '#6a8f5c';
        g.fillRect(a.x, a.y, a.w, a.h);
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(a.x + 1, a.y + 1, a.w - 2, 2);
        break;
      }
      default:
        break;
    }
  }

  private drawTree(g: CanvasRenderingContext2D, p: Prop, scale: number): void {
    const r = p.r;
    if (p.kind === 'pine') {
      const n = 9;
      g.fillStyle = '#26472f';
      starPath(g, p.x, p.y, r, r * 0.72, n, p.a);
      g.fill();
      g.fillStyle = '#335c3b';
      starPath(g, p.x - r * 0.12, p.y - r * 0.14, r * 0.7, r * 0.5, n, p.a + 0.3);
      g.fill();
      if (scale >= 0.7) {
        g.fillStyle = '#41704a';
        starPath(g, p.x - r * 0.2, p.y - r * 0.24, r * 0.36, r * 0.26, 7, p.a);
        g.fill();
      }
      return;
    }
    const v = p.v;
    let base = '#3f6a35';
    let mid = '#4f7d3d';
    let hi = '#679a4b';
    if (v < 0.07) {
      base = '#6e5a2c';
      mid = '#8f7434';
      hi = '#b0913f';
    } else if (v < 0.11) {
      base = '#6b3a24';
      mid = '#94512c';
      hi = '#b86c38';
    } else if (v < 0.4) {
      base = '#3a6331';
      mid = '#48763a';
      hi = '#5f9046';
    } else if (v > 0.85) {
      base = '#456b39';
      mid = '#5a8443';
      hi = '#78a356';
    }
    if (v > 0.965) {
      // dead tree: bare branches
      g.strokeStyle = '#4d4034';
      g.lineWidth = 1.4;
      g.lineCap = 'round';
      for (let k = 0; k < 6; k++) {
        const a = p.a + (k / 6) * Math.PI * 2;
        line(g, p.x, p.y, p.x + Math.cos(a) * r * 0.9, p.y + Math.sin(a) * r * 0.9);
      }
      g.lineCap = 'butt';
      return;
    }
    g.fillStyle = base;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = mid;
    g.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = p.a + (k / 4) * Math.PI * 2;
      const cx = p.x + Math.cos(a) * r * 0.36 - r * 0.08;
      const cy = p.y + Math.sin(a) * r * 0.36 - r * 0.1;
      g.moveTo(cx + r * 0.55, cy);
      g.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    }
    g.fill();
    if (scale >= 0.6) {
      g.fillStyle = hi;
      g.beginPath();
      g.arc(p.x - r * 0.3, p.y - r * 0.32, r * 0.38, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,230,0.12)';
      g.beginPath();
      g.arc(p.x - r * 0.38, p.y - r * 0.42, r * 0.18, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawProp(g: CanvasRenderingContext2D, p: Prop, scale: number): void {
    switch (p.kind) {
      case 'car':
      case 'police':
      case 'truck':
      case 'firetruck':
      case 'bus':
        drawVehicle(g, p, scale);
        break;
      case 'bush':
        g.fillStyle = '#3d6131';
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#527f3e';
        g.beginPath();
        g.arc(p.x - p.r * 0.25, p.y - p.r * 0.3, p.r * 0.6, 0, Math.PI * 2);
        g.fill();
        break;
      case 'dumpster':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = p.c;
        g.fillRect(-6, -3.5, 12, 7);
        g.fillStyle = shade(p.c, -0.3);
        g.fillRect(-6, -0.3, 12, 0.8);
        g.restore();
        break;
      case 'container':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = p.c;
        g.fillRect(-15, -5, 30, 10);
        g.strokeStyle = shade(p.c, -0.28);
        g.lineWidth = 0.6;
        g.beginPath();
        for (let x = -13; x < 15; x += 2.5) {
          g.moveTo(x, -5);
          g.lineTo(x, 5);
        }
        g.stroke();
        g.strokeStyle = shade(p.c, 0.2);
        g.strokeRect(-15, -5, 30, 10);
        g.restore();
        break;
      case 'bench':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = '#6d5139';
        g.fillRect(-4.5, -1.3, 9, 2.6);
        g.fillStyle = '#8a6a4a';
        g.fillRect(-4.5, -1.3, 9, 0.9);
        g.restore();
        break;
      case 'lamp':
        g.fillStyle = '#3b3f44';
        g.beginPath();
        g.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#4a4f55';
        g.lineWidth = 0.9;
        line(g, p.x, p.y, p.x + Math.cos(p.a) * 6, p.y + Math.sin(p.a) * 6);
        g.fillStyle = '#7d8288';
        g.fillRect(p.x + Math.cos(p.a) * 6 - 1.5, p.y + Math.sin(p.a) * 6 - 1, 3, 2);
        break;
      case 'debris':
        g.fillStyle = p.c;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.beginPath();
        g.moveTo(-p.r, -p.r * 0.4);
        g.lineTo(p.r * 0.6, -p.r * 0.7);
        g.lineTo(p.r, p.r * 0.3);
        g.lineTo(-p.r * 0.3, p.r * 0.8);
        g.closePath();
        g.fill();
        g.restore();
        break;
      case 'stone':
        g.fillStyle = '#8d8e8b';
        g.fillRect(p.x - 2, p.y - 1.4, 4, 2.8);
        g.fillStyle = '#b2b3ae';
        g.fillRect(p.x - 2, p.y - 1.4, 4, 0.9);
        break;
      case 'hay':
        g.fillStyle = '#c7a75a';
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#9b7f3e';
        g.lineWidth = 0.6;
        g.beginPath();
        g.arc(p.x, p.y, p.r * 0.55, 0, Math.PI * 1.6);
        g.stroke();
        break;
      case 'barrier':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = '#e6e2d8';
        g.fillRect(-7, -1.5, 14, 3);
        g.fillStyle = '#c0392b';
        for (let x = -7; x < 7; x += 3.5) g.fillRect(x, -1.5, 1.75, 3);
        g.restore();
        break;
      case 'shed':
        g.fillStyle = shade(p.c, -0.25);
        g.fillRect(p.x - 6, p.y - 1, 12, 5);
        g.fillStyle = p.c;
        g.fillRect(p.x - 6, p.y - 6, 12, 5.5);
        g.fillStyle = shade(p.c, 0.15);
        g.fillRect(p.x - 6, p.y - 6, 12, 2.6);
        break;
      case 'fountain':
        g.fillStyle = '#a49c8c';
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#4a7a82';
        g.beginPath();
        g.arc(p.x, p.y, p.r - 3, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#c4bcac';
        g.beginPath();
        g.arc(p.x, p.y, 4, 0, Math.PI * 2);
        g.fill();
        break;
      case 'canopy': {
        const w = p.w ?? 40;
        const h = p.h ?? 30;
        g.fillStyle = '#d9d6cc';
        g.fillRect(p.x - w / 2, p.y - h / 2, w, h);
        g.fillStyle = '#b8322a';
        g.fillRect(p.x - w / 2, p.y - h / 2, w, 3);
        g.fillRect(p.x - w / 2, p.y + h / 2 - 3, w, 3);
        g.fillStyle = 'rgba(0,0,0,0.08)';
        g.fillRect(p.x - w / 2, p.y, w, h / 2 - 3);
        break;
      }
      default:
        break;
    }
  }

  private drawBuilding(g: CanvasRenderingContext2D, b: BuildingDef, scale: number): void {
    const roofH = b.h - b.wallH;
    const wallY = b.y + roofH;
    const h = (n: number) => hash2(b.id, n, 77);
    // --- wall face (south) ---
    const wall = shade(b.wallColor, -0.16);
    g.fillStyle = wall;
    g.fillRect(b.x, wallY, b.w, b.wallH);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(b.x, b.y + b.h - 1.2, b.w, 1.2);
    if (scale >= 0.5) this.drawFacade(g, b, wallY);

    // --- roof ---
    const rc = b.roofColor;
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const rh = roofH;
    switch (b.roof) {
      case 'flat': {
        g.fillStyle = rc;
        g.fillRect(x, y, w, rh);
        g.strokeStyle = shade(rc, -0.22);
        g.lineWidth = 1.6;
        g.strokeRect(x + 0.8, y + 0.8, w - 1.6, rh - 1.6);
        g.strokeStyle = shade(rc, 0.18);
        g.lineWidth = 0.6;
        g.beginPath();
        g.moveTo(x + 1.6, y + rh - 1.6);
        g.lineTo(x + 1.6, y + 1.6);
        g.lineTo(x + w - 1.6, y + 1.6);
        g.stroke();
        if (scale >= 0.5) this.drawFlatRoofDetails(g, b, rh);
        break;
      }
      case 'gable-h': {
        g.fillStyle = shade(rc, 0.12);
        g.fillRect(x, y, w, rh / 2);
        g.fillStyle = shade(rc, -0.14);
        g.fillRect(x, y + rh / 2, w, rh / 2);
        if (scale >= 1) shingles(g, x, y, w, rh, true, rc);
        g.fillStyle = shade(rc, 0.3);
        g.fillRect(x, y + rh / 2 - 0.6, w, 1.2);
        break;
      }
      case 'gable-v': {
        g.fillStyle = shade(rc, 0.12);
        g.fillRect(x, y, w / 2, rh);
        g.fillStyle = shade(rc, -0.14);
        g.fillRect(x + w / 2, y, w / 2, rh);
        if (scale >= 1) shingles(g, x, y, w, rh, false, rc);
        g.fillStyle = shade(rc, 0.3);
        g.fillRect(x + w / 2 - 0.6, y, 1.2, rh);
        break;
      }
      case 'hip': {
        const horiz = w >= rh;
        const d = horiz ? rh / 2 : w / 2;
        if (horiz) {
          poly(g, shade(rc, 0.15), [x, y, x + w, y, x + w - d, y + rh / 2, x + d, y + rh / 2]);
          poly(g, shade(rc, -0.17), [x, y + rh, x + w, y + rh, x + w - d, y + rh / 2, x + d, y + rh / 2]);
          poly(g, shade(rc, 0.03), [x, y, x + d, y + rh / 2, x, y + rh]);
          poly(g, shade(rc, -0.07), [x + w, y, x + w - d, y + rh / 2, x + w, y + rh]);
          g.strokeStyle = shade(rc, 0.32);
          g.lineWidth = 0.8;
          line(g, x + d, y + rh / 2, x + w - d, y + rh / 2);
        } else {
          poly(g, shade(rc, 0.03), [x, y, x + w / 2, y + d, x + w / 2, y + rh - d, x, y + rh]);
          poly(g, shade(rc, -0.12), [x + w, y, x + w / 2, y + d, x + w / 2, y + rh - d, x + w, y + rh]);
          poly(g, shade(rc, 0.16), [x, y, x + w, y, x + w / 2, y + d]);
          poly(g, shade(rc, -0.18), [x, y + rh, x + w, y + rh, x + w / 2, y + rh - d]);
          g.strokeStyle = shade(rc, 0.32);
          g.lineWidth = 0.8;
          line(g, x + w / 2, y + d, x + w / 2, y + rh - d);
        }
        break;
      }
    }
    // chimneys / solar / damage on pitched roofs
    if (b.roof !== 'flat' && scale >= 0.7) {
      if (h(1) < 0.45) {
        const cx = x + w * (0.2 + h(2) * 0.6);
        const cy = y + rh * (0.15 + h(3) * 0.2);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(cx + 1.5, cy + 1.5, 3.5, 3.5);
        g.fillStyle = '#7a5144';
        g.fillRect(cx, cy, 3.5, 3.5);
        g.fillStyle = '#2a2a2a';
        g.fillRect(cx + 0.9, cy + 0.9, 1.7, 1.7);
      }
      if (h(4) < 0.12 && b.kind === 'house') {
        g.fillStyle = '#273449';
        const sw = Math.min(w * 0.4, 14);
        const sx = x + w * 0.5 - sw / 2;
        const sy = y + rh * 0.58;
        g.fillRect(sx, sy, sw, rh * 0.3);
        g.strokeStyle = 'rgba(160,190,220,0.35)';
        g.lineWidth = 0.4;
        g.strokeRect(sx, sy, sw, rh * 0.3);
      }
    }
    if (h(5) < 0.09 && b.kind !== 'firestation') {
      // scorched / collapsed patch
      g.fillStyle = 'rgba(25,20,18,0.55)';
      g.beginPath();
      const sr = Math.min(w, rh, 40);
      g.ellipse(x + w * (0.3 + h(6) * 0.4), y + rh * (0.3 + h(7) * 0.4), sr * 0.18, sr * 0.12, h(8) * 3, 0, Math.PI * 2);
      g.fill();
    }
    // deco
    if (b.deco === 'helipad') {
      const r = Math.min(w, rh) * 0.22;
      const cx = x + w - r - 8;
      const cy = y + r + 8;
      g.fillStyle = '#5b6064';
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#e8e6df';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(cx, cy, r - 2.5, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 1.8;
      line(g, cx - r * 0.35, cy - r * 0.45, cx - r * 0.35, cy + r * 0.45);
      line(g, cx + r * 0.35, cy - r * 0.45, cx + r * 0.35, cy + r * 0.45);
      line(g, cx - r * 0.35, cy, cx + r * 0.35, cy);
      // red cross
      const kx = x + w * 0.3;
      const ky = y + rh * 0.5;
      g.fillStyle = '#c0392b';
      g.fillRect(kx - 9, ky - 3, 18, 6);
      g.fillRect(kx - 3, ky - 9, 6, 18);
    }
    if (b.deco === 'steeple') {
      const t = steepleRect(b);
      g.fillStyle = shade(b.wallColor, -0.2);
      g.fillRect(t.x, t.y + t.h - 6, t.w, 6);
      poly(g, shade(b.roofColor, 0.15), [t.x, t.y, t.x + t.w, t.y, t.x + t.w / 2, t.y + (t.h - 6) / 2]);
      poly(g, shade(b.roofColor, -0.15), [t.x, t.y + t.h - 6, t.x + t.w, t.y + t.h - 6, t.x + t.w / 2, t.y + (t.h - 6) / 2]);
      poly(g, shade(b.roofColor, 0.02), [t.x, t.y, t.x + t.w / 2, t.y + (t.h - 6) / 2, t.x, t.y + t.h - 6]);
      poly(g, shade(b.roofColor, -0.06), [t.x + t.w, t.y, t.x + t.w / 2, t.y + (t.h - 6) / 2, t.x + t.w, t.y + t.h - 6]);
      g.strokeStyle = '#d8c48a';
      g.lineWidth = 1;
      const cx = t.x + t.w / 2;
      const cy = t.y + (t.h - 6) / 2;
      line(g, cx, cy - 5, cx, cy + 3);
      line(g, cx - 2.5, cy - 2.5, cx + 2.5, cy - 2.5);
    }
    // edge outline
    g.strokeStyle = 'rgba(20,20,22,0.45)';
    g.lineWidth = 0.7;
    g.strokeRect(b.x, b.y, b.w, b.h);
  }

  private drawFacade(g: CanvasRenderingContext2D, b: BuildingDef, wallY: number): void {
    const H = b.wallH;
    const h = (n: number) => hash2(b.id, n, 91);
    const glass = '#2a343d';
    const glassHi = '#43535f';
    const frontSouth = b.facing === 's';
    const win = (wx: number, wy: number, ww: number, wh: number, k: number) => {
      const r = h(100 + k);
      if (r < 0.14) {
        // boarded up
        g.fillStyle = '#7b6247';
        g.fillRect(wx, wy, ww, wh);
        g.fillStyle = '#5e4a35';
        g.fillRect(wx, wy + wh * 0.35, ww, 0.6);
        return;
      }
      g.fillStyle = r < 0.24 ? '#111417' : glass;
      g.fillRect(wx, wy, ww, wh);
      g.fillStyle = glassHi;
      g.fillRect(wx, wy, ww, wh * 0.35);
    };
    switch (b.kind) {
      case 'shop':
      case 'diner':
      case 'pharmacy':
      case 'hardware':
      case 'supermarket':
      case 'gas': {
        if (frontSouth) {
          const awn = ['#9c3b32', '#2f6b5a', '#c28a2c', '#3a5a8c', '#7a3b6b', '#3e7a3a'][Math.floor(h(1) * 6)];
          const kind = b.kind === 'pharmacy' ? '#2f8a5a' : b.kind === 'supermarket' ? '#2f7a3a' : awn;
          g.fillStyle = glass;
          g.fillRect(b.x + 2, wallY + H * 0.38, b.w - 4, H * 0.55);
          g.fillStyle = glassHi;
          g.fillRect(b.x + 2, wallY + H * 0.38, b.w - 4, H * 0.14);
          g.fillStyle = shade(b.wallColor, -0.3);
          for (let x = b.x + 2; x < b.x + b.w - 2; x += 9) g.fillRect(x, wallY + H * 0.38, 0.8, H * 0.55);
          g.fillStyle = kind;
          g.fillRect(b.x, wallY, b.w, H * 0.34);
          g.fillStyle = 'rgba(255,255,255,0.22)';
          for (let x = b.x; x < b.x + b.w; x += 6) g.fillRect(x, wallY, 3, H * 0.34);
        } else this.windowRows(g, b, wallY, win);
        break;
      }
      case 'firestation': {
        if (frontSouth) {
          const n = 3;
          const dw = (b.w - 8) / n - 3;
          for (let i = 0; i < n; i++) {
            const dx = b.x + 4 + i * (dw + 3);
            g.fillStyle = '#d6d0c4';
            g.fillRect(dx, wallY + H * 0.2, dw, H * 0.8);
            g.fillStyle = 'rgba(0,0,0,0.18)';
            for (let yy = wallY + H * 0.3; yy < b.y + b.h; yy += 2) g.fillRect(dx, yy, dw, 0.5);
          }
        } else this.windowRows(g, b, wallY, win);
        break;
      }
      case 'warehouse':
      case 'factory': {
        if (frontSouth) {
          for (let x = b.x + 8; x < b.x + b.w - 20; x += 26) {
            g.fillStyle = '#6d7175';
            g.fillRect(x, wallY + H * 0.3, 16, H * 0.7);
            g.fillStyle = 'rgba(0,0,0,0.2)';
            for (let yy = wallY + H * 0.36; yy < b.y + b.h; yy += 2) g.fillRect(x, yy, 16, 0.5);
          }
        }
        g.fillStyle = glass;
        for (let x = b.x + 4; x < b.x + b.w - 6; x += 10) g.fillRect(x, wallY + 2, 6, 2);
        break;
      }
      case 'barn': {
        if (frontSouth) {
          const dx = b.x + b.w / 2 - 8;
          g.fillStyle = '#6b2a20';
          g.fillRect(dx, wallY + 1.5, 16, H - 1.5);
          g.strokeStyle = '#e0d6c4';
          g.lineWidth = 0.8;
          g.strokeRect(dx, wallY + 1.5, 16, H - 1.5);
          line(g, dx, wallY + 1.5, dx + 16, b.y + b.h);
          line(g, dx + 16, wallY + 1.5, dx, b.y + b.h);
        }
        break;
      }
      case 'church': {
        g.fillStyle = glass;
        for (let x = b.x + 5; x < b.x + b.w - 5; x += 8) g.fillRect(x, wallY + H * 0.2, 3, H * 0.6);
        break;
      }
      default:
        this.windowRows(g, b, wallY, win);
        if (frontSouth && (b.kind === 'house' || b.kind === 'bungalow' || b.kind === 'farmhouse')) {
          g.fillStyle = '#5a3e2c';
          g.fillRect(b.x + b.w / 2 - 2, wallY + H * 0.3, 4, H * 0.7);
        }
    }
  }

  private windowRows(_g: CanvasRenderingContext2D, b: BuildingDef, wallY: number, win: (x: number, y: number, w: number, h: number, k: number) => void): void {
    const H = b.wallH;
    const floors = Math.max(1, Math.floor(H / 6.5));
    const fh = H / floors;
    let k = 0;
    for (let f = 0; f < floors; f++) {
      const wy = wallY + f * fh + fh * 0.28;
      for (let x = b.x + 4; x < b.x + b.w - 6; x += 9) {
        if (b.facing === 's' && f === floors - 1 && Math.abs(x + 2 - (b.x + b.w / 2)) < 5) continue;
        win(x, wy, 4.5, fh * 0.45, k++);
      }
    }
  }

  private drawFlatRoofDetails(g: CanvasRenderingContext2D, b: BuildingDef, rh: number): void {
    const h = (n: number) => hash2(b.id, n, 33);
    const big = b.w * rh > 4000;
    if (b.kind === 'warehouse' || b.kind === 'factory') {
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      g.lineWidth = 0.6;
      g.beginPath();
      for (let x = b.x + 4; x < b.x + b.w - 2; x += 4) {
        g.moveTo(x, b.y + 2);
        g.lineTo(x, b.y + rh - 2);
      }
      g.stroke();
      g.fillStyle = 'rgba(170,195,205,0.55)';
      for (let x = b.x + 14; x < b.x + b.w - 14; x += 28) g.fillRect(x, b.y + 6, 8, rh - 12);
    }
    // stains
    g.fillStyle = 'rgba(0,0,0,0.08)';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.ellipse(b.x + b.w * (0.2 + h(i) * 0.6), b.y + rh * (0.2 + h(i + 9) * 0.6), 4 + h(i + 3) * b.w * 0.12, 3 + h(i + 5) * rh * 0.1, h(i + 7) * 3, 0, Math.PI * 2);
      g.fill();
    }
    // AC units & vents
    const n = big ? 3 + Math.floor(h(20) * 4) : Math.floor(h(20) * 3);
    for (let i = 0; i < n; i++) {
      const ax = b.x + 5 + h(30 + i) * (b.w - 16);
      const ay = b.y + 5 + h(40 + i) * (rh - 15);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(ax + 1.5, ay + 1.5, 7, 6);
      g.fillStyle = '#c9cbc6';
      g.fillRect(ax, ay, 7, 6);
      g.fillStyle = '#5c6166';
      g.beginPath();
      g.arc(ax + 3.5, ay + 3, 2, 0, Math.PI * 2);
      g.fill();
    }
    if (b.kind === 'supermarket' || b.kind === 'apartment' || b.kind === 'office') {
      g.fillStyle = 'rgba(160,185,200,0.6)';
      g.fillRect(b.x + b.w * 0.3, b.y + rh * 0.35, b.w * 0.15, rh * 0.3);
    }
    if (b.kind === 'police') {
      g.fillStyle = 'rgba(30,45,80,0.55)';
      g.fillRect(b.x + b.w / 2 - 14, b.y + rh / 2 - 5, 28, 10);
      g.fillStyle = 'rgba(230,230,230,0.8)';
      g.font = 'bold 6px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('POLICE', b.x + b.w / 2, b.y + rh / 2 + 0.5);
    }
  }
}

// ---- helpers --------------------------------------------------------------

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function line(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}

function poly(g: CanvasRenderingContext2D, fill: string, pts: number[]): void {
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  g.fill();
}

function starPath(g: CanvasRenderingContext2D, x: number, y: number, r1: number, r2: number, n: number, a0: number): void {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = a0 + (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 ? r2 : r1;
    if (i) g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
}

function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function shingles(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, horiz: boolean, rc: string): void {
  g.strokeStyle = shade(rc, -0.3);
  g.globalAlpha = 0.25;
  g.lineWidth = 0.4;
  g.beginPath();
  if (horiz) {
    for (let yy = y + 2.5; yy < y + h; yy += 2.5) {
      g.moveTo(x, yy);
      g.lineTo(x + w, yy);
    }
  } else {
    for (let xx = x + 2.5; xx < x + w; xx += 2.5) {
      g.moveTo(xx, y);
      g.lineTo(xx, y + h);
    }
  }
  g.stroke();
  g.globalAlpha = 1;
}

export function steepleRect(b: BuildingDef): Rect {
  const s = 16;
  const roofH = b.h - b.wallH;
  switch (b.facing) {
    case 's':
      return { x: b.x + b.w / 2 - s / 2, y: b.y + roofH - s + 4, w: s, h: s + 6 };
    case 'n':
      return { x: b.x + b.w / 2 - s / 2, y: b.y - 4, w: s, h: s + 6 };
    case 'w':
      return { x: b.x - 2, y: b.y + roofH / 2 - s / 2, w: s, h: s + 6 };
    default:
      return { x: b.x + b.w - s + 2, y: b.y + roofH / 2 - s / 2, w: s, h: s + 6 };
  }
}

function propDims(p: Prop): [number, number] | null {
  switch (p.kind) {
    case 'car':
    case 'police':
      return [18, 9];
    case 'truck':
      return [30, 11];
    case 'firetruck':
      return [34, 12];
    case 'bus':
      return [42, 12];
    case 'container':
      return [30, 10];
    case 'dumpster':
      return [12, 7];
    case 'shed':
      return [12, 11];
    case 'bush':
      return null;
    case 'fountain':
      return null;
    default:
      return null;
  }
}

function rotRect(g: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hw = w / 2;
  const hh = h / 2;
  const pts = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  pts.forEach(([x, y], i) => {
    const px = cx + x * c - y * s;
    const py = cy + x * s + y * c;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  });
  g.closePath();
}

export function drawVehicle(g: CanvasRenderingContext2D, p: Prop, scale: number): void {
  const dims = propDims(p)!;
  const [L, W] = dims;
  const burnt = p.v === 1 && p.kind === 'car' && p.c === '#2a2522';
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.a);
  const body = p.kind === 'firetruck' ? '#b8322a' : p.kind === 'bus' ? (p.v > 0.5 ? '#d9a62e' : '#d8d8d0') : p.c;
  g.fillStyle = shade(body, -0.25);
  g.fillRect(-L / 2, -W / 2, L, W);
  g.fillStyle = body;
  g.fillRect(-L / 2 + 0.6, -W / 2 + 0.6, L - 1.2, W - 1.2);
  if (p.kind === 'car' || p.kind === 'police') {
    const glass = burnt ? '#141212' : '#25303a';
    g.fillStyle = glass;
    g.fillRect(L * 0.08, -W / 2 + 1.2, L * 0.17, W - 2.4); // windshield
    g.fillRect(-L * 0.36, -W / 2 + 1.4, L * 0.1, W - 2.8); // rear
    g.fillStyle = burnt ? '#3a302a' : shade(body, 0.12);
    g.fillRect(-L * 0.26, -W / 2 + 1.4, L * 0.34, W - 2.8); // roof
    if (p.kind === 'police') {
      g.fillStyle = '#1d2228';
      g.fillRect(-L / 2 + 0.6, -W / 2 + 0.6, L * 0.25, W - 1.2);
      g.fillRect(L * 0.3, -W / 2 + 0.6, L * 0.19, W - 1.2);
      g.fillStyle = '#d63a3a';
      g.fillRect(-L * 0.06, -W / 2 + 1.4, 1.6, (W - 2.8) / 2);
      g.fillStyle = '#3a6ad6';
      g.fillRect(-L * 0.06, 0, 1.6, (W - 2.8) / 2);
    }
    if (burnt) {
      g.fillStyle = 'rgba(140,70,30,0.6)';
      g.fillRect(-L * 0.4, -W * 0.3, 3, 2);
      g.fillRect(L * 0.3, W * 0.1, 2, 2);
    } else if (scale >= 1) {
      g.fillStyle = 'rgba(255,250,220,0.8)';
      g.fillRect(L / 2 - 1, -W / 2 + 1, 0.8, 1.6);
      g.fillRect(L / 2 - 1, W / 2 - 2.6, 0.8, 1.6);
    }
  } else if (p.kind === 'truck' || p.kind === 'firetruck') {
    g.fillStyle = shade(body, p.kind === 'firetruck' ? -0.12 : -0.08);
    g.fillRect(L / 2 - 8, -W / 2 + 0.6, 7.4, W - 1.2);
    g.fillStyle = '#25303a';
    g.fillRect(L / 2 - 2.6, -W / 2 + 1.4, 1.8, W - 2.8);
    if (p.kind === 'firetruck') {
      g.fillStyle = '#c9c9c4';
      g.fillRect(-L / 2 + 2, -1.8, L - 12, 3.6);
      g.fillStyle = '#8a8a86';
      for (let x = -L / 2 + 3; x < L / 2 - 10; x += 3) g.fillRect(x, -1.8, 0.6, 3.6);
    } else {
      g.fillStyle = shade(body, 0.08);
      g.fillRect(-L / 2 + 1, -W / 2 + 1, L - 10, W - 2);
    }
  } else if (p.kind === 'bus') {
    g.fillStyle = '#2a343d';
    for (let x = -L / 2 + 3; x < L / 2 - 4; x += 5) {
      g.fillRect(x, -W / 2 + 0.8, 3.4, 1.4);
      g.fillRect(x, W / 2 - 2.2, 3.4, 1.4);
    }
    g.fillStyle = shade(body, 0.1);
    g.fillRect(-L / 2 + 2, -W / 2 + 2.6, L - 4, W - 5.2);
  }
  g.restore();
}
