import pg from 'pg';
import type { ConnectionConfig, IntrospectResponse, IntrospectedTable, ReferentialAction, StatementResult } from '../../src/shared/types';

const { Client } = pg;

function clientFor(cfg: ConnectionConfig) {
  return new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionTimeoutMillis: 6000,
    statement_timeout: 60000,
  });
}

export async function testConnection(cfg: ConnectionConfig): Promise<string> {
  const c = clientFor(cfg);
  await c.connect();
  try {
    const r = await c.query('SELECT version() AS v');
    return String(r.rows[0].v);
  } finally {
    await c.end();
  }
}

export async function applyStatements(cfg: ConnectionConfig, statements: string[], stopOnError: boolean): Promise<StatementResult[]> {
  const c = clientFor(cfg);
  await c.connect();
  const results: StatementResult[] = [];
  try {
    if (stopOnError) await c.query('BEGIN');
    for (let i = 0; i < statements.length; i++) {
      const sql = statements[i];
      const t0 = Date.now();
      try {
        await c.query(sql);
        results.push({ index: i, sql, ok: true, durationMs: Date.now() - t0 });
      } catch (e) {
        results.push({ index: i, sql, ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 });
        if (stopOnError) {
          await c.query('ROLLBACK');
          return results;
        }
      }
    }
    if (stopOnError) await c.query('COMMIT');
    return results;
  } finally {
    await c.end();
  }
}

const ACTION: Record<string, ReferentialAction> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

export async function introspect(cfg: ConnectionConfig): Promise<IntrospectResponse> {
  const c = clientFor(cfg);
  await c.connect();
  try {
    const version = String((await c.query('SELECT version() AS v')).rows[0].v);

    const tables = await c.query<{ schema: string; name: string; comment: string | null }>(
      `SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND ${SYSTEM_SCHEMAS}
       ORDER BY 1, 2`,
    );

    const columns = await c.query<{
      schema: string;
      table: string;
      name: string;
      type: string;
      nullable: boolean;
      default_value: string | null;
      is_identity: boolean;
      comment: string | null;
    }>(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_value,
              a.attidentity <> '' AS is_identity,
              col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND ${SYSTEM_SCHEMAS}
       ORDER BY n.nspname, c.relname, a.attnum`,
    );

    const constraints = await c.query<{
      schema: string;
      table: string;
      name: string;
      type: string;
      columns: string[] | null;
      ref_schema: string | null;
      ref_table: string | null;
      ref_columns: string[] | null;
      confdeltype: string | null;
      confupdtype: string | null;
    }>(
      `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS type,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
              fn.nspname AS ref_schema, fc.relname AS ref_table,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns,
              con.confdeltype, con.confupdtype
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class fc ON fc.oid = con.confrelid
       LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       WHERE con.contype IN ('p', 'u', 'f') AND ${SYSTEM_SCHEMAS}
       ORDER BY 1, 2, 3`,
    );

    const indexes = await c.query<{ schema: string; table: string; name: string; unique: boolean; columns: string[] | null }>(
      `SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name, i.indisunique AS unique,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT i.indisprimary
         AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
         AND ${SYSTEM_SCHEMAS}
       ORDER BY 1, 2, 3`,
    );

    const byKey = new Map<string, IntrospectedTable>();
    for (const t of tables.rows) {
      byKey.set(`${t.schema}.${t.name}`, { schema: t.schema, name: t.name, comment: t.comment, columns: [], primaryKey: [], uniques: [], indexes: [], foreignKeys: [] });
    }
    for (const col of columns.rows) {
      const t = byKey.get(`${col.schema}.${col.table}`);
      if (!t) continue;
      const isSerial = Boolean(col.default_value && /^nextval\(/i.test(col.default_value));
      t.columns.push({
        name: col.name,
        type: col.type,
        nullable: col.nullable,
        defaultValue: isSerial ? null : col.default_value,
        autoIncrement: col.is_identity || isSerial,
        comment: col.comment,
      });
    }
    for (const con of constraints.rows) {
      const t = byKey.get(`${con.schema}.${con.table}`);
      if (!t || !con.columns) continue;
      if (con.type === 'p') t.primaryKey = con.columns;
      else if (con.type === 'u') t.uniques.push({ name: con.name, columns: con.columns });
      else if (con.type === 'f' && con.ref_table && con.ref_columns) {
        t.foreignKeys.push({
          name: con.name,
          columns: con.columns,
          refSchema: con.ref_schema,
          refTable: con.ref_table,
          refColumns: con.ref_columns,
          onDelete: ACTION[con.confdeltype ?? 'a'] ?? 'NO ACTION',
          onUpdate: ACTION[con.confupdtype ?? 'a'] ?? 'NO ACTION',
        });
      }
    }
    for (const ix of indexes.rows) {
      const t = byKey.get(`${ix.schema}.${ix.table}`);
      if (!t || !ix.columns || ix.columns.length === 0) continue; // expression indexes are skipped
      t.indexes.push({ name: ix.name, columns: ix.columns, unique: ix.unique });
    }
    return { serverVersion: version, tables: [...byKey.values()] };
  } finally {
    await c.end();
  }
}
