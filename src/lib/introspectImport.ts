import type { Diagram, IntrospectResponse } from '@shared/types';
import { parseResultToDiagram, type ImportResult } from './sql/import';
import type { ParseResult, ParsedTable } from './sql/parser';
import { normalizeType } from './sql/dialect';
import { viewSourcesFromSql } from './sql/views';

/** format_type() output uses long names; prefer the short spellings people type. A named type keeps the spelling it was created with. */
function canonicalType(type: string, dialect: Diagram['dialect'], namedTypes: Map<string, string>): string {
  const named = namedTypes.get(type.trim().replace(/^"|"$/g, '').toLowerCase());
  if (named) return named;
  let t = normalizeType(type);
  if (dialect === 'postgresql') {
    t = t
      .replace(/^CHARACTER VARYING/, 'VARCHAR')
      .replace(/^TIMESTAMP(\(\d+\))? WITH TIME ZONE/, 'TIMESTAMPTZ$1')
      .replace(/^TIMESTAMP(\(\d+\))? WITHOUT TIME ZONE/, 'TIMESTAMP$1')
      .replace(/^TIME(\(\d+\))? WITH TIME ZONE/, 'TIMETZ$1')
      .replace(/^TIME(\(\d+\))? WITHOUT TIME ZONE/, 'TIME$1')
      .replace(/^CHARACTER\(/, 'CHAR(');
  } else if (dialect === 'duckdb') {
    t = t.replace(/^TIMESTAMP WITH TIME ZONE/, 'TIMESTAMPTZ').replace(/^TIME WITH TIME ZONE/, 'TIMETZ');
  }
  return t;
}

/** Convert a live-database introspection into diagram tables and relationships. */
export function introspectionToDiagram(res: IntrospectResponse, dialect: Diagram['dialect'], existing: Diagram | null): ImportResult {
  const schemas = new Set(res.tables.map((t) => t.schema));
  const dropSchema = schemas.size <= 1; // everything in one schema (public / the database) -> keep names short
  const tableNames = res.tables.map((t) => (dropSchema ? t.name : `${t.schema}.${t.name}`));
  const namedTypes = new Map((res.enums ?? []).map((e) => [e.name.toLowerCase(), e.name] as const));
  const parsed: ParseResult = {
    enums: (res.enums ?? []).map((e) => ({ name: e.name, values: e.values })),
    extensions: (res.extensions ?? []).map((e) => ({ name: e.name, schema: e.schema, version: e.version })),
    views: res.tables
      .filter((t) => t.kind === 'view')
      .map((t) => ({
        schema: dropSchema ? undefined : t.schema,
        name: t.name,
        columns: [],
        sql: (t.viewSql ?? '').trim(),
        sources: viewSourcesFromSql(t.viewSql ?? '', tableNames),
        materialized: t.materialized || undefined,
      })),
    compositeTypes: [],
    errors: [],
    warnings: [],
    statementCount: res.tables.length,
    tables: res.tables.filter((t) => t.kind !== 'view').map<ParsedTable>((t) => ({
      schema: dropSchema ? undefined : t.schema,
      name: t.name,
      comment: t.comment ?? undefined,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: canonicalType(c.type, dialect, namedTypes),
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
