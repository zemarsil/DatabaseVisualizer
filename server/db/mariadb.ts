import mariadb from 'mariadb';
import type {
  ConnectionConfig,
  DatabaseExtension,
  ExtensionsResponse,
  IntrospectResponse,
  IntrospectedRoutine,
  IntrospectedTable,
  QueryResult,
  ReferentialAction,
  StatementResult,
} from '../../src/shared/types';
import type { QueryOptions } from './index';
import { serializeRows, splitStatements } from './values';

async function connect(cfg: ConnectionConfig) {
  return mariadb.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    connectTimeout: 6000,
    multipleStatements: false,
    bigIntAsNumber: true,
  });
}

export async function testConnection(cfg: ConnectionConfig): Promise<string> {
  const c = await connect(cfg);
  try {
    const rows = (await c.query('SELECT VERSION() AS v')) as { v: string }[];
    return String(rows[0]?.v ?? 'unknown');
  } finally {
    await c.end();
  }
}

export async function applyStatements(cfg: ConnectionConfig, statements: string[], stopOnError: boolean): Promise<StatementResult[]> {
  const c = await connect(cfg);
  const results: StatementResult[] = [];
  try {
    // DDL auto-commits in MariaDB, so there is no transaction to wrap; we just stop early.
    for (let i = 0; i < statements.length; i++) {
      const sql = statements[i];
      const t0 = Date.now();
      try {
        await c.query(sql);
        results.push({ index: i, sql, ok: true, durationMs: Date.now() - t0 });
      } catch (e) {
        results.push({ index: i, sql, ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 });
        if (stopOnError) return results;
      }
    }
    return results;
  } finally {
    await c.end();
  }
}

function action(rule: string | null | undefined): ReferentialAction {
  const r = (rule ?? 'NO ACTION').toUpperCase();
  if (r === 'CASCADE' || r === 'RESTRICT' || r === 'SET NULL' || r === 'SET DEFAULT') return r;
  return 'NO ACTION';
}

/**
 * MariaDB's answer to extensions is plugins, which are libraries loaded into the
 * server rather than objects created in a database. information_schema.PLUGINS
 * lists both what is loaded and what is compiled in, which is as close to
 * pg_available_extensions as MariaDB gets.
 *
 * A plugin adds behaviour — a storage engine, an authentication method — not
 * types, so there is nothing to report under types or functions.
 */
export async function listExtensions(cfg: ConnectionConfig): Promise<ExtensionsResponse> {
  const c = await connect(cfg);
  try {
    const version = String(((await c.query('SELECT VERSION() AS v')) as { v: string }[])[0]?.v ?? 'unknown');
    const rows = (await c.query(
      `SELECT PLUGIN_NAME AS name, PLUGIN_VERSION AS version, PLUGIN_STATUS AS status,
              PLUGIN_TYPE AS type, PLUGIN_LIBRARY AS library, PLUGIN_DESCRIPTION AS description
         FROM information_schema.PLUGINS
        ORDER BY PLUGIN_NAME`,
    )) as { name: string; version: string; status: string; type: string; library: string | null; description: string | null }[];

    const extensions: DatabaseExtension[] = rows.map((r) => ({
      // The library is what INSTALL SONAME names; a plugin with none is
      // compiled into the server and cannot be installed or removed.
      name: r.library ? r.library.replace(/\.(so|dll|dylib)$/i, '') : r.name,
      installed: r.status === 'ACTIVE',
      installedVersion: r.status === 'ACTIVE' ? String(r.version) : undefined,
      comment: [r.type, r.description].filter(Boolean).join(': ') || undefined,
    }));

    // Several plugins share one library (ha_connect provides more than one), so
    // collapse them: the library is the unit INSTALL SONAME works in.
    const byName = new Map<string, DatabaseExtension>();
    for (const e of extensions) {
      const prev = byName.get(e.name);
      if (!prev) byName.set(e.name, e);
      else if (e.installed && !prev.installed) byName.set(e.name, e);
    }

    return {
      serverVersion: version,
      extensions: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      note: 'MariaDB has plugins rather than extensions: libraries loaded into the whole server, installed once with INSTALL SONAME rather than per database.',
    };
  } finally {
    await c.end();
  }
}

export async function introspect(cfg: ConnectionConfig): Promise<IntrospectResponse> {
  if (!cfg.database) throw new Error('A database name is required to introspect a MariaDB server.');
  const c = await connect(cfg);
  try {
    const version = String(((await c.query('SELECT VERSION() AS v')) as { v: string }[])[0]?.v ?? 'unknown');
    const db = cfg.database;

    const tables = (await c.query(
      `SELECT t.TABLE_NAME AS name, t.TABLE_COMMENT AS comment, t.TABLE_TYPE AS table_type, v.VIEW_DEFINITION AS view_sql
       FROM information_schema.TABLES t
       LEFT JOIN information_schema.VIEWS v ON v.TABLE_SCHEMA = t.TABLE_SCHEMA AND v.TABLE_NAME = t.TABLE_NAME
       WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY t.TABLE_NAME`,
      [db],
    )) as { name: string; comment: string | null; table_type: string; view_sql: string | null }[];

    const columns = (await c.query(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS default_value, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db],
    )) as { tbl: string; name: string; type: string; nullable: string; default_value: string | null; extra: string; comment: string | null }[];

    const constraints = (await c.query(
      `SELECT tc.TABLE_NAME AS tbl, tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type,
              kcu.COLUMN_NAME AS col, kcu.ORDINAL_POSITION AS pos,
              kcu.REFERENCED_TABLE_SCHEMA AS ref_schema, kcu.REFERENCED_TABLE_NAME AS ref_table,
              kcu.REFERENCED_COLUMN_NAME AS ref_col, rc.DELETE_RULE AS on_delete, rc.UPDATE_RULE AS on_update
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND rc.TABLE_NAME = tc.TABLE_NAME
       WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')
       ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [db],
    )) as {
      tbl: string;
      name: string;
      type: string;
      col: string;
      pos: number;
      ref_schema: string | null;
      ref_table: string | null;
      ref_col: string | null;
      on_delete: string | null;
      on_update: string | null;
    }[];

    const stats = (await c.query(
      `SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME <> 'PRIMARY'
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [db],
    )) as { tbl: string; name: string; non_unique: number; col: string | null }[];

    const byName = new Map<string, IntrospectedTable>();
    for (const t of tables) {
      const isView = t.table_type === 'VIEW';
      byName.set(t.name, {
        schema: db,
        name: t.name,
        kind: isView ? 'view' : 'table',
        viewSql: isView ? (t.view_sql ?? '').trim() : undefined,
        comment: t.comment || null,
        columns: [],
        primaryKey: [],
        uniques: [],
        indexes: [],
        foreignKeys: [],
      });
    }
    for (const col of columns) {
      const t = byName.get(col.tbl);
      if (!t) continue;
      const extra = (col.extra ?? '').toLowerCase();
      let def: string | null = col.default_value;
      if (def === 'NULL') def = null;
      t.columns.push({
        name: col.name,
        type: col.type.toUpperCase(),
        nullable: col.nullable === 'YES',
        defaultValue: def,
        autoIncrement: extra.includes('auto_increment'),
        comment: col.comment || null,
      });
    }

    // group constraint rows by (table, name)
    const grouped = new Map<string, typeof constraints>();
    for (const row of constraints) {
      const key = `${row.tbl} ${row.name}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }
    const fkNames = new Set<string>();
    for (const rows of grouped.values()) {
      const first = rows[0];
      const t = byName.get(first.tbl);
      if (!t) continue;
      if (first.type === 'PRIMARY KEY') t.primaryKey = rows.map((r) => r.col);
      else if (first.type === 'FOREIGN KEY' && first.ref_table) {
        fkNames.add(`${first.tbl} ${first.name}`);
        t.foreignKeys.push({
          name: first.name,
          columns: rows.map((r) => r.col),
          refSchema: first.ref_schema,
          refTable: first.ref_table,
          refColumns: rows.map((r) => r.ref_col ?? ''),
          onDelete: action(first.on_delete),
          onUpdate: action(first.on_update),
        });
      }
    }

    const idxGrouped = new Map<string, typeof stats>();
    for (const row of stats) {
      const key = `${row.tbl} ${row.name}`;
      if (!idxGrouped.has(key)) idxGrouped.set(key, []);
      idxGrouped.get(key)!.push(row);
    }
    for (const [key, rows] of idxGrouped) {
      const t = byName.get(rows[0].tbl);
      if (!t) continue;
      const cols = rows.map((r) => r.col).filter((x): x is string => Boolean(x));
      if (cols.length === 0) continue;
      const unique = Number(rows[0].non_unique) === 0;
      if (unique) t.uniques.push({ name: rows[0].name, columns: cols });
      else if (!fkNames.has(key)) t.indexes.push({ name: rows[0].name, columns: cols, unique: false });
    }
    // Stored procedures and functions. ROUTINE_DEFINITION is the body as it was
    // written; it reads NULL for a user without the privilege to see it, and a
    // routine whose body cannot be read is still worth listing by its signature.
    const routineRows = (await c.query(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns, ROUTINE_DEFINITION AS body, ROUTINE_COMMENT AS comment
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION') ORDER BY ROUTINE_NAME`,
      [db],
    )) as { name: string; type: string; returns: string | null; body: string | null; comment: string | null }[];
    const paramRows = (await c.query(
      `SELECT SPECIFIC_NAME AS routine, ROUTINE_TYPE AS type, PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS dtype
       FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0 ORDER BY SPECIFIC_NAME, ORDINAL_POSITION`,
      [db],
    )) as { routine: string; type: string; mode: string | null; name: string | null; dtype: string }[];
    const routines: IntrospectedRoutine[] = routineRows.map((r) => {
      const kind = r.type === 'FUNCTION' ? 'function' : 'procedure';
      const params = paramRows
        .filter((x) => x.routine === r.name && x.type === r.type)
        .map((x) => {
          const mode = (x.mode ?? '').toUpperCase();
          return { name: x.name ?? '', type: x.dtype, ...(mode === 'OUT' ? { mode: 'out' as const } : mode === 'INOUT' ? { mode: 'inout' as const } : {}) };
        });
      return {
        schema: db,
        name: r.name,
        kind,
        params,
        ...(kind === 'function' && r.returns ? { returns: r.returns } : {}),
        body: r.body ?? '',
        comment: r.comment || null,
      };
    });

    return { serverVersion: version, tables: [...byName.values()], routines };
  } finally {
    await c.end();
  }
}

interface MariaResultSet extends Array<unknown[]> {
  meta?: { name(): string }[];
}
interface MariaWriteResult {
  affectedRows: number;
  insertId?: number | bigint;
}

/**
 * Run an ad-hoc script. Reads happen in a READ ONLY transaction that is rolled
 * back; writes need allowWrites and commit. DDL auto-commits in MariaDB, which
 * is why the read-only guard in the API layer matters more than the rollback.
 */
export async function runQuery(cfg: ConnectionConfig, sql: string, opts: QueryOptions): Promise<QueryResult> {
  const c = await connect(cfg);
  const t0 = Date.now();
  try {
    await c.query(opts.allowWrites ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
    let last: { columns: string[]; rows: unknown[][]; affected: number; command: string } | null = null;
    for (const statement of splitStatements(sql)) {
      const res = (await c.query({ sql: statement, rowsAsArray: true })) as MariaResultSet | MariaWriteResult;
      const command = statement.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
      if (Array.isArray(res)) {
        const columns = (res.meta ?? []).map((m) => m.name());
        last = { columns, rows: res as unknown[][], affected: 0, command };
      } else if (!last || !last.columns.length) {
        last = { columns: [], rows: [], affected: Number(res.affectedRows ?? 0), command };
      }
    }
    await c.query(opts.allowWrites ? 'COMMIT' : 'ROLLBACK');
    if (!last) return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: Date.now() - t0 };
    const rows = serializeRows(last.rows);
    const truncated = rows.length > opts.maxRows;
    return {
      columns: last.columns,
      rows: truncated ? rows.slice(0, opts.maxRows) : rows,
      rowCount: last.columns.length ? rows.length : last.affected,
      truncated,
      durationMs: Date.now() - t0,
      command: last.command,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
