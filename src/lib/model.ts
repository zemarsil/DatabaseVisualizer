import { kindMeta, type Column, type Diagram, type Dialect, type Index, type Note, type Relationship, type Table } from '@shared/types';
import { newId } from './ids';
import { colorForName } from './palette';

export function emptyDiagram(dialect: Dialect = 'postgresql', name = 'Untitled diagram'): Diagram {
  return { version: 1, name, dialect, tables: [], relationships: [], notes: [] };
}

export function createColumn(partial: Partial<Column> & { name: string }): Column {
  return {
    id: newId('col'),
    type: partial.type ?? (partial.primaryKey ? 'INTEGER' : 'VARCHAR(255)'),
    nullable: partial.nullable ?? !partial.primaryKey,
    primaryKey: partial.primaryKey ?? false,
    unique: partial.unique ?? false,
    autoIncrement: partial.autoIncrement ?? false,
    ...partial,
    name: partial.name,
  };
}

export function createTable(partial: Partial<Table> & { name: string }): Table {
  return {
    id: newId('tbl'),
    columns: [],
    indexes: [],
    checks: [],
    position: { x: 0, y: 0 },
    color: colorForName(partial.name),
    ...partial,
    name: partial.name,
  };
}

export function createIndex(partial: Partial<Index> & { columnIds: string[] }): Index {
  return { id: newId('idx'), name: '', unique: false, ...partial };
}

export function createRelationship(partial: Omit<Relationship, 'id'> & { id?: string }): Relationship {
  return { id: newId('rel'), onDelete: 'NO ACTION', onUpdate: 'NO ACTION', ...partial };
}

export function createNote(partial: Partial<Note> = {}): Note {
  return { id: newId('note'), text: 'New note', position: { x: 0, y: 0 }, width: 220, height: 120, color: 'yellow', ...partial };
}

/** Next free table name like "table_3". */
export function uniqueTableName(d: Diagram, base = 'new_table'): string {
  const names = new Set(d.tables.map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function uniqueColumnName(t: Table, base = 'column'): string {
  const names = new Set(t.columns.map((c) => c.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function tableById(d: Diagram, id: string): Table | undefined {
  return d.tables.find((t) => t.id === id);
}

export function columnById(t: Table | undefined, id: string): Column | undefined {
  return t?.columns.find((c) => c.id === id);
}

export function findColumnOwner(d: Diagram, columnId: string): { table: Table; column: Column } | undefined {
  for (const t of d.tables) {
    const c = t.columns.find((col) => col.id === columnId);
    if (c) return { table: t, column: c };
  }
  return undefined;
}

/** Column ids referenced by any FK where this table is the referencing side. */
export function foreignKeyColumnIds(d: Diagram, tableId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of d.relationships) {
    if (r.kind === 'fk' && r.sourceTableId === tableId) r.sourceColumnIds.forEach((id) => ids.add(id));
  }
  return ids;
}

/** Column ids of this table that hold another table serialized inside them. */
export function embeddedColumnIds(d: Diagram, tableId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of d.relationships) {
    if (r.kind === 'embed' && r.sourceTableId === tableId && r.sourceColumnIds[0]) ids.add(r.sourceColumnIds[0]);
  }
  return ids;
}

/** Remove dangling references after tables/columns are deleted. */
export function pruneRelationships(d: Diagram): Diagram {
  const tables = new Set(d.tables.map((t) => t.id));
  const columns = new Set(d.tables.flatMap((t) => t.columns.map((c) => c.id)));
  const relationships = d.relationships
    .filter((r) => tables.has(r.sourceTableId) && tables.has(r.targetTableId))
    .map((r) => ({
      ...r,
      sourceColumnIds: r.sourceColumnIds.filter((id) => columns.has(id)),
      targetColumnIds: r.targetColumnIds.filter((id) => columns.has(id)),
    }))
    // Only column-pair kinds (FKs) become meaningless without their columns; the
    // documentation kinds are table-to-table and survive a column being dropped.
    .filter((r) => !kindMeta(r.kind).needsColumnPairs || (r.sourceColumnIds.length > 0 && r.targetColumnIds.length > 0));
  const tablesOut = d.tables.map((t) => ({
    ...t,
    indexes: t.indexes.map((i) => ({ ...i, columnIds: i.columnIds.filter((id) => columns.has(id)) })).filter((i) => i.columnIds.length > 0),
  }));
  return { ...d, tables: tablesOut, relationships };
}
