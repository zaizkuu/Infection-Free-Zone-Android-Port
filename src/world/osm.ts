import { Rng } from '../core/rng';
import { hash2 } from '../core/rng';
import { clamp, type Rect, type Vec } from '../core/math';
import { CAPACITY, CAR_COLORS, FLAT_ROOFS, HOUSE_ROOFS, HOUSE_WALLS, SHOP_WALLS, defaultName, rollInfected, rollLoot, rollSurvivors } from './mapgen';
import { assembleRings, centroid, clipPolyRect, closestOnPoly, closestOnSeg, mainAxis, pointInPoly, polyArea, polyBounds, simplify, simplifyRing } from './geo';
import type { Area, AreaKind, BuildingDef, BuildingKind, Facing, MapData, Prop, WaterBody, Way } from './types';

/**
 * Real-world maps from OpenStreetMap (© OpenStreetMap contributors, ODbL).
 * A square around the chosen point is downloaded from an Overpass API server and
 * turned into the same kind of map data the procedural generator produces.
 */

/** Half-size of the playable square, in metres. */
export const REAL_HALF = 600;
/** World units per metre (the game's units are a little larger than life so people stay readable). */
export const REAL_SCALE = 2;
export const REAL_SIZE = REAL_HALF * 2 * REAL_SCALE;
const MAX_BUILDINGS = 2400;

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export interface Place {
  lat: number;
  lon: number;
  name: string;
  detail?: string;
}

interface LatLon {
  lat: number;
  lon: number;
}
interface OsmEl {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: (LatLon | null)[];
  members?: { type: string; ref: number; role: string; geometry?: (LatLon | null)[] }[];
}
export interface OsmData {
  elements: OsmEl[];
}

// ---------------------------------------------------------------------------- network

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function overpassQuery(lat: number, lon: number, halfM = REAL_HALF + 40): string {
  const dlat = halfM / 110540;
  const dlon = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bb = `${(lat - dlat).toFixed(6)},${(lon - dlon).toFixed(6)},${(lat + dlat).toFixed(6)},${(lon + dlon).toFixed(6)}`;
  return `[out:json][timeout:60][bbox:${bb}];
(
  way["building"];
  way["highway"];
  way["landuse"];
  way["leisure"];
  way["natural"];
  way["waterway"];
  way["amenity"~"parking|grave_yard|school|hospital|university|college"];
  way["place"="square"];
  relation["building"];
  relation["natural"="water"];
  relation["landuse"];
  relation["leisure"="park"];
  relation["waterway"="riverbank"];
  node["natural"="tree"];
  node["amenity"];
  node["shop"];
);
out geom qt;`;
}

/** Downloads map data, trying several public Overpass servers in turn. */
export async function fetchOsm(lat: number, lon: number, onStatus?: (msg: string) => void, signal?: AbortSignal): Promise<OsmData> {
  const body = 'data=' + encodeURIComponent(overpassQuery(lat, lon));
  let lastErr = '';
  for (let i = 0; i < ENDPOINTS.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    const url = ENDPOINTS[i];
    onStatus?.(i === 0 ? 'Downloading map data…' : `Server busy, trying another (${i + 1}/${ENDPOINTS.length})…`);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), 70000);
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const data = (await res.json()) as OsmData;
      if (!data || !Array.isArray(data.elements)) {
        lastErr = 'bad response';
        continue;
      }
      return data;
    } catch (e) {
      if (signal?.aborted) throw new Error('cancelled');
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(`Couldn't download map data (${lastErr}). Check your internet connection and try again.`);
}

/** Place search (Nominatim). Called only when the player presses Search. */
export async function searchPlaces(q: string): Promise<Place[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const list = (await res.json()) as { lat: string; lon: string; display_name: string; name?: string }[];
  return list.map((r) => {
    const parts = r.display_name.split(',').map((s) => s.trim());
    return { lat: Number(r.lat), lon: Number(r.lon), name: r.name || parts[0], detail: parts.slice(1, 4).join(', ') };
  });
}

/** A short name for a coordinate (used for "Use my location"). */
export async function reverseName(lat: number, lon: number): Promise<string> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error('reverse lookup failed');
  const r = (await res.json()) as { name?: string; address?: Record<string, string> };
  const a = r.address ?? {};
  return a.suburb || a.neighbourhood || a.town || a.city || a.village || r.name || 'Your neighbourhood';
}

/** Suggested places that make good maps (small towns and old districts). */
export const SUGGESTED: Place[] = [
  { name: 'Hudson', detail: 'New York, USA', lat: 42.2529, lon: -73.791 },
  { name: 'Bath', detail: 'England, UK', lat: 51.3814, lon: -2.3597 },
  { name: 'Kamakura', detail: 'Kanagawa, Japan', lat: 35.3193, lon: 139.547 },
  { name: 'Annecy', detail: 'Haute-Savoie, France', lat: 45.8992, lon: 6.1294 },
  { name: 'Galway', detail: 'Ireland', lat: 53.2723, lon: -9.0532 },
  { name: 'Savannah', detail: 'Georgia, USA', lat: 32.0789, lon: -81.0911 },
];

// ---------------------------------------------------------------------------- conversion

const W = REAL_SIZE;
const S = REAL_SCALE;

/** Converts Overpass JSON into playable map data. */
export function buildRealMap(data: OsmData, place: Place): MapData {
  const seed = Math.abs(Math.floor(place.lat * 10000) * 31 + Math.floor(place.lon * 10000)) % 2147483647 || 7;
  const rng = new Rng(seed);
  const mLat = 110540;
  const mLon = 111320 * Math.cos((place.lat * Math.PI) / 180);
  const proj = (p: LatLon): Vec => ({ x: (p.lon - place.lon) * mLon * S + W / 2, y: (place.lat - p.lat) * mLat * S + W / 2 });
  const bounds: Rect = { x: -60, y: -60, w: W + 120, h: W + 120 };
  const inMap = (v: Vec, pad = 0) => v.x >= -pad && v.y >= -pad && v.x <= W + pad && v.y <= W + pad;
  const geom = (g?: (LatLon | null)[]) => (g ?? []).filter((p): p is LatLon => !!p).map(proj);
  const ring = (g?: (LatLon | null)[]) => {
    const pts = geom(g);
    if (pts.length > 2 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    return pts;
  };
  const closed = (g?: (LatLon | null)[]) => {
    const gg = (g ?? []).filter(Boolean) as LatLon[];
    return gg.length > 3 && gg[0].lat === gg[gg.length - 1].lat && gg[0].lon === gg[gg.length - 1].lon;
  };
  /** Polygons of an element: a closed way, or the assembled outer rings of a multipolygon. */
  const polysOf = (e: OsmEl): Vec[][] => {
    if (e.type === 'way') return closed(e.geometry) ? [ring(e.geometry)] : [];
    if (e.type === 'relation' && e.members) {
      const outers = e.members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '')).map((m) => geom(m.geometry));
      return assembleRings(outers);
    }
    return [];
  };
  const clipSimplify = (p: Vec[], tol: number): Vec[] => {
    const b = polyBounds(p);
    let q = p;
    if (b.x < bounds.x || b.y < bounds.y || b.x + b.w > bounds.x + bounds.w || b.y + b.h > bounds.y + bounds.h) q = clipPolyRect(p, bounds);
    return q.length >= 3 ? simplifyRing(q, tol) : [];
  };

  const els = data.elements;
  const ways: Way[] = [];
  const water: WaterBody[] = [];
  const areas: Area[] = [];
  const props: Prop[] = [];
  const pois: { x: number; y: number; tags: Record<string, string> }[] = [];
  const rawBuildings: { poly: Vec[]; tags: Record<string, string>; area: number }[] = [];
  const landuse: { poly: Vec[]; v: number }[] = [];
  const forests: Vec[][] = [];
  const parks: Vec[][] = [];

  const addArea = (kind: AreaKind, poly: Vec[], v = 0.5, o?: number) => {
    if (poly.length < 3) return;
    const b = polyBounds(poly);
    if (b.w < 2 || b.h < 2) return;
    areas.push({ kind, x: b.x, y: b.y, w: b.w, h: b.h, v, o, poly });
  };

  for (const e of els) {
    const t = e.tags ?? {};
    if (e.type === 'node') {
      if (e.lat === undefined || e.lon === undefined) continue;
      const p = proj({ lat: e.lat, lon: e.lon });
      if (!inMap(p, 40)) continue;
      if (t.natural === 'tree') props.push({ kind: 'tree', x: p.x, y: p.y, r: rng.range(9, 14), a: rng.range(0, 6.28), c: '', v: rng.next() });
      else if (t.amenity || t.shop || t.office) pois.push({ x: p.x, y: p.y, tags: t });
      continue;
    }
    // buildings
    if (t.building && t.building !== 'no' && t.building !== 'roof' && !t['building:part'] && t.location !== 'underground') {
      for (const p of polysOf(e)) {
        const q = simplifyRing(p, 0.7);
        if (q.length < 3) continue;
        const area = Math.abs(polyArea(q));
        if (area < 30) continue;
        const c = centroid(q);
        if (!inMap(c, -8)) continue;
        rawBuildings.push({ poly: q, tags: t, area });
      }
      continue;
    }
    // roads & paths
    if (t.highway && e.type === 'way') {
      if (t.tunnel === 'yes' || t.tunnel === 'building_passage') continue;
      const hw = t.highway;
      if (t.area === 'yes' || (hw === 'pedestrian' && closed(e.geometry))) {
        for (const p of polysOf(e)) addArea('plaza', clipSimplify(p, 0.8));
        continue;
      }
      let kind: Way['kind'];
      let w: number;
      if (/^(motorway|trunk|primary|secondary)(_link)?$/.test(hw)) [kind, w] = ['major', 22];
      else if (/^tertiary(_link)?$/.test(hw)) [kind, w] = ['major', 18];
      else if (/^(residential|unclassified|living_street|road)$/.test(hw)) [kind, w] = ['minor', 15];
      else if (hw === 'service' || hw === 'track') [kind, w] = ['service', hw === 'track' ? 8 : 10];
      else if (hw === 'pedestrian') [kind, w] = ['pedestrian', 12];
      else if (/^(footway|path|cycleway|steps|bridleway|corridor)$/.test(hw)) [kind, w] = ['path', 4];
      else continue;
      const pts = simplify(geom(e.geometry), 0.6);
      if (pts.length < 2 || !pts.some((p) => inMap(p, 80))) continue;
      ways.push({ pts, w, kind, bridge: t.bridge === 'yes' || t.bridge === 'viaduct', name: t.name ?? '' });
      continue;
    }
    // water
    const isWaterPoly = t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin' || t.waterway === 'dock';
    if (isWaterPoly) {
      for (const p of polysOf(e)) {
        const q = clipSimplify(p, 1.2);
        if (q.length >= 3) water.push({ poly: q });
      }
      continue;
    }
    if (t.waterway && e.type === 'way' && t.tunnel !== 'culvert' && t.tunnel !== 'yes') {
      const w = t.waterway === 'river' ? 36 : t.waterway === 'canal' ? 22 : t.waterway === 'stream' ? 7 : t.waterway === 'ditch' || t.waterway === 'drain' ? 4 : 0;
      const pts = simplify(geom(e.geometry), 1);
      if (w && pts.length >= 2 && pts.some((p) => inMap(p, 80))) water.push({ line: pts, w });
      continue;
    }
    // land cover
    const polys = () => polysOf(e).map((p) => clipSimplify(p, 1));
    if (t.landuse === 'forest' || t.natural === 'wood') {
      for (const p of polys()) if (p.length >= 3) {
        addArea('forest', p);
        forests.push(p);
      }
    } else if (t.natural === 'scrub' || t.natural === 'heath' || t.natural === 'grassland') {
      for (const p of polys()) addArea('park', p, 0.2);
    } else if (t.natural === 'wetland') {
      for (const p of polys()) addArea('wetland', p);
    } else if (t.natural === 'beach' || t.natural === 'sand' || t.leisure === 'beach_resort') {
      for (const p of polys()) addArea('sand', p);
    } else if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'common' || t.leisure === 'dog_park' || t.leisure === 'golf_course' || t.leisure === 'nature_reserve' || t.landuse === 'grass' || t.landuse === 'meadow' || t.landuse === 'village_green' || t.landuse === 'recreation_ground') {
      for (const p of polys()) if (p.length >= 3) {
        addArea('park', p);
        parks.push(p);
      }
    } else if (t.leisure === 'pitch' || t.leisure === 'sports_centre' || t.leisure === 'stadium' || t.leisure === 'track') {
      for (const p of polys()) addArea('lawn', p, 0.1);
    } else if (t.leisure === 'playground') {
      for (const p of polys()) addArea('dirt', p);
    } else if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') {
      for (const p of polys()) addArea('graveyard', p);
    } else if (/^(farmland|orchard|vineyard|allotments|plant_nursery|greenhouse_horticulture)$/.test(t.landuse ?? '')) {
      for (const p of polys()) addArea('crops', p, rng.next(), rng.chance(0.5) ? 0 : 1);
    } else if (/^(farmyard|construction|brownfield|landfill|quarry)$/.test(t.landuse ?? '')) {
      for (const p of polys()) addArea('dirt', p);
    } else if (t.amenity === 'parking') {
      for (const p of polys()) addArea('parking', p, rng.next(), 2);
    } else if (t.amenity === 'school' || t.amenity === 'university' || t.amenity === 'college' || t.amenity === 'hospital' || t.landuse === 'religious') {
      for (const p of polys()) addArea('lawn', p, 0.6);
    } else if (t.place === 'square') {
      for (const p of polys()) addArea('plaza', p);
    } else if (t.landuse === 'residential') {
      for (const p of polys()) if (p.length >= 3) {
        addArea('tint', p, 0);
        landuse.push({ poly: p, v: 0 });
      }
    } else if (t.landuse === 'commercial' || t.landuse === 'retail') {
      for (const p of polys()) if (p.length >= 3) {
        addArea('tint', p, 1);
        landuse.push({ poly: p, v: 1 });
      }
    } else if (t.landuse === 'industrial' || t.landuse === 'railway') {
      for (const p of polys()) if (p.length >= 3) {
        addArea('tint', p, 2);
        landuse.push({ poly: p, v: 2 });
      }
    } else if (t.natural === 'tree_row' && e.type === 'way') {
      const pts = geom(e.geometry);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        for (let s = 0; s < len; s += 18) props.push({ kind: 'tree', x: a.x + ((b.x - a.x) * s) / len, y: a.y + ((b.y - a.y) * s) / len, r: rng.range(8, 12), a: rng.range(0, 6.28), c: '', v: rng.next() });
      }
    }
  }

  // ---- occupancy raster (buildings, roads, water) for placing trees & cars
  const OC = 8;
  const ow = Math.ceil(W / OC);
  const occ = new Uint8Array(ow * ow);
  const markDisc = (x: number, y: number, r: number) => {
    const x0 = Math.max(0, Math.floor((x - r) / OC));
    const y0 = Math.max(0, Math.floor((y - r) / OC));
    const x1 = Math.min(ow - 1, Math.floor((x + r) / OC));
    const y1 = Math.min(ow - 1, Math.floor((y + r) / OC));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) occ[cy * ow + cx] = 1;
  };
  const markPoly = (p: Vec[], pad = 0) => {
    const b = polyBounds(p);
    for (let cy = Math.max(0, Math.floor((b.y - pad) / OC)); cy <= Math.min(ow - 1, Math.floor((b.y + b.h + pad) / OC)); cy++)
      for (let cx = Math.max(0, Math.floor((b.x - pad) / OC)); cx <= Math.min(ow - 1, Math.floor((b.x + b.w + pad) / OC)); cx++)
        if (pointInPoly(p, cx * OC + OC / 2, cy * OC + OC / 2)) occ[cy * ow + cx] = 1;
  };
  const free = (x: number, y: number) => x > 0 && y > 0 && x < W && y < W && !occ[Math.floor(y / OC) * ow + Math.floor(x / OC)];
  for (const wy of ways) {
    for (let i = 1; i < wy.pts.length; i++) {
      const a = wy.pts[i - 1];
      const b = wy.pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let s = 0; s <= len; s += 4) markDisc(a.x + ((b.x - a.x) * s) / len, a.y + ((b.y - a.y) * s) / len, wy.w / 2 + (wy.kind === 'path' ? 1 : 6));
    }
  }
  for (const wb of water) {
    if (wb.poly) markPoly(wb.poly, 4);
    if (wb.line) for (const p of wb.line) markDisc(p.x, p.y, (wb.w ?? 4) / 2 + 4);
  }

  // ---- buildings
  rawBuildings.sort((a, b) => b.area - a.area);
  {
    // drop footprints nested inside a bigger building (duplicates, mis-tagged parts)
    const G = 120;
    const gw = Math.ceil(W / G) + 1;
    const grid = new Map<number, Vec[][]>();
    const kept: typeof rawBuildings = [];
    for (const rb of rawBuildings) {
      const c = centroid(rb.poly);
      const key = Math.floor(c.y / G) * gw + Math.floor(c.x / G);
      let inside = false;
      for (let dy = -1; dy <= 1 && !inside; dy++)
        for (let dx = -1; dx <= 1 && !inside; dx++)
          for (const o of grid.get(key + dy * gw + dx) ?? []) if (pointInPoly(o, c.x, c.y)) inside = true;
      if (inside) continue;
      kept.push(rb);
      const bb = polyBounds(rb.poly);
      for (let gy = Math.floor(bb.y / G); gy <= Math.floor((bb.y + bb.h) / G); gy++)
        for (let gx = Math.floor(bb.x / G); gx <= Math.floor((bb.x + bb.w) / G); gx++) {
          const k = gy * gw + gx;
          const cell = grid.get(k);
          if (cell) cell.push(rb.poly);
          else grid.set(k, [rb.poly]);
        }
    }
    rawBuildings.length = 0;
    rawBuildings.push(...kept);
  }
  if (rawBuildings.length > MAX_BUILDINGS) rawBuildings.length = MAX_BUILDINGS;
  // POIs inside buildings
  const landuseAt = (x: number, y: number) => {
    for (const l of landuse) if (pointInPoly(l.poly, x, y)) return l.v;
    return -1;
  };
  const poiFor = (poly: Vec[]) => {
    const b = polyBounds(poly);
    return pois.filter((q) => q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h && pointInPoly(poly, q.x, q.y));
  };
  // spatial grid of drivable road segments for doors
  const SEG = 80;
  const sw = Math.ceil(W / SEG) + 1;
  const segGrid: [Vec, Vec, string][][] = Array.from({ length: sw * sw }, () => []);
  for (const wy of ways) {
    if (wy.kind === 'path') continue;
    for (let i = 1; i < wy.pts.length; i++) {
      const a = wy.pts[i - 1];
      const b = wy.pts[i];
      const x0 = clamp(Math.floor(Math.min(a.x, b.x) / SEG), 0, sw - 1);
      const x1 = clamp(Math.floor(Math.max(a.x, b.x) / SEG), 0, sw - 1);
      const y0 = clamp(Math.floor(Math.min(a.y, b.y) / SEG), 0, sw - 1);
      const y1 = clamp(Math.floor(Math.max(a.y, b.y) / SEG), 0, sw - 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) segGrid[y * sw + x].push([a, b, wy.name]);
    }
  }
  const nearestRoad = (x: number, y: number): { p: Vec; name: string } | null => {
    let best: { p: Vec; name: string } | null = null;
    let bd = 150 * 150;
    const cx = clamp(Math.floor(x / SEG), 0, sw - 1);
    const cy = clamp(Math.floor(y / SEG), 0, sw - 1);
    for (let yy = Math.max(0, cy - 2); yy <= Math.min(sw - 1, cy + 2); yy++)
      for (let xx = Math.max(0, cx - 2); xx <= Math.min(sw - 1, cx + 2); xx++)
        for (const [a, b, name] of segGrid[yy * sw + xx]) {
          const c = closestOnSeg(a.x, a.y, b.x, b.y, x, y);
          const d = (c.x - x) ** 2 + (c.y - y) ** 2;
          if (d < bd) {
            bd = d;
            best = { p: c, name };
          }
        }
    return best;
  };

  const buildings: BuildingDef[] = [];
  for (const rb of rawBuildings) {
    const poly = rb.poly;
    const c = centroid(poly);
    const inside = poiFor(poly);
    const kind = classify(rb.tags, inside.map((q) => q.tags), rb.area, landuseAt(c.x, c.y));
    const levels = Number(rb.tags['building:levels']) || (Number(rb.tags.height) ? Number(rb.tags.height) / 3 : 0) || DEFAULT_LEVELS[kind];
    const wallH = Math.round(clamp(4 + levels * 2.4, 6, 20));
    const pitched = ['house', 'bungalow', 'farmhouse', 'barn', 'church'].includes(kind) && rb.area < 2600;
    const h = (n: number) => hash2(buildings.length, n, seed);
    const flat = !pitched;
    const road = nearestRoad(c.x, c.y);
    let door: Vec;
    if (road) {
      const edge = closestOnPoly(poly, road.p.x, road.p.y);
      const dx = edge.x - c.x;
      const dy = edge.y - c.y;
      const dl = Math.hypot(dx, dy) || 1;
      door = { x: edge.x + (dx / dl) * 7, y: edge.y + (dy / dl) * 7 };
    } else {
      const b = polyBounds(poly);
      door = { x: c.x, y: b.y + b.h + 7 };
    }
    const fdx = door.x - c.x;
    const fdy = door.y - c.y;
    const facing: Facing = Math.abs(fdx) > Math.abs(fdy) ? (fdx > 0 ? 'e' : 'w') : fdy > 0 ? 's' : 'n';
    const fb = polyBounds(poly);
    const named = rb.tags.name || inside.find((q) => q.tags.name)?.tags.name;
    const street = rb.tags['addr:street'] || road?.name || '';
    const num = rb.tags['addr:housenumber'];
    buildings.push({
      id: buildings.length,
      kind,
      name: named || defaultName(kind, rng),
      sub: num && street ? `${num} ${street}` : street,
      x: fb.x,
      y: fb.y - wallH,
      w: fb.w,
      h: fb.h + wallH,
      wallH,
      roof: flat ? 'flat' : 'gable-h',
      roofColor: flat ? FLAT_ROOFS[Math.floor(h(1) * FLAT_ROOFS.length)] : HOUSE_ROOFS[Math.floor(h(1) * HOUSE_ROOFS.length)],
      wallColor: flat ? SHOP_WALLS[Math.floor(h(2) * SHOP_WALLS.length)] : HOUSE_WALLS[Math.floor(h(2) * HOUSE_WALLS.length)],
      door,
      facing,
      capacity: CAPACITY[kind],
      baseHp: Math.round(260 + rb.area / 12),
      loot: rollLoot(kind, rng),
      infected: rollInfected(kind, rng),
      survivors: rollSurvivors(kind, rng),
      poly,
      ridge: pitched ? mainAxis(poly) : undefined,
    });
    markPoly(poly, 3);
  }

  // ---- trees in woods, parks and yards
  const scatter = (p: Vec[], spacing: number, chance: number, max: number) => {
    const b = polyBounds(p);
    let n = 0;
    for (let y = b.y + rng.range(0, spacing); y < b.y + b.h && n < max; y += spacing)
      for (let x = b.x + rng.range(0, spacing); x < b.x + b.w && n < max; x += spacing) {
        const tx = x + rng.range(-spacing * 0.35, spacing * 0.35);
        const ty = y + rng.range(-spacing * 0.35, spacing * 0.35);
        if (!rng.chance(chance) || !pointInPoly(p, tx, ty) || !free(tx, ty)) continue;
        const pine = rng.chance(0.25);
        props.push({ kind: pine ? 'pine' : 'tree', x: tx, y: ty, r: (pine ? rng.range(8, 12) : rng.range(9, 15)) * rng.range(0.95, 1.2), a: rng.range(0, 6.28), c: '', v: rng.next() });
        n++;
      }
  };
  for (const f of forests) scatter(f, 22, 0.85, 900);
  for (const p of parks) scatter(p, 34, 0.45, 160);
  for (const l of landuse) if (l.v === 0) scatter(l.poly, 40, 0.18, 260);

  // ---- parked & abandoned cars along streets
  let cars = 0;
  for (const wy of ways) {
    if (wy.kind !== 'major' && wy.kind !== 'minor') continue;
    for (let i = 1; i < wy.pts.length && cars < 380; i++) {
      const a = wy.pts[i - 1];
      const b = wy.pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      for (let s = rng.range(10, 50); s < len - 10; s += rng.range(55, 140)) {
        if (!rng.chance(0.5)) continue;
        const side = rng.chance(0.5) ? 1 : -1;
        const off = (wy.w / 2 - 4) * side;
        const x = a.x + Math.cos(ang) * s - Math.sin(ang) * off;
        const y = a.y + Math.sin(ang) * s + Math.cos(ang) * off;
        if (!inMap({ x, y }, -10)) continue;
        const burnt = rng.chance(0.12);
        const skew = rng.chance(0.3) ? rng.range(-0.6, 0.6) : rng.range(-0.06, 0.06);
        props.push({ kind: rng.chance(0.06) ? 'truck' : 'car', x, y, r: 1, a: ang + skew + (side < 0 ? Math.PI : 0), c: burnt ? '#2a2522' : rng.pick(CAR_COLORS), v: burnt ? 1 : 0, solid: true });
        cars++;
      }
    }
  }
  for (const a of areas) {
    if (a.kind !== 'parking' || !a.poly) continue;
    for (let k = 0; k < Math.min(24, (a.w * a.h) / 900); k++) {
      const x = a.x + rng.range(0, a.w);
      const y = a.y + rng.range(0, a.h);
      if (!pointInPoly(a.poly, x, y) || !free(x, y)) continue;
      props.push({ kind: 'car', x, y, r: 1, a: rng.chance(0.5) ? 0 : Math.PI / 2, c: rng.pick(CAR_COLORS), v: 0, solid: true });
    }
  }
  // service vehicles at their stations (some of these become drivable)
  for (const b of buildings) {
    const k = b.kind === 'police' ? 'police' : b.kind === 'firestation' ? 'firetruck' : b.kind === 'warehouse' || b.kind === 'factory' || b.kind === 'supermarket' ? 'truck' : null;
    if (!k || !rng.chance(k === 'truck' ? 0.4 : 0.9)) continue;
    const dx = b.door.x - (b.x + b.w / 2);
    const dy = b.door.y - (b.y + b.h / 2);
    const dl = Math.hypot(dx, dy) || 1;
    const x = b.door.x + (dx / dl) * 10;
    const y = b.door.y + (dy / dl) * 10;
    props.push({ kind: k, x, y, r: 1, a: Math.atan2(dy, dx) + Math.PI / 2, c: k === 'police' ? '#e8e8e8' : rng.pick(CAR_COLORS), v: 0, solid: true });
  }
  // street litter
  for (const wy of ways) {
    if (wy.kind === 'path') continue;
    for (let i = 1; i < wy.pts.length; i++) {
      const a = wy.pts[i - 1];
      const b = wy.pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let s = 0; s < len; s += 75) {
        if (!rng.chance(0.6)) continue;
        const t = rng.next();
        const off = rng.range(-wy.w / 2 - 4, wy.w / 2 + 4);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        props.push({ kind: 'debris', x: a.x + (b.x - a.x) * t - Math.sin(ang) * off, y: a.y + (b.y - a.y) * t + Math.cos(ang) * off, r: rng.range(1.5, 3.5), a: rng.range(0, 6.28), c: rng.pick(['#2a2a2a', '#5a5550', '#7b6f60', '#3e4a3e']), v: 0 });
      }
    }
  }

  // ---- haven HQ: a fire station near the middle if there is one, else something sturdy
  const mid = { x: W / 2, y: W / 2 };
  const dist = (b: BuildingDef) => Math.hypot(b.x + b.w / 2 - mid.x, b.y + b.h / 2 - mid.y);
  const pickHq = () => {
    for (const kinds of [['firestation'], ['police'], ['church', 'school', 'office', 'apartment', 'supermarket']]) {
      const c = buildings.filter((b) => kinds.includes(b.kind) && dist(b) < (kinds[0] === 'firestation' ? 700 : 520) && b.w * b.h > 700).sort((a, b) => dist(a) - dist(b));
      if (c.length) return c[0];
    }
    return buildings.filter((b) => b.w * b.h > 500).sort((a, b) => dist(a) - dist(b))[0] ?? buildings[0];
  };
  const hq = pickHq();
  if (!hq) throw new Error('No buildings found here. Try a town or city centre.');
  hq.infected = 0;
  hq.survivors = 0;
  hq.loot = { food: 0, mat: 0, ammo: 0, med: 0, guns: 0, fuel: 0 };
  if (hq.kind !== 'firestation') hq.name = `${hq.name} (Haven)`;

  // ---- horde entry points where roads leave the map
  const entries: Vec[] = [];
  for (const wy of ways) {
    if (wy.kind !== 'major' && wy.kind !== 'minor') continue;
    for (let i = 1; i < wy.pts.length; i++) {
      const a = wy.pts[i - 1];
      const b = wy.pts[i];
      if (inMap(a) === inMap(b)) continue;
      const pIn = inMap(a) ? a : b;
      const p = { x: clamp(pIn.x, 12, W - 12), y: clamp(pIn.y, 12, W - 12) };
      if (entries.every((e) => Math.hypot(e.x - p.x, e.y - p.y) > 260)) entries.push(p);
    }
  }
  while (entries.length < 6) {
    const side = rng.int(0, 3);
    const t = rng.range(150, W - 150);
    entries.push(side === 0 ? { x: t, y: 12 } : side === 1 ? { x: t, y: W - 12 } : side === 2 ? { x: 12, y: t } : { x: W - 12, y: t });
  }

  return {
    seed,
    townName: place.name,
    width: W,
    height: W,
    roads: [],
    buildings,
    areas,
    props,
    fences: [],
    river: { pts: [], w: 0, step: 16, y0: 0 },
    bridges: [],
    hqId: hq.id,
    center: mid,
    town: { x: 60, y: 60, w: W - 120, h: W - 120 },
    entries,
    real: { lat: place.lat, lon: place.lon, name: place.name, half: REAL_HALF, scale: REAL_SCALE },
    ways,
    water,
  };
}

const DEFAULT_LEVELS: Record<BuildingKind, number> = {
  house: 2,
  bungalow: 1,
  apartment: 4,
  shop: 2,
  diner: 2,
  office: 3,
  supermarket: 2,
  pharmacy: 2,
  hospital: 4,
  police: 2,
  hardware: 2,
  gas: 1,
  school: 2,
  church: 4,
  warehouse: 3,
  factory: 4,
  firestation: 2,
  farmhouse: 2,
  barn: 2,
};

/** Maps OSM tags (on the building and any shops/amenities inside it) to a game building type. */
function classify(t: Record<string, string>, inside: Record<string, string>[], area: number, landuse: number): BuildingKind {
  const all = [t, ...inside];
  const any = (k: string, re: RegExp) => all.some((x) => x[k] !== undefined && re.test(x[k]));
  if (any('amenity', /^fire_station$/) || t.building === 'fire_station') return 'firestation';
  if (any('amenity', /^police$/)) return 'police';
  if (any('amenity', /^(hospital)$/) || t.building === 'hospital') return area > 2500 ? 'hospital' : 'pharmacy';
  if (any('amenity', /^(clinic|doctors|dentist|pharmacy)$/) || any('shop', /^(chemist|medical_supply)$/)) return 'pharmacy';
  if (any('amenity', /^(school|college|university|kindergarten)$/) || /^(school|university|college|kindergarten)$/.test(t.building ?? '')) return 'school';
  if (any('amenity', /^place_of_worship$/) || /^(church|cathedral|chapel|mosque|temple|synagogue|shrine|religious)$/.test(t.building ?? '')) return 'church';
  if (any('amenity', /^fuel$/)) return 'gas';
  if (any('shop', /^(supermarket|department_store|wholesale|mall|general)$/) || t.building === 'supermarket') return area > 1200 ? 'supermarket' : 'shop';
  if (any('shop', /^(hardware|doityourself|trade|building_materials|garden_centre)$/)) return 'hardware';
  if (any('amenity', /^(restaurant|cafe|fast_food|pub|bar|food_court|biergarten|ice_cream)$/)) return 'diner';
  if (inside.some((x) => x.shop) || t.shop || /^(retail|commercial|kiosk|shop)$/.test(t.building ?? '')) return area > 3000 ? 'supermarket' : 'shop';
  if (any('amenity', /^(bank|post_office|townhall|library|community_centre|courthouse|social_facility|arts_centre|theatre|cinema)$/) || t.office || t.building === 'office' || t.building === 'civic' || t.building === 'public' || t.building === 'government') return 'office';
  const b = t.building ?? 'yes';
  if (/^(industrial|warehouse|manufacture|hangar|storage_tank|factory|service)$/.test(b)) return area > 6000 ? 'factory' : 'warehouse';
  if (/^(barn|farm_auxiliary|stable|cowshed|greenhouse|sty)$/.test(b)) return 'barn';
  if (b === 'farm') return 'farmhouse';
  if (/^(apartments|dormitory|residential|hotel)$/.test(b)) return area < 500 ? 'house' : 'apartment';
  if (/^(house|detached|semidetached_house|terrace|bungalow|cabin|hut|static_caravan)$/.test(b)) return area < 220 ? 'bungalow' : 'house';
  if (/^(garage|garages|carport|shed|outbuilding)$/.test(b)) return 'bungalow';
  // unknown: decide by size and neighbourhood
  if (area < 200) return 'bungalow';
  if (landuse === 2) return area > 6000 ? 'factory' : 'warehouse';
  if (landuse === 1) return area > 3000 ? 'supermarket' : 'shop';
  if (area < 800) return 'house';
  if (area < 3000) return landuse === 0 ? 'apartment' : 'office';
  return landuse === 0 ? 'apartment' : 'warehouse';
}
