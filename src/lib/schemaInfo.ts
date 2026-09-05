import type { Diagram, Relationship, Table } from '@shared/types';

/**
 * Small structural facts about a schema that several features share:
 * which column sets are unique, what a foreign key's cardinality is, and
 * whether a table is a many-to-many join table.
 */

export function pkColumnIds(t: Table): string[] {
  return t.columns.filter((c) => c.primaryKey).map((c) => c.id);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * True when the given columns are guaranteed unique together: they are the
 * whole primary key, a single column flagged UNIQUE, or exactly the columns of
 * a unique index.
 */
export function isUniqueColumnSet(t: Table, columnIds: string[]): boolean {
  if (columnIds.length === 0) return false;
  const pk = pkColumnIds(t);
  if (pk.length && sameSet(pk, columnIds)) return true;
  if (columnIds.length === 1) {
    const c = t.columns.find((x) => x.id === columnIds[0]);
    // A member of a composite key is flagged primaryKey but is not unique on its own.
    if (c?.unique || (c?.primaryKey && pk.length === 1)) return true;
  }
  return t.indexes.some((ix) => ix.unique && sameSet(ix.columnIds, columnIds));
}

/** Column ids on the referencing side of every FK leaving the table. */
export function fkColumnIds(d: Diagram, tableId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of d.relationships) if (r.kind === 'fk' && r.sourceTableId === tableId) for (const c of r.sourceColumnIds) ids.add(c);
  return ids;
}

/** The referenced columns of an FK must be unique (PK or UNIQUE); PostgreSQL and SQLite reject the constraint otherwise. */
export function fkTargetIsUnique(d: Diagram, r: Relationship): boolean {
  if (r.kind !== 'fk') return true;
  const tgt = d.tables.find((t) => t.id === r.targetTableId);
  if (!tgt) return false;
  return isUniqueColumnSet(tgt, r.targetColumnIds);
}

export interface Cardinality {
  /** '1' when the referencing columns are themselves unique (a one-to-one link), else 'N'. */
  source: '1' | 'N';
  /** Any referencing column is nullable, so a child row may have no parent. */
  sourceOptional: boolean;
  target: '1';
}

/** Cardinality of a foreign key as drawn on the diagram; null for data-flow links. */
export function relationshipCardinality(d: Diagram, r: Relationship): Cardinality | null {
  if (r.kind !== 'fk') return null;
  const src = d.tables.find((t) => t.id === r.sourceTableId);
  if (!src) return null;
  const cols = r.sourceColumnIds.map((id) => src.columns.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  return {
    source: isUniqueColumnSet(src, r.sourceColumnIds) ? '1' : 'N',
    sourceOptional: cols.some((c) => c.nullable),
    target: '1',
  };
}

/**
 * A join table implements a many-to-many relationship: it has foreign keys to
 * at least two different tables and its primary key (or, lacking one, all of
 * its columns) consists of those foreign-key columns.
 */
export function isJoinTable(d: Diagram, t: Table): boolean {
  if (t.kind === 'view') return false;
  const fks = d.relationships.filter((r) => r.kind === 'fk' && r.sourceTableId === t.id);
  const targets = new Set(fks.map((r) => r.targetTableId));
  if (targets.size < 2) return false;
  const fkCols = new Set(fks.flatMap((r) => r.sourceColumnIds));
  const pk = pkColumnIds(t);
  const key = pk.length ? pk : t.columns.map((c) => c.id);
  if (key.length < 2) return false;
  return key.every((id) => fkCols.has(id));
}

/** Tables that reference the given table through a foreign key. */
export function referencingTables(d: Diagram, tableId: string): Table[] {
  const ids = new Set(d.relationships.filter((r) => r.kind === 'fk' && r.targetTableId === tableId).map((r) => r.sourceTableId));
  return d.tables.filter((t) => ids.has(t.id));
}
