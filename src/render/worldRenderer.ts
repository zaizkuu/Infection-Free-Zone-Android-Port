import type { Camera } from './camera';
import { MapRenderer, drawVehicle } from './mapRenderer';
import { makeCanvas } from './textures';
import { hexA, shade, type Vec } from '../core/math';
import { polyPath } from '../world/geo';
import { hash2 } from '../core/rng';
import type { MapData } from '../world/types';
import { BUILD_RANGE, FOG_CELL, GUARD_COLOR, SQUAD_COLORS, STRUCTS, VEHICLES, VEH_SEAT, WALL_MAX, WEATHER, ZKINDS, type Structure, hourOf, maxHpOf, nightness, type GameState, type StructKind, type Survivor, type Vehicle, type Zombie } from '../game/state';
import type { Prop } from '../world/types';
import type { Runtime } from '../game/sim';

export interface RenderOpts {
  fog: boolean;
  budget?: number;
  quality?: 'high' | 'balanced' | 'low';
  /** -2..2 */
  brightness?: number;
}

export interface ViewState {
  selectedSquad: number;
  selectedBuilding: number;
  selectedVehicle: number;
  placing: StructKind | null;
  /** first point of a wall being placed */
  wallStart: Vec | null;
  selectedStructure: number;
  /** map prop index of a selected abandoned car */
  selectedProp: number;
  ghost: Vec | null;
  ghostOk: boolean;
  markers: { x: number; y: number; t: number; c: string }[];
  time: number; // real seconds, for animation
}

/** Units are drawn slightly larger than their collision size so they read well on phones. */
const UNIT_SCALE = 1.25;
const SKIN = ['#c49a7a', '#a57a5a', '#8a5e42', '#5e3e2a', '#d2ae90', '#74503a'];
const ZCLOTH = ['#3a3d33', '#463b33', '#33393d', '#3f3540', '#444736', '#2c312a'];
/** Muted, practical clothing; squads are told apart by the ring at their feet and backpack colour. */
const CLOTH = ['#3b4636', '#4a4136', '#2f3945', '#55504a', '#3d3a40', '#5a4a3a', '#44483c'];

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
      img.data[o] = 5;
      img.data[o + 1] = 7;
      img.data[o + 2] = 10;
      img.data[o + 3] = rt.explored[i] ? 0 : 236;
    }
    this.fogCtx.putImageData(img, 0, 0);
    rt.fogDirty = false;
  }

  render(ctx: CanvasRenderingContext2D, cam: Camera, st: GameState, rt: Runtime, view: ViewState, opts: RenderOpts = { fog: true }): void {
    const quality = opts.quality ?? 'high';
    const bright = opts.brightness ?? 0;
    // ease weather visuals in and out
    const wdt = Math.min(0.1, Math.max(0, view.time - this.lastT));
    this.lastT = view.time;
    const w = st.weather ?? 'clear';
    this.rainK += ((w === 'rain' ? 1 : 0) - this.rainK) * Math.min(1, wdt * 0.6);
    this.fogK += ((w === 'fog' ? 1 : 0) - this.fogK) * Math.min(1, wdt * 0.5);
    this.darkK += (WEATHER[w].dark - this.darkK) * Math.min(1, wdt * 0.5);
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
      ctx.fillStyle = `rgba(42,7,7,${0.65 * a})`;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r * 1.3, d.r * 0.9, d.a, 0, Math.PI * 2);
      ctx.fill();
      if (d.corpse) {
        ctx.fillStyle = `rgba(38,42,32,${0.95 * a})`;
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
        if (d.poly) {
          // real-world footprint: barricades hug the walls, the glow follows the roof
          if (lv >= 3) ringPoly(ctx, d.poly, '#7d858c', 10, [2, 1.8]);
          if (lv >= 2) ringPoly(ctx, d.poly, '#b9a27a', 7, [3.5, 1.2]);
          if (lv >= 1) ringPoly(ctx, d.poly, '#8b6b45', 4, [5, 2.5]);
          ctx.beginPath();
          polyPath(ctx, d.poly, 0, -d.wallH);
          ctx.strokeStyle = hexA('#ff8a3d', 0.25);
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.strokeStyle = hexA('#ff8a3d', 0.9);
          ctx.lineWidth = 1.3;
          ctx.stroke();
        } else {
          if (lv >= 1) ring(ctx, d, 3.5, '#8b6b45', 2.6, [5, 2.5]);
          if (lv >= 2) ring(ctx, d, 7, '#b9a27a', 3.2, [3.5, 1.2]);
          if (lv >= 3) ring(ctx, d, 10.5, '#7d858c', 2, [2, 1.8]);
          ctx.strokeStyle = hexA('#ff8a3d', 0.9);
          ctx.lineWidth = 1.3;
          ctx.strokeRect(d.x - 0.5, d.y - 0.5, d.w + 1, d.h + 1);
          ctx.strokeStyle = hexA('#ff8a3d', 0.25);
          ctx.lineWidth = 4;
          ctx.strokeRect(d.x - 2, d.y - 2, d.w + 4, d.h + 4);
        }
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
        if (l.fuel) types.push('#e08a5a');
        if (l.guns) types.push('#b0bec5');
        if (!types.length) {
          ctx.fillStyle = 'rgba(25,28,32,0.28)';
          if (d.poly) {
            ctx.beginPath();
            polyPath(ctx, d.poly, 0, -d.wallH);
            ctx.fill();
          } else ctx.fillRect(d.x, d.y, d.w, d.h);
        } else lootPill(ctx, d.x + d.w / 2, d.y + (d.h - d.wallH) / 2, types, cam.zoom);
        if (b.survivors > 0) personBadge(ctx, d.x + d.w / 2, d.y - 6, cam.zoom);
      }
      if (b.breached && !b.owned) {
        ctx.fillStyle = 'rgba(60,10,10,0.18)';
        if (d.poly) {
          ctx.beginPath();
          polyPath(ctx, d.poly, 0, -d.wallH);
          ctx.fill();
        } else ctx.fillRect(d.x, d.y, d.w, d.h);
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

    // buildings being torn down
    st.b.forEach((b, i) => {
      if (!b.demo || b.demolished) return;
      const d = this.map.buildings[i];
      if (!inView(d.x + d.w / 2, d.y + d.h / 2, Math.max(d.w, d.h))) return;
      if (d.poly) {
        ctx.save();
        ctx.beginPath();
        polyPath(ctx, d.poly, 0, -d.wallH);
        polyPath(ctx, d.poly);
        ctx.clip();
        drawDemolition(ctx, d, b.demo, now, cam.zoom);
        ctx.restore();
      } else drawDemolition(ctx, d, b.demo, now, cam.zoom);
    });
    // selected abandoned car
    if (view.selectedProp >= 0) {
      const p = this.map.props[view.selectedProp];
      if (p) {
        ctx.strokeStyle = '#fff4e6';
        ctx.lineWidth = 1.6 / Math.min(1.2, cam.zoom);
        ctx.setLineDash([4 / Math.min(1, cam.zoom), 3 / Math.min(1, cam.zoom)]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 15 + Math.sin(now * 5) * 1.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- structures ----
    for (const sobj of st.structures) {
      const wall = sobj.kind === 'wall';
      const cx = wall ? (sobj.x + sobj.x2!) / 2 : sobj.x;
      const cy = wall ? (sobj.y + sobj.y2!) / 2 : sobj.y;
      if (!inView(cx, cy, wall ? WALL_MAX : 40)) continue;
      if (wall) drawWall(ctx, sobj, cam.zoom);
      else if (sobj.built < 1) drawSite(ctx, sobj, now, night);
      else drawStructure(ctx, sobj.kind, sobj.x, sobj.y, now + sobj.id, night, 1);
      const top = wall ? cy - 8 : sobj.y - STRUCTS[sobj.kind].r - 12;
      if (sobj.built < 1) progressRing(ctx, cx, top - 2, sobj.built, cam.zoom);
      else if (sobj.hp < STRUCTS[sobj.kind].hp) bar(ctx, cx, top, 18, 2.2, sobj.hp / STRUCTS[sobj.kind].hp, '#7ccf6a');
      if (view.selectedStructure === sobj.id) {
        ctx.strokeStyle = '#fff4e6';
        ctx.lineWidth = 1.5 / Math.min(1.2, cam.zoom);
        ctx.setLineDash([4 / Math.min(1, cam.zoom), 3 / Math.min(1, cam.zoom)]);
        ctx.beginPath();
        if (wall) {
          ctx.moveTo(sobj.x, sobj.y);
          ctx.lineTo(sobj.x2!, sobj.y2!);
          ctx.lineWidth = 9 / Math.min(1.2, cam.zoom);
          ctx.strokeStyle = 'rgba(255,244,230,0.35)';
        } else ctx.arc(sobj.x, sobj.y, STRUCTS[sobj.kind].r + 6 + Math.sin(now * 5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // vehicles
    for (const v of st.vehicles ?? []) {
      if (!inView(v.x, v.y)) continue;
      this.drawVehicleEntity(ctx, v, view.selectedVehicle === v.id, st, now, cam.zoom);
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
    if (view.placing === 'wall') {
      const a = view.wallStart;
      const b = view.ghost;
      const col = view.ghostOk ? '#7ccf6a' : '#e5484d';
      if (a) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (a && b) {
        const ghost: Structure = { id: -1, kind: 'wall', x: a.x, y: a.y, x2: b.x, y2: b.y, hp: STRUCTS.wall.hp, cd: 0, t: 0, built: 1, cost: 0 };
        ctx.globalAlpha = 0.6;
        drawWall(ctx, ghost, cam.zoom);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.4 / Math.min(1, cam.zoom);
        ctx.setLineDash([5 / Math.min(1, cam.zoom), 4 / Math.min(1, cam.zoom)]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (b) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5 / Math.min(1, cam.zoom);
        ctx.beginPath();
        ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (view.placing && view.ghost) {
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
    if (night < 0.9 && quality !== 'low') {
      ctx.globalAlpha = 1 - night;
      for (let i = 0; i < 5; i++) {
        const cx = ((hash2(i, 1, 5) * this.map.width + now * (6 + i)) % (this.map.width + 800)) - 400;
        const cy = hash2(i, 2, 5) * this.map.height;
        const r = 220 + hash2(i, 3, 5) * 200;
        if (!inView(cx, cy, r)) continue;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, 'rgba(10,14,18,0.16)');
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
    // overcast, slightly cool daylight
    ctx.globalCompositeOperation = 'multiply';
    const base = Math.max(180, Math.min(252, 224 + bright * 11 - this.darkK * 110));
    ctx.fillStyle = `rgb(${Math.round(base)},${Math.round(base + 2)},${Math.round(base + 4 + this.rainK * 6)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    const h = hourOf(st.time);
    const warm = h > 16 && h < 21 ? Math.sin(((h - 16) / 5) * Math.PI) : h > 4 && h < 8 ? Math.sin(((h - 4) / 4) * Math.PI) * 0.7 : 0;
    if (warm > 0.01) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(255,${Math.round(190 - 40 * warm)},${Math.round(150 - 70 * warm)},${0.45 * warm})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (night > 0.01) this.drawLighting(ctx, cam, st, rt, night, now, Math.max(0.6, 0.85 - bright * 0.05), quality === 'low' ? 4 : 2);
    if (this.fogK > 0.01) this.drawFogWeather(ctx, cam, now, this.fogK, night);
    if (this.rainK > 0.01) this.drawRain(ctx, now, this.rainK, quality);

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
    ctx.globalAlpha = Math.max(0.15, 0.34 - bright * 0.03 + night * 0.22);
    ctx.drawImage(this.vignette, 0, 0);
    // film grain
    if (!this.grain) this.grain = ctx.createPattern(this.mapR.tex.film, 'repeat');
    if (this.grain && quality !== 'low') {
      this.grain.setTransform(new DOMMatrix().translate(Math.floor(Math.random() * 160), Math.floor(Math.random() * 160)));
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = this.grain;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  private grain: CanvasPattern | null = null;
  private lastT = 0;
  private rainK = 0;
  private fogK = 0;
  private darkK = 0;

  private drawVehicleEntity(ctx: CanvasRenderingContext2D, v: Vehicle, selected: boolean, st: GameState, now: number, zoom: number): void {
    const K = VEHICLES[v.kind];
    const p: Prop = v.wreck
      ? { kind: 'car', x: v.x, y: v.y, r: 1, a: v.a, c: '#2a2522', v: 1 }
      : { kind: K.prop, x: v.x, y: v.y, r: 1, a: v.a, c: v.color, v: 0 };
    // soft shadow
    ctx.save();
    ctx.translate(v.x + 2.2, v.y + 1.8);
    ctx.rotate(v.a);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    const L = K.prop === 'truck' ? 31 : 19;
    const Wd = K.prop === 'truck' ? 12 : 10;
    ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
    ctx.restore();
    drawVehicle(ctx, p, 2);
    if (v.broken && !v.wreck) {
      // dust & flat tyres: a dull film over the body
      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.rotate(v.a);
      ctx.fillStyle = 'rgba(80,70,55,0.35)';
      ctx.fillRect(-L / 2 + 1, -Wd / 2 + 1, L - 2, Wd - 2);
      ctx.restore();
    }
    const riding = st.survivors.some((s) => s.inside === VEH_SEAT + v.id);
    if (v.squad >= 0 && !v.wreck) {
      const col = SQUAD_COLORS[v.squad];
      ctx.strokeStyle = hexA(col, riding ? 0.95 : 0.6);
      ctx.lineWidth = 1.1 / Math.min(1, zoom);
      ctx.beginPath();
      ctx.ellipse(v.x, v.y, L * 0.7, L * 0.5, v.a, 0, Math.PI * 2);
      ctx.stroke();
      if (riding && v.path && v.path.length) {
        // exhaust puffs
        const bx = v.x - Math.cos(v.a) * (L / 2 + 2);
        const by = v.y - Math.sin(v.a) * (L / 2 + 2);
        for (let i = 0; i < 3; i++) {
          const f = (now * 2 + i / 3) % 1;
          ctx.fillStyle = `rgba(170,170,165,${0.25 * (1 - f)})`;
          ctx.beginPath();
          ctx.arc(bx - Math.cos(v.a) * f * 8, by - Math.sin(v.a) * f * 8, 1.5 + f * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (selected) {
      ctx.strokeStyle = '#fff4e6';
      ctx.lineWidth = 1.6 / Math.min(1.2, zoom);
      ctx.setLineDash([4 / Math.min(1, zoom), 3 / Math.min(1, zoom)]);
      ctx.beginPath();
      ctx.arc(v.x, v.y, L * 0.75 + Math.sin(now * 5) * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!v.wreck && v.hp < K.hp) bar(ctx, v.x, v.y - 13, 16, 2, v.hp / K.hp, '#f0b44a');
  }

  /** Low drifting fog banks plus a general haze. */
  private drawFogWeather(ctx: CanvasRenderingContext2D, cam: Camera, now: number, k: number, night: number): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const s = cam.scale;
    ctx.setTransform(s, 0, 0, s, -cam.left * s, -cam.top * s);
    const col = night > 0.5 ? '70,78,92' : '176,182,186';
    for (let i = 0; i < 14; i++) {
      const cx = ((hash2(i, 11, 3) * this.map.width + now * (4 + i * 0.6)) % (this.map.width + 600)) - 300;
      const cy = hash2(i, 12, 3) * this.map.height;
      const r = 180 + hash2(i, 13, 3) * 220;
      if (cx + r < cam.left || cx - r > cam.left + W / s || cy + r < cam.top || cy - r > cam.top + H / s) continue;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${col},${0.3 * k})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.6, 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgba(${col},${0.14 * k})`;
    ctx.fillRect(0, 0, W, H);
  }

  /** Screen-space rain streaks. */
  private drawRain(ctx: CanvasRenderingContext2D, now: number, k: number, quality: string): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const n = Math.min(quality === 'low' ? 90 : 240, Math.floor(((W * H) / 7000) * k));
    const len = H * 0.035;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = `rgba(185,198,210,${0.32 * k})`;
    ctx.lineWidth = Math.max(1, W / 1400);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const sp = 0.8 + hash2(i, 1, 9) * 0.6;
      const x = (hash2(i, 2, 9) * W + now * W * 0.18 * sp) % W;
      const y = (hash2(i, 3, 9) * H + now * H * 1.6 * sp) % H;
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * 0.25, y - len);
    }
    ctx.stroke();
    // splashes
    ctx.fillStyle = `rgba(190,200,210,${0.22 * k})`;
    for (let i = 0; i < n / 4; i++) {
      const t = (now * 3 + hash2(i, 4, 9)) % 1;
      const x = hash2(i, 5, Math.floor(now * 3 + hash2(i, 4, 9))) * W;
      const y = hash2(i, 6, Math.floor(now * 3 + hash2(i, 4, 9))) * H;
      ctx.beginPath();
      ctx.ellipse(x, y, (1 + t * 4) * (W / 1400), (0.5 + t * 2) * (W / 1400), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private vignette: HTMLCanvasElement | null = null;

  private drawLighting(ctx: CanvasRenderingContext2D, cam: Camera, st: GameState, rt: Runtime, night: number, now: number, nightAlpha: number, div: number): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const lw = Math.ceil(W / div);
    const lh = Math.ceil(H / div);
    if (this.light.width !== lw || this.light.height !== lh) {
      this.light.width = lw;
      this.light.height = lh;
    }
    const g = this.lightCtx;
    const ls = cam.scale / div;
    const L = cam.left;
    const T = cam.top;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, lw, lh);
    g.fillStyle = `rgba(3,6,14,${nightAlpha * night})`;
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
      if (s.built < 1 || s.kind === 'wall' || s.kind === 'trap') continue;
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
    for (const v of st.vehicles ?? []) {
      if (v.wreck || !st.survivors.some((s) => s.inside === VEH_SEAT + v.id)) continue;
      const fx = v.x + Math.cos(v.a) * 8;
      const fy = v.y + Math.sin(v.a) * 8;
      cone(g, fx, fy, v.a, 210, 0.32);
      glow(v.x, v.y, 30, 0.7);
      warmGlows.push([v.x - Math.cos(v.a) * 9, v.y - Math.sin(v.a) * 9, 10, 0.25]);
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
      gr.addColorStop(0, `rgba(255,150,60,${a * 1.25 * night})`);
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
  const cloth = CLOTH[s.id % CLOTH.length];
  const moving = !!(s.path && s.path.length);
  const step = moving ? Math.sin(s.anim * 2) : 0;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.scale(UNIT_SCALE, UNIT_SCALE);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath();
  ctx.ellipse(1.5, 2, 4.8, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // squad ring at the feet
  ctx.strokeStyle = hexA(col, 0.7);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.ellipse(0, 0.6, 5.4, 4.4, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.rotate(s.facing);
  // legs
  ctx.fillStyle = '#2b2f36';
  ctx.beginPath();
  ctx.ellipse(step * 2.2, -1.6, 1.8, 1.2, 0, 0, Math.PI * 2);
  ctx.ellipse(-step * 2.2, 1.6, 1.8, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // hammer or pry bar while working a job
  if (s.working) {
    const sw = Math.sin(now * 13 + s.id) * 0.9;
    const hx = 2 + Math.cos(sw) * 7;
    const hy = -1 + Math.sin(sw) * 7;
    ctx.strokeStyle = '#6b5a48';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(1.5, -1.5);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = '#9aa0a6';
    ctx.fillRect(hx - 1.3, hy - 1.3, 2.6, 2.6);
  } else if (s.gun > 0) {
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
  ctx.fillStyle = shade(cloth, -0.45);
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.2, 4.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.ellipse(-0.2, -0.2, 2.6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(cloth, 0.12);
  ctx.beginPath();
  ctx.ellipse(-0.4, -1.4, 1.6, 2.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // backpack in squad colour
  ctx.fillStyle = shade(col, -0.35);
  ctx.beginPath();
  ctx.ellipse(-2.4, 0, 1.5, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(col, -0.1);
  ctx.beginPath();
  ctx.ellipse(-2.5, -0.4, 1, 1.7, 0, 0, Math.PI * 2);
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
}

function drawZombie(ctx: CanvasRenderingContext2D, z: Zombie, now: number): void {
  const K = ZKINDS[z.kind];
  const r = K.r;
  const cloth = z.kind === 1 ? '#4f2d28' : z.kind === 2 ? '#2e3128' : ZCLOTH[z.id % ZCLOTH.length];
  const skin = z.kind === 1 ? '#9a8676' : z.kind === 2 ? '#7d8270' : '#8e917e';
  const sway = Math.sin(z.anim * 1.3 + z.id) * 0.22;
  const step = Math.sin(z.anim * 2);
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.scale(UNIT_SCALE, UNIT_SCALE);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath();
  ctx.ellipse(1.5, 2, r, r * 0.75, 0, 0, Math.PI * 2);
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
  // blood stains
  ctx.fillStyle = 'rgba(70,10,10,0.8)';
  ctx.beginPath();
  ctx.arc(0.6, 1.2, 1.3, 0, Math.PI * 2);
  ctx.arc(-1, -1.6, 0.8, 0, Math.PI * 2);
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
    case 'trap': {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-5, -4, 12, 11);
      ctx.fillStyle = '#3e3326';
      ctx.fillRect(-6, -6, 12, 12);
      ctx.strokeStyle = '#2a2219';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.fillStyle = '#9ea2a3';
      for (let i = -4; i <= 4; i += 4)
        for (let j = -4; j <= 4; j += 4) {
          ctx.beginPath();
          ctx.moveTo(i, j - 1.6);
          ctx.lineTo(i + 1.2, j + 1);
          ctx.lineTo(i - 1.2, j + 1);
          ctx.closePath();
          ctx.fill();
        }
      break;
    }
    case 'wall':
      break;
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

function progressRing(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, zoom: number): void {
  const r = 5 / Math.min(1, zoom);
  ctx.fillStyle = 'rgba(12,16,22,0.8)';
  ctx.beginPath();
  ctx.arc(x, y, r + 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.8 / Math.min(1, zoom);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ffb36b';
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, p) * Math.PI * 2);
  ctx.stroke();
}

/** A palisade of sharpened stakes; gaps appear as it takes damage. Unfinished walls show their outline. */
export function drawWall(ctx: CanvasRenderingContext2D, s: Structure, zoom: number): void {
  const x2 = s.x2 ?? s.x;
  const y2 = s.y2 ?? s.y;
  const len = Math.hypot(x2 - s.x, y2 - s.y) || 1;
  const ux = (x2 - s.x) / len;
  const uy = (y2 - s.y) / len;
  const hp = Math.max(0, s.hp / STRUCTS.wall.hp);
  const built = s.built >= 1 ? len : len * s.built;
  ctx.lineCap = 'round';
  if (s.built < 1) {
    ctx.strokeStyle = 'rgba(255,200,140,0.45)';
    ctx.lineWidth = 1.2 / Math.min(1, zoom);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (built > 1) {
    const ex = s.x + ux * built;
    const ey = s.y + uy * built;
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(s.x + 2, s.y + 2.4);
    ctx.lineTo(ex + 2, ey + 2.4);
    ctx.stroke();
    ctx.strokeStyle = '#3f3022';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    for (let t = 0, i = 0; t <= built; t += 2.6, i++) {
      const gap = hash2(s.id, i, 41) > hp + 0.3;
      if (gap) continue;
      const x = s.x + ux * t;
      const y = s.y + uy * t;
      ctx.fillStyle = i % 2 ? '#5e4731' : '#6e5539';
      ctx.beginPath();
      ctx.arc(x, y, 1.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8f744f';
      ctx.beginPath();
      ctx.arc(x - 0.45, y - 0.45, 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // cross braces
    ctx.strokeStyle = '#2f241a';
    ctx.lineWidth = 0.8;
    for (let t = 8; t < built; t += 18) {
      const x = s.x + ux * t;
      const y = s.y + uy * t;
      ctx.beginPath();
      ctx.moveTo(x - uy * 3.4, y + ux * 3.4);
      ctx.lineTo(x + uy * 3.4, y - ux * 3.4);
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';
}

/** Construction site: faint outline of the finished thing, scaffolding and a lumber pile. */
function drawSite(ctx: CanvasRenderingContext2D, s: Structure, now: number, night: number): void {
  ctx.globalAlpha = 0.35 + s.built * 0.4;
  drawStructure(ctx, s.kind, s.x, s.y, now + s.id, night, 1);
  ctx.globalAlpha = 1;
  const r = STRUCTS[s.kind].r + 2;
  ctx.strokeStyle = '#8b6b45';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
  ctx.beginPath();
  ctx.moveTo(s.x - r, s.y - r);
  ctx.lineTo(s.x + r, s.y + r);
  ctx.moveTo(s.x + r, s.y - r);
  ctx.lineTo(s.x - r, s.y + r);
  ctx.stroke();
  ctx.fillStyle = '#6e5539';
  ctx.fillRect(s.x + r + 2, s.y + r - 4, 7, 2);
  ctx.fillRect(s.x + r + 2, s.y + r - 1.6, 7, 2);
}

/** Holes, dust and scaffolding spreading over a building while it is torn down. */
function drawDemolition(ctx: CanvasRenderingContext2D, d: { id: number; x: number; y: number; w: number; h: number; wallH: number }, p: number, now: number, zoom: number): void {
  const rh = d.h - d.wallH;
  ctx.fillStyle = `rgba(22,19,16,${0.12 + p * 0.38})`;
  ctx.fillRect(d.x, d.y, d.w, d.h);
  const n = Math.floor(p * 10);
  for (let k = 0; k < n; k++) {
    const hx = d.x + d.w * (0.12 + hash2(d.id, k, 61) * 0.76);
    const hy = d.y + rh * (0.15 + hash2(d.id, k, 62) * 0.7);
    const hr = Math.min(d.w, rh) * (0.06 + hash2(d.id, k, 63) * 0.08);
    ctx.fillStyle = '#0b0a09';
    ctx.beginPath();
    ctx.ellipse(hx, hy, hr, hr * 0.75, hash2(d.id, k, 64) * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5d564c';
    ctx.fillRect(hx - hr * 0.6, hy + hr * 0.3, hr * 0.5, hr * 0.3);
  }
  // scaffolding poles along the walls
  ctx.strokeStyle = 'rgba(150,120,80,0.8)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = d.x; x <= d.x + d.w; x += 12) {
    ctx.moveTo(x, d.y - 2);
    ctx.lineTo(x, d.y + d.h + 2);
  }
  ctx.moveTo(d.x - 2, d.y - 1.5);
  ctx.lineTo(d.x + d.w + 2, d.y - 1.5);
  ctx.moveTo(d.x - 2, d.y + d.h + 1.5);
  ctx.lineTo(d.x + d.w + 2, d.y + d.h + 1.5);
  ctx.stroke();
  // progress bar
  const w = Math.min(d.w, 70);
  const k = 1 / Math.min(1.2, Math.max(0.6, zoom));
  const y = d.y - 9 * k;
  ctx.fillStyle = 'rgba(10,12,16,0.8)';
  ctx.fillRect(d.x + d.w / 2 - w / 2 - 1, y - 1, w + 2, 4 * k + 2);
  ctx.fillStyle = `rgba(255,179,107,${0.8 + Math.sin(now * 4) * 0.2})`;
  ctx.fillRect(d.x + d.w / 2 - w / 2, y, w * p, 4 * k);
}

/** Dashed barricade line around a real-world footprint. */
function ringPoly(ctx: CanvasRenderingContext2D, poly: Vec[], col: string, lw: number, dash: number[]): void {
  ctx.setLineDash(dash);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  polyPath(ctx, poly, 0.7, 0.9);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = lw + 1;
  ctx.stroke();
  ctx.beginPath();
  polyPath(ctx, poly);
  ctx.strokeStyle = col;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineJoin = 'miter';
}
