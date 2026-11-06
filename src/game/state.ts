import { Rng } from '../core/rng';
import type { Vec } from '../core/math';
import type { Loot, MapData } from '../world/types';

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

export type StructKind = 'tower' | 'barrel' | 'garden' | 'workshop' | 'infirmary';
export const STRUCTS: Record<StructKind, { name: string; cost: number; hp: number; desc: string; r: number }> = {
  tower: { name: 'Watchtower', cost: 30, hp: 220, desc: 'Armed lookout. Shoots infected in range and lights the area. Uses ammo.', r: 9 },
  barrel: { name: 'Fire Barrel', cost: 6, hp: 60, desc: 'Lights up the dark so your guards can see the horde coming.', r: 4 },
  garden: { name: 'Garden Plot', cost: 15, hp: 80, desc: 'Grows +4 food every morning.', r: 13 },
  workshop: { name: 'Workshop', cost: 35, hp: 160, desc: 'Turns 2 materials into 5 ammo every few hours of daylight.', r: 11 },
  infirmary: { name: 'Infirmary Tent', cost: 25, hp: 120, desc: 'Survivors near the haven heal five times faster.', r: 11 },
};

export const FORT_COST = [15, 30, 50];

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
  inside: number; // building id when inside, else -1
  post: Vec | null; // guard post for haven guards
  kills: number;
  anim: number;
  repath: number;
  /** Walking to the haven to join it (rescued or reassigned). */
  joining?: boolean;
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

export type OrderType = 'idle' | 'move' | 'scout' | 'scavenge' | 'claim' | 'return';
export interface Order {
  t: OrderType;
  x?: number;
  y?: number;
  b?: number;
  /** progress phase for building orders */
  phase?: 'go' | 'clear' | 'inside' | 'done';
  timer?: number;
  total?: number;
}

export interface Squad {
  id: number;
  order: Order;
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
}

export interface Structure {
  id: number;
  kind: StructKind;
  x: number;
  y: number;
  hp: number;
  cd: number;
  t: number;
}

export interface Resources {
  food: number;
  mat: number;
  ammo: number;
  med: number;
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
    loot: { ...d.loot },
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
    res: { food: 18, mat: 30, ammo: 120, med: 2 },
    survivors: [],
    zombies: [],
    squads: [
      { id: 0, order: { t: 'idle' } },
      { id: 1, order: { t: 'idle' } },
      { id: 2, order: { t: 'idle' } },
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
  };
  const used = new Set<string>();
  const door = hq.door;
  const mk = (squad: number, gun: Gun, i: number): Survivor => ({
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
    post: null,
    kills: 0,
    anim: rng.next() * 10,
    repath: 0,
  });
  let i = 0;
  st.survivors.push(mk(0, 1, i++), mk(0, 1, i++), mk(0, 0, i++));
  st.survivors.push(mk(1, 1, i++), mk(1, 0, i++));
  st.survivors.push(mk(-1, 1, i++), mk(-1, 0, i++));

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
