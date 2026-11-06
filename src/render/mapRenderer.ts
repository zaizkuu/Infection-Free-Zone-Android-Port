import type { Area, BuildingDef, Fence, MapData, Prop, Road } from '../world/types';
import { buildTextures, makeCanvas, worldPattern, type Textures } from './textures';
import { hash2 } from '../core/rng';
import { clamp, mixHex, shade, type Rect } from '../core/math';
import { vehicleSpots } from '../world/mapgen';

const SIDEWALK = 8;
const IDX = 200; // spatial index bucket size in world units
const TILE = 256; // tile size in device pixels
const PAD = 24; // render margin so blurred shadows match across tile seams
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
  lot: 1,
  lawn: 2,
  park: 2,
  field: 2,
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
};

const GROUND_PROPS = new Set(['debris', 'stone', 'hay', 'bench', 'barrier', 'dumpster', 'container', 'car', 'truck', 'firetruck', 'police', 'bus', 'shed', 'lamp', 'fountain', 'bush']);

interface Tile {
  c: HTMLCanvasElement;
  used: number;
  pinned: boolean;
}

const HAS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
let BLUR = HAS_FILTER;

/** Runs `fn` with a blur filter (device px) if the platform supports canvas filters. */
function blurred(g: CanvasRenderingContext2D, px: number, fn: () => void): void {
  if (BLUR && px >= 0.35) {
    g.filter = `blur(${px.toFixed(2)}px)`;
    fn();
    g.filter = 'none';
  } else fn();
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
  private reedPoly: Path2D;
  private riverBounds: Rect;
  private scratch: HTMLCanvasElement;

  constructor(private map: MapData) {
    this.tex = buildTextures(map.seed, map.width, map.height);
    this.scratch = makeCanvas(TILE + PAD * 2, TILE + PAD * 2);
    this.areas = [...map.areas].sort((a, b) => (AREA_ORDER[a.kind] ?? 0) - (AREA_ORDER[b.kind] ?? 0));
    // drivable vehicles are drawn by the world renderer, not baked into tiles
    const dynamic = new Set(vehicleSpots(map));
    this.props = map.props.filter((_, i) => !dynamic.has(i));
    this.fences = map.fences;
    this.buildings = [...map.buildings].sort((a, b) => a.y + a.h - (b.y + b.h));
    const pad = (r: Rect, p: number, sx = 0, sy = 0): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2 + sx, h: r.h + p * 2 + sy });
    this.areaIdx = new SpatialIndex(this.areas.map((a) => ({ b: pad(a, 2) })), map.width, map.height);
    this.propIdx = new SpatialIndex(
      this.props.map((p) => {
        const s = p.kind === 'canopy' ? Math.max(p.w ?? 0, p.h ?? 0) / 2 + 10 : p.kind === 'bus' ? 30 : p.kind === 'container' || p.kind === 'truck' || p.kind === 'firetruck' ? 24 : p.kind === 'fountain' ? p.r + 8 : Math.max(p.r * 2.2, 16);
        return { b: { x: p.x - s, y: p.y - s, w: s * 2 + 10, h: s * 2 + 10 } };
      }),
      map.width,
      map.height,
    );
    this.bldIdx = new SpatialIndex(this.buildings.map((b) => ({ b: pad(b, 22, b.wallH * 1.8, b.wallH * 1.4) })), map.width, map.height);
    this.fenceIdx = new SpatialIndex(
      this.fences.map((f) => ({ b: { x: Math.min(f.x1, f.x2) - 4, y: Math.min(f.y1, f.y2) - 4, w: Math.abs(f.x2 - f.x1) + 8, h: Math.abs(f.y2 - f.y1) + 8 } })),
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
    const rv = map.river;
    const poly = (half: number, wob = 0) => {
      const p = new Path2D();
      rv.pts.forEach((pt, i) => {
        const j = wob ? (hash2(i, 1, 55) - 0.5) * wob : 0;
        if (i) p.lineTo(pt.x - half + j, pt.y);
        else p.moveTo(pt.x - half + j, pt.y);
      });
      for (let i = rv.pts.length - 1; i >= 0; i--) {
        const j = wob ? (hash2(i, 2, 55) - 0.5) * wob : 0;
        p.lineTo(rv.pts[i].x + half + j, rv.pts[i].y);
      }
      p.closePath();
      return p;
    };
    this.bankPoly = poly(rv.w / 2 + 9, 6);
    this.reedPoly = poly(rv.w / 2 + 2, 7);
    this.riverPoly = poly(rv.w / 2, 3);
    this.deepPoly = poly(rv.w / 2 - 12, 4);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of rv.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    this.riverBounds = { x: minX - rv.w, y: -100, w: maxX - minX + rv.w * 2, h: map.height + 200 };
  }

  /** Soft shadows on/off (battery saver). Clears the tile cache when it changes. */
  setBlur(on: boolean): void {
    const v = on && HAS_FILTER;
    if (v === BLUR) return;
    BLUR = v;
    this.tiles.clear();
    this.warmup();
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
    const sg = this.scratch.getContext('2d')!;
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalAlpha = 1;
    sg.globalCompositeOperation = 'source-over';
    sg.fillStyle = '#0b0f14';
    sg.fillRect(0, 0, this.scratch.width, this.scratch.height);
    sg.setTransform(s, 0, 0, s, -tx * tw * s + PAD, -ty * tw * s + PAD);
    const pw = PAD / s;
    const region = { x: tx * tw - pw, y: ty * tw - pw, w: tw + pw * 2, h: tw + pw * 2 };
    sg.save();
    this.drawRegion(sg, region, s);
    sg.restore();
    const c = makeCanvas(TILE, TILE);
    c.getContext('2d')!.drawImage(this.scratch, PAD, PAD, TILE, TILE, 0, 0, TILE, TILE);
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

  get tileCount(): number {
    return this.tiles.size;
  }

  // ---------------------------------------------------------------------------
  // Region drawing (world coordinates)
  // ---------------------------------------------------------------------------

  drawRegion(g: CanvasRenderingContext2D, r: Rect, scale: number): void {
    const T = this.tex;
    g.imageSmoothingEnabled = true;
    g.drawImage(T.ground, 0, 0, T.ground.width, T.ground.height, 0, 0, this.map.width, this.map.height);
    if (scale >= 0.5) {
      g.globalAlpha = 0.7;
      g.fillStyle = worldPattern(g, T.grass);
      g.fillRect(r.x, r.y, r.w, r.h);
      g.globalAlpha = 1;
    }

    for (const i of this.areaIdx.query(r)) this.drawArea(g, this.areas[i], scale);

    if (r.x < this.riverBounds.x + this.riverBounds.w && r.x + r.w > this.riverBounds.x) this.drawRiver(g, scale);

    for (const b of this.map.bridges) {
      if (!intersects(b, r)) continue;
      blurred(g, 3 * scale, () => {
        g.fillStyle = 'rgba(5,12,14,0.55)';
        g.fillRect(b.x + 5, b.y + 7, b.w, b.h);
      });
      g.fillStyle = '#5f5d58';
      g.fillRect(b.x, b.y, b.w, b.h);
    }

    // Roads
    const roads = this.map.roads.filter((rd) => intersects(this.roadRect(rd, SIDEWALK + 2), r));
    for (const rd of roads) {
      const rr = this.roadRect(rd, SIDEWALK);
      g.fillStyle = rd.bridge ? '#62605a' : '#6c6a63';
      g.fillRect(rr.x, rr.y, rr.w, rr.h);
    }
    if (scale >= 0.5)
      for (const rd of roads) {
        if (rd.bridge) continue;
        const rr = this.roadRect(rd, SIDEWALK);
        g.globalAlpha = 0.8;
        g.fillStyle = worldPattern(g, T.concrete);
        g.fillRect(rr.x, rr.y, rr.w, rr.h);
        g.globalAlpha = 1;
        if (scale >= 1) this.sidewalkJoints(g, rd, rr, r);
      }
    for (const rd of roads) {
      const rr = this.roadRect(rd, 0);
      g.fillStyle = rd.main ? '#26282b' : '#2b2d30';
      g.fillRect(rr.x, rr.y, rr.w, rr.h);
    }
    if (scale >= 0.5) {
      g.fillStyle = worldPattern(g, T.asphalt);
      for (const rd of roads) {
        const rr = this.roadRect(rd, 0);
        g.fillRect(rr.x, rr.y, rr.w, rr.h);
      }
    }
    for (const rd of roads) this.drawRoadDetails(g, rd, r, scale);

    // Bridge railings
    for (const b of this.map.bridges) {
      if (!intersects(b, r)) continue;
      g.fillStyle = '#8b887f';
      g.fillRect(b.x, b.y, b.w, 1.8);
      g.fillRect(b.x, b.y + b.h - 1.8, b.w, 1.8);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(b.x, b.y + 1.8, b.w, 0.8);
      g.fillStyle = '#4a4845';
      for (let x = b.x; x < b.x + b.w; x += 8) {
        g.fillRect(x, b.y - 0.5, 1.4, 2.8);
        g.fillRect(x, b.y + b.h - 2.3, 1.4, 2.8);
      }
    }

    // Weathering: stains, leaf litter, litter, weeds
    this.drawGrime(g, r, scale, roads);

    for (const i of this.fenceIdx.query(r)) this.drawFence(g, this.fences[i]);

    // Ambient occlusion + soft cast shadows (single union fills, so overlaps don't stack)
    const propIds = this.propIdx.query(r);
    const bldIds = this.bldIdx.query(r);
    blurred(g, 4.5 * scale, () => {
      g.fillStyle = 'rgba(8,10,8,0.42)';
      g.beginPath();
      for (const i of bldIds) {
        const b = this.buildings[i];
        g.rect(b.x - 2.5, b.y - 2.5, b.w + 5, b.h + 5);
      }
      for (const i of propIds) {
        const p = this.props[i];
        if (p.kind === 'tree' || p.kind === 'pine') {
          g.moveTo(p.x + p.r * 0.75, p.y);
          g.arc(p.x, p.y, p.r * 0.75, 0, Math.PI * 2);
        }
      }
      g.fill();
    });
    blurred(g, Math.max(0.6, 1.8 * scale), () => {
      g.fillStyle = 'rgba(6,8,10,0.5)';
      g.beginPath();
      for (const i of bldIds) {
        const b = this.buildings[i];
        const sx = b.wallH * 1.45;
        const sy = b.wallH * 1.05;
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
          g.lineTo(t.x + t.w + 40, t.y + 29);
          g.lineTo(t.x + 40, t.y + t.h + 29);
          g.lineTo(t.x, t.y + t.h);
          g.closePath();
        }
      }
      for (const i of propIds) {
        const p = this.props[i];
        if (p.kind === 'tree' || p.kind === 'pine') {
          const rr = p.r;
          g.moveTo(p.x + rr * 0.75 + rr * 1.05, p.y + rr * 0.6);
          g.ellipse(p.x + rr * 0.75, p.y + rr * 0.6, rr * 1.05, rr * 0.95, 0, 0, Math.PI * 2);
        } else if (p.kind === 'canopy') {
          const w = p.w ?? 40;
          const h = p.h ?? 30;
          g.rect(p.x - w / 2 + 8, p.y - h / 2 + 6, w, h);
        } else if (p.kind === 'lamp') {
          g.moveTo(p.x, p.y);
          g.lineTo(p.x + 18, p.y + 13);
          g.lineTo(p.x + 19, p.y + 12);
          g.lineTo(p.x + 1, p.y - 1);
          g.closePath();
        } else if (p.kind === 'bush') {
          g.moveTo(p.x + 1.5 + p.r, p.y + 1.5);
          g.arc(p.x + 1.5, p.y + 1.5, p.r, 0, Math.PI * 2);
        } else {
          const d = propDims(p);
          if (!d) continue;
          rotRect(g, p.x + 2.2, p.y + 1.8, d[0] + 1, d[1] + 1, p.a);
        }
      }
      g.fill();
    });

    for (const i of propIds) {
      const p = this.props[i];
      if (GROUND_PROPS.has(p.kind)) this.drawProp(g, p, scale);
    }
    for (const i of bldIds) this.drawBuilding(g, this.buildings[i], scale);
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

  private sidewalkJoints(g: CanvasRenderingContext2D, rd: Road, rr: Rect, r: Rect): void {
    g.strokeStyle = 'rgba(30,28,24,0.35)';
    g.lineWidth = 0.5;
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
    // curb highlight on the sidewalk side
    g.fillStyle = 'rgba(160,156,146,0.35)';
    if (vertical) {
      g.fillRect(rd.x1 - rd.w / 2 - 1.2, Math.max(rr.y, r.y), 1.2, Math.min(rr.h, r.h + 4));
      g.fillRect(rd.x1 + rd.w / 2, Math.max(rr.y, r.y), 1.2, Math.min(rr.h, r.h + 4));
    } else {
      g.fillRect(Math.max(rr.x, r.x), rd.y1 - rd.w / 2 - 1.2, Math.min(rr.w, r.w + 4), 1.2);
      g.fillRect(Math.max(rr.x, r.x), rd.y1 + rd.w / 2, Math.min(rr.w, r.w + 4), 1.2);
    }
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
    const lo = Math.max(a0, (vertical ? r.y : r.x) - 20);
    const hi = Math.min(a1, (vertical ? r.y + r.h : r.x + r.w) + 20);
    if (hi <= lo) return;
    // lane wear: dark oil strip down each lane, lighter tyre tracks either side
    if (scale >= 0.5) {
      const lanes = rd.main ? [-rd.w * 0.375, -rd.w * 0.125, rd.w * 0.125, rd.w * 0.375] : [-rd.w / 4, rd.w / 4];
      for (const l of lanes) {
        g.fillStyle = 'rgba(0,0,0,0.16)';
        seg(lo, hi, l, 2.6);
        g.fillStyle = 'rgba(150,150,145,0.05)';
        seg(lo, hi, l - 3.2, 1.8);
        seg(lo, hi, l + 3.2, 1.8);
      }
    }
    // repair patches, potholes, cracks
    if (scale >= 0.7) {
      for (let s = Math.floor(lo / 34) * 34; s < hi; s += 34) {
        const h = hash2(Math.floor(s / 34), idx, 11);
        const off = (hash2(s, idx, 3) - 0.5) * rd.w * 0.7;
        if (h < 0.28) {
          const len = 8 + hash2(s, idx, 5) * 24;
          const wd = 6 + hash2(s, idx, 9) * 8;
          g.fillStyle = h < 0.12 ? 'rgba(10,10,11,0.4)' : 'rgba(70,70,68,0.22)';
          if (vertical) g.fillRect(rd.x1 + off - wd / 2, s, wd, len);
          else g.fillRect(s, rd.y1 + off - wd / 2, len, wd);
        } else if (h < 0.36) {
          const px = vertical ? rd.x1 + off : s;
          const py = vertical ? s : rd.y1 + off;
          const pr = 1.5 + hash2(s, idx, 13) * 2.5;
          g.fillStyle = 'rgba(85,84,80,0.5)';
          g.beginPath();
          g.ellipse(px, py, pr + 0.8, pr * 0.8 + 0.8, h * 9, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#0d0e0f';
          g.beginPath();
          g.ellipse(px, py, pr, pr * 0.8, h * 9, 0, Math.PI * 2);
          g.fill();
        }
        if (h > 0.62) {
          g.strokeStyle = 'rgba(8,8,9,0.6)';
          g.lineWidth = 0.55;
          g.beginPath();
          let px = vertical ? rd.x1 + (h - 0.8) * rd.w * 1.5 : s;
          let py = vertical ? s : rd.y1 + (h - 0.8) * rd.w * 1.5;
          g.moveTo(px, py);
          for (let q = 0; q < 6; q++) {
            px += vertical ? (hash2(q, s, 1) - 0.5) * 7 : 3 + hash2(q, s, 2) * 5;
            py += vertical ? 3 + hash2(q, s, 2) * 5 : (hash2(q, s, 1) - 0.5) * 7;
            g.lineTo(px, py);
          }
          g.stroke();
        }
      }
    }
    // curb shadow
    g.fillStyle = 'rgba(0,0,0,0.45)';
    seg(lo, hi, -rd.w / 2 + 0.7, 1.4);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    seg(lo, hi, rd.w / 2 - 0.5, 1);
    // faded lane markings, with worn gaps
    const worn = (d: number) => hash2(Math.floor(d / 6), idx, 71) < 0.18;
    if (rd.main) {
      g.fillStyle = 'rgba(176,146,70,0.55)';
      for (let d = lo; d < hi; d += 6) {
        if (inCross(d) || inCross(d + 6) || worn(d)) continue;
        seg(d, d + 6, -1.4, 0.9);
        seg(d, d + 6, 1.4, 0.9);
      }
      g.fillStyle = 'rgba(190,188,180,0.38)';
      for (let d = a0 + 6; d < a1; d += 26) {
        if (d < lo || d > hi || inCross(d) || inCross(d + 12) || worn(d)) continue;
        seg(d, d + 12, -rd.w / 4, 0.9);
        seg(d, d + 12, rd.w / 4, 0.9);
      }
      g.fillStyle = 'rgba(196,194,186,0.42)';
      for (const [c0, c1] of cross) {
        for (const at of [c0 - 6, c1 + 1]) {
          if (at < lo || at > hi) continue;
          for (let q = -rd.w / 2 + 3; q < rd.w / 2 - 2; q += 4.5) {
            if (hash2(Math.round(q * 3), Math.round(at), idx) < 0.2) continue;
            if (vertical) g.fillRect(rd.x1 + q, at, 2.5, 5);
            else g.fillRect(at, rd.y1 + q, 5, 2.5);
          }
        }
      }
    } else {
      g.fillStyle = 'rgba(190,180,140,0.32)';
      for (let d = a0 + 10; d < a1; d += 22) {
        if (d < lo || d > hi || inCross(d) || inCross(d + 10) || worn(d)) continue;
        seg(d, d + 10, 0, 0.9);
      }
    }
  }

  /** Stains, leaf litter, rubbish and weeds pushing through the cracks. */
  private drawGrime(g: CanvasRenderingContext2D, r: Rect, scale: number, roads: Road[]): void {
    const C = 36;
    const x0 = Math.floor(r.x / C);
    const y0 = Math.floor(r.y / C);
    const x1 = Math.floor((r.x + r.w) / C);
    const y1 = Math.floor((r.y + r.h) / C);
    blurred(g, 2.5 * scale, () => {
      g.fillStyle = 'rgba(14,12,8,0.18)';
      g.beginPath();
      for (let cy = y0; cy <= y1; cy++)
        for (let cx = x0; cx <= x1; cx++) {
          const h = hash2(cx, cy, 401);
          if (h > 0.24) continue;
          const x = cx * C + hash2(cx, cy, 402) * C;
          const y = cy * C + hash2(cx, cy, 403) * C;
          const rx = 4 + hash2(cx, cy, 404) * 12;
          g.moveTo(x + rx, y);
          g.ellipse(x, y, rx, rx * (0.5 + hash2(cx, cy, 405) * 0.5), h * 20, 0, Math.PI * 2);
        }
      g.fill();
    });
    if (scale >= 1) {
      const litter = ['#4e4026', '#62502e', '#39401f', '#6b5a36'];
      for (let cy = y0; cy <= y1; cy++)
        for (let cx = x0; cx <= x1; cx++) {
          const h = hash2(cx, cy, 401);
          if (h < 0.24 || h > 0.42) continue;
          const bx = cx * C + hash2(cx, cy, 406) * C;
          const by = cy * C + hash2(cx, cy, 407) * C;
          if (h < 0.38) {
            for (let k = 0; k < 7; k++) {
              g.fillStyle = litter[k % litter.length];
              g.globalAlpha = 0.7;
              g.fillRect(bx + (hash2(k, cx, cy) - 0.5) * 12, by + (hash2(cy, k, cx) - 0.5) * 12, 1.1, 0.8);
            }
            g.globalAlpha = 1;
          } else {
            g.save();
            g.translate(bx, by);
            g.rotate(h * 40);
            g.fillStyle = hash2(cx, cy, 408) < 0.5 ? '#8f897b' : '#4f5d68';
            g.fillRect(-1.4, -0.9, 2.8, 1.8);
            g.restore();
          }
        }
    }
    if (scale >= 0.7) {
      // weeds along curbs and sidewalk edges
      const dark: number[] = [];
      const light: number[] = [];
      for (const rd of roads) {
        const vertical = rd.x1 === rd.x2;
        const a0 = Math.max(vertical ? rd.y1 : rd.x1, (vertical ? r.y : r.x) - 4);
        const a1 = Math.min(vertical ? rd.y2 : rd.x2, (vertical ? r.y + r.h : r.x + r.w) + 4);
        const idx = this.map.roads.indexOf(rd);
        for (let s = Math.floor(a0 / 7) * 7; s < a1; s += 7) {
          for (const side of [-1, 1]) {
            for (const edge of [rd.w / 2 + 0.5, rd.w / 2 + SIDEWALK - 0.5]) {
              const h = hash2(Math.floor(s / 7) * side, idx * 3 + (edge > rd.w ? 1 : 0), 77);
              if (h > 0.2) continue;
              const off = side * edge;
              const x = vertical ? rd.x1 + off : s;
              const y = vertical ? s : rd.y1 + off;
              (h < 0.1 ? dark : light).push(x, y, 0.8 + h * 6);
            }
          }
        }
      }
      for (const [arr, col] of [
        [dark, '#2f3a1e'],
        [light, '#4f5a30'],
      ] as const) {
        g.fillStyle = col;
        g.beginPath();
        for (let i = 0; i < arr.length; i += 3) {
          const x = arr[i];
          const y = arr[i + 1];
          const s = arr[i + 2];
          g.moveTo(x + s, y);
          g.arc(x, y, s, 0, Math.PI * 2);
          g.moveTo(x + 1.5 + s * 0.6, y + 1);
          g.arc(x + 1.5, y + 1, s * 0.6, 0, Math.PI * 2);
        }
        g.fill();
      }
    }
  }

  private drawRiver(g: CanvasRenderingContext2D, scale: number): void {
    blurred(g, 3 * scale, () => {
      g.fillStyle = '#4a4331';
      g.fill(this.bankPoly);
    });
    g.fillStyle = '#3a4a2a';
    g.fill(this.reedPoly);
    g.fillStyle = '#34494c';
    g.fill(this.riverPoly);
    blurred(g, 4 * scale, () => {
      g.fillStyle = '#25383c';
      g.fill(this.deepPoly);
    });
    if (scale >= 0.5) {
      g.save();
      g.clip(this.riverPoly);
      g.fillStyle = worldPattern(g, this.tex.water);
      g.fillRect(this.riverBounds.x, this.riverBounds.y, this.riverBounds.w, this.riverBounds.h);
      g.restore();
    }
    g.strokeStyle = 'rgba(160,180,170,0.14)';
    g.lineWidth = 0.8;
    g.stroke(this.riverPoly);
  }

  private drawFence(g: CanvasRenderingContext2D, f: Fence): void {
    g.lineCap = 'round';
    switch (f.kind) {
      case 'hedge':
        g.strokeStyle = '#1e2a17';
        g.lineWidth = 5.4;
        line(g, f.x1 + 0.8, f.y1 + 0.8, f.x2 + 0.8, f.y2 + 0.8);
        g.strokeStyle = '#2f3f22';
        g.lineWidth = 4.4;
        line(g, f.x1, f.y1, f.x2, f.y2);
        g.strokeStyle = '#43542e';
        g.lineWidth = 1.6;
        line(g, f.x1 - 0.8, f.y1 - 0.8, f.x2 - 0.8, f.y2 - 0.8);
        break;
      case 'chain':
        g.strokeStyle = 'rgba(120,124,126,0.6)';
        g.lineWidth = 0.7;
        g.setLineDash([2, 1.5]);
        line(g, f.x1, f.y1, f.x2, f.y2);
        g.setLineDash([]);
        break;
      case 'wall':
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        g.lineWidth = 3;
        line(g, f.x1 + 0.8, f.y1 + 0.8, f.x2 + 0.8, f.y2 + 0.8);
        g.strokeStyle = '#77736a';
        g.lineWidth = 2.2;
        line(g, f.x1, f.y1, f.x2, f.y2);
        break;
      default:
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        g.lineWidth = 1.4;
        line(g, f.x1 + 0.6, f.y1 + 0.6, f.x2 + 0.6, f.y2 + 0.6);
        g.strokeStyle = '#5a4a38';
        g.lineWidth = 1.1;
        line(g, f.x1, f.y1, f.x2, f.y2);
    }
    g.lineCap = 'butt';
  }

  private overgrowth(g: CanvasRenderingContext2D, a: Area, n: number): void {
    for (let i = 0; i < n; i++) {
      const x = a.x + hash2(i, Math.round(a.x), 31) * a.w;
      const y = a.y + hash2(i, Math.round(a.y), 32) * a.h;
      const rr = 4 + hash2(i, 3, Math.round(a.w)) * 10;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      const col = hash2(i, 5, 7) < 0.5 ? '106,102,64' : '30,38,20';
      gr.addColorStop(0, `rgba(${col},0.35)`);
      gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr;
      g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
  }

  private drawArea(g: CanvasRenderingContext2D, a: Area, scale: number): void {
    const T = this.tex;
    const grassOver = (alpha: number) => {
      if (scale < 0.5) return;
      g.globalAlpha = alpha;
      g.fillStyle = worldPattern(g, T.grass);
      g.fillRect(a.x, a.y, a.w, a.h);
      g.globalAlpha = 1;
    };
    switch (a.kind) {
      case 'lawn':
      case 'yard': {
        const cols = ['#4a5933', '#53603a', '#46552f', '#5a6240', '#4e5b35', '#58603b'];
        g.fillStyle = cols[Math.floor(a.v * cols.length)];
        g.fillRect(a.x, a.y, a.w, a.h);
        grassOver(0.75);
        if (scale >= 0.5) this.overgrowth(g, a, Math.ceil((a.w * a.h) / 900));
        break;
      }
      case 'park':
        g.fillStyle = '#465631';
        g.fillRect(a.x, a.y, a.w, a.h);
        grassOver(0.75);
        if (scale >= 0.5) this.overgrowth(g, a, Math.ceil((a.w * a.h) / 1400));
        break;
      case 'graveyard':
        g.fillStyle = '#44522e';
        g.fillRect(a.x, a.y, a.w, a.h);
        grassOver(0.6);
        break;
      case 'concrete':
      case 'plaza': {
        g.fillStyle = a.kind === 'plaza' ? '#6f695f' : '#5f5e59';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.globalAlpha = 0.85;
          g.fillStyle = worldPattern(g, T.concrete);
          g.fillRect(a.x, a.y, a.w, a.h);
          g.globalAlpha = 1;
        }
        if (scale >= 0.9) {
          const step = a.kind === 'plaza' ? 10 : 22;
          g.strokeStyle = 'rgba(20,18,14,0.3)';
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
        this.stains(g, a, 2600, 'rgba(10,10,10,0.22)');
        break;
      }
      case 'parking': {
        g.fillStyle = '#2f3134';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.fillStyle = worldPattern(g, T.asphalt);
          g.fillRect(a.x, a.y, a.w, a.h);
        }
        g.strokeStyle = 'rgba(185,182,170,0.34)';
        g.lineWidth = 0.75;
        g.beginPath();
        const stallW = 12;
        const stallD = 22;
        if (!a.o) {
          for (let row = 0; row * stallD + stallD <= a.h; row++) {
            if (row % 3 === 2) continue;
            for (let x = a.x + 4; x <= a.x + a.w - 2; x += stallW) {
              if (hash2(Math.round(x), row, 9) < 0.15) continue;
              g.moveTo(x, a.y + row * stallD + 2);
              g.lineTo(x, a.y + row * stallD + stallD - 2);
            }
          }
        } else {
          for (let col = 0; col * stallD + stallD <= a.w; col++) {
            if (col % 3 === 2) continue;
            for (let y = a.y + 4; y <= a.y + a.h - 2; y += stallW) {
              if (hash2(Math.round(y), col, 9) < 0.15) continue;
              g.moveTo(a.x + col * stallD + 2, y);
              g.lineTo(a.x + col * stallD + stallD - 2, y);
            }
          }
        }
        g.stroke();
        this.stains(g, a, 700, 'rgba(0,0,0,0.3)');
        break;
      }
      case 'driveway':
        g.fillStyle = '#5c5952';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.globalAlpha = 0.7;
          g.fillStyle = worldPattern(g, T.concrete);
          g.fillRect(a.x, a.y, a.w, a.h);
          g.globalAlpha = 1;
        }
        break;
      case 'path':
        g.fillStyle = '#665e4c';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.globalAlpha = 0.6;
          g.fillStyle = worldPattern(g, T.dirt);
          g.fillRect(a.x, a.y, a.w, a.h);
          g.globalAlpha = 1;
        }
        break;
      case 'dirt':
      case 'lot':
        g.fillStyle = '#54473a';
        g.fillRect(a.x, a.y, a.w, a.h);
        if (scale >= 0.5) {
          g.fillStyle = worldPattern(g, T.dirt);
          g.fillRect(a.x, a.y, a.w, a.h);
        }
        break;
      case 'crops': {
        g.fillStyle = '#55532f';
        g.fillRect(a.x, a.y, a.w, a.h);
        const rowCol = a.v < 0.5 ? '#434b27' : '#6a6038';
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
        grassOver(0.35);
        if (scale >= 0.5) this.overgrowth(g, a, Math.ceil((a.w * a.h) / 1600));
        g.strokeStyle = 'rgba(40,34,20,0.5)';
        g.lineWidth = 2;
        g.strokeRect(a.x, a.y, a.w, a.h);
        break;
      }
      case 'track': {
        g.fillStyle = '#4a5c32';
        g.fillRect(a.x, a.y, a.w, a.h);
        grassOver(0.6);
        const rr = Math.min(a.w, a.h) / 2 - 4;
        g.strokeStyle = '#6b3a2e';
        g.lineWidth = 10;
        roundRectPath(g, a.x + 9, a.y + 9, a.w - 18, a.h - 18, rr - 5);
        g.stroke();
        g.strokeStyle = 'rgba(200,195,185,0.25)';
        g.lineWidth = 0.5;
        roundRectPath(g, a.x + 9, a.y + 9, a.w - 18, a.h - 18, rr - 5);
        g.stroke();
        g.strokeStyle = 'rgba(205,205,195,0.35)';
        g.lineWidth = 0.7;
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
        if (scale >= 0.5) this.overgrowth(g, a, 10);
        break;
      }
      case 'court':
        g.fillStyle = '#30404a';
        g.fillRect(a.x, a.y, a.w, a.h);
        g.fillStyle = '#5c3a2c';
        g.fillRect(a.x + 4, a.y + 4, a.w - 8, a.h - 8);
        g.strokeStyle = 'rgba(205,205,195,0.45)';
        g.lineWidth = 0.6;
        g.strokeRect(a.x + 4, a.y + 4, a.w - 8, a.h - 8);
        g.beginPath();
        g.moveTo(a.x + a.w / 2, a.y + 4);
        g.lineTo(a.x + a.w / 2, a.y + a.h - 4);
        g.stroke();
        this.stains(g, a, 600, 'rgba(0,0,0,0.25)');
        break;
      case 'pond': {
        const cx = a.x + a.w / 2;
        const cy = a.y + a.h / 2;
        blurred(g, 2.5 * scale, () => {
          g.fillStyle = '#433d2c';
          g.beginPath();
          g.ellipse(cx, cy, a.w / 2 + 5, a.h / 2 + 5, 0, 0, Math.PI * 2);
          g.fill();
        });
        g.fillStyle = '#334548';
        g.beginPath();
        g.ellipse(cx, cy, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
        g.fill();
        blurred(g, 4 * scale, () => {
          g.fillStyle = '#23333a';
          g.beginPath();
          g.ellipse(cx + 2, cy + 2, a.w / 2 - 8, a.h / 2 - 7, 0, 0, Math.PI * 2);
          g.fill();
        });
        // algae / lily pads
        g.fillStyle = 'rgba(70,90,50,0.55)';
        for (let i = 0; i < 6; i++) {
          g.beginPath();
          g.arc(cx + (hash2(i, 1, 3) - 0.5) * a.w * 0.7, cy + (hash2(i, 2, 3) - 0.5) * a.h * 0.6, 1.2 + hash2(i, 3, 3) * 2, 0, Math.PI * 2);
          g.fill();
        }
        break;
      }
      case 'pool': {
        g.fillStyle = '#77736a';
        g.fillRect(a.x - 2, a.y - 2, a.w + 4, a.h + 4);
        g.fillStyle = a.v < 0.5 ? '#2f4a3e' : '#3b4a2c';
        g.fillRect(a.x, a.y, a.w, a.h);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(a.x, a.y, a.w, 2.2);
        g.fillRect(a.x, a.y, 2.2, a.h);
        g.fillStyle = 'rgba(90,110,60,0.4)';
        g.beginPath();
        g.ellipse(a.x + a.w * 0.6, a.y + a.h * 0.6, a.w * 0.25, a.h * 0.25, 0.4, 0, Math.PI * 2);
        g.fill();
        break;
      }
      default:
        break;
    }
  }

  private stains(g: CanvasRenderingContext2D, a: Area, per: number, col: string): void {
    g.fillStyle = col;
    for (let i = 0; i < (a.w * a.h) / per; i++) {
      const x = a.x + hash2(i, Math.round(a.x), 1) * a.w;
      const y = a.y + hash2(i, Math.round(a.y), 2) * a.h;
      g.beginPath();
      g.ellipse(x, y, 2 + hash2(i, 3, 3) * 6, 1.5 + hash2(i, 4, 4) * 4, hash2(i, 5, 5) * 3, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawTree(g: CanvasRenderingContext2D, p: Prop, scale: number): void {
    const r = p.r;
    if (p.kind === 'pine') {
      const n = 10;
      g.fillStyle = '#18241a';
      starPath(g, p.x, p.y, r, r * 0.7, n, p.a);
      g.fill();
      g.fillStyle = '#223225';
      starPath(g, p.x - r * 0.1, p.y - r * 0.12, r * 0.76, r * 0.52, n, p.a + 0.3);
      g.fill();
      if (scale >= 0.6) {
        g.fillStyle = '#2d4030';
        starPath(g, p.x - r * 0.2, p.y - r * 0.24, r * 0.46, r * 0.32, 8, p.a + 0.1);
        g.fill();
        g.fillStyle = 'rgba(120,140,100,0.12)';
        starPath(g, p.x - r * 0.3, p.y - r * 0.34, r * 0.22, r * 0.14, 6, p.a);
        g.fill();
      }
      return;
    }
    const v = p.v;
    let dark = '#212b19';
    let mid = '#344227';
    let light = '#4e5c35';
    if (v < 0.07) {
      dark = '#3a3519';
      mid = '#56502a';
      light = '#776d3a';
    } else if (v < 0.11) {
      dark = '#33231a';
      mid = '#523222';
      light = '#6e4630';
    } else if (v < 0.4) {
      dark = '#1d2618';
      mid = '#2e3c25';
      light = '#465433';
    } else if (v > 0.85) {
      dark = '#27311c';
      mid = '#3e4c2e';
      light = '#5a663d';
    }
    if (v > 0.965) {
      g.strokeStyle = '#2e2620';
      g.lineCap = 'round';
      for (let k = 0; k < 7; k++) {
        const a = p.a + (k / 7) * Math.PI * 2 + hash2(k, 1, 9) * 0.4;
        const l = r * (0.6 + hash2(k, 2, 9) * 0.4);
        g.lineWidth = 1.3;
        line(g, p.x, p.y, p.x + Math.cos(a) * l, p.y + Math.sin(a) * l);
        g.lineWidth = 0.6;
        line(g, p.x + Math.cos(a) * l * 0.6, p.y + Math.sin(a) * l * 0.6, p.x + Math.cos(a + 0.5) * l, p.y + Math.sin(a + 0.5) * l);
      }
      g.lineCap = 'butt';
      return;
    }
    // irregular dark base
    g.fillStyle = dark;
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const rr = r * (0.9 + hash2(k, Math.round(p.x), Math.round(p.y)) * 0.18);
      if (k) g.lineTo(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr);
      else g.moveTo(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    if (scale < 0.5) {
      g.fillStyle = mid;
      g.beginPath();
      g.arc(p.x - r * 0.2, p.y - r * 0.22, r * 0.62, 0, Math.PI * 2);
      g.fill();
      return;
    }
    // leaf clusters, lit from the north-west
    const n = r > 11 ? 11 : 8;
    for (let k = 0; k < n; k++) {
      const a = p.a + k * 2.39996;
      const d = r * (0.18 + 0.5 * hash2(k, Math.round(p.x), 3));
      const cr = r * (0.3 + 0.16 * hash2(k, Math.round(p.y), 4));
      const cx = p.x + Math.cos(a) * d;
      const cy = p.y + Math.sin(a) * d;
      const lit = clamp(0.5 - (cx - p.x + (cy - p.y)) / (1.6 * r), 0, 1);
      g.fillStyle = lit > 0.5 ? mixHex(mid, light, (lit - 0.5) * 2) : mixHex(dark, mid, lit * 2);
      g.beginPath();
      g.arc(cx, cy, cr, 0, Math.PI * 2);
      g.fill();
    }
    if (scale >= 1) {
      g.fillStyle = 'rgba(160,170,120,0.18)';
      for (let k = 0; k < 6; k++) {
        const a = Math.PI * 1.25 + (hash2(k, 7, Math.round(p.x)) - 0.5) * 1.6;
        const d = r * (0.3 + hash2(k, 8, Math.round(p.y)) * 0.45);
        g.beginPath();
        g.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, r * 0.09, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(0,0,0,0.18)';
      for (let k = 0; k < 5; k++) {
        const a = Math.PI * 0.25 + (hash2(k, 9, Math.round(p.x)) - 0.5) * 1.6;
        const d = r * (0.35 + hash2(k, 10, Math.round(p.y)) * 0.4);
        g.beginPath();
        g.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, r * 0.12, 0, Math.PI * 2);
        g.fill();
      }
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
        g.fillStyle = '#1f2a17';
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#34432a';
        g.beginPath();
        g.arc(p.x - p.r * 0.25, p.y - p.r * 0.3, p.r * 0.62, 0, Math.PI * 2);
        g.fill();
        break;
      case 'dumpster':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = shade(p.c, -0.45);
        g.fillRect(-6, -3.5, 12, 7);
        g.fillStyle = shade(p.c, -0.3);
        g.fillRect(-5.6, -3.1, 11.2, 3);
        g.fillStyle = shade(p.c, -0.4);
        g.fillRect(-5.6, 0.1, 11.2, 3);
        g.fillStyle = 'rgba(110,70,40,0.4)';
        g.fillRect(-4, -2, 3, 1.5);
        g.restore();
        break;
      case 'container':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = shade(p.c, -0.35);
        g.fillRect(-15, -5, 30, 10);
        g.strokeStyle = shade(p.c, -0.55);
        g.lineWidth = 0.6;
        g.beginPath();
        for (let x = -13; x < 15; x += 2.2) {
          g.moveTo(x, -5);
          g.lineTo(x, 5);
        }
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(-15, -5, 30, 4);
        g.fillStyle = 'rgba(100,55,25,0.35)';
        g.fillRect(-10, 1, 6, 3);
        g.fillRect(6, -4, 4, 2);
        g.restore();
        break;
      case 'bench':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = '#3b2e22';
        g.fillRect(-4.5, -1.3, 9, 2.6);
        g.fillStyle = '#4f3f2e';
        g.fillRect(-4.5, -1.3, 9, 0.9);
        g.restore();
        break;
      case 'lamp':
        g.fillStyle = '#26292c';
        g.beginPath();
        g.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#33373b';
        g.lineWidth = 0.9;
        line(g, p.x, p.y, p.x + Math.cos(p.a) * 6, p.y + Math.sin(p.a) * 6);
        g.fillStyle = '#55595d';
        g.fillRect(p.x + Math.cos(p.a) * 6 - 1.5, p.y + Math.sin(p.a) * 6 - 1, 3, 2);
        break;
      case 'debris':
        g.fillStyle = shade(p.c, -0.25);
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
        g.fillStyle = '#5f605c';
        g.fillRect(p.x - 2, p.y - 1.4, 4, 2.8);
        g.fillStyle = '#7d7e78';
        g.fillRect(p.x - 2, p.y - 1.4, 4, 0.9);
        break;
      case 'hay':
        g.fillStyle = '#8a7542';
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#66562f';
        g.lineWidth = 0.6;
        g.beginPath();
        g.arc(p.x, p.y, p.r * 0.55, 0, Math.PI * 1.6);
        g.stroke();
        break;
      case 'barrier':
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.a);
        g.fillStyle = '#a19c90';
        g.fillRect(-7, -1.5, 14, 3);
        g.fillStyle = '#7c2a22';
        for (let x = -7; x < 7; x += 3.5) g.fillRect(x, -1.5, 1.75, 3);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(-7, 0.5, 14, 1);
        g.restore();
        break;
      case 'shed':
        g.fillStyle = shade(p.c, -0.5);
        g.fillRect(p.x - 6, p.y - 1, 12, 5);
        g.fillStyle = shade(p.c, -0.2);
        g.fillRect(p.x - 6, p.y - 6, 12, 5.5);
        g.fillStyle = shade(p.c, -0.08);
        g.fillRect(p.x - 6, p.y - 6, 12, 2.6);
        break;
      case 'fountain':
        g.fillStyle = '#6e685c';
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#2c3d3d';
        g.beginPath();
        g.arc(p.x, p.y, p.r - 3, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(70,90,50,0.45)';
        g.beginPath();
        g.arc(p.x + 4, p.y + 3, p.r * 0.35, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#7f786a';
        g.beginPath();
        g.arc(p.x, p.y, 4, 0, Math.PI * 2);
        g.fill();
        break;
      case 'canopy': {
        const w = p.w ?? 40;
        const h = p.h ?? 30;
        g.fillStyle = '#8f8c84';
        g.fillRect(p.x - w / 2, p.y - h / 2, w, h);
        g.fillStyle = '#74271f';
        g.fillRect(p.x - w / 2, p.y - h / 2, w, 3);
        g.fillRect(p.x - w / 2, p.y + h / 2 - 3, w, 3);
        g.fillStyle = 'rgba(0,0,0,0.16)';
        g.fillRect(p.x - w / 2, p.y, w, h / 2 - 3);
        if (scale >= 0.7) {
          g.globalAlpha = 0.6;
          g.fillStyle = worldPattern(g, this.tex.grain);
          g.fillRect(p.x - w / 2, p.y - h / 2, w, h);
          g.globalAlpha = 1;
        }
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
    const fine = scale >= 0.7;
    // --- wall face (south, in shade) ---
    g.fillStyle = shade(b.wallColor, -0.38);
    g.fillRect(b.x, wallY, b.w, b.wallH);
    if (scale >= 0.5) this.drawFacade(g, b, wallY);
    const grime = g.createLinearGradient(0, wallY, 0, b.y + b.h);
    grime.addColorStop(0, 'rgba(0,0,0,0)');
    grime.addColorStop(1, 'rgba(10,8,6,0.4)');
    g.fillStyle = grime;
    g.fillRect(b.x, wallY, b.w, b.wallH);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(b.x, wallY, b.w, 1);

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
        const metal = b.kind === 'warehouse' || b.kind === 'factory';
        if (scale >= 0.5) {
          g.globalAlpha = metal ? 0.7 : 0.8;
          g.fillStyle = worldPattern(g, metal ? this.tex.metal : this.tex.gravel);
          g.fillRect(x, y, w, rh);
          g.globalAlpha = 1;
        }
        if (scale >= 0.5) this.drawFlatRoofDetails(g, b, rh, scale);
        // parapet: lit top edge, inner shadow on the north/west inner sides
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.fillRect(x + 1.6, y + 1.6, w - 3.2, 2.2);
        g.fillRect(x + 1.6, y + 1.6, 2.2, rh - 3.2);
        g.strokeStyle = shade(rc, 0.14);
        g.lineWidth = 1.6;
        g.strokeRect(x + 0.8, y + 0.8, w - 1.6, rh - 1.6);
        break;
      }
      case 'gable-h': {
        const n = g.createLinearGradient(0, y, 0, y + rh / 2);
        n.addColorStop(0, shade(rc, 0.0));
        n.addColorStop(1, shade(rc, 0.1));
        g.fillStyle = n;
        g.fillRect(x, y, w, rh / 2);
        const s = g.createLinearGradient(0, y + rh / 2, 0, y + rh);
        s.addColorStop(0, shade(rc, -0.16));
        s.addColorStop(1, shade(rc, -0.3));
        g.fillStyle = s;
        g.fillRect(x, y + rh / 2, w, rh / 2);
        if (scale >= 1) shingles(g, x, y, w, rh, true, rc);
        g.fillStyle = shade(rc, 0.16);
        g.fillRect(x, y + rh / 2 - 0.7, w, 1.4);
        break;
      }
      case 'gable-v': {
        const wv = g.createLinearGradient(x, 0, x + w / 2, 0);
        wv.addColorStop(0, shade(rc, 0.0));
        wv.addColorStop(1, shade(rc, 0.1));
        g.fillStyle = wv;
        g.fillRect(x, y, w / 2, rh);
        const ev = g.createLinearGradient(x + w / 2, 0, x + w, 0);
        ev.addColorStop(0, shade(rc, -0.16));
        ev.addColorStop(1, shade(rc, -0.3));
        g.fillStyle = ev;
        g.fillRect(x + w / 2, y, w / 2, rh);
        if (scale >= 1) shingles(g, x, y, w, rh, false, rc);
        g.fillStyle = shade(rc, 0.16);
        g.fillRect(x + w / 2 - 0.7, y, 1.4, rh);
        break;
      }
      case 'hip': {
        const horiz = w >= rh;
        const d = horiz ? rh / 2 : w / 2;
        if (horiz) {
          poly(g, shade(rc, 0.08), [x, y, x + w, y, x + w - d, y + rh / 2, x + d, y + rh / 2]);
          poly(g, shade(rc, -0.26), [x, y + rh, x + w, y + rh, x + w - d, y + rh / 2, x + d, y + rh / 2]);
          poly(g, shade(rc, -0.02), [x, y, x + d, y + rh / 2, x, y + rh]);
          poly(g, shade(rc, -0.17), [x + w, y, x + w - d, y + rh / 2, x + w, y + rh]);
          g.strokeStyle = shade(rc, 0.18);
          g.lineWidth = 0.8;
          line(g, x + d, y + rh / 2, x + w - d, y + rh / 2);
          g.lineWidth = 0.5;
          line(g, x, y, x + d, y + rh / 2);
          line(g, x + w, y, x + w - d, y + rh / 2);
          line(g, x, y + rh, x + d, y + rh / 2);
          line(g, x + w, y + rh, x + w - d, y + rh / 2);
        } else {
          poly(g, shade(rc, -0.02), [x, y, x + w / 2, y + d, x + w / 2, y + rh - d, x, y + rh]);
          poly(g, shade(rc, -0.2), [x + w, y, x + w / 2, y + d, x + w / 2, y + rh - d, x + w, y + rh]);
          poly(g, shade(rc, 0.08), [x, y, x + w, y, x + w / 2, y + d]);
          poly(g, shade(rc, -0.28), [x, y + rh, x + w, y + rh, x + w / 2, y + rh - d]);
          g.strokeStyle = shade(rc, 0.18);
          g.lineWidth = 0.8;
          line(g, x + w / 2, y + d, x + w / 2, y + rh - d);
        }
        break;
      }
    }
    // material grain and weathering on every roof
    if (fine) {
      g.globalAlpha = 0.9;
      g.fillStyle = worldPattern(g, this.tex.grain);
      g.fillRect(x, y, w, rh);
      g.globalAlpha = 1;
    }
    if (b.roof !== 'flat' && scale >= 0.5) {
      // moss and water streaks
      if (h(9) < 0.45) {
        g.fillStyle = 'rgba(70,80,40,0.28)';
        for (let i = 0; i < 3; i++) {
          g.beginPath();
          g.ellipse(x + w * (0.15 + h(10 + i) * 0.7), y + rh * (0.2 + h(20 + i) * 0.6), 2 + h(30 + i) * 5, 1.5 + h(40 + i) * 3, 0, 0, Math.PI * 2);
          g.fill();
        }
      }
      if (h(1) < 0.45) {
        const cx = x + w * (0.2 + h(2) * 0.6);
        const cy = y + rh * (0.15 + h(3) * 0.2);
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(cx + 1.5, cy + 1.5, 4, 4);
        g.fillStyle = '#4a3a33';
        g.fillRect(cx, cy, 3.5, 3.5);
        g.fillStyle = '#5c4a40';
        g.fillRect(cx, cy, 3.5, 1.2);
        g.fillStyle = '#0d0d0d';
        g.fillRect(cx + 0.9, cy + 0.9, 1.7, 1.7);
      }
      if (h(4) < 0.1 && b.kind === 'house') {
        g.fillStyle = '#1b2230';
        const sw = Math.min(w * 0.4, 14);
        const sx = x + w * 0.5 - sw / 2;
        const sy = y + rh * 0.58;
        g.fillRect(sx, sy, sw, rh * 0.3);
        g.strokeStyle = 'rgba(120,140,160,0.25)';
        g.lineWidth = 0.4;
        g.strokeRect(sx, sy, sw, rh * 0.3);
      }
    }
    if (h(5) < 0.14 && b.kind !== 'firestation') this.drawDamage(g, b, rh, h, scale);
    // deco
    if (b.deco === 'helipad') {
      const r = Math.min(w, rh) * 0.22;
      const cx = x + w - r - 8;
      const cy = y + r + 8;
      g.fillStyle = '#3a3d3f';
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(200,198,188,0.55)';
      g.lineWidth = 1.1;
      g.beginPath();
      g.arc(cx, cy, r - 2.5, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 1.8;
      line(g, cx - r * 0.35, cy - r * 0.45, cx - r * 0.35, cy + r * 0.45);
      line(g, cx + r * 0.35, cy - r * 0.45, cx + r * 0.35, cy + r * 0.45);
      line(g, cx - r * 0.35, cy, cx + r * 0.35, cy);
      const kx = x + w * 0.3;
      const ky = y + rh * 0.5;
      g.fillStyle = 'rgba(130,36,30,0.85)';
      g.fillRect(kx - 9, ky - 3, 18, 6);
      g.fillRect(kx - 3, ky - 9, 6, 18);
    }
    if (b.deco === 'steeple') {
      const t = steepleRect(b);
      g.fillStyle = shade(b.wallColor, -0.42);
      g.fillRect(t.x, t.y + t.h - 6, t.w, 6);
      poly(g, shade(b.roofColor, 0.06), [t.x, t.y, t.x + t.w, t.y, t.x + t.w / 2, t.y + (t.h - 6) / 2]);
      poly(g, shade(b.roofColor, -0.28), [t.x, t.y + t.h - 6, t.x + t.w, t.y + t.h - 6, t.x + t.w / 2, t.y + (t.h - 6) / 2]);
      poly(g, shade(b.roofColor, -0.04), [t.x, t.y, t.x + t.w / 2, t.y + (t.h - 6) / 2, t.x, t.y + t.h - 6]);
      poly(g, shade(b.roofColor, -0.18), [t.x + t.w, t.y, t.x + t.w / 2, t.y + (t.h - 6) / 2, t.x + t.w, t.y + t.h - 6]);
      g.strokeStyle = '#9a8a5a';
      g.lineWidth = 1;
      const cx = t.x + t.w / 2;
      const cy = t.y + (t.h - 6) / 2;
      line(g, cx, cy - 5, cx, cy + 3);
      line(g, cx - 2.5, cy - 2.5, cx + 2.5, cy - 2.5);
    }
    // crisp edges: lit north-west, dark south-east
    g.fillStyle = 'rgba(255,250,235,0.1)';
    g.fillRect(x, y, w, 0.8);
    g.fillRect(x, y, 0.8, rh);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x + w - 0.8, y, 0.8, b.h);
    g.fillRect(x, y + b.h - 0.9, w, 0.9);
  }

  private drawDamage(g: CanvasRenderingContext2D, b: BuildingDef, rh: number, h: (n: number) => number, scale: number): void {
    const sr = Math.min(b.w, rh, 44);
    const cx = b.x + b.w * (0.3 + h(6) * 0.4);
    const cy = b.y + rh * (0.3 + h(7) * 0.4);
    // soot
    blurred(g, 3 * scale, () => {
      g.fillStyle = 'rgba(12,10,9,0.55)';
      g.beginPath();
      g.ellipse(cx, cy, sr * 0.32, sr * 0.22, h(8) * 3, 0, Math.PI * 2);
      g.fill();
    });
    if (h(11) < 0.6) {
      // collapsed hole with debris
      g.fillStyle = '#0a0908';
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const rr = sr * (0.1 + h(50 + k) * 0.08);
        if (k) g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8);
        else g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8);
      }
      g.closePath();
      g.fill();
      g.fillStyle = '#3a312a';
      for (let k = 0; k < 5; k++) g.fillRect(cx + (h(60 + k) - 0.5) * sr * 0.3, cy + (h(70 + k) - 0.5) * sr * 0.25, 1.4, 0.9);
    }
  }

  private drawFacade(g: CanvasRenderingContext2D, b: BuildingDef, wallY: number): void {
    const H = b.wallH;
    const h = (n: number) => hash2(b.id, n, 91);
    const glass = '#14191e';
    const glassHi = '#26303a';
    const frontSouth = b.facing === 's';
    const win = (wx: number, wy: number, ww: number, wh: number, k: number) => {
      const r = h(100 + k);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(wx - 0.4, wy - 0.4, ww + 0.8, wh + 0.8);
      if (r < 0.18) {
        g.fillStyle = '#4a3c2c';
        g.fillRect(wx, wy, ww, wh);
        g.fillStyle = '#2e251b';
        g.fillRect(wx, wy + wh * 0.35, ww, 0.5);
        g.fillRect(wx, wy + wh * 0.7, ww, 0.5);
        return;
      }
      g.fillStyle = r < 0.3 ? '#08090a' : glass;
      g.fillRect(wx, wy, ww, wh);
      if (r >= 0.3) {
        g.fillStyle = glassHi;
        g.fillRect(wx, wy, ww, wh * 0.3);
      } else {
        g.fillStyle = 'rgba(150,160,170,0.35)';
        g.beginPath();
        g.moveTo(wx, wy);
        g.lineTo(wx + ww * 0.5, wy);
        g.lineTo(wx, wy + wh * 0.6);
        g.fill();
      }
    };
    switch (b.kind) {
      case 'shop':
      case 'diner':
      case 'pharmacy':
      case 'hardware':
      case 'supermarket':
      case 'gas': {
        if (frontSouth) {
          const awn = ['#5e2a24', '#2a4038', '#7a5c28', '#2c3a52', '#4e2c45', '#36492c'][Math.floor(h(1) * 6)];
          const kind = b.kind === 'pharmacy' ? '#24503a' : b.kind === 'supermarket' ? '#2a4a2c' : awn;
          g.fillStyle = glass;
          g.fillRect(b.x + 2, wallY + H * 0.38, b.w - 4, H * 0.55);
          g.fillStyle = glassHi;
          g.fillRect(b.x + 2, wallY + H * 0.38, b.w - 4, H * 0.12);
          g.fillStyle = shade(b.wallColor, -0.55);
          for (let x = b.x + 2; x < b.x + b.w - 2; x += 9) g.fillRect(x, wallY + H * 0.38, 0.8, H * 0.55);
          // awning, sometimes torn
          const torn = h(2) < 0.35;
          g.fillStyle = kind;
          if (torn) {
            g.beginPath();
            g.moveTo(b.x, wallY);
            g.lineTo(b.x + b.w, wallY);
            g.lineTo(b.x + b.w, wallY + H * 0.2);
            for (let x = b.x + b.w; x > b.x; x -= 4) g.lineTo(x - 2, wallY + H * (0.18 + h(x) * 0.18));
            g.closePath();
            g.fill();
          } else g.fillRect(b.x, wallY, b.w, H * 0.34);
          g.fillStyle = 'rgba(255,255,255,0.08)';
          for (let x = b.x; x < b.x + b.w; x += 6) g.fillRect(x, wallY, 3, H * (torn ? 0.16 : 0.34));
        } else this.windowRows(b, wallY, win);
        break;
      }
      case 'firestation': {
        if (frontSouth) {
          const n = 3;
          const dw = (b.w - 8) / n - 3;
          for (let i = 0; i < n; i++) {
            const dx = b.x + 4 + i * (dw + 3);
            g.fillStyle = '#7d786e';
            g.fillRect(dx, wallY + H * 0.2, dw, H * 0.8);
            g.fillStyle = 'rgba(0,0,0,0.25)';
            for (let yy = wallY + H * 0.3; yy < b.y + b.h; yy += 2) g.fillRect(dx, yy, dw, 0.5);
          }
        } else this.windowRows(b, wallY, win);
        break;
      }
      case 'warehouse':
      case 'factory': {
        if (frontSouth) {
          for (let x = b.x + 8; x < b.x + b.w - 20; x += 26) {
            g.fillStyle = '#4c4f52';
            g.fillRect(x, wallY + H * 0.3, 16, H * 0.7);
            g.fillStyle = 'rgba(0,0,0,0.25)';
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
          g.fillStyle = '#3e1a14';
          g.fillRect(dx, wallY + 1.5, 16, H - 1.5);
          g.strokeStyle = 'rgba(170,160,140,0.6)';
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
        this.windowRows(b, wallY, win);
        if (frontSouth && (b.kind === 'house' || b.kind === 'bungalow' || b.kind === 'farmhouse')) {
          g.fillStyle = '#2c2119';
          g.fillRect(b.x + b.w / 2 - 2, wallY + H * 0.3, 4, H * 0.7);
        }
    }
  }

  private windowRows(b: BuildingDef, wallY: number, win: (x: number, y: number, w: number, h: number, k: number) => void): void {
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

  private drawFlatRoofDetails(g: CanvasRenderingContext2D, b: BuildingDef, rh: number, scale: number): void {
    const h = (n: number) => hash2(b.id, n, 33);
    const big = b.w * rh > 4000;
    if (b.kind === 'warehouse' || b.kind === 'factory') {
      // corrugated metal with rust runs
      g.lineWidth = 0.9;
      for (let x = b.x + 2, i = 0; x < b.x + b.w - 1; x += 2.6, i++) {
        g.strokeStyle = i % 2 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.05)';
        g.beginPath();
        g.moveTo(x, b.y + 1.5);
        g.lineTo(x, b.y + rh - 1.5);
        g.stroke();
      }
      for (let i = 0; i < 4; i++) {
        const rx = b.x + 6 + h(80 + i) * (b.w - 12);
        const gr = g.createLinearGradient(0, b.y, 0, b.y + rh);
        gr.addColorStop(0, 'rgba(110,60,30,0)');
        gr.addColorStop(0.5, 'rgba(110,60,30,0.3)');
        gr.addColorStop(1, 'rgba(110,60,30,0)');
        g.fillStyle = gr;
        g.fillRect(rx, b.y + 2, 3 + h(90 + i) * 4, rh - 4);
      }
      for (let x = b.x + 14; x < b.x + b.w - 14; x += 28) {
        g.fillStyle = 'rgba(40,52,58,0.75)';
        g.fillRect(x, b.y + 6, 8, rh - 12);
        g.fillStyle = 'rgba(150,170,175,0.12)';
        g.fillRect(x, b.y + 6, 8, (rh - 12) * 0.3);
      }
    }
    // ponding water stains
    blurred(g, 2 * scale, () => {
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const ex = b.x + b.w * (0.15 + h(i) * 0.7);
        const ey = b.y + rh * (0.15 + h(i + 9) * 0.7);
        const rx = 3 + h(i + 3) * b.w * 0.12;
        g.moveTo(ex + rx, ey);
        g.ellipse(ex, ey, rx, 2 + h(i + 5) * rh * 0.1, h(i + 7) * 3, 0, Math.PI * 2);
      }
      g.fill();
    });
    // rooftop plant: AC units, vents, hatch
    const n = big ? 3 + Math.floor(h(20) * 4) : Math.floor(h(20) * 3);
    for (let i = 0; i < n; i++) {
      const ax = b.x + 5 + h(30 + i) * (b.w - 16);
      const ay = b.y + 5 + h(40 + i) * (rh - 15);
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(ax + 2, ay + 1.6, 7, 6);
      g.fillStyle = '#6a6c69';
      g.fillRect(ax, ay, 7, 6);
      g.fillStyle = '#82847f';
      g.fillRect(ax, ay, 7, 1.6);
      g.fillStyle = '#4a4c4a';
      g.fillRect(ax + 6, ay, 1, 6);
      g.fillStyle = '#1b1c1c';
      g.beginPath();
      g.arc(ax + 3.4, ay + 3.4, 1.9, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < (big ? 4 : 2); i++) {
      const vx = b.x + 4 + h(50 + i) * (b.w - 8);
      const vy = b.y + 4 + h(60 + i) * (rh - 8);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(vx + 1, vy + 0.8, 1.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#5d5f5c';
      g.beginPath();
      g.arc(vx, vy, 1.3, 0, Math.PI * 2);
      g.fill();
    }
    if (b.kind === 'supermarket' || b.kind === 'apartment' || b.kind === 'office') {
      g.fillStyle = 'rgba(30,40,48,0.8)';
      g.fillRect(b.x + b.w * 0.3, b.y + rh * 0.35, b.w * 0.15, rh * 0.3);
      g.fillStyle = 'rgba(150,170,180,0.1)';
      g.fillRect(b.x + b.w * 0.3, b.y + rh * 0.35, b.w * 0.15, rh * 0.1);
    }
    if (b.kind === 'police') {
      g.fillStyle = 'rgba(20,28,45,0.6)';
      g.fillRect(b.x + b.w / 2 - 14, b.y + rh / 2 - 5, 28, 10);
      g.fillStyle = 'rgba(190,190,185,0.55)';
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
  g.strokeStyle = shade(rc, -0.5);
  g.globalAlpha = 0.3;
  g.lineWidth = 0.4;
  g.beginPath();
  if (horiz) {
    for (let yy = y + 1.8; yy < y + h; yy += 1.8) {
      g.moveTo(x, yy);
      g.lineTo(x + w, yy);
    }
  } else {
    for (let xx = x + 1.8; xx < x + w; xx += 1.8) {
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

function bodyPath(g: CanvasRenderingContext2D, L: number, W: number, r: number): void {
  g.beginPath();
  g.moveTo(-L / 2 + r, -W / 2);
  g.lineTo(L / 2 - r, -W / 2);
  g.quadraticCurveTo(L / 2, -W / 2, L / 2, -W / 2 + r);
  g.lineTo(L / 2, W / 2 - r);
  g.quadraticCurveTo(L / 2, W / 2, L / 2 - r, W / 2);
  g.lineTo(-L / 2 + r, W / 2);
  g.quadraticCurveTo(-L / 2, W / 2, -L / 2, W / 2 - r);
  g.lineTo(-L / 2, -W / 2 + r);
  g.quadraticCurveTo(-L / 2, -W / 2, -L / 2 + r, -W / 2);
  g.closePath();
}

export function drawVehicle(g: CanvasRenderingContext2D, p: Prop, scale: number): void {
  const [L, W] = propDims(p)!;
  const burnt = p.v === 1 && p.kind === 'car' && p.c === '#2a2522';
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.a);
  const paint = p.kind === 'firetruck' ? '#7e2620' : p.kind === 'bus' ? (p.v > 0.5 ? '#9a7a2e' : '#9a9890') : burnt ? '#1d1a17' : shade(p.c, -0.22);
  bodyPath(g, L, W, p.kind === 'car' || p.kind === 'police' ? 2.4 : 1.2);
  g.fillStyle = shade(paint, -0.4);
  g.fill();
  bodyPath(g, L - 1, W - 1, 2);
  g.fillStyle = paint;
  g.fill();
  if (p.kind === 'car' || p.kind === 'police') {
    const glass = burnt ? '#0b0a09' : '#12171c';
    g.fillStyle = glass;
    g.fillRect(L * 0.08, -W / 2 + 1.2, L * 0.17, W - 2.4);
    g.fillRect(-L * 0.36, -W / 2 + 1.4, L * 0.1, W - 2.8);
    g.fillStyle = burnt ? '#2a221c' : shade(paint, 0.08);
    g.fillRect(-L * 0.26, -W / 2 + 1.4, L * 0.34, W - 2.8);
    if (!burnt) {
      g.fillStyle = 'rgba(180,195,205,0.18)';
      g.fillRect(L * 0.1, -W / 2 + 1.4, L * 0.05, W - 2.8);
    }
    if (p.kind === 'police') {
      g.fillStyle = '#16191c';
      g.fillRect(-L / 2 + 0.6, -W / 2 + 0.6, L * 0.25, W - 1.2);
      g.fillRect(L * 0.3, -W / 2 + 0.6, L * 0.19, W - 1.2);
      g.fillStyle = '#7a2424';
      g.fillRect(-L * 0.06, -W / 2 + 1.4, 1.6, (W - 2.8) / 2);
      g.fillStyle = '#243f7a';
      g.fillRect(-L * 0.06, 0, 1.6, (W - 2.8) / 2);
    }
    if (burnt) {
      g.fillStyle = 'rgba(110,55,25,0.55)';
      g.fillRect(-L * 0.4, -W * 0.3, 3, 2);
      g.fillRect(L * 0.3, W * 0.1, 2, 2);
      g.fillRect(-L * 0.1, W * 0.2, 2.5, 1.5);
    }
  } else if (p.kind === 'truck' || p.kind === 'firetruck') {
    g.fillStyle = shade(paint, -0.1);
    g.fillRect(L / 2 - 8, -W / 2 + 0.6, 7.4, W - 1.2);
    g.fillStyle = '#12171c';
    g.fillRect(L / 2 - 2.6, -W / 2 + 1.4, 1.8, W - 2.8);
    if (p.kind === 'firetruck') {
      g.fillStyle = '#86857f';
      g.fillRect(-L / 2 + 2, -1.8, L - 12, 3.6);
      g.fillStyle = '#55554f';
      for (let x = -L / 2 + 3; x < L / 2 - 10; x += 3) g.fillRect(x, -1.8, 0.6, 3.6);
    } else {
      g.fillStyle = shade(paint, 0.05);
      g.fillRect(-L / 2 + 1, -W / 2 + 1, L - 10, W - 2);
    }
  } else if (p.kind === 'bus') {
    g.fillStyle = '#14191e';
    for (let x = -L / 2 + 3; x < L / 2 - 4; x += 5) {
      g.fillRect(x, -W / 2 + 0.8, 3.4, 1.4);
      g.fillRect(x, W / 2 - 2.2, 3.4, 1.4);
    }
    g.fillStyle = shade(paint, 0.06);
    g.fillRect(-L / 2 + 2, -W / 2 + 2.6, L - 4, W - 5.2);
  }
  if (scale >= 0.7) {
    // road grime on the lower body
    g.fillStyle = 'rgba(60,50,35,0.25)';
    g.fillRect(-L / 2 + 0.5, W / 2 - 2.2, L - 1, 1.7);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(-L / 2 + 0.5, -0.2, L - 1, W / 2);
  }
  g.restore();
}
