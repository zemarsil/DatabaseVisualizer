import type { Diagram, IntrospectResponse } from '@shared/types';
import { parseResultToDiagram, type ImportResult } from './sql/import';
import type { ParseResult, ParsedTable } from './sql/parser';
import { normalizeType } from './sql/dialect';

/** format_type() output uses long names; prefer the short spellings people type. */
function canonicalType(type: string, dialect: Diagram['dialect']): string {
  let t = normalizeType(type);
  if (dialect === 'postgresql') {
    t = t
      .replace(/^CHARACTER VARYING/, 'VARCHAR')
      .replace(/^TIMESTAMP(\(\d+\))? WITH TIME ZONE/, 'TIMESTAMPTZ$1')
      .replace(/^TIMESTAMP(\(\d+\))? WITHOUT TIME ZONE/, 'TIMESTAMP$1')
      .replace(/^TIME(\(\d+\))? WITH TIME ZONE/, 'TIMETZ$1')
      .replace(/^TIME(\(\d+\))? WITHOUT TIME ZONE/, 'TIME$1')
      .replace(/^CHARACTER\(/, 'CHAR(');
  }
  return t;
}

/** Convert a live-database introspection into diagram tables and relationships. */
export function introspectionToDiagram(res: IntrospectResponse, dialect: Diagram['dialect'], existing: Diagram | null): ImportResult {
  const schemas = new Set(res.tables.map((t) => t.schema));
  const dropSchema = schemas.size <= 1; // everything in one schema (public / the database) -> keep names short
  const parsed: ParseResult = {
    enums: [],
    compositeTypes: [],
    errors: [],
    warnings: [],
    statementCount: res.tables.length,
    tables: res.tables.map<ParsedTable>((t) => ({
      schema: dropSchema ? undefined : t.schema,
      name: t.name,
      comment: t.comment ?? undefined,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: canonicalType(c.type, dialect),
        nullable: c.nullable,
        primaryKey: t.primaryKey.includes(c.name),
        unique: t.uniques.some((u) => u.columns.length === 1 && u.columns[0] === c.name),
        autoIncrement: c.autoIncrement,
        defaultValue: c.defaultValue ?? undefined,
        comment: c.comment ?? undefined,
      })),
      primaryKey: t.primaryKey,
      uniques: t.uniques.filter((u) => u.columns.length > 1),
      indexes: t.indexes,
      checks: [],
      foreignKeys: t.foreignKeys.map((fk) => ({
        name: fk.name,
        columns: fk.columns,
        refSchema: dropSchema ? undefined : (fk.refSchema ?? undefined),
        refTable: fk.refTable,
        refColumns: fk.refColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      })),
    })),
  };
  return parseResultToDiagram(parsed, existing);
}
