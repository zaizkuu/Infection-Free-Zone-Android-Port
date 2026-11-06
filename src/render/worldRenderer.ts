import type { Camera } from './camera';
import { MapRenderer } from './mapRenderer';
import { makeCanvas } from './textures';
import { hexA, shade, type Vec } from '../core/math';
import { hash2 } from '../core/rng';
import type { MapData } from '../world/types';
import { BUILD_RANGE, FOG_CELL, GUARD_COLOR, SQUAD_COLORS, STRUCTS, ZKINDS, hourOf, maxHpOf, nightness, type GameState, type StructKind, type Survivor, type Zombie } from '../game/state';
import type { Runtime } from '../game/sim';

export interface ViewState {
  selectedSquad: number;
  selectedBuilding: number;
  placing: StructKind | null;
  ghost: Vec | null;
  ghostOk: boolean;
  markers: { x: number; y: number; t: number; c: string }[];
  time: number; // real seconds, for animation
}

/** Units are drawn slightly larger than their collision size so they read well on phones. */
const UNIT_SCALE = 1.25;
const SKIN = ['#e0b48f', '#c99470', '#a8734f', '#7a4f33', '#f0c8a6', '#8c5a3c'];
const ZCLOTH = ['#55604a', '#6a5a4a', '#4c5a60', '#5e4f5a', '#646b55', '#3f4a3c'];

export class WorldRenderer {
  readonly mapR: MapRenderer;
  private fog: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  private light: HTMLCanvasElement;
  private lightCtx: CanvasRenderingContext2D;

  constructor(
    private map: MapData,
    fogW: number,
    fogH: number,
  ) {
    this.mapR = new MapRenderer(map);
    this.fog = makeCanvas(fogW, fogH);
    this.fogCtx = this.fog.getContext('2d')!;
    this.light = makeCanvas(4, 4);
    this.lightCtx = this.light.getContext('2d')!;
  }

  updateFog(rt: Runtime): void {
    const img = this.fogCtx.createImageData(rt.fogW, rt.fogH);
    for (let i = 0; i < rt.explored.length; i++) {
      const o = i * 4;
      img.data[o] = 9;
      img.data[o + 1] = 12;
      img.data[o + 2] = 18;
      img.data[o + 3] = rt.explored[i] ? 0 : 228;
    }
    this.fogCtx.putImageData(img, 0, 0);
    rt.fogDirty = false;
  }

  render(ctx: CanvasRenderingContext2D, cam: Camera, st: GameState, rt: Runtime, view: ViewState, opts: { fog: boolean; budget?: number } = { fog: true }): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const s = cam.scale;
    const L = cam.left;
    const T = cam.top;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, W, H);
    this.mapR.render(ctx, L, T, s, W, H, opts.budget ?? 9);

    ctx.setTransform(s, 0, 0, s, -L * s, -T * s);
    const vx1 = L + W / s;
    const vy1 = T + H / s;
    const inView = (x: number, y: number, m = 40) => x > L - m && x < vx1 + m && y > T - m && y < vy1 + m;
    const now = view.time;
    const night = nightness(st.time);

    // ---- decals ----
    for (const d of rt.decals) {
      if (!inView(d.x, d.y)) continue;
      const a = Math.max(0, 1 - d.t / 90);
      ctx.fillStyle = `rgba(70,12,12,${0.55 * a})`;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r * 1.3, d.r * 0.9, d.a, 0, Math.PI * 2);
      ctx.fill();
      if (d.corpse) {
        ctx.fillStyle = `rgba(55,62,45,${0.9 * a})`;
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, d.r * 0.75, d.r * 0.45, d.a, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- build range when placing ----
    if (view.placing) {
      ctx.beginPath();
      st.b.forEach((b, i) => {
        if (!b.owned) return;
        const d = this.map.buildings[i];
        roundRect(ctx, d.x - BUILD_RANGE, d.y - BUILD_RANGE, d.w + BUILD_RANGE * 2, d.h + BUILD_RANGE * 2, BUILD_RANGE);
      });
      ctx.fillStyle = 'rgba(255,138,61,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,138,61,0.5)';
      ctx.lineWidth = 1.5 / cam.zoom;
      ctx.setLineDash([6 / cam.zoom, 5 / cam.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- haven overlays ----
    st.b.forEach((b, i) => {
      const d = this.map.buildings[i];
      if (!inView(d.x + d.w / 2, d.y + d.h / 2, Math.max(d.w, d.h))) return;
      if (b.owned) {
        // barricades
        const lv = b.fort;
        if (lv >= 1) ring(ctx, d, 3.5, '#8b6b45', 2.6, [5, 2.5]);
        if (lv >= 2) ring(ctx, d, 7, '#b9a27a', 3.2, [3.5, 1.2]);
        if (lv >= 3) ring(ctx, d, 10.5, '#7d858c', 2, [2, 1.8]);
        ctx.strokeStyle = hexA('#ff8a3d', 0.9);
        ctx.lineWidth = 1.3;
        ctx.strokeRect(d.x - 0.5, d.y - 0.5, d.w + 1, d.h + 1);
        ctx.strokeStyle = hexA('#ff8a3d', 0.25);
        ctx.lineWidth = 4;
        ctx.strokeRect(d.x - 2, d.y - 2, d.w + 4, d.h + 4);
        const max = maxHpOf(this.map, st.b, i);
        if (b.hp < max) bar(ctx, d.x + d.w / 2, d.y - 8, Math.min(d.w, 60), 3, b.hp / max, b.hp / max > 0.5 ? '#7ccf6a' : b.hp / max > 0.25 ? '#f0b44a' : '#e5484d');
        if (i === this.map.hqId) havenBadge(ctx, d.x + d.w / 2, d.y + (d.h - d.wallH) / 2, cam.zoom, now);
      } else if (b.explored && cam.zoom > 0.5) {
        const l = b.loot;
        const types: string[] = [];
        if (l.food) types.push('#7ccf6a');
        if (l.mat) types.push('#d29a5a');
        if (l.ammo) types.push('#f0d35a');
        if (l.med) types.push('#ef6b6b');
        if (l.guns) types.push('#b0bec5');
        if (!types.length) {
          ctx.fillStyle = 'rgba(25,28,32,0.28)';
          ctx.fillRect(d.x, d.y, d.w, d.h);
        } else lootPill(ctx, d.x + d.w / 2, d.y + (d.h - d.wallH) / 2, types, cam.zoom);
        if (b.survivors > 0) personBadge(ctx, d.x + d.w / 2, d.y - 6, cam.zoom);
      }
      if (b.breached && !b.owned) {
        ctx.fillStyle = 'rgba(60,10,10,0.18)';
        ctx.fillRect(d.x, d.y, d.w, d.h);
      }
    });

    // squads inside buildings: progress rings
    for (const sq of st.squads) {
      const o = sq.order;
      if (o.phase !== 'inside' || o.b === undefined) continue;
      const d = this.map.buildings[o.b];
      const p = Math.min(1, (o.timer ?? 0) / (o.total || 1));
      const cx = d.door.x;
      const cy = d.door.y - 4;
      const r = 7 / Math.min(1, cam.zoom);
      ctx.fillStyle = 'rgba(12,16,22,0.8)';
      ctx.beginPath();
      ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 2.2 / Math.min(1, cam.zoom);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = SQUAD_COLORS[sq.id];
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = SQUAD_COLORS[sq.id];
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // selected building brackets
    if (view.selectedBuilding >= 0) {
      const d = this.map.buildings[view.selectedBuilding];
      const pulse = 1 + Math.sin(now * 5) * 0.5;
      brackets(ctx, d.x - 4 - pulse, d.y - 4 - pulse, d.w + 8 + pulse * 2, d.h + 8 + pulse * 2, Math.min(12, d.w / 3, d.h / 3), 2 / Math.min(1.2, cam.zoom));
    }

    // ---- structures ----
    for (const sobj of st.structures) {
      if (!inView(sobj.x, sobj.y)) continue;
      drawStructure(ctx, sobj.kind, sobj.x, sobj.y, now + sobj.id, night, 1);
      if (sobj.hp < STRUCTS[sobj.kind].hp) bar(ctx, sobj.x, sobj.y - STRUCTS[sobj.kind].r - 12, 18, 2.2, sobj.hp / STRUCTS[sobj.kind].hp, '#7ccf6a');
    }
    // fires on wrecks
    for (const f of st.fires) if (inView(f.x, f.y)) drawFire(ctx, f.x, f.y - 1, now + f.x, 1.2);

    // ---- selected squad path ----
    if (view.selectedSquad >= 0) {
      const col = SQUAD_COLORS[view.selectedSquad];
      ctx.strokeStyle = hexA(col, 0.5);
      ctx.lineWidth = 1.2 / Math.min(1, cam.zoom);
      ctx.setLineDash([4 / Math.min(1, cam.zoom), 4 / Math.min(1, cam.zoom)]);
      for (const m of st.survivors) {
        if (m.squad !== view.selectedSquad || !m.path || !m.path.length || m.inside >= 0) continue;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        for (const p of m.path) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // ---- units (y-sorted) ----
    const units: (Survivor | Zombie)[] = [];
    for (const z of st.zombies) if (z.seen && inView(z.x, z.y)) units.push(z);
    for (const sv of st.survivors) if (sv.inside < 0 && inView(sv.x, sv.y)) units.push(sv);
    units.sort((a, b) => a.y - b.y);
    // selection rings under units
    for (const u of units) {
      if ('squad' in u && u.squad === view.selectedSquad && view.selectedSquad >= 0) {
        ctx.strokeStyle = hexA(SQUAD_COLORS[u.squad], 0.85);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.ellipse(u.x, u.y + 1, 7.5, 6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (const u of units) {
      if ('squad' in u) drawSurvivor(ctx, u, now);
      else drawZombie(ctx, u, now);
    }
    // hp bars
    for (const u of units) {
      const max = 'squad' in u ? u.maxHp : ZKINDS[u.kind].hp;
      if (u.hp < max) bar(ctx, u.x, u.y - 10, 10, 1.6, u.hp / max, 'squad' in u ? '#7ccf6a' : '#e5484d');
    }

    // ---- effects ----
    ctx.lineCap = 'round';
    for (const t of rt.tracers) {
      const a = 1 - t.t / 0.09;
      ctx.strokeStyle = `rgba(255,236,170,${0.85 * a})`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    for (const f of rt.flashes) {
      ctx.fillStyle = `rgba(255,220,130,${1 - f.t / 0.08})`;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of rt.particles) {
      const a = 1 - p.t / p.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;

    // ---- markers ----
    for (const m of view.markers) {
      const k = m.t / 0.7;
      ctx.strokeStyle = hexA(m.c, 1 - k);
      ctx.lineWidth = 1.6 / Math.min(1, cam.zoom);
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, 4 + k * 12, 3 + k * 9, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- placement ghost ----
    if (view.placing && view.ghost) {
      ctx.globalAlpha = 0.75;
      drawStructure(ctx, view.placing, view.ghost.x, view.ghost.y, now, 0, 1);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = view.ghostOk ? '#7ccf6a' : '#e5484d';
      ctx.lineWidth = 1.5 / Math.min(1, cam.zoom);
      ctx.beginPath();
      ctx.arc(view.ghost.x, view.ghost.y, STRUCTS[view.placing].r + 4, 0, Math.PI * 2);
      ctx.stroke();
      if (view.placing === 'tower') {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(view.ghost.x, view.ghost.y, 200, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- clouds (day) ----
    if (night < 0.9) {
      ctx.globalAlpha = 1 - night;
      for (let i = 0; i < 5; i++) {
        const cx = ((hash2(i, 1, 5) * this.map.width + now * (6 + i)) % (this.map.width + 800)) - 400;
        const cy = hash2(i, 2, 5) * this.map.height;
        const r = 220 + hash2(i, 3, 5) * 200;
        if (!inView(cx, cy, r)) continue;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, 'rgba(15,25,35,0.13)');
        g.addColorStop(1, 'rgba(15,25,35,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.7, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // ---- colour grading & night lighting ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const h = hourOf(st.time);
    const warm = h > 16 && h < 21 ? Math.sin(((h - 16) / 5) * Math.PI) : h > 4 && h < 8 ? Math.sin(((h - 4) / 4) * Math.PI) * 0.7 : 0;
    if (warm > 0.01) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(255,${Math.round(190 - 40 * warm)},${Math.round(150 - 70 * warm)},${0.45 * warm})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (night > 0.01) this.drawLighting(ctx, cam, st, rt, night, now);

    // ---- fog of war ----
    if (opts.fog) {
      if (rt.fogDirty) this.updateFog(rt);
      ctx.setTransform(s, 0, 0, s, -L * s, -T * s);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fog, 0, 0, rt.fogW, rt.fogH, 0, 0, rt.fogW * FOG_CELL, rt.fogH * FOG_CELL);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // vignette (cached per screen size)
    if (!this.vignette || this.vignette.width !== W || this.vignette.height !== H) {
      this.vignette = makeCanvas(W, H);
      const vc = this.vignette.getContext('2d')!;
      const vg = vc.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,1)');
      vc.fillStyle = vg;
      vc.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 0.28 + night * 0.25;
    ctx.drawImage(this.vignette, 0, 0);
    ctx.globalAlpha = 1;
  }

  private vignette: HTMLCanvasElement | null = null;

  private drawLighting(ctx: CanvasRenderingContext2D, cam: Camera, st: GameState, rt: Runtime, night: number, now: number): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const lw = Math.ceil(W / 2);
    const lh = Math.ceil(H / 2);
    if (this.light.width !== lw || this.light.height !== lh) {
      this.light.width = lw;
      this.light.height = lh;
    }
    const g = this.lightCtx;
    const ls = cam.scale / 2;
    const L = cam.left;
    const T = cam.top;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, lw, lh);
    g.fillStyle = `rgba(6,10,26,${0.86 * night})`;
    g.fillRect(0, 0, lw, lh);
    g.globalCompositeOperation = 'destination-out';
    g.setTransform(ls, 0, 0, ls, -L * ls, -T * ls);
    const vx1 = L + W / cam.scale;
    const vy1 = T + H / cam.scale;
    const glow = (x: number, y: number, r: number, a = 1) => {
      if (x + r < L || x - r > vx1 || y + r < T || y - r > vy1) return;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(0,0,0,${a})`);
      gr.addColorStop(0.55, `rgba(0,0,0,${a * 0.6})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    const warmGlows: [number, number, number, number][] = [];
    st.b.forEach((b, i) => {
      if (!b.owned) return;
      const d = this.map.buildings[i];
      const r = Math.max(d.w, d.h) * 0.55 + 60;
      glow(d.x + d.w / 2, d.y + d.h / 2, r, 0.95);
      warmGlows.push([d.x + d.w / 2, d.y + d.h / 2, r * 0.8, 0.12]);
    });
    for (const s of st.structures) {
      const flick = 0.9 + Math.sin(now * 13 + s.id) * 0.05 + Math.sin(now * 7.3 + s.id * 2) * 0.05;
      if (s.kind === 'tower') {
        glow(s.x, s.y, 120, 0.9);
        // sweeping searchlight
        const a = now * 0.7 + s.id;
        const ex = s.x + Math.cos(a) * 150;
        const ey = s.y + Math.sin(a) * 150;
        cone(g, s.x, s.y, a, 210, 0.22);
        warmGlows.push([ex, ey, 40, 0.05]);
      } else if (s.kind === 'barrel') {
        glow(s.x, s.y, 135 * flick, 1);
        warmGlows.push([s.x, s.y, 90 * flick, 0.22]);
      } else glow(s.x, s.y, 50, 0.7);
    }
    for (const f of st.fires) {
      const flick = 0.85 + Math.sin(now * 11 + f.x) * 0.08 + Math.sin(now * 17 + f.y) * 0.07;
      glow(f.x, f.y, 75 * flick, 0.85);
      warmGlows.push([f.x, f.y, 55 * flick, 0.25]);
    }
    for (const sv of st.survivors) {
      if (sv.inside >= 0) continue;
      glow(sv.x, sv.y, 34, 0.75);
      cone(g, sv.x, sv.y, sv.facing, 135, 0.42);
    }
    for (const fl of rt.flashes) {
      glow(fl.x, fl.y, 60, 0.8);
      warmGlows.push([fl.x, fl.y, 30, 0.35]);
    }
    g.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.light, 0, 0, lw, lh, 0, 0, W, H);
    // warm additive glows
    ctx.setTransform(cam.scale, 0, 0, cam.scale, -L * cam.scale, -T * cam.scale);
    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, r, a] of warmGlows) {
      if (x + r < L || x - r > vx1 || y + r < T || y - r > vy1) continue;
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,150,60,${a * night})`);
      gr.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

// ---- drawing helpers -----------------------------------------------------------

function cone(g: CanvasRenderingContext2D, x: number, y: number, a: number, len: number, half: number): void {
  const gr = g.createRadialGradient(x, y, 4, x, y, len);
  gr.addColorStop(0, 'rgba(0,0,0,0.95)');
  gr.addColorStop(0.6, 'rgba(0,0,0,0.5)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(x, y);
  g.arc(x, y, len, a - half, a + half);
  g.closePath();
  g.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ring(ctx: CanvasRenderingContext2D, d: { x: number; y: number; w: number; h: number }, off: number, col: string, lw: number, dash: number[]): void {
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = lw + 1;
  ctx.setLineDash(dash);
  ctx.strokeRect(d.x - off + 0.6, d.y - off + 0.8, d.w + off * 2, d.h + off * 2);
  ctx.strokeStyle = col;
  ctx.lineWidth = lw;
  ctx.strokeRect(d.x - off, d.y - off, d.w + off * 2, d.h + off * 2);
  ctx.setLineDash([]);
}

function bar(ctx: CanvasRenderingContext2D, cx: number, y: number, w: number, h: number, f: number, col: string): void {
  ctx.fillStyle = 'rgba(10,12,16,0.75)';
  ctx.fillRect(cx - w / 2 - 0.6, y - 0.6, w + 1.2, h + 1.2);
  ctx.fillStyle = col;
  ctx.fillRect(cx - w / 2, y, w * Math.max(0, Math.min(1, f)), h);
}

function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, l: number, lw: number): void {
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = lw + 1.5;
  const pathB = () => {
    ctx.beginPath();
    ctx.moveTo(x, y + l);
    ctx.lineTo(x, y);
    ctx.lineTo(x + l, y);
    ctx.moveTo(x + w - l, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + l);
    ctx.moveTo(x + w, y + h - l);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - l, y + h);
    ctx.moveTo(x + l, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - l);
  };
  pathB();
  ctx.stroke();
  ctx.strokeStyle = '#fff4e6';
  ctx.lineWidth = lw;
  pathB();
  ctx.stroke();
}

function havenBadge(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, now: number): void {
  const k = 1 / Math.min(1.3, Math.max(0.45, zoom));
  const r = 7 * k;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6);
  glow.addColorStop(0, `rgba(255,138,61,${0.45 + Math.sin(now * 2.2) * 0.12})`);
  glow.addColorStop(1, 'rgba(255,138,61,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1410';
  ctx.beginPath();
  ctx.arc(x, y, r + 1.5 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff8a3d';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // flame glyph
  ctx.fillStyle = '#fff1df';
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.62);
  ctx.quadraticCurveTo(x + r * 0.55, y - r * 0.05, x + r * 0.32, y + r * 0.42);
  ctx.quadraticCurveTo(x, y + r * 0.62, x - r * 0.32, y + r * 0.42);
  ctx.quadraticCurveTo(x - r * 0.55, y - r * 0.05, x, y - r * 0.62);
  ctx.fill();
  ctx.fillStyle = '#ff8a3d';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.22, r * 0.16, r * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
}

function lootPill(ctx: CanvasRenderingContext2D, x: number, y: number, cols: string[], zoom: number): void {
  const k = 1 / Math.min(1.3, Math.max(0.6, zoom));
  const dot = 2.6 * k;
  const gap = 2 * k;
  const w = cols.length * dot * 2 + (cols.length - 1) * gap + 6 * k;
  const h = dot * 2 + 5 * k;
  ctx.fillStyle = 'rgba(12,16,22,0.78)';
  ctx.beginPath();
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  cols.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x - w / 2 + 3 * k + dot + i * (dot * 2 + gap), y, dot, 0, Math.PI * 2);
    ctx.fill();
  });
}

function personBadge(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number): void {
  const k = 1 / Math.min(1.3, Math.max(0.6, zoom));
  ctx.fillStyle = '#4fc3f7';
  ctx.beginPath();
  ctx.arc(x, y, 5.5 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b1620';
  ctx.beginPath();
  ctx.arc(x, y - 1.4 * k, 1.6 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y + 2 * k, 2.8 * k, 1.8 * k, 0, Math.PI, 0);
  ctx.fill();
}

function drawSurvivor(ctx: CanvasRenderingContext2D, s: Survivor, now: number): void {
  const col = s.squad >= 0 ? SQUAD_COLORS[s.squad] : s.joining ? '#cfd8dc' : GUARD_COLOR;
  const skin = SKIN[s.id % SKIN.length];
  const moving = !!(s.path && s.path.length);
  const step = moving ? Math.sin(s.anim * 2) : 0;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.scale(UNIT_SCALE, UNIT_SCALE);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(1.3, 1.8, 4.6, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(s.facing);
  // legs
  ctx.fillStyle = '#2b2f36';
  ctx.beginPath();
  ctx.ellipse(step * 2.2, -1.6, 1.8, 1.2, 0, 0, Math.PI * 2);
  ctx.ellipse(-step * 2.2, 1.6, 1.8, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // gun
  if (s.gun > 0) {
    ctx.strokeStyle = '#1b1d21';
    ctx.lineWidth = s.gun === 2 ? 1.5 : 1.3;
    ctx.beginPath();
    ctx.moveTo(1, 2.2);
    ctx.lineTo(s.gun === 2 ? 10 : 6.5, 1.4);
    ctx.stroke();
  } else {
    ctx.strokeStyle = '#6b5a48';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(1, 3);
    ctx.lineTo(5.5, 4.6);
    ctx.stroke();
  }
  // torso
  ctx.fillStyle = shade(col, -0.45);
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.2, 4.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.ellipse(-0.2, -0.2, 2.6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(0.4, 0, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = s.id % 3 === 0 ? '#3a2a1e' : s.id % 3 === 1 ? '#1c1c1c' : '#6b4b2a';
  ctx.beginPath();
  ctx.arc(-0.1, 0, 1.9, Math.PI * 0.55, Math.PI * 1.45);
  ctx.fill();
  ctx.restore();
  void now;
}

function drawZombie(ctx: CanvasRenderingContext2D, z: Zombie, now: number): void {
  const K = ZKINDS[z.kind];
  const r = K.r;
  const cloth = z.kind === 1 ? '#6e3f38' : z.kind === 2 ? '#3d4234' : ZCLOTH[z.id % ZCLOTH.length];
  const skin = z.kind === 1 ? '#a28a78' : '#8c9a78';
  const sway = Math.sin(z.anim * 1.3 + z.id) * 0.22;
  const step = Math.sin(z.anim * 2);
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.scale(UNIT_SCALE, UNIT_SCALE);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(1.3, 1.8, r, r * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(z.facing + sway);
  const k = r / 4.6;
  ctx.scale(k, k);
  // legs
  ctx.fillStyle = '#2a2b26';
  ctx.beginPath();
  ctx.ellipse(step * 1.6, -1.6, 1.7, 1.2, 0, 0, Math.PI * 2);
  ctx.ellipse(-step * 1.6, 1.6, 1.7, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // arms reaching forward
  ctx.strokeStyle = skin;
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0.5, -3.1);
  ctx.lineTo(5.8 + step * 0.4, -2.4);
  ctx.moveTo(0.5, 3.1);
  ctx.lineTo(5.6 - step * 0.4, 2.6);
  ctx.stroke();
  ctx.lineCap = 'butt';
  // torso
  ctx.fillStyle = shade(cloth, -0.35);
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.1, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.ellipse(-0.2, -0.2, 2.5, 3.9, 0, 0, Math.PI * 2);
  ctx.fill();
  // blood stain
  ctx.fillStyle = 'rgba(110,20,20,0.7)';
  ctx.beginPath();
  ctx.arc(0.6, 1.2, 1.1, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(0.8, 0, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(40,30,25,0.6)';
  ctx.beginPath();
  ctx.arc(0.2, -0.3, 1.6, Math.PI * 0.6, Math.PI * 1.3);
  ctx.fill();
  ctx.restore();
  void now;
}

export function drawFire(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, s: number): void {
  for (let i = 0; i < 4; i++) {
    const f = (t * (2.1 + i * 0.37) + i * 0.25) % 1;
    const ox = Math.sin(t * 5 + i * 2) * 1.4 * s;
    const r = (3.2 - f * 2.4) * s;
    ctx.fillStyle = i % 2 ? `rgba(255,${150 + i * 20},60,${0.85 - f * 0.6})` : `rgba(255,220,120,${0.9 - f * 0.7})`;
    ctx.beginPath();
    ctx.arc(x + ox, y - f * 7 * s, Math.max(0.4, r), 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawStructure(ctx: CanvasRenderingContext2D, kind: StructKind, x: number, y: number, t: number, night: number, s = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  switch (kind) {
    case 'tower': {
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.moveTo(-9, 9);
      ctx.lineTo(9, 9);
      ctx.lineTo(24, 22);
      ctx.lineTo(6, 22);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#5c4430';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-8, 8);
      ctx.lineTo(-6, -8);
      ctx.moveTo(8, 8);
      ctx.lineTo(6, -8);
      ctx.moveTo(-8, 8);
      ctx.lineTo(6, -8);
      ctx.moveTo(8, 8);
      ctx.lineTo(-6, -8);
      ctx.stroke();
      ctx.fillStyle = '#7a5a3c';
      ctx.fillRect(-9, -18, 18, 12);
      ctx.fillStyle = '#946d48';
      ctx.fillRect(-9, -18, 18, 3);
      ctx.strokeStyle = 'rgba(40,28,18,0.6)';
      ctx.lineWidth = 0.5;
      for (let i = -6; i < 9; i += 3) {
        ctx.beginPath();
        ctx.moveTo(i, -15);
        ctx.lineTo(i, -6);
        ctx.stroke();
      }
      ctx.fillStyle = '#4b3a2c';
      ctx.beginPath();
      ctx.moveTo(-11, -18);
      ctx.lineTo(0, -25);
      ctx.lineTo(11, -18);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = night > 0.3 ? '#fff1c4' : '#c9c2a8';
      ctx.beginPath();
      ctx.arc(0, -12, 1.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'barrel': {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(1.5, 2, 4.6, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3e4247';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d1a18';
      ctx.beginPath();
      ctx.arc(0, 0, 2.9, 0, Math.PI * 2);
      ctx.fill();
      drawFire(ctx, 0, 0, t, 1);
      break;
    }
    case 'garden': {
      ctx.fillStyle = '#6b5236';
      ctx.fillRect(-14, -10, 28, 20);
      ctx.strokeStyle = '#4e7a35';
      ctx.lineWidth = 2.4;
      for (let i = -11; i <= 11; i += 5) {
        ctx.beginPath();
        ctx.moveTo(i, -8);
        ctx.lineTo(i, 8);
        ctx.stroke();
      }
      ctx.fillStyle = '#7fae4f';
      for (let i = -11; i <= 11; i += 5) for (let j = -7; j <= 7; j += 3.5) {
        ctx.beginPath();
        ctx.arc(i, j, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = '#8b6b45';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(-14, -10, 28, 20);
      break;
    }
    case 'workshop': {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-9, -5, 24, 18);
      ctx.fillStyle = '#5a5f63';
      ctx.fillRect(-12, 4, 24, 6);
      ctx.fillStyle = '#7d858c';
      ctx.fillRect(-12, -10, 24, 14);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 0.5;
      for (let i = -10; i < 12; i += 2.5) {
        ctx.beginPath();
        ctx.moveTo(i, -10);
        ctx.lineTo(i, 4);
        ctx.stroke();
      }
      ctx.fillStyle = '#f0b44a';
      ctx.beginPath();
      ctx.arc(0, -3, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7d858c';
      ctx.beginPath();
      ctx.arc(0, -3, 1.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'infirmary': {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.moveTo(-10, 10);
      ctx.lineTo(14, 10);
      ctx.lineTo(16, -6);
      ctx.lineTo(-8, -6);
      ctx.fill();
      ctx.fillStyle = '#d9d4c7';
      ctx.beginPath();
      ctx.moveTo(-12, 8);
      ctx.lineTo(12, 8);
      ctx.lineTo(12, -9);
      ctx.lineTo(-12, -9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ece8de';
      ctx.fillRect(-12, -9, 24, 8);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(-4.5, -4, 9, 3);
      ctx.fillRect(-1.5, -7, 3, 9);
      break;
    }
  }
  ctx.restore();
}
