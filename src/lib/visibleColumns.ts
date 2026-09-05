import type { Column, Table, TableDisplay } from '@shared/types';

/** What a table node shows: every column, only keys, or the header alone. */
export type TableDisplayMode = 'full' | 'keys' | 'header';

/** The mode a table renders in, given its own setting and the zoom-driven level of detail. */
export function effectiveDisplay(t: Pick<Table, 'collapsed'>, lodCollapsed: boolean): TableDisplayMode {
  if (lodCollapsed) return 'header';
  return t.collapsed ?? 'full';
}

/** Columns drawn on the canvas for a mode. `fkColumnIds` are the referencing columns of the table's foreign keys. */
export function visibleColumns(t: Pick<Table, 'columns'>, mode: TableDisplayMode, fkColumnIds: Set<string>): Column[] {
  if (mode === 'full') return t.columns;
  if (mode === 'header') return [];
  return t.columns.filter((c) => c.primaryKey || fkColumnIds.has(c.id));
}

/** The next mode when the header chevron is clicked: full -> keys -> header -> full. */
export function nextDisplay(current: TableDisplay | undefined): TableDisplay | undefined {
  if (!current) return 'keys';
  if (current === 'keys') return 'header';
  return undefined;
}

export function displayLabel(mode: TableDisplayMode): string {
  return mode === 'full' ? 'All columns' : mode === 'keys' ? 'Keys only' : 'Header only';
}
