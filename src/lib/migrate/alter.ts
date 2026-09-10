import { engineName, type Diagram, type Dialect } from '@shared/types';
import { normalizeType, quoteIdent, quoteQualified, quoteString } from '../sql/dialect';
import {
  columnDefinition,
  createViewStatement,
  enumTypeStatement,
  foreignKeyStatement,
  orderTables,
  resolvedColumnType,
  sequenceDefault,
  sequenceStatement,
  tableDdl,
} from '../sql/generator';
import { externalTableIds } from '../groups';
import type { Change, SchemaSnapshot, SnapColumn, SnapTable } from './diff';

/**
 * Turn selected changes into an ALTER script for the diagram's dialect.
 *
 * PostgreSQL and MariaDB get in-place ALTER TABLE statements. SQLite cannot
 * change a column or a constraint in place, so any table needing that is
 * rebuilt the way the SQLite documentation prescribes: create the new shape
 * under a temporary name, copy the rows across, drop the old table, rename.
 *
 * DuckDB alters columns in place but refuses to touch a table while an index
 * depends on it, so those indexes are dropped first and created again after;
 * and it cannot add or drop a constraint after CREATE TABLE at all (a primary
 * key can be added, once), so those changes are written as notes rather than
 * statements the engine would reject.
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
  if (/^(TEXT|VARCHAR|CHAR|CHARACTER|CHARACTER VARYING|NVARCHAR|NCHAR|TINYTEXT|MEDIUMTEXT|LONGTEXT|CITEXT|CLOB|ENUM|SET|STRING)$/.test(base)) return "''";
  if (/\[\]$/.test(t)) return dialect === 'duckdb' ? '[]' : "'{}'";
  if (/^(HUGEINT|UHUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)$/.test(base)) return '0';
  return null;
}

/** The sequence a DuckDB column's nextval() default reads, quoted as it appeared, or null. */
function sequenceOfDefault(defaultValue: string | null | undefined): string | null {
  const m = /^\s*nextval\s*\(\s*'((?:[^']|'')*)'\s*\)\s*$/i.exec(defaultValue ?? '');
  return m ? m[1].replace(/''/g, "'") : null;
}

export function generateMigration(d: Diagram, changes: Change[], current: SchemaSnapshot): MigrationScript {
  const dialect = d.dialect;
  const duck = dialect === 'duckdb';
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

  /* ---- DuckDB: which tables have to lose their indexes while a column changes ---- */
  // "Dependency Error: Cannot alter entry because there are entries that depend
  // on it" is what DuckDB says to any column change on a table with an index.
  // ADD COLUMN is the one alteration it allows through.
  const reindex = new Set<string>();
  // Tables other tables point at through a foreign key: DuckDB refuses the same
  // column changes there and nothing in a script can lift that.
  const referencedBy = new Map<string, Set<string>>();
  if (duck) {
    for (const t of current.tables) {
      for (const fk of t.foreignKeys) {
        if (fk.refKey === t.key) continue;
        if (!referencedBy.has(fk.refKey)) referencedBy.set(fk.refKey, new Set());
        referencedBy.get(fk.refKey)!.add(t.name);
      }
    }
    for (const c of changes) {
      const op = c.op;
      if (op.kind !== 'alter-column' && op.kind !== 'drop-column' && op.kind !== 'set-primary-key') continue;
      const cur = curByKey.get(op.table.key);
      if (cur?.indexes.some((ix) => !ix.constraint)) reindex.add(op.table.key);
      const parents = referencedBy.get(op.table.key);
      if (parents?.size) {
        warnings.push(
          `DuckDB refuses to change columns of ${op.table.name} while ${[...parents].join(', ')} reference${parents.size === 1 ? 's' : ''} it through a foreign key; if the statement fails, recreate the table by hand.`,
        );
      }
    }
  }
  const reindexed = (c: Change) => duck && 'table' in c.op && reindex.has(c.op.table.key);

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
      if (duck) {
        types.lines.push({ changeId: c.id, sql: '', note: `${op.enum.name} gains ${op.values.join(', ')}: DuckDB cannot add values to an enum type in place; recreate the type (and the columns using it) by hand.` });
        warnings.push(`DuckDB cannot add values to the enum type ${op.enum.name} in place; that change is written as a note.`);
      } else {
        for (const v of op.values) types.lines.push({ changeId: c.id, sql: `ALTER TYPE ${q(op.enum.name)} ADD VALUE IF NOT EXISTS ${quoteString(v)};` });
        warnings.push(`New enum values (${op.enum.name}) cannot be used by later statements in the same transaction; if a statement fails on one, run the script with "Stop on first error" off.`);
      }
    } else if (op.kind === 'enum-values-removed') {
      types.lines.push({ changeId: c.id, sql: '', note: `${op.enum.name} no longer lists ${op.values.join(', ')}: ${engineName(dialect)} cannot drop enum values; recreate the type by hand once no row uses them.` });
    }
  }

  /* ---- 2. Drop constraints, views, indexes, columns, tables ---- */
  const drops = section('Drop what the diagram no longer has');
  if (dialect === 'mariadb' && dropsTable) drops.lines.push({ changeId: '', sql: 'SET FOREIGN_KEY_CHECKS = 0;' });
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'drop-foreign-key' || covered(c)) continue;
    if (duck) {
      drops.lines.push({ changeId: c.id, sql: '', note: `${op.table.name}: DuckDB cannot drop the foreign key ${op.fk.name} (${op.fk.columns.join(', ')} → ${op.fk.refTable}) from an existing table; recreate the table by hand.` });
      warnings.push(`DuckDB cannot drop a foreign key from ${op.table.name} in place; that change is written as a note.`);
      continue;
    }
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
    if (op.kind !== 'drop-index' || covered(c) || reindexed(c)) continue;
    const cur = curByKey.get(op.table.key) ?? op.table;
    if (dialect === 'postgresql') {
      drops.lines.push({ changeId: c.id, sql: op.index.constraint ? `ALTER TABLE ${tn(cur)} DROP CONSTRAINT ${q(op.index.name)};` : `DROP INDEX IF EXISTS ${quoteQualified(op.index.name, cur.schema, dialect)};` });
    } else if (dialect === 'mariadb') {
      drops.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(cur)} DROP INDEX ${q(op.index.name)};` });
    } else if (duck && op.index.constraint) {
      drops.lines.push({ changeId: c.id, sql: '', note: `${op.table.name}: DuckDB cannot drop the UNIQUE constraint ${op.index.name} (${op.index.columns.join(', ')}) from an existing table; recreate the table by hand.` });
      warnings.push(`DuckDB cannot drop a UNIQUE constraint from ${op.table.name} in place; that change is written as a note.`);
    } else {
      drops.lines.push({ changeId: c.id, sql: `DROP INDEX IF EXISTS ${q(op.index.name)};` });
    }
  }
  // DuckDB: every index on a table whose columns change goes first and comes back at the end.
  if (duck) {
    for (const key of reindex) {
      const cur = curByKey.get(key);
      const firstChange = changes.find((c) => 'table' in c.op && c.op.table.key === key);
      if (!cur || !firstChange) continue;
      for (const ix of cur.indexes) {
        if (ix.constraint) continue;
        drops.lines.push({ changeId: firstChange.id, sql: `DROP INDEX IF EXISTS ${q(ix.name)};`, note: `${cur.name}: DuckDB refuses to alter an indexed table, so its indexes are dropped here and created again below.` });
      }
    }
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'drop-column' || covered(c)) continue;
    if (duck) {
      const cur = curByKey.get(op.table.key);
      const inKey =
        cur?.primaryKey.some((p) => p.toLowerCase() === op.column.name.toLowerCase()) ||
        cur?.foreignKeys.some((fk) => fk.columns.some((x) => x.toLowerCase() === op.column.name.toLowerCase())) ||
        cur?.indexes.some((ix) => ix.constraint && ix.columns.some((x) => x.toLowerCase() === op.column.name.toLowerCase()));
      if (inKey) {
        drops.lines.push({ changeId: c.id, sql: '', note: `${op.table.name}.${op.column.name} is part of a key or constraint, which DuckDB cannot drop a column out of; recreate the table by hand.` });
        warnings.push(`DuckDB cannot drop ${op.table.name}.${op.column.name} while a key or constraint uses it; that change is written as a note.`);
        continue;
      }
    }
    drops.lines.push({ changeId: c.id, sql: `ALTER TABLE ${tn(op.table)} DROP COLUMN ${q(op.column.name)};` });
  }
  // Tables that reference a dropped table go first: DuckDB and MariaDB (with
  // checks on) refuse to drop a parent while a child still points at it.
  const dropTableChanges = changes.filter((c) => c.op.kind === 'drop-table');
  const droppedKeys = new Set(dropTableChanges.map((c) => (c.op as { table: SnapTable }).table.key));
  const orderedDrops: Change[] = [];
  const placedDrops = new Set<string>();
  const placeDrop = (c: Change, depth: number) => {
    const t = (c.op as { table: SnapTable }).table;
    if (placedDrops.has(t.key)) return;
    if (depth < 50) {
      for (const other of dropTableChanges) {
        const ot = (other.op as { table: SnapTable }).table;
        if (ot.key !== t.key && ot.foreignKeys.some((fk) => fk.refKey === t.key) && droppedKeys.has(ot.key)) placeDrop(other, depth + 1);
      }
    }
    if (placedDrops.has(t.key)) return;
    placedDrops.add(t.key);
    orderedDrops.push(c);
  };
  for (const c of dropTableChanges) placeDrop(c, 0);
  for (const c of orderedDrops) {
    const op = c.op;
    if (op.kind !== 'drop-table') continue;
    drops.lines.push({ changeId: c.id, sql: `DROP TABLE IF EXISTS ${tn(op.table)}${dialect === 'postgresql' ? ' CASCADE' : ''};` });
    if (duck) {
      // The sequences its auto-increment columns read from. Never CASCADE on a
      // sequence: on DuckDB that would take the tables using it along.
      for (const col of op.table.columns) {
        const seq = sequenceOfDefault(col.defaultValue);
        if (seq) drops.lines.push({ changeId: c.id, sql: `DROP SEQUENCE IF EXISTS ${seq};` });
      }
    }
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
    // SQLite resolves foreign keys at run time and DuckDB cannot add one later,
    // so both keep every foreign key inside the CREATE TABLE.
    const inlineFks = dialect === 'sqlite' || duck;
    const ddl = tableDdl(d, t.id, { inlineFks });
    if (!ddl) continue;
    for (const seq of ddl.sequences) creates.lines.push({ changeId: c.id, sql: seq });
    creates.lines.push({ changeId: c.id, sql: ddl.create });
    for (const ix of ddl.indexes) creates.lines.push({ changeId: c.id, sql: ix });
    for (const cm of ddl.comments) newTableComments.push({ changeId: c.id, sql: cm });
    if (!inlineFks) {
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
    if (duck) {
      // DuckDB's ADD COLUMN takes a type and a default, nothing else ("Adding
      // columns with constraints not yet supported"); NOT NULL follows on its own.
      const t = tn(op.table);
      const col = q(op.column.name);
      const type = resolvedColumnType(d, op.column.column);
      const owner = d.tables.find((x) => x.id === op.table.table?.id) ?? op.table.table;
      const auto = op.column.autoIncrement && owner;
      if (auto) columns.lines.push({ changeId: c.id, sql: sequenceStatement(owner, op.column.column, dialect) });
      const dflt = auto ? sequenceDefault(owner, op.column.column, dialect) : op.column.defaultValue?.trim() || null;
      const needsFill = !op.column.nullable && !dflt;
      const ph = needsFill ? placeholderFor(op.column.type, dialect) : null;
      if (needsFill && !ph) warnings.push(`${op.table.name}.${op.column.name} is NOT NULL without a default; adding it fails while the table has rows.`);
      columns.lines.push({
        changeId: c.id,
        sql: `ALTER TABLE ${t} ADD COLUMN ${col} ${type}${dflt ? ` DEFAULT ${dflt}` : ph ? ` DEFAULT ${ph}` : ''};`,
        note: ph ? `NOT NULL with no default: existing rows get ${ph}, then the default is removed again.` : undefined,
      });
      if (!op.column.nullable) columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} SET NOT NULL;` });
      if (ph) columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;` });
      if (op.column.column.unique) {
        columns.lines.push({ changeId: c.id, sql: `CREATE UNIQUE INDEX ${q(`uq_${op.table.name}_${op.column.name}`)} ON ${t} (${col});`, note: 'DuckDB cannot add a UNIQUE constraint to an existing table; a unique index enforces the same rule.' });
      }
      if (op.column.column.check?.trim()) {
        columns.lines.push({ changeId: c.id, sql: '', note: `CHECK (${op.column.column.check.trim()}) on ${op.column.name}: DuckDB cannot add a CHECK constraint to an existing table.` });
        warnings.push(`The CHECK constraint on ${op.table.name}.${op.column.name} cannot be added to an existing DuckDB table; it is written as a note.`);
      }
      continue;
    }
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
    if (duck) {
      const cur = curByKey.get(op.table.key);
      const keyed =
        cur?.primaryKey.some((p) => p.toLowerCase() === op.column.name.toLowerCase()) ||
        cur?.foreignKeys.some((fk) => fk.columns.some((x) => x.toLowerCase() === op.column.name.toLowerCase())) ||
        cur?.indexes.some((ix) => ix.constraint && ix.columns.some((x) => x.toLowerCase() === op.column.name.toLowerCase()));
      const owner = d.tables.find((x) => x.id === op.table.table?.id) ?? op.table.table;
      for (const ch of op.changes) {
        if (ch === 'type') {
          if (keyed) {
            columns.lines.push({ changeId: c.id, sql: '', note: `${op.table.name}.${op.column.name} is part of a key, and DuckDB cannot change the type of such a column; recreate the table by hand.` });
            warnings.push(`DuckDB cannot change the type of ${op.table.name}.${op.column.name} while a key uses it; that change is written as a note.`);
          } else columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${op.column.type};` });
        } else if (ch === 'nullable') columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} ${op.column.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};` });
        else if (ch === 'default') columns.lines.push({ changeId: c.id, sql: op.column.defaultValue ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${op.column.defaultValue};` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;` });
        else if (ch === 'autoIncrement') {
          if (op.column.autoIncrement && owner) {
            columns.lines.push({ changeId: c.id, sql: sequenceStatement(owner, op.column.column, dialect) });
            columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${sequenceDefault(owner, op.column.column, dialect)};` });
          } else {
            columns.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;` });
            const seq = sequenceOfDefault(op.current.defaultValue);
            if (seq) columns.lines.push({ changeId: c.id, sql: `DROP SEQUENCE IF EXISTS ${seq};` });
          }
        }
      }
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
    } else if (duck) {
      if (op.from.length) {
        keys.lines.push({ changeId: c.id, sql: '', note: `${op.table.name}: DuckDB cannot drop or change a primary key (${op.from.join(', ')}) once the table exists; recreate the table by hand.` });
        warnings.push(`DuckDB cannot change the primary key of ${op.table.name} in place; that change is written as a note.`);
      } else if (op.to.length) keys.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ADD PRIMARY KEY (${cols(op.to)});` });
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
    if (op.kind !== 'add-index' || covered(c) || reindexed(c)) continue;
    const t = tn(op.table);
    const ix = op.index;
    if (dialect === 'postgresql') {
      keys.lines.push({ changeId: c.id, sql: ix.constraint ? `ALTER TABLE ${t} ADD CONSTRAINT ${q(ix.name)} UNIQUE (${cols(ix.columns)});` : `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${t} (${cols(ix.columns)});` });
    } else if (dialect === 'mariadb') {
      keys.lines.push({ changeId: c.id, sql: `ALTER TABLE ${t} ADD ${ix.unique ? 'UNIQUE KEY' : 'INDEX'} ${q(ix.name)} (${cols(ix.columns)});` });
    } else if (duck) {
      keys.lines.push({
        changeId: c.id,
        sql: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(ix.name)} ON ${t} (${cols(ix.columns)});`,
        note: ix.constraint ? 'DuckDB cannot add a UNIQUE constraint to an existing table; a unique index enforces the same rule.' : undefined,
      });
    } else {
      keys.lines.push({ changeId: c.id, sql: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(ix.name)} ON ${t} (${cols(ix.columns)});` });
    }
  }
  // DuckDB: the indexes dropped above come back as the diagram defines them.
  if (duck) {
    for (const key of reindex) {
      const firstChange = changes.find((c) => 'table' in c.op && c.op.table.key === key);
      const target = firstChange && 'table' in firstChange.op ? firstChange.op.table : undefined;
      if (!target?.table || !firstChange) continue;
      const ddl = tableDdl(d, target.table.id, { inlineFks: false });
      for (const ix of ddl?.indexes ?? []) keys.lines.push({ changeId: firstChange.id, sql: ix });
    }
  }
  for (const c of changes) {
    const op = c.op;
    if (op.kind !== 'add-foreign-key' || covered(c) || !op.fk.relationshipId) continue;
    const stmt = fkStatement(d, op.fk.relationshipId);
    if (!stmt) continue;
    if (duck) {
      keys.lines.push({ changeId: c.id, sql: '', note: `${op.table.name}: DuckDB cannot add a foreign key to an existing table. It would read: ${stmt}` });
      warnings.push(`DuckDB cannot add the foreign key ${op.table.name} (${op.fk.columns.join(', ')}) → ${op.fk.refTable} in place; it is written as a note.`);
      continue;
    }
    keys.lines.push({ changeId: c.id, sql: stmt });
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
    if (dialect === 'postgresql' || duck) {
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
      `-- Migration for ${d.name || 'Untitled diagram'} (${engineName(dialect)})`,
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
