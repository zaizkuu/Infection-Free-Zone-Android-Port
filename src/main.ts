import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import './ui/styles.css';

import { Capacitor } from '@capacitor/core';
import { generateMap, vehicleSpots } from './world/mapgen';
import { NavGrid, CELL } from './world/nav';
import type { MapData } from './world/types';
import { Camera } from './render/camera';
import { WorldRenderer, type ViewState } from './render/worldRenderer';
import { Input } from './input';
import { Sfx } from './audio/sfx';
import { Music } from './audio/music';
import { Ui, type App } from './ui/ui';
import { initPlatform, buzz, getLocation } from './platform';
import { clearSave, hasSave, loadGame, loadPrefs, saveGame, savePrefs, type Prefs } from './save';
import { buildRealMap, fetchOsm, reverseName, searchPlaces, type OsmData, type Place } from './world/osm';
import { loadMap, saveMap } from './world/mapstore';
import { DAY_LEN, SQUAD_COLORS, STRUCTS, VEH_SEAT, WALL_MAX, migrate, nightness, newGame, type GameState, type OrderType, type StructKind } from './game/state';
import { assignSurvivor, build, canBuildAt, canBuildWall, createRuntime, dismantle, fortify, orderSquad, populate, releaseVehicle, salvageInfo, squadMembers, step, stepFx, syncFog, unloadAll, vehicleOf, type Runtime } from './game/sim';

/** The town is generated from a fixed seed, so every game uses the same pre-generated map. */
const SEED = 1337;
const STEP = 1 / 30;

class Game implements App {
  st: GameState | null = null;
  rt: Runtime | null = null;
  map: MapData;
  view: ViewState = { selectedSquad: 0, selectedBuilding: -1, selectedVehicle: -1, selectedStructure: -1, selectedProp: -1, placing: null, wallStart: null, ghost: null, ghostOk: false, markers: [], time: 0 };
  paused = false;
  prefs: Prefs;
  placeError = '';
  mode: 'title' | 'play' = 'title';

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cam: Camera;
  private renderer: WorldRenderer;
  private input: Input;
  private sfx = new Sfx();
  private vehicleProps: Set<number> | null = null;
  private procMap: MapData;
  private loadAbort: AbortController | null = null;
  private procRenderer: WorldRenderer;
  private music = new Music();
  private tension = 0;
  private tensionTimer = 0;
  private rainOn = -1;
  private ui: Ui;
  private acc = 0;
  private last = performance.now();
  private hudTimer = 0;
  private endTimer = -1;
  private demoT = 0;

  constructor() {
    this.canvas = document.getElementById('game') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.map = this.procMap = generateMap(SEED);
    const fogW = Math.ceil(this.map.width / 40);
    const fogH = Math.ceil(this.map.height / 40);
    this.renderer = this.procRenderer = new WorldRenderer(this.map, fogW, fogH);
    this.renderer.mapR.warmup();
    this.cam = new Camera(this.map.width, this.map.height);
    this.input = new Input(
      this.canvas,
      this.cam,
      (x, y) => this.tap(x, y),
      (x, y) => this.hover(x, y),
    );
    this.prefs = loadPrefs();
    this.ui = new Ui(document.getElementById('ui')!, this);
    this.sfx.enabled = this.prefs.sound;
    this.music.enabled = this.prefs.music;
    this.renderer.mapR.setBlur(this.prefs.quality !== 'low');
    this.resize();
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.save();
        this.sfx.suspend();
      } else this.sfx.resume();
    });
    addEventListener(
      'pointerdown',
      () => {
        this.sfx.unlock();
        if (this.sfx.context) this.music.attach(this.sfx.context);
      },
      { capture: true },
    );
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
        if (this.mode !== 'play') {
          const sc = this.ui.currentScreen;
          if (sc === 'loading') return this.cancelLoad();
          if (sc === 'mappick' || sc === 'howto' || sc === 'settings') return this.ui.showTitle();
          return void CapApp.exitApp();
        }
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
    const cap = this.prefs.quality === 'low' ? 1 : this.prefs.quality === 'balanced' ? 1.5 : 2;
    const dpr = Math.min(cap, devicePixelRatio || 1);
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
    // the world as this save left it: demolished buildings and scrapped cars
    st.b.forEach((b, i) => {
      if (!b.demolished) return;
      const d = this.map.buildings[i];
      if (d.poly) nav.markPoly(d.poly, 0, 0);
      else nav.clearRect(d);
    });
    for (const pi of st.salvaged) nav.clearProp(this.map.props[pi]);
    for (const s of st.structures) {
      if (s.built >= 1 && (s.kind === 'tower' || s.kind === 'workshop' || s.kind === 'infirmary')) {
        const r = STRUCTS[s.kind].r - 2;
        for (let dx = -r; dx <= r; dx += CELL / 2) for (let dy = -r; dy <= r; dy += CELL / 2) nav.blocked[nav.idx(s.x + dx, s.y + dy)] = 1;
      }
    }
    return rt;
  }

  private startDemo(): void {
    this.useMap(this.procMap);
    const st = newGame(this.map, SEED + 99);
    st.time = DAY_LEN * (15.5 / 24); // 21:30
    st.lastHour = 21.5;
    const rt = this.freshRuntime(st);
    rt.explored.fill(1);
    const hq = this.map.buildings[this.map.hqId];
    st.structures.push({ id: 900, kind: 'tower', x: hq.x - 26, y: hq.y + hq.h + 30, hp: 220, cd: 0, t: 0, built: 1, cost: 30 });
    st.structures.push({ id: 901, kind: 'barrel', x: hq.x + hq.w + 24, y: hq.y + hq.h + 16, hp: 60, cd: 0, t: 0, built: 1, cost: 6 });
    st.structures.push({ id: 902, kind: 'barrel', x: hq.x + 10, y: hq.y - 22, hp: 60, cd: 0, t: 0, built: 1, cost: 6 });
    this.renderer.mapR.setWorldState([], []);
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

  /** Switches the world being played and its renderer. */
  private useMap(map: MapData): void {
    if (this.map === map) return;
    this.map = map;
    if (map === this.procMap) this.renderer = this.procRenderer;
    else {
      this.renderer = new WorldRenderer(map, Math.ceil(map.width / 40), Math.ceil(map.height / 40));
      this.renderer.mapR.warmup();
    }
    this.cam.mapW = map.width;
    this.cam.mapH = map.height;
    this.vehicleProps = null;
    this.resize();
  }

  /** Starts a game on a real-world map built from OpenStreetMap data. */
  startRealGame(map: MapData): void {
    clearSave();
    this.useMap(map);
    const st = newGame(map, map.seed);
    st.mapRef = { lat: map.real!.lat, lon: map.real!.lon, name: map.real!.name };
    const rt = this.freshRuntime(st);
    populate(st, rt, Math.round(150 + Math.min(130, map.buildings.length / 12)));
    this.begin(st, rt);
    void saveMap(map);
    this.ui.banner('Day 1', `${map.townName} has fallen. Your haven is ${map.buildings[map.hqId].name}. The dead come at night.`, 'info');
  }

  search(q: string): Promise<Place[]> {
    return searchPlaces(q);
  }

  /** Downloads the area around a place from OpenStreetMap and starts a game there. */
  pickPlace(place: Place): void {
    this.loadAbort?.abort();
    const ctl = new AbortController();
    this.loadAbort = ctl;
    this.ui.showLoading(place.name, 'Downloading map data…');
    fetchOsm(place.lat, place.lon, (m) => this.ui.setLoadingStatus(m), ctl.signal)
      .then((data) => {
        if (ctl.signal.aborted) return;
        this.ui.setLoadingStatus('Building the town…');
        setTimeout(() => {
          if (ctl.signal.aborted) return;
          this.loadAbort = null;
          try {
            this.startRealGame(buildRealMap(data, place));
          } catch (e) {
            this.ui.showMapPicker({ error: e instanceof Error ? e.message : 'Could not build a town here.' });
          }
        }, 30);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        this.loadAbort = null;
        this.ui.showMapPicker({ error: e instanceof Error ? e.message : 'Download failed.' });
      });
  }

  async useMyLocation(): Promise<void> {
    this.loadAbort?.abort();
    const ctl = new AbortController();
    this.loadAbort = ctl;
    this.ui.showLoading('Your location', 'Finding where you are…');
    try {
      const pos = await getLocation();
      if (ctl.signal.aborted) return;
      let name = 'Your neighbourhood';
      try {
        name = await reverseName(pos.lat, pos.lon);
      } catch {
        /* keep the generic name */
      }
      if (ctl.signal.aborted) return;
      this.loadAbort = null;
      this.pickPlace({ lat: pos.lat, lon: pos.lon, name });
    } catch {
      if (!ctl.signal.aborted) this.ui.showMapPicker({ error: "Couldn't get your location. Allow location access, or search for a place instead." });
    }
  }

  cancelLoad(): void {
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.ui.showMapPicker();
  }

  /** Converts downloaded OSM data and starts playing it. */
  playOsm(data: OsmData, place: Place): void {
    this.startRealGame(buildRealMap(data, place));
  }

  newGame(): void {
    clearSave();
    this.useMap(this.procMap);
    const st = newGame(this.map, SEED);
    const rt = this.freshRuntime(st);
    populate(st, rt, 175);
    this.begin(st, rt);
    this.ui.banner('Day 1', `${this.map.townName} has fallen. Scout the neighbourhood and get ready. The dead come at night.`, 'info');
  }

  async continueGame(): Promise<void> {
    const saved = loadGame();
    if (!saved) return this.newGame();
    if (saved.mapRef) {
      const map = await loadMap();
      if (!map || !map.real || Math.abs(map.real.lat - saved.mapRef.lat) > 1e-6 || Math.abs(map.real.lon - saved.mapRef.lon) > 1e-6) {
        this.ui.showTitle(`The map for ${saved.mapRef.name} is no longer on this device. Start a new game there to download it again.`);
        return;
      }
      this.useMap(map);
    } else this.useMap(this.procMap);
    const st = migrate(saved, this.map);
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
    this.view = { selectedSquad: 0, selectedBuilding: -1, selectedVehicle: -1, selectedStructure: -1, selectedProp: -1, placing: null, wallStart: null, ghost: null, ghostOk: false, markers: [], time: 0 };
    this.ui.hideScreens();
    this.ui.closePanel();
    this.ui.showHud(true);
    this.renderer.mapR.setWorldState(
      st.b.flatMap((b, i) => (b.demolished ? [i] : [])),
      st.salvaged,
    );
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

  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
    this.prefs = { ...this.prefs, [k]: v };
    savePrefs(this.prefs);
    if (k === 'sound') this.sfx.setEnabled(!!v);
    if (k === 'music') {
      this.sfx.unlock();
      if (this.sfx.context) this.music.attach(this.sfx.context);
      this.music.setEnabled(!!v);
    }
    if (k === 'quality') {
      this.renderer.mapR.setBlur(v !== 'low');
      this.resize();
    }
    if (k === 'haptics' && v) void buzz();
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
    if (m.length && m[0].inside >= 0 && m[0].inside < VEH_SEAT && o.b !== undefined) {
      const d = this.map.buildings[o.b];
      this.cam.focus(d.door.x, d.door.y);
    } else if (m.length) this.cam.focus(m[0].x, m[0].y);
  }

  focusHaven(): void {
    const hq = this.map.buildings[this.map.hqId];
    this.cam.focus(hq.x + hq.w / 2, hq.y + hq.h / 2 + 20);
  }

  order(t: OrderType, b?: number, v?: number): void {
    if (!this.st || !this.rt) return;
    const sq = this.view.selectedSquad;
    if (sq < 0 || !squadMembers(this.st, sq).length) return;
    orderSquad(this.st, this.rt, sq, { t, b, v });
    if (b !== undefined) {
      const d = this.map.buildings[b];
      this.view.markers.push({ x: d.door.x, y: d.door.y, t: 0, c: SQUAD_COLORS[sq] });
    }
    const veh = v !== undefined ? this.st.vehicles.find((q) => q.id === v) : null;
    if (veh) this.view.markers.push({ x: veh.x, y: veh.y, t: 0, c: SQUAD_COLORS[sq] });
    this.buzz();
    this.ui.update();
  }

  vehicleAction(a: 'in' | 'out' | 'leave'): void {
    if (!this.st || !this.rt) return;
    const sq = this.view.selectedSquad;
    if (sq < 0) return;
    const v = vehicleOf(this.st, sq);
    if (a === 'in' && v) this.order('vehicle', undefined, v.id);
    else if (a === 'out') {
      unloadAll(this.st, this.rt, sq);
      this.st.squads[sq].order = { t: 'idle' };
    } else if (a === 'leave') releaseVehicle(this.st, this.rt, sq);
    this.ui.update();
  }

  private buzz(kind: 'light' | 'heavy' = 'light'): void {
    if (this.prefs.haptics) void buzz(kind);
  }

  fortify(b: number): void {
    if (!this.st || !this.rt) return;
    if (fortify(this.st, this.rt, b)) this.buzz('heavy');
    this.ui.update();
  }

  startPlacing(k: StructKind): void {
    this.view.placing = k;
    this.view.ghost = null;
    this.view.wallStart = null;
    this.placeError = '';
    this.view.selectedBuilding = -1;
    this.ui.update();
  }

  confirmPlace(): void {
    const v = this.view;
    if (!this.st || !this.rt || !v.placing || !v.ghost) return;
    const ok = v.placing === 'wall' ? !!v.wallStart && build(this.st, this.rt, 'wall', v.wallStart.x, v.wallStart.y, v.ghost.x, v.ghost.y) : build(this.st, this.rt, v.placing, v.ghost.x, v.ghost.y);
    if (ok) {
      this.buzz('heavy');
      v.placing = null;
      v.ghost = null;
      v.wallStart = null;
    }
    this.ui.update();
  }

  cancelPlace(): void {
    this.view.placing = null;
    this.view.ghost = null;
    this.view.wallStart = null;
    this.ui.update();
  }

  /** Updates the placement preview for a point the player is pointing at. */
  private aim(w: { x: number; y: number }): void {
    const st = this.st!;
    const rt = this.rt!;
    const v = this.view;
    if (v.placing === 'wall') {
      if (!v.wallStart) {
        v.ghost = null;
        return;
      }
      let ex = w.x;
      let ey = w.y;
      const len = Math.hypot(ex - v.wallStart.x, ey - v.wallStart.y);
      if (len > WALL_MAX) {
        ex = v.wallStart.x + ((ex - v.wallStart.x) / len) * WALL_MAX;
        ey = v.wallStart.y + ((ey - v.wallStart.y) / len) * WALL_MAX;
      }
      v.ghost = { x: ex, y: ey };
      this.placeError = canBuildWall(st, rt, v.wallStart.x, v.wallStart.y, ex, ey) ?? '';
    } else if (v.placing) {
      v.ghost = w;
      this.placeError = canBuildAt(st, rt, v.placing, w.x, w.y) ?? '';
    }
    v.ghostOk = !this.placeError;
  }

  salvage(t: { p?: number; v?: number }): void {
    if (!this.st || !this.rt) return;
    const sq = this.view.selectedSquad;
    if (sq < 0 || !squadMembers(this.st, sq).length) return;
    orderSquad(this.st, this.rt, sq, { t: 'salvage', p: t.p, v: t.v });
    const x = t.p !== undefined ? this.map.props[t.p].x : this.st.vehicles.find((q) => q.id === t.v)?.x;
    const y = t.p !== undefined ? this.map.props[t.p].y : this.st.vehicles.find((q) => q.id === t.v)?.y;
    if (x !== undefined && y !== undefined) this.view.markers.push({ x, y, t: 0, c: SQUAD_COLORS[sq] });
    this.buzz();
    this.ui.update();
  }

  dismantle(id: number): void {
    if (!this.st || !this.rt) return;
    dismantle(this.st, this.rt, id);
    this.ui.update();
  }

  assign(survivorId: number, squad: number): void {
    if (!this.st || !this.rt) return;
    assignSurvivor(this.st, this.rt, survivorId, squad);
    this.ui.update();
  }

  // ------------------------------------------------------------------ input

  private hover(sx: number, sy: number): void {
    if (this.mode !== 'play' || !this.view.placing || !this.st || !this.rt) return;
    this.aim(this.cam.toWorld(sx, sy));
  }

  private tap(sx: number, sy: number): void {
    if (this.mode !== 'play' || !this.st || !this.rt || this.ui.screenOpen) return;
    const st = this.st;
    const rt = this.rt;
    const w = this.cam.toWorld(sx, sy);
    if (this.view.placing) {
      if (this.view.placing === 'wall' && !this.view.wallStart) {
        this.view.wallStart = w;
        this.view.ghost = null;
        this.placeError = '';
      } else this.aim(w);
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
    // vehicles
    let vbest = -1;
    let vd = 14 / this.cam.zoom + 6;
    for (const v of st.vehicles) {
      const d = Math.hypot(v.x - w.x, v.y - w.y);
      if (d < vd && rt.explored[Math.floor(v.y / 40) * rt.fogW + Math.floor(v.x / 40)]) {
        vd = d;
        vbest = v.id;
      }
    }
    if (vbest >= 0) {
      this.view.selectedVehicle = vbest;
      this.view.selectedBuilding = -1;
      this.ui.openPanel('vehicle');
      this.click();
      return;
    }
    // structures (walls by distance to the segment)
    let sbest = -1;
    let sd = 10 / this.cam.zoom + 4;
    for (const s of st.structures) {
      let d: number;
      if (s.kind === 'wall') {
        const x2 = s.x2!;
        const y2 = s.y2!;
        const L2 = (x2 - s.x) ** 2 + (y2 - s.y) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((w.x - s.x) * (x2 - s.x) + (w.y - s.y) * (y2 - s.y)) / L2));
        d = Math.hypot(w.x - (s.x + (x2 - s.x) * t), w.y - (s.y + (y2 - s.y) * t));
      } else d = Math.hypot(w.x - s.x, w.y - s.y) - STRUCTS[s.kind].r;
      if (d < sd) {
        sd = d;
        sbest = s.id;
      }
    }
    if (sbest >= 0) {
      this.view.selectedStructure = sbest;
      this.view.selectedBuilding = -1;
      this.ui.openPanel('structure');
      this.click();
      return;
    }
    // abandoned cars that can be scrapped
    if (!this.vehicleProps) this.vehicleProps = new Set(vehicleSpots(this.map));
    let pbest = -1;
    let pd = 11 / this.cam.zoom + 5;
    this.map.props.forEach((p, i) => {
      if (this.vehicleProps!.has(i)) return;
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d >= pd || !salvageInfo(rt, i) || st.salvaged.includes(i)) return;
      if (!rt.explored[Math.floor(p.y / 40) * rt.fogW + Math.floor(p.x / 40)]) return;
      pd = d;
      pbest = i;
    });
    if (pbest >= 0) {
      this.view.selectedProp = pbest;
      this.view.selectedBuilding = -1;
      this.ui.openPanel('prop');
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
      this.buzz();
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
      this.renderer.render(this.ctx, this.cam, st, rt, this.view, { fog: this.mode === 'play', quality: this.prefs.quality, brightness: this.prefs.brightness });
      const nt = nightness(st.time);
      this.sfx.setMood(nt);
      // music follows the danger: how many of the horde are close to the haven
      this.tensionTimer -= dt;
      if (this.tensionTimer <= 0) {
        this.tensionTimer = 0.5;
        const hq = this.map.buildings[this.map.hqId];
        let near = 0;
        for (const z of st.zombies) if ((z.mode === 2 || z.mode === 1) && Math.hypot(z.x - hq.x, z.y - hq.y) < 420) near++;
        this.tension = this.mode === 'play' ? Math.min(1, near / 8) : 0;
      }
      this.music.setMood(nt, this.tension);
      const rain = st.weather === 'rain' ? 1 : 0;
      if (rain !== this.rainOn) {
        this.rainOn = rain;
        this.sfx.setRain(rain);
      }
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
        if (e.tone === 'bad') this.buzz('heavy');
      } else if (e.k === 'save') this.save();
      else if (e.k === 'world') {
        if (e.building !== undefined) this.renderer.mapR.markDemolished(e.building);
        if (e.prop !== undefined) this.renderer.mapR.hideProp(e.prop);
      }
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
    // test hook: play a saved Overpass JSON file as a real-world map
    (window as unknown as { __loadFixture: (url: string, place: Place) => Promise<void> }).__loadFixture = async (url, place) => {
      const data = (await (await fetch(url)).json()) as OsmData;
      game.playOsm(data, place);
    };
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
