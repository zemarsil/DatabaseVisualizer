import type { ApplySchemaResponse, ConnectionConfig, DatabaseExtension, ExtensionsResponse, IntrospectResponse, QueryResult } from '@shared/types';
import { dialectLabel, isServerDialect } from '@shared/types';
import { api } from './api';
import { getSqliteEngine } from './sqlite/engine';

/**
 * One interface for "the database we are talking to", whether that is a
 * PostgreSQL/MariaDB server reached through the local API or the SQLite
 * engine running inside the browser. Panels ask for a backend with
 * `backendFor(conn)` and never care which one they got.
 */
export interface Backend {
  readonly kind: 'server' | 'sqlite';
  readonly connection: ConnectionConfig;
  /** Short human label, e.g. "PostgreSQL app@127.0.0.1:5432" or "SQLite (in browser)". */
  readonly label: string;
  test(): Promise<{ ok: boolean; message: string }>;
  apply(statements: string[], stopOnError: boolean): Promise<ApplySchemaResponse>;
  query(sql: string, opts?: { maxRows?: number; allowWrites?: boolean }): Promise<QueryResult>;
  introspect(): Promise<IntrospectResponse>;
  /** What this engine can be extended with, and what is enabled right now. */
  extensions(): Promise<ExtensionsResponse>;
}

class ServerBackend implements Backend {
  readonly kind = 'server' as const;
  constructor(readonly connection: ConnectionConfig) {}
  get label(): string {
    const c = this.connection;
    return `${dialectLabel(c.dialect)} ${c.database || c.user}@${c.host}:${c.port}`;
  }
  async test() {
    const r = await api.db.test(this.connection);
    return r.ok ? { ok: true, message: r.serverVersion ?? 'Connected' } : { ok: false, message: r.error ?? 'Failed' };
  }
  apply(statements: string[], stopOnError: boolean) {
    return api.db.apply({ connection: this.connection, statements, stopOnError });
  }
  query(sql: string, opts?: { maxRows?: number; allowWrites?: boolean }) {
    return api.db.query({ connection: this.connection, sql, maxRows: opts?.maxRows, allowWrites: opts?.allowWrites });
  }
  introspect() {
    return api.db.introspect(this.connection);
  }
  extensions() {
    return api.db.extensions(this.connection);
  }
}

class SqliteBackend implements Backend {
  readonly kind = 'sqlite' as const;
  readonly label = 'SQLite (in browser)';
  constructor(readonly connection: ConnectionConfig) {}
  async test() {
    try {
      const e = await getSqliteEngine();
      return { ok: true, message: `SQLite ${await e.version()} (in browser)` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  async apply(statements: string[], stopOnError: boolean): Promise<ApplySchemaResponse> {
    const e = await getSqliteEngine();
    const results = await e.exec(statements, stopOnError);
    return { ok: results.every((r) => r.ok), results };
  }
  async query(sql: string, opts?: { maxRows?: number }) {
    const e = await getSqliteEngine();
    return e.query(sql, { maxRows: opts?.maxRows });
  }
  async introspect() {
    const e = await getSqliteEngine();
    return e.introspect();
  }
  async extensions(): Promise<ExtensionsResponse> {
    const e = await getSqliteEngine();
    return {
      serverVersion: `SQLite ${await e.version()} (in browser)`,
      extensions: compileOptionsToExtensions(await e.compileOptions()),
      note: 'SQLite has no catalog of extensions. This is what the build was compiled with; a loadable module such as SpatiaLite cannot be loaded by the in-browser engine at all.',
    };
  }
}

/**
 * Read a build's compile options as a list of modules. SQLite reports features
 * as ENABLE_* / OMIT_* flags rather than as installable things, so a flag that
 * names a module is the closest thing to "this extension is present".
 */
function compileOptionsToExtensions(options: string[]): DatabaseExtension[] {
  const flags = new Set(options.map((o) => o.toUpperCase()));
  const known: { flag: string; name: string; comment: string }[] = [
    { flag: 'ENABLE_FTS5', name: 'fts5', comment: 'Full-text search (CREATE VIRTUAL TABLE ... USING fts5)' },
    { flag: 'ENABLE_FTS4', name: 'fts4', comment: 'Full-text search, the version before FTS5' },
    { flag: 'ENABLE_RTREE', name: 'rtree', comment: 'R*Tree spatial index module' },
    { flag: 'ENABLE_GEOPOLY', name: 'geopoly', comment: 'Polygon queries built on R*Tree' },
    { flag: 'ENABLE_JSON1', name: 'json1', comment: 'JSON functions (compiled in by default since 3.38)' },
    { flag: 'ENABLE_MATH_FUNCTIONS', name: 'math', comment: 'SQL math functions such as ceil() and log()' },
    { flag: 'ENABLE_DBSTAT_VTAB', name: 'dbstat', comment: 'The dbstat virtual table, for how storage is used' },
  ];
  return known
    .filter((k) => flags.has(k.flag))
    .map((k) => ({ name: k.name, installed: true, comment: `${k.comment}. Compiled in, so there is nothing to install.` }));
}

export function backendFor(conn: ConnectionConfig): Backend {
  return isServerDialect(conn.dialect) ? new ServerBackend(conn) : new SqliteBackend(conn);
}
