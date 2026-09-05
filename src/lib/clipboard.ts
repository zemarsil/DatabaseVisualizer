/**
 * Clipboard payloads for copying tables between diagrams, plus a classifier
 * for whatever text lands on the canvas via paste or drop.
 */
import type { CustomType, Diagram, Relationship, Table } from '@shared/types';
import { customTypesUsedBy } from './model';

export interface ClipboardPayload {
  dbvizClipboard: 1;
  tables: Table[];
  relationships: Relationship[];
  customTypes: CustomType[];
}

export function encodeClipboard(d: Diagram, tableIds: string[]): string {
  const ids = new Set(tableIds);
  const tables = d.tables.filter((t) => ids.has(t.id));
  const relationships = d.relationships.filter((r) => ids.has(r.sourceTableId) && ids.has(r.targetTableId));
  const payload: ClipboardPayload = { dbvizClipboard: 1, tables, relationships, customTypes: customTypesUsedBy(d, tables) };
  return JSON.stringify(payload);
}

export function decodeClipboard(text: string): ClipboardPayload | null {
  try {
    const o = JSON.parse(text) as Partial<ClipboardPayload>;
    if (!o || o.dbvizClipboard !== 1 || !Array.isArray(o.tables)) return null;
    return { dbvizClipboard: 1, tables: o.tables, relationships: Array.isArray(o.relationships) ? o.relationships : [], customTypes: Array.isArray(o.customTypes) ? o.customTypes : [] };
  } catch {
    return null;
  }
}

export type PastedKind = 'clipboard' | 'sql' | 'diagram' | 'unknown';

export function classifyPastedText(text: string): PastedKind {
  const trimmed = text.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('{')) {
    if (decodeClipboard(trimmed)) return 'clipboard';
    try {
      const o = JSON.parse(trimmed) as { tables?: unknown };
      if (o && Array.isArray(o.tables)) return 'diagram';
    } catch {
      /* not JSON */
    }
  }
  if (/\bcreate\s+(or\s+replace\s+)?(temp(orary)?\s+)?(unlogged\s+)?(materialized\s+)?(table|view|type|index|unique)\b/i.test(trimmed)) return 'sql';
  return 'unknown';
}
