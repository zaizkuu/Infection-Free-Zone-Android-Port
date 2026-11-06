import type { GameState } from './game/state';

const KEY = 'emberhaven.save.v1';
const PREFS = 'emberhaven.prefs.v1';

export function saveGame(st: GameState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const st = JSON.parse(raw) as GameState;
    if (st.version !== 1 || st.over) return null;
    return st;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function hasSave(): boolean {
  return loadGame() !== null;
}

export interface Prefs {
  sound: boolean;
}

export function loadPrefs(): Prefs {
  try {
    return { sound: true, ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { sound: true };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
