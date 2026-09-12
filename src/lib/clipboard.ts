/**
 * Clipboard payloads for copying tables between diagrams, plus a classifier
 * for whatever text lands on the canvas via paste or drop.
 */
import type { CustomType, Diagram, DiagramExtension, Program, Relationship, Table } from '@shared/types';
import { codeSubtreeIds } from './codemap';
import { customTypesUsedBy } from './model';
import { extensionsUsedBy } from './extensions/registry';

export interface ClipboardPayload {
  dbvizClipboard: 1;
  tables: Table[];
  relationships: Relationship[];
  customTypes: CustomType[];
  /** Extensions the copied tables depend on, so a paste into a fresh diagram still generates valid DDL. */
  extensions: DiagramExtension[];
  /** Code nodes copied along with the tables, each with everything inside it. Absent in payloads written before code maps. */
  programs: Program[];
}

export function encodeClipboard(d: Diagram, tableIds: string[], programIds: string[] = []): string {
  const ids = new Set(tableIds);
  const tables = d.tables.filter((t) => ids.has(t.id));
  const relationships = d.relationships.filter((r) => ids.has(r.sourceTableId) && ids.has(r.targetTableId));
  // A container is copied with its members: a module without its functions
  // is not the thing that was selected.
  const codeIds = new Set(codeSubtreeIds(d, programIds));
  const programs = d.programs.filter((p) => codeIds.has(p.id));
  const payload: ClipboardPayload = { dbvizClipboard: 1, tables, relationships, customTypes: customTypesUsedBy(d, tables), extensions: extensionsUsedBy(d, tables), programs };
  return JSON.stringify(payload);
}

export function decodeClipboard(text: string): ClipboardPayload | null {
  try {
    const o = JSON.parse(text) as Partial<ClipboardPayload>;
    if (!o || o.dbvizClipboard !== 1 || !Array.isArray(o.tables)) return null;
    return {
      dbvizClipboard: 1,
      tables: o.tables,
      relationships: Array.isArray(o.relationships) ? o.relationships : [],
      customTypes: Array.isArray(o.customTypes) ? o.customTypes : [],
      // Payloads copied before extensions existed simply have none.
      extensions: Array.isArray(o.extensions) ? o.extensions : [],
      programs: Array.isArray(o.programs) ? o.programs : [],
    };
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
