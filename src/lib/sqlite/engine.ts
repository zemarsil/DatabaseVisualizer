import type { IntrospectResponse, QueryResult, StatementResult } from '@shared/types';

/**
 * The in-browser SQLite engine (sql.js, WebAssembly). One database lives in
 * memory for the session and is persisted to IndexedDB so it survives reloads.
 *
 * Everything the server does for PostgreSQL/MariaDB (apply, query, introspect)
 * has an equivalent here so the rest of the app can treat SQLite as just
 * another backend (see src/lib/backend.ts).
 */
export interface SqliteEngine {
  /** Run statements in order. Wraps them in a transaction when stopOnError is true. */
  exec(statements: string[], stopOnError: boolean): Promise<StatementResult[]>;
  /** Run one statement and return its result set (or rows-affected for writes). */
  query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult>;
  /** Normalised schema in the same shape the server returns. */
  introspect(): Promise<IntrospectResponse>;
  /** Serialise the database file (for download). */
  exportBytes(): Promise<Uint8Array>;
  /** Replace the database with the contents of a .sqlite/.db file. */
  load(bytes: Uint8Array): Promise<void>;
  /** Drop everything and start from an empty database. */
  reset(): Promise<void>;
  /** Number of user tables, for status displays. */
  tableCount(): Promise<number>;
  /** SQLite library version string. */
  version(): Promise<string>;
  /** Notified after any change to the database. */
  subscribe(listener: () => void): () => void;
}

let enginePromise: Promise<SqliteEngine> | null = null;

/** Lazily loads the WebAssembly build and the persisted database. */
export function getSqliteEngine(): Promise<SqliteEngine> {
  if (!enginePromise) enginePromise = createEngine();
  return enginePromise;
}

async function createEngine(): Promise<SqliteEngine> {
  // Implemented in ./sqljs.ts (dynamic import keeps the wasm out of the main bundle).
  const mod = await import('./sqljs');
  return mod.createSqlJsEngine();
}
