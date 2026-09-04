import type { Diagram, Note, Relationship, Table } from '@shared/types';
import { emptyDiagram } from './model';

export const FILE_EXTENSION = '.dbviz.json';

export function serializeDiagram(d: Diagram): string {
  return JSON.stringify(d, null, 2);
}

class InvalidFile extends Error {}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Parse and validate a saved file. Tolerant of missing optional fields so old files keep loading. */
export function parseDiagramFile(text: string): Diagram {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InvalidFile('The file is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object') throw new InvalidFile('The file does not contain a diagram.');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tables)) throw new InvalidFile('The file has no "tables" array; is this a Database Visualizer file?');

  const dialect = o.dialect === 'mariadb' ? 'mariadb' : 'postgresql';
  const d = emptyDiagram(dialect, str(o.name, 'Untitled diagram'));

  const tables: Table[] = [];
  for (const rt of o.tables as unknown[]) {
    if (!rt || typeof rt !== 'object') continue;
    const t = rt as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.name !== 'string') continue;
    const pos = (t.position ?? {}) as Record<string, unknown>;
    tables.push({
      id: t.id,
      name: t.name,
      schema: typeof t.schema === 'string' && t.schema ? t.schema : undefined,
      comment: typeof t.comment === 'string' && t.comment ? t.comment : undefined,
      color: str(t.color, 'blue'),
      position: { x: num(pos.x), y: num(pos.y) },
      checks: strArray(t.checks),
      columns: (Array.isArray(t.columns) ? t.columns : [])
        .filter((c: unknown): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
        .filter((c) => typeof c.id === 'string' && typeof c.name === 'string')
        .map((c) => ({
          id: c.id as string,
          name: c.name as string,
          type: str(c.type, 'TEXT'),
          nullable: bool(c.nullable, true),
          primaryKey: bool(c.primaryKey),
          unique: bool(c.unique),
          autoIncrement: bool(c.autoIncrement),
          defaultValue: typeof c.defaultValue === 'string' && c.defaultValue ? c.defaultValue : undefined,
          check: typeof c.check === 'string' && c.check ? c.check : undefined,
          comment: typeof c.comment === 'string' && c.comment ? c.comment : undefined,
        })),
      indexes: (Array.isArray(t.indexes) ? t.indexes : [])
        .filter((i: unknown): i is Record<string, unknown> => Boolean(i) && typeof i === 'object')
        .filter((i) => typeof i.id === 'string')
        .map((i) => ({ id: i.id as string, name: str(i.name), unique: bool(i.unique), columnIds: strArray(i.columnIds) })),
    });
  }
  d.tables = tables;

  const rels: Relationship[] = [];
  for (const rr of (Array.isArray(o.relationships) ? o.relationships : []) as unknown[]) {
    if (!rr || typeof rr !== 'object') continue;
    const r = rr as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.sourceTableId !== 'string' || typeof r.targetTableId !== 'string') continue;
    rels.push({
      id: r.id,
      kind: r.kind === 'flow' ? 'flow' : 'fk',
      sourceTableId: r.sourceTableId,
      targetTableId: r.targetTableId,
      sourceColumnIds: strArray(r.sourceColumnIds),
      targetColumnIds: strArray(r.targetColumnIds),
      name: typeof r.name === 'string' && r.name ? r.name : undefined,
      inverseName: typeof r.inverseName === 'string' && r.inverseName ? r.inverseName : undefined,
      onDelete: (r.onDelete as Relationship['onDelete']) ?? 'NO ACTION',
      onUpdate: (r.onUpdate as Relationship['onUpdate']) ?? 'NO ACTION',
      query: typeof r.query === 'string' && r.query ? r.query : undefined,
      note: typeof r.note === 'string' && r.note ? r.note : undefined,
    });
  }
  d.relationships = rels;

  const notes: Note[] = [];
  for (const rn of (Array.isArray(o.notes) ? o.notes : []) as unknown[]) {
    if (!rn || typeof rn !== 'object') continue;
    const n = rn as Record<string, unknown>;
    if (typeof n.id !== 'string') continue;
    const pos = (n.position ?? {}) as Record<string, unknown>;
    notes.push({
      id: n.id,
      text: str(n.text),
      position: { x: num(pos.x), y: num(pos.y) },
      width: num(n.width, 220),
      height: num(n.height, 120),
      color: str(n.color, 'yellow'),
    });
  }
  d.notes = notes;

  if (o.viewport && typeof o.viewport === 'object') {
    const v = o.viewport as Record<string, unknown>;
    d.viewport = { x: num(v.x), y: num(v.y), zoom: num(v.zoom, 1) || 1 };
  }
  return d;
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Safe file name from the diagram name. */
export function fileSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'diagram';
}
