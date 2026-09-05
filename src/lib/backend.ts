import type { ApplySchemaResponse, ConnectionConfig, IntrospectResponse, QueryResult } from '@shared/types';
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
}

export function backendFor(conn: ConnectionConfig): Backend {
  return isServerDialect(conn.dialect) ? new ServerBackend(conn) : new SqliteBackend(conn);
}
