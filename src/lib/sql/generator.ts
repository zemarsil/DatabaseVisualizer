import {
  describeRelationship,
  kindMeta,
  type Column,
  type CustomType,
  type Derivation,
  type Diagram,
  type Dialect,
  type Relationship,
  type Table,
} from '@shared/types';
import { derivationSummaries, flowDerivations, groupDerivations, isDerivationComplete, parseOrderKey } from '../derivation';
import { foreignKeyPath } from '../schemaInfo';
import { collectReferences, parseExpression, type ColumnRef, type Expr } from '../simulate/expression';
import { tokenize, type Token } from './tokenizer';
import { externalTableIds } from '../groups';
import { isIntegerType, isSerialType, quoteIdent, quoteQualified, quoteString } from './dialect';
import { orderViews } from './views';

/** Look up a column's raw type string against the diagram's named custom types (case-insensitive, quotes stripped). */
function findCustomType(customTypes: CustomType[], type: string): CustomType | undefined {
  const bare = type.trim().replace(/^["'`]|["'`]$/g, '');
  return customTypes.find((t) => t.name.toLowerCase() === bare.toLowerCase());
}

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
  // Views are created after every table (see orderViews), so they never take part here.
  const buildable = d.tables.filter((t) => t.kind !== 'view' && !skip.has(t.id));
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

/** Resolve a column's raw type against named custom types, per dialect quirks (see resolveColumnType). */
function resolveColumnType(ctx: Ctx, rawType: string, columnLabel: string, warnings: string[]): string {
  const type = rawType.trim() || 'TEXT';
  const ct = findCustomType(ctx.d.customTypes, type);
  if (!ct) return type;
  if (ctx.dialect === 'postgresql') return quoteIdent(ct.name, ctx.dialect);
  if (ctx.dialect === 'sqlite') {
    // Enums become TEXT with a CHECK (added by columnLine); composites have no equivalent at all.
    if (ct.kind !== 'enum') warnings.push(`${columnLabel} uses custom composite type "${ct.name}", which SQLite cannot express; emitted as TEXT.`);
    return 'TEXT';
  }
  // MariaDB has no named CREATE TYPE: inline enums, and fall back composites to JSON.
  if (ct.kind === 'enum') {
    const values = (ct.values ?? []).map(quoteString);
    return values.length ? `ENUM(${values.join(',')})` : 'TEXT';
  }
  warnings.push(`${columnLabel} uses custom composite type "${ct.name}", which MariaDB has no equivalent for; emitted as JSON.`);
  return 'JSON';
}

/**
 * SQLite only accepts a literal, CURRENT_TIMESTAMP-style keywords, or a
 * parenthesised expression after DEFAULT; now() does not exist there at all.
 */
function sqliteDefault(raw: string): string {
  const v = raw.trim();
  if (/^(now|current_timestamp|localtimestamp)\s*\(\s*\)$/i.test(v)) return 'CURRENT_TIMESTAMP';
  if (/^(current_date|current_time)\s*\(\s*\)$/i.test(v)) return v.replace(/\s*\(\s*\)$/, '').toUpperCase();
  if (/^-?\d+(\.\d+)?$/.test(v) || /^'(?:[^']|'')*'$/.test(v) || /^(null|true|false|current_timestamp|current_date|current_time)$/i.test(v)) return v;
  if (/^\(.*\)$/.test(v)) return v;
  return `(${v})`;
}

function columnLine(ctx: Ctx, c: Column, inlinePk: boolean, warnings: string[]): string {
  const { dialect } = ctx;
  const parts: string[] = [quoteIdent(c.name, dialect)];
  let type = resolveColumnType(ctx, c.type, `Column "${c.name}"`, warnings);

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

  if (dialect === 'sqlite') {
    // AUTOINCREMENT is only legal on the exact spelling INTEGER PRIMARY KEY.
    if (c.autoIncrement && inlinePk) {
      if (!isIntegerType(type)) warnings.push(`Column "${c.name}" is auto-increment, so SQLite needs it to be INTEGER; its type ${type} was replaced.`);
      parts.push('INTEGER PRIMARY KEY AUTOINCREMENT');
    } else {
      if (c.autoIncrement) warnings.push(`Column "${c.name}" is auto-increment but not the single primary key; SQLite only auto-increments an INTEGER PRIMARY KEY.`);
      parts.push(isSerialType(type) ? 'INTEGER' : type);
      if (inlinePk) parts.push('PRIMARY KEY');
      if (!c.nullable && !inlinePk) parts.push('NOT NULL');
    }
    if (c.defaultValue && c.defaultValue.trim()) parts.push(`DEFAULT ${sqliteDefault(c.defaultValue.trim())}`);
    if (c.unique && !inlinePk) parts.push('UNIQUE');
    const ct = findCustomType(ctx.d.customTypes, c.type);
    if (ct?.kind === 'enum') {
      const values = (ct.values ?? []).filter((v) => v.trim());
      if (values.length) parts.push(`CHECK (${quoteIdent(c.name, dialect)} IN (${values.map(quoteString).join(', ')}))`);
    }
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

function createTable(ctx: Ctx, t: Table, opts: TableSqlOptions, warnings: string[]): { create: string; extras: string[]; notes: string[] } {
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
    lines.push(columnLine(ctx, c, c.id === inlinePkId, warnings));
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

  const notes: string[] = [];
  if (dialect === 'postgresql') {
    if (t.comment && t.comment.trim()) extras.push(`COMMENT ON TABLE ${tableName(t, dialect)} IS ${quoteString(t.comment.trim())};`);
    for (const c of t.columns) {
      if (c.comment && c.comment.trim()) {
        extras.push(`COMMENT ON COLUMN ${tableName(t, dialect)}.${quoteIdent(c.name, dialect)} IS ${quoteString(c.comment.trim())};`);
      }
    }
  } else if (dialect === 'sqlite') {
    // SQLite keeps no comments, so they live in the script as comment lines only.
    if (t.comment && t.comment.trim()) notes.push(`-- ${t.name}: ${t.comment.trim().replace(/\r?\n/g, ' ')}`);
    for (const c of t.columns) {
      if (c.comment && c.comment.trim()) notes.push(`-- ${t.name}.${c.name}: ${c.comment.trim().replace(/\r?\n/g, ' ')}`);
    }
  }
  return { create, extras, notes };
}

/** CREATE VIEW for a view table; null (with a warning) when it has no SELECT yet. */
function createView(ctx: Ctx, t: Table, warnings: string[]): string | null {
  const sql = (t.viewSql ?? '').trim().replace(/;+$/, '');
  if (!sql) {
    warnings.push(`View ${t.name} has no SELECT yet and was skipped.`);
    return null;
  }
  const keyword = ctx.dialect === 'mariadb' ? 'CREATE OR REPLACE VIEW' : 'CREATE VIEW';
  return `${keyword} ${tableName(t, ctx.dialect)} AS\n${sql};`;
}

/** CREATE TYPE statements for named enum/composite types (PostgreSQL only; MariaDB inlines/falls back per-column). */
function createTypeStatements(d: Diagram, warnings: string[]): string[] {
  if (d.customTypes.length === 0) return [];
  if (d.dialect === 'sqlite') {
    warnings.push('SQLite has no CREATE TYPE: enum types became CHECK constraints and composite types TEXT.');
    return [];
  }
  if (d.dialect !== 'postgresql') {
    warnings.push('MariaDB has no CREATE TYPE: enum types were inlined per column and composite types fell back to JSON.');
    return [];
  }
  const statements: string[] = [];
  for (const ct of d.customTypes) {
    const name = quoteIdent(ct.name, d.dialect);
    if (ct.kind === 'enum') {
      const values = (ct.values ?? []).filter((v) => v.trim());
      if (values.length === 0) {
        warnings.push(`Custom type "${ct.name}" has no values and was skipped.`);
        continue;
      }
      statements.push(`CREATE TYPE ${name} AS ENUM (${values.map(quoteString).join(', ')});`);
    } else {
      const fields = (ct.fields ?? []).filter((f) => f.name.trim());
      if (fields.length === 0) {
        warnings.push(`Custom type "${ct.name}" has no fields and was skipped.`);
        continue;
      }
      const body = fields.map((f) => `${quoteIdent(f.name, d.dialect)} ${f.type.trim() || 'TEXT'}`).join(', ');
      statements.push(`CREATE TYPE ${name} AS (${body});`);
    }
  }
  return statements;
}

function alterAddFk(ctx: Ctx, r: Relationship): string | null {
  const src = ctx.tableById.get(r.sourceTableId);
  const clause = fkClause(ctx, r);
  if (!src || !clause) return null;
  return `ALTER TABLE ${tableName(src, ctx.dialect)} ADD ${clause};`;
}

/** Column types that hold a point in time, for choosing how to subtract two of them. */
function temporalKind(type: string): 'date' | 'timestamp' | null {
  const base = type.trim().toUpperCase().replace(/\(.*$/, '').trim();
  if (base === 'DATE') return 'date';
  if (/^(TIMESTAMP|TIMESTAMPTZ|DATETIME|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITHOUT TIME ZONE)$/.test(base)) return 'timestamp';
  return null;
}

/**
 * Qualify bare column names of the source table (quantity -> order_items.quantity)
 * so they stay unambiguous once the statement joins other tables. Words that
 * are function calls, already qualified, or type names after AS are left alone.
 */
function qualifyBareColumns(text: string, src: Table, dialect: Dialect): string {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return text;
  }
  const names = new Map(src.columns.map((c) => [c.name.toLowerCase(), c.name]));
  let out = '';
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'eof') break;
    out += text.slice(last, t.start);
    last = t.end;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const isName = (t.type === 'word' || t.type === 'quoted') && names.has(t.value.toLowerCase());
    const qualified = prev?.type === 'punct' && prev.value === '.';
    const call = next?.type === 'punct' && next.value === '(';
    const dotted = next?.type === 'punct' && next.value === '.';
    const afterAs = prev?.type === 'word' && prev.upper === 'AS';
    if (isName && !qualified && !call && !dotted && !afterAs) out += `${quoteIdent(src.name, dialect)}.${quoteIdent(names.get(t.value.toLowerCase())!, dialect)}`;
    else out += text.slice(t.start, t.end);
  }
  return out + text.slice(last);
}

interface FlowJoins {
  /** JOIN lines in the order they must appear. */
  lines: string[];
  /** Ids of the tables joined. */
  tableIds: Set<string>;
}

/**
 * The JOINs a group of derivations needs: every table.column reference whose
 * table the source reaches through foreign keys becomes a JOIN along that
 * chain. References the diagram cannot resolve are left as written, with a
 * warning, so the skeleton still shows the intent.
 */
function flowJoins(ctx: Ctx, src: Table, texts: string[], warnings: string[]): FlowJoins {
  const { dialect } = ctx;
  const joins: FlowJoins = { lines: [], tableIds: new Set() };
  const wanted = new Map<string, string>();
  for (const text of texts) {
    if (!text.trim() || text.trim() === '*') continue;
    let refs: ColumnRef[];
    try {
      refs = collectReferences(parseExpression(text));
    } catch {
      continue;
    }
    for (const ref of refs) {
      if (!ref.table || ref.table.toLowerCase() === src.name.toLowerCase()) continue;
      if (!wanted.has(ref.table.toLowerCase())) wanted.set(ref.table.toLowerCase(), `${ref.table}.${ref.name}`);
    }
  }
  for (const [table, example] of wanted) {
    const path = foreignKeyPath(ctx.d, src.id, table);
    if (!path) {
      warnings.push(`Data flow from ${src.name}: "${example}" is not reachable through foreign keys, so no JOIN was written for it.`);
      continue;
    }
    for (const step of path) {
      if (joins.tableIds.has(step.parentId)) continue;
      const fk = step.relationship;
      const child = ctx.tableById.get(fk.sourceTableId);
      const parent = ctx.tableById.get(step.parentId);
      if (!child || !parent) continue;
      const pairs = fk.sourceColumnIds.map((sid, k) => {
        const sc = child.columns.find((c) => c.id === sid)?.name ?? '?';
        const tc = parent.columns.find((c) => c.id === fk.targetColumnIds[k])?.name ?? '?';
        return `${quoteIdent(parent.name, dialect)}.${quoteIdent(tc, dialect)} = ${quoteIdent(child.name, dialect)}.${quoteIdent(sc, dialect)}`;
      });
      joins.lines.push(`JOIN ${tableName(parent, dialect)} ON ${pairs.join(' AND ')}`);
      joins.tableIds.add(step.parentId);
    }
  }
  return joins;
}

/** The type of an expression when it is a single column reference (bare or through foreign keys); null otherwise. */
function referencedColumnType(ctx: Ctx, src: Table, text: string): string | null {
  let expr: Expr;
  try {
    expr = parseExpression(text);
  } catch {
    return null;
  }
  if (expr.kind !== 'column') return null;
  if (!expr.table || expr.table.toLowerCase() === src.name.toLowerCase()) {
    return src.columns.find((c) => c.name.toLowerCase() === expr.name.toLowerCase())?.type ?? null;
  }
  const path = foreignKeyPath(ctx.d, src.id, expr.table);
  if (!path) return null;
  const far = ctx.tableById.get(path[path.length - 1].parentId);
  return far?.columns.find((c) => c.name.toLowerCase() === expr.name.toLowerCase())?.type ?? null;
}

/**
 * The SQL for one sequence (window) derivation, per dialect. DIFF on a date or
 * timestamp column subtracts the way each database does it (days for dates,
 * seconds for timestamps), so the snippet runs as written.
 */
function windowSql(ctx: Ctx, src: Table, dv: Derivation, q: (text: string) => string): string {
  const w = dv.window!;
  const { dialect } = ctx;
  const clause = [
    w.partitionBy.filter((k) => k.trim()).length ? `PARTITION BY ${w.partitionBy.filter((k) => k.trim()).map(q).join(', ')}` : '',
    w.orderBy.filter((k) => k.trim()).length ? `ORDER BY ${w.orderBy.filter((k) => k.trim()).map(q).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const expr = q(dv.expression.trim());
  switch (w.fn) {
    case 'LAG':
    case 'LEAD':
      return `${w.fn}(${expr}) OVER (${clause})`;
    case 'DIFF': {
      const prev = `LAG(${expr}) OVER (${clause})`;
      const kind = temporalKind(referencedColumnType(ctx, src, dv.expression) ?? '');
      if (kind === 'date') {
        if (dialect === 'mariadb') return `DATEDIFF(${expr}, ${prev})`;
        if (dialect === 'sqlite') return `julianday(${expr}) - julianday(${prev})`;
        return `${expr} - ${prev}`;
      }
      if (kind === 'timestamp') {
        if (dialect === 'mariadb') return `TIMESTAMPDIFF(SECOND, ${prev}, ${expr})`;
        if (dialect === 'sqlite') return `(julianday(${expr}) - julianday(${prev})) * 86400`;
        return `EXTRACT(EPOCH FROM (${expr} - ${prev}))`;
      }
      return `${expr} - ${prev}`;
    }
    case 'RUNNING_SUM':
      return `SUM(${expr}) OVER (${clause} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
    case 'RUNNING_AVG':
      return `AVG(${expr}) OVER (${clause} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
    case 'ROW_NUMBER':
      return `ROW_NUMBER() OVER (${clause})`;
    case 'RANK':
      return `RANK() OVER (${clause})`;
    default:
      return expr;
  }
}

/**
 * INSERT ... SELECT statements built from a flow's structured derivations, one
 * per distinct (GROUP BY, WHERE) signature, so two columns rolled up the same
 * way share a statement.
 *
 * A grouping key that also names a column of the target table is carried into
 * the insert list (product_id in the shop sample) unless a derivation fills that
 * column explicitly. Columns of other tables (orders.status) are reached through
 * the diagram's foreign keys and turn into JOINs; sequence operations become
 * window functions, and a sequence that is then aggregated (the average gap)
 * is written as a subquery, because SQL cannot nest one inside the other.
 */
function flowStatements(ctx: Ctx, r: Relationship, warnings: string[]): string[] {
  const src = ctx.tableById.get(r.sourceTableId);
  const tgt = ctx.tableById.get(r.targetTableId);
  if (!src || !tgt) return [];
  const { dialect } = ctx;

  const usable: Derivation[] = [];
  for (const dv of flowDerivations(r)) {
    if (isDerivationComplete(dv) && tgt.columns.some((c) => c.id === dv.targetColumnId)) usable.push(dv);
    else warnings.push(`Data flow ${src.name} -> ${tgt.name} has an incomplete derivation; it was left out of the generated snippet.`);
  }
  if (!usable.length) return [];

  const out: string[] = [];
  for (const group of groupDerivations(usable)) {
    const texts = group.entries.flatMap((dv) => [dv.expression, ...(dv.window ? [...dv.window.orderBy.map((k) => parseOrderKey(k).expression), ...dv.window.partitionBy] : [])]);
    texts.push(...group.groupBy, group.filter);
    const joins = flowJoins(ctx, src, texts, warnings);
    // With other tables in the FROM list, a bare column name could be ambiguous.
    const q = (text: string) => (joins.lines.length ? qualifyBareColumns(text, src, dialect) : text);
    const from = [`FROM ${tableName(src, dialect)}`, ...joins.lines];
    const targetName = (dv: Derivation) => tgt.columns.find((c) => c.id === dv.targetColumnId)!.name;
    const explicit = new Set(group.entries.map((dv) => dv.targetColumnId));
    const keys = group.groupBy.map((key, n) => {
      const column = tgt.columns.find((c) => c.name.toLowerCase() === key.toLowerCase());
      return { key, column: column && !explicit.has(column.id) ? column : undefined, alias: column ? column.name : `key_${n + 1}` };
    });
    const carried = keys.filter((k): k is { key: string; column: Column; alias: string } => Boolean(k.column));
    const rowValue = (dv: Derivation): string => {
      if (dv.window) return windowSql(ctx, src, dv, q);
      const text = dv.expression.trim();
      return !text || text === '*' ? '*' : q(text);
    };
    const insertCols = [...carried.map((k) => quoteIdent(k.column.name, dialect)), ...group.entries.map((dv) => quoteIdent(targetName(dv), dialect))];
    const hasWindow = group.entries.some((dv) => dv.window);
    const hasAggregate = group.groupBy.length > 0 || group.entries.some((dv) => dv.aggregate);

    if (hasWindow && hasAggregate) {
      // Window functions cannot sit inside an aggregate: compute them in a subquery first.
      // A key that a derivation also fills would give the subquery two columns of one name.
      const entryNames = new Set(group.entries.map((dv) => targetName(dv).toLowerCase()));
      const innerKeys = keys.filter((k) => !entryNames.has(k.alias.toLowerCase()));
      const innerItems = [...innerKeys.map((k) => `${q(k.key)} AS ${quoteIdent(k.alias, dialect)}`), ...group.entries.map((dv) => `${rowValue(dv)} AS ${quoteIdent(targetName(dv), dialect)}`)];
      const inner = [`SELECT ${innerItems.join(', ')}`, ...from];
      if (group.filter) inner.push(`WHERE ${q(group.filter)}`);
      const outerItems = [
        ...carried.map((k) => quoteIdent(k.alias, dialect)),
        ...group.entries.map((dv) => (dv.aggregate ? `${dv.aggregate}(${quoteIdent(targetName(dv), dialect)})` : quoteIdent(targetName(dv), dialect))),
      ];
      const outerGroup = [...innerKeys.map((k) => quoteIdent(k.alias, dialect)), ...group.entries.filter((dv) => !dv.aggregate).map((dv) => quoteIdent(targetName(dv), dialect))];
      const lines = [
        `INSERT INTO ${tableName(tgt, dialect)} (${insertCols.join(', ')})`,
        `SELECT ${outerItems.join(', ')}`,
        `FROM (`,
        ...inner.map((l) => `  ${l}`),
        `) AS w`,
      ];
      if (outerGroup.length) lines.push(`GROUP BY ${outerGroup.join(', ')}`);
      out.push(`${lines.join('\n')};`);
      continue;
    }

    const selectItems = [
      ...carried.map((k) => q(k.key)),
      ...group.entries.map((dv) => {
        const value = rowValue(dv);
        if (!dv.aggregate) return value;
        return `${dv.aggregate}(${value})`;
      }),
    ];
    const lines = [`INSERT INTO ${tableName(tgt, dialect)} (${insertCols.join(', ')})`, `SELECT ${selectItems.join(', ')}`, ...from];
    if (group.filter) lines.push(`WHERE ${q(group.filter)}`);
    if (group.groupBy.length) lines.push(`GROUP BY ${group.groupBy.map(q).join(', ')}`);
    out.push(`${lines.join('\n')};`);
  }
  return out;
}

/**
 * The generated snippet for one flow relationship, uncommented - used by the
 * inspector to preview what the structured metadata produces.
 */
export function generateFlowSql(d: Diagram, relationshipId: string): string {
  const ctx = buildCtx(d);
  const r = d.relationships.find((x) => x.id === relationshipId);
  if (!r) return '';
  return flowStatements(ctx, r, []).join('\n\n');
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
  const ordered = orderTables(d, ctx.external);
  const order = ordered.order;
  // SQLite checks foreign keys at run time, so a reference to a table created later is fine inline.
  const deferred = d.dialect === 'sqlite' ? new Set<string>() : ordered.deferred;
  const statements: string[] = [];
  const scriptParts: string[] = [];
  const tableSql: Record<string, string> = {};

  if (d.dialect === 'sqlite') {
    const schemaed = d.tables.filter((t) => t.schema && !ctx.external.has(t.id)).map((t) => t.name);
    if (schemaed.length) warnings.push(`SQLite has no schemas; the schema prefix was dropped for ${schemaed.join(', ')}.`);
  }

  // A foreign key can only be created when both ends are in this database. One
  // that points into an external group is documented instead of executed.
  const crossing: Relationship[] = [];
  const fksBySource = new Map<string, Relationship[]>();
  for (const r of d.relationships) {
    if (r.kind !== 'fk') continue;
    const srcTable = ctx.tableById.get(r.sourceTableId);
    const tgtTable = ctx.tableById.get(r.targetTableId);
    if (srcTable?.kind === 'view' || tgtTable?.kind === 'view') {
      warnings.push(`Foreign key ${srcTable?.name ?? '?'} → ${tgtTable?.name ?? '?'} touches a view; views cannot take part in foreign keys, so it was skipped.`);
      continue;
    }
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

  const label = d.dialect === 'postgresql' ? 'PostgreSQL' : d.dialect === 'mariadb' ? 'MariaDB' : 'SQLite';
  const externalTables = d.tables.filter((t) => ctx.external.has(t.id));
  const views = orderViews(d).filter((v) => !ctx.external.has(v.id));
  const documented = d.relationships.filter((r) => !kindMeta(r.kind).emitsDdl).length;
  const createdFks = [...fksBySource.values()].reduce((n, list) => n + list.length, 0);
  const headLines = [
    `-- ${d.name || 'Untitled diagram'} (${label})`,
    '-- Generated by Database Visualizer',
    `-- Tables: ${order.length}${views.length ? `, views: ${views.length}` : ''}, foreign keys: ${createdFks}${documented ? `, documented connections: ${documented}` : ''}`,
  ];
  if (d.dialect === 'sqlite') headLines.push('-- Foreign keys are only enforced when the connection runs PRAGMA foreign_keys = ON (the in-browser engine does).');
  if (externalTables.length) {
    headLines.push(
      `-- ${externalTables.length} table(s) live in another database and are not created here; see "External sources" at the end.`,
    );
  }
  scriptParts.push(headLines.join('\n'));

  const typeStatements = createTypeStatements(d, warnings);
  if (typeStatements.length) {
    statements.push(...typeStatements);
    scriptParts.push(`-- Custom types\n${typeStatements.join('\n')}`);
  }

  for (const t of order) {
    const fks = (fksBySource.get(t.id) ?? []).filter((r) => !deferred.has(r.id));
    const { create, extras, notes } = createTable(ctx, t, { inlineFks: fks }, warnings);
    statements.push(create, ...extras);
    const block = [...notes, create, ...extras].join('\n');
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

  const viewStatements: string[] = [];
  for (const v of views) {
    const stmt = createView(ctx, v, warnings);
    if (!stmt) continue;
    viewStatements.push(stmt);
    tableSql[v.id] = stmt;
  }
  if (viewStatements.length) {
    statements.push(...viewStatements);
    scriptParts.push(`-- Views\n${viewStatements.join('\n\n')}`);
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

  // Documentation-only appendix: every connection the database cannot enforce
  // (data flows, serialized copies, dependencies) plus any tagged query.
  const annotated = d.relationships.filter((r) => !kindMeta(r.kind).emitsDdl || (r.query && r.query.trim()));
  if (annotated.length) {
    const lines: string[] = [
      '-- ----------------------------------------------------------------',
      '-- Connections the schema does not enforce, and tagged queries',
      '-- (documentation only, not executed)',
    ];
    for (const r of annotated) {
      const srcTable = ctx.tableById.get(r.sourceTableId);
      const tgtTable = ctx.tableById.get(r.targetTableId);
      const sentence = describeRelationship(r, srcTable?.name ?? '?', tgtTable?.name ?? '?');
      const storedIn = r.kind === 'embed' ? srcTable?.columns.find((c) => c.id === r.sourceColumnIds[0]) : undefined;
      const where = storedIn ? ` in ${srcTable!.name}.${storedIn.name}` : '';
      lines.push(`-- [${kindMeta(r.kind).short}] ${sentence}${where}${r.name ? ` (${r.name})` : ''}`);
      if (r.note && r.note.trim()) lines.push(commentBlock(r.note.trim()));

      const summaries = derivationSummaries(r, tgtTable);
      if (summaries.length) {
        lines.push('--   Derived columns:');
        for (const summary of summaries) lines.push(`--     ${summary}`);
      }
      const generated = flowStatements(ctx, r, warnings);
      if (generated.length) {
        lines.push('--   Built from the derivation metadata:');
        for (const stmt of generated) lines.push(commentBlock(stmt));
      }
      if (r.query && r.query.trim()) {
        if (summaries.length) lines.push('--   Tagged query:');
        lines.push(commentBlock(r.query.trim()));
      }
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
  if (t.kind === 'view') return createView(ctx, t, []) ?? `-- View ${t.name} has no SELECT yet.`;
  // A foreign key that would cross into another database is not real DDL.
  const fks = d.relationships.filter((r) => r.kind === 'fk' && r.sourceTableId === tableId && !ctx.external.has(r.targetTableId));
  const { create, extras, notes } = createTable(ctx, t, { inlineFks: fks }, []);
  const body = [...notes, create, ...extras].join('\n');
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
  const external = externalTableIds(d);
  const { order } = orderTables(d, external);
  const reversed = [...order].reverse();
  const viewDrops = orderViews(d)
    .filter((v) => !external.has(v.id))
    .reverse()
    .map((v) => `DROP VIEW IF EXISTS ${tableName(v, d.dialect)};`);
  if (d.dialect === 'postgresql') {
    return [
      ...viewDrops,
      ...reversed.map((t) => `DROP TABLE IF EXISTS ${tableName(t, d.dialect)} CASCADE;`),
      ...d.customTypes.map((ct) => `DROP TYPE IF EXISTS ${quoteIdent(ct.name, d.dialect)};`),
    ];
  }
  if (d.dialect === 'sqlite') {
    return [...viewDrops, ...reversed.map((t) => `DROP TABLE IF EXISTS ${tableName(t, d.dialect)};`)];
  }
  return [
    'SET FOREIGN_KEY_CHECKS = 0;',
    ...viewDrops,
    ...reversed.map((t) => `DROP TABLE IF EXISTS ${tableName(t, d.dialect)};`),
    'SET FOREIGN_KEY_CHECKS = 1;',
  ];
}

/* ---------------- Building blocks for migrations ---------------- */

/** The column's type as the script would emit it (named custom types resolved per dialect). */
export function resolvedColumnType(d: Diagram, column: Column): string {
  const ctx = buildCtx(d);
  return resolveColumnType(ctx, column.type, `Column "${column.name}"`, []);
}

/** One column's definition, as used by ADD COLUMN / MODIFY COLUMN (never with an inline PRIMARY KEY unless asked). */
export function columnDefinition(d: Diagram, column: Column, opts: { inlinePk?: boolean } = {}): string {
  const ctx = buildCtx(d);
  return columnLine(ctx, column, opts.inlinePk ?? false, []);
}

export interface TableDdl {
  create: string;
  /** CREATE INDEX statements (MariaDB keeps its KEY lines inside the CREATE TABLE). */
  indexes: string[];
  /** COMMENT ON statements (PostgreSQL only). */
  comments: string[];
}

/** CREATE TABLE for one table, with or without its foreign keys inline, plus its index and comment statements. */
export function tableDdl(d: Diagram, tableId: string, opts: { inlineFks: boolean }): TableDdl | null {
  const ctx = buildCtx(d);
  const t = ctx.tableById.get(tableId);
  if (!t || t.kind === 'view') return null;
  const fks = opts.inlineFks
    ? d.relationships.filter((r) => r.kind === 'fk' && r.sourceTableId === tableId && !ctx.external.has(r.targetTableId) && ctx.tableById.get(r.targetTableId)?.kind !== 'view')
    : [];
  const { create, extras } = createTable(ctx, t, { inlineFks: fks }, []);
  return { create, indexes: extras.filter((s) => /^CREATE /i.test(s)), comments: extras.filter((s) => /^COMMENT /i.test(s)) };
}

/** ALTER TABLE ... ADD CONSTRAINT for one foreign key (null when it is incomplete), with the constraint name the script uses. */
export function foreignKeyStatement(d: Diagram, relationshipId: string): { sql: string; name: string } | null {
  const ctx = buildCtx(d);
  const r = d.relationships.find((x) => x.id === relationshipId);
  if (!r || r.kind !== 'fk') return null;
  const sql = alterAddFk(ctx, r);
  return sql ? { sql, name: ctx.fkNames.get(r.id) ?? 'fk' } : null;
}

/** CREATE VIEW for one view table, or null when it has no SELECT. */
export function createViewStatement(d: Diagram, tableId: string): string | null {
  const ctx = buildCtx(d);
  const t = ctx.tableById.get(tableId);
  if (!t || t.kind !== 'view') return null;
  return createView(ctx, t, []);
}

/** CREATE TYPE for one enum type (PostgreSQL), or null when it has no values or the dialect has no named types. */
export function enumTypeStatement(d: Diagram, customTypeId: string): string | null {
  const ct = d.customTypes.find((c) => c.id === customTypeId);
  if (!ct || ct.kind !== 'enum' || d.dialect !== 'postgresql') return null;
  const values = (ct.values ?? []).filter((v) => v.trim());
  if (!values.length) return null;
  return `CREATE TYPE ${quoteIdent(ct.name, d.dialect)} AS ENUM (${values.map(quoteString).join(', ')});`;
}
