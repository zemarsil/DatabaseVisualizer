import type { ExtensionsResponse, IntrospectResponse, QueryResult, StatementResult } from '@shared/types';

/**
 * The in-browser DuckDB engine (DuckDB-Wasm in a Web Worker). Where the browser
 * offers an origin-private file system the database is a real .duckdb file
 * kept there between reloads, which is also what "Download" hands out; where
 * it does not, the database lives in memory for the session.
 *
 * Everything the server does for PostgreSQL/MariaDB (apply, query, introspect)
 * has an equivalent here, so the rest of the app can treat DuckDB as just
 * another backend (see src/lib/backend.ts), the same way it treats SQLite.
 */
export interface DuckdbEngine {
  /** Where the database lives: an OPFS file kept between reloads, or memory for this session only. */
  readonly storage: 'opfs' | 'memory';
  /** Why it is memory only, when it is. */
  readonly storageNote?: string;
  /** Run statements in order. Wraps them in a transaction when stopOnError is true. */
  exec(statements: string[], stopOnError: boolean): Promise<StatementResult[]>;
  /** Run a query (or script) and return its last result set, or rows-affected for writes. */
  query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult>;
  /** Normalised schema in the same shape the server returns. */
  introspect(): Promise<IntrospectResponse>;
  /** Every extension DuckDB knows, with the ones loaded in this session marked. */
  extensions(): Promise<ExtensionsResponse>;
  /** The database as a .duckdb file (OPFS storage only). */
  exportBytes(): Promise<Uint8Array>;
  /** Replace the database with the contents of a .duckdb file. */
  load(bytes: Uint8Array): Promise<void>;
  /** Drop everything and start from an empty database. */
  reset(): Promise<void>;
  /** Number of user tables, for status displays. */
  tableCount(): Promise<number>;
  /** DuckDB version string, e.g. "1.4.3". */
  version(): Promise<string>;
  /** Notified after any change to the database. */
  subscribe(listener: () => void): () => void;
}

let enginePromise: Promise<DuckdbEngine> | null = null;

/** Lazily loads the WebAssembly build (a large download, fetched once) and opens the persisted database. */
export function getDuckdbEngine(): Promise<DuckdbEngine> {
  if (!enginePromise) {
    enginePromise = createEngine().catch((e) => {
      // Let the next call try again rather than caching a failed download.
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

async function createEngine(): Promise<DuckdbEngine> {
  // Implemented in ./wasm.ts (dynamic import keeps the wasm and worker out of the main bundle).
  const mod = await import('./wasm');
  return mod.createWasmEngine();
}
