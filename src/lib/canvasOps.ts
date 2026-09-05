/**
 * Pure geometry for the Arrange tools (align / distribute / snap) and the
 * "group by schema" helper. Callers turn the returned moves into one undo
 * step with beginDrag / moveItems / endDrag.
 */
import type { Diagram, Table } from '@shared/types';
import { estimateNodeSize } from './geometry';

export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';
export type SizeMap = Record<string, { width: number; height: number }>;
export interface Move {
  id: string;
  position: { x: number; y: number };
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxes(tables: Table[], sizes: SizeMap | undefined): Box[] {
  return tables.map((t) => {
    const s = sizes?.[t.id] ?? estimateNodeSize(t.columns);
    return { id: t.id, x: t.position.x, y: t.position.y, w: s.width, h: s.height };
  });
}

export function alignTables(tables: Table[], sizes: SizeMap | undefined, mode: AlignMode): Move[] {
  if (tables.length < 2) return [];
  const b = boxes(tables, sizes);
  const minX = Math.min(...b.map((x) => x.x));
  const maxR = Math.max(...b.map((x) => x.x + x.w));
  const minY = Math.min(...b.map((x) => x.y));
  const maxB = Math.max(...b.map((x) => x.y + x.h));
  const cx = (minX + maxR) / 2;
  const cy = (minY + maxB) / 2;
  return b.map((box) => {
    let x = box.x;
    let y = box.y;
    switch (mode) {
      case 'left':
        x = minX;
        break;
      case 'right':
        x = maxR - box.w;
        break;
      case 'centerX':
        x = cx - box.w / 2;
        break;
      case 'top':
        y = minY;
        break;
      case 'bottom':
        y = maxB - box.h;
        break;
      case 'centerY':
        y = cy - box.h / 2;
        break;
    }
    return { id: box.id, position: { x: Math.round(x), y: Math.round(y) } };
  });
}

/** Equal gaps between tables along one axis; the outermost two stay put. */
export function distributeTables(tables: Table[], sizes: SizeMap | undefined, axis: 'x' | 'y'): Move[] {
  if (tables.length < 3) return [];
  const b = boxes(tables, sizes).sort((p, q) => (axis === 'x' ? p.x - q.x : p.y - q.y));
  const size = (box: Box) => (axis === 'x' ? box.w : box.h);
  const start = axis === 'x' ? b[0].x : b[0].y;
  const last = b[b.length - 1];
  const end = (axis === 'x' ? last.x : last.y) + size(last);
  const total = b.reduce((n, box) => n + size(box), 0);
  const gap = (end - start - total) / (b.length - 1);
  let cursor = start;
  return b.map((box) => {
    const pos = Math.round(cursor);
    cursor += size(box) + gap;
    return { id: box.id, position: axis === 'x' ? { x: pos, y: box.y } : { x: box.x, y: pos } };
  });
}

export function snapAllToGrid(tables: Table[], grid = 20): Move[] {
  return tables
    .map((t) => ({ id: t.id, position: { x: Math.round(t.position.x / grid) * grid, y: Math.round(t.position.y / grid) * grid } }))
    .filter((m, i) => m.position.x !== tables[i].position.x || m.position.y !== tables[i].position.y);
}

/** One group per distinct schema, for tables that carry a schema and are not grouped yet. */
export function groupBySchema(d: Diagram): { name: string; tableIds: string[] }[] {
  const bySchema = new Map<string, string[]>();
  for (const t of d.tables) {
    const schema = t.schema?.trim();
    if (!schema || t.groupId) continue;
    const key = schema.toLowerCase();
    if (!bySchema.has(key)) bySchema.set(key, []);
    bySchema.get(key)!.push(t.id);
  }
  return [...bySchema.entries()]
    .map(([key, tableIds]) => ({ name: d.tables.find((t) => t.schema?.trim().toLowerCase() === key)!.schema!.trim(), tableIds }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct schemas among the tables (used to enable the menu item). */
export function schemaCount(d: Diagram): number {
  return new Set(d.tables.map((t) => t.schema?.trim().toLowerCase()).filter(Boolean)).size;
}
