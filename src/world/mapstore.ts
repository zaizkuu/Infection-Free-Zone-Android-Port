import type { MapData } from './types';

/**
 * Keeps the processed real-world map on the device (IndexedDB, with a localStorage
 * fallback) so a saved game can be continued without downloading it again.
 */

const DB = 'emberhaven';
const STORE = 'maps';
const KEY = 'current';
const LS_KEY = 'emberhaven.realmap.v1';
const EXACT = new Set(['lat', 'lon', 'seed', 'scale', 'half']);

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMap(map: MapData): Promise<void> {
  // world coordinates only need 0.1 precision (keeps the store small); geographic keys keep theirs
  const json = JSON.stringify(map, (k, v) => (typeof v === 'number' && !EXACT.has(k) ? Math.round(v * 10) / 10 : v));
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(json, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    try {
      localStorage.setItem(LS_KEY, json);
    } catch {
      /* storage full: the game still runs, it just can't be continued later */
    }
  }
}

export async function loadMap(): Promise<MapData | null> {
  try {
    const db = await openDb();
    const json = await new Promise<string | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (json) return JSON.parse(json) as MapData;
  } catch {
    /* fall through */
  }
  try {
    const json = localStorage.getItem(LS_KEY);
    return json ? (JSON.parse(json) as MapData) : null;
  } catch {
    return null;
  }
}
