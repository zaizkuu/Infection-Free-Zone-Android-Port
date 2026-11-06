import { Rng } from '../core/rng';
import type { Vec } from '../core/math';
import type { Loot, MapData } from '../world/types';
import { vehicleSpots } from '../world/mapgen';

// ---- tunables ----------------------------------------------------------------
export const DAY_LEN = 240; // seconds of game time per full day at 1x
export const GOAL_DAY = 13; // survive until the morning of this day
export const FOG_CELL = 40;
export const CLAIM_RANGE = 170; // max gap between a building and your base to claim it
export const BUILD_RANGE = 150; // structures must be this close to a base building

export const SQUAD_COLORS = ['#4fc3f7', '#ffb74d', '#c792ea'];
export const SQUAD_NAMES = ['Alpha', 'Bravo', 'Charlie'];
export const GUARD_COLOR = '#8bd17c';

export type Gun = 0 | 1 | 2; // melee, pistol, rifle
export const GUNS = [
  { name: 'Melee', range: 14, dmg: 24, cd: 0.85, acc: 0.95, noise: 0 },
  { name: 'Pistol', range: 125, dmg: 34, cd: 0.7, acc: 0.72, noise: 230 },
  { name: 'Rifle', range: 185, dmg: 58, cd: 0.95, acc: 0.85, noise: 300 },
];

export const ZKINDS = [
  { name: 'Walker', hp: 70, speed: 21, wander: 7, dmg: 8, cd: 1.1, r: 4.6 },
  { name: 'Runner', hp: 45, speed: 44, wander: 10, dmg: 6, cd: 0.8, r: 4 },
  { name: 'Brute', hp: 240, speed: 15, wander: 5, dmg: 20, cd: 1.5, r: 6.6 },
];

export type StructKind = 'tower' | 'barrel' | 'garden' | 'workshop' | 'infirmary' | 'wall' | 'trap';
/** cost in materials; work = worker-seconds for haven guards to build it (walls: per 10 units of length). */
export const STRUCTS: Record<StructKind, { name: string; cost: number; hp: number; desc: string; r: number; work: number }> = {
  tower: { name: 'Watchtower', cost: 30, hp: 220, desc: 'Armed lookout. Shoots infected in range and lights the area. Uses ammo.', r: 9, work: 30 },
  barrel: { name: 'Fire Barrel', cost: 6, hp: 60, desc: 'Lights up the dark so your guards can see the horde coming.', r: 4, work: 4 },
  garden: { name: 'Garden Plot', cost: 15, hp: 80, desc: 'Grows +4 food every morning.', r: 13, work: 14 },
  workshop: { name: 'Workshop', cost: 35, hp: 160, desc: 'Turns 2 materials into 5 ammo every few hours of daylight.', r: 11, work: 34 },
  infirmary: { name: 'Infirmary Tent', cost: 25, hp: 120, desc: 'Survivors near the haven heal five times faster.', r: 11, work: 22 },
  wall: { name: 'Palisade Wall', cost: 0, hp: 260, desc: 'Draw a line of sharpened stakes. Holds the infected back while your own people slip through the gaps.', r: 4, work: 1.6 },
  trap: { name: 'Spike Trap', cost: 8, hp: 90, desc: 'Hidden spikes that wound any infected walking over them. Wears out with use.', r: 6, work: 6 },
};

export const WALL_MAX = 150;
/** Materials for a wall of the given length (world units). */
export const wallCost = (len: number) => Math.max(6, Math.round(len / 5));
/** Worker-seconds to build a structure. */
export const workFor = (s: { kind: StructKind; x: number; y: number; x2?: number; y2?: number }) =>
  s.kind === 'wall' ? Math.max(6, (Math.hypot((s.x2 ?? s.x) - s.x, (s.y2 ?? s.y) - s.y) / 10) * STRUCTS.wall.work) : STRUCTS[s.kind].work;

export const FORT_COST = [15, 30, 50];

// ---- survivor roles ------------------------------------------------------------
export type Role = 'soldier' | 'scout' | 'medic' | 'engineer' | 'scavenger';
export const ROLE_LIST: Role[] = ['soldier', 'scout', 'medic', 'engineer', 'scavenger'];
export const ROLES: Record<Role, { name: string; desc: string }> = {
  soldier: { name: 'Soldier', desc: 'Hits harder, aims better and takes more punishment.' },
  scout: { name: 'Scout', desc: 'Moves faster, sees further and scouts buildings quickly.' },
  medic: { name: 'Medic', desc: 'Patches up nearby survivors over time.' },
  engineer: { name: 'Engineer', desc: 'At the haven: cheaper building and barricades, better repairs and workshops.' },
  scavenger: { name: 'Scavenger', desc: 'Their squad scavenges faster and finds extra supplies.' },
};

// ---- vehicles ---------------------------------------------------------------------
export type VehKind = 'car' | 'cruiser' | 'van';
export const VEHICLES: Record<VehKind, { name: string; speed: number; hp: number; fuelPer100: number; repair: number; prop: 'car' | 'police' | 'truck' }> = {
  car: { name: 'Sedan', speed: 115, hp: 90, fuelPer100: 0.35, repair: 12, prop: 'car' },
  cruiser: { name: 'Police Cruiser', speed: 135, hp: 120, fuelPer100: 0.5, repair: 18, prop: 'police' },
  van: { name: 'Delivery Van', speed: 95, hp: 170, fuelPer100: 0.55, repair: 20, prop: 'truck' },
};

/** Survivors riding in vehicle `v` have inside = VEH_SEAT + v (hidden, like being in a building). */
export const VEH_SEAT = 100000;

export interface Vehicle {
  id: number;
  kind: VehKind;
  x: number;
  y: number;
  a: number;
  hp: number;
  broken: boolean;
  wreck: boolean;
  squad: number;
  path: Vec[] | null;
  color: string;
  odo: number;
  ram: number;
}

// ---- weather ------------------------------------------------------------------------
export type Weather = 'clear' | 'overcast' | 'rain' | 'fog';
export const WEATHER: Record<Weather, { name: string; vision: number; perception: number; noise: number; dark: number }> = {
  clear: { name: 'Clear', vision: 1, perception: 1, noise: 1, dark: 0 },
  overcast: { name: 'Overcast', vision: 0.95, perception: 1, noise: 1, dark: 0.08 },
  rain: { name: 'Rain', vision: 0.75, perception: 0.8, noise: 0.6, dark: 0.14 },
  fog: { name: 'Fog', vision: 0.6, perception: 0.7, noise: 0.85, dark: 0.06 },
};

// ---- entity types ------------------------------------------------------------
export interface Survivor {
  id: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  squad: number; // -1 = haven guard
  gun: Gun;
  facing: number;
  path: Vec[] | null;
  goal: Vec | null;
  cd: number;
  inside: number; // building id when inside, VEH_SEAT + id when riding, else -1
  role: Role;
  post: Vec | null; // guard post for haven guards
  kills: number;
  anim: number;
  repath: number;
  /** Walking to the haven to join it (rescued or reassigned). */
  joining?: boolean;
  /** transient: fighting this tick */
  eng?: boolean;
  /** transient: hammering away at a job site this tick */
  working?: boolean;
  /** haven guard: structure id being built, or -1 */
  job?: number;
}

export interface Zombie {
  id: number;
  kind: 0 | 1 | 2;
  x: number;
  y: number;
  hp: number;
  /** 0 wander, 1 chase survivor, 2 horde, 3 investigate noise */
  mode: 0 | 1 | 2 | 3;
  tx: number;
  ty: number;
  target: number; // survivor id when chasing
  cd: number;
  think: number;
  facing: number;
  anim: number;
  seen: boolean;
  vx: number;
  vy: number;
}

export type OrderType = 'idle' | 'move' | 'scout' | 'scavenge' | 'claim' | 'return' | 'vehicle' | 'demolish' | 'salvage';
export interface Order {
  t: OrderType;
  x?: number;
  y?: number;
  b?: number;
  /** vehicle id for 'vehicle' orders */
  v?: number;
  /** map prop index for 'salvage' orders on abandoned cars */
  p?: number;
  /** driving stage when the squad uses its vehicle for this order */
  drive?: 'board' | 'drive';
  /** progress phase for building orders */
  phase?: 'go' | 'clear' | 'inside' | 'work' | 'done';
  timer?: number;
  total?: number;
}

export interface Squad {
  id: number;
  order: Order;
  vehicle: number; // vehicle id or -1
}

export interface BState {
  explored: boolean;
  owned: boolean;
  fort: number;
  hp: number;
  loot: Loot;
  infected: number;
  survivors: number;
  breached?: boolean;
  /** demolition progress 0..1 (kept if the crew leaves) */
  demo?: number;
  demolished?: boolean;
}

export interface Structure {
  id: number;
  kind: StructKind;
  x: number;
  y: number;
  /** wall end point */
  x2?: number;
  y2?: number;
  hp: number;
  cd: number;
  t: number;
  /** construction progress 0..1; only finished structures work */
  built: number;
  /** materials paid, for refunds */
  cost: number;
}

export interface Resources {
  food: number;
  mat: number;
  ammo: number;
  med: number;
  fuel: number;
}

export interface Stats {
  kills: number;
  rescued: number;
  looted: number;
  lost: number;
  built: number;
}

export interface GameState {
  version: 1;
  seed: number;
  time: number;
  day: number;
  speed: number;
  res: Resources;
  survivors: Survivor[];
  zombies: Zombie[];
  squads: Squad[];
  b: BState[];
  structures: Structure[];
  nextId: number;
  stats: Stats;
  fog: number[]; // explored fog cells (run-length friendly, 0/1)
  tutorial: number;
  over: '' | 'lost' | 'won';
  hordeFrom: string;
  hordeSpawned: number;
  hordeTotal: number;
  hordeEntries: Vec[];
  rngState: number;
  lastHour: number;
  alerts: Record<string, number>;
  fires: Vec[];
  vehicles: Vehicle[];
  weather: Weather;
  /** map prop indices of cars that were scrapped */
  salvaged: number[];
  /** set when the game is played on a real-world (OpenStreetMap) map */
  mapRef?: { lat: number; lon: number; name: string };
}

const NAMES = [
  'Maya', 'Theo', 'Rosa', 'Jonah', 'Iris', 'Malik', 'Nadia', 'Owen', 'Priya', 'Silas', 'Wren', 'Gabe', 'Lena', 'Marco', 'Ava', 'Kofi', 'June', 'Felix', 'Hana', 'Diego',
  'Esme', 'Ravi', 'Tess', 'Omar', 'Clara', 'Hugo', 'Zara', 'Eli', 'Noor', 'Abe', 'Ines', 'Tomas', 'Kira', 'Sam', 'Lucia', 'Ben', 'Yara', 'Cole', 'Mei', 'Arlo',
];

export function nameFor(rng: Rng, used: Set<string>): string {
  for (let i = 0; i < 20; i++) {
    const n = rng.pick(NAMES);
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  return rng.pick(NAMES);
}

export function hourOf(time: number): number {
  return (6 + ((time % DAY_LEN) / DAY_LEN) * 24) % 24;
}

/** 0 = full day, 1 = full night; smooth dusk & dawn. */
export function nightness(time: number): number {
  const h = hourOf(time);
  if (h >= 20 || h < 4.8) return 1;
  if (h >= 18.2) return (h - 18.2) / 1.8;
  if (h < 6.4) return 1 - (h - 4.8) / 1.6;
  return 0;
}

export function isNight(time: number): boolean {
  const h = hourOf(time);
  return h >= 20 || h < 5;
}

export function newGame(map: MapData, seed: number): GameState {
  const rng = new Rng(seed * 7 + 3);
  const hq = map.buildings[map.hqId];
  const b: BState[] = map.buildings.map((d) => ({
    explored: false,
    owned: false,
    fort: 0,
    hp: d.baseHp,
    loot: { ...d.loot, fuel: fuelFor(d.kind, rng) },
    infected: d.infected,
    survivors: d.survivors,
  }));
  b[hq.id].explored = true;
  b[hq.id].owned = true;
  b[hq.id].fort = 1;
  b[hq.id].hp = maxHpOf(map, b, hq.id);

  const st: GameState = {
    version: 1,
    seed,
    time: DAY_LEN * (1.5 / 24), // 07:30
    day: 1,
    speed: 1,
    res: { food: 18, mat: 30, ammo: 120, med: 2, fuel: 10 },
    survivors: [],
    zombies: [],
    squads: [
      { id: 0, order: { t: 'idle' }, vehicle: -1 },
      { id: 1, order: { t: 'idle' }, vehicle: -1 },
      { id: 2, order: { t: 'idle' }, vehicle: -1 },
    ],
    b,
    structures: [],
    nextId: 1,
    stats: { kills: 0, rescued: 0, looted: 0, lost: 0, built: 0 },
    fog: [],
    tutorial: 0,
    over: '',
    hordeFrom: '',
    hordeSpawned: 0,
    hordeTotal: 0,
    hordeEntries: [],
    rngState: rng.state,
    lastHour: 7,
    alerts: {},
    fires: [],
    vehicles: [],
    weather: 'clear',
    salvaged: [],
  };
  const used = new Set<string>();
  const door = hq.door;
  const mk = (squad: number, gun: Gun, i: number, role: Role): Survivor => ({
    id: st.nextId++,
    name: nameFor(rng, used),
    x: door.x + ((i % 3) - 1) * 10,
    y: door.y + Math.floor(i / 3) * 10,
    hp: 100,
    maxHp: 100,
    squad,
    gun,
    facing: Math.PI / 2,
    path: null,
    goal: null,
    cd: 0,
    inside: -1,
    role,
    post: null,
    kills: 0,
    anim: rng.next() * 10,
    repath: 0,
  });
  let i = 0;
  st.survivors.push(mk(0, 1, i++, 'soldier'), mk(0, 1, i++, 'scavenger'), mk(0, 0, i++, 'medic'));
  st.survivors.push(mk(1, 1, i++, 'scout'), mk(1, 0, i++, 'engineer'));
  st.survivors.push(mk(-1, 1, i++, 'soldier'), mk(-1, 0, i++, 'engineer'));
  for (const s of st.survivors) if (s.role === 'soldier') s.hp = s.maxHp = 120;
  st.vehicles = createVehicles(map, () => st.nextId++);

  // Burning wrecks that flicker at night.
  const burnt = map.props.filter((p) => p.kind === 'car' && p.c === '#2a2522');
  rng.shuffle(burnt);
  st.fires = burnt.slice(0, 7).map((p) => ({ x: p.x, y: p.y }));
  return st;
}

export function maxHpOf(map: MapData, b: BState[], id: number): number {
  return Math.round(map.buildings[id].baseHp * (1 + 0.9 * b[id].fort));
}

export function capacity(map: MapData, st: GameState): number {
  let c = 0;
  st.b.forEach((s, i) => {
    if (s.owned) c += map.buildings[i].capacity;
  });
  return c;
}

const FUEL: Partial<Record<string, [number, number, number]>> = {
  gas: [14, 24, 1],
  farmhouse: [4, 8, 0.6],
  barn: [4, 8, 0.6],
  warehouse: [3, 6, 0.4],
  police: [3, 6, 0.5],
  factory: [4, 8, 0.5],
  hardware: [2, 4, 0.4],
  house: [1, 2, 0.1],
};

function fuelFor(kind: string, rng: Rng): number {
  const f = FUEL[kind];
  return f && rng.chance(f[2]) ? rng.int(f[0], f[1]) : 0;
}

export function createVehicles(map: MapData, nextId: () => number): Vehicle[] {
  const out: Vehicle[] = vehicleSpots(map).map((pi) => {
    const p = map.props[pi];
    const kind: VehKind = p.kind === 'police' ? 'cruiser' : p.kind === 'truck' ? 'van' : 'car';
    return { id: nextId(), kind, x: p.x, y: p.y, a: p.a, hp: VEHICLES[kind].hp, broken: true, wreck: false, squad: -1, path: null, color: p.c || '#55575a', odo: 0, ram: 0 };
  });
  // one sedan near the haven still runs
  const ready = out.find((v) => v.kind === 'car');
  if (ready) ready.broken = false;
  return out;
}

export function roleFor(id: number): Role {
  return ROLE_LIST[id % ROLE_LIST.length];
}

/** Brings saves from older versions up to date. */
export function migrate(st: GameState, map: MapData): GameState {
  st.res.fuel ??= 0;
  st.weather ??= 'clear';
  for (const sq of st.squads) sq.vehicle ??= -1;
  for (const b of st.b) b.loot.fuel ??= 0;
  for (const s of st.survivors) s.role ??= roleFor(s.id);
  if (!st.vehicles) st.vehicles = createVehicles(map, () => st.nextId++);
  st.salvaged ??= [];
  for (const s of st.structures) {
    s.built ??= 1;
    s.cost ??= STRUCTS[s.kind].cost;
  }
  return st;
}
