/**
 * Keyboard mapping for the inspector's column grid and for the roving-tabindex
 * button rows next to it (the colour palette, the per-column flag toolbar).
 *
 * It lives away from React so the flow can be exercised without a DOM: the
 * components turn a KeyboardEvent into a KeySpec, ask what it means, and do it.
 * Nothing here touches the store or the diagram.
 */

/** The four column constraints the grid toggles, named as they are on Column. */
export type ColumnFlag = 'primaryKey' | 'nullable' | 'unique' | 'autoIncrement';

/** Where in a column row the key was pressed. */
export type ColumnField = 'name' | 'type' | 'flags';

export type ColumnAction =
  /** Add a row and put the cursor in it. */
  | { kind: 'add'; where: 'below' | 'above' }
  | { kind: 'toggle'; flag: ColumnFlag }
  /** Move the cursor one row up or down, staying in the same column of the grid. */
  | { kind: 'step'; delta: -1 | 1 }
  | { kind: 'delete' }
  | { kind: 'blur' };

/** The parts of a KeyboardEvent this module reads. */
export interface KeySpec {
  key: string;
  /** Physical key. Alt rewrites `key` on macOS (Alt+P arrives as "π"), `code` survives it. */
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Alt+letter toggles a flag without the cursor leaving the name or type box.
 * The grid labels its buttons from this, so the tooltip and the binding cannot drift.
 */
export const FLAG_SHORTCUT: Record<ColumnFlag, string> = {
  primaryKey: 'P',
  nullable: 'N',
  unique: 'U',
  autoIncrement: 'I',
};

const FLAG_KEYS: Record<string, ColumnFlag> = Object.fromEntries(
  Object.entries(FLAG_SHORTCUT).map(([flag, k]) => [k.toLowerCase(), flag as ColumnFlag]),
) as Record<string, ColumnFlag>;

/** The letter pressed, preferring the physical key so Alt combos survive macOS. */
function letter(e: KeySpec): string {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key.length === 1 ? e.key.toLowerCase() : '';
}

/**
 * What a keystroke in a column row means, or null to leave it to the browser.
 * `nameEmpty` is the row's name, not the focused field: Ctrl+Backspace deletes
 * a row that was never named, from wherever in it you happen to be.
 */
export function columnKeyAction(e: KeySpec, ctx: { field: ColumnField; nameEmpty: boolean }): ColumnAction | null {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const flag = FLAG_KEYS[letter(e)];
    return flag ? { kind: 'toggle', flag } : null;
  }
  if (e.key === 'Enter') return { kind: 'add', where: e.shiftKey ? 'above' : 'below' };
  if (e.key === 'Escape') return { kind: 'blur' };
  if (e.key === 'Backspace' && (e.ctrlKey || e.metaKey) && ctx.nameEmpty) return { kind: 'delete' };
  // The type box keeps its own arrows: they walk the datalist of type suggestions.
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && ctx.field !== 'type' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    return { kind: 'step', delta: e.key === 'ArrowUp' ? -1 : 1 };
  }
  return null;
}

/**
 * Where the arrow keys move inside a row of buttons that shares one tab stop
 * (the WAI-ARIA roving-tabindex pattern). Returns the index to focus, or null
 * when the key belongs to whoever called us. A `both` row also answers to
 * up and down, which a row that wraps onto several lines wants and a row
 * sitting inside a grid — where up and down mean "next record" — does not.
 */
export function rovingIndex(key: string, index: number, count: number, orientation: 'horizontal' | 'both' = 'horizontal'): number | null {
  if (count <= 0) return null;
  const across = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  const down = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  const delta = orientation === 'both' ? across || down : across;
  if (delta) return (((index + delta) % count) + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
