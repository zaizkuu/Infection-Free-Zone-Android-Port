import { Rng } from '../core/rng';
import { clamp, dist, dist2, distToRect, type Vec } from '../core/math';
import type { MapData } from '../world/types';
import { CELL, NavGrid } from '../world/nav';
import {
  BUILD_RANGE,
  CLAIM_RANGE,
  DAY_LEN,
  FOG_CELL,
  FORT_COST,
  GOAL_DAY,
  GUNS,
  ROLE_LIST,
  STRUCTS,
  VEHICLES,
  VEH_SEAT,
  WALL_MAX,
  WEATHER,
  ZKINDS,
  wallCost,
  workFor,
  capacity,
  hourOf,
  isNight,
  maxHpOf,
  nameFor,
  type GameState,
  type Order,
  type StructKind,
  type Structure,
  type Survivor,
  type Vehicle,
  type Weather,
  type Zombie,
} from './state';

// ---- runtime (not saved) -------------------------------------------------------

export type Tone = 'info' | 'good' | 'warn' | 'bad';
export type GameEvent =
  | { k: 'toast'; text: string; tone: Tone }
  | { k: 'banner'; title: string; sub: string; tone: Tone }
  | { k: 'sfx'; name: SfxName; x: number; y: number }
  | { k: 'save' }
  | { k: 'world'; building?: number; prop?: number };
export type SfxName = 'pistol' | 'rifle' | 'melee' | 'hit' | 'zdie' | 'sdie' | 'groan' | 'alarm' | 'build' | 'loot' | 'door' | 'dawn' | 'tower' | 'engine' | 'crash';

export interface Tracer {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  t: number;
}
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  c: string;
  s: number;
}
export interface Decal {
  x: number;
  y: number;
  r: number;
  a: number;
  t: number;
  corpse: boolean;
}
export interface Flash {
  x: number;
  y: number;
  t: number;
}

export interface Runtime {
  map: MapData;
  nav: NavGrid;
  rng: Rng;
  flow: Float32Array | null;
  flowDirty: boolean;
  events: GameEvent[];
  tracers: Tracer[];
  particles: Particle[];
  decals: Decal[];
  flashes: Flash[];
  explored: Uint8Array;
  fogW: number;
  fogH: number;
  fogDirty: boolean;
  zcells: Zombie[][];
  zcw: number;
  zch: number;
  visTimer: number;
  thinkTimer: number;
  postsDirty: boolean;
  workshopTimer: number;
  tutTimer: number;
  hordeTimer: number;
  attackAlert: number;
  survById: Map<number, Survivor>;
  /** per nav cell: id of a finished wall standing there, or -1 */
  wallAt: Int32Array;
  wallsDirty: boolean;
}

const ZCELL = 50;

export function createRuntime(map: MapData, nav: NavGrid, st: GameState): Runtime {
  const fogW = Math.ceil(map.width / FOG_CELL);
  const fogH = Math.ceil(map.height / FOG_CELL);
  const explored = new Uint8Array(fogW * fogH);
  for (const i of st.fog) explored[i] = 1;
  const zcw = Math.ceil(map.width / ZCELL);
  const zch = Math.ceil(map.height / ZCELL);
  const rng = new Rng(1);
  rng.state = st.rngState;
  return {
    map,
    nav,
    rng,
    flow: null,
    flowDirty: true,
    events: [],
    tracers: [],
    particles: [],
    decals: [],
    flashes: [],
    explored,
    fogW,
    fogH,
    fogDirty: true,
    zcells: Array.from({ length: zcw * zch }, () => []),
    zcw,
    zch,
    visTimer: 0,
    thinkTimer: 0,
    postsDirty: true,
    workshopTimer: 0,
    tutTimer: 0,
    hordeTimer: 0,
    attackAlert: 0,
    survById: new Map(),
    wallAt: new Int32Array(nav.w * nav.h).fill(-1),
    wallsDirty: true,
  };
}

const toast = (rt: Runtime, text: string, tone: Tone = 'info') => rt.events.push({ k: 'toast', text, tone });
const sfx = (rt: Runtime, name: SfxName, x: number, y: number) => rt.events.push({ k: 'sfx', name, x, y });

// ---- helpers ---------------------------------------------------------------------

export function squadMembers(st: GameState, squad: number): Survivor[] {
  return st.survivors.filter((s) => s.squad === squad && !s.joining);
}

export function hq(rt: Runtime) {
  return rt.map.buildings[rt.map.hqId];
}

/** Engineers guarding the haven make construction cheaper. */
export function engineerAtHaven(st: GameState): boolean {
  return st.survivors.some((s) => s.squad === -1 && !s.joining && s.role === 'engineer');
}

export function fortCost(st: GameState, level: number): number {
  return Math.round(FORT_COST[level] * (engineerAtHaven(st) ? 0.8 : 1));
}

export function structCost(st: GameState, kind: StructKind, len = 0): number {
  const base = kind === 'wall' ? wallCost(len) : STRUCTS[kind].cost;
  return Math.round(base * (engineerAtHaven(st) ? 0.8 : 1));
}

// ---- demolition & salvage numbers ----------------------------------------------

const DEMO_MUL: Partial<Record<string, number>> = { warehouse: 1.25, factory: 1.3, barn: 1.15, church: 1.2, apartment: 1.15, office: 1.1, school: 1.1, hospital: 1.2, supermarket: 1.15, police: 1.1 };

/** Materials a building yields when torn down, and the worker-seconds it takes. */
export function demolishInfo(rt: Runtime, id: number): { mat: number; work: number } {
  const d = rt.map.buildings[id];
  const area = d.w * d.h;
  return { mat: Math.round(5 + Math.sqrt(area) * 0.6 * (DEMO_MUL[d.kind] ?? 1)), work: Math.round(area / 55 + d.wallH * 1.5) };
}

export function canDemolish(st: GameState, rt: Runtime, id: number): string | null {
  if (id === rt.map.hqId) return 'You can\'t tear down your own HQ';
  if (st.b[id].demolished) return 'Already rubble';
  return null;
}

const SALVAGE_KINDS = new Set(['car', 'police', 'truck', 'bus', 'firetruck']);

/** What scrapping an abandoned car (map prop) yields. */
export function salvageInfo(rt: Runtime, pi: number): { mat: number; fuel: number; work: number; name: string } | null {
  const p = rt.map.props[pi];
  if (!p || !SALVAGE_KINDS.has(p.kind)) return null;
  const burnt = p.c === '#2a2522';
  const h = (n: number) => hash01(pi, n);
  if (burnt) return { mat: 4 + Math.floor(h(1) * 3), fuel: 0, work: 8, name: 'Burnt-out wreck' };
  if (p.kind === 'car' || p.kind === 'police') return { mat: 6 + Math.floor(h(1) * 4), fuel: 1 + Math.floor(h(2) * 3), work: 8, name: p.kind === 'police' ? 'Abandoned police car' : 'Abandoned car' };
  if (p.kind === 'bus') return { mat: 14 + Math.floor(h(1) * 5), fuel: 2 + Math.floor(h(2) * 3), work: 18, name: 'Abandoned bus' };
  return { mat: 10 + Math.floor(h(1) * 5), fuel: 2 + Math.floor(h(2) * 3), work: 14, name: p.kind === 'firetruck' ? 'Fire engine' : 'Abandoned truck' };
}

export function vehicleSalvageInfo(v: Vehicle): { mat: number; fuel: number; work: number } {
  if (v.wreck) return { mat: 6, fuel: 0, work: 8 };
  return { mat: v.kind === 'van' ? 16 : v.kind === 'cruiser' ? 12 : 10, fuel: 2, work: 10 };
}

function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function repairCost(st: GameState, v: Vehicle): number {
  const eng = st.survivors.some((s) => s.squad >= 0 && s.role === 'engineer' && dist(s.x, s.y, v.x, v.y) < 40);
  return Math.round(VEHICLES[v.kind].repair * (eng ? 0.6 : 1));
}

export function vehicleOf(st: GameState, squad: number): Vehicle | null {
  const id = st.squads[squad]?.vehicle ?? -1;
  return st.vehicles.find((v) => v.id === id && !v.wreck) ?? null;
}

export function aboard(s: Survivor): boolean {
  return s.inside >= VEH_SEAT;
}

const hasRole = (list: Survivor[], r: Survivor['role']) => list.some((s) => s.role === r);
const weatherOf = (st: GameState) => WEATHER[st.weather ?? 'clear'];

export function ownedIds(st: GameState): number[] {
  const out: number[] = [];
  st.b.forEach((b, i) => b.owned && out.push(i));
  return out;
}

export function distToBase(st: GameState, rt: Runtime, x: number, y: number): number {
  let best = Infinity;
  st.b.forEach((b, i) => {
    if (b.owned) best = Math.min(best, distToRect(rt.map.buildings[i], x, y));
  });
  return best;
}

export function canClaim(st: GameState, rt: Runtime, id: number): string | null {
  const bs = st.b[id];
  if (bs.owned) return 'Already part of your haven';
  const d = rt.map.buildings[id];
  let near = Infinity;
  st.b.forEach((o, i) => {
    if (!o.owned) return;
    const od = rt.map.buildings[i];
    const dx = Math.max(od.x - (d.x + d.w), 0, d.x - (od.x + od.w));
    const dy = Math.max(od.y - (d.y + d.h), 0, d.y - (od.y + od.h));
    near = Math.min(near, Math.hypot(dx, dy));
  });
  if (near > CLAIM_RANGE) return 'Too far from your haven';
  return null;
}

function spawnZombie(st: GameState, rt: Runtime, x: number, y: number, kind: 0 | 1 | 2, mode: Zombie['mode']): Zombie {
  const z: Zombie = {
    id: st.nextId++,
    kind,
    x,
    y,
    hp: ZKINDS[kind].hp,
    mode,
    tx: x,
    ty: y,
    target: -1,
    cd: 0,
    think: rt.rng.next() * 0.5,
    facing: rt.rng.range(0, Math.PI * 2),
    anim: rt.rng.range(0, 10),
    seen: false,
    vx: 0,
    vy: 0,
  };
  st.zombies.push(z);
  return z;
}

/** Seeds wandering infected across town (new game). */
export function populate(st: GameState, rt: Runtime, count: number, avoidR = 430): void {
  const map = rt.map;
  const h = hq(rt);
  const hx = h.x + h.w / 2;
  const hy = h.y + h.h / 2;
  let placed = 0;
  for (let tries = 0; tries < count * 20 && placed < count; tries++) {
    // bias toward the town center
    const inTown = rt.rng.chance(0.85);
    const x = inTown ? rt.rng.range(map.town.x, map.town.x + map.town.w) : rt.rng.range(40, map.width - 40);
    const y = inTown ? rt.rng.range(map.town.y, map.town.y + map.town.h) : rt.rng.range(40, map.height - 40);
    if (Math.hypot(x - hx, y - hy) < avoidR) continue;
    if (rt.nav.isBlocked(x, y)) continue;
    const group = rt.rng.int(1, 4);
    for (let g = 0; g < group && placed < count; g++) {
      const gx = x + rt.rng.range(-18, 18);
      const gy = y + rt.rng.range(-18, 18);
      if (rt.nav.isBlocked(gx, gy)) continue;
      const kind = st.day >= 4 && rt.rng.chance(0.1) ? 1 : st.day >= 6 && rt.rng.chance(0.05) ? 2 : 0;
      spawnZombie(st, rt, gx, gy, kind, 0);
      placed++;
    }
  }
}

// ---- orders ----------------------------------------------------------------------

const FORMATION: Vec[] = [
  { x: 0, y: 0 },
  { x: 11, y: 4 },
  { x: -11, y: 4 },
  { x: 0, y: 11 },
  { x: 12, y: -8 },
  { x: -12, y: -8 },
];

function pathMembers(rt: Runtime, members: Survivor[], tx: number, ty: number): void {
  members.forEach((m, i) => {
    const o = FORMATION[i % FORMATION.length];
    const g = rt.nav.nearestFree(tx + o.x, ty + o.y, 4);
    m.goal = g;
    m.path = rt.nav.findPath(m.x, m.y, g.x, g.y);
    m.repath = 0;
  });
}

export function orderSquad(st: GameState, rt: Runtime, squad: number, order: Order): void {
  const sq = st.squads[squad];
  const members = squadMembers(st, squad);
  if (!members.length) return;
  // leaving a building early collects what was found so far
  exitBuilding(st, rt, squad, true);
  sq.order = { ...order, phase: 'go', timer: 0, total: 0 };
  if (order.t === 'vehicle') {
    const v = st.vehicles.find((q) => q.id === order.v);
    if (!v || v.wreck) return;
    if (members.every((m) => m.inside === VEH_SEAT + v.id)) {
      sq.order = { t: 'idle' };
      return;
    }
    unloadAll(st, rt, squad);
    pathMembers(rt, members, v.x, v.y);
    sfx(rt, 'door', members[0].x, members[0].y);
    return;
  }
  // Use the squad's vehicle for longer trips (or if they're already in it).
  const veh = vehicleOf(st, squad);
  const dest = orderDest(rt, order);
  if (veh && dest && order.t !== 'idle') {
    const riding = members.every((m) => m.inside === VEH_SEAT + veh.id);
    const lead = members[0];
    const far = dist(lead.x, lead.y, dest.x, dest.y) > 220 && dist(lead.x, lead.y, veh.x, veh.y) < dist(lead.x, lead.y, dest.x, dest.y) * 0.6;
    if (riding || far) {
      if (st.res.fuel <= 0) {
        toast(rt, 'No fuel. The squad will walk.', 'warn');
        unloadAll(st, rt, squad);
      } else {
        sq.order.drive = riding ? 'drive' : 'board';
        if (riding) startDrive(st, rt, veh, dest);
        else pathMembers(rt, members, veh.x, veh.y);
        return;
      }
    }
  } else if (veh && order.t === 'idle') {
    veh.path = null;
  }
  if (order.t === 'move') pathMembers(rt, members, order.x!, order.y!);
  else if (order.t === 'return') {
    const d = hq(rt).door;
    pathMembers(rt, members, d.x, d.y);
  } else if (order.t === 'idle') {
    members.forEach((m) => (m.path = null));
  } else if (order.b !== undefined) {
    const b = rt.map.buildings[order.b];
    pathMembers(rt, members, b.door.x, b.door.y);
  } else if (order.t === 'salvage') {
    _st = st;
    const t = salvageTarget(rt, order);
    if (t) pathMembers(rt, members, t.x, t.y);
  }
  sfx(rt, 'door', members[0].x, members[0].y);
}

function orderDest(rt: Runtime, o: Order): Vec | null {
  if (o.t === 'move') return { x: o.x!, y: o.y! };
  if (o.t === 'return') return hq(rt).door;
  if (o.b !== undefined) return rt.map.buildings[o.b].door;
  if (o.t === 'salvage') return salvageTarget(rt, o);
  return null;
}

let _st: GameState | null = null; // set each step so helpers can look up vehicles
function salvageTarget(rt: Runtime, o: Order): Vec | null {
  if (o.p !== undefined) {
    const p = rt.map.props[o.p];
    return p ? rt.nav.nearestFree(p.x, p.y + 8, 4) : null;
  }
  const v = _st?.vehicles.find((q) => q.id === o.v);
  return v ? rt.nav.nearestFree(v.x, v.y + 8, 4) : null;
}

function startDrive(_st: GameState, rt: Runtime, v: Vehicle, dest: Vec): void {
  const p = rt.nav.findPath(v.x, v.y, dest.x, dest.y);
  if (!p) {
    toast(rt, `The ${VEHICLES[v.kind].name} can't get there.`, 'warn');
    v.path = null;
    return;
  }
  v.path = p;
  sfx(rt, 'engine', v.x, v.y);
}

/** Puts every member of the squad who is riding back on the ground next to the vehicle. */
export function unloadAll(st: GameState, rt: Runtime, squad: number): void {
  const members = squadMembers(st, squad).filter(aboard);
  if (!members.length) return;
  const v = st.vehicles.find((q) => VEH_SEAT + q.id === members[0].inside);
  if (!v) {
    for (const m of members) m.inside = -1;
    return;
  }
  v.path = null;
  const side = v.a + Math.PI / 2;
  members.forEach((m, i) => {
    const f = FORMATION[i % FORMATION.length];
    const p = rt.nav.nearestFree(v.x + Math.cos(side) * 11 + f.x * 0.5, v.y + Math.sin(side) * 11 + f.y * 0.5, 5);
    m.inside = -1;
    m.x = p.x;
    m.y = p.y;
    m.path = null;
  });
  sfx(rt, 'door', v.x, v.y);
}

function board(_st: GameState, v: Vehicle, members: Survivor[]): void {
  for (const m of members) {
    m.inside = VEH_SEAT + v.id;
    m.x = v.x;
    m.y = v.y;
    m.path = null;
  }
}

/** Squad gives up its vehicle (it stays parked where it is). */
export function releaseVehicle(st: GameState, rt: Runtime, squad: number): void {
  const v = vehicleOf(st, squad);
  unloadAll(st, rt, squad);
  if (v) v.squad = -1;
  st.squads[squad].vehicle = -1;
  if (st.squads[squad].order.drive) st.squads[squad].order = { t: 'idle' };
}

function exitBuilding(st: GameState, rt: Runtime, squad: number, partial: boolean): void {
  const sq = st.squads[squad];
  const o = sq.order;
  const members = squadMembers(st, squad);
  if (o.b === undefined || o.phase !== 'inside') {
    return;
  }
  const b = rt.map.buildings[o.b];
  if (partial && o.t === 'scavenge' && st.b[o.b].explored && o.total) {
    collectLoot(st, rt, o.b, clamp((o.timer ?? 0) / o.total, 0, 1), members);
  }
  members.forEach((m, i) => {
    const f = FORMATION[i % FORMATION.length];
    const p = rt.nav.nearestFree(b.door.x + f.x * 0.6, b.door.y + f.y * 0.6, 4);
    m.inside = -1;
    m.x = p.x;
    m.y = p.y;
    m.path = null;
  });
  o.phase = 'done';
}

function collectLoot(st: GameState, rt: Runtime, id: number, frac: number, members: Survivor[]): void {
  const bs = st.b[id];
  const got = { food: 0, mat: 0, ammo: 0, med: 0, guns: 0, fuel: 0 };
  for (const k of ['food', 'mat', 'ammo', 'med', 'guns', 'fuel'] as const) {
    const have = bs.loot[k] || 0;
    const n = frac >= 1 ? have : Math.floor(have * frac);
    got[k] = n;
    bs.loot[k] = have - n;
  }
  // scavengers turn up a little extra
  if (hasRole(members, 'scavenger') && frac >= 1) {
    got.food += Math.ceil(got.food * 0.25);
    got.mat += Math.ceil(got.mat * 0.25);
    got.ammo += Math.ceil(got.ammo * 0.15);
  }
  st.res.food += got.food;
  st.res.mat += got.mat;
  st.res.ammo += got.ammo;
  st.res.med += got.med;
  st.res.fuel += got.fuel;
  // firearms upgrade survivors: melee -> pistol, then pistol -> rifle
  let guns = got.guns;
  const pool = [...members, ...st.survivors.filter((s) => !members.includes(s))];
  for (const tier of [0, 1] as const) {
    for (const s of pool) {
      if (guns <= 0) break;
      if (s.gun === tier) {
        s.gun = (tier + 1) as 1 | 2;
        guns--;
      }
    }
  }
  if (guns > 0) st.res.ammo += guns * 12;
  const parts: string[] = [];
  if (got.food) parts.push(`${got.food} food`);
  if (got.mat) parts.push(`${got.mat} materials`);
  if (got.ammo) parts.push(`${got.ammo} ammo`);
  if (got.med) parts.push(`${got.med} medicine`);
  if (got.fuel) parts.push(`${got.fuel} fuel`);
  if (got.guns) parts.push(`${got.guns} firearm${got.guns > 1 ? 's' : ''}`);
  const name = rt.map.buildings[id].name;
  if (parts.length) {
    toast(rt, `${name}: +${parts.join(', +')}`, 'good');
    st.stats.looted++;
    sfx(rt, 'loot', 0, 0);
  } else if (frac >= 1) toast(rt, `${name} had nothing left.`, 'info');
}

function rescue(st: GameState, rt: Runtime, id: number): void {
  const bs = st.b[id];
  if (bs.survivors <= 0) return;
  const free = capacity(rt.map, st) - st.survivors.length;
  const d = rt.map.buildings[id];
  if (free <= 0) {
    toast(rt, `${bs.survivors} survivor${bs.survivors > 1 ? 's' : ''} hiding in ${d.name}, but the haven is full. Claim more buildings.`, 'warn');
    return;
  }
  const n = Math.min(free, bs.survivors);
  bs.survivors -= n;
  const used = new Set(st.survivors.map((s) => s.name));
  const h = hq(rt);
  for (let i = 0; i < n; i++) {
    const p = rt.nav.nearestFree(d.door.x + i * 6, d.door.y + 4, 4);
    const s: Survivor = {
      id: st.nextId++,
      name: nameFor(rt.rng, used),
      x: p.x,
      y: p.y,
      hp: 70 + rt.rng.int(0, 30),
      maxHp: 100,
      squad: -1,
      gun: rt.rng.chance(0.25) ? 1 : 0,
      facing: 0,
      path: rt.nav.findPath(p.x, p.y, h.door.x, h.door.y),
      goal: { x: h.door.x, y: h.door.y },
      cd: 0,
      inside: -1,
      role: ROLE_LIST[rt.rng.int(0, ROLE_LIST.length - 1)],
      post: null,
      kills: 0,
      anim: rt.rng.next() * 10,
      repath: 0,
      joining: true,
    };
    if (s.role === 'soldier') s.maxHp = 120;
    st.survivors.push(s);
  }
  st.stats.rescued += n;
  rt.postsDirty = true;
  toast(rt, `Found ${n} survivor${n > 1 ? 's' : ''} in ${d.name}! Heading to the haven.`, 'good');
}

function updateSquads(st: GameState, rt: Runtime, dt: number): void {
  for (const s of st.survivors) s.working = false;
  for (const sq of st.squads) {
    const o = sq.order;
    const members = squadMembers(st, sq.id);
    if (!members.length) {
      if (o.t !== 'idle') sq.order = { t: 'idle' };
      if (sq.vehicle >= 0) {
        const v = st.vehicles.find((q) => q.id === sq.vehicle);
        if (v) v.squad = -1;
        sq.vehicle = -1;
      }
      continue;
    }
    if (o.t === 'vehicle') {
      const v = st.vehicles.find((q) => q.id === o.v);
      if (!v || v.wreck) {
        sq.order = { t: 'idle' };
        continue;
      }
      const near = members.some((m) => dist(m.x, m.y, v.x, v.y) < 20);
      if (!near && members.every((m) => !m.path)) {
        toast(rt, `Squad can't reach the ${VEHICLES[v.kind].name}.`, 'warn');
        sq.order = { t: 'idle' };
      }
      if (!near) continue;
      if (v.squad >= 0 && v.squad !== sq.id) {
        toast(rt, `Squad ${['Alpha', 'Bravo', 'Charlie'][v.squad]} already uses that vehicle.`, 'warn');
        sq.order = { t: 'idle' };
        continue;
      }
      if (v.broken) {
        const cost = repairCost(st, v);
        if (st.res.mat < cost) {
          toast(rt, `Need ${cost} materials to repair the ${VEHICLES[v.kind].name}.`, 'warn');
          sq.order = { t: 'idle' };
          continue;
        }
        st.res.mat -= cost;
        v.broken = false;
        toast(rt, `The ${VEHICLES[v.kind].name} is running again (-${cost} materials).`, 'good');
        for (let i = 0; i < 10; i++) spark(rt, v.x + rt.rng.range(-8, 8), v.y + rt.rng.range(-5, 5), '#ffcc80');
      }
      if (sq.vehicle >= 0 && sq.vehicle !== v.id) {
        const old = st.vehicles.find((q) => q.id === sq.vehicle);
        if (old) old.squad = -1;
      }
      sq.vehicle = v.id;
      v.squad = sq.id;
      board(st, v, members);
      sfx(rt, 'engine', v.x, v.y);
      toast(rt, `Squad ${['Alpha', 'Bravo', 'Charlie'][sq.id]} took the ${VEHICLES[v.kind].name}. Long trips are now driven.`, 'good');
      sq.order = { t: 'idle' };
      continue;
    }
    if (o.drive) {
      const v = vehicleOf(st, sq.id);
      const dest = orderDest(rt, o);
      if (!v || !dest) {
        delete o.drive;
        unloadAll(st, rt, sq.id);
        continue;
      }
      if (o.drive === 'board') {
        const allClose = members.every((m) => dist(m.x, m.y, v.x, v.y) < 18 || (!m.path && dist(m.x, m.y, v.x, v.y) < 34));
        if (allClose) {
          board(st, v, members);
          o.drive = 'drive';
          startDrive(st, rt, v, dest);
          if (!v.path) {
            delete o.drive;
            unloadAll(st, rt, sq.id);
            pathMembers(rt, members, dest.x, dest.y);
          }
        } else if (members.every((m) => !m.path)) {
          delete o.drive;
          pathMembers(rt, members, dest.x, dest.y);
        }
        continue;
      }
      // driving: wait until the vehicle arrives (or stops)
      if (v.path && v.path.length) continue;
      delete o.drive;
      unloadAll(st, rt, sq.id);
      if (o.t === 'move' || o.t === 'return') {
        sq.order = { t: 'idle' };
        continue;
      }
      pathMembers(rt, members, dest.x, dest.y);
      continue;
    }
    if (o.t === 'idle' || o.phase === 'done') continue;
    if (o.t === 'salvage') {
      updateSalvage(st, rt, sq.id, members, dt);
      continue;
    }
    if (o.t === 'move' || o.t === 'return') {
      if (members.every((m) => !m.path || !m.path.length)) sq.order = { t: 'idle' };
      continue;
    }
    const id = o.b!;
    const bd = rt.map.buildings[id];
    const bs = st.b[id];
    const lead = members[0];
    if (o.phase === 'go') {
      const near = members.some((m) => dist(m.x, m.y, bd.door.x, bd.door.y) < 20);
      const stuck = members.every((m) => !m.path || !m.path.length);
      if (near || stuck) {
        if (!near && stuck && dist(lead.x, lead.y, bd.door.x, bd.door.y) > 60) {
          toast(rt, `Squad can't reach ${bd.name}.`, 'warn');
          sq.order = { t: 'idle' };
          continue;
        }
        if (bs.infected > 0) {
          for (let i = 0; i < bs.infected; i++) {
            const p = rt.nav.nearestFree(bd.door.x + rt.rng.range(-8, 8), bd.door.y + rt.rng.range(-8, 8), 4);
            const z = spawnZombie(st, rt, p.x, p.y, st.day >= 5 && rt.rng.chance(0.08) ? 2 : 0, 1);
            z.target = lead.id;
          }
          toast(rt, `Infected inside ${bd.name}!`, 'bad');
          sfx(rt, 'groan', bd.door.x, bd.door.y);
          bs.infected = 0;
          o.phase = 'clear';
        } else if (o.t === 'demolish') startDemolition(st, rt, sq.id, members);
        else enterBuilding(st, rt, sq.id, members);
      }
    } else if (o.phase === 'clear') {
      let threats = 0;
      forZombiesNear(rt, bd.door.x, bd.door.y, 110, (z) => {
        if (z.mode === 1 || dist(z.x, z.y, bd.door.x, bd.door.y) < 60) threats++;
      });
      if (threats === 0) {
        if (o.t === 'demolish') startDemolition(st, rt, sq.id, members);
        else enterBuilding(st, rt, sq.id, members);
      }
    } else if (o.phase === 'work') {
      workDemolition(st, rt, sq.id, members, dt);
    } else if (o.phase === 'inside') {
      o.timer = (o.timer ?? 0) + dt;
      if (o.timer >= (o.total ?? 1)) {
        o.timer = 0;
        if (!bs.explored || (o.t === 'scout' && bs.survivors > 0)) {
          const first = !bs.explored;
          bs.explored = true;
          if (first) st.stats.looted += 0;
          rescue(st, rt, id);
          if (o.t === 'scout') {
            exitBuilding(st, rt, sq.id, false);
            if (first) toast(rt, `${bd.name} scouted.`, 'info');
            sq.order = { t: 'idle' };
            continue;
          }
          if (o.t === 'scavenge') {
            o.total = scavengeTime(st, id, members);
            continue;
          }
          if (o.t === 'claim') {
            o.total = 3;
            continue;
          }
        }
        if (o.t === 'scavenge') {
          collectLoot(st, rt, id, 1, members);
          exitBuilding(st, rt, sq.id, false);
          sq.order = { t: 'idle' };
        } else if (o.t === 'claim') {
          const why = canClaim(st, rt, id);
          if (why) toast(rt, `Can't claim ${bd.name}: ${why.toLowerCase()}.`, 'warn');
          else {
            bs.owned = true;
            bs.fort = 0;
            bs.breached = false;
            bs.hp = maxHpOf(rt.map, st.b, id);
            rt.flowDirty = true;
            rt.postsDirty = true;
            toast(rt, `${bd.name} is now part of your haven (+${bd.capacity} beds).`, 'good');
            sfx(rt, 'build', bd.door.x, bd.door.y);
            if (bs.loot.food + bs.loot.mat + bs.loot.ammo + bs.loot.med + bs.loot.guns > 0) collectLoot(st, rt, id, 1, members);
          }
          exitBuilding(st, rt, sq.id, false);
          sq.order = { t: 'idle' };
        } else {
          exitBuilding(st, rt, sq.id, false);
          sq.order = { t: 'idle' };
        }
      }
    }
  }
}

function scavengeTime(st: GameState, id: number, members: Survivor[]): number {
  const l = st.b[id].loot;
  const units = l.food + l.mat + l.ammo + l.med + (l.fuel || 0) + l.guns * 5;
  return (2 + (units * 0.6) / Math.max(1, members.length)) * (hasRole(members, 'scavenger') ? 0.65 : 1);
}

function enterBuilding(st: GameState, rt: Runtime, squad: number, members: Survivor[]): void {
  const sq = st.squads[squad];
  const o = sq.order;
  const id = o.b!;
  const bd = rt.map.buildings[id];
  const bs = st.b[id];
  o.phase = 'inside';
  o.timer = 0;
  if (!bs.explored || (o.t === 'scout' && bs.survivors > 0)) o.total = (2.5 + (bd.w * bd.h) / 2500) * (hasRole(members, 'scout') ? 0.6 : 1);
  else if (o.t === 'scavenge') o.total = scavengeTime(st, id, members);
  else if (o.t === 'claim') o.total = 3;
  else o.total = 1;
  members.forEach((m) => {
    m.inside = id;
    m.path = null;
  });
  sfx(rt, 'door', bd.door.x, bd.door.y);
}

// ---- player actions --------------------------------------------------------------

export function fortify(st: GameState, rt: Runtime, id: number): boolean {
  const bs = st.b[id];
  if (!bs.owned || bs.fort >= 3) return false;
  const cost = fortCost(st, bs.fort);
  if (st.res.mat < cost) {
    toast(rt, `Need ${cost} materials to fortify.`, 'warn');
    return false;
  }
  st.res.mat -= cost;
  const before = maxHpOf(rt.map, st.b, id);
  bs.fort++;
  bs.hp += maxHpOf(rt.map, st.b, id) - before;
  const d = rt.map.buildings[id];
  toast(rt, `${d.name} barricaded (level ${bs.fort}).`, 'good');
  sfx(rt, 'build', d.door.x, d.door.y);
  for (let i = 0; i < 16; i++) spark(rt, d.x + rt.rng.next() * d.w, d.y + rt.rng.next() * d.h, '#ffcc80');
  return true;
}

export function canBuildWall(st: GameState, rt: Runtime, x1: number, y1: number, x2: number, y2: number): string | null {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 14) return 'Drag the wall out a little further';
  if (len > WALL_MAX + 0.5) return 'That wall is too long';
  const cost = structCost(st, 'wall', len);
  if (st.res.mat < cost) return `Need ${cost} materials`;
  if (distToBase(st, rt, x1, y1) > BUILD_RANGE || distToBase(st, rt, x2, y2) > BUILD_RANGE) return 'Too far from your haven';
  for (let t = 0; t <= len; t += 4) {
    const x = x1 + ((x2 - x1) * t) / len;
    const y = y1 + ((y2 - y1) * t) / len;
    if (rt.nav.isBlocked(x, y)) return 'Something is in the way';
  }
  return null;
}

export function canBuildAt(st: GameState, rt: Runtime, kind: StructKind, x: number, y: number): string | null {
  const r = STRUCTS[kind].r;
  if (st.res.mat < structCost(st, kind)) return `Need ${structCost(st, kind)} materials`;
  if (distToBase(st, rt, x, y) > BUILD_RANGE) return 'Too far from your haven';
  for (let dx = -r; dx <= r; dx += CELL / 2)
    for (let dy = -r; dy <= r; dy += CELL / 2) if (rt.nav.isBlocked(x + dx, y + dy)) return 'Something is in the way';
  for (const s of st.structures) if (s.kind !== 'wall' && dist(s.x, s.y, x, y) < STRUCTS[s.kind].r + r + 3) return 'Too close to another structure';
  return null;
}

/** Places a construction site; haven guards then build it. Materials are paid up front. */
export function build(st: GameState, rt: Runtime, kind: StructKind, x: number, y: number, x2?: number, y2?: number): boolean {
  const wall = kind === 'wall' && x2 !== undefined && y2 !== undefined;
  const why = wall ? canBuildWall(st, rt, x, y, x2!, y2!) : canBuildAt(st, rt, kind, x, y);
  if (why) {
    toast(rt, why, 'warn');
    return false;
  }
  const cost = wall ? structCost(st, 'wall', Math.hypot(x2! - x, y2! - y)) : structCost(st, kind);
  st.res.mat -= cost;
  const s: Structure = { id: st.nextId++, kind, x, y, hp: STRUCTS[kind].hp * 0.25, cd: 0, t: 0, built: 0, cost };
  if (wall) {
    s.x2 = x2;
    s.y2 = y2;
  }
  st.structures.push(s);
  const guards = st.survivors.some((g) => g.squad === -1 && !g.joining);
  toast(rt, guards ? `${STRUCTS[kind].name} site marked. Haven guards will build it.` : `${STRUCTS[kind].name} site marked, but no one is at the haven to build it.`, guards ? 'info' : 'warn');
  sfx(rt, 'door', x, y);
  return true;
}

const SOLID = new Set<StructKind>(['tower', 'workshop', 'infirmary']);

function completeStructure(st: GameState, rt: Runtime, s: Structure): void {
  s.built = 1;
  s.hp = STRUCTS[s.kind].hp;
  st.stats.built++;
  if (SOLID.has(s.kind)) {
    const r = STRUCTS[s.kind].r - 2;
    for (let dx = -r; dx <= r; dx += CELL / 2) for (let dy = -r; dy <= r; dy += CELL / 2) rt.nav.blocked[rt.nav.idx(s.x + dx, s.y + dy)] = 1;
  }
  if (s.kind === 'wall') rt.wallsDirty = true;
  rt.flowDirty = true;
  for (const g of st.survivors) if (g.job === s.id) g.job = -1;
  const cx = s.kind === 'wall' ? (s.x + s.x2!) / 2 : s.x;
  const cy = s.kind === 'wall' ? (s.y + s.y2!) / 2 : s.y;
  toast(rt, `${STRUCTS[s.kind].name} finished.`, 'good');
  sfx(rt, 'build', cx, cy);
  for (let i = 0; i < 14; i++) spark(rt, cx + rt.rng.range(-10, 10), cy + rt.rng.range(-10, 10), '#ffcc80');
}

/** Player tears down one of their own structures for a partial refund. */
export function dismantle(st: GameState, rt: Runtime, id: number): void {
  const s = st.structures.find((q) => q.id === id);
  if (!s) return;
  const refund = s.built < 1 ? s.cost : Math.floor(s.cost * 0.4 * (s.hp / STRUCTS[s.kind].hp));
  st.res.mat += refund;
  removeStructure(st, rt, id);
  toast(rt, `${STRUCTS[s.kind].name} ${s.built < 1 ? 'cancelled' : 'taken down'}${refund ? ` (+${refund} materials)` : ''}.`, 'info');
  sfx(rt, 'build', s.x, s.y);
}

export function refundOf(s: Structure): number {
  return s.built < 1 ? s.cost : Math.floor(s.cost * 0.4 * (s.hp / STRUCTS[s.kind].hp));
}

// ---- demolition ------------------------------------------------------------------

/** Spots around a building's walls where the crew works. */
function perimeterSpots(rt: Runtime, r: { x: number; y: number; w: number; h: number }, n: number, seed: number): Vec[] {
  const per = 2 * (r.w + r.h);
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    let t = ((i + 0.5) / n + (seed % 7) * 0.031) * per;
    t %= per;
    let x: number;
    let y: number;
    const o = 7;
    if (t < r.w) {
      x = r.x + t;
      y = r.y + r.h + o;
    } else if (t < r.w + r.h) {
      x = r.x + r.w + o;
      y = r.y + r.h - (t - r.w);
    } else if (t < 2 * r.w + r.h) {
      x = r.x + r.w - (t - r.w - r.h);
      y = r.y - o;
    } else {
      x = r.x - o;
      y = r.y + (t - 2 * r.w - r.h);
    }
    out.push(rt.nav.nearestFree(x, y, 4));
  }
  return out;
}

function startDemolition(st: GameState, rt: Runtime, squad: number, members: Survivor[]): void {
  const o = st.squads[squad].order;
  const id = o.b!;
  const bs = st.b[id];
  const d = rt.map.buildings[id];
  if (canDemolish(st, rt, id)) {
    st.squads[squad].order = { t: 'idle' };
    return;
  }
  if (!bs.explored) {
    bs.explored = true;
    toast(rt, `${d.name} checked. The crew starts tearing it down.`, 'info');
  }
  rescue(st, rt, id);
  o.phase = 'work';
  o.timer = 0;
  bs.demo ??= 0;
  const spots = perimeterSpots(rt, d, members.length, squad * 3 + id);
  members.forEach((m, i) => {
    m.goal = spots[i];
    m.path = rt.nav.findPath(m.x, m.y, spots[i].x, spots[i].y);
  });
  sfx(rt, 'build', d.door.x, d.door.y);
}

function workDemolition(st: GameState, rt: Runtime, squad: number, members: Survivor[], dt: number): void {
  const o = st.squads[squad].order;
  const id = o.b!;
  const bs = st.b[id];
  const d = rt.map.buildings[id];
  if (bs.demolished) {
    st.squads[squad].order = { t: 'idle' };
    return;
  }
  const info = demolishInfo(rt, id);
  let crew = 0;
  for (const m of members) {
    if (m.eng || m.inside >= 0) continue;
    if (m.goal && dist(m.x, m.y, m.goal.x, m.goal.y) < 8 && !m.path) {
      crew += m.role === 'engineer' ? 1.6 : 1;
      m.working = true;
      m.facing = Math.atan2(d.y + d.h / 2 - m.y, d.x + d.w / 2 - m.x);
    }
  }
  if (crew <= 0) return;
  bs.demo = Math.min(1, (bs.demo ?? 0) + (crew * dt) / info.work);
  o.timer = (o.timer ?? 0) + dt;
  if (o.timer > 2.4) {
    o.timer = 0;
    noise(rt, d.x + d.w / 2, d.y + d.h / 2, 210 * weatherOf(st).noise);
    sfx(rt, 'build', d.x + d.w / 2, d.y + d.h / 2);
  }
  if (rt.rng.chance(dt * 6)) {
    rt.particles.push({ x: d.x + rt.rng.next() * d.w, y: d.y + rt.rng.next() * d.h, vx: rt.rng.range(-8, 8), vy: rt.rng.range(-12, -2), t: 0, life: rt.rng.range(0.8, 1.6), c: '#8f877a', s: rt.rng.range(1.5, 3.5) });
  }
  if (bs.demo >= 1) finishDemolition(st, rt, id);
}

function finishDemolition(st: GameState, rt: Runtime, id: number): void {
  const bs = st.b[id];
  const d = rt.map.buildings[id];
  const info = demolishInfo(rt, id);
  const crew = st.squads.filter((q) => q.order.b === id).flatMap((q) => squadMembers(st, q.id));
  // anyone still inside comes out first
  for (const q of st.squads) if (q.order.b === id && q.order.phase === 'inside') exitBuilding(st, rt, q.id, true);
  if ((bs.loot.food || 0) + bs.loot.mat + bs.loot.ammo + bs.loot.med + bs.loot.guns + (bs.loot.fuel || 0) > 0) collectLoot(st, rt, id, 1, crew);
  const bonus = crew.some((m) => m.role === 'engineer') ? Math.round(info.mat * 0.15) : 0;
  st.res.mat += info.mat + bonus;
  const wasOwned = bs.owned;
  bs.demolished = true;
  bs.owned = false;
  bs.fort = 0;
  bs.demo = 1;
  bs.survivors = 0;
  bs.infected = 0;
  rt.nav.clearRect(d);
  rt.flowDirty = true;
  if (wasOwned) rt.postsDirty = true;
  for (const q of st.squads) if (q.order.b === id) q.order = { t: 'idle' };
  for (const m of crew) m.path = null;
  rt.events.push({ k: 'world', building: id });
  toast(rt, `${d.name} torn down: +${info.mat + bonus} materials${wasOwned ? ` (-${d.capacity} beds)` : ''}.`, 'good');
  sfx(rt, 'crash', d.x + d.w / 2, d.y + d.h / 2);
  for (let i = 0; i < 40; i++)
    rt.particles.push({ x: d.x + rt.rng.next() * d.w, y: d.y + rt.rng.next() * d.h, vx: rt.rng.range(-25, 25), vy: rt.rng.range(-25, 10), t: 0, life: rt.rng.range(1, 2.4), c: rt.rng.chance(0.5) ? '#9a9286' : '#6d665c', s: rt.rng.range(2, 5) });
  noise(rt, d.x + d.w / 2, d.y + d.h / 2, 320);
}

// ---- salvage -----------------------------------------------------------------------

function updateSalvage(st: GameState, rt: Runtime, squad: number, members: Survivor[], dt: number): void {
  const o = st.squads[squad].order;
  _st = st;
  const v = o.v !== undefined ? st.vehicles.find((q) => q.id === o.v) : undefined;
  const p = o.p !== undefined ? rt.map.props[o.p] : undefined;
  const gone = (o.p !== undefined && st.salvaged.includes(o.p)) || (o.v !== undefined && (!v || v.squad >= 0));
  if ((!v && !p) || gone) {
    st.squads[squad].order = { t: 'idle' };
    return;
  }
  const tx = v ? v.x : p!.x;
  const ty = v ? v.y : p!.y;
  const info = v ? vehicleSalvageInfo(v) : salvageInfo(rt, o.p!)!;
  if (o.phase === 'go') {
    const near = members.some((m) => dist(m.x, m.y, tx, ty) < 24);
    if (!near) {
      if (members.every((m) => !m.path)) {
        toast(rt, "Squad can't reach it.", 'warn');
        st.squads[squad].order = { t: 'idle' };
      }
      return;
    }
    o.phase = 'work';
    o.timer = 0;
    o.total = info.work;
    members.forEach((m, i) => {
      const a = (i / Math.max(1, members.length)) * Math.PI * 2 + 0.6;
      const g = rt.nav.nearestFree(tx + Math.cos(a) * 13, ty + Math.sin(a) * 10, 3);
      m.goal = g;
      m.path = rt.nav.findPath(m.x, m.y, g.x, g.y);
    });
    return;
  }
  let crew = 0;
  for (const m of members) {
    if (m.eng || m.inside >= 0) continue;
    if (dist(m.x, m.y, tx, ty) < 22 && !m.path) {
      crew += m.role === 'engineer' ? 1.6 : 1;
      m.working = true;
      m.facing = Math.atan2(ty - m.y, tx - m.x);
    }
  }
  o.timer = (o.timer ?? 0) + crew * dt;
  if (crew > 0 && rt.rng.chance(dt * 3)) spark(rt, tx + rt.rng.range(-6, 6), ty + rt.rng.range(-4, 4), '#ffd28a');
  if (crew > 0 && rt.rng.chance(dt * 0.6)) sfx(rt, 'melee', tx, ty);
  if ((o.timer ?? 0) < (o.total ?? 1)) return;
  st.res.mat += info.mat;
  st.res.fuel += info.fuel;
  if (v) {
    st.vehicles = st.vehicles.filter((q) => q.id !== v.id);
    for (const q of st.squads) if (q.vehicle === v.id) q.vehicle = -1;
  } else {
    st.salvaged.push(o.p!);
    rt.nav.clearProp(p!);
    rt.events.push({ k: 'world', prop: o.p });
  }
  toast(rt, `Scrapped for parts: +${info.mat} materials${info.fuel ? `, +${info.fuel} fuel` : ''}.`, 'good');
  sfx(rt, 'loot', tx, ty);
  for (const m of members) m.path = null;
  st.squads[squad].order = { t: 'idle' };
}

// ---- walls & construction crews ----------------------------------------------------

function rebuildWalls(st: GameState, rt: Runtime): void {
  rt.wallAt.fill(-1);
  for (const s of st.structures) {
    if (s.kind !== 'wall' || s.built < 1) continue;
    const len = Math.hypot(s.x2! - s.x, s.y2! - s.y) || 1;
    const nx = -(s.y2! - s.y) / len;
    const ny = (s.x2! - s.x) / len;
    for (let t = 0; t <= len; t += 3)
      for (const o of [-3, 0, 3]) {
        const x = s.x + ((s.x2! - s.x) * t) / len + nx * o;
        const y = s.y + ((s.y2! - s.y) * t) / len + ny * o;
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        if (rt.nav.inBounds(cx, cy)) rt.wallAt[cy * rt.nav.w + cx] = s.id;
      }
  }
  rt.wallsDirty = false;
  rt.flowDirty = true;
}

/** Where a builder stands for a given site. */
function siteSpot(rt: Runtime, s: Structure, k: number): Vec {
  if (s.kind === 'wall') {
    const t = (k % 4 + 0.5) / 4;
    const len = Math.hypot(s.x2! - s.x, s.y2! - s.y) || 1;
    const side = k % 2 ? 1 : -1;
    return rt.nav.nearestFree(s.x + (s.x2! - s.x) * t + (-(s.y2! - s.y) / len) * 8 * side, s.y + (s.y2! - s.y) * t + ((s.x2! - s.x) / len) * 8 * side, 3);
  }
  const a = (k / 4) * Math.PI * 2 + 0.4;
  const r = STRUCTS[s.kind].r + 7;
  return rt.nav.nearestFree(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, 3);
}

function pickSite(st: GameState, rt: Runtime, g: Survivor): Structure | null {
  let best: Structure | null = null;
  let bd = Infinity;
  for (const s of st.structures) {
    if (s.built >= 1) continue;
    const crew = st.survivors.filter((q) => q.job === s.id && q !== g).length;
    if (crew >= 4) continue;
    if (nearestZombie(rt, s.x, s.y, 90, false)) continue;
    const d = dist(g.x, g.y, s.x, s.y);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** Haven guards build construction sites when it's safe. Returns true if busy building. */
function guardBuild(st: GameState, rt: Runtime, g: Survivor, dt: number): boolean {
  const site = pickSite(st, rt, g);
  if (!site) {
    g.job = -1;
    return false;
  }
  const k = st.survivors.filter((q) => q.job === site.id && q.id < g.id).length;
  const spot = siteSpot(rt, site, k);
  if (g.job !== site.id || !g.goal || dist(g.goal.x, g.goal.y, spot.x, spot.y) > 2) {
    g.job = site.id;
    g.goal = spot;
    g.path = rt.nav.findPath(g.x, g.y, spot.x, spot.y);
  }
  if (g.path) {
    moveAlong(rt, g, 38 * (g.role === 'scout' ? 1.3 : 1), dt);
    return true;
  }
  if (dist(g.x, g.y, spot.x, spot.y) > 10) {
    g.job = -1;
    return false;
  }
  g.working = true;
  const cx = site.kind === 'wall' ? (site.x + site.x2!) / 2 : site.x;
  const cy = site.kind === 'wall' ? (site.y + site.y2!) / 2 : site.y;
  g.facing = Math.atan2(cy - g.y, cx - g.x);
  site.built = Math.min(1, site.built + (dt * (g.role === 'engineer' ? 1.6 : 1)) / workFor(site));
  site.hp = Math.max(site.hp, STRUCTS[site.kind].hp * (0.25 + 0.75 * site.built));
  if (rt.rng.chance(dt * 0.7)) sfx(rt, 'melee', cx, cy);
  if (site.built >= 1) completeStructure(st, rt, site);
  return true;
}

function attackWall(st: GameState, rt: Runtime, z: Zombie, wallId: number): void {
  if (z.cd > 0) return;
  const s = st.structures.find((q) => q.id === wallId);
  if (!s) {
    rt.wallsDirty = true;
    return;
  }
  const K = ZKINDS[z.kind];
  s.hp -= K.dmg * 0.6;
  z.cd = K.cd;
  spark(rt, z.x, z.y, '#a07a50');
  if (s.hp <= 0) {
    toast(rt, 'A palisade wall was torn down!', 'bad');
    removeStructure(st, rt, s.id);
  }
}

/** Moves one survivor between the haven guard pool and a squad. */
export function transfer(st: GameState, rt: Runtime, squad: number, delta: 1 | -1): boolean {
  if (delta > 0) {
    const members = squadMembers(st, squad);
    if (members.length >= 4) {
      toast(rt, 'A squad can have at most 4 members.', 'warn');
      return false;
    }
    if (members.some((m) => m.inside >= 0)) {
      toast(rt, 'Wait until the squad is outside and on foot.', 'warn');
      return false;
    }
    const guards = st.survivors.filter((s) => s.squad === -1 && !s.joining).sort((a, b) => b.gun - a.gun || b.hp - a.hp);
    if (!guards.length) {
      toast(rt, 'No one at the haven to assign.', 'warn');
      return false;
    }
    const g = guards[0];
    g.squad = squad;
    g.post = null;
    const lead = members[0];
    if (lead) {
      g.goal = rt.nav.nearestFree(lead.x + 8, lead.y + 8, 4);
      g.path = rt.nav.findPath(g.x, g.y, g.goal.x, g.goal.y);
    } else {
      g.path = null;
      st.squads[squad].order = { t: 'idle' };
    }
  } else {
    const members = squadMembers(st, squad);
    if (!members.length) return false;
    if (members.some((m) => m.inside >= 0)) {
      toast(rt, 'Wait until the squad is outside and on foot.', 'warn');
      return false;
    }
    const m = members[members.length - 1];
    m.squad = -1;
    m.post = null;
  }
  rt.postsDirty = true;
  return true;
}

/** Moves one specific survivor into a squad (or home to the haven with squad = -1). */
export function assignSurvivor(st: GameState, rt: Runtime, id: number, squad: number): boolean {
  const s = st.survivors.find((x) => x.id === id);
  if (!s || s.joining) return false;
  if (squad >= 0) {
    const members = squadMembers(st, squad);
    if (members.length >= 4) {
      toast(rt, 'A squad can have at most 4 members.', 'warn');
      return false;
    }
    if (members.some((m) => m.inside >= 0) || s.inside >= 0) {
      toast(rt, 'Wait until the squad is outside and on foot.', 'warn');
      return false;
    }
    s.squad = squad;
    s.post = null;
    const lead = members[0];
    if (lead) {
      s.goal = rt.nav.nearestFree(lead.x + 8, lead.y + 8, 4);
      s.path = rt.nav.findPath(s.x, s.y, s.goal.x, s.goal.y);
    } else {
      s.path = null;
      st.squads[squad].order = { t: 'idle' };
    }
  } else {
    if (s.inside >= 0) {
      toast(rt, 'Wait until the squad is outside and on foot.', 'warn');
      return false;
    }
    s.squad = -1;
    s.post = null;
  }
  rt.postsDirty = true;
  return true;
}

// ---- combat & effects -------------------------------------------------------------

function spark(rt: Runtime, x: number, y: number, c: string): void {
  rt.particles.push({ x, y, vx: rt.rng.range(-30, 30), vy: rt.rng.range(-40, 10), t: 0, life: rt.rng.range(0.3, 0.7), c, s: rt.rng.range(0.8, 1.6) });
}

function blood(rt: Runtime, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) rt.particles.push({ x, y, vx: rt.rng.range(-35, 35), vy: rt.rng.range(-35, 35), t: 0, life: rt.rng.range(0.2, 0.45), c: '#5a1414', s: rt.rng.range(0.8, 1.8) });
}

function forZombiesNear(rt: Runtime, x: number, y: number, r: number, fn: (z: Zombie) => void): void {
  const x0 = Math.max(0, Math.floor((x - r) / ZCELL));
  const y0 = Math.max(0, Math.floor((y - r) / ZCELL));
  const x1 = Math.min(rt.zcw - 1, Math.floor((x + r) / ZCELL));
  const y1 = Math.min(rt.zch - 1, Math.floor((y + r) / ZCELL));
  const r2 = r * r;
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++)
      for (const z of rt.zcells[cy * rt.zcw + cx]) {
        if (z.hp > 0 && dist2(z.x, z.y, x, y) <= r2) fn(z);
      }
}

function nearestZombie(rt: Runtime, x: number, y: number, r: number, los: boolean): Zombie | null {
  let best: Zombie | null = null;
  let bd = Infinity;
  forZombiesNear(rt, x, y, r, (z) => {
    const d = dist2(z.x, z.y, x, y);
    if (d < bd && (!los || rt.nav.sightLine(x, y, z.x, z.y))) {
      bd = d;
      best = z;
    }
  });
  return best;
}

function noise(rt: Runtime, x: number, y: number, r: number): void {
  if (r <= 0) return;
  forZombiesNear(rt, x, y, r, (z) => {
    if (z.mode === 0 || z.mode === 3) {
      z.mode = 3;
      z.tx = x + rt.rng.range(-20, 20);
      z.ty = y + rt.rng.range(-20, 20);
    }
  });
}

function damageZombie(st: GameState, rt: Runtime, z: Zombie, dmg: number, killer: Survivor | null, bloodN = 3): void {
  if (z.hp <= 0) return;
  z.hp -= dmg;
  if (bloodN) blood(rt, z.x, z.y, bloodN);
  if (z.hp <= 0) {
    st.stats.kills++;
    if (killer) killer.kills++;
    rt.decals.push({ x: z.x, y: z.y, r: ZKINDS[z.kind].r * 1.3, a: rt.rng.range(0, 6.28), t: 0, corpse: true });
    sfx(rt, 'zdie', z.x, z.y);
  }
}

function shoot(st: GameState, rt: Runtime, sx: number, sy: number, z: Zombie, gun: number, shooter: Survivor | null, accMul = 1): void {
  const g = GUNS[gun];
  st.res.ammo--;
  const night = isNight(st.time);
  const soldier = shooter?.role === 'soldier';
  if (soldier) accMul *= 1.12;
  if (st.weather === 'rain' || st.weather === 'fog') accMul *= 0.92;
  const hit = rt.rng.chance(Math.min(0.98, g.acc * accMul * (night ? 0.88 : 1)));
  const ex = hit ? z.x : z.x + rt.rng.range(-14, 14);
  const ey = hit ? z.y : z.y + rt.rng.range(-14, 14);
  rt.tracers.push({ x1: sx, y1: sy, x2: ex, y2: ey, t: 0 });
  rt.flashes.push({ x: sx, y: sy, t: 0 });
  if (hit) damageZombie(st, rt, z, g.dmg * (soldier ? 1.25 : 1) * rt.rng.range(0.85, 1.15), shooter);
  noise(rt, sx, sy, g.noise * weatherOf(st).noise);
  sfx(rt, gun === 2 ? 'rifle' : 'pistol', sx, sy);
}

// ---- survivors ---------------------------------------------------------------------

function computePosts(st: GameState, rt: Runtime): void {
  const posts: Vec[] = [];
  const ids = ownedIds(st).sort((a, b) => (a === rt.map.hqId ? -1 : b === rt.map.hqId ? 1 : a - b));
  for (const id of ids) {
    const b = rt.map.buildings[id];
    const o = 11;
    const pts = [
      { x: b.door.x, y: b.door.y },
      { x: b.x - o, y: b.y - o },
      { x: b.x + b.w + o, y: b.y + b.h + o },
      { x: b.x + b.w + o, y: b.y - o },
      { x: b.x - o, y: b.y + b.h + o },
      { x: b.x + b.w / 2, y: b.y - o },
      { x: b.x + b.w / 2, y: b.y + b.h + o },
      { x: b.x - o, y: b.y + b.h / 2 },
      { x: b.x + b.w + o, y: b.y + b.h / 2 },
    ];
    for (const p of pts) posts.push(rt.nav.nearestFree(p.x, p.y, 3));
  }
  const guards = st.survivors.filter((s) => s.squad === -1 && !s.joining);
  guards.forEach((g, i) => {
    const p = posts[i % Math.max(1, posts.length)];
    const ring = Math.floor(i / Math.max(1, posts.length));
    g.post = p ? rt.nav.nearestFree(p.x + ring * 7, p.y + ring * 5, 3) : null;
    g.path = null;
  });
  rt.postsDirty = false;
}

function moveAlong(rt: Runtime, s: Survivor, speed: number, dt: number): void {
  if (!s.path || !s.path.length) return;
  const t = s.path[0];
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const d = Math.hypot(dx, dy);
  const step = speed * dt;
  if (d <= step + 0.5) {
    s.x = t.x;
    s.y = t.y;
    s.path.shift();
    if (!s.path.length) s.path = null;
  } else {
    const nx = s.x + (dx / d) * step;
    const ny = s.y + (dy / d) * step;
    if (!rt.nav.isBlocked(nx, ny) || rt.nav.isBlocked(s.x, s.y)) {
      s.x = nx;
      s.y = ny;
    } else {
      // something blocked us (new structure etc) -> repath
      s.repath += dt;
      if (s.repath > 0.5 && s.goal) {
        s.path = rt.nav.findPath(s.x, s.y, s.goal.x, s.goal.y);
        s.repath = 0;
      }
    }
    s.facing = Math.atan2(dy, dx);
  }
  s.anim += dt * speed * 0.25;
}

function updateSurvivors(st: GameState, rt: Runtime, dt: number): void {
  for (const s of st.survivors) s.eng = false;
  if (rt.postsDirty) computePosts(st, rt);
  const h = hq(rt);
  for (const s of st.survivors) {
    if (s.inside >= 0 || s.hp <= 0) continue;
    s.cd -= dt;
    // --- combat ---
    const g = st.res.ammo > 0 ? s.gun : 0;
    const range = GUNS[g].range;
    let engaged = false;
    const target = nearestZombie(rt, s.x, s.y, Math.max(range, 16), g > 0);
    if (target) {
      const d = dist(s.x, s.y, target.x, target.y);
      const reach = GUNS[0].range + ZKINDS[target.kind].r;
      if (g > 0 && d <= range && (d > reach || target.kind === 2)) {
        engaged = true;
        s.facing = Math.atan2(target.y - s.y, target.x - s.x);
        if (s.cd <= 0) {
          shoot(st, rt, s.x + Math.cos(s.facing) * 5, s.y + Math.sin(s.facing) * 5, target, g, s);
          s.cd = GUNS[g].cd * rt.rng.range(0.9, 1.15);
        }
      } else if (d <= reach) {
        engaged = true;
        s.facing = Math.atan2(target.y - s.y, target.x - s.x);
        if (s.cd <= 0) {
          damageZombie(st, rt, target, GUNS[0].dmg * (s.role === 'soldier' ? 1.25 : 1) * rt.rng.range(0.8, 1.2), s);
          s.cd = GUNS[0].cd;
          sfx(rt, 'melee', s.x, s.y);
        }
      }
    }
    // --- movement ---
    if (s.joining) {
      moveAlong(rt, s, 34, dt);
      if (dist(s.x, s.y, h.door.x, h.door.y) < 16 || !s.path) {
        s.joining = false;
        s.squad = -1;
        rt.postsDirty = true;
      }
      continue;
    }
    s.eng = engaged;
    if (engaged && s.squad >= 0) continue; // squads stop to shoot
    if (s.squad === -1) {
      if (engaged) continue;
      if (guardBuild(st, rt, s, dt)) continue;
      if (s.post && !s.path && dist(s.x, s.y, s.post.x, s.post.y) > 5) {
        s.goal = s.post;
        s.path = rt.nav.findPath(s.x, s.y, s.post.x, s.post.y);
        if (!s.path) s.post = null;
      }
      moveAlong(rt, s, 34 * (s.role === 'scout' ? 1.3 : 1), dt);
      if (!s.path && s.post) s.facing = Math.atan2(s.y - (h.y + h.h / 2), s.x - (h.x + h.w / 2));
    } else {
      moveAlong(rt, s, 44 * (s.role === 'scout' ? 1.3 : 1), dt);
    }
  }
  // light separation so units don't stack
  const arr = st.survivors;
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.inside >= 0) continue;
    for (let j = i + 1; j < arr.length; j++) {
      const b = arr[j];
      if (b.inside >= 0) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.01 && d2 < 64) {
        const d = Math.sqrt(d2);
        const push = (8 - d) * 0.25;
        const nx = (dx / d) * push;
        const ny = (dy / d) * push;
        if (!rt.nav.isBlocked(a.x - nx, a.y - ny)) {
          a.x -= nx;
          a.y -= ny;
        }
        if (!rt.nav.isBlocked(b.x + nx, b.y + ny)) {
          b.x += nx;
          b.y += ny;
        }
      }
    }
  }
  // deaths
  for (const s of st.survivors) {
    if (s.hp > 0) continue;
    st.stats.lost++;
    rt.decals.push({ x: s.x, y: s.y, r: 6, a: rt.rng.range(0, 6.28), t: 0, corpse: false });
    toast(rt, `${s.name} was killed.`, 'bad');
    sfx(rt, 'sdie', s.x, s.y);
    rt.postsDirty = true;
  }
  const before = st.survivors.length;
  st.survivors = st.survivors.filter((s) => s.hp > 0);
  if (before !== st.survivors.length) rt.survById.clear();
}

// ---- zombies -------------------------------------------------------------------------

function rebuildZGrid(st: GameState, rt: Runtime): void {
  for (const c of rt.zcells) c.length = 0;
  for (const z of st.zombies) {
    const cx = clamp(Math.floor(z.x / ZCELL), 0, rt.zcw - 1);
    const cy = clamp(Math.floor(z.y / ZCELL), 0, rt.zch - 1);
    rt.zcells[cy * rt.zcw + cx].push(z);
  }
}

function rebuildFlow(st: GameState, rt: Runtime): void {
  const targets: number[] = [];
  st.b.forEach((b, i) => {
    if (b.owned) targets.push(...rt.nav.ringCells(rt.map.buildings[i], 8));
  });
  for (const s of st.structures) {
    if (s.kind === 'barrel' || s.kind === 'garden' || s.kind === 'wall' || s.kind === 'trap' || s.built < 1) continue;
    const r = STRUCTS[s.kind].r + 6;
    targets.push(...rt.nav.ringCells({ x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 }, 0));
  }
  rt.flow = rt.nav.flowField(targets, rt.wallAt);
  rt.flowDirty = false;
}

/** Moves an infected toward a point. Returns the id of a wall blocking the way, or -1. */
function zMove(rt: Runtime, z: Zombie, tx: number, ty: number, speed: number, dt: number): number {
  const dx = tx - z.x;
  const dy = ty - z.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.5) return -1;
  const vx = (dx / d) * speed;
  const vy = (dy / d) * speed;
  z.vx += (vx - z.vx) * Math.min(1, dt * 6);
  z.vy += (vy - z.vy) * Math.min(1, dt * 6);
  const nx = z.x + z.vx * dt;
  const ny = z.y + z.vy * dt;
  const wi = rt.wallAt[rt.nav.idx(nx, ny)] ?? -1;
  if (wi >= 0 && rt.wallAt[rt.nav.idx(z.x, z.y)] !== wi) {
    z.vx *= 0.2;
    z.vy *= 0.2;
    z.facing = Math.atan2(dy, dx);
    return wi;
  }
  if (!rt.nav.isBlocked(nx, ny)) {
    z.x = nx;
    z.y = ny;
  } else if (!rt.nav.isBlocked(nx, z.y)) z.x = nx;
  else if (!rt.nav.isBlocked(z.x, ny)) z.y = ny;
  else {
    z.vx = -z.vx * 0.5;
    z.vy = -z.vy * 0.5;
  }
  z.facing = Math.atan2(z.vy, z.vx);
  z.anim += dt * speed * 0.22;
  return -1;
}

function flowStep(rt: Runtime, z: Zombie): Vec | null {
  const f = rt.flow;
  if (!f) return null;
  const W = rt.nav.w;
  const cx = Math.floor(z.x / CELL);
  const cy = Math.floor(z.y / CELL);
  let best = f[cy * W + cx];
  let bx = -1;
  let by = -1;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= rt.nav.h) continue;
      const v = f[ny * W + nx];
      if (v < best) {
        best = v;
        bx = nx;
        by = ny;
      }
    }
  if (bx < 0) return null;
  return { x: bx * CELL + CELL / 2, y: by * CELL + CELL / 2 };
}

function updateZombies(st: GameState, rt: Runtime, dt: number): void {
  const night = isNight(st.time);
  const perception = (night ? 125 : 85) * weatherOf(st).perception;
  const think = rt.thinkTimer <= 0;
  for (const z of st.zombies) {
    if (z.hp <= 0) continue;
    const K = ZKINDS[z.kind];
    z.cd -= dt;
    z.think -= dt;
    // --- perception ---
    if (z.think <= 0) {
      z.think = 0.35 + rt.rng.next() * 0.3;
      let best: Survivor | null = null;
      let bd = (z.kind === 2 ? perception * 0.8 : perception) ** 2;
      for (const s of st.survivors) {
        if (s.inside >= 0) continue;
        const d = dist2(s.x, s.y, z.x, z.y);
        if (d < bd && rt.nav.sightLine(z.x, z.y, s.x, s.y)) {
          bd = d;
          best = s;
        }
      }
      if (best) {
        if (z.mode !== 1 && rt.rng.chance(0.15)) sfx(rt, 'groan', z.x, z.y);
        z.mode = 1;
        z.target = best.id;
      } else if (z.mode === 1) {
        const t = st.survivors.find((s) => s.id === z.target);
        if (!t || t.inside >= 0 || dist(t.x, t.y, z.x, z.y) > 280) {
          z.mode = night ? 2 : 0;
          z.target = -1;
        }
      }
      if (z.mode === 0 && (rt.rng.chance(0.25) || dist(z.x, z.y, z.tx, z.ty) < 4)) {
        const nx = z.x + rt.rng.range(-70, 70);
        const ny = z.y + rt.rng.range(-70, 70);
        if (!rt.nav.isBlocked(nx, ny)) {
          z.tx = nx;
          z.ty = ny;
        }
      }
      if (z.mode === 3 && dist(z.x, z.y, z.tx, z.ty) < 10) z.mode = night ? 2 : 0;
    }
    // --- act ---
    const speed = K.speed * (night ? 1.2 : 1);
    if (z.mode === 1) {
      const t = st.survivors.find((s) => s.id === z.target);
      if (!t) {
        z.mode = 0;
        continue;
      }
      const d = dist(z.x, z.y, t.x, t.y);
      if (d < K.r + 6) {
        if (z.cd <= 0) {
          t.hp -= K.dmg * rt.rng.range(0.8, 1.2);
          z.cd = K.cd;
          blood(rt, t.x, t.y, 2);
          sfx(rt, 'hit', t.x, t.y);
        }
      } else {
        // Direct chase when there's a clear line, otherwise follow the flow toward the haven
        // as a fallback, or slide along walls.
        const w = zMove(rt, z, t.x, t.y, speed, dt);
        if (w >= 0) attackWall(st, rt, z, w);
      }
    } else if (z.mode === 2) {
      const step = flowStep(rt, z);
      if (step) {
        const w = zMove(rt, z, step.x, step.y, speed * 0.9, dt);
        if (w >= 0) attackWall(st, rt, z, w);
      } else if (think) attackBase(st, rt, z);
      if (rt.flow && rt.flow[rt.nav.idx(z.x, z.y)] <= 1.5) attackBase(st, rt, z);
    } else if (z.mode === 3) {
      const w = zMove(rt, z, z.tx, z.ty, speed * 0.85, dt);
      if (w >= 0) attackWall(st, rt, z, w);
    } else if (zMove(rt, z, z.tx, z.ty, K.wander, dt) >= 0) {
      // wanderers just turn away from walls
      z.tx = z.x - (z.tx - z.x);
      z.ty = z.y - (z.ty - z.y);
    }
  }
  // separation
  for (const z of st.zombies) {
    if (z.hp <= 0) continue;
    forZombiesNear(rt, z.x, z.y, 10, (o) => {
      if (o === z) return;
      const dx = o.x - z.x;
      const dy = o.y - z.y;
      const d2 = dx * dx + dy * dy;
      const min = ZKINDS[z.kind].r + ZKINDS[o.kind].r;
      if (d2 > 0.01 && d2 < min * min) {
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.3;
        const nx = z.x - (dx / d) * push;
        const ny = z.y - (dy / d) * push;
        const wNew = rt.wallAt[rt.nav.idx(nx, ny)] ?? -1;
        if (!rt.nav.isBlocked(nx, ny) && (wNew < 0 || wNew === rt.wallAt[rt.nav.idx(z.x, z.y)])) {
          z.x = nx;
          z.y = ny;
        }
      }
    });
  }
  st.zombies = st.zombies.filter((z) => z.hp > 0);
}

function attackBase(st: GameState, rt: Runtime, z: Zombie): void {
  if (z.cd > 0) return;
  const K = ZKINDS[z.kind];
  // structures first
  for (const s of st.structures) {
    if (s.kind === 'barrel' || s.kind === 'garden' || s.kind === 'wall' || s.kind === 'trap') continue;
    if (dist(s.x, s.y, z.x, z.y) < STRUCTS[s.kind].r + 9) {
      s.hp -= K.dmg * 0.5;
      z.cd = K.cd;
      spark(rt, s.x, s.y, '#c8a070');
      if (s.hp <= 0) {
        toast(rt, `${STRUCTS[s.kind].name} destroyed!`, 'bad');
        removeStructure(st, rt, s.id);
      }
      return;
    }
  }
  for (let i = 0; i < st.b.length; i++) {
    const bs = st.b[i];
    if (!bs.owned) continue;
    const d = rt.map.buildings[i];
    if (distToRect(d, z.x, z.y) > 12) continue;
    const dmg = K.dmg * 0.35 * (1 - 0.14 * bs.fort);
    bs.hp -= dmg;
    z.cd = K.cd;
    spark(rt, z.x, z.y, '#b08a60');
    if (rt.attackAlert <= 0) {
      rt.attackAlert = 20;
      toast(rt, `${d.name} is under attack!`, 'bad');
      sfx(rt, 'alarm', d.x, d.y);
    }
    if (bs.hp <= 0) breach(st, rt, i);
    return;
  }
}

function removeStructure(st: GameState, rt: Runtime, id: number): void {
  const s = st.structures.find((q) => q.id === id);
  if (!s) return;
  st.structures = st.structures.filter((q) => q.id !== id);
  for (const g of st.survivors) if (g.job === id) g.job = -1;
  if (s.kind === 'wall') rt.wallsDirty = true;
  if (SOLID.has(s.kind) && s.built >= 1) {
    // restore walkability (rebuild from scratch is simpler than tracking)
    const r = STRUCTS[s.kind].r - 2;
    for (let dx = -r; dx <= r; dx += CELL / 2) for (let dy = -r; dy <= r; dy += CELL / 2) rt.nav.blocked[rt.nav.idx(s.x + dx, s.y + dy)] = 0;
  }
  rt.flowDirty = true;
}

function breach(st: GameState, rt: Runtime, id: number): void {
  const bs = st.b[id];
  const d = rt.map.buildings[id];
  if (id === rt.map.hqId) {
    st.over = 'lost';
    rt.events.push({ k: 'banner', title: 'The Haven Has Fallen', sub: `${d.name} was overrun on night ${st.day}.`, tone: 'bad' });
    return;
  }
  bs.owned = false;
  bs.fort = 0;
  bs.breached = true;
  bs.hp = Math.round(d.baseHp * 0.3);
  rt.flowDirty = true;
  rt.postsDirty = true;
  toast(rt, `${d.name} has been overrun!`, 'bad');
  sfx(rt, 'alarm', d.x, d.y);
}

// ---- structures ------------------------------------------------------------------

function updateStructures(st: GameState, rt: Runtime, dt: number): void {
  const night = isNight(st.time);
  for (const s of st.structures) {
    s.t += dt;
    if (s.built < 1) continue;
    if (s.kind === 'trap') {
      let hits = 0;
      forZombiesNear(rt, s.x, s.y, STRUCTS.trap.r + 3, (z) => {
        hits++;
        damageZombie(st, rt, z, 30 * dt, null, rt.rng.chance(dt * 4) ? 2 : 0);
      });
      if (hits) {
        s.hp -= 5 * hits * dt;
        if (s.hp <= 0) {
          toast(rt, 'A spike trap wore out.', 'warn');
          removeStructure(st, rt, s.id);
          break;
        }
      }
    }
    if (s.kind === 'tower') {
      s.cd -= dt;
      if (s.cd <= 0 && st.res.ammo > 0) {
        const z = nearestZombie(rt, s.x, s.y, 200, false);
        if (z) {
          shoot(st, rt, s.x, s.y - 10, z, 2, null, 0.95);
          s.cd = 1.05;
        } else s.cd = 0.3;
      }
    }
  }
  if (!night) {
    rt.workshopTimer += dt;
    if (rt.workshopTimer > 18) {
      rt.workshopTimer = 0;
      const n = st.structures.filter((s) => s.kind === 'workshop' && s.built >= 1).length;
      const eng = Math.min(2, st.survivors.filter((s) => s.squad === -1 && !s.joining && s.role === 'engineer').length);
      for (let i = 0; i < n; i++) {
        if (st.res.mat >= 2) {
          st.res.mat -= 2;
          st.res.ammo += 5 + eng * 2;
        }
      }
    }
  }
}

// ---- vehicles ------------------------------------------------------------------

function updateVehicles(st: GameState, rt: Runtime, dt: number): void {
  for (const v of st.vehicles) {
    if (v.wreck) continue;
    v.ram -= dt;
    const riders = st.survivors.filter((s) => s.inside === VEH_SEAT + v.id);
    if (!v.path || !v.path.length) {
      v.path = null;
      for (const r of riders) {
        r.x = v.x;
        r.y = v.y;
      }
      continue;
    }
    const K = VEHICLES[v.kind];
    const t = v.path[0];
    const dx = t.x - v.x;
    const dy = t.y - v.y;
    const d = Math.hypot(dx, dy);
    const want = Math.atan2(dy, dx);
    let da = want - v.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    v.a += da * Math.min(1, dt * 7);
    const sharp = Math.abs(da) > 0.9 ? 0.45 : 1;
    const step = K.speed * sharp * dt;
    if (d <= step + 1) {
      v.x = t.x;
      v.y = t.y;
      v.path.shift();
    } else {
      v.x += (dx / d) * step;
      v.y += (dy / d) * step;
    }
    const moved = Math.min(step, d);
    v.odo += moved;
    st.res.fuel = Math.max(0, st.res.fuel - (moved * K.fuelPer100) / 100);
    for (const r of riders) {
      r.x = v.x;
      r.y = v.y;
    }
    // engine noise draws the infected
    if (v.odo > 60) {
      v.odo = 0;
      noise(rt, v.x, v.y, 170 * weatherOf(st).noise);
    }
    // run down anything in the way
    if (v.ram <= 0) {
      forZombiesNear(rt, v.x + Math.cos(v.a) * 6, v.y + Math.sin(v.a) * 6, 11, (z) => {
        if (v.ram > 0) return;
        damageZombie(st, rt, z, z.kind === 2 ? 45 : 90, null);
        z.x += Math.cos(v.a) * 8;
        z.y += Math.sin(v.a) * 8;
        v.hp -= z.kind === 2 ? 12 : 4;
        v.ram = 0.12;
        sfx(rt, 'crash', v.x, v.y);
      });
    }
    if (v.hp <= 0) {
      wreckVehicle(st, rt, v);
      continue;
    }
    if (st.res.fuel <= 0) {
      v.path = null;
      toast(rt, `The ${K.name} ran out of fuel.`, 'warn');
    }
  }
}

function wreckVehicle(st: GameState, rt: Runtime, v: Vehicle): void {
  if (v.squad >= 0) {
    unloadAll(st, rt, v.squad);
    for (const s of squadMembers(st, v.squad)) s.hp -= 15;
    st.squads[v.squad].vehicle = -1;
    if (st.squads[v.squad].order.drive) st.squads[v.squad].order = { t: 'idle' };
  }
  v.wreck = true;
  v.squad = -1;
  v.path = null;
  st.fires.push({ x: v.x, y: v.y });
  for (let i = 0; i < 18; i++) spark(rt, v.x + rt.rng.range(-8, 8), v.y + rt.rng.range(-6, 6), '#ffb060');
  toast(rt, `The ${VEHICLES[v.kind].name} is wrecked!`, 'bad');
  sfx(rt, 'crash', v.x, v.y);
}

// ---- time of day --------------------------------------------------------------

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function compass(rt: Runtime, x: number, y: number): string {
  const c = rt.map.center;
  const a = Math.atan2(y - c.y, x - c.x); // 0 = east
  const idx = Math.round(((a + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return DIRS[idx];
}

function startNight(st: GameState, rt: Runtime): void {
  const n = st.day;
  st.hordeTotal = 8 + (n - 1) * 5 + rt.rng.int(0, 3);
  st.hordeSpawned = 0;
  const entries = rt.rng.shuffle([...rt.map.entries]);
  const count = n <= 3 ? 1 : n <= 8 ? 2 : 3;
  const chosen = entries.slice(0, count);
  st.hordeFrom = [...new Set(chosen.map((e) => compass(rt, e.x, e.y)))].join(' and ');
  st.hordeEntries = chosen;
  rt.hordeTimer = 0;
  rt.events.push({ k: 'banner', title: `Night ${n}`, sub: `A horde of ${st.hordeTotal} is coming from the ${st.hordeFrom}.`, tone: 'bad' });
  sfx(rt, 'alarm', 0, 0);
  // wandering infected near the haven get restless
  const h0 = hq(rt);
  for (const z of st.zombies) if (z.mode === 0 && dist(z.x, z.y, h0.x + h0.w / 2, h0.y + h0.h / 2) < 650 && rt.rng.chance(0.2)) z.mode = 2;
}

function spawnHordeTick(st: GameState, rt: Runtime, dt: number): void {
  if (st.hordeSpawned >= st.hordeTotal) return;
  const entries = st.hordeEntries.length ? st.hordeEntries : rt.map.entries.slice(0, 1);
  rt.hordeTimer -= dt;
  if (rt.hordeTimer > 0) return;
  rt.hordeTimer = 0.55;
  const n = st.day;
  for (const e of entries) {
    if (st.hordeSpawned >= st.hordeTotal) break;
    const k = rt.rng.int(1, 2);
    for (let i = 0; i < k && st.hordeSpawned < st.hordeTotal; i++) {
      const p = rt.nav.nearestFree(e.x + rt.rng.range(-30, 30), e.y + rt.rng.range(-30, 30), 10);
      const r = rt.rng.next();
      const kind: 0 | 1 | 2 = n >= 5 && r < 0.06 + (n >= 9 ? 0.06 : 0) ? 2 : n >= 3 && r < 0.25 + (n >= 7 ? 0.1 : 0) ? 1 : 0;
      spawnZombie(st, rt, p.x, p.y, kind, 2);
      st.hordeSpawned++;
    }
  }
}

function dawn(st: GameState): void {
  for (const z of st.zombies) if (z.mode === 2) z.mode = 0;
}

function newDay(st: GameState, rt: Runtime): void {
  st.day++;
  if (st.day >= GOAL_DAY) {
    st.over = 'won';
    rt.events.push({ k: 'banner', title: 'The Convoy Has Arrived', sub: `You held the haven for ${GOAL_DAY - 1} nights.`, tone: 'good' });
    return;
  }
  const notes: string[] = [];
  // food
  const pop = st.survivors.length;
  const eaten = Math.min(st.res.food, pop);
  st.res.food -= eaten;
  if (eaten < pop) {
    const hungry = pop - eaten;
    st.survivors.slice(0, hungry).forEach((s) => (s.hp = Math.max(1, s.hp - 30)));
    notes.push(`${hungry} went hungry`);
  } else notes.push(`ate ${eaten} food`);
  const gardens = st.structures.filter((s) => s.kind === 'garden' && s.built >= 1).length;
  if (gardens) {
    st.res.food += gardens * 4;
    notes.push(`gardens +${gardens * 4} food`);
  }
  // medicine
  let treated = 0;
  for (const s of st.survivors)
    if (s.hp < 55 && st.res.med > 0) {
      st.res.med--;
      s.hp = s.maxHp;
      treated++;
    }
  if (treated) notes.push(`treated ${treated} wounded`);
  // repairs
  let repaired = 0;
  const per = engineerAtHaven(st) ? 40 : 20;
  st.b.forEach((b, i) => {
    if (!b.owned) return;
    const max = maxHpOf(rt.map, st.b, i);
    const missing = max - b.hp;
    if (missing <= 0) return;
    const cost = Math.ceil(missing / per);
    const pay = Math.min(cost, st.res.mat);
    st.res.mat -= pay;
    b.hp = Math.min(max, b.hp + pay * per);
    repaired += pay;
  });
  for (const s of st.structures) {
    if (s.built < 1) continue;
    const missing = STRUCTS[s.kind].hp - s.hp;
    if (missing <= 0) continue;
    const pay = Math.min(Math.ceil(missing / per), st.res.mat);
    st.res.mat -= pay;
    s.hp = Math.min(STRUCTS[s.kind].hp, s.hp + pay * per);
    repaired += pay;
  }
  if (repaired) notes.push(`repairs used ${repaired} materials`);
  // more infected drift into town
  populate(st, rt, 10 + st.day * 2, 520);
  st.weather = rollWeather(rt);
  if (st.weather !== 'clear') notes.push(`${WEATHER[st.weather].name.toLowerCase()} today`);
  rt.events.push({ k: 'banner', title: `Day ${st.day}`, sub: `You survived the night. ${capitalize(notes.join(', '))}.`, tone: 'good' });
  sfx(rt, 'dawn', 0, 0);
  rt.events.push({ k: 'save' });
}

function rollWeather(rt: Runtime): Weather {
  return rt.rng.weighted<Weather>([
    ['clear', 45],
    ['overcast', 25],
    ['rain', 20],
    ['fog', 10],
  ]);
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function updateTime(st: GameState, rt: Runtime, dt: number): void {
  const prev = hourOf(st.time);
  st.time += dt;
  const h = hourOf(st.time);
  const crossed = (at: number) => (prev < at && h >= at) || (prev > h && (at > prev || at <= h));
  if (crossed(17.5)) toast(rt, 'Dusk is coming. Get your squads back to the haven.', 'warn');
  if (crossed(13) && rt.rng.chance(0.3)) {
    const w = rollWeather(rt);
    if (w !== st.weather) {
      st.weather = w;
      toast(rt, w === 'rain' ? 'It starts to rain. Gunfire carries less, but you see less too.' : w === 'fog' ? 'Fog rolls in. Visibility is poor.' : w === 'clear' ? 'The sky clears.' : 'Clouds gather over the town.', 'info');
    }
  }
  if (crossed(20)) startNight(st, rt);
  if (crossed(5)) dawn(st);
  if (crossed(6)) newDay(st, rt);
  if (isNight(st.time)) spawnHordeTick(st, rt, dt);
}

// ---- visibility & fog ------------------------------------------------------------

export interface Viewer {
  x: number;
  y: number;
  r: number;
}

export function viewers(st: GameState, rt: Runtime): Viewer[] {
  const night = isNight(st.time);
  const out: Viewer[] = [];
  const wv = weatherOf(st).vision;
  for (const s of st.survivors) if (s.inside < 0) out.push({ x: s.x, y: s.y, r: (night ? 105 : 150) * wv * (s.role === 'scout' ? 1.35 : 1) });
  for (const v of st.vehicles) if (v.squad >= 0 && st.survivors.some((s) => s.inside === VEH_SEAT + v.id)) out.push({ x: v.x, y: v.y, r: (night ? 130 : 160) * wv });
  st.b.forEach((b, i) => {
    if (!b.owned) return;
    const d = rt.map.buildings[i];
    out.push({ x: d.x + d.w / 2, y: d.y + d.h / 2, r: Math.max(d.w, d.h) / 2 + (night ? 70 : 110) });
  });
  for (const s of st.structures) {
    if (s.built < 1) continue;
    if (s.kind === 'tower') out.push({ x: s.x, y: s.y, r: 210 });
    else if (s.kind === 'barrel') out.push({ x: s.x, y: s.y, r: 140 });
  }
  if (night) for (const f of st.fires) out.push({ x: f.x, y: f.y, r: 70 });
  return out;
}

function updateVisibility(st: GameState, rt: Runtime): void {
  const vs = viewers(st, rt);
  for (const v of vs) {
    const x0 = Math.max(0, Math.floor((v.x - v.r) / FOG_CELL));
    const y0 = Math.max(0, Math.floor((v.y - v.r) / FOG_CELL));
    const x1 = Math.min(rt.fogW - 1, Math.floor((v.x + v.r) / FOG_CELL));
    const y1 = Math.min(rt.fogH - 1, Math.floor((v.y + v.r) / FOG_CELL));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * rt.fogW + x;
        if (rt.explored[i]) continue;
        if (dist2(x * FOG_CELL + FOG_CELL / 2, y * FOG_CELL + FOG_CELL / 2, v.x, v.y) <= v.r * v.r) {
          rt.explored[i] = 1;
          rt.fogDirty = true;
        }
      }
  }
  for (const z of st.zombies) {
    let seen = false;
    for (const v of vs)
      if (dist2(z.x, z.y, v.x, v.y) <= v.r * v.r) {
        seen = true;
        break;
      }
    z.seen = seen;
  }
}

// ---- tutorial -------------------------------------------------------------------

export const TUTORIAL = [
  'Tap a building near your haven, then send Squad Alpha to scout it.',
  'Scavenge a scouted building for supplies.',
  'Claim a building next to your haven to make room for more survivors.',
  'Tap your haven and fortify it before nightfall.',
  'Open Build and place a Watchtower or Fire Barrels near the haven.',
  'Survive the night. Keep your squads close to home after dark.',
  `Hold out until the convoy arrives on Day ${GOAL_DAY}.`,
];

function updateTutorial(st: GameState, rt: Runtime): void {
  const t = st.tutorial;
  const owned = st.b.filter((b) => b.owned).length;
  const done = [
    () => st.b.some((b, i) => b.explored && i !== rt.map.hqId),
    () => st.stats.looted > 0,
    () => owned >= 2,
    () => st.b.some((b) => b.owned && b.fort >= 2) || st.b.filter((b) => b.owned && b.fort > 0).length >= 2,
    () => st.structures.length > 0,
    () => st.day >= 2,
  ];
  // allow skipping ahead when later goals are met first
  if (t < done.length && done[t]()) st.tutorial++;
  else if (t < done.length && isNight(st.time) && t < 5) st.tutorial = 5;
}

// ---- main step -------------------------------------------------------------------

export function step(st: GameState, rt: Runtime, dt: number): void {
  if (st.over) return;
  updateTime(st, rt, dt);
  if (st.over) return;
  _st = st;
  if (rt.wallsDirty) rebuildWalls(st, rt);
  if (rt.flowDirty) rebuildFlow(st, rt);
  rebuildZGrid(st, rt);
  rt.thinkTimer -= dt;
  updateSquads(st, rt, dt);
  updateVehicles(st, rt, dt);
  updateSurvivors(st, rt, dt);
  updateZombies(st, rt, dt);
  updateStructures(st, rt, dt);
  if (rt.thinkTimer <= 0) rt.thinkTimer = 0.25;
  rt.attackAlert -= dt;

  // healing near the haven
  const infirm = st.structures.some((s) => s.kind === 'infirmary' && s.built >= 1);
  for (const s of st.survivors) {
    if (s.hp >= s.maxHp) continue;
    if ((s.inside >= 0 && !aboard(s)) || distToBase(st, rt, s.x, s.y) < 60) s.hp = Math.min(s.maxHp, s.hp + dt * (infirm ? 2.5 : 0.5));
  }
  // medics patch up anyone close by
  for (const m of st.survivors) {
    if (m.role !== 'medic' || m.hp <= 0) continue;
    for (const s of st.survivors) {
      if (s.hp >= s.maxHp || s.hp <= 0) continue;
      const near = (m.inside >= 0 && s.inside === m.inside) || (m.inside < 0 && s.inside < 0 && dist2(m.x, m.y, s.x, s.y) < 45 * 45);
      if (near) s.hp = Math.min(s.maxHp, s.hp + dt * (s === m ? 0.6 : 1.2));
    }
  }

  rt.visTimer -= dt;
  if (rt.visTimer <= 0) {
    rt.visTimer = 0.25;
    updateVisibility(st, rt);
  }
  rt.tutTimer -= dt;
  if (rt.tutTimer <= 0) {
    rt.tutTimer = 1;
    updateTutorial(st, rt);
  }
  if (!st.survivors.length && !st.over) {
    st.over = 'lost';
    rt.events.push({ k: 'banner', title: 'No One Is Left', sub: `The last survivor fell on day ${st.day}.`, tone: 'bad' });
  }
  // cap population of wanderers
  if (st.zombies.length > 480) {
    const far = st.zombies.filter((z) => !z.seen && z.mode === 0);
    const kill = new Set(far.slice(0, st.zombies.length - 480).map((z) => z.id));
    st.zombies = st.zombies.filter((z) => !kill.has(z.id));
  }
  st.rngState = rt.rng.state;
}

/** Updates purely visual effects (independent of pause). */
export function stepFx(rt: Runtime, dt: number): void {
  for (const t of rt.tracers) t.t += dt;
  rt.tracers = rt.tracers.filter((t) => t.t < 0.09);
  for (const f of rt.flashes) f.t += dt;
  rt.flashes = rt.flashes.filter((f) => f.t < 0.08);
  for (const p of rt.particles) {
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.9;
    p.vy *= 0.9;
  }
  rt.particles = rt.particles.filter((p) => p.t < p.life);
  for (const d of rt.decals) d.t += dt;
  if (rt.decals.length > 260) rt.decals.splice(0, rt.decals.length - 260);
  rt.decals = rt.decals.filter((d) => d.t < 90);
}

/** Saves explored fog into the state (call before serialising). */
export function syncFog(st: GameState, rt: Runtime): void {
  const out: number[] = [];
  rt.explored.forEach((v, i) => v && out.push(i));
  st.fog = out;
}

export const DAY_SECONDS = DAY_LEN;
