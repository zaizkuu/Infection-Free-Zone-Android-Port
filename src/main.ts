import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import './ui/styles.css';

import { Capacitor } from '@capacitor/core';
import { generateMap } from './world/mapgen';
import { NavGrid, CELL } from './world/nav';
import type { MapData } from './world/types';
import { Camera } from './render/camera';
import { WorldRenderer, type ViewState } from './render/worldRenderer';
import { Input } from './input';
import { Sfx } from './audio/sfx';
import { Ui, type App } from './ui/ui';
import { initPlatform, buzz } from './platform';
import { clearSave, hasSave, loadGame, loadPrefs, saveGame, savePrefs } from './save';
import { DAY_LEN, SQUAD_COLORS, STRUCTS, nightness, newGame, type GameState, type OrderType, type StructKind } from './game/state';
import { build, canBuildAt, createRuntime, fortify, orderSquad, populate, squadMembers, step, stepFx, syncFog, transfer, type Runtime } from './game/sim';

/** The town is generated from a fixed seed, so every game uses the same pre-generated map. */
const SEED = 1337;
const STEP = 1 / 30;

class Game implements App {
  st: GameState | null = null;
  rt: Runtime | null = null;
  map: MapData;
  view: ViewState = { selectedSquad: 0, selectedBuilding: -1, placing: null, ghost: null, ghostOk: false, markers: [], time: 0 };
  paused = false;
  soundOn: boolean;
  mode: 'title' | 'play' = 'title';

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cam: Camera;
  private renderer: WorldRenderer;
  private input: Input;
  private sfx = new Sfx();
  private ui: Ui;
  private acc = 0;
  private last = performance.now();
  private hudTimer = 0;
  private endTimer = -1;
  private demoT = 0;

  constructor() {
    this.canvas = document.getElementById('game') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.map = generateMap(SEED);
    const fogW = Math.ceil(this.map.width / 40);
    const fogH = Math.ceil(this.map.height / 40);
    this.renderer = new WorldRenderer(this.map, fogW, fogH);
    this.renderer.mapR.warmup();
    this.cam = new Camera(this.map.width, this.map.height);
    this.input = new Input(
      this.canvas,
      this.cam,
      (x, y) => this.tap(x, y),
      (x, y) => this.hover(x, y),
    );
    this.ui = new Ui(document.getElementById('ui')!, this);
    const prefs = loadPrefs();
    this.soundOn = prefs.sound;
    this.sfx.enabled = prefs.sound;
    this.resize();
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.save();
        this.sfx.suspend();
      } else this.sfx.resume();
    });
    addEventListener('pointerdown', () => this.sfx.unlock(), { capture: true });
    this.setupBackButton();
    this.startDemo();
    this.ui.showTitle();
    requestAnimationFrame((t) => this.frame(t));
  }

  private async setupBackButton(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const { App: CapApp } = await import('@capacitor/app');
      await CapApp.addListener('backButton', () => {
        if (this.mode !== 'play') return void CapApp.exitApp();
        if (this.view.placing) return this.cancelPlace();
        if (this.ui.panelOpen) return this.ui.closePanel();
        if (this.ui.screenOpen) {
          this.ui.hideScreens();
          this.paused = false;
          return;
        }
        this.paused = true;
        this.ui.showPause();
      });
      await CapApp.addListener('pause', () => this.save());
    } catch {
      /* plugin missing */
    }
  }

  private resize(): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = innerWidth;
    const h = innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.cam.resize(w, h, dpr);
  }

  // ------------------------------------------------------------------ game lifecycle

  private freshRuntime(st: GameState): Runtime {
    const nav = new NavGrid(this.map);
    const rt = createRuntime(this.map, nav, st);
    for (const s of st.structures) {
      if (s.kind === 'tower' || s.kind === 'workshop' || s.kind === 'infirmary') {
        const r = STRUCTS[s.kind].r - 2;
        for (let dx = -r; dx <= r; dx += CELL / 2) for (let dy = -r; dy <= r; dy += CELL / 2) nav.blocked[nav.idx(s.x + dx, s.y + dy)] = 1;
      }
    }
    return rt;
  }

  private startDemo(): void {
    const st = newGame(this.map, SEED + 99);
    st.time = DAY_LEN * (15.5 / 24); // 21:30
    st.lastHour = 21.5;
    const rt = this.freshRuntime(st);
    rt.explored.fill(1);
    const hq = this.map.buildings[this.map.hqId];
    st.structures.push({ id: 900, kind: 'tower', x: hq.x - 26, y: hq.y + hq.h + 30, hp: 220, cd: 0, t: 0 });
    st.structures.push({ id: 901, kind: 'barrel', x: hq.x + hq.w + 24, y: hq.y + hq.h + 16, hp: 60, cd: 0, t: 0 });
    st.structures.push({ id: 902, kind: 'barrel', x: hq.x + 10, y: hq.y - 22, hp: 60, cd: 0, t: 0 });
    st.b[this.map.hqId].fort = 2;
    populate(st, rt, 260, 260);
    st.res.ammo = 9999;
    this.st = st;
    this.rt = rt;
    this.mode = 'title';
    this.ui.showHud(false);
    this.cam.zoom = 1.15;
    this.cam.x = hq.x + hq.w / 2 - 120;
    this.cam.y = hq.y + hq.h / 2;
    this.cam.clamp();
    this.demoT = 0;
  }

  newGame(): void {
    clearSave();
    const st = newGame(this.map, SEED);
    const rt = this.freshRuntime(st);
    populate(st, rt, 175);
    this.begin(st, rt);
    this.ui.banner('Day 1', `${this.map.townName} has fallen. Scout the neighbourhood and get ready. The dead come at night.`, 'info');
  }

  continueGame(): void {
    const st = loadGame();
    if (!st) return this.newGame();
    const rt = this.freshRuntime(st);
    this.begin(st, rt);
    this.ui.banner(`Day ${st.day}`, 'Welcome back to the haven.', 'info');
  }

  private begin(st: GameState, rt: Runtime): void {
    this.st = st;
    this.rt = rt;
    this.mode = 'play';
    this.paused = false;
    this.endTimer = -1;
    this.acc = 0;
    this.view = { selectedSquad: 0, selectedBuilding: -1, placing: null, ghost: null, ghostOk: false, markers: [], time: 0 };
    this.ui.hideScreens();
    this.ui.closePanel();
    this.ui.showHud(true);
    const hq = this.map.buildings[this.map.hqId];
    this.cam.zoom = 1.35;
    this.cam.x = hq.x + hq.w / 2;
    this.cam.y = hq.y + hq.h / 2 + 30;
    this.cam.clamp();
    this.ui.update();
  }

  hasSave(): boolean {
    return hasSave();
  }

  private save(): void {
    if (this.mode !== 'play' || !this.st || !this.rt || this.st.over) return;
    syncFog(this.st, this.rt);
    saveGame(this.st);
  }

  quitToTitle(): void {
    this.save();
    this.ui.closePanel();
    this.startDemo();
    this.ui.showTitle();
  }

  // ------------------------------------------------------------------ App API (used by UI)

  click(): void {
    this.sfx.unlock();
    this.sfx.uiClick();
  }

  setSound(on: boolean): void {
    this.soundOn = on;
    this.sfx.setEnabled(on);
    savePrefs({ sound: on });
  }

  setSpeed(n: number): void {
    if (!this.st) return;
    if (n === 0) this.paused = !this.paused;
    else {
      this.paused = false;
      this.st.speed = n;
    }
    this.ui.update();
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  selectSquad(i: number): void {
    this.view.selectedSquad = i;
    this.ui.update();
  }

  focusSquad(i: number): void {
    if (!this.st) return;
    const o = this.st.squads[i].order;
    const m = squadMembers(this.st, i);
    if (m.length && m[0].inside >= 0 && o.b !== undefined) {
      const d = this.map.buildings[o.b];
      this.cam.focus(d.door.x, d.door.y);
    } else if (m.length) this.cam.focus(m[0].x, m[0].y);
  }

  focusHaven(): void {
    const hq = this.map.buildings[this.map.hqId];
    this.cam.focus(hq.x + hq.w / 2, hq.y + hq.h / 2 + 20);
  }

  order(t: OrderType, b?: number): void {
    if (!this.st || !this.rt) return;
    const sq = this.view.selectedSquad;
    if (sq < 0 || !squadMembers(this.st, sq).length) return;
    orderSquad(this.st, this.rt, sq, { t, b });
    if (b !== undefined) {
      const d = this.map.buildings[b];
      this.view.markers.push({ x: d.door.x, y: d.door.y, t: 0, c: SQUAD_COLORS[sq] });
    }
    void buzz();
    this.ui.update();
  }

  fortify(b: number): void {
    if (!this.st || !this.rt) return;
    if (fortify(this.st, this.rt, b)) void buzz('heavy');
    this.ui.update();
  }

  startPlacing(k: StructKind): void {
    this.view.placing = k;
    this.view.ghost = null;
    this.view.selectedBuilding = -1;
    this.ui.update();
  }

  confirmPlace(): void {
    if (!this.st || !this.rt || !this.view.placing || !this.view.ghost) return;
    if (build(this.st, this.rt, this.view.placing, this.view.ghost.x, this.view.ghost.y)) {
      void buzz('heavy');
      this.view.placing = null;
      this.view.ghost = null;
    }
    this.ui.update();
  }

  cancelPlace(): void {
    this.view.placing = null;
    this.view.ghost = null;
    this.ui.update();
  }

  transfer(squad: number, delta: 1 | -1): void {
    if (!this.st || !this.rt) return;
    transfer(this.st, this.rt, squad, delta);
    this.ui.update();
  }

  // ------------------------------------------------------------------ input

  private hover(sx: number, sy: number): void {
    if (this.mode !== 'play' || !this.view.placing || !this.st || !this.rt) return;
    const w = this.cam.toWorld(sx, sy);
    this.view.ghost = w;
    this.view.ghostOk = !canBuildAt(this.st, this.rt, this.view.placing, w.x, w.y);
  }

  private tap(sx: number, sy: number): void {
    if (this.mode !== 'play' || !this.st || !this.rt || this.ui.screenOpen) return;
    const st = this.st;
    const rt = this.rt;
    const w = this.cam.toWorld(sx, sy);
    if (this.view.placing) {
      this.view.ghost = w;
      this.view.ghostOk = !canBuildAt(st, rt, this.view.placing, w.x, w.y);
      this.ui.update();
      return;
    }
    // survivors
    const r = 16 / this.cam.zoom;
    let best = null as null | { squad: number; d: number };
    for (const s of st.survivors) {
      if (s.inside >= 0) continue;
      const d = Math.hypot(s.x - w.x, s.y - w.y);
      if (d < r && (!best || d < best.d)) best = { squad: s.squad, d };
    }
    if (best) {
      if (best.squad >= 0) {
        this.selectSquad(best.squad);
        this.ui.closePanel();
      } else this.ui.openPanel('guards');
      this.click();
      return;
    }
    // buildings (smallest containing rect wins)
    const pad = 3 / this.cam.zoom;
    let hit = -1;
    let area = Infinity;
    for (const b of this.map.buildings) {
      if (w.x >= b.x - pad && w.x <= b.x + b.w + pad && w.y >= b.y - pad && w.y <= b.y + b.h + pad && b.w * b.h < area) {
        hit = b.id;
        area = b.w * b.h;
      }
    }
    if (hit >= 0) {
      this.view.selectedBuilding = hit;
      this.ui.openPanel('building');
      this.click();
      return;
    }
    if (this.ui.panelOpen) {
      this.ui.closePanel();
      return;
    }
    // move the selected squad
    const sq = this.view.selectedSquad;
    if (sq >= 0 && squadMembers(st, sq).length) {
      const p = rt.nav.nearestFree(w.x, w.y, 6);
      orderSquad(st, rt, sq, { t: 'move', x: p.x, y: p.y });
      this.view.markers.push({ x: p.x, y: p.y, t: 0, c: SQUAD_COLORS[sq] });
      void buzz();
    }
  }

  // ------------------------------------------------------------------ main loop

  private frame(t: number): void {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const st = this.st;
    const rt = this.rt;
    if (st && rt) {
      const running = this.mode === 'title' || (!this.paused && !this.ui.screenOpen && !st.over);
      if (running) {
        const speed = this.mode === 'title' ? 1 : st.speed;
        this.acc += dt * speed;
        let n = 0;
        while (this.acc >= STEP && n < 12) {
          step(st, rt, STEP);
          this.acc -= STEP;
          n++;
        }
        if (n === 12) this.acc = 0;
        stepFx(rt, dt * speed);
      }
      if (this.mode === 'title') {
        // slow cinematic drift around the haven; ignore events
        this.demoT += dt;
        const hq = this.map.buildings[this.map.hqId];
        this.cam.x = hq.x + hq.w / 2 - 140 + Math.sin(this.demoT * 0.05) * 160;
        this.cam.y = hq.y + hq.h / 2 + Math.cos(this.demoT * 0.04) * 90;
        this.cam.clamp();
        rt.events.length = 0;
        if (st.over || st.survivors.length < 3) this.startDemo();
      } else this.handleEvents(st, rt);
      this.input.update(dt);
      this.cam.update(dt);
      this.view.time += dt;
      for (const m of this.view.markers) m.t += dt;
      this.view.markers = this.view.markers.filter((m) => m.t < 0.7);
      this.renderer.render(this.ctx, this.cam, st, rt, this.view, { fog: this.mode === 'play' });
      this.sfx.setMood(nightness(st.time));
      if (this.mode === 'play') {
        this.hudTimer -= dt;
        if (this.hudTimer <= 0) {
          this.hudTimer = 0.15;
          this.ui.update();
        }
        if (st.over && this.endTimer < 0) {
          this.endTimer = 3.2;
          clearSave();
        }
        if (this.endTimer > 0) {
          this.endTimer -= dt;
          if (this.endTimer <= 0) this.ui.showEnd(st);
        }
      }
    }
    requestAnimationFrame((tt) => this.frame(tt));
  }

  private handleEvents(st: GameState, rt: Runtime): void {
    for (const e of rt.events) {
      if (e.k === 'toast') this.ui.toast(e.text, e.tone);
      else if (e.k === 'banner') {
        this.ui.banner(e.title, e.sub, e.tone);
        if (e.tone === 'bad') void buzz('heavy');
      } else if (e.k === 'save') this.save();
      else if (e.k === 'sfx') {
        let vol = 1;
        if (e.x || e.y) {
          const d = Math.hypot(e.x - this.cam.x, e.y - this.cam.y);
          const range = 380 + 260 / Math.max(0.4, this.cam.zoom);
          vol = Math.max(0, 1 - d / range) * Math.min(1, 0.45 + this.cam.zoom * 0.4);
        }
        this.sfx.play(e.name, vol);
      }
    }
    rt.events.length = 0;
    void st;
  }
}

async function boot(): Promise<void> {
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Loading';
  document.body.appendChild(loading);
  await initPlatform();
  await new Promise((r) => setTimeout(r, 30));
  try {
    await document.fonts.ready;
  } catch {
    /* ignore */
  }
  const game = new Game();
  (window as unknown as { __game: Game }).__game = game;
  if (import.meta.env.DEV) {
    // test hook: advance the simulation quickly
    (window as unknown as { __advance: (s: number) => number }).__advance = (secs: number) => {
      const t0 = performance.now();
      const n = Math.round(secs / STEP);
      for (let i = 0; i < n && game.st && game.rt && !game.st.over; i++) step(game.st, game.rt, STEP);
      return performance.now() - t0;
    };
  }
  loading.remove();
}

void boot();
