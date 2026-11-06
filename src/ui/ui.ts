import { I } from './icons';
import {
  GOAL_DAY,
  GUNS,
  ROLES,
  SQUAD_COLORS,
  SQUAD_NAMES,
  STRUCTS,
  VEHICLES,
  VEH_SEAT,
  WEATHER,
  capacity,
  hourOf,
  isNight,
  maxHpOf,
  type GameState,
  type OrderType,
  type Role,
  type StructKind,
  type Survivor,
} from '../game/state';
import { TUTORIAL, canClaim, engineerAtHaven, fortCost, repairCost, squadMembers, structCost, vehicleOf, type Runtime, type Tone } from '../game/sim';
import type { MapData } from '../world/types';
import type { ViewState } from '../render/worldRenderer';
import type { Prefs } from '../save';

export interface App {
  st: GameState | null;
  rt: Runtime | null;
  map: MapData;
  view: ViewState;
  paused: boolean;
  prefs: Prefs;
  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void;
  setSpeed(n: number): void;
  togglePause(): void;
  selectSquad(i: number): void;
  focusSquad(i: number): void;
  order(t: OrderType, b?: number, v?: number): void;
  fortify(b: number): void;
  startPlacing(k: StructKind): void;
  confirmPlace(): void;
  cancelPlace(): void;
  assign(survivorId: number, squad: number): void;
  vehicleAction(a: 'in' | 'out' | 'leave'): void;
  focusHaven(): void;
  newGame(): void;
  continueGame(): void;
  hasSave(): boolean;
  quitToTitle(): void;
  click(): void;
}

type PanelMode = 'none' | 'building' | 'build' | 'squad' | 'guards' | 'vehicle';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const ROLE_ICON: Record<Role, string> = { soldier: I.target, scout: I.scout, medic: I.med, engineer: I.hammer, scavenger: I.scavenge };

export const LOGO = `<svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd29a"/><stop offset="1" stop-color="#ff6a1f"/></linearGradient></defs>
  <path d="M32 4l24 9v17c0 14-10 24-24 30C18 54 8 44 8 30V13z" fill="#1a120c" stroke="url(#lg)" stroke-width="3"/>
  <path d="M32 50c-7 0-11-4.6-11-10.4 0-7.4 7-10 8.4-18.6C35 24.4 43 30.6 43 39.4 43 45.6 38.6 50 32 50z" fill="url(#lg)"/>
  <path d="M32 50c-3.4 0-5.6-2.2-5.6-5.2 0-3.6 3.2-5 4.2-8.8 3 2 6.6 4.6 6.6 8.8 0 3-2.2 5.2-5.2 5.2z" fill="#fff1df"/>
</svg>`;

export class Ui {
  private hud: HTMLElement;
  private screens: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  private panel: PanelMode = 'none';
  private panelKey = '';
  private resCache = '';
  private lastRes = { food: 0, mat: 0, ammo: 0, med: 0, fuel: 0 };
  private squadKeys: string[] = [];
  private placeKey = '';
  private pressing = false;
  private screen: '' | 'title' | 'howto' | 'pause' | 'end' | 'settings' = '';
  private settingsBack: 'title' | 'pause' = 'title';

  constructor(
    root: HTMLElement,
    private app: App,
  ) {
    root.innerHTML = `
      <div id="hud" class="hidden">
        <div class="clock panel">
          <div class="clock-row"><div class="day"><small>DAY</small><span data-r="day">1</span></div><div class="time" data-r="time">${I.sun}<span>07:30</span></div></div>
          <div class="phase" data-r="phase"><i></i></div>
          <div class="phase-label" data-r="phaseLabel"></div>
          <div class="objective" data-r="objWrap">${I.target}<span data-r="obj"></span></div>
        </div>
        <div class="res panel" data-r="res"></div>
        <div class="controls">
          <div class="seg panel" data-r="speed">
            <button class="btn-ic" data-speed="0" aria-label="Pause">${I.pause}</button>
            <button class="btn-ic" data-speed="1" aria-label="Normal speed">${I.play}</button>
            <button class="btn-ic" data-speed="2" aria-label="Fast">${I.ff}</button>
            <button class="btn-ic" data-speed="3" aria-label="Fastest">${I.fff}</button>
          </div>
          <button class="menu-btn panel" data-act="menu" aria-label="Menu">${I.menu}</button>
        </div>
        <div class="squads" data-r="squads"></div>
        <div class="actions">
          <button class="fab panel" data-act="haven">${I.haven}<span>Haven</span></button>
          <button class="fab primary" data-act="build">${I.hammer}<span>Build</span></button>
        </div>
        <div class="card panel hidden" data-r="card"></div>
        <div class="placebar panel hidden" data-r="placebar"></div>
        <div class="toasts" data-r="toasts"></div>
        <div class="banner" data-r="banner"></div>
      </div>
      <div id="screens"></div>
      <div class="rotate">Rotate your device to landscape</div>`;
    this.hud = root.querySelector('#hud')!;
    this.screens = root.querySelector('#screens')!;
    root.querySelectorAll<HTMLElement>('[data-r]').forEach((e) => (this.el[e.dataset.r!] = e));

    this.el.squads.innerHTML =
      SQUAD_NAMES.map(
        (n, i) => `<button class="squad panel" data-squad="${i}" style="--c:${SQUAD_COLORS[i]}">
          <div class="sq-head"><span class="dot"></span>${n}<span class="count" data-c></span></div>
          <div class="status" data-s></div><div class="pips" data-p></div><div class="prog" data-g></div></button>`,
      ).join('') +
      `<button class="squad panel guards" data-squad="-1"><div class="sq-head"><span class="dot"></span>Haven<span class="count" data-c></span></div><div class="status" data-s>Guards</div><div class="pips" data-p></div></button>`;

    this.hud.addEventListener('click', (e) => this.onClick(e));
    this.screens.addEventListener('click', (e) => this.onScreenClick(e));
    this.el.card.addEventListener('pointerdown', () => (this.pressing = true));
    const release = () => setTimeout(() => (this.pressing = false), 0);
    addEventListener('pointerup', release);
    addEventListener('pointercancel', release);
  }

  // ------------------------------------------------------------------ events

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const sp = t.closest<HTMLElement>('[data-speed]');
    if (sp) {
      this.app.click();
      this.app.setSpeed(Number(sp.dataset.speed));
      return;
    }
    const sq = t.closest<HTMLElement>('[data-squad]');
    if (sq) {
      this.app.click();
      const i = Number(sq.dataset.squad);
      if (i === -1) {
        this.togglePanel('guards');
        return;
      }
      if (this.app.view.selectedSquad === i) {
        if (this.panel === 'squad') this.closePanel();
        else this.openPanel('squad');
        this.app.focusSquad(i);
      } else {
        this.app.selectSquad(i);
        if (this.panel === 'squad') this.panelKey = '';
      }
      return;
    }
    const a = t.closest<HTMLElement>('[data-act]');
    if (!a || (a as HTMLButtonElement).disabled) return;
    this.app.click();
    const act = a.dataset.act!;
    const b = this.app.view.selectedBuilding;
    switch (act) {
      case 'menu':
        this.app.togglePause();
        this.showPause();
        break;
      case 'haven':
        this.app.focusHaven();
        this.app.view.selectedBuilding = this.app.map.hqId;
        this.openPanel('building');
        break;
      case 'build':
        this.togglePanel('build');
        break;
      case 'close':
        this.closePanel();
        break;
      case 'scout':
      case 'scavenge':
      case 'claim':
        this.app.order(act, b);
        this.closePanel();
        break;
      case 'take':
        this.app.order('vehicle', undefined, this.app.view.selectedVehicle);
        this.closePanel();
        break;
      case 'veh-in':
        this.app.vehicleAction('in');
        this.panelKey = '';
        break;
      case 'veh-out':
        this.app.vehicleAction('out');
        this.panelKey = '';
        break;
      case 'veh-leave':
        this.app.vehicleAction('leave');
        this.panelKey = '';
        break;
      case 'return':
        this.app.order('return');
        break;
      case 'hold':
        this.app.order('idle');
        break;
      case 'fortify':
        this.app.fortify(b);
        this.panelKey = '';
        break;
      case 'place':
        this.closePanel();
        this.app.startPlacing(a.dataset.kind as StructKind);
        break;
      case 'place-ok':
        this.app.confirmPlace();
        break;
      case 'place-cancel':
        this.app.cancelPlace();
        break;
      case 'assign':
        this.app.assign(Number(a.dataset.id), this.app.view.selectedSquad);
        this.panelKey = '';
        break;
      case 'home':
        this.app.assign(Number(a.dataset.id), -1);
        this.panelKey = '';
        break;
    }
  }

  private onScreenClick(e: Event): void {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!a) return;
    this.app.click();
    const p = this.app.prefs;
    switch (a.dataset.act) {
      case 'new':
        this.app.newGame();
        break;
      case 'continue':
        this.app.continueGame();
        break;
      case 'howto':
        this.showHowTo();
        break;
      case 'settings':
        this.settingsBack = this.screen === 'pause' ? 'pause' : 'title';
        this.showSettings();
        break;
      case 'back':
        if (this.screen === 'settings' && this.settingsBack === 'title') this.showTitle();
        else if (this.app.st && !this.app.st.over && (this.screen !== 'howto' || this.settingsBack === 'pause' || this.app.paused)) this.showPause();
        else this.showTitle();
        break;
      case 'resume':
        this.hideScreens();
        this.app.togglePause();
        break;
      case 'quit':
        this.app.quitToTitle();
        break;
      case 'pref': {
        const k = a.dataset.k as keyof Prefs;
        const v = a.dataset.v!;
        if (k === 'quality') this.app.setPref('quality', v as Prefs['quality']);
        else if (k === 'brightness') this.app.setPref('brightness', Number(v));
        else this.app.setPref(k, !p[k] as never);
        this.showSettings();
        break;
      }
    }
  }

  // ------------------------------------------------------------------ panels

  openPanel(mode: PanelMode): void {
    this.panel = mode;
    this.panelKey = '';
    this.renderPanel();
  }

  togglePanel(mode: PanelMode): void {
    if (this.panel === mode) this.closePanel();
    else this.openPanel(mode);
  }

  closePanel(): void {
    if (this.panel === 'building') this.app.view.selectedBuilding = -1;
    if (this.panel === 'vehicle') this.app.view.selectedVehicle = -1;
    this.panel = 'none';
    this.el.card.classList.add('hidden');
  }

  get panelOpen(): boolean {
    return this.panel !== 'none';
  }

  private renderPanel(): void {
    const st = this.app.st;
    const rt = this.app.rt;
    if (!st || !rt || this.panel === 'none') {
      this.el.card.classList.add('hidden');
      return;
    }
    let html = '';
    if (this.panel === 'building') {
      const id = this.app.view.selectedBuilding;
      if (id < 0) return this.closePanel();
      html = this.buildingCard(st, rt, id);
    } else if (this.panel === 'vehicle') {
      const id = this.app.view.selectedVehicle;
      if (id < 0) return this.closePanel();
      html = this.vehicleCard(st, id);
    } else if (this.panel === 'build') html = this.buildSheet(st);
    else if (this.panel === 'squad') html = this.squadSheet(st);
    else if (this.panel === 'guards') html = this.guardsSheet(st);
    // Never swap the panel's buttons while a finger is on it, or the tap would be lost.
    if (html !== this.panelKey && !this.pressing) {
      this.el.card.innerHTML = html;
      this.panelKey = html;
    }
    this.patchDynamic(st);
    this.el.card.classList.remove('hidden');
  }

  /** Fast-changing numbers (health) are patched in place instead of re-rendering the panel. */
  private patchDynamic(st: GameState): void {
    this.el.card.querySelectorAll<HTMLElement>('[data-hp]').forEach((el) => {
      const s = st.survivors.find((x) => x.id === Number(el.dataset.hp));
      (el.firstElementChild as HTMLElement).style.width = s ? `${Math.max(0, (s.hp / s.maxHp) * 100)}%` : '0%';
    });
    const bar = this.el.card.querySelector<HTMLElement>('[data-bhp]');
    if (bar) {
      const id = Number(bar.dataset.bhp);
      const max = maxHpOf(this.app.map, st.b, id);
      const f = Math.max(0, st.b[id].hp / max);
      const i = bar.firstElementChild as HTMLElement;
      i.style.width = `${f * 100}%`;
      i.style.background = f > 0.5 ? 'var(--good)' : f > 0.25 ? 'var(--warn)' : 'var(--bad)';
      const txt = this.el.card.querySelector<HTMLElement>('[data-bhptext]');
      if (txt) txt.textContent = `${Math.max(0, Math.round(st.b[id].hp))} / ${max}`;
    }
    const vb = this.el.card.querySelector<HTMLElement>('[data-vhp]');
    if (vb) {
      const v = st.vehicles.find((q) => q.id === Number(vb.dataset.vhp));
      if (v) (vb.firstElementChild as HTMLElement).style.width = `${Math.max(0, (v.hp / VEHICLES[v.kind].hp) * 100)}%`;
    }
  }

  private head(title: string, sub: string): string {
    return `<div class="card-head"><div><div class="card-title">${esc(title)}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}</div><button class="card-x" data-act="close" aria-label="Close">${I.close}</button></div>`;
  }

  private squadChip(st: GameState, busy = false): string {
    const sq = this.app.view.selectedSquad;
    const n = sq >= 0 ? squadMembers(st, sq).length : 0;
    if (!n) return `<div class="note">Squad ${SQUAD_NAMES[sq] ?? ''} has no one assigned. Tap the squad card to add survivors.</div>`;
    const v = vehicleOf(st, sq);
    return `<div class="squad-chip" style="--c:${SQUAD_COLORS[sq]}"><i></i>Orders go to Squad ${SQUAD_NAMES[sq]} (${n})${v ? ` · ${VEHICLES[v.kind].name}` : ''}${busy ? ' · already here' : ''}</div>`;
  }

  private buildingCard(st: GameState, rt: Runtime, id: number): string {
    const d = this.app.map.buildings[id];
    const b = st.b[id];
    const sq = this.app.view.selectedSquad;
    const members = sq >= 0 ? squadMembers(st, sq) : [];
    const busyHere = st.squads.some((s) => s.order.b === id && s.order.phase !== 'done' && s.order.t !== 'idle');
    const tags: string[] = [];
    const kind = d.kind === 'firestation' ? 'Fire station' : d.kind[0].toUpperCase() + d.kind.slice(1);
    tags.push(`<span class="tag">${kind}</span>`);
    if (id === this.app.map.hqId) tags.push('<span class="tag ember">Haven HQ</span>');
    else if (b.owned) tags.push('<span class="tag ember">Your haven</span>');
    else if (b.breached) tags.push('<span class="tag bad">Overrun</span>');
    else if (!b.explored) tags.push('<span class="tag">Unexplored</span>');
    else tags.push('<span class="tag good">Scouted</span>');
    if (b.explored && b.survivors > 0) tags.push(`<span class="tag info">${b.survivors} survivor${b.survivors > 1 ? 's' : ''}</span>`);
    let body = '';
    const l = b.loot;
    const lootLeft = l.food + l.mat + l.ammo + l.med + l.guns + (l.fuel || 0);
    if (b.owned) {
      body += `<div class="hpbar" data-bhp="${id}"><i></i></div>`;
      body += `<div class="kv"><span>Structure</span><b data-bhptext></b></div>`;
      body += `<div class="kv"><span>Barricades</span><b>${['None', 'Planks', 'Sandbags', 'Steel'][b.fort]}</b></div>`;
      body += `<div class="kv"><span>Beds</span><b>${d.capacity}</b></div>`;
    } else if (b.explored) {
      const cell = (ic: string, n: number, col: string) => `<div class="${n ? '' : 'zero'}" style="color:${col}">${ic}<span style="color:var(--text)">${n}</span></div>`;
      body += `<div class="loot six">${cell(I.food, l.food, 'var(--food)')}${cell(I.mat, l.mat, 'var(--mat)')}${cell(I.ammo, l.ammo, 'var(--ammo)')}${cell(I.med, l.med, 'var(--med)')}${cell(I.fuel, l.fuel || 0, 'var(--fuel)')}${cell(I.gun, l.guns, '#b0bec5')}</div>`;
      if (!lootLeft) body += `<div class="note">Picked clean.</div>`;
    } else {
      body += `<div class="note">Contents unknown. Infected may be hiding inside. Scout it first.</div>`;
    }
    let btns = '';
    const noSquad = members.length === 0;
    if (b.owned) {
      if (b.fort < 3) {
        const cost = fortCost(st, b.fort);
        btns += `<button class="btn primary" data-act="fortify" ${st.res.mat < cost ? 'disabled' : ''}>${I.fortify}Fortify <small>${cost} mat</small></button>`;
      } else btns += `<button class="btn" disabled>${I.fortify}Max barricades</button>`;
      if (id === this.app.map.hqId) btns += `<button class="btn" data-act="build">${I.hammer}Build</button>`;
      else btns += `<button class="btn" data-act="haven">${I.haven}Haven</button>`;
    } else {
      if (!b.explored) {
        btns += `<button class="btn" data-act="scout" ${noSquad ? 'disabled' : ''}>${I.scout}Scout</button>`;
        btns += `<button class="btn primary" data-act="scavenge" ${noSquad ? 'disabled' : ''}>${I.scavenge}Scavenge</button>`;
      } else {
        if (b.survivors > 0) btns += `<button class="btn" data-act="scout" ${noSquad ? 'disabled' : ''}>${I.person}Rescue</button>`;
        if (lootLeft) btns += `<button class="btn primary" data-act="scavenge" ${noSquad ? 'disabled' : ''}>${I.scavenge}Scavenge</button>`;
      }
      const why = canClaim(st, rt, id);
      btns += `<button class="btn" data-act="claim" ${noSquad || why ? 'disabled' : ''}>${I.claim}Claim <small>+${d.capacity} beds</small></button>`;
    }
    let footer = '';
    if (!b.owned) {
      const why = canClaim(st, rt, id);
      footer = this.squadChip(st, busyHere) + (why && b.explored && !noSquad ? `<div class="note" style="margin-top:4px">Claim: ${why.toLowerCase()}.</div>` : '');
    }
    const btnCount = (btns.match(/class="btn/g) || []).length;
    return `${this.head(d.name, d.sub)}<div class="tags">${tags.join('')}</div>${body}<div class="btns ${btnCount === 1 ? 'one' : ''}">${btns}</div>${footer}`;
  }

  private vehicleCard(st: GameState, id: number): string {
    const v = st.vehicles.find((q) => q.id === id);
    if (!v) return '';
    const K = VEHICLES[v.kind];
    const sq = this.app.view.selectedSquad;
    const mine = v.squad >= 0 && v.squad === sq;
    const tags = [`<span class="tag">${v.kind === 'van' ? 'Van' : v.kind === 'cruiser' ? 'Police car' : 'Car'}</span>`];
    if (v.wreck) tags.push('<span class="tag bad">Wrecked</span>');
    else if (v.squad >= 0) tags.push(`<span class="tag info">Squad ${SQUAD_NAMES[v.squad]}</span>`);
    else if (v.broken) tags.push('<span class="tag">Needs repair</span>');
    else tags.push('<span class="tag good">Runs</span>');
    const range = (st.res.fuel / K.fuelPer100) * 100;
    let body = `<div class="hpbar" data-vhp="${v.id}"><i></i></div>`;
    body += `<div class="kv"><span>Speed</span><b>${K.speed >= 130 ? 'Fast' : K.speed >= 110 ? 'Good' : 'Slow but sturdy'}</b></div>`;
    body += `<div class="kv"><span>Fuel stockpile</span><b>${Math.floor(st.res.fuel)} · range ≈ ${(range / 1000).toFixed(1)} km</b></div>`;
    let btns = '';
    const members = sq >= 0 ? squadMembers(st, sq) : [];
    if (v.wreck) body += `<div class="note">Burnt out. Nothing left to salvage.</div>`;
    else if (mine) {
      const riding = members.some((m) => m.inside === VEH_SEAT + v.id);
      btns += riding ? `<button class="btn" data-act="veh-out">${I.door}Get out</button>` : `<button class="btn primary" data-act="veh-in">${I.car}Get in</button>`;
      btns += `<button class="btn" data-act="veh-leave">${I.close}Leave it</button>`;
    } else if (v.squad >= 0) {
      btns += `<button class="btn" disabled>${I.car}In use</button>`;
    } else {
      const cost = repairCost(st, v);
      btns += `<button class="btn primary" data-act="take" ${!members.length || (v.broken && st.res.mat < cost) ? 'disabled' : ''}>${I.car}${v.broken ? `Repair &amp; take <small>${cost} mat</small>` : 'Take vehicle'}</button>`;
    }
    const note = v.wreck ? '' : `<div class="note">Squads drive on trips longer than a couple of blocks. Engines are loud, and you can run the infected down, but it damages the vehicle.</div>`;
    const btnCount = (btns.match(/class="btn/g) || []).length;
    return `${this.head(K.name, v.wreck ? 'Wreck' : `${Math.round((v.hp / K.hp) * 100)}% condition`)}<div class="tags">${tags.join('')}</div>${body}${btns ? `<div class="btns ${btnCount === 1 ? 'one' : ''}">${btns}</div>` : ''}${v.wreck ? '' : this.squadChip(st)}${note}`;
  }

  private buildSheet(st: GameState): string {
    const eng = engineerAtHaven(st);
    const items = (Object.keys(STRUCTS) as StructKind[])
      .map((k) => {
        const s = STRUCTS[k];
        const cost = structCost(st, k);
        const ok = st.res.mat >= cost;
        return `<button class="build-item ${ok ? '' : 'no'}" data-act="place" data-kind="${k}"><div class="bi">${I[k]}</div><div><b>${s.name}</b><p>${s.desc}</p></div><div class="cost">${I.mat}${cost}</div></button>`;
      })
      .join('');
    return `${this.head('Build', eng ? 'An engineer at the haven cuts costs by 20%.' : 'Structures must be placed near your haven.')}<div class="build-list">${items}</div>`;
  }

  private memberRow(m: Survivor, action: string): string {
    const r = ROLES[m.role];
    return `<div class="member"><div><b>${esc(m.name)}</b>${m.joining ? ' <small style="color:var(--info)">· arriving</small>' : ''}<span>${ROLE_ICON[m.role]}${r.name} · ${I.gun}${GUNS[m.gun].name}</span></div>${action}<div class="hpbar" data-hp="${m.id}"><i></i></div></div>`;
  }

  private squadSheet(st: GameState): string {
    const sq = this.app.view.selectedSquad;
    const members = squadMembers(st, sq);
    const guards = st.survivors.filter((s) => s.squad === -1 && !s.joining);
    const inBuilding = members.some((m) => m.inside >= 0 && m.inside < VEH_SEAT);
    const riding = members.some((m) => m.inside >= VEH_SEAT);
    const busy = inBuilding || riding;
    const full = members.length >= 4;
    const v = vehicleOf(st, sq);
    const rows = members.map((m) => this.memberRow(m, `<button class="mini" data-act="home" data-id="${m.id}" ${busy ? 'disabled' : ''}>Send home</button>`)).join('');
    const avail = guards.map((m) => this.memberRow(m, `<button class="mini" data-act="assign" data-id="${m.id}" ${busy || full ? 'disabled' : ''}>Assign</button>`)).join('');
    let veh = '';
    if (v) {
      veh = `<div class="veh-row">${I.car}<div><b>${VEHICLES[v.kind].name}</b><span>${riding ? 'Driving' : 'Parked'} · ${Math.round((v.hp / VEHICLES[v.kind].hp) * 100)}% condition</span></div>
        ${riding ? `<button class="mini" data-act="veh-out">Get out</button>` : `<button class="mini" data-act="veh-in" ${inBuilding ? 'disabled' : ''}>Get in</button>`}<button class="mini" data-act="veh-leave">Leave</button></div>`;
    }
    return `${this.head(`Squad ${SQUAD_NAMES[sq]}`, `${members.length} / 4 members`)}
      ${rows || '<div class="note">No one assigned yet. Pick someone from the haven below.</div>'}
      ${veh}
      <div class="btns"><button class="btn" data-act="hold" ${!members.length ? 'disabled' : ''}>${I.stop}Hold</button><button class="btn" data-act="return" ${!members.length ? 'disabled' : ''}>${I.ret}Return</button></div>
      ${busy ? '<div class="note">Members can be swapped once the squad is outside and on foot.</div>' : ''}
      <div class="sub-title">At the haven (${guards.length})</div>
      ${avail || '<div class="note">No one is free at the haven.</div>'}`;
  }

  private guardsSheet(st: GameState): string {
    const guards = st.survivors.filter((s) => s.squad === -1);
    const rows = guards.map((m) => this.memberRow(m, '')).join('');
    const roleNotes = (Object.keys(ROLES) as Role[]).map((r) => `<div class="kv"><span>${ROLE_ICON[r]} ${ROLES[r].name}</span><b>${ROLES[r].desc}</b></div>`).join('');
    return `${this.head('Haven Guards', `${guards.length} survivors defend the haven and heal there`)}${rows || '<div class="note">No one is guarding the haven.</div>'}<div class="sub-title">Roles</div><div class="roles">${roleNotes}</div>`;
  }

  // ------------------------------------------------------------------ hud updates

  showHud(on: boolean): void {
    this.hud.classList.toggle('hidden', !on);
  }

  update(): void {
    const st = this.app.st;
    const rt = this.app.rt;
    if (!st || !rt) return;
    const h = hourOf(st.time);
    const night = isNight(st.time);
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    this.el.day.textContent = String(st.day);
    this.el.time.className = `time ${night ? 'night' : ''}`;
    this.el.time.innerHTML = `${night ? I.moon : I.sun}<span>${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}</span>`;
    let frac: number;
    let label: string;
    if (!night && h >= 5 && h < 20) {
      const start = h < 6 ? 5 : 6;
      frac = (h - start) / (20 - start);
      const left = 20 - h;
      label = `Nightfall in ${Math.floor(left)}h ${String(Math.floor((left % 1) * 60)).padStart(2, '0')}m`;
    } else {
      const since = h >= 20 ? h - 20 : h + 4;
      frac = since / 9;
      const left = 9 - since;
      label = `Dawn in ${Math.floor(left)}h ${String(Math.floor((left % 1) * 60)).padStart(2, '0')}m${st.hordeTotal ? ` · horde from the ${st.hordeFrom}` : ''}`;
    }
    const w = st.weather ?? 'clear';
    if (w !== 'clear') label += ` · ${WEATHER[w].name}`;
    this.el.phase.className = `phase ${night ? 'night' : ''}`;
    (this.el.phase.firstElementChild as HTMLElement).style.width = `${Math.min(100, frac * 100)}%`;
    this.el.phaseLabel.textContent = label;
    const tut = TUTORIAL[Math.min(st.tutorial, TUTORIAL.length - 1)];
    this.el.obj.textContent = st.tutorial >= TUTORIAL.length - 1 ? `Survive until Day ${GOAL_DAY}. ${Math.max(0, GOAL_DAY - st.day)} days to go.` : tut;

    // resources
    const pop = st.survivors.length;
    const cap = capacity(this.app.map, st);
    const r = { food: st.res.food, mat: st.res.mat, ammo: st.res.ammo, med: st.res.med, fuel: Math.floor(st.res.fuel) };
    const key = `${r.food}|${r.mat}|${r.ammo}|${r.med}|${r.fuel}|${pop}|${cap}`;
    if (key !== this.resCache) {
      const flash = (k: keyof typeof r) => (r[k] > this.lastRes[k] && this.resCache ? 'flash' : '');
      this.el.res.innerHTML = `
        <div class="chip food ${r.food < pop ? 'low' : flash('food')}" title="Food">${I.food}${r.food}</div>
        <div class="chip mat ${flash('mat')}" title="Materials">${I.mat}${r.mat}</div>
        <div class="chip ammo ${r.ammo < 15 ? 'low' : flash('ammo')}" title="Ammo">${I.ammo}${r.ammo}</div>
        <div class="chip med ${flash('med')}" title="Medicine">${I.med}${r.med}</div>
        <div class="chip fuel ${flash('fuel')}" title="Fuel">${I.fuel}${r.fuel}</div>
        <div class="chip pop" title="Survivors / beds">${I.people}${pop}<small>/${cap}</small></div>`;
      this.resCache = key;
      this.lastRes = { ...r };
      setTimeout(() => this.el.res.querySelectorAll('.flash').forEach((c) => c.classList.remove('flash')), 900);
    }
    this.el.speed.querySelectorAll<HTMLElement>('[data-speed]').forEach((b) => {
      const s = Number(b.dataset.speed);
      b.classList.toggle('on', this.app.paused ? s === 0 : s === st.speed && s > 0);
    });
    // squads
    const cards = this.el.squads.querySelectorAll<HTMLElement>('.squad');
    cards.forEach((card, idx) => {
      const i = idx < 3 ? idx : -1;
      const members = i >= 0 ? squadMembers(st, i) : st.survivors.filter((s) => s.squad === -1);
      let status = 'Idle';
      let cls = '';
      let prog = 0;
      if (i >= 0) {
        const o = st.squads[i].order;
        const bname = o.b !== undefined ? this.app.map.buildings[o.b].name : '';
        const riding = members.length > 0 && members.every((m) => m.inside >= VEH_SEAT);
        if (!members.length) status = 'No members';
        else if (o.drive === 'drive') {
          status = o.b !== undefined ? `Driving to ${bname}` : 'Driving';
          cls = 'busy';
        } else if (o.drive === 'board' || o.t === 'vehicle') {
          status = 'To the vehicle';
          cls = 'busy';
        } else if (o.phase === 'inside') {
          prog = Math.min(1, (o.timer ?? 0) / (o.total || 1));
          const explored = st.b[o.b!].explored;
          status = `${!explored ? 'Scouting' : o.t === 'scavenge' ? 'Scavenging' : o.t === 'claim' ? 'Claiming' : 'Searching'} ${Math.round(prog * 100)}%`;
          cls = 'busy';
        } else if (o.phase === 'clear') {
          status = `Fighting at ${bname}`;
          cls = 'fight';
        } else if (o.t === 'move') {
          status = 'Moving';
          cls = 'busy';
        } else if (o.t === 'return') {
          status = 'Returning';
          cls = 'busy';
        } else if (o.t !== 'idle' && o.phase === 'go') {
          status = `To ${bname}`;
          cls = 'busy';
        } else if (riding) status = 'In the vehicle';
      } else status = members.length ? 'Guarding' : 'Unguarded';
      const pips = members.map((m) => `<div class="pip"><i style="width:${Math.round((m.hp / m.maxHp) * 20) * 5}%"></i></div>`).join('');
      const k = `${status}|${cls}|${pips}|${prog.toFixed(2)}|${this.app.view.selectedSquad}`;
      if (this.squadKeys[idx] === k) return;
      this.squadKeys[idx] = k;
      card.querySelector<HTMLElement>('[data-c]')!.textContent = String(members.length);
      const s = card.querySelector<HTMLElement>('[data-s]')!;
      s.textContent = status;
      s.className = `status ${cls}`;
      card.querySelector<HTMLElement>('[data-p]')!.innerHTML = pips;
      const g = card.querySelector<HTMLElement>('[data-g]');
      if (g) g.style.width = `${prog * 100}%`;
      card.classList.toggle('sel', i >= 0 && this.app.view.selectedSquad === i);
      card.classList.toggle('empty', !members.length);
    });
    if (this.panel !== 'none') this.renderPanel();
    const v = this.app.view;
    if (v.placing) {
      const s = STRUCTS[v.placing];
      const cost = structCost(st, v.placing);
      const msg = v.ghost ? (v.ghostOk ? `Place <b>${s.name}</b> here?` : `<span class="msg bad">Can't build here</span>`) : `Tap near your haven to place <b>${s.name}</b>`;
      const html = `<div class="msg">${msg}</div><button class="btn" data-act="place-cancel">${I.close}</button>${v.ghost && v.ghostOk ? `<button class="btn primary" data-act="place-ok">${I.check}Build <small>${cost}</small></button>` : ''}`;
      if (this.placeKey !== html) {
        this.el.placebar.innerHTML = html;
        this.placeKey = html;
      }
      this.el.placebar.classList.remove('hidden');
    } else {
      this.el.placebar.classList.add('hidden');
      this.placeKey = '';
    }
  }

  // ------------------------------------------------------------------ toasts & banner

  toast(text: string, tone: Tone): void {
    const t = document.createElement('div');
    t.className = `toast ${tone}`;
    t.textContent = text;
    const box = this.el.toasts;
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild!.remove();
    setTimeout(() => t.classList.add('out'), 3600);
    setTimeout(() => t.remove(), 4100);
  }

  banner(title: string, sub: string, tone: Tone): void {
    const b = this.el.banner;
    b.className = `banner ${tone}`;
    b.innerHTML = `<div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;
  }

  // ------------------------------------------------------------------ screens

  hideScreens(): void {
    this.screens.innerHTML = '';
    this.screen = '';
  }

  showTitle(): void {
    this.screen = 'title';
    const save = this.app.hasSave();
    this.screens.innerHTML = `<div class="screen title"><div class="title-inner">
      <div class="logo">${LOGO}<h1>Ember<br/>Haven</h1></div>
      <p class="tagline">Hold the light. Survive the night.</p>
      <div class="menu">
        ${save ? `<button class="btn primary" data-act="continue">${I.play}Continue</button>` : ''}
        <button class="btn ${save ? '' : 'primary'}" data-act="new">${I.flame}New game</button>
        <button class="btn" data-act="howto">${I.info}How to play</button>
        <button class="btn" data-act="settings">${I.gear}Settings</button>
      </div>
      <div class="foot">v0.3 prototype · pre-generated town map</div>
    </div></div>`;
  }

  showHowTo(): void {
    if (this.screen === 'pause') this.settingsBack = 'pause';
    else if (this.screen === 'title') this.settingsBack = 'title';
    this.screen = 'howto';
    const tip = (ic: string, t: string, p: string) => `<div class="tip"><div class="bi">${ic}</div><div><b>${t}</b><p>${p}</p></div></div>`;
    this.screens.innerHTML = `<div class="screen dim"><div class="modal panel">
      <h2>How to play</h2>
      <div class="tips">
        ${tip(I.people, 'Command squads', 'Tap a squad card to select it. Tap the ground to move, or tap a building for orders. Tap the card again to swap members.')}
        ${tip(I.scout, 'Scout & scavenge', 'Scouting reveals supplies, infected and survivors. Scavenging brings everything back to your stockpile.')}
        ${tip(I.target, 'Roles matter', 'Soldiers fight, scouts move and see further, medics heal, engineers cut building costs, scavengers find more.')}
        ${tip(I.car, 'Vehicles', 'Repair abandoned cars and squads will drive longer trips. Driving burns fuel and makes noise.')}
        ${tip(I.claim, 'Grow the haven', 'Claim cleared buildings next to your haven for more beds. Rescued survivors move in and stand guard.')}
        ${tip(I.fortify, 'Fortify & build', 'Barricade haven buildings and build watchtowers, fire barrels, gardens, workshops and infirmaries.')}
        ${tip(I.moon, 'Nights are deadly', 'At 20:00 a horde marches on the haven. Light the dark so guards can see, and bring squads home.')}
        ${tip(I.rain, 'Weather', 'Rain muffles gunfire but cuts visibility. Fog hides the infected until they are close.')}
      </div>
      <div class="row"><button class="btn primary" data-act="back">${I.ret}Back</button></div>
    </div></div>`;
  }

  showSettings(): void {
    this.screen = 'settings';
    const p = this.app.prefs;
    const toggle = (k: 'music' | 'sound' | 'haptics', ic: string, label: string) =>
      `<div class="set-row"><span>${ic}${label}</span><button class="switch ${p[k] ? 'on' : ''}" data-act="pref" data-k="${k}" aria-pressed="${p[k]}"><i></i></button></div>`;
    const seg = <T extends string | number>(k: 'quality' | 'brightness', opts: [T, string][], cur: T) =>
      `<div class="seg-ctl">${opts.map(([v, l]) => `<button class="${v === cur ? 'on' : ''}" data-act="pref" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
    this.screens.innerHTML = `<div class="screen dim"><div class="modal panel" style="width:min(480px,100%)">
      <h2>Settings</h2>
      <div class="settings">
        ${toggle('music', I.music, 'Music')}
        ${toggle('sound', I.sound, 'Sound effects')}
        ${toggle('haptics', I.vibrate, 'Vibration')}
        <div class="set-row col"><span>${I.gear}Graphics</span>${seg('quality', [['high', 'High'], ['balanced', 'Balanced'], ['low', 'Battery saver']], p.quality)}</div>
        <div class="set-row col"><span>${I.sun}Brightness</span>${seg('brightness', [[-2, 'Darker'], [-1, '−'], [0, 'Default'], [1, '+'], [2, 'Brighter']], p.brightness)}</div>
      </div>
      <div class="row"><button class="btn primary" data-act="back">${I.ret}Back</button></div>
    </div></div>`;
  }

  showPause(): void {
    this.screen = 'pause';
    this.screens.innerHTML = `<div class="screen dim"><div class="modal panel" style="width:min(360px,100%)">
      <h2>Paused</h2>
      <div class="menu" style="width:100%">
        <button class="btn primary" data-act="resume">${I.play}Resume</button>
        <button class="btn" data-act="howto">${I.info}How to play</button>
        <button class="btn" data-act="settings">${I.gear}Settings</button>
        <button class="btn" data-act="quit">${I.ret}Save &amp; quit to title</button>
      </div></div></div>`;
  }

  showEnd(st: GameState): void {
    this.screen = 'end';
    const won = st.over === 'won';
    this.screens.innerHTML = `<div class="screen dim"><div class="modal panel" style="width:min(520px,100%)">
      <h2 style="color:${won ? 'var(--ember-2)' : '#ff9a8a'}">${won ? 'You made it' : 'Overrun'}</h2>
      <div class="note" style="font-size:14px">${won ? `The convoy rolled into town on the morning of Day ${GOAL_DAY}. ${st.survivors.length} survivors climbed aboard.` : `The haven held out until day ${st.day}.`}</div>
      <div class="stats">
        <div><b>${st.day}</b><span>Days</span></div>
        <div><b>${st.stats.kills}</b><span>Infected</span></div>
        <div><b>${st.stats.rescued}</b><span>Rescued</span></div>
        <div><b>${st.stats.looted}</b><span>Looted</span></div>
      </div>
      <div class="row"><button class="btn primary" data-act="new">${I.flame}New game</button><button class="btn" data-act="quit">${I.ret}Title</button></div>
    </div></div>`;
  }

  get screenOpen(): boolean {
    return this.screen !== '';
  }
}
