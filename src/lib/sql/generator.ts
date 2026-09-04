import type { Column, Diagram, Dialect, Relationship, Table } from '@shared/types';
import { externalTableIds } from '../groups';
import { isIntegerType, isSerialType, quoteIdent, quoteQualified, quoteString } from './dialect';

export interface GeneratedSql {
  /** Executable statements in dependency order (each ends with ';'). */
  statements: string[];
  /** The same statements, formatted as a readable script with comments. */
  script: string;
  /** CREATE TABLE (plus its indexes / comments) per table id, for the inspector. */
  tableSql: Record<string, string>;
  warnings: string[];
}

interface Ctx {
  d: Diagram;
  dialect: Dialect;
  tableById: Map<string, Table>;
  columnById: Map<string, { table: Table; column: Column }>;
  fkNames: Map<string, string>;
  /** Tables in an external group: they live in another database, so this script never creates them. */
  external: Set<string>;
}

function buildCtx(d: Diagram): Ctx {
  const tableById = new Map<string, Table>();
  const columnById = new Map<string, { table: Table; column: Column }>();
  for (const t of d.tables) {
    tableById.set(t.id, t);
    for (const c of t.columns) columnById.set(c.id, { table: t, column: c });
  }
  return { d, dialect: d.dialect, tableById, columnById, fkNames: assignFkNames(d, tableById), external: externalTableIds(d) };
}

/** Constraint names must be unique per schema (PG) or per database (MariaDB). */
function assignFkNames(d: Diagram, tableById: Map<string, Table>): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const r of d.relationships) {
    if (r.kind !== 'fk') continue;
    const src = tableById.get(r.sourceTableId);
    const tgt = tableById.get(r.targetTableId);
    let base = r.name?.trim() || `fk_${src?.name ?? 'src'}_${tgt?.name ?? 'tgt'}`;
    base = base.slice(0, 60);
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${i++}`;
    used.add(name.toLowerCase());
    names.set(r.id, name);
  }
  return names;
}

function tableName(t: Table, dialect: Dialect): string {
  return quoteQualified(t.name, t.schema, dialect);
}

function columnNames(ids: string[], t: Table, dialect: Dialect): string[] {
  return ids.map((id) => t.columns.find((c) => c.id === id)).filter((c): c is Column => Boolean(c)).map((c) => quoteIdent(c.name, dialect));
}

/**
 * Kahn topological sort: referenced tables first. Back-edges (cycles) are
 * returned separately. Tables in `skip` (external ones) are left out entirely,
 * along with any foreign key that touches them.
 */
export function orderTables(d: Diagram, skip: Set<string> = new Set()): { order: Table[]; deferred: Set<string> } {
  const buildable = skip.size ? d.tables.filter((t) => !skip.has(t.id)) : d.tables;
  const ids = buildable.map((t) => t.id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const fks = d.relationships.filter(
    (r) => r.kind === 'fk' && r.sourceTableId !== r.targetTableId && !skip.has(r.sourceTableId) && !skip.has(r.targetTableId),
  );
  for (const r of fks) {
    if (!indeg.has(r.sourceTableId) || !indeg.has(r.targetTableId)) continue;
    indeg.set(r.sourceTableId, (indeg.get(r.sourceTableId) ?? 0) + 1);
    out.get(r.targetTableId)!.push(r.sourceTableId);
  }
  const byId = new Map(buildable.map((t) => [t.id, t]));
  const ready = ids.filter((id) => indeg.get(id) === 0).sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name));
  const order: Table[] = [];
  const placed = new Set<string>();
  while (ready.length) {
    const id = ready.shift()!;
    placed.add(id);
    order.push(byId.get(id)!);
    for (const dep of out.get(id) ?? []) {
      indeg.set(dep, indeg.get(dep)! - 1);
      if (indeg.get(dep) === 0) {
        ready.push(dep);
        ready.sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name));
      }
    }
  }
  // remaining tables are part of cycles: append in name order
  const remaining = buildable.filter((t) => !placed.has(t.id)).sort((a, b) => a.name.localeCompare(b.name));
  for (const t of remaining) {
    placed.add(t.id);
    order.push(t);
  }
  const position = new Map(order.map((t, i) => [t.id, i]));
  const deferred = new Set<string>();
  for (const r of fks) {
    const s = position.get(r.sourceTableId);
    const t = position.get(r.targetTableId);
    if (s === undefined || t === undefined) continue;
    if (t > s) deferred.add(r.id); // referenced table is created later -> ALTER TABLE
  }
  return { order, deferred };
}

function columnLine(ctx: Ctx, c: Column, inlinePk: boolean): string {
  const { dialect } = ctx;
  const parts: string[] = [quoteIdent(c.name, dialect)];
  let type = c.type.trim() || 'TEXT';

  if (dialect === 'postgresql') {
    if (c.autoIncrement) {
      if (isSerialType(type)) {
        parts.push(type.toUpperCase());
      } else if (isIntegerType(type)) {
        parts.push(type, 'GENERATED BY DEFAULT AS IDENTITY');
      } else {
        parts.push(type);
      }
    } else {
      parts.push(type);
    }
    if (inlinePk) parts.push('PRIMARY KEY');
    else if (!c.nullable && !isSerialType(type)) parts.push('NOT NULL');
    if (c.defaultValue && c.defaultValue.trim()) parts.push(`DEFAULT ${c.defaultValue.trim()}`);
    if (c.unique && !inlinePk) parts.push('UNIQUE');
    if (c.check && c.check.trim()) parts.push(`CHECK (${c.check.trim()})`);
    return parts.join(' ');
  }

  // MariaDB
  if (isSerialType(type)) type = type.toUpperCase() === 'BIGSERIAL' ? 'BIGINT' : type.toUpperCase() === 'SMALLSERIAL' ? 'SMALLINT' : 'INT';
  parts.push(type);
  if (!c.nullable || inlinePk) parts.push('NOT NULL');
  if (c.defaultValue && c.defaultValue.trim()) parts.push(`DEFAULT ${c.defaultValue.trim()}`);
  if (c.autoIncrement) parts.push('AUTO_INCREMENT');
  if (inlinePk) parts.push('PRIMARY KEY');
  if (c.unique && !inlinePk) parts.push('UNIQUE');
  if (c.check && c.check.trim()) parts.push(`CHECK (${c.check.trim()})`);
  if (c.comment && c.comment.trim()) parts.push(`COMMENT ${quoteString(c.comment.trim())}`);
  return parts.join(' ');
}

function fkClause(ctx: Ctx, r: Relationship): string | null {
  const src = ctx.tableById.get(r.sourceTableId);
  const tgt = ctx.tableById.get(r.targetTableId);
  if (!src || !tgt) return null;
  const sCols = columnNames(r.sourceColumnIds, src, ctx.dialect);
  const tCols = columnNames(r.targetColumnIds, tgt, ctx.dialect);
  if (sCols.length === 0 || tCols.length === 0 || sCols.length !== tCols.length) return null;
  const parts = [
    `CONSTRAINT ${quoteIdent(ctx.fkNames.get(r.id) ?? 'fk', ctx.dialect)}`,
    `FOREIGN KEY (${sCols.join(', ')})`,
    `REFERENCES ${tableName(tgt, ctx.dialect)} (${tCols.join(', ')})`,
  ];
  if (r.onDelete && r.onDelete !== 'NO ACTION') parts.push(`ON DELETE ${r.onDelete}`);
  if (r.onUpdate && r.onUpdate !== 'NO ACTION') parts.push(`ON UPDATE ${r.onUpdate}`);
  return parts.join(' ');
}

interface TableSqlOptions {
  /** FK relationship ids to emit inline; others are left for ALTER TABLE. */
  inlineFks: Relationship[];
}

function createTable(ctx: Ctx, t: Table, opts: TableSqlOptions, warnings: string[]): { create: string; extras: string[] } {
  const { dialect } = ctx;
  const pkCols = t.columns.filter((c) => c.primaryKey);
  const inlinePkId = pkCols.length === 1 ? pkCols[0].id : null;
  const lines: string[] = [];

  if (t.columns.length === 0) warnings.push(`Table ${t.name} has no columns.`);

  for (const c of t.columns) {
    if (!c.name.trim()) {
      warnings.push(`Table ${t.name} has a column with an empty name; it was skipped.`);
      continue;
    }
    lines.push(columnLine(ctx, c, c.id === inlinePkId));
  }
  if (pkCols.length > 1) {
    lines.push(`PRIMARY KEY (${columnNames(pkCols.map((c) => c.id), t, dialect).join(', ')})`);
  }
  for (const chk of t.checks) {
    if (chk.trim()) lines.push(`CHECK (${chk.trim()})`);
  }
  const extras: string[] = [];
  for (const idx of t.indexes) {
    const cols = columnNames(idx.columnIds, t, dialect);
    if (cols.length === 0) continue;
    const name = idx.name.trim() || `${idx.unique ? 'uq' : 'idx'}_${t.name}_${cols.map((c) => c.replace(/[`"]/g, '')).join('_')}`;
    if (dialect === 'mariadb') {
      lines.push(`${idx.unique ? 'UNIQUE KEY' : 'KEY'} ${quoteIdent(name, dialect)} (${cols.join(', ')})`);
    } else {
      extras.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(name, dialect)} ON ${tableName(t, dialect)} (${cols.join(', ')});`);
    }
  }
  for (const r of opts.inlineFks) {
    const clause = fkClause(ctx, r);
    if (clause) lines.push(clause);
    else warnings.push(`Foreign key ${ctx.fkNames.get(r.id) ?? r.id} on ${t.name} is incomplete and was skipped.`);
  }

  let create = `CREATE TABLE ${tableName(t, dialect)} (\n  ${lines.join(',\n  ')}\n)`;
  if (dialect === 'mariadb') {
    create += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    if (t.comment && t.comment.trim()) create += ` COMMENT=${quoteString(t.comment.trim())}`;
  }
  create += ';';

  if (dialect === 'postgresql') {
    if (t.comment && t.comment.trim()) extras.push(`COMMENT ON TABLE ${tableName(t, dialect)} IS ${quoteString(t.comment.trim())};`);
    for (const c of t.columns) {
      if (c.comment && c.comment.trim()) {
        extras.push(`COMMENT ON COLUMN ${tableName(t, dialect)}.${quoteIdent(c.name, dialect)} IS ${quoteString(c.comment.trim())};`);
      }
    }
  }
  return { create, extras };
}

function alterAddFk(ctx: Ctx, r: Relationship): string | null {
  const src = ctx.tableById.get(r.sourceTableId);
  const clause = fkClause(ctx, r);
  if (!src || !clause) return null;
  return `ALTER TABLE ${tableName(src, ctx.dialect)} ADD ${clause};`;
}

function commentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `--   ${l}`)
    .join('\n');
}

/** Generate the full schema script for a diagram. */
export function generateSchema(d: Diagram): GeneratedSql {
  const ctx = buildCtx(d);
  const warnings: string[] = [];
  const { order, deferred } = orderTables(d, ctx.external);
  const statements: string[] = [];
  const scriptParts: string[] = [];
  const tableSql: Record<string, string> = {};

  // A foreign key can only be created when both ends are in this database. One
  // that points into an external group is documented instead of executed.
  const crossing: Relationship[] = [];
  const fksBySource = new Map<string, Relationship[]>();
  for (const r of d.relationships) {
    if (r.kind !== 'fk') continue;
    if (ctx.external.has(r.sourceTableId)) continue; // the other database's business
    if (ctx.external.has(r.targetTableId)) {
      crossing.push(r);
      continue;
    }
    if (!fksBySource.has(r.sourceTableId)) fksBySource.set(r.sourceTableId, []);
    fksBySource.get(r.sourceTableId)!.push(r);
  }
  for (const r of crossing) {
    const src = ctx.tableById.get(r.sourceTableId);
    const tgt = ctx.tableById.get(r.targetTableId);
    const group = d.groups.find((g) => g.id === tgt?.groupId);
    warnings.push(
      `${src?.name ?? '?'} references ${tgt?.name ?? '?'} in the external group "${group?.name ?? '?'}"; a foreign key cannot cross databases, so it is written as a comment.`,
    );
  }

  const label = d.dialect === 'postgresql' ? 'PostgreSQL' : 'MariaDB';
  const externalTables = d.tables.filter((t) => ctx.external.has(t.id));
  const headLines = [
    `-- ${d.name || 'Untitled diagram'} (${label})`,
    '-- Generated by Database Visualizer',
    `-- Tables: ${order.length}, foreign keys: ${d.relationships.filter((r) => r.kind === 'fk' && !ctx.external.has(r.sourceTableId) && !ctx.external.has(r.targetTableId)).length}`,
  ];
  if (externalTables.length) {
    headLines.push(
      `-- ${externalTables.length} table(s) live in another database and are not created here; see "External sources" at the end.`,
    );
  }
  scriptParts.push(headLines.join('\n'));

  for (const t of order) {
    const fks = (fksBySource.get(t.id) ?? []).filter((r) => !deferred.has(r.id));
    const { create, extras } = createTable(ctx, t, { inlineFks: fks }, warnings);
    statements.push(create, ...extras);
    const block = [create, ...extras].join('\n');
    tableSql[t.id] = block;
    scriptParts.push(block);
  }

  const deferredStatements: string[] = [];
  for (const r of d.relationships) {
    if (r.kind === 'fk' && deferred.has(r.id)) {
      const s = alterAddFk(ctx, r);
      if (s) deferredStatements.push(s);
    }
  }
  if (deferredStatements.length) {
    statements.push(...deferredStatements);
    scriptParts.push(`-- Foreign keys that close reference cycles\n${deferredStatements.join('\n')}`);
  }

  // Documentation-only appendix: the tables this schema reads from but does not own.
  const externalGroups = d.groups.filter((g) => g.external && d.tables.some((t) => t.groupId === g.id));
  if (externalGroups.length) {
    const lines: string[] = [
      '-- ----------------------------------------------------------------',
      '-- External sources: other databases this schema reads from.',
      '-- Nothing below is executed; it is here so the script documents where the data comes from.',
    ];
    for (const g of externalGroups) {
      const members = d.tables.filter((t) => t.groupId === g.id);
      lines.push(`--`, `-- ${g.name} (${members.length} table${members.length === 1 ? '' : 's'})`);
      if (g.note && g.note.trim()) lines.push(commentBlock(g.note.trim()));
      for (const t of members) {
        lines.push(`--   ${t.name} (${t.columns.map((c) => c.name).join(', ') || 'no columns'})`);
      }
      const refs = crossing.filter((r) => ctx.tableById.get(r.targetTableId)?.groupId === g.id);
      if (refs.length) {
        lines.push('--', `-- References into ${g.name}, as foreign keys would look if the tables were local:`);
        for (const r of refs) {
          const stmt = alterAddFk(ctx, r);
          if (stmt) lines.push(`-- ${stmt}`);
        }
      }
    }
    scriptParts.push(lines.join('\n'));
  }

  // Documentation-only appendix: data flows and tagged queries.
  const annotated = d.relationships.filter((r) => r.kind === 'flow' || (r.query && r.query.trim()));
  if (annotated.length) {
    const lines: string[] = ['-- ----------------------------------------------------------------', '-- Data flows and tagged queries (documentation only, not executed)'];
    for (const r of annotated) {
      const src = ctx.tableById.get(r.sourceTableId)?.name ?? '?';
      const tgt = ctx.tableById.get(r.targetTableId)?.name ?? '?';
      const head = r.kind === 'flow' ? `${src} -> ${tgt}` : `${src} references ${tgt}`;
      lines.push(`-- ${head}${r.name ? ` (${r.name})` : ''}`);
      if (r.note && r.note.trim()) lines.push(commentBlock(r.note.trim()));
      if (r.query && r.query.trim()) lines.push(commentBlock(r.query.trim()));
    }
    scriptParts.push(lines.join('\n'));
  }

  return { statements, script: scriptParts.join('\n\n') + '\n', tableSql, warnings };
}

/** Standalone CREATE TABLE for one table with all of its foreign keys inline (for the inspector). */
export function generateTableSql(d: Diagram, tableId: string): string {
  const ctx = buildCtx(d);
  const t = ctx.tableById.get(tableId);
  if (!t) return '';
  // A foreign key that would cross into another database is not real DDL.
  const fks = d.relationships.filter((r) => r.kind === 'fk' && r.sourceTableId === tableId && !ctx.external.has(r.targetTableId));
  const { create, extras } = createTable(ctx, t, { inlineFks: fks }, []);
  const body = [create, ...extras].join('\n');
  if (!ctx.external.has(t.id)) return body;
  const group = d.groups.find((g) => g.id === t.groupId);
  return [
    `-- ${t.name} lives in ${group ? `"${group.name}"` : 'another database'}, so the schema script does not create it.`,
    '-- This is what it looks like, for reference.',
    body,
  ].join('\n');
}

/** DROP TABLE statements in reverse dependency order. */
export function generateDropStatements(d: Diagram): string[] {
  const { order } = orderTables(d, externalTableIds(d));
  const reversed = [...order].reverse();
  if (d.dialect === 'postgresql') {
    return reversed.map((t) => `DROP TABLE IF EXISTS ${tableName(t, d.dialect)} CASCADE;`);
  }
  return [
    'SET FOREIGN_KEY_CHECKS = 0;',
    ...reversed.map((t) => `DROP TABLE IF EXISTS ${tableName(t, d.dialect)};`),
    'SET FOREIGN_KEY_CHECKS = 1;',
  ];
}
