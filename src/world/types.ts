import type { Rect, Vec } from '../core/math';

export type BuildingKind =
  | 'house'
  | 'bungalow'
  | 'apartment'
  | 'shop'
  | 'diner'
  | 'office'
  | 'supermarket'
  | 'pharmacy'
  | 'hospital'
  | 'police'
  | 'hardware'
  | 'gas'
  | 'school'
  | 'church'
  | 'warehouse'
  | 'factory'
  | 'firestation'
  | 'farmhouse'
  | 'barn';

export type RoofStyle = 'gable-h' | 'gable-v' | 'hip' | 'flat';
export type Facing = 'n' | 's' | 'e' | 'w';

export interface Loot {
  food: number;
  mat: number;
  ammo: number;
  med: number;
  guns: number;
}

export const emptyLoot = (): Loot => ({ food: 0, mat: 0, ammo: 0, med: 0, guns: 0 });
export const lootTotal = (l: Loot) => l.food + l.mat + l.ammo + l.med + l.guns;

/** Static (generated) building definition. Dynamic state lives in the game state. */
export interface BuildingDef extends Rect {
  id: number;
  kind: BuildingKind;
  name: string;
  sub: string;
  wallH: number;
  roof: RoofStyle;
  roofColor: string;
  wallColor: string;
  door: Vec;
  facing: Facing;
  capacity: number;
  baseHp: number;
  /** Generated starting contents. */
  loot: Loot;
  infected: number;
  survivors: number;
  /** Extra decorative parts drawn with the building (e.g. steeple, helipad). */
  deco?: string;
}

export type AreaKind =
  | 'lawn'
  | 'yard'
  | 'parking'
  | 'plaza'
  | 'park'
  | 'field'
  | 'crops'
  | 'dirt'
  | 'court'
  | 'track'
  | 'concrete'
  | 'pond'
  | 'pool'
  | 'path'
  | 'driveway'
  | 'graveyard'
  | 'lot';

export interface Area extends Rect {
  kind: AreaKind;
  /** Free-form variant number for colouring / details. */
  v: number;
  /** For parking: stall orientation, 0 = vertical stalls, 1 = horizontal stalls. */
  o?: number;
}

export type PropKind =
  | 'tree'
  | 'pine'
  | 'bush'
  | 'car'
  | 'truck'
  | 'firetruck'
  | 'police'
  | 'bus'
  | 'dumpster'
  | 'container'
  | 'bench'
  | 'lamp'
  | 'debris'
  | 'canopy'
  | 'stone'
  | 'shed'
  | 'hay'
  | 'barrier'
  | 'fountain';

export interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  /** Size / radius. */
  r: number;
  /** Rotation in radians. */
  a: number;
  /** Colour or variant. */
  c: string;
  v: number;
  /** Whether the prop blocks movement. */
  solid?: boolean;
  /** Extra dimensions for rectangular props. */
  w?: number;
  h?: number;
}

export interface Fence {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'wood' | 'chain' | 'hedge' | 'wall';
}

export interface Road {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  main: boolean;
  bridge: boolean;
  name: string;
}

export interface River {
  /** Centerline samples, ordered by y. */
  pts: Vec[];
  w: number;
  step: number;
  y0: number;
}

export interface MapData {
  seed: number;
  townName: string;
  width: number;
  height: number;
  roads: Road[];
  buildings: BuildingDef[];
  areas: Area[];
  props: Prop[];
  fences: Fence[];
  river: River;
  bridges: Rect[];
  hqId: number;
  center: Vec;
  /** Grid bounds (inside this is the town, outside is forest/farmland). */
  town: Rect;
  /** Points on the map edge where hordes can enter (end of highways etc). */
  entries: Vec[];
}
