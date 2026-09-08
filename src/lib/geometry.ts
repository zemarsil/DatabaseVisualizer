import type { Diagram } from '@shared/types';
import { effectiveDisplay, visibleColumns } from './visibleColumns';

/** Pixel constants shared by the table node CSS, the edge router and the auto-layout. */
export const NODE_MIN_WIDTH = 240;
export const NODE_MAX_WIDTH = 420;
export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 28;
export const FOOTER_HEIGHT = 8;
export const EMPTY_TABLE_HEIGHT = 34;

/** Estimated node size before React Flow has measured it. */
export function estimateNodeSize(columns: { name: string; type: string }[]): { width: number; height: number } {
  const longest = columns.reduce((m, c) => Math.max(m, c.name.length + c.type.length), 12);
  const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, 90 + longest * 7.2));
  const height = HEADER_HEIGHT + (columns.length ? columns.length * ROW_HEIGHT : EMPTY_TABLE_HEIGHT) + FOOTER_HEIGHT;
  return { width, height };
}

/** Vertical centre of a column row, relative to the node's top. */
export function rowCenterY(rowIndex: number): number {
  return HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export type SizeMap = Record<string, { width: number; height: number }>;

/**
 * The sizes tables should be *placed* by, which are not always the sizes they
 * are currently *drawn* at.
 *
 * Below the level-of-detail zoom every table renders as a bare header, so the
 * sizes the canvas measures there describe collapsed nodes. Placing tables by
 * those — Detangle, align, distribute, imports — packs them tightly enough to
 * overlap the moment the zoom brings their columns back, so while the canvas is
 * collapsed by zoom the measurements are dropped in favour of the estimate for
 * each table's own display mode. That is the same estimate an import already
 * lays out from, and it is generous, so tables get at least the room they need.
 */
export function placementSizes(d: Diagram, measured: SizeMap | undefined, lodCollapsed: boolean): SizeMap {
  const fkColumns = new Map<string, Set<string>>();
  for (const r of d.relationships) {
    if (r.kind !== 'fk') continue;
    let ids = fkColumns.get(r.sourceTableId);
    if (!ids) fkColumns.set(r.sourceTableId, (ids = new Set()));
    for (const id of r.sourceColumnIds) ids.add(id);
  }
  const sizes: SizeMap = {};
  for (const t of d.tables) {
    const m = lodCollapsed ? undefined : measured?.[t.id];
    sizes[t.id] = m ?? estimateNodeSize(visibleColumns(t, effectiveDisplay(t, false), fkColumns.get(t.id) ?? new Set()));
  }
  return sizes;
}
