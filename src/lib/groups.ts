/**
 * Geometry and membership helpers for table groups.
 *
 * A group has no stored rectangle: its box is the bounding box of its member
 * tables, grown by a padding and a header strip. That way Detangle, imports and
 * table drags can move tables around without ever leaving the region behind.
 * Group.position is only the fallback box for a group that has no members yet.
 */
import type { Diagram, Table } from '@shared/types';
import { estimateNodeSize } from './geometry';

/** Space between the outermost tables and the region border. */
export const GROUP_PADDING = 26;
/** Extra space on top of the padding for the title bar. */
export const GROUP_HEADER = 30;
/** Box drawn for a group that has no tables in it yet. */
export const EMPTY_GROUP_WIDTH = 340;
export const EMPTY_GROUP_HEIGHT = 200;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SizeMap = Record<string, { width: number; height: number }>;

export function tableRect(t: Table, sizes?: SizeMap): Rect {
  const size = sizes?.[t.id] ?? estimateNodeSize(t.columns);
  return { x: t.position.x, y: t.position.y, width: size.width, height: size.height };
}

export function rectContains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** The box a set of tables needs, including padding and the title bar. */
export function boundsForTables(tables: Table[], sizes?: SizeMap): Rect | null {
  if (tables.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tables) {
    const r = tableRect(t, sizes);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  // Deliberately not rounded: while a region is dragged its box is derived from
  // the tables it just moved, and rounding here would fight React Flow's own
  // sub-pixel drag position.
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_HEADER,
    width: maxX - minX + GROUP_PADDING * 2,
    height: maxY - minY + GROUP_PADDING * 2 + GROUP_HEADER,
  };
}

export interface BoundsOptions {
  sizes?: SizeMap;
  /**
   * Tables to leave out of the maths, used while they are being dragged so the
   * region stays put instead of stretching to follow the table in flight.
   */
  exclude?: Set<string>;
  /** Boxes to fall back to when excluding leaves a group with no tables. */
  fallback?: Record<string, Rect>;
}

/** The rectangle for every group in the diagram, keyed by group id. */
export function groupBounds(d: Diagram, opts: BoundsOptions = {}): Record<string, Rect> {
  const members = new Map<string, Table[]>(d.groups.map((g) => [g.id, []]));
  for (const t of d.tables) {
    if (!t.groupId) continue;
    if (opts.exclude?.has(t.id)) continue;
    members.get(t.groupId)?.push(t);
  }
  const out: Record<string, Rect> = {};
  for (const g of d.groups) {
    const box = boundsForTables(members.get(g.id) ?? [], opts.sizes);
    out[g.id] =
      box ??
      opts.fallback?.[g.id] ?? {
        x: g.position.x,
        y: g.position.y,
        width: EMPTY_GROUP_WIDTH,
        height: EMPTY_GROUP_HEIGHT,
      };
  }
  return out;
}

/** How far outside its own region a table must go before it leaves the group. */
export const GROUP_STICKINESS = 40;

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

/** The group whose box a point falls in; the smallest one wins if they overlap. */
export function groupAtPoint(bounds: Record<string, Rect>, p: { x: number; y: number }): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const [id, r] of Object.entries(bounds)) {
    if (!rectContains(r, p)) continue;
    const area = r.width * r.height;
    if (area < bestArea) {
      best = id;
      bestArea = area;
    }
  }
  return best;
}

/** Ids of tables that live in an external group, i.e. in another database. */
export function externalTableIds(d: Diagram): Set<string> {
  const external = new Set(d.groups.filter((g) => g.external).map((g) => g.id));
  const ids = new Set<string>();
  if (external.size === 0) return ids;
  for (const t of d.tables) {
    if (t.groupId && external.has(t.groupId)) ids.add(t.id);
  }
  return ids;
}

/** Drop group ids that no longer point at a group. */
export function pruneGroupIds(d: Diagram): void {
  const ids = new Set(d.groups.map((g) => g.id));
  for (const t of d.tables) {
    if (t.groupId && !ids.has(t.groupId)) t.groupId = undefined;
  }
}

/** A free spot for a new empty group, to the right of everything already placed. */
export function nextGroupPosition(d: Diagram, sizes?: SizeMap): { x: number; y: number } {
  let maxX = -Infinity;
  let minY = Infinity;
  for (const t of d.tables) {
    const r = tableRect(t, sizes);
    maxX = Math.max(maxX, r.x + r.width);
    minY = Math.min(minY, r.y);
  }
  for (const g of d.groups) {
    maxX = Math.max(maxX, g.position.x + EMPTY_GROUP_WIDTH);
    minY = Math.min(minY, g.position.y);
  }
  if (!Number.isFinite(maxX)) return { x: 80, y: 80 };
  return { x: Math.round(maxX + 90), y: Math.round(Number.isFinite(minY) ? minY : 80) };
}
