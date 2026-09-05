/** Recent queries, kept in localStorage so the Query tab remembers what you ran. */

const KEY = 'dbviz:queryHistory';
const LIMIT = 30;

export interface HistoryEntry {
  sql: string;
  at: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadHistory(): HistoryEntry[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is HistoryEntry => Boolean(e) && typeof e === 'object' && typeof (e as HistoryEntry).sql === 'string' && typeof (e as HistoryEntry).at === 'number');
  } catch {
    return [];
  }
}

/** Adds a query to the front, dropping an earlier identical one; returns the new list. */
export function pushHistory(sql: string): HistoryEntry[] {
  const trimmed = sql.trim();
  if (!trimmed) return loadHistory();
  const next = [{ sql: trimmed, at: Date.now() }, ...loadHistory().filter((e) => e.sql !== trimmed)].slice(0, LIMIT);
  storage()?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearHistory(): void {
  storage()?.removeItem(KEY);
}
