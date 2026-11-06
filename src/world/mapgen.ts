import { Rng } from '../core/rng';
import { clamp, rectsOverlap, type Rect, type Vec } from '../core/math';
import type {
  Area,
  AreaKind,
  BuildingDef,
  BuildingKind,
  Facing,
  Fence,
  Loot,
  MapData,
  Prop,
  PropKind,
  River,
  Road,
  RoofStyle,
} from './types';

/**
 * Procedural town generator. The same seed always produces the same town, so a
 * fixed seed acts as a "pre-generated" map. The output format (roads, building
 * footprints, areas, props) is deliberately close to what real map data provides
 * so it can later be fed from OpenStreetMap instead.
 */

export const MAP_W = 2400;
export const MAP_H = 2400;
const STREET_W = 24;
const MAIN_W = 36;
const SIDEWALK = 8;

const TOWN_NAMES = ['Ashbury', 'Millbrook', 'Harlow Creek', 'Stonebridge', 'Westfield', 'Larkspur'];
const V_STREETS = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Hawthorn', 'Juniper', 'Linden', 'Poplar', 'Willow', 'Sycamore'];
const H_STREETS = ['Railway', 'Mill', 'Church', 'Market', 'Union', 'Garden', 'Harbor', 'Ridge', 'Summit', 'Valley', 'Orchard'];

const HOUSE_ROOFS = ['#3b3d40', '#4a3f37', '#45494f', '#5a4636', '#6b4436', '#4d5148', '#5e5a52', '#3f3a35', '#6e4f3c'];
const HOUSE_WALLS = ['#a49a88', '#9b9483', '#8d8b84', '#a8977c', '#958a7a', '#b0a690', '#8a8478', '#a39c8e'];
const FLAT_ROOFS = ['#5d5e5c', '#676661', '#555756', '#6e6b64', '#4f5251', '#605d57'];
const SHOP_WALLS = ['#8a6e57', '#7a6250', '#958a7a', '#776d63', '#8c7b66', '#6b625a', '#8f7559'];
const CAR_COLORS = ['#6a2a2a', '#2a3a4c', '#a9a8a2', '#232426', '#55575a', '#6e6440', '#2d4234', '#8a8d90', '#4a3a4c', '#7a5232'];

interface Cell {
  i: number;
  j: number;
  r: Rect; // interior (inside sidewalks)
  kind: string;
  sides: Record<Facing, boolean>;
  streets: Record<Facing, string>;
  cx: number;
  cy: number;
}

export function riverXAt(river: River, y: number): number {
  const t = (y - river.y0) / river.step;
  const i = clamp(Math.floor(t), 0, river.pts.length - 2);
  const f = clamp(t - i, 0, 1);
  return river.pts[i].x + (river.pts[i + 1].x - river.pts[i].x) * f;
}

export function inRiver(river: River, x: number, y: number, pad = 0): boolean {
  return Math.abs(x - riverXAt(river, y)) < river.w / 2 + pad;
}

export function generateMap(seed: number): MapData {
  const rng = new Rng(seed);
  const townName = rng.pick(TOWN_NAMES);

  // ---- road grid ---------------------------------------------------------
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 330 + rng.int(0, 40); x < MAP_W - 300; x += rng.int(236, 292)) xs.push(x);
  for (let y = 330 + rng.int(0, 40); y < MAP_H - 300; y += rng.int(236, 292)) ys.push(y);
  const nx = xs.length;
  const ny = ys.length;

  let mi = 0;
  let mj = 0;
  xs.forEach((x, i) => {
    if (Math.abs(x - MAP_W * 0.42) < Math.abs(xs[mi] - MAP_W * 0.42)) mi = i;
  });
  ys.forEach((y, j) => {
    if (Math.abs(y - MAP_H * 0.5) < Math.abs(ys[mj] - MAP_H * 0.5)) mj = j;
  });

  // River runs north-south through one column of the grid, east of the centre.
  let k = mi + 2;
  if (k > nx - 3) k = nx - 3;
  if (k <= mi) k = mi + 1;
  const vW = (i: number) => (i === mi ? MAIN_W : STREET_W);
  const hW = (j: number) => (j === mj ? MAIN_W : STREET_W);

  const riverW = 64;
  const colInner = xs[k + 1] - xs[k] - (vW(k) + vW(k + 1)) / 2 - SIDEWALK * 2;
  const amp = Math.max(8, Math.min(42, (colInner - riverW) / 2 - 16));
  const rx0 = (xs[k] + xs[k + 1]) / 2;
  const ph1 = rng.range(0, Math.PI * 2);
  const ph2 = rng.range(0, Math.PI * 2);
  const river: River = { pts: [], w: riverW, step: 16, y0: -32 };
  for (let y = -32; y <= MAP_H + 48; y += 16) {
    river.pts.push({ x: rx0 + amp * Math.sin(y * 0.0042 + ph1) + amp * 0.35 * Math.sin(y * 0.012 + ph2), y });
  }

  const roads: Road[] = [];
  const bridges: Rect[] = [];
  const removed = new Set<string>();
  const merges: [number, number, number, number][] = []; // cells (i,j) merged with (i2,j2)

  // ---- cells & districts ------------------------------------------------
  const center = { x: xs[mi], y: ys[mj] };
  const cellCenter = (i: number, j: number) => ({ x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 });
  const westCells: [number, number, number][] = [];
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < ny - 1; j++) {
      if (i >= k) continue;
      const c = cellCenter(i, j);
      westCells.push([i, j, Math.hypot(c.x - center.x, c.y - center.y)]);
    }
  westCells.sort((a, b) => a[2] - b[2]);
  const kinds = new Map<string, string>();
  const key = (i: number, j: number) => `${i},${j}`;
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < ny - 1; j++) {
      kinds.set(key(i, j), i === k ? 'riverpark' : i > k ? (rng.chance(0.72) ? 'industrial' : 'residential') : 'residential');
    }
  // downtown: the closest cells to the main intersection
  const downtown = westCells.slice(0, 6);
  downtown.forEach(([i, j]) => kinds.set(key(i, j), 'downtown'));
  const dtShuffled = rng.shuffle(downtown.slice());
  kinds.set(key(dtShuffled[0][0], dtShuffled[0][1]), 'supermarket');
  kinds.set(key(dtShuffled[1][0], dtShuffled[1][1]), 'police');
  kinds.set(key(dtShuffled[2][0], dtShuffled[2][1]), 'plaza');

  const ring = westCells.slice(6, 16).filter(([i, j]) => kinds.get(key(i, j)) === 'residential');
  const ringShuffled = rng.shuffle(ring.slice());
  const takeRing = () => ringShuffled.shift();
  // Hospital: merge a ring cell with a horizontal neighbour if possible.
  for (let t = 0; t < ringShuffled.length; t++) {
    const [i, j] = ringShuffled[t];
    const nb = [
      [i + 1, j],
      [i - 1, j],
    ].find(([a, b]) => a >= 0 && a < k && a !== i && kinds.get(key(a, b)) === 'residential' && a !== mi && Math.min(a, i) + 1 !== mi);
    if (nb) {
      const a = Math.min(i, nb[0]);
      kinds.set(key(a, j), 'hospital');
      kinds.set(key(a + 1, j), 'merged');
      merges.push([a, j, a + 1, j]);
      removed.add(`v,${a + 1},${j}`);
      ringShuffled.splice(t, 1);
      const idx = ringShuffled.findIndex(([x, y]) => x === nb[0] && y === nb[1]);
      if (idx >= 0) ringShuffled.splice(idx, 1);
      break;
    }
  }
  // The fire station (your starting haven) sits right next to downtown.
  const fsCell = ring.find(([i, j]) => kinds.get(key(i, j)) === 'residential');
  if (fsCell) {
    kinds.set(key(fsCell[0], fsCell[1]), 'firestation');
    const idx = ringShuffled.findIndex(([x, y]) => x === fsCell[0] && y === fsCell[1]);
    if (idx >= 0) ringShuffled.splice(idx, 1);
  }
  for (const kind of ['school', 'church', 'park']) {
    const c = takeRing();
    if (c) kinds.set(key(c[0], c[1]), kind);
  }
  // Extra spread-out specials
  const resLeft = westCells.filter(([i, j]) => kinds.get(key(i, j)) === 'residential');
  rng.shuffle(resLeft);
  let gasCount = 0;
  for (const [i, j] of resLeft) {
    const nearMain = i === mi || i + 1 === mi || j === mj || j + 1 === mj;
    if (nearMain && gasCount < 2) {
      kinds.set(key(i, j), 'gas');
      gasCount++;
    }
  }
  const resLeft2 = resLeft.filter(([i, j]) => kinds.get(key(i, j)) === 'residential');
  if (resLeft2.length > 3) kinds.set(key(resLeft2[resLeft2.length - 1][0], resLeft2[resLeft2.length - 1][1]), 'park');
  // one factory merge in the industrial zone
  for (let j = 0; j < ny - 2; j++) {
    const i = k + 1;
    if (i < nx - 1 && kinds.get(key(i, j)) === 'industrial' && kinds.get(key(i, j + 1)) === 'industrial' && j !== mj - 1 && j + 1 !== mj) {
      kinds.set(key(i, j), 'factory');
      kinds.set(key(i, j + 1), 'merged');
      merges.push([i, j, i, j + 1]);
      removed.add(`h,${i},${j + 1}`);
      break;
    }
  }

  // ---- roads ----------------------------------------------------------------
  const top = ys[0];
  const bot = ys[ny - 1];
  const left = xs[0];
  const right = xs[nx - 1];
  for (let i = 0; i < nx; i++) {
    const main = i === mi;
    const name = main ? 'Main St' : `${V_STREETS[i % V_STREETS.length]} St`;
    if (main) {
      roads.push({ x1: xs[i], y1: -40, x2: xs[i], y2: MAP_H + 40, w: MAIN_W, main, bridge: false, name });
      continue;
    }
    for (let j = 0; j < ny - 1; j++) {
      if (removed.has(`v,${i},${j}`)) continue;
      roads.push({ x1: xs[i], y1: ys[j], x2: xs[i], y2: ys[j + 1], w: STREET_W, main, bridge: false, name });
    }
  }
  for (let j = 0; j < ny; j++) {
    const main = j === mj;
    const name = main ? 'Kingsway' : `${H_STREETS[j % H_STREETS.length]} Rd`;
    const w = hW(j);
    if (main) {
      // split at river so the bridge can be flagged
      roads.push({ x1: -40, y1: ys[j], x2: xs[k], y2: ys[j], w, main, bridge: false, name });
      roads.push({ x1: xs[k], y1: ys[j], x2: xs[k + 1], y2: ys[j], w, main, bridge: true, name });
      roads.push({ x1: xs[k + 1], y1: ys[j], x2: MAP_W + 40, y2: ys[j], w, main, bridge: false, name });
      continue;
    }
    for (let i = 0; i < nx - 1; i++) {
      if (removed.has(`h,${i},${j}`)) continue;
      let bridge = false;
      if (i === k) {
        if (j === 0 || j === ny - 1 || (j - mj) % 2 === 0) bridge = true;
        else continue;
      }
      roads.push({ x1: xs[i], y1: ys[j], x2: xs[i + 1], y2: ys[j], w, main, bridge, name });
    }
  }
  for (const r of roads) {
    if (!r.bridge) continue;
    bridges.push({ x: r.x1 + vW(k) / 2, y: r.y1 - r.w / 2 - 4, w: r.x2 - r.x1 - vW(k) / 2 - vW(k + 1) / 2, h: r.w + 8 });
  }

  // ---- output containers -------------------------------------------------
  const buildings: BuildingDef[] = [];
  const areas: Area[] = [];
  const props: Prop[] = [];
  const fences: Fence[] = [];

  const addArea = (kind: AreaKind, r: Rect, v = rng.next(), o?: number) => {
    if (r.w > 1 && r.h > 1) areas.push({ kind, x: r.x, y: r.y, w: r.w, h: r.h, v, o });
  };
  const addProp = (kind: PropKind, x: number, y: number, r: number, a = 0, c = '', extra: Partial<Prop> = {}) => {
    props.push({ kind, x, y, r, a, c, v: rng.next(), ...extra });
  };
  const addTree = (x: number, y: number, s = 1) => {
    if (inRiver(river, x, y, 10)) return;
    const pine = rng.chance(0.22);
    addProp(pine ? 'pine' : 'tree', x, y, (pine ? rng.range(8, 12) : rng.range(9, 15)) * s, rng.range(0, 6.28));
  };

  // ---- buildings -------------------------------------------------------
  const addBuilding = (kind: BuildingKind, r: Rect, facing: Facing, opts: Partial<BuildingDef> = {}): BuildingDef => {
    const flat = !['house', 'bungalow', 'farmhouse', 'barn', 'church'].includes(kind);
    const roof: RoofStyle = opts.roof ?? (flat ? 'flat' : rng.chance(0.3) ? 'hip' : r.w >= r.h ? 'gable-h' : 'gable-v');
    const wallH = opts.wallH ?? (kind === 'house' ? rng.int(7, 9) : kind === 'bungalow' ? 6 : flat ? rng.int(9, 15) : 9);
    let door: Vec;
    const off = 7;
    switch (facing) {
      case 'n':
        door = { x: r.x + r.w / 2, y: r.y - off };
        break;
      case 's':
        door = { x: r.x + r.w / 2, y: r.y + r.h + off };
        break;
      case 'w':
        door = { x: r.x - off, y: r.y + r.h / 2 };
        break;
      default:
        door = { x: r.x + r.w + off, y: r.y + r.h / 2 };
    }
    const area = r.w * r.h;
    const b: BuildingDef = {
      id: buildings.length,
      kind,
      name: opts.name ?? defaultName(kind, rng),
      sub: opts.sub ?? '',
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
      wallH,
      roof,
      roofColor: opts.roofColor ?? (flat ? rng.pick(FLAT_ROOFS) : rng.pick(HOUSE_ROOFS)),
      wallColor: opts.wallColor ?? (flat ? rng.pick(SHOP_WALLS) : rng.pick(HOUSE_WALLS)),
      door,
      facing,
      capacity: CAPACITY[kind],
      baseHp: Math.round(260 + area / 12),
      loot: rollLoot(kind, rng),
      infected: rollInfected(kind, rng),
      survivors: rollSurvivors(kind, rng),
      deco: opts.deco,
    };
    buildings.push(b);
    return b;
  };

  /** Map a local rect (u along frontage, v depth from road) to world space. */
  const toWorld = (R: Rect, f: Facing, u: number, v: number, lw: number, ld: number): Rect => {
    switch (f) {
      case 'n':
        return { x: R.x + u, y: R.y + v, w: lw, h: ld };
      case 's':
        return { x: R.x + u, y: R.y + R.h - v - ld, w: lw, h: ld };
      case 'w':
        return { x: R.x + v, y: R.y + u, w: ld, h: lw };
      default:
        return { x: R.x + R.w - v - ld, y: R.y + u, w: ld, h: lw };
    }
  };
  const frontLen = (R: Rect, f: Facing) => (f === 'n' || f === 's' ? R.w : R.h);
  const depthLen = (R: Rect, f: Facing) => (f === 'n' || f === 's' ? R.h : R.w);

  const splitLots = (L: number, minW: number, maxW: number): [number, number][] => {
    const lots: [number, number][] = [];
    let u = 0;
    while (L - u > 0) {
      let w = rng.range(minW, maxW);
      if (L - u - w < minW * 0.7) w = L - u;
      lots.push([u, w]);
      u += w;
    }
    return lots;
  };

  const fillResidentialRow = (R: Rect, f: Facing, D: number, street: string, numBase: number) => {
    const L = frontLen(R, f);
    const lots = splitLots(L, 46, 62);
    let num = numBase;
    lots.forEach(([u0, lw], li) => {
      num += 2;
      const lot = toWorld(R, f, u0, 0, lw, D);
      addArea('yard', lot, rng.next());
      // side fence
      if (li > 0) {
        const a = toWorld(R, f, u0, D * 0.45, 0, D * 0.55);
        fences.push({ x1: a.x, y1: a.y, x2: a.x + a.w, y2: a.y + a.h, kind: rng.chance(0.25) ? 'hedge' : 'wood' });
      }
      if (rng.chance(0.07)) {
        // vacant, overgrown lot
        for (let t = 0; t < 3; t++) {
          const p = toWorld(R, f, u0 + rng.range(6, lw - 6), rng.range(6, D - 6), 0, 0);
          addProp('bush', p.x, p.y, rng.range(4, 7));
        }
        if (rng.chance(0.5)) addTree(lot.x + lot.w / 2 + rng.range(-8, 8), lot.y + lot.h / 2 + rng.range(-8, 8));
        return;
      }
      const small = rng.chance(0.25);
      const hw = clamp(lw - rng.range(12, 18), 22, small ? 30 : 42);
      const hd = clamp(rng.range(small ? 20 : 24, small ? 26 : 34), 18, D - 22);
      const sb = rng.range(9, 13);
      const space = lw - hw;
      const drivewayLeft = rng.chance(0.5);
      const uHouse = u0 + (drivewayLeft ? Math.min(space - 3, 13) : 3 + rng.range(0, Math.max(0, space - 16)));
      const hr = toWorld(R, f, uHouse, sb, hw, hd);
      const b = addBuilding(small ? 'bungalow' : 'house', hr, f, { sub: `${num} ${street}` });
      // driveway
      const dwU = drivewayLeft ? u0 + 2 : uHouse + hw + 2;
      if ((drivewayLeft ? uHouse - u0 : u0 + lw - (uHouse + hw)) >= 11) {
        const dw = toWorld(R, f, dwU, 0, 9, sb + hd * 0.7);
        addArea('driveway', dw);
        if (rng.chance(0.35)) {
          const c = toWorld(R, f, dwU + 4.5, sb * 0.7, 0, 0);
          const vertical = f === 'n' || f === 's';
          addProp('car', c.x, c.y, 1, (vertical ? Math.PI / 2 : 0) + rng.range(-0.05, 0.05), rng.pick(CAR_COLORS), { solid: true });
        }
      }
      // walkway
      const ww = toWorld(R, f, uHouse + hw / 2 - 1.5, 0, 3, sb);
      addArea('path', ww);
      // backyard
      const back = sb + hd;
      if (D - back > 18) {
        const nt = rng.int(0, 2);
        for (let t = 0; t < nt; t++) {
          const p = toWorld(R, f, u0 + rng.range(8, lw - 8), back + rng.range(8, D - back - 4), 0, 0);
          addTree(p.x, p.y, 0.85);
        }
        if (rng.chance(0.12) && D - back > 26 && lw > 40) {
          const pr = toWorld(R, f, u0 + rng.range(5, lw - 25), back + 6, 18, 11);
          addArea('pool', pr);
        } else if (rng.chance(0.18)) {
          const p = toWorld(R, f, u0 + rng.range(8, lw - 8), D - 8, 0, 0);
          addProp('shed', p.x, p.y, 6, 0, rng.pick(['#7a6a55', '#6b6f73', '#8a5a44']));
        }
      }
      if (rng.chance(0.25)) {
        const p = toWorld(R, f, u0 + rng.range(4, lw - 4), 4, 0, 0);
        addProp('bush', p.x, p.y, rng.range(3, 5));
      }
      void b;
    });
  };

  const fillResidential = (c: Cell, R = c.r) => {
    const horiz = R.w >= R.h * 0.9;
    const fA: Facing = horiz ? 'n' : 'w';
    const fB: Facing = horiz ? 's' : 'e';
    const D = depthLen(R, fA);
    const hasA = c.sides[fA];
    const hasB = c.sides[fB];
    if (hasA && hasB && D > 96) {
      const half = D / 2;
      fillResidentialRow(R, fA, half, c.streets[fA], c.i * 100 + 1);
      fillResidentialRow(R, fB, half, c.streets[fB], c.i * 100 + 2);
      // shared back fence
      const a = toWorld(R, fA, 0, half, frontLen(R, fA), 0);
      fences.push({ x1: a.x, y1: a.y, x2: a.x + a.w, y2: a.y + a.h, kind: 'wood' });
    } else {
      const f = hasA ? fA : hasB ? fB : fA;
      fillResidentialRow(R, f, Math.min(D, 90), c.streets[f], c.j * 100 + 1);
      if (D > 110) {
        const rest = toWorld(R, f, 0, 92, frontLen(R, f), D - 92);
        addArea('lawn', rest);
        for (let t = 0; t < (rest.w * rest.h) / 1400; t++) addTree(rest.x + rng.range(6, rest.w - 6), rest.y + rng.range(6, rest.h - 6));
      }
    }
  };

  const DT_KINDS: [BuildingKind, number][] = [
    ['shop', 5],
    ['office', 2],
    ['apartment', 3],
    ['diner', 1],
  ];
  const forcedDowntown: BuildingKind[] = ['pharmacy', 'hardware', 'diner', 'pharmacy', 'apartment'];

  const fillDowntownRow = (R: Rect, f: Facing, D: number, street: string) => {
    const L = frontLen(R, f);
    const lots = splitLots(L, 40, 78);
    let num = 100 + rng.int(0, 50) * 2;
    for (const [u0, lw] of lots) {
      num += 4;
      const gap = rng.chance(0.3) ? rng.range(6, 10) : 1;
      const w = lw - gap;
      if (w < 26) continue;
      const d = clamp(rng.range(46, 72), 30, D - 6);
      const kind = forcedDowntown.length && rng.chance(0.35) ? forcedDowntown.shift()! : rng.weighted(DT_KINDS);
      const r = toWorld(R, f, u0 + gap / 2, 2, w, d);
      addBuilding(kind, r, f, { sub: `${num} ${street}`, wallH: kind === 'apartment' || kind === 'office' ? rng.int(14, 18) : rng.int(9, 12) });
      if (rng.chance(0.3)) {
        const p = toWorld(R, f, u0 + gap / 2 + rng.range(4, w - 4), d + 6, 0, 0);
        addProp('dumpster', p.x, p.y, 1, f === 'n' || f === 's' ? 0 : Math.PI / 2, rng.pick(['#2f5a3f', '#2f4f6f', '#5a4a3a']), { solid: true });
      }
    }
  };

  const fillDowntown = (c: Cell, R = c.r) => {
    addArea('concrete', R);
    const horiz = R.w >= R.h * 0.9;
    const fA: Facing = horiz ? 'n' : 'w';
    const fB: Facing = horiz ? 's' : 'e';
    const D = depthLen(R, fA);
    fillDowntownRow(R, fA, D / 2 - 6, c.streets[fA]);
    fillDowntownRow(R, fB, D / 2 - 6, c.streets[fB]);
    // back alley parking
    const mid = toWorld(R, fA, 4, D / 2 - 14, frontLen(R, fA) - 8, 28);
    if (rng.chance(0.6)) addArea('parking', mid, rng.next(), horiz ? 0 : 1);
  };

  const parkingLot = (r: Rect, orient: number, density = 0.35) => {
    addArea('parking', r, rng.next(), orient);
    // cars in stalls
    const stallW = 12;
    const stallD = 22;
    if (orient === 0) {
      for (let row = 0; row * stallD + stallD <= r.h; row += 1) {
        if (row % 3 === 2) continue;
        for (let x = r.x + 4; x + stallW <= r.x + r.w - 2; x += stallW) {
          if (rng.chance(density)) addProp('car', x + stallW / 2, r.y + row * stallD + stallD / 2, 1, Math.PI / 2 + rng.range(-0.08, 0.08), rng.pick(CAR_COLORS), { solid: true });
        }
      }
    } else {
      for (let col = 0; col * stallD + stallD <= r.w; col += 1) {
        if (col % 3 === 2) continue;
        for (let y = r.y + 4; y + stallW <= r.y + r.h - 2; y += stallW) {
          if (rng.chance(density)) addProp('car', r.x + col * stallD + stallD / 2, y + stallW / 2, 1, rng.range(-0.08, 0.08), rng.pick(CAR_COLORS), { solid: true });
        }
      }
    }
  };

  const frontFacing = (c: Cell): Facing => {
    const order: Facing[] = ['s', 'n', 'w', 'e'];
    // prefer the side facing a main road
    for (const f of order) if (c.sides[f] && /Main|Kingsway/.test(c.streets[f])) return f;
    for (const f of order) if (c.sides[f]) return f;
    return 's';
  };

  const fillSupermarket = (c: Cell) => {
    const R = c.r;
    const f = frontFacing(c);
    const D = depthLen(R, f);
    const L = frontLen(R, f);
    addArea('concrete', R);
    const bw = Math.min(L - 30, 150);
    const bd = Math.min(D * 0.48, 92);
    const br = toWorld(R, f, (L - bw) / 2, D - bd - 8, bw, bd);
    addBuilding('supermarket', br, f, { name: 'Greenleaf Market', sub: c.streets[f], wallH: 12, roofColor: '#77797a', wallColor: '#9a8a6c' });
    const pk = toWorld(R, f, 8, 6, L - 16, D - bd - 24);
    parkingLot(pk, f === 'n' || f === 's' ? 0 : 1, 0.28);
    const p = toWorld(R, f, L - 14, D - bd - 14, 0, 0);
    addProp('truck', p.x, p.y, 1, f === 'n' || f === 's' ? 0 : Math.PI / 2, '#d8d8d0', { solid: true });
  };

  const fillPolice = (c: Cell) => {
    const R = c.r;
    const f = frontFacing(c);
    const D = depthLen(R, f);
    const L = frontLen(R, f);
    addArea('concrete', R);
    const bw = Math.min(L * 0.5, 100);
    const br = toWorld(R, f, 6, 4, bw, Math.min(66, D * 0.45));
    addBuilding('police', br, f, { name: `${townName} Police Dept.`, sub: c.streets[f], wallH: 13, roofColor: '#55595e', wallColor: '#8f887c' });
    const pk = toWorld(R, f, bw + 14, 4, L - bw - 20, Math.min(66, D * 0.45));
    addArea('parking', pk, rng.next(), f === 'n' || f === 's' ? 0 : 1);
    for (let t = 0; t < 3; t++) {
      const p = toWorld(R, f, bw + 24 + t * 16, 18, 0, 0);
      addProp('police', p.x, p.y, 1, (f === 'n' || f === 's' ? Math.PI / 2 : 0) + rng.range(-0.1, 0.1), '#e8e8e8', { solid: true });
    }
    // barricade line in front, the last stand of the local police
    for (let t = 0; t < 4; t++) {
      const p = toWorld(R, f, 10 + t * 22, -3, 0, 0);
      addProp('barrier', p.x, p.y, 1, f === 'n' || f === 's' ? 0 : Math.PI / 2);
    }
    const restF: Facing = f === 'n' ? 's' : f === 's' ? 'n' : f === 'w' ? 'e' : 'w';
    fillDowntownRow(R, restF, D * 0.45, c.streets[restF]);
  };

  const fillPlaza = (c: Cell) => {
    const R = c.r;
    addArea('plaza', R);
    const cx = R.x + R.w / 2;
    const cy = R.y + R.h / 2;
    addProp('fountain', cx, cy, 20, 0, '', { solid: true });
    for (let gx = R.x + 22; gx < R.x + R.w - 10; gx += 40)
      for (let gy = R.y + 22; gy < R.y + R.h - 10; gy += 40) {
        if (Math.hypot(gx - cx, gy - cy) < 46) continue;
        addTree(gx + rng.range(-3, 3), gy + rng.range(-3, 3), 0.9);
      }
    for (let t = 0; t < 6; t++) {
      const ang = (t / 6) * Math.PI * 2;
      addProp('bench', cx + Math.cos(ang) * 34, cy + Math.sin(ang) * 34, 1, ang + Math.PI / 2);
    }
  };

  const fillPark = (c: Cell, R = c.r) => {
    addArea('park', R);
    const cx = R.x + R.w / 2;
    const cy = R.y + R.h / 2;
    addArea('path', { x: R.x, y: cy - 3, w: R.w, h: 6 });
    addArea('path', { x: cx - 3, y: R.y, w: 6, h: R.h });
    const pr = { x: R.x + R.w * 0.58, y: R.y + R.h * 0.12, w: R.w * 0.32, h: R.h * 0.26 };
    addArea('pond', pr);
    const pondHit = (x: number, y: number) => x > pr.x - 8 && x < pr.x + pr.w + 8 && y > pr.y - 8 && y < pr.y + pr.h + 8;
    const n = (R.w * R.h) / 900;
    for (let t = 0; t < n; t++) {
      const x = R.x + rng.range(8, R.w - 8);
      const y = R.y + rng.range(8, R.h - 8);
      if (Math.abs(x - cx) < 12 || Math.abs(y - cy) < 12 || pondHit(x, y)) continue;
      addTree(x, y);
    }
    for (let t = 0; t < 4; t++) addProp('bench', cx + (t < 2 ? -24 : 24), cy + (t % 2 ? 9 : -9), 1, 0);
  };

  const fillHospital = (c: Cell, R: Rect) => {
    const f = frontFacing(c);
    const D = depthLen(R, f);
    const L = frontLen(R, f);
    addArea('lawn', R);
    const bw = Math.min(L * 0.62, 260);
    const bd = Math.min(D * 0.46, 100);
    const u = (L - bw) / 2;
    const br = toWorld(R, f, u, 34, bw, bd);
    addBuilding('hospital', br, f, { name: `${townName} General Hospital`, sub: c.streets[f], wallH: 18, roofColor: '#9c9d9a', wallColor: '#aaa79e', deco: 'helipad' });
    // drive & parking
    addArea('concrete', toWorld(R, f, u - 10, 6, bw + 20, 22));
    const pk = toWorld(R, f, 10, 34 + bd + 14, L - 20, D - bd - 56);
    parkingLot(pk, f === 'n' || f === 's' ? 0 : 1, 0.3);
    const amb = toWorld(R, f, u + 18, 16, 0, 0);
    addProp('truck', amb.x, amb.y, 1, f === 'n' || f === 's' ? 0 : Math.PI / 2, '#f0f0ea', { solid: true });
    for (let t = 0; t < 8; t++) {
      const p = toWorld(R, f, rng.range(6, u - 16), rng.range(10, 34 + bd), 0, 0);
      addTree(p.x, p.y, 0.9);
    }
  };

  const fillSchool = (c: Cell) => {
    const R = c.r;
    const f = frontFacing(c);
    const D = depthLen(R, f);
    const L = frontLen(R, f);
    addArea('lawn', R);
    const bw = Math.min(L * 0.55, 140);
    const br = toWorld(R, f, 8, 10, bw, Math.min(56, D * 0.32));
    addBuilding('school', br, f, { name: `${townName} Elementary`, sub: c.streets[f], wallH: 12, roofColor: '#62645e', wallColor: '#7f5040' });
    const fieldR = toWorld(R, f, 10, D * 0.42, L - 20, D * 0.54);
    addArea('track', fieldR);
    const court = toWorld(R, f, bw + 20, 10, Math.min(L - bw - 28, 56), 34);
    if (court.w > 30) addArea('court', court);
  };

  const fillChurch = (c: Cell) => {
    const R = c.r;
    const f = frontFacing(c);
    const D = depthLen(R, f);
    const L = frontLen(R, f);
    addArea('lawn', R);
    const vertical = f === 'n' || f === 's';
    const cw = vertical ? 48 : 84;
    const ch = vertical ? 84 : 48;
    const br = toWorld(R, f, 18, 14, vertical ? cw : ch, vertical ? ch : cw);
    addBuilding('church', br, f, {
      name: "St. Brigid's Church",
      sub: c.streets[f],
      wallH: 14,
      roof: vertical ? 'gable-v' : 'gable-h',
      roofColor: '#3c4249',
      wallColor: '#9c968a',
      deco: 'steeple',
    });
    const g = toWorld(R, f, 18 + (vertical ? cw : ch) + 20, 14, L - (vertical ? cw : ch) - 48, D - 34);
    addArea('graveyard', g);
    for (let gx = g.x + 8; gx < g.x + g.w - 4; gx += 11)
      for (let gy = g.y + 8; gy < g.y + g.h - 4; gy += 14) if (rng.chance(0.75)) addProp('stone', gx + rng.range(-1, 1), gy, 1, rng.range(-0.1, 0.1));
    fences.push({ x1: g.x, y1: g.y, x2: g.x + g.w, y2: g.y, kind: 'wall' });
    fences.push({ x1: g.x, y1: g.y + g.h, x2: g.x + g.w, y2: g.y + g.h, kind: 'wall' });
    fences.push({ x1: g.x, y1: g.y, x2: g.x, y2: g.y + g.h, kind: 'wall' });
    fences.push({ x1: g.x + g.w, y1: g.y, x2: g.x + g.w, y2: g.y + g.h, kind: 'wall' });
    for (let t = 0; t < 5; t++) addTree(R.x + rng.range(8, R.w - 8), R.y + R.h - rng.range(6, 18), 1.1);
  };

  const halves = (R: Rect, f: Facing): [Rect, Rect] => {
    // Split a cell into the half touching side f and the other half.
    if (f === 'n' || f === 's') {
      const a = { x: R.x, y: R.y, w: R.w / 2 - 4, h: R.h };
      const b = { x: R.x + R.w / 2 + 4, y: R.y, w: R.w / 2 - 4, h: R.h };
      return [a, b];
    }
    const a = { x: R.x, y: R.y, w: R.w, h: R.h / 2 - 4 };
    const b = { x: R.x, y: R.y + R.h / 2 + 4, w: R.w, h: R.h / 2 - 4 };
    return [a, b];
  };

  const fillFirestation = (c: Cell): void => {
    const R = c.r;
    const f = frontFacing(c);
    const [a, b] = halves(R, f);
    addArea('concrete', a);
    const vertical = f === 'n' || f === 's';
    const w = vertical ? Math.min(a.w - 16, 82) : 62;
    const h = vertical ? 62 : Math.min(a.h - 16, 82);
    const fr = toWorld(a, f, 8, 22, vertical ? w : h, vertical ? h : w);
    addBuilding('firestation', fr, f, { name: 'Fire Station No. 3', sub: c.streets[f], wallH: 12, roofColor: '#5c534d', wallColor: '#7a3a2f' });
    const t = toWorld(a, f, 8 + (vertical ? w : h) * 0.5, 10, 0, 0);
    addProp('firetruck', t.x, t.y, 1, vertical ? 0.04 : Math.PI / 2 + 0.04, '#b8322a', { solid: true });
    const sub = { ...c, r: b };
    fillResidential(sub, b);
  };

  const fillGas = (c: Cell) => {
    const R = c.r;
    const f = frontFacing(c);
    const [a, b] = halves(R, f);
    addArea('concrete', a);
    const vertical = f === 'n' || f === 's';
    const L = frontLen(a, f);
    const cw = Math.min(L - 30, 76);
    const can = toWorld(a, f, (L - cw) / 2, 14, cw, 40);
    addProp('canopy', can.x + can.w / 2, can.y + can.h / 2, 1, 0, '#d8d4c8', { w: can.w, h: can.h });
    const st = toWorld(a, f, (L - 54) / 2, 72, 54, 34);
    addBuilding('gas', st, f, { name: 'Quik-Fill Station', sub: c.streets[f], wallH: 9, roofColor: '#767977', wallColor: '#9a968b' });
    const p = toWorld(a, f, (L - cw) / 2 + 10, 34, 0, 0);
    addProp('car', p.x, p.y, 1, vertical ? Math.PI / 2 : 0, rng.pick(CAR_COLORS), { solid: true });
    fillResidential({ ...c }, b);
  };

  const fillIndustrial = (c: Cell, R = c.r, factory = false) => {
    addArea('concrete', R, rng.next());
    const f = frontFacing(c);
    const L = frontLen(R, f);
    const D = depthLen(R, f);
    if (factory) {
      const br = toWorld(R, f, 16, 30, L - 32, Math.min(D * 0.52, 220));
      addBuilding('factory', br, f, { name: 'Calder Steelworks', sub: c.streets[f], wallH: 18, roofColor: '#575b5e', wallColor: '#6e6052' });
      const yard = toWorld(R, f, 10, Math.min(D * 0.52, 220) + 44, L - 20, D - Math.min(D * 0.52, 220) - 56);
      for (let t = 0; t < 10; t++) {
        const x = yard.x + rng.range(12, yard.w - 12);
        const y = yard.y + rng.range(8, yard.h - 8);
        addProp('container', x, y, 1, rng.chance(0.7) ? 0 : Math.PI / 2, rng.pick(['#8a3b2e', '#2f5d7c', '#3d6b44', '#b8892f', '#6b6f73']), { solid: true });
      }
    } else {
      const n = L > 200 ? 2 : 1;
      const seg = L / n;
      for (let t = 0; t < n; t++) {
        const bw = seg - rng.range(16, 30);
        const bd = Math.min(D - 70, rng.range(90, 140));
        const br = toWorld(R, f, t * seg + (seg - bw) / 2, 24, bw, bd);
        addBuilding('warehouse', br, f, { sub: c.streets[f], wallH: rng.int(12, 15), roofColor: rng.pick(['#5d6266', '#6b6e6a', '#545b5e', '#736b5d']) });
        const tk = toWorld(R, f, t * seg + seg / 2 + rng.range(-20, 20), 12, 0, 0);
        if (rng.chance(0.6)) addProp('truck', tk.x, tk.y, 1, f === 'n' || f === 's' ? 0 : Math.PI / 2, rng.pick(['#d8d8d0', '#8b2f2f', '#2f4f6f']), { solid: true });
      }
      const back = toWorld(R, f, 8, D - 40, L - 16, 32);
      for (let t = 0; t < 4; t++) {
        if (rng.chance(0.4)) continue;
        addProp('container', back.x + 20 + t * ((back.w - 40) / 3), back.y + back.h / 2, 1, 0, rng.pick(['#8a3b2e', '#2f5d7c', '#3d6b44', '#b8892f']), { solid: true });
      }
    }
    // chain-link perimeter (back and sides)
    const fr = R;
    fences.push({ x1: fr.x + 2, y1: fr.y + 2, x2: fr.x + 2, y2: fr.y + fr.h - 2, kind: 'chain' });
    fences.push({ x1: fr.x + fr.w - 2, y1: fr.y + 2, x2: fr.x + fr.w - 2, y2: fr.y + fr.h - 2, kind: 'chain' });
  };

  const fillRiverPark = (c: Cell) => {
    const R = c.r;
    addArea('park', R, 0.2);
    const n = (R.w * R.h) / 1100;
    for (let t = 0; t < n; t++) {
      const x = R.x + rng.range(6, R.w - 6);
      const y = R.y + rng.range(6, R.h - 6);
      if (inRiver(river, x, y, 18)) continue;
      addTree(x, y);
    }
    for (let t = 0; t < 2; t++) {
      const y = R.y + rng.range(20, R.h - 20);
      const x = riverXAt(river, y) - river.w / 2 - 22;
      if (x > R.x + 6) addProp('bench', x, y, 1, Math.PI / 2);
    }
  };

  // Build cell list.
  const cells: Cell[] = [];
  const lineHalf = (isV: boolean, idx: number) => (isV ? vW(idx) : hW(idx)) / 2;
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < ny - 1; j++) {
      let kind = kinds.get(key(i, j))!;
      if (kind === 'merged') continue;
      let i2 = i;
      let j2 = j;
      const m = merges.find((mm) => mm[0] === i && mm[1] === j);
      if (m) {
        i2 = m[2];
        j2 = m[3];
      }
      const x0 = xs[i] + lineHalf(true, i) + SIDEWALK;
      const x1 = xs[i2 + 1] - lineHalf(true, i2 + 1) - SIDEWALK;
      const y0 = ys[j] + lineHalf(false, j) + SIDEWALK;
      const y1 = ys[j2 + 1] - lineHalf(false, j2 + 1) - SIDEWALK;
      const hasH = (jj: number, ii: number) => !removed.has(`h,${ii},${jj}`) && !(ii === k && jj !== mj && !(jj === 0 || jj === ny - 1 || (jj - mj) % 2 === 0));
      const sides: Record<Facing, boolean> = {
        n: hasH(j, i),
        s: hasH(j2 + 1, i),
        w: !removed.has(`v,${i},${j}`),
        e: !removed.has(`v,${i2 + 1},${j}`),
      };
      const streets: Record<Facing, string> = {
        n: j === mj ? 'Kingsway' : `${H_STREETS[j % H_STREETS.length]} Rd`,
        s: j2 + 1 === mj ? 'Kingsway' : `${H_STREETS[(j2 + 1) % H_STREETS.length]} Rd`,
        w: i === mi ? 'Main St' : `${V_STREETS[i % V_STREETS.length]} St`,
        e: i2 + 1 === mi ? 'Main St' : `${V_STREETS[(i2 + 1) % V_STREETS.length]} St`,
      };
      if (kind === 'residential' && (i === 0 || j === 0 || i2 === nx - 2 || j2 === ny - 2) && rng.chance(0.12)) kind = 'park';
      const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      cells.push({ i, j, r, kind, sides, streets, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }

  for (const c of cells) {
    switch (c.kind) {
      case 'residential':
        fillResidential(c);
        break;
      case 'downtown':
        fillDowntown(c);
        break;
      case 'supermarket':
        fillSupermarket(c);
        break;
      case 'police':
        fillPolice(c);
        break;
      case 'plaza':
        fillPlaza(c);
        break;
      case 'park':
        fillPark(c);
        break;
      case 'hospital':
        fillHospital(c, c.r);
        break;
      case 'school':
        fillSchool(c);
        break;
      case 'church':
        fillChurch(c);
        break;
      case 'firestation':
        fillFirestation(c);
        break;
      case 'gas':
        fillGas(c);
        break;
      case 'industrial':
        fillIndustrial(c);
        break;
      case 'factory':
        fillIndustrial(c, c.r, true);
        break;
      case 'riverpark':
        fillRiverPark(c);
        break;
    }
  }

  // ---- outskirts: farmland & forest ----------------------------------------
  const town: Rect = { x: left - 20, y: top - 20, w: right - left + 40, h: bot - top + 40 };
  const fields: Rect[] = [];
  const tryField = (r: Rect) => {
    if (rectsOverlap(r, town, 40)) return;
    if (r.x < 30 || r.y < 30 || r.x + r.w > MAP_W - 30 || r.y + r.h > MAP_H - 30) return;
    for (const f of fields) if (rectsOverlap(r, f, 30)) return;
    // keep fields off roads and the river
    for (const rd of roads) {
      const rr = rd.x1 === rd.x2 ? { x: rd.x1 - rd.w, y: rd.y1, w: rd.w * 2, h: rd.y2 - rd.y1 } : { x: rd.x1, y: rd.y1 - rd.w, w: rd.x2 - rd.x1, h: rd.w * 2 };
      if (rectsOverlap(r, rr, 16)) return;
    }
    for (let y = r.y; y <= r.y + r.h; y += 20) if (inRiver(river, r.x, y, 20) || inRiver(river, r.x + r.w, y, 20) || (riverXAt(river, y) > r.x && riverXAt(river, y) < r.x + r.w)) return;
    fields.push(r);
  };
  for (let t = 0; t < 80 && fields.length < 9; t++) {
    const w = rng.range(160, 280);
    const h = rng.range(110, 200);
    const side = rng.int(0, 3);
    let x = 0;
    let y = 0;
    if (side === 0) {
      x = rng.range(40, MAP_W - w - 40);
      y = rng.range(40, top - h - 50);
    } else if (side === 1) {
      x = rng.range(40, MAP_W - w - 40);
      y = rng.range(bot + 50, MAP_H - h - 40);
    } else if (side === 2) {
      x = rng.range(40, left - w - 50);
      y = rng.range(40, MAP_H - h - 40);
    } else {
      x = rng.range(right + 50, MAP_W - w - 40);
      y = rng.range(40, MAP_H - h - 40);
    }
    tryField({ x, y, w, h });
  }
  fields.forEach((f, fi) => {
    addArea('crops', f, rng.next(), rng.chance(0.5) ? 0 : 1);
    if (fi < 4) {
      // farmstead on the edge of the field
      const fx = f.x + rng.range(10, f.w - 70);
      const fy = f.y - 70 > 20 ? f.y - 66 : f.y + f.h + 10;
      addArea('dirt', { x: fx - 10, y: fy - 6, w: 110, h: 62 });
      addBuilding('farmhouse', { x: fx, y: fy, w: 40, h: 30 }, 's', { sub: 'County Road', wallH: 9 });
      addBuilding('barn', { x: fx + 52, y: fy - 2, w: 44, h: 46 }, 's', { sub: 'County Road', roofColor: '#5e2a22', wallColor: '#6e2e24', roof: 'gable-v', wallH: 12 });
      for (let t = 0; t < 4; t++) addProp('hay', f.x + rng.range(10, f.w - 10), f.y + rng.range(10, f.h - 10), 5);
    }
  });

  // Forest: jittered grid over the outskirts.
  const isRoad = (x: number, y: number, pad: number) => {
    for (const rd of roads) {
      if (rd.x1 === rd.x2) {
        if (Math.abs(x - rd.x1) < rd.w / 2 + pad && y >= rd.y1 - pad && y <= rd.y2 + pad) return true;
      } else if (Math.abs(y - rd.y1) < rd.w / 2 + pad && x >= rd.x1 - pad && x <= rd.x2 + pad) return true;
    }
    return false;
  };
  const occupied = (x: number, y: number) => {
    for (const f of fields) if (x > f.x - 14 && x < f.x + f.w + 14 && y > f.y - 14 && y < f.y + f.h + 14) return true;
    for (const b of buildings) if (x > b.x - 20 && x < b.x + b.w + 20 && y > b.y - 20 && y < b.y + b.h + 20) return true;
    return false;
  };
  for (let gx = 0; gx < MAP_W; gx += 26)
    for (let gy = 0; gy < MAP_H; gy += 26) {
      const x = gx + rng.range(0, 22);
      const y = gy + rng.range(0, 22);
      const inTown = x > town.x - 10 && x < town.x + town.w + 10 && y > town.y - 10 && y < town.y + town.h + 10;
      if (inTown) continue;
      const edgeDist = Math.min(x - town.x, town.x + town.w - x, y - town.y, town.y + town.h - y);
      // thinner near town
      const d = -edgeDist;
      const p = clamp((d - 10) / 160, 0.12, 0.82);
      if (!rng.chance(p)) continue;
      if (isRoad(x, y, 12) || occupied(x, y) || inRiver(river, x, y, 12)) continue;
      addTree(x, y, rng.range(0.95, 1.25));
    }

  // ---- street dressing -----------------------------------------------------
  for (const rd of roads) {
    const vertical = rd.x1 === rd.x2;
    const len = vertical ? rd.y2 - rd.y1 : rd.x2 - rd.x1;
    const nCars = Math.floor((len / 260) * rng.range(0.4, 1.6));
    for (let t = 0; t < nCars; t++) {
      const s = rng.range(0.12, 0.88);
      const lane = (rng.chance(0.5) ? 1 : -1) * rd.w * 0.22;
      const x = vertical ? rd.x1 + lane : rd.x1 + len * s;
      const y = vertical ? rd.y1 + len * s : rd.y1 + lane;
      if (x < 20 || y < 20 || x > MAP_W - 20 || y > MAP_H - 20) continue;
      const skew = rng.chance(0.3) ? rng.range(-0.7, 0.7) : rng.range(-0.08, 0.08);
      const burnt = rng.chance(0.12);
      addProp(rng.chance(0.08) ? 'bus' : 'car', x, y, 1, (vertical ? Math.PI / 2 : 0) + skew + (rng.chance(0.5) ? Math.PI : 0), burnt ? '#2a2522' : rng.pick(CAR_COLORS), { solid: true, v: burnt ? 1 : 0 });
    }
    // debris & trash
    const nDeb = Math.floor(len / 70);
    for (let t = 0; t < nDeb; t++) {
      const s = rng.next();
      const off = rng.range(-rd.w / 2 - 6, rd.w / 2 + 6);
      const x = vertical ? rd.x1 + off : rd.x1 + len * s;
      const y = vertical ? rd.y1 + len * s : rd.y1 + off;
      addProp('debris', x, y, rng.range(1.5, 3.5), rng.range(0, 6.28), rng.pick(['#2a2a2a', '#5a5550', '#7b6f60', '#3e4a3e']));
    }
    if (rd.main) {
      for (let s = 50; s < len; s += 96) {
        const off = rd.w / 2 + 4;
        const x = vertical ? rd.x1 - off : rd.x1 + s;
        const y = vertical ? rd.y1 + s : rd.y1 - off;
        if (inRiver(river, x, y, 6)) continue;
        addProp('lamp', x, y, 1, vertical ? 0 : Math.PI / 2);
      }
    }
  }
  // police barricades at a couple of downtown intersections
  for (let t = 0; t < 3; t++) {
    const i = clamp(mi + rng.int(-1, 1), 0, nx - 1);
    const j = clamp(mj + rng.int(-1, 1), 0, ny - 1);
    const vertical = rng.chance(0.5);
    for (let q = -1; q <= 1; q++) {
      const x = xs[i] + (vertical ? q * 10 : 30);
      const y = ys[j] + (vertical ? 30 : q * 10);
      addProp('barrier', x, y, 1, vertical ? 0 : Math.PI / 2);
    }
  }

  // ---- HQ & entries ------------------------------------------------------
  const hq = buildings.find((b) => b.kind === 'firestation') ?? buildings[0];
  // Clear the HQ's own loot & infected (you start there).
  hq.infected = 0;
  hq.survivors = 0;
  hq.loot = { food: 0, mat: 0, ammo: 0, med: 0, guns: 0 };

  const entries: Vec[] = [
    { x: xs[mi], y: 10 },
    { x: xs[mi], y: MAP_H - 10 },
    { x: 10, y: ys[mj] },
    { x: MAP_W - 10, y: ys[mj] },
    { x: 10, y: rng.range(200, MAP_H - 200) },
    { x: MAP_W - 10, y: rng.range(200, MAP_H - 200) },
    { x: rng.range(200, MAP_W - 200), y: 10 },
    { x: rng.range(200, MAP_W - 200), y: MAP_H - 10 },
  ];

  // Sort buildings by y for painter's algorithm stability; keep ids stable.
  return {
    seed,
    townName,
    width: MAP_W,
    height: MAP_H,
    roads,
    buildings,
    areas,
    props,
    fences,
    river,
    bridges,
    hqId: hq.id,
    center,
    town,
    entries,
  };
}

// ---- tables ---------------------------------------------------------------

const CAPACITY: Record<BuildingKind, number> = {
  house: 3,
  bungalow: 2,
  apartment: 8,
  shop: 2,
  diner: 3,
  office: 4,
  supermarket: 6,
  pharmacy: 2,
  hospital: 12,
  police: 6,
  hardware: 3,
  gas: 2,
  school: 10,
  church: 6,
  warehouse: 6,
  factory: 8,
  firestation: 8,
  farmhouse: 4,
  barn: 3,
};

function defaultName(kind: BuildingKind, rng: Rng): string {
  switch (kind) {
    case 'house':
      return rng.pick(['Family Home', 'Two-Storey House', 'Townhouse', 'Duplex']);
    case 'bungalow':
      return rng.pick(['Cottage', 'Bungalow', 'Small House']);
    case 'apartment':
      return rng.pick(['Apartments', 'Tenement Block', 'Residences', 'Lofts']);
    case 'shop':
      return rng.pick(['Corner Store', 'Boutique', 'Bookshop', 'Electronics Store', 'Bakery', 'Thrift Store', 'Laundromat', 'Bank']);
    case 'diner':
      return rng.pick(["Rosie's Diner", 'Night Owl Cafe', 'Pizzeria', 'Burger Joint']);
    case 'office':
      return rng.pick(['Office Block', 'Insurance Office', 'Town Hall Annex', 'Law Offices', 'Post Office']);
    case 'pharmacy':
      return rng.pick(['Riverside Pharmacy', 'Wellcare Drugs']);
    case 'hardware':
      return 'Hammer & Nail Hardware';
    case 'warehouse':
      return rng.pick(['Warehouse', 'Distribution Depot', 'Cold Storage', 'Freight Shed']);
    case 'farmhouse':
      return 'Farmhouse';
    case 'barn':
      return 'Barn';
    default:
      return kind[0].toUpperCase() + kind.slice(1);
  }
}

type LootSpec = Partial<Record<keyof Loot, [number, number, number?]>>; // [min, max, chance]
const LOOT: Record<BuildingKind, LootSpec> = {
  house: { food: [2, 6], mat: [1, 4], ammo: [1, 4, 0.3], med: [1, 1, 0.25] },
  bungalow: { food: [1, 4], mat: [1, 3], ammo: [1, 3, 0.2], med: [1, 1, 0.2] },
  apartment: { food: [6, 14], mat: [3, 8], ammo: [2, 8, 0.4], med: [1, 2, 0.4] },
  shop: { food: [1, 5], mat: [4, 9] },
  diner: { food: [10, 18], mat: [1, 4] },
  office: { mat: [5, 11], med: [1, 2, 0.4], food: [1, 3] },
  supermarket: { food: [30, 48], mat: [4, 10], med: [1, 3, 0.6] },
  pharmacy: { med: [7, 12], food: [2, 5] },
  hospital: { med: [16, 26], food: [4, 8], mat: [4, 8] },
  police: { ammo: [45, 75], guns: [2, 3], mat: [2, 5], med: [1, 3] },
  hardware: { mat: [26, 40], ammo: [4, 10, 0.5], guns: [1, 1, 0.4] },
  gas: { food: [4, 9], mat: [6, 12] },
  school: { food: [6, 12], mat: [6, 12], med: [1, 3] },
  church: { food: [4, 9], med: [1, 3] },
  warehouse: { mat: [18, 32], food: [6, 14] },
  factory: { mat: [30, 50], ammo: [0, 6, 0.5] },
  firestation: {},
  farmhouse: { food: [8, 14], ammo: [3, 10], guns: [1, 1, 0.5] },
  barn: { food: [6, 12], mat: [6, 12] },
};

function rollLoot(kind: BuildingKind, rng: Rng): Loot {
  const spec = LOOT[kind];
  const l: Loot = { food: 0, mat: 0, ammo: 0, med: 0, guns: 0 };
  for (const k of Object.keys(spec) as (keyof Loot)[]) {
    const [a, b, p = 1] = spec[k]!;
    if (rng.chance(p)) l[k] = rng.int(a, b);
  }
  return l;
}

const INFECTED: Record<BuildingKind, [number, number, number]> = {
  // [min, max, chance of any]
  house: [1, 2, 0.4],
  bungalow: [1, 1, 0.35],
  apartment: [2, 5, 0.8],
  shop: [1, 2, 0.5],
  diner: [1, 3, 0.6],
  office: [1, 3, 0.6],
  supermarket: [4, 7, 1],
  pharmacy: [1, 3, 0.8],
  hospital: [7, 12, 1],
  police: [3, 6, 1],
  hardware: [1, 3, 0.7],
  gas: [1, 2, 0.5],
  school: [4, 8, 1],
  church: [1, 3, 0.5],
  warehouse: [2, 4, 0.7],
  factory: [3, 6, 0.9],
  firestation: [0, 0, 0],
  farmhouse: [1, 2, 0.5],
  barn: [1, 2, 0.4],
};

function rollInfected(kind: BuildingKind, rng: Rng): number {
  const [a, b, p] = INFECTED[kind];
  return rng.chance(p) ? rng.int(a, b) : 0;
}

const SURVIVORS: Partial<Record<BuildingKind, [number, number, number]>> = {
  house: [1, 1, 0.07],
  apartment: [1, 3, 0.35],
  church: [1, 3, 0.55],
  school: [1, 3, 0.5],
  hospital: [1, 2, 0.6],
  supermarket: [1, 2, 0.3],
  police: [1, 1, 0.5],
  farmhouse: [1, 2, 0.4],
  office: [1, 1, 0.12],
  diner: [1, 1, 0.1],
  warehouse: [1, 2, 0.2],
};

function rollSurvivors(kind: BuildingKind, rng: Rng): number {
  const s = SURVIVORS[kind];
  if (!s) return 0;
  return rng.chance(s[2]) ? rng.int(s[0], s[1]) : 0;
}
