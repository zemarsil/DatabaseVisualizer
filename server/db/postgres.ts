import pg from 'pg';
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
import { parseRoutineParams } from '../../src/shared/routines';
import type { QueryOptions } from './index';
import { serializeRows, splitStatements } from './values';

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

/**
 * The catalog queries a schema import runs, kept out here so a real PostgreSQL
 * can be pointed at them: a query is a string until a server reads it, and the
 * only way to know one is right is to run it (see tests/introspect-sql.test.ts).
 *
 * Every aggregated name is cast to text, and that cast is load-bearing.
 * `array_agg(a.attname)` produces `name[]` (OID 1003), and node-postgres
 * registers no parser for that OID: the client is handed the array's raw text,
 * `{id,customer_id}`, where the response says `string[]`. Nothing notices until
 * the browser does what the type promises and calls .map on a string. Casting to
 * text makes it `text[]` (OID 1009), which the driver does parse. PGlite parses
 * `name[]` regardless, so this could only ever be seen against a real server —
 * which is why the test asserts on the column types, not on the values.
 */
export const INTROSPECT_QUERIES = {
  version: `SELECT version() AS v`,
  tables: `SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment, c.relkind, c.relpersistence = 'u' AS unlogged,
              CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) ELSE NULL END AS view_sql
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm') AND ${SYSTEM_SCHEMAS}
       ORDER BY 1, 2`,
  columns: `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_value,
              a.attidentity <> '' AS is_identity,
              col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm') AND ${SYSTEM_SCHEMAS}
       ORDER BY n.nspname, c.relname, a.attnum`,
  constraints: `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS type,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
              fn.nspname AS ref_schema, fc.relname AS ref_table,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
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
  indexes: `SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name, i.indisunique AS unique,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
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
  enums: `SELECT n.nspname AS schema, t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE ${SYSTEM_SCHEMAS}
       GROUP BY 1, 2 ORDER BY 1, 2`,
  // Stored procedures and functions written in SQL or PL/pgSQL. Everything an
  // extension installed is left out (PostGIS alone brings thousands, and the
  // extension is already recorded), and so is anything in C or another
  // procedural language, whose body is not text the diagram can show.
  routines: `SELECT n.nspname AS schema, p.proname AS name,
              CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
              pg_get_function_arguments(p.oid) AS arguments,
              CASE WHEN p.prokind = 'f' THEN pg_get_function_result(p.oid) END AS returns,
              l.lanname::text AS language,
              p.prosrc AS body,
              obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
       WHERE p.prokind IN ('p', 'f') AND l.lanname IN ('sql', 'plpgsql') AND ${SYSTEM_SCHEMAS}
         AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e')
       ORDER BY 1, 2`,
} as const;

/**
 * An array column as an array, whatever the driver made of it.
 *
 * The queries above ask for text[] so that node-postgres parses it, and this is
 * the promise kept on the way out: a driver that hands back the raw literal
 * still leaves this module returning the `string[]` its response type declares,
 * rather than a string that only fails later, somewhere else, in the browser.
 *
 * The literal is read with the driver's own text[] parser rather than by
 * splitting on commas, because an element containing a comma is quoted and an
 * element containing a quote is escaped, and that is a format worth reading
 * with the code that already knows it.
 */
// 1009 is text[]. The driver's typings only name a handful of OIDs, so the
// lookup is cast rather than the parser written out again here.
const getTypeParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (raw: string) => (string | null)[];
const parseTextArray = getTypeParser(1009, 'text');

export function textArray(v: string[] | string | null | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  const raw = v.trim();
  if (!raw) return [];
  if (!raw.startsWith('{')) return [raw];
  return parseTextArray(raw).filter((x): x is string => x !== null);
}

export async function introspect(cfg: ConnectionConfig): Promise<IntrospectResponse> {
  const c = clientFor(cfg);
  await c.connect();
  try {
    const version = String((await c.query(INTROSPECT_QUERIES.version)).rows[0].v);

    const tables = await c.query<{ schema: string; name: string; comment: string | null; relkind: string; unlogged: boolean; view_sql: string | null }>(INTROSPECT_QUERIES.tables);

    const columns = await c.query<{
      schema: string;
      table: string;
      name: string;
      type: string;
      nullable: boolean;
      default_value: string | null;
      is_identity: boolean;
      comment: string | null;
    }>(INTROSPECT_QUERIES.columns);

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
    }>(INTROSPECT_QUERIES.constraints);

    const indexes = await c.query<{ schema: string; table: string; name: string; unique: boolean; columns: string[] | null }>(INTROSPECT_QUERIES.indexes);

    const extensions = await c.query<{ name: string; schema: string; version: string }>(EXTENSION_QUERIES.forImport);

    const enums = await c.query<{ schema: string; name: string; values: string[] }>(INTROSPECT_QUERIES.enums);

    const routines = await c.query<{ schema: string; name: string; kind: 'procedure' | 'function'; arguments: string; returns: string | null; language: string; body: string; comment: string | null }>(
      INTROSPECT_QUERIES.routines,
    );

    const byKey = new Map<string, IntrospectedTable>();
    for (const t of tables.rows) {
      const isView = t.relkind === 'v' || t.relkind === 'm';
      byKey.set(`${t.schema}.${t.name}`, {
        schema: t.schema,
        name: t.name,
        kind: isView ? 'view' : 'table',
        materialized: t.relkind === 'm' || undefined,
        unlogged: (!isView && t.unlogged) || undefined,
        viewSql: isView ? (t.view_sql ?? '').trim().replace(/;$/, '') : undefined,
        comment: t.comment,
        columns: [],
        primaryKey: [],
        uniques: [],
        indexes: [],
        foreignKeys: [],
      });
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
      const cols = textArray(con.columns);
      if (con.type === 'p') t.primaryKey = cols;
      else if (con.type === 'u') t.uniques.push({ name: con.name, columns: cols });
      else if (con.type === 'f' && con.ref_table && con.ref_columns) {
        t.foreignKeys.push({
          name: con.name,
          columns: cols,
          refSchema: con.ref_schema,
          refTable: con.ref_table,
          refColumns: textArray(con.ref_columns),
          onDelete: ACTION[con.confdeltype ?? 'a'] ?? 'NO ACTION',
          onUpdate: ACTION[con.confupdtype ?? 'a'] ?? 'NO ACTION',
        });
      }
    }
    for (const ix of indexes.rows) {
      const t = byKey.get(`${ix.schema}.${ix.table}`);
      const cols = textArray(ix.columns);
      if (!t || cols.length === 0) continue; // expression indexes are skipped
      t.indexes.push({ name: ix.name, columns: cols, unique: ix.unique });
    }
    return {
      serverVersion: version,
      tables: [...byKey.values()],
      enums: enums.rows.map((e) => ({ schema: e.schema, name: e.name, values: textArray(e.values) })),
      routines: routines.rows.map((r) => routineFromRow(r)),
      // plpgsql is in every database already, so listing it would only add noise.
      extensions: extensions.rows.map((e) => ({ name: e.name, schema: e.schema === 'public' ? undefined : e.schema, version: e.version })),
    };
  } finally {
    await c.end();
  }
}

/** One pg_proc row as the response shape: the argument text split into parameters. */
export function routineFromRow(r: { schema: string; name: string; kind: 'procedure' | 'function'; arguments: string; returns: string | null; language: string; body: string; comment: string | null }): IntrospectedRoutine {
  return {
    schema: r.schema,
    name: r.name,
    kind: r.kind,
    params: parseRoutineParams(r.arguments ?? '', true),
    ...(r.kind === 'function' && r.returns ? { returns: r.returns } : {}),
    language: r.language,
    body: r.body ?? '',
    comment: r.comment,
  };
}

/** PostGIS alone provides several thousand functions; a sample is enough to recognise it by. */
const MAX_LISTED_FUNCTIONS = 40;

/**
 * The catalog queries, as named constants rather than inline strings, so
 * tests/introspect-sql.test.ts can run exactly what the driver runs against a
 * real PostgreSQL. These are the one part of the app a unit test cannot reach:
 * they are strings handed to a database, and only a database can say whether
 * they are valid.
 */
export const EXTENSION_QUERIES = {
  /** Everything the server could install, installed or not. */
  available: `SELECT name, default_version, installed_version, comment FROM pg_available_extensions ORDER BY name`,
  /**
   * What each extension depends on. It lives on the version rows, so the default
   * version has to be joined back in — pg_available_extension_versions has no
   * default_version column of its own.
   */
  requires: `SELECT v.name, v.requires::text[] AS requires
         FROM pg_available_extension_versions v
         JOIN pg_available_extensions a ON a.name = v.name AND a.default_version = v.version
        ORDER BY v.name`,
  /**
   * The objects an installed extension created, read out of pg_depend: anything
   * that depends on the extension with deptype 'e' was created by it. Array
   * types (leading underscore) and rowtypes are noise, so they are excluded, and
   * the function list is capped because PostGIS alone has thousands.
   */
  installed: `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema,
              (SELECT array_agg(DISTINCT t.typname::text ORDER BY t.typname::text)
                 FROM pg_depend d JOIN pg_type t ON t.oid = d.objid
                WHERE d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
                  AND d.classid = 'pg_type'::regclass AND d.deptype = 'e'
                  AND t.typtype IN ('b', 'e', 'r', 'd', 'm')
                  AND t.typname NOT LIKE '\\_%') AS types,
              (SELECT (array_agg(DISTINCT p.proname::text ORDER BY p.proname::text))[1:${MAX_LISTED_FUNCTIONS}]
                 FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid
                WHERE d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
                  AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e') AS functions,
              (SELECT count(DISTINCT p.proname)
                 FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid
                WHERE d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
                  AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e') AS function_count,
              (SELECT array_agg(DISTINCT am.amname::text ORDER BY am.amname::text)
                 FROM pg_depend d JOIN pg_am am ON am.oid = d.objid
                WHERE d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
                  AND d.classid = 'pg_am'::regclass AND d.deptype = 'e'
                  AND am.amtype = 'i') AS index_methods,
              (SELECT array_agg(DISTINCT oc.opcname::text ORDER BY oc.opcname::text)
                 FROM pg_depend d JOIN pg_opclass oc ON oc.oid = d.objid
                WHERE d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
                  AND d.classid = 'pg_opclass'::regclass AND d.deptype = 'e') AS operator_classes
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        ORDER BY e.extname`,
  /** Just the names, for an ordinary schema import. */
  forImport: `SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql'
        ORDER BY e.extname`,
} as const;

/**
 * Everything the server knows about extensions, which is the authoritative
 * answer for this server and beats any catalog the app ships with.
 *
 * `pg_available_extensions` is what the server has on disk and could install.
 * For the ones actually installed, the objects they brought with them are read
 * out of `pg_depend`: every type, function, index access method and operator
 * class that depends on the extension with deptype 'e' was created *by* it.
 * That is how the app can describe an extension it has never heard of.
 */
export async function listExtensions(cfg: ConnectionConfig): Promise<ExtensionsResponse> {
  const c = clientFor(cfg);
  await c.connect();
  try {
    const version = String((await c.query('SELECT version() AS v')).rows[0].v);

    const available = await c.query<{ name: string; default_version: string | null; installed_version: string | null; comment: string | null }>(
      EXTENSION_QUERIES.available,
    );

    // What an extension depends on lives on the version rows rather than on
    // pg_available_extensions, so the default version has to be joined back in
    // (that view has no default_version column of its own).
    const requires = await c.query<{ name: string; requires: string[] | null }>(
      EXTENSION_QUERIES.requires,
    );
    const requiresByName = new Map(requires.rows.map((r) => [r.name, textArray(r.requires)]));

    const installed = await c.query<{
      name: string;
      version: string;
      schema: string;
      types: string[] | null;
      functions: string[] | null;
      function_count: number;
      index_methods: string[] | null;
      operator_classes: string[] | null;
    }>(
      // Every branch is the same shape: objects of one catalog that pg_depend
      // ties back to this extension. Array types (leading underscore) and the
      // row types of the extension's own tables are noise, so they are excluded.
      EXTENSION_QUERIES.installed,
    );
    const installedByName = new Map(installed.rows.map((r) => [r.name, r]));

    const extensions: DatabaseExtension[] = available.rows.map((row) => {
      const live = installedByName.get(row.name);
      const count = live ? Number(live.function_count) : 0;
      return {
        name: row.name,
        installed: Boolean(row.installed_version),
        installedVersion: row.installed_version ?? undefined,
        defaultVersion: row.default_version ?? undefined,
        comment: row.comment ?? undefined,
        requires: requiresByName.get(row.name)?.length ? requiresByName.get(row.name) : undefined,
        schema: live?.schema,
        types: live?.types ? textArray(live.types) : undefined,
        functions: live?.functions ? textArray(live.functions) : undefined,
        functionCount: count || undefined,
        indexMethods: live?.index_methods ? textArray(live.index_methods) : undefined,
        operatorClasses: live?.operator_classes ? textArray(live.operator_classes) : undefined,
      };
    });

    // An extension installed from a directory the server no longer lists still
    // exists in this database, so it must not vanish from the answer.
    for (const [name, live] of installedByName) {
      if (extensions.some((e) => e.name === name)) continue;
      extensions.push({
        name,
        installed: true,
        installedVersion: live.version,
        schema: live.schema,
        types: live.types ? textArray(live.types) : undefined,
        functions: live.functions ? textArray(live.functions) : undefined,
        functionCount: Number(live.function_count) || undefined,
        indexMethods: live.index_methods ? textArray(live.index_methods) : undefined,
        operatorClasses: live.operator_classes ? textArray(live.operator_classes) : undefined,
      });
    }
    extensions.sort((a, b) => a.name.localeCompare(b.name));

    return { serverVersion: version, extensions };
  } finally {
    await c.end();
  }
}

/**
 * Run an ad-hoc script inside one transaction. Without allowWrites the
 * transaction is READ ONLY and rolled back at the end, so a stray UPDATE can
 * neither run nor stick; with it, the transaction commits. The row cap is
 * applied after the fetch (no server cursor), which is fine for the sizes the
 * grid can show anyway.
 */
export async function runQuery(cfg: ConnectionConfig, sql: string, opts: QueryOptions): Promise<QueryResult> {
  const c = clientFor(cfg);
  await c.connect();
  const t0 = Date.now();
  try {
    await c.query('BEGIN');
    if (!opts.allowWrites) await c.query('SET TRANSACTION READ ONLY');
    let last: pg.QueryArrayResult | null = null;
    for (const statement of splitStatements(sql)) {
      const res = await c.query({ text: statement, rowMode: 'array' });
      if (!last || res.fields.length || !last.fields.length) last = res;
    }
    await c.query(opts.allowWrites ? 'COMMIT' : 'ROLLBACK');
    if (!last) return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: Date.now() - t0 };
    const rows = serializeRows(last.rows as unknown[][]);
    const truncated = rows.length > opts.maxRows;
    return {
      columns: last.fields.map((f) => f.name),
      rows: truncated ? rows.slice(0, opts.maxRows) : rows,
      rowCount: last.fields.length ? rows.length : (last.rowCount ?? 0),
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
