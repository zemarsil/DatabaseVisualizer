import type { Diagram, Dialect } from '@shared/types';
import { normalizeType, quoteIdent, quoteQualified, quoteString } from '../sql/dialect';
import { columnDefinition, createViewStatement, enumTypeStatement, foreignKeyStatement, orderTables, tableDdl } from '../sql/generator';
import { externalTableIds } from '../groups';
import type { Change, SchemaSnapshot, SnapColumn, SnapTable } from './diff';

/**
 * Turn selected changes into an ALTER script for the diagram's dialect.
 *
 * PostgreSQL and MariaDB get in-place ALTER TABLE statements. SQLite cannot
 * change a column or a constraint in place, so any table needing that is
 * rebuilt the way the SQLite documentation prescribes: create the new shape
 * under a temporary name, copy the rows across, drop the old table, rename.
 */

export interface MigrationEntry {
  changeId: string;
  sql: string;
}

export interface MigrationScript {
  /** Executable statements in order (no comments). */
  statements: string[];
  /** The same, as a readable script with headings. */
  script: string;
  entries: MigrationEntry[];
  warnings: string[];
  /** Table keys that SQLite rebuilds wholesale. */
  rebuilt: string[];
}

type Section = { title: string; lines: { changeId: string; sql: string; note?: string }[] };

/** A value that lets a NOT NULL column be added to a table that already has rows. */
export function placeholderFor(type: string, dialect: Dialect): string | null {
  const t = normalizeType(type);
  const base = t.replace(/\(.*$/, '').trim();
  if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL|NUMERIC|DECIMAL|DEC|REAL|FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION|MONEY|YEAR)$/.test(base)) return '0';
  if (/^(BOOL|BOOLEAN|BIT)$/.test(base)) return dialect === 'mariadb' ? '0' : 'FALSE';
  if (/^DATE$/.test(base)) return dialect === 'mariadb' ? 'CURDATE()' : 'CURRENT_DATE';
  if (/^(TIMESTAMP|TIMESTAMPTZ|DATETIME|TIME|TIMETZ)/.test(base) || /TIME ZONE/.test(t)) return 'CURRENT_TIMESTAMP';
  if (/^(JSON|JSONB)$/.test(base)) return "'{}'";
  if (/^(TEXT|VARCHAR|CHAR|CHARACTER|CHARACTER VARYING|NVARCHAR|NCHAR|TINYTEXT|MEDIUMTEXT|LONGTEXT|CITEXT|CLOB|ENUM|SET)$/.test(base)) return "''";
  if (/\[\]$/.test(t)) return "'{}'";
  return null;
}

export function generateMigration(d: Diagram, changes: Change[], current: SchemaSnapshot): MigrationScript {
  const dialect = d.dialect;
  const warnings: string[] = [];
  const q = (n: string) => quoteIdent(n, dialect);
  const tn = (t: SnapTable) => (dialect === 'sqlite' ? q(t.name) : quoteQualified(t.name, t.schema, dialect));
  const cols = (names: string[]) => names.map(q).join(', ');
  const curByKey = new Map(current.tables.map((t) => [t.key, t] as const));

  const sections: Section[] = [];
  const section = (title: string): Section => {
    const s: Section = { title, lines: [] };
    sections.push(s);
    return s;
  };

  /* ---- SQLite: which tables must be rebuilt ---- */
  const rebuild = new Set<string>();
  if (dialect === 'sqlite') {
    for (const c of changes) {
      const op = c.op;
      const constrained = (t: SnapTable, col: string) =>
        t.primaryKey.some((p) => p.toLowerCase() === col.toLowerCase()) ||
        t.indexes.some((ix) => ix.columns.some((x) => x.toLowerCase() === col.toLowerCase())) ||
        t.foreignKeys.some((fk) => fk.columns.some((x) => x.toLowerCase() === col.toLowerCase()));
      switch (op.kind) {
        case 'alter-column':
        case 'set-primary-key':
        case 'add-foreign-key':
        case 'drop-foreign-key':
          rebuild.add(op.table.key);
          break;
        case 'add-column':
          if (op.column.column?.primaryKey || op.column.column?.unique || (!op.column.nullable && !op.column.defaultValue)) rebuild.add(op.table.key);
          break;
        case 'drop-column': {
          const cur = curByKey.get(op.table.key);
          if (cur && constrained(cur, op.column.name)) rebuild.add(op.table.key);
          break;
        }
        case 'drop-index':
          if (op.index.constraint || /^sqlite_autoindex/i.test(op.index.name)) rebuild.add(op.table.key);
          break;
        default:
          break;
      }
    }
  }
  const dropsTable = changes.some((c) => c.op.kind === 'drop-table');
  const fkOff = dialect === 'sqlite' && (rebuild.size > 0 || dropsTable);
  const covered = (c: Change) => 'table' in c.op && rebuild.has(c.op.table.key);

  /* ---- 1. Types ---- */
  const types = section('Types');
  for (const c of changes) {
    const op = c.op;
    if (op.kind === 'create-enum') {
      const sql = (op.enum.customTypeId && enumTypeStatement(d, op.enum.customTypeId)) || `CREATE TYPE ${q(op.enum.name)} AS ENUM (${op.enum.values.map(quoteString).join(', ')});`;
      types.lines.push({ changeId: c.id, sql });
    } else if (op.kind === 'add-enum-values') {
      for (const v of op.values) types.lines.push({ changeId: c.id, sql: `ALTER TYPE ${q(op.enum.name)} ADD VALUE IF NOT EXISTS ${quoteString(v)};` });
      warnings.push(`New enum values (${op.enum.name}) cannot be used by later statements in the same transaction; if a statement fails on one, run the script with "Stop on first error" off.`);
    } else if (op.kind === 'enum-values-removed') {
      types.lines.push({ changeId: c.id, sql: '', note: `${op.enum.name} no longer lists ${op.values.join(', ')}: PostgreSQL cannot drop enum values; recreate the type by hand once no row uses them.` });
    }
  }

  /* ---- 2. Drop constraints, views, indexes, columns, tables ---- */
  const drops = section('Drop what the diagram no longer has');
  if (dialect === 'mariadb' && dropsTable) drops.lines.push({ changeId: '', sql: 'SET FOREIGN_KEY_CHECKS = 0;' });
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'drop-foreign-key' || covered(c)) continue;
    drops.lines.push({ changeId: c.id, sql: dialect === 'mariadb' ? `ALTER TABLE ${tn(op.table)} DROP FOREIGN KEY ${q(op.fk.name)};` : `ALTER TABLE ${tn(op.table)} DROP CONSTRAINT ${q(op.fk.name)};` });
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind === 'drop-view' || (op.kind === 'replace-view' && dialect !== 'mariadb')) {
      drops.lines.push({ changeId: c.id, sql: `DROP VIEW IF EXISTS ${tn(op.kind === 'replace-view' ? op.current : op.table)};` });
    }
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'drop-index' || covered(c)) continue;
    const cur = curByKey.get(op.table.key) ?? op.table;
    if (dialect === 'postgresql') {
      drops.lines.push({ changeId: c.id, sql: op.index.constraint ? `ALTER TABLE ${tn(cur)} DROP CONSTRAINT ${q(op.index.name)};` : `DROP INDEX IF EXISTS ${quoteQualified(op.index.name, cur.schema, dialect)};` });
    } else if (dialect === 'mariadb') {
      drops.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(cur)} DROP INDEX ${q(op.index.name)};` });
    } else {
      drops.lines.push({ changeId: c.id, sql: `DROP INDEX IF EXISTS ${q(op.index.name)};` });
    }
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'drop-column' || covered(c)) continue;
    drops.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(op.table)} DROP COLUMN ${q(op.column.name)};` });
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'drop-table') continue;
    drops.lines.push({ changeId: c.id, sql: `DROP TABLE IF EXISTS ${tn(op.table)}${dialect === 'postgresql' ? ' CASCADE' : ''};` });
  }
  if (dialect === 'mariadb' && dropsTable) drops.lines.push({ changeId: '', sql: 'SET FOREIGN_KEY_CHECKS = 1;' });

  /* ---- 3. Create tables (referenced tables first) ---- */
  const creates = section('New tables');
  const createChanges = changes.filter((c) => c.op.kind === 'create-table');
  const createByTableId = new Map<string, Change>();
  for (const c of createChanges) if (c.op.kind === 'create-table' && c.op.table.table) createByTableId.set(c.op.table.table.id, c);
  const { order } = orderTables(d, externalTableIds(d));
  const newTableFks: { changeId: string; sql: string }[] = [];
  const newTableComments: { changeId: string; sql: string }[] = [];
  for (const t of order) {
    const c = createByTableId.get(t.id);
    if (!c || c.op.kind !== 'create-table') continue;
    const ddl = tableDdl(d, t.id, { inlineFks: dialect === 'sqlite' });
    if (!ddl) continue;
    creates.lines.push({ changeId: c.id, sql: ddl.create });
    for (const ix of ddl.indexes) creates.lines.push({ changeId: c.id, sql: ix });
    for (const cm of ddl.comments) newTableComments.push({ changeId: c.id, sql: cm });
    if (dialect !== 'sqlite') {
      for (const fk of c.op.table.foreignKeys) {
        if (!fk.relationshipId) continue;
        const stmt = fkStatement(d, fk.relationshipId);
        if (stmt) newTableFks.push({ changeId: c.id, sql: stmt });
      }
    }
  }

  /* ---- 4. Columns ---- */
  const columns = section('Columns');
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'add-column' || covered(c) || !op.column.column) continue;
    const def = columnDefinition(d, { ...op.column.column, unique: false });
    const needsFill = !op.column.nullable && !op.column.defaultValue && !op.column.autoIncrement;
    if (needsFill && dialect === 'postgresql') {
      const ph = placeholderFor(op.column.type, dialect);
      if (ph) {
        columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(op.table)} ADD COLUMN ${def} DEFAULT ${ph};`, note: `NOT NULL with no default: existing rows get ${ph}, then the default is removed again.` });
        columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(op.table)} ALTER COLUMN ${q(op.column.name)} DROP DEFAULT;` });
        continue;
      }
      warnings.push(`${op.table.name}.${op.column.name} is NOT NULL without a default; adding it fails while the table has rows.`);
    }
    columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(op.table)} ADD COLUMN ${def};` });
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'alter-column' || covered(c) || !op.column.column) continue;
    const t = tn(op.table);
    const col = q(op.column.name);
    if (dialect === 'mariadb') {
      columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} MODIFY COLUMN ${columnDefinition(d, { ...op.column.column, unique: false })};` });
      continue;
    }
    for (const ch of op.changes) {
      if (ch === 'type') columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${op.column.type} USING ${col}::${op.column.type};` });
      else if (ch === 'nullable') columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} ${op.column.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};` });
      else if (ch === 'default') columns.lines.push({ changeId: c.id, sql: op.column.defaultValue ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${op.column.defaultValue};` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;` });
      else if (ch === 'autoIncrement') {
        columns.lines.push({
          changeId: c.id,
          sql: op.column.autoIncrement ? `ALTER TABLE ${t} ALTER COLUMN ${col} ADD GENERATED BY DEFAULT AS IDENTITY;` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP IDENTITY IF EXISTS, ALTER COLUMN ${col} DROP DEFAULT;`,
        });
      }
    }
  }

  /* ---- 5. Keys and indexes ---- */
  const keys = section('Keys and indexes');
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'set-primary-key' || covered(c)) continue;
    const t = tn(op.table);
    if (dialect === 'mariadb') {
      const parts = [op.from.length ? 'DROP PRIMARY KEY' : '', op.to.length ? `ADD PRIMARY KEY (${cols(op.to)})` : ''].filter(Boolean);
      keys.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ${parts.join(', ')};` });
    } else {
      if (op.from.length) {
        keys.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} DROP CONSTRAINT ${q(`${op.table.name}_pkey`)};`, note: 'constraint name assumed from the PostgreSQL default' });
        warnings.push(`The primary key constraint of ${op.table.name} is assumed to be named ${op.table.name}_pkey; adjust if it was created with another name.`);
      }
      if (op.to.length) keys.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ADD PRIMARY KEY (${cols(op.to)});` });
    }
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'add-index' || covered(c)) continue;
    const t = tn(op.table);
    const ix = op.index;
    if (dialect === 'postgresql') {
      keys.lines.push({ changeId: c.id, sql: ix.constraint ? `ALTER TABLE ${t} ADD CONSTRAINT ${q(ix.name)} UNIQUE (${cols(ix.columns)});` : `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${t} (${cols(ix.columns)});` });
    } else if (dialect === 'mariadb') {
      keys.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ADD ${ix.unique ? 'UNIQUE KEY' : 'INDEX'} ${q(ix.name)} (${cols(ix.columns)});` });
    } else {
      keys.lines.push({ changeId: c.id, sql: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(ix.name)} ON ${t} (${cols(ix.columns)});` });
    }
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'add-foreign-key' || covered(c) || !op.fk.relationshipId) continue;
    const stmt = fkStatement(d, op.fk.relationshipId);
    if (stmt) keys.lines.push({ changeId: c.id, sql: stmt });
  }
  for (const fk of newTableFks) keys.lines.push(fk);

  /* ---- 6. SQLite rebuilds ---- */
  const rebuilds = section('Rebuilt tables (SQLite cannot alter columns or constraints in place)');
  if (dialect === 'sqlite') {
    for (const key of rebuild) {
      const t = changes.find((c) => 'table' in c.op && c.op.table.key === key)?.op;
      const target = t && 'table' in t ? t.table : undefined;
      const cur = curByKey.get(key);
      const firstChange = changes.find((c) => 'table' in c.op && c.op.table.key === key);
      if (!target?.table || !cur || !firstChange) continue;
      const ddl = tableDdl(d, target.table.id, { inlineFks: true });
      if (!ddl) continue;
      const tmp = q(`__new_${target.name}`);
      const head = `CREATE TABLE ${tn(target)} (`;
      const create = ddl.create.startsWith(head) ? `CREATE TABLE ${tmp} (${ddl.create.slice(head.length)}` : ddl.create.replace(/^CREATE TABLE \S+/, `CREATE TABLE ${tmp}`);
      const curNames = new Set(cur.columns.map((c) => c.name.toLowerCase()));
      const insertCols: string[] = [];
      const selectCols: string[] = [];
      for (const col of target.columns) {
        if (curNames.has(col.name.toLowerCase())) {
          insertCols.push(q(col.name));
          selectCols.push(q(col.name));
        } else if (!col.nullable && !col.defaultValue && !col.autoIncrement) {
          const ph = placeholderFor(col.type, dialect);
          if (ph) {
            insertCols.push(q(col.name));
            selectCols.push(ph);
            warnings.push(`${target.name}.${col.name} is new and NOT NULL: existing rows get ${ph}.`);
          } else warnings.push(`${target.name}.${col.name} is new and NOT NULL with no default; copying existing rows will fail.`);
        }
      }
      const id = firstChange.id;
      rebuilds.lines.push({ changeId: id, sql: create, note: `${target.name}: ${changes.filter((c) => 'table' in c.op && c.op.table.key === key).map((c) => c.label).join('; ')}` });
      if (insertCols.length) rebuilds.lines.push({ changeId: id, sql: `INSERT INTO ${tmp} (${insertCols.join(', ')})\nSELECT ${selectCols.join(', ')} FROM ${tn(cur)};` });
      rebuilds.lines.push({ changeId: id, sql: `DROP TABLE ${tn(cur)};` });
      rebuilds.lines.push({ changeId: id, sql: `ALTER TABLE ${tmp} RENAME TO ${q(target.name)};` });
      for (const ix of ddl.indexes) rebuilds.lines.push({ changeId: id, sql: ix });
    }
  }

  /* ---- 7. Views ---- */
  const views = section('Views');
  for (const c of changes) {
    const op = c.op;
    if ((op.kind !== 'create-view' && op.kind !== 'replace-view') || !op.table.table) continue;
    const stmt = createViewStatement(d, op.table.table.id);
    if (stmt) views.lines.push({ changeId: c.id, sql: stmt });
  }

  /* ---- 8. Comments ---- */
  const comments = section('Comments');
  for (const cm of newTableComments) comments.lines.push(cm);
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'set-comment') continue;
    const t = tn(op.table);
    if (dialect === 'postgresql') {
      const value = op.comment ? quoteString(op.comment) : 'NULL';
      comments.lines.push({ changeId: c.id, sql: op.column ? `COMMENT ON COLUMN ${t}.${q(op.column.name)} IS ${value};` : `COMMENT ON TABLE ${t} IS ${value};` });
    } else if (dialect === 'mariadb') {
      if (op.column?.column) comments.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} MODIFY COLUMN ${columnDefinition(d, { ...op.column.column, unique: false })};` });
      else comments.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} COMMENT = ${quoteString(op.comment ?? '')};` });
    }
  }

  /* ---- 9. Drop types ---- */
  for (const c of changes) {
    const op = c.op;
    if (op.kind === 'drop-enum') types.lines.push({ changeId: c.id, sql: `DROP TYPE IF EXISTS ${q(op.enum.name)};` });
  }

  /* ---- Assemble ---- */
  const labelOf = new Map(changes.map((c) => [c.id, c.label] as const));
  const entries: MigrationEntry[] = [];
  const statements: string[] = [];
  const parts: string[] = [
    [
      `-- Migration for ${d.name || 'Untitled diagram'} (${dialect === 'postgresql' ? 'PostgreSQL' : dialect === 'mariadb' ? 'MariaDB' : 'SQLite'})`,
      '-- Generated by Database Visualizer from the difference between the diagram and the database.',
      '-- Review before running: the diagram knows the schema, not the data.',
    ].join('\n'),
  ];
  if (fkOff) {
    statements.push('PRAGMA foreign_keys = OFF;');
    entries.push({ changeId: '', sql: 'PRAGMA foreign_keys = OFF;' });
    parts.push('PRAGMA foreign_keys = OFF;');
  }
  if (dialect === 'sqlite' && rebuild.size) warnings.push(`${rebuild.size} table${rebuild.size === 1 ? ' is' : 's are'} rebuilt (copy, drop, rename) because SQLite cannot alter columns or constraints in place. Back the database up first.`);
  for (const s of sections) {
    if (!s.lines.length) continue;
    const lines = [`-- ${s.title}`];
    let last = '';
    for (const l of s.lines) {
      const label = labelOf.get(l.changeId);
      if (label && label !== last) {
        lines.push(`-- ${label}`);
        last = label;
      }
      if (l.note) lines.push(`--   ${l.note}`);
      if (!l.sql) continue;
      lines.push(l.sql);
      statements.push(l.sql);
      entries.push({ changeId: l.changeId, sql: l.sql });
    }
    parts.push(lines.join('\n'));
  }
  if (fkOff) {
    statements.push('PRAGMA foreign_keys = ON;');
    entries.push({ changeId: '', sql: 'PRAGMA foreign_keys = ON;' });
    parts.push('PRAGMA foreign_keys = ON;');
  }
  if (statements.length === (fkOff ? 2 : 0)) parts.push('-- Nothing to do: the database already matches the diagram.');
  return { statements, script: parts.join('\n\n') + '\n', entries, warnings: [...new Set(warnings)], rebuilt: [...rebuild] };
}

function fkStatement(d: Diagram, relationshipId: string): string | null {
  return foreignKeyStatement(d, relationshipId)?.sql ?? null;
}

/** Helper for the UI: the columns a snapshot column compares on, for tooltips. */
export function describeSnapColumn(c: SnapColumn): string {
  return `${c.type}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}${c.autoIncrement ? ' AUTO' : ''}`;
}
