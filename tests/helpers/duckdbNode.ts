/**
 * The DuckDB engine the tests run against: the same WebAssembly build the
 * browser uses, loaded into Node through DuckDB-Wasm's blocking bindings, and
 * driven through the same DuckdbCore the browser engine uses. Persistence is
 * the one thing not covered here (it is OPFS, which only a browser has).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ExtensionsResponse, IntrospectResponse, QueryResult, StatementResult } from '../../src/shared/types';
import { DuckdbCore, type DuckdbSession } from '../../src/lib/duckdb/core';

const require = createRequire(import.meta.url);

export interface NodeDuckdb {
  exec(statements: string[], stopOnError: boolean): Promise<StatementResult[]>;
  query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult>;
  introspect(): Promise<IntrospectResponse>;
  extensions(): Promise<ExtensionsResponse>;
  tableCount(): Promise<number>;
  version(): Promise<string>;
  /** Start again from an empty in-memory database. */
  reset(): Promise<void>;
  /** Raw SQL with plain-value rows, for assertions. */
  run(sql: string): Promise<unknown[][]>;
}

let instance: Promise<NodeDuckdb> | null = null;

/** One engine per test run (instantiating the module takes a second or two). */
export function getNodeDuckdb(): Promise<NodeDuckdb> {
  if (!instance) instance = create();
  return instance;
}

async function create(): Promise<NodeDuckdb> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const duckdb = require('@duckdb/duckdb-wasm/blocking') as any;
  const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm'));
  const bundles = {
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs') },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs') },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.open({ path: ':memory:' });
  let conn = db.connect();
  const session: DuckdbSession = {
    query: async (sql) => conn.query(sql),
    stream: async (sql) => conn.send(sql),
    cancel: async () => {
      conn.cancelSent();
    },
  };
  let core = new DuckdbCore(session);
  return {
    exec: (statements, stopOnError) => core.exec(statements, stopOnError),
    query: (sql, opts) => core.query(sql, opts),
    introspect: () => core.introspect(),
    extensions: () => core.extensions('node'),
    tableCount: () => core.tableCount(),
    version: () => core.version(),
    run: (sql) => core.run(sql),
    reset: async () => {
      conn.close();
      db.open({ path: ':memory:' });
      conn = db.connect();
      core = new DuckdbCore(session);
    },
  };
}
