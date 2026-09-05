import type { Column, Diagram, Dialect, IntrospectResponse, Table } from '@shared/types';
import { externalTableIds } from '../groups';
import { isSerialType, normalizeType } from '../sql/dialect';
import { foreignKeyStatement, resolvedColumnType } from '../sql/generator';

/**
 * Diagram vs. live database. Both sides are flattened into the same
 * "snapshot" shape (names, not ids), then compared table by table. The result
 * is a list of changes that alter.ts turns into per-dialect DDL.
 */

export interface SnapColumn {
  name: string;
  /** Type as the script would emit it / as the database reports it. */
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  comment: string | null;
  /** The diagram column this came from (target side only). */
  column?: Column;
}

export interface SnapFk {
  name: string;
  columns: string[];
  refKey: string;
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
  /** Diagram relationship id (target side only). */
  relationshipId?: string;
}

export interface SnapIndex {
  name: string;
  columns: string[];
  unique: boolean;
  /** A UNIQUE constraint (or SQLite auto-index) rather than a standalone index. */
  constraint: boolean;
}

export interface SnapTable {
  /** Lower-case match key: `name` in the default schema, otherwise `schema.name`. */
  key: string;
  schema?: string;
  name: string;
  kind: 'table' | 'view';
  viewSql: string;
  comment: string | null;
  columns: SnapColumn[];
  primaryKey: string[];
  indexes: SnapIndex[];
  foreignKeys: SnapFk[];
  /** The diagram table this came from (target side only). */
  table?: Table;
}

export interface SnapEnum {
  name: string;
  values: string[];
  customTypeId?: string;
}

export interface SchemaSnapshot {
  dialect: Dialect;
  tables: SnapTable[];
  enums: SnapEnum[];
}

export type ColumnChange = 'type' | 'nullable' | 'default' | 'autoIncrement';

export type MigrationOp =
  | { kind: 'create-table'; table: SnapTable }
  | { kind: 'drop-table'; table: SnapTable }
  | { kind: 'create-view'; table: SnapTable }
  | { kind: 'drop-view'; table: SnapTable }
  | { kind: 'replace-view'; table: SnapTable; current: SnapTable }
  | { kind: 'add-column'; table: SnapTable; column: SnapColumn }
  | { kind: 'drop-column'; table: SnapTable; column: SnapColumn }
  | { kind: 'alter-column'; table: SnapTable; column: SnapColumn; current: SnapColumn; changes: ColumnChange[] }
  | { kind: 'set-primary-key'; table: SnapTable; from: string[]; to: string[] }
  | { kind: 'add-foreign-key'; table: SnapTable; fk: SnapFk }
  | { kind: 'drop-foreign-key'; table: SnapTable; fk: SnapFk }
  | { kind: 'add-index'; table: SnapTable; index: SnapIndex }
  | { kind: 'drop-index'; table: SnapTable; index: SnapIndex }
  | { kind: 'set-comment'; table: SnapTable; column?: SnapColumn; comment: string | null }
  | { kind: 'create-enum'; enum: SnapEnum }
  | { kind: 'add-enum-values'; enum: SnapEnum; values: string[] }
  | { kind: 'enum-values-removed'; enum: SnapEnum; values: string[] }
  | { kind: 'drop-enum'; enum: SnapEnum };

export type Risk = 'safe' | 'risky' | 'destructive';

export interface Change {
  id: string;
  op: MigrationOp;
  /** Which table (key) the change belongs to; enums use "type:<name>". */
  group: string;
  label: string;
  detail?: string;
  risk: Risk;
  /** Ticked by default in the UI. Destructive and uncertain changes start unticked. */
  defaultOn: boolean;
  /** The comparison could be a false positive (the database reformats view SQL). */
  uncertain?: boolean;
}

/* ---------------- Normalisation ---------------- */

const TYPE_ALIASES: Record<string, string> = {
  INT: 'INTEGER',
  INT4: 'INTEGER',
  INT8: 'BIGINT',
  INT2: 'SMALLINT',
  SERIAL: 'INTEGER',
  BIGSERIAL: 'BIGINT',
  SMALLSERIAL: 'SMALLINT',
  BOOL: 'BOOLEAN',
  FLOAT4: 'REAL',
  FLOAT8: 'DOUBLE PRECISION',
  DOUBLE: 'DOUBLE PRECISION',
  DECIMAL: 'NUMERIC',
  DEC: 'NUMERIC',
  'CHARACTER VARYING': 'VARCHAR',
  CHARACTER: 'CHAR',
  'TIMESTAMP WITH TIME ZONE': 'TIMESTAMPTZ',
  'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
  'TIME WITH TIME ZONE': 'TIMETZ',
  'TIME WITHOUT TIME ZONE': 'TIME',
};

const INT_FAMILY = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)$/;

/** Reduce a type to the spelling both sides agree on, so `int(11)` equals `INT` and `character varying(20)` equals `VARCHAR(20)`. */
export function comparableType(type: string, dialect: Dialect): string {
  let norm = normalizeType(type);
  // PostgreSQL reports user types schema-qualified / quoted; the script quotes only when needed.
  norm = norm.replace(/^PUBLIC\./i, '').replace(/^"([^"]+)"/, '$1');
  const open = norm.indexOf('(');
  let base = norm;
  let args = '';
  let suffix = '';
  if (open !== -1) {
    const close = norm.indexOf(')', open);
    base = norm.slice(0, open).trim();
    args = close === -1 ? norm.slice(open) : norm.slice(open, close + 1);
    suffix = close === -1 ? '' : norm.slice(close + 1).trim();
  } else {
    const m = /^([A-Z0-9_]+(?: [A-Z0-9_]+)*?)((?:\s*\[\])+|\s+(?:UNSIGNED|ZEROFILL|WITH TIME ZONE|WITHOUT TIME ZONE)(?:\s+ZEROFILL)?)$/.exec(norm);
    if (m) {
      base = m[1].trim();
      suffix = m[2].trim();
    }
  }
  const upperBase = base.toUpperCase();
  const timeZoned = suffix && /TIME ZONE/.test(suffix) ? `${upperBase} ${suffix}` : null;
  let aliased = timeZoned && TYPE_ALIASES[timeZoned] ? TYPE_ALIASES[timeZoned] : (TYPE_ALIASES[upperBase] ?? upperBase);
  if (timeZoned && TYPE_ALIASES[timeZoned]) suffix = '';
  if (dialect === 'mariadb') {
    if (upperBase === 'TINYINT' && args === '(1)') return 'BOOLEAN';
    if (INT_FAMILY.test(upperBase)) args = ''; // display width is not part of the type
    if (aliased === 'DOUBLE PRECISION') aliased = 'DOUBLE';
  } else if (dialect === 'sqlite') {
    if (INT_FAMILY.test(upperBase)) args = '';
  }
  return `${aliased}${args}${suffix ? (suffix.startsWith('[') ? suffix : ` ${suffix}`) : ''}`.trim();
}

export function sameType(a: string, b: string, dialect: Dialect): boolean {
  return comparableType(a, dialect) === comparableType(b, dialect);
}

/** Default expressions as both sides would agree on them; null when there is none. */
export function comparableDefault(value: string | null | undefined, dialect: Dialect): string | null {
  if (value === null || value === undefined) return null;
  let v = value.trim();
  if (!v || /^null$/i.test(v)) return null;
  // PostgreSQL casts: 'pending'::character varying, 0::numeric
  v = v.replace(/::[a-z_][a-z0-9_ ]*(\([^)]*\))?(\[\])*/gi, '').trim();
  while (/^\(.*\)$/.test(v)) v = v.slice(1, -1).trim();
  v = v.replace(/\s+/g, ' ');
  if (/^(now|current_timestamp|localtimestamp|transaction_timestamp|utc_timestamp)(\s*\(\s*\d*\s*\))?$/i.test(v)) return 'current_timestamp';
  if (/^(current_date|curdate)(\s*\(\s*\))?$/i.test(v)) return 'current_date';
  if (/^(gen_random_uuid|uuid_generate_v4|uuid)\s*\(\s*\)$/i.test(v)) return 'uuid()';
  if (dialect === 'mariadb') {
    if (/^true$/i.test(v)) return '1';
    if (/^false$/i.test(v)) return '0';
    // Older servers report string defaults unquoted.
    if (!/^'.*'$/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) && !/\(/.test(v) && !/^current_/i.test(v)) v = `'${v}'`;
  }
  if (/^'.*'$/.test(v)) return v; // literal: keep case
  return v.toLowerCase();
}

export function tableKey(name: string, schema: string | undefined, defaultSchema: string): string {
  const s = (schema ?? '').trim().toLowerCase();
  return s && s !== defaultSchema ? `${s}.${name.toLowerCase()}` : name.toLowerCase();
}

function normalizeViewSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),.=<>])\s*/g, '$1')
    .replace(/;+\s*$/, '')
    .replace(/["`]/g, '')
    .trim()
    .toLowerCase();
}

function action(a: string | undefined | null): string {
  const v = (a ?? 'NO ACTION').toUpperCase().trim();
  return v || 'NO ACTION';
}

/* ---------------- Snapshots ---------------- */

/** Which schema names may be dropped from match keys: `public` on PostgreSQL, the database on MariaDB, `main` on SQLite. */
export function defaultSchemaOf(res: IntrospectResponse, dialect: Dialect): string {
  if (dialect === 'postgresql') return 'public';
  if (dialect === 'sqlite') return 'main';
  const counts = new Map<string, number>();
  for (const t of res.tables) counts.set(t.schema.toLowerCase(), (counts.get(t.schema.toLowerCase()) ?? 0) + 1);
  let best = '';
  let n = -1;
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c];
  return best;
}

/** The type the script writes for a column: SQLite forces INTEGER on auto-increment keys and serial types, the others keep the resolved type. */
function emittedType(d: Diagram, c: Column, singlePk: boolean): string {
  const type = resolvedColumnType(d, c);
  if (d.dialect === 'sqlite' && ((c.autoIncrement && c.primaryKey && singlePk) || isSerialType(type))) return 'INTEGER';
  return type;
}

export function snapshotFromDiagram(d: Diagram, defaultSchema: string): SchemaSnapshot {
  const external = externalTableIds(d);
  const byId = new Map(d.tables.map((t) => [t.id, t] as const));
  const keyOf = (t: Table) => (d.dialect === 'sqlite' ? t.name.toLowerCase() : tableKey(t.name, t.schema, defaultSchema));
  const tables: SnapTable[] = [];
  for (const t of d.tables) {
    if (external.has(t.id)) continue;
    const columns = t.columns.filter((c) => c.name.trim());
    const colName = (id: string) => t.columns.find((c) => c.id === id)?.name;
    const snap: SnapTable = {
      key: keyOf(t),
      schema: t.schema?.trim() || undefined,
      name: t.name,
      kind: t.kind === 'view' ? 'view' : 'table',
      viewSql: (t.viewSql ?? '').trim(),
      comment: t.comment?.trim() || null,
      columns: columns.map((c) => ({
        name: c.name,
        type: emittedType(d, c, columns.filter((x) => x.primaryKey).length === 1),
        nullable: c.nullable && !c.primaryKey,
        defaultValue: c.defaultValue?.trim() || null,
        autoIncrement: c.autoIncrement,
        comment: c.comment?.trim() || null,
        column: c,
      })),
      primaryKey: columns.filter((c) => c.primaryKey).map((c) => c.name),
      indexes: [],
      foreignKeys: [],
      table: t,
    };
    for (const c of columns) {
      if (c.unique && !c.primaryKey) snap.indexes.push({ name: `uq_${t.name}_${c.name}`, columns: [c.name], unique: true, constraint: true });
    }
    for (const ix of t.indexes) {
      const cols = ix.columnIds.map(colName).filter((n): n is string => Boolean(n));
      if (!cols.length) continue;
      snap.indexes.push({ name: ix.name.trim() || `${ix.unique ? 'uq' : 'idx'}_${t.name}_${cols.join('_')}`, columns: cols, unique: ix.unique, constraint: false });
    }
    if (snap.kind === 'table') {
      for (const r of d.relationships) {
        if (r.kind !== 'fk' || r.sourceTableId !== t.id) continue;
        const tgt = byId.get(r.targetTableId);
        if (!tgt || external.has(tgt.id) || tgt.kind === 'view') continue;
        const cols = r.sourceColumnIds.map(colName).filter((n): n is string => Boolean(n));
        const refCols = r.targetColumnIds.map((id) => tgt.columns.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n));
        if (!cols.length || cols.length !== refCols.length) continue;
        const stmt = foreignKeyStatement(d, r.id);
        snap.foreignKeys.push({
          name: stmt?.name ?? r.name ?? `fk_${t.name}_${tgt.name}`,
          columns: cols,
          refKey: keyOf(tgt),
          refTable: tgt.name,
          refColumns: refCols,
          onDelete: action(r.onDelete),
          onUpdate: action(r.onUpdate),
          relationshipId: r.id,
        });
      }
    }
    tables.push(snap);
  }
  const enums: SnapEnum[] =
    d.dialect === 'postgresql'
      ? d.customTypes.filter((ct) => ct.kind === 'enum' && (ct.values ?? []).some((v) => v.trim())).map((ct) => ({ name: ct.name, values: (ct.values ?? []).filter((v) => v.trim()), customTypeId: ct.id }))
      : [];
  return { dialect: d.dialect, tables, enums };
}

export function snapshotFromIntrospection(res: IntrospectResponse, dialect: Dialect): SchemaSnapshot {
  const defaultSchema = defaultSchemaOf(res, dialect);
  const tables: SnapTable[] = res.tables.map((t) => {
    const uniqueNames = new Set(t.uniques.map((u) => u.name.toLowerCase()));
    const indexes: SnapIndex[] = [
      ...t.uniques.map((u) => ({ name: u.name, columns: u.columns, unique: true, constraint: true })),
      ...t.indexes.filter((ix) => !uniqueNames.has(ix.name.toLowerCase())).map((ix) => ({ name: ix.name, columns: ix.columns, unique: ix.unique, constraint: false })),
    ];
    return {
      key: tableKey(t.name, t.schema, defaultSchema),
      schema: t.schema,
      name: t.name,
      kind: t.kind === 'view' ? 'view' : 'table',
      viewSql: (t.viewSql ?? '').trim(),
      comment: t.comment?.trim() || null,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, defaultValue: c.defaultValue, autoIncrement: c.autoIncrement, comment: c.comment?.trim() || null })),
      primaryKey: t.primaryKey,
      indexes,
      foreignKeys: t.foreignKeys.map((fk) => ({
        name: fk.name,
        columns: fk.columns,
        refKey: tableKey(fk.refTable, fk.refSchema ?? undefined, defaultSchema),
        refTable: fk.refTable,
        refColumns: fk.refColumns,
        onDelete: action(fk.onDelete),
        onUpdate: action(fk.onUpdate),
      })),
    };
  });
  const enums: SnapEnum[] = (res.enums ?? []).map((e) => ({ name: e.name, values: e.values }));
  return { dialect, tables, enums };
}

/* ---------------- Diff ---------------- */

function fkSignature(fk: SnapFk): string {
  return `${fk.columns.map((c) => c.toLowerCase()).join(',')}>${fk.refKey}(${fk.refColumns.map((c) => c.toLowerCase()).join(',')})`;
}

function indexSignature(ix: SnapIndex): string {
  return `${ix.unique ? 'u' : 'i'}:${ix.columns.map((c) => c.toLowerCase()).join(',')}`;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());
}

function pkKey(cols: string[]): string {
  return cols.map((c) => c.toLowerCase()).join(',');
}

let seq = 0;
function change(op: MigrationOp, group: string, label: string, risk: Risk, extra: Partial<Change> = {}): Change {
  return { id: `chg_${++seq}`, op, group, label, risk, defaultOn: risk !== 'destructive' && !extra.uncertain, ...extra };
}

function describeColumn(c: SnapColumn): string {
  return `${c.type}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}${c.autoIncrement ? ' auto-increment' : ''}`;
}

/** Every change needed to turn `current` (the database) into `target` (the diagram). */
export function diffSchemas(target: SchemaSnapshot, current: SchemaSnapshot): Change[] {
  const dialect = target.dialect;
  const out: Change[] = [];
  const curByKey = new Map(current.tables.map((t) => [t.key, t] as const));
  const tgtByKey = new Map(target.tables.map((t) => [t.key, t] as const));

  // Enums first (PostgreSQL): a column can only use a type that exists.
  if (dialect === 'postgresql') {
    const curEnums = new Map(current.enums.map((e) => [e.name.toLowerCase(), e] as const));
    const tgtEnums = new Map(target.enums.map((e) => [e.name.toLowerCase(), e] as const));
    for (const e of target.enums) {
      const cur = curEnums.get(e.name.toLowerCase());
      if (!cur) {
        out.push(change({ kind: 'create-enum', enum: e }, `type:${e.name}`, `Create enum type ${e.name}`, 'safe', { detail: e.values.join(', ') }));
        continue;
      }
      const curSet = new Set(cur.values);
      const added = e.values.filter((v) => !curSet.has(v));
      const removed = cur.values.filter((v) => !e.values.includes(v));
      if (added.length) out.push(change({ kind: 'add-enum-values', enum: e, values: added }, `type:${e.name}`, `Add ${added.length === 1 ? 'value' : 'values'} to ${e.name}`, 'safe', { detail: added.join(', ') }));
      if (removed.length) {
        out.push(
          change({ kind: 'enum-values-removed', enum: e, values: removed }, `type:${e.name}`, `${e.name} no longer lists ${removed.join(', ')}`, 'destructive', {
            detail: 'PostgreSQL cannot remove enum values in place; recreate the type by hand if rows never use them.',
          }),
        );
      }
    }
    for (const e of current.enums) {
      if (!tgtEnums.has(e.name.toLowerCase())) out.push(change({ kind: 'drop-enum', enum: e }, `type:${e.name}`, `Drop enum type ${e.name}`, 'destructive', { detail: 'Fails while a column still uses it.' }));
    }
  }

  // Tables and views present on one side only.
  for (const t of target.tables) {
    const cur = curByKey.get(t.key);
    if (cur) continue;
    if (t.kind === 'view') {
      if (t.viewSql) out.push(change({ kind: 'create-view', table: t }, t.key, `Create view ${t.name}`, 'safe'));
    } else {
      out.push(change({ kind: 'create-table', table: t }, t.key, `Create table ${t.name}`, 'safe', { detail: `${t.columns.length} column${t.columns.length === 1 ? '' : 's'}` }));
    }
  }
  for (const c of current.tables) {
    if (tgtByKey.has(c.key)) continue;
    if (c.kind === 'view') out.push(change({ kind: 'drop-view', table: c }, c.key, `Drop view ${c.name}`, 'destructive'));
    else out.push(change({ kind: 'drop-table', table: c }, c.key, `Drop table ${c.name}`, 'destructive', { detail: `${c.columns.length} column${c.columns.length === 1 ? '' : 's'} and all of its rows` }));
  }

  // Tables on both sides.
  for (const t of target.tables) {
    const cur = curByKey.get(t.key);
    if (!cur) continue;
    if (t.kind !== cur.kind) {
      // table <-> view: replace wholesale
      if (cur.kind === 'view') out.push(change({ kind: 'drop-view', table: cur }, t.key, `Drop view ${cur.name} (it is a table in the diagram)`, 'destructive'));
      else out.push(change({ kind: 'drop-table', table: cur }, t.key, `Drop table ${cur.name} (it is a view in the diagram)`, 'destructive'));
      if (t.kind === 'view') {
        if (t.viewSql) out.push(change({ kind: 'create-view', table: t }, t.key, `Create view ${t.name}`, 'safe'));
      } else out.push(change({ kind: 'create-table', table: t }, t.key, `Create table ${t.name}`, 'safe'));
      continue;
    }
    if (t.kind === 'view') {
      if (t.viewSql && normalizeViewSql(t.viewSql) !== normalizeViewSql(cur.viewSql)) {
        out.push(change({ kind: 'replace-view', table: t, current: cur }, t.key, `Replace view ${t.name}`, 'risky', { uncertain: true, detail: 'The database stores views reformatted, so the SELECT may only look different.' }));
      }
      continue;
    }

    const curCols = new Map(cur.columns.map((c) => [c.name.toLowerCase(), c] as const));
    const tgtCols = new Map(t.columns.map((c) => [c.name.toLowerCase(), c] as const));
    for (const col of t.columns) {
      const cc = curCols.get(col.name.toLowerCase());
      if (!cc) {
        out.push(change({ kind: 'add-column', table: t, column: col }, t.key, `Add column ${t.name}.${col.name}`, 'safe', { detail: describeColumn(col) }));
        continue;
      }
      const changes: ColumnChange[] = [];
      if (!sameType(col.type, cc.type, dialect)) changes.push('type');
      if (col.nullable !== cc.nullable) changes.push('nullable');
      if (col.autoIncrement !== cc.autoIncrement) changes.push('autoIncrement');
      if (!col.autoIncrement && !cc.autoIncrement && comparableDefault(col.defaultValue, dialect) !== comparableDefault(cc.defaultValue, dialect)) changes.push('default');
      if (changes.length) {
        const parts = changes.map((ch) => {
          if (ch === 'type') return `type ${cc.type} → ${col.type}`;
          if (ch === 'nullable') return col.nullable ? 'allow NULL' : 'NOT NULL';
          if (ch === 'default') return `default ${cc.defaultValue ?? 'none'} → ${col.defaultValue ?? 'none'}`;
          return col.autoIncrement ? 'auto-increment' : 'no auto-increment';
        });
        out.push(change({ kind: 'alter-column', table: t, column: col, current: cc, changes }, t.key, `Change ${t.name}.${col.name}`, changes.includes('type') || (changes.includes('nullable') && !col.nullable) ? 'risky' : 'safe', { detail: parts.join('; ') }));
      }
      if (dialect !== 'sqlite' && (col.comment ?? '') !== (cc.comment ?? '')) {
        out.push(change({ kind: 'set-comment', table: t, column: col, comment: col.comment }, t.key, `Comment on ${t.name}.${col.name}`, 'safe', { detail: col.comment ?? '(remove)' }));
      }
    }
    for (const cc of cur.columns) {
      if (!tgtCols.has(cc.name.toLowerCase())) out.push(change({ kind: 'drop-column', table: t, column: cc }, t.key, `Drop column ${t.name}.${cc.name}`, 'destructive', { detail: `${cc.type}; its values are lost` }));
    }

    if (pkKey(t.primaryKey) !== pkKey(cur.primaryKey)) {
      out.push(change({ kind: 'set-primary-key', table: t, from: cur.primaryKey, to: t.primaryKey }, t.key, `Primary key of ${t.name}`, 'risky', { detail: `${cur.primaryKey.join(', ') || 'none'} → ${t.primaryKey.join(', ') || 'none'}` }));
    }

    // Indexes and unique constraints, matched by columns rather than name.
    const curIx = new Map(cur.indexes.map((ix) => [indexSignature(ix), ix] as const));
    const tgtIx = new Map(t.indexes.map((ix) => [indexSignature(ix), ix] as const));
    for (const [sig, ix] of tgtIx) {
      if (curIx.has(sig)) continue;
      // A unique index on the primary key columns is redundant on every engine.
      if (ix.unique && sameList(ix.columns, t.primaryKey)) continue;
      out.push(change({ kind: 'add-index', table: t, index: ix }, t.key, `${ix.unique ? 'Unique' : 'Index'} on ${t.name} (${ix.columns.join(', ')})`, 'safe'));
    }
    for (const [sig, ix] of curIx) {
      if (tgtIx.has(sig)) continue;
      out.push(change({ kind: 'drop-index', table: t, index: ix }, t.key, `Drop ${ix.unique ? 'unique ' : ''}index ${ix.name} on ${t.name}`, 'safe', { detail: `(${ix.columns.join(', ')})`, defaultOn: true }));
    }

    const curFk = new Map(cur.foreignKeys.map((fk) => [fkSignature(fk), fk] as const));
    const tgtFk = new Map(t.foreignKeys.map((fk) => [fkSignature(fk), fk] as const));
    for (const [sig, fk] of tgtFk) {
      const existing = curFk.get(sig);
      if (existing && existing.onDelete === fk.onDelete && existing.onUpdate === fk.onUpdate) continue;
      if (existing) {
        out.push(change({ kind: 'drop-foreign-key', table: t, fk: existing }, t.key, `Drop foreign key ${existing.name} on ${t.name}`, 'safe', { detail: 'replaced: referential actions changed' }));
      }
      out.push(change({ kind: 'add-foreign-key', table: t, fk }, t.key, `Foreign key ${t.name} (${fk.columns.join(', ')}) → ${fk.refTable}`, 'risky', { detail: 'Fails when existing rows violate it.' }));
    }
    for (const [sig, fk] of curFk) {
      if (tgtFk.has(sig)) continue;
      out.push(change({ kind: 'drop-foreign-key', table: t, fk }, t.key, `Drop foreign key ${fk.name} on ${t.name}`, 'safe', { detail: `(${fk.columns.join(', ')}) → ${fk.refTable}` }));
    }

    if (dialect !== 'sqlite' && (t.comment ?? '') !== (cur.comment ?? '')) {
      out.push(change({ kind: 'set-comment', table: t, comment: t.comment }, t.key, `Comment on ${t.name}`, 'safe', { detail: t.comment ?? '(remove)' }));
    }
  }
  return out;
}

/** Diagram vs. database in one call. */
export function diffDiagramAgainst(d: Diagram, res: IntrospectResponse): { changes: Change[]; target: SchemaSnapshot; current: SchemaSnapshot } {
  const current = snapshotFromIntrospection(res, d.dialect);
  const target = snapshotFromDiagram(d, defaultSchemaOf(res, d.dialect));
  return { changes: diffSchemas(target, current), target, current };
}

export function summarizeChanges(changes: Change[]): { safe: number; risky: number; destructive: number } {
  const s = { safe: 0, risky: 0, destructive: 0 };
  for (const c of changes) s[c.risk]++;
  return s;
}
