/**
 * DuckDB-Wasm in the browser: a Web Worker running the engine, with the
 * database on the origin-private file system (OPFS) so it survives reloads.
 *
 * Three things about DuckDB-Wasm shape this file. Reopening a database on a
 * running worker leaves the old file locked, so loading another file or
 * starting empty restarts the worker instead of calling open() twice. A
 * database file inside the worker's virtual file system cannot be copied back
 * out, so the file lives on OPFS, where the page can read it for a download
 * while the engine keeps it open. And the write-ahead log is registered with
 * the engine before the database is opened (see boot). Without OPFS (a browser
 * that lacks it, or an insecure context) the database is in memory and lives
 * as long as the tab.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { ExtensionsResponse, IntrospectResponse, QueryResult, StatementResult } from '@shared/types';
import { DuckdbCore, errorMessage, isWriteSql, type DuckdbSession } from './core';
import type { DuckdbEngine } from './engine';
import { DUCKDB_BUNDLES } from './wasmUrls';

const FILE = 'dbviz.duckdb';
const WAL = `${FILE}.wal`;

/* ------------------------------------------------------------------ */
/* OPFS helpers (main thread)                                          */
/* ------------------------------------------------------------------ */

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) return null;
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function opfsRead(name: string): Promise<Uint8Array> {
  const root = await opfsRoot();
  if (!root) throw new Error('The browser offers no file storage for the database.');
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function opfsWrite(name: string, bytes: Uint8Array): Promise<void> {
  const root = await opfsRoot();
  if (!root) throw new Error('The browser offers no file storage for the database.');
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as unknown as BufferSource);
  await writable.close();
}

async function opfsRemove(name: string): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  // A worker that was just terminated may hold its lock on the file for a moment longer.
  for (let attempt = 0; ; attempt++) {
    try {
      await root.removeEntry(name);
      return;
    } catch (e) {
      if ((e as DOMException)?.name === 'NotFoundError' || attempt >= 10) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */

interface Booted {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
  storage: 'opfs' | 'memory';
  note?: string;
}

async function instantiate(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
  if (!bundle.mainWorker) throw new Error('No DuckDB-Wasm bundle suits this browser.');
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  } catch (e) {
    worker.terminate();
    throw new Error(`The DuckDB engine could not be loaded: ${errorMessage(e)}`);
  }
  return db;
}

/**
 * Start a worker and open the database. With OPFS, a file that fails to open
 * (corrupt, or written by a newer DuckDB) is reported rather than silently
 * discarded: the caller decides whether to throw it away.
 */
async function boot(opts: { allowOpfs: boolean }): Promise<Booted> {
  const db = await instantiate();
  const root = opts.allowOpfs ? await opfsRoot() : null;
  if (root) {
    try {
      // The write-ahead log is handed to the engine before open() so that it is
      // read and written directly. Left to itself DuckDB-Wasm only does that for a
      // log that already has content; an empty one (a database just created, or
      // one loaded from a file) goes through its page buffer, which keeps the
      // read-only flag from the replay read when the log is reopened for
      // writing, and every commit then fails with "File is not opened in write
      // mode".
      const wal = await root.getFileHandle(WAL, { create: true });
      await db.registerFileHandle(`opfs://${WAL}`, wal, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
      await db.open({ path: `opfs://${FILE}`, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
      return { db, conn: await db.connect(), storage: 'opfs' };
    } catch (e) {
      await db.terminate().catch(() => undefined);
      throw new OpenError(errorMessage(e));
    }
  }
  await db.open({ path: ':memory:', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  return {
    db,
    conn: await db.connect(),
    storage: 'memory',
    note: opts.allowOpfs ? 'This browser offers no private file storage here, so the database lives in memory and is lost when the tab closes.' : undefined,
  };
}

class OpenError extends Error {}

function sessionFor(conn: duckdb.AsyncDuckDBConnection): DuckdbSession {
  return {
    query: (sql) => conn.query(sql),
    stream: (sql) => conn.send(sql),
    cancel: async () => {
      await conn.cancelSent().catch(() => false);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

class WasmEngine implements DuckdbEngine {
  storage: 'opfs' | 'memory';
  storageNote?: string;
  private db: duckdb.AsyncDuckDB;
  private conn: duckdb.AsyncDuckDBConnection;
  private core: DuckdbCore;
  private listeners = new Set<() => void>();
  /** Operations run one at a time: a restart must never interleave with a query. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(booted: Booted) {
    this.db = booted.db;
    this.conn = booted.conn;
    this.storage = booted.storage;
    this.storageNote = booted.note;
    this.core = new DuckdbCore(sessionFor(booted.conn));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private adopt(booted: Booted): void {
    this.db = booted.db;
    this.conn = booted.conn;
    this.storage = booted.storage;
    this.storageNote = booted.note;
    this.core = new DuckdbCore(sessionFor(booted.conn));
  }

  private async shutdown(): Promise<void> {
    await this.conn.close().catch(() => undefined);
    await this.db.terminate().catch(() => undefined);
  }

  exec(statements: string[], stopOnError: boolean): Promise<StatementResult[]> {
    return this.serial(async () => {
      const results = await this.core.exec(statements, stopOnError);
      // An abrupt end of the worker (a reload) loses what is only in the
      // write-ahead log, so every batch is flushed into the file.
      await this.core.checkpoint();
      this.changed();
      return results;
    });
  }

  query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult> {
    return this.serial(async () => {
      const result = await this.core.query(sql, opts);
      if (isWriteSql(sql) || (result.command && isWriteSql(result.command))) {
        await this.core.checkpoint();
        this.changed();
      }
      return result;
    });
  }

  introspect(): Promise<IntrospectResponse> {
    return this.serial(() => this.core.introspect());
  }

  extensions(): Promise<ExtensionsResponse> {
    return this.serial(() => this.core.extensions('in browser'));
  }

  exportBytes(): Promise<Uint8Array> {
    return this.serial(async () => {
      if (this.storage !== 'opfs') throw new Error('The in-memory database cannot be saved as a file in this browser.');
      await this.core.checkpoint();
      return opfsRead(FILE);
    });
  }

  load(bytes: Uint8Array): Promise<void> {
    return this.serial(async () => {
      if (this.storage === 'opfs') {
        await this.shutdown();
        await opfsRemove(WAL);
        await opfsWrite(FILE, bytes);
        try {
          this.adopt(await boot({ allowOpfs: true }));
        } catch (e) {
          // Not a database file (or one this engine cannot read): start empty again rather than leave no engine at all.
          await opfsRemove(FILE);
          await opfsRemove(WAL);
          this.adopt(await boot({ allowOpfs: true }));
          this.changed();
          throw new Error(`That file could not be opened as a DuckDB database: ${errorMessage(e)}`);
        }
        this.changed();
        return;
      }
      // In memory: attach the file from a buffer and copy its contents across.
      await this.db.open({ path: ':memory:', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
      this.conn = await this.db.connect();
      this.core = new DuckdbCore(sessionFor(this.conn));
      const name = 'imported.duckdb';
      try {
        await this.db.registerFileBuffer(name, bytes);
        await this.conn.query(`ATTACH '${name}' AS imported (READ_ONLY)`);
        await this.conn.query('COPY FROM DATABASE imported TO memory');
        await this.conn.query('DETACH imported');
      } catch (e) {
        throw new Error(`That file could not be opened as a DuckDB database: ${errorMessage(e)}`);
      } finally {
        await this.db.dropFiles([name, `${name}.wal`]).catch(() => undefined);
        this.changed();
      }
    });
  }

  reset(): Promise<void> {
    return this.serial(async () => {
      if (this.storage === 'opfs') {
        await this.shutdown();
        await opfsRemove(FILE);
        await opfsRemove(WAL);
        this.adopt(await boot({ allowOpfs: true }));
      } else {
        await this.db.open({ path: ':memory:', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
        this.conn = await this.db.connect();
        this.core = new DuckdbCore(sessionFor(this.conn));
      }
      this.changed();
    });
  }

  tableCount(): Promise<number> {
    return this.serial(() => this.core.tableCount());
  }

  version(): Promise<string> {
    return this.serial(() => this.core.version());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export async function createWasmEngine(): Promise<DuckdbEngine> {
  try {
    return new WasmEngine(await boot({ allowOpfs: true }));
  } catch (e) {
    if (!(e instanceof OpenError)) throw e;
    // The stored file could not be opened. Keep it out of the way (renamed, not
    // deleted) and start empty, saying why, rather than refusing to run at all.
    const reason = e.message;
    try {
      const bytes = await opfsRead(FILE);
      await opfsWrite(`${FILE}.unreadable`, bytes);
    } catch {
      /* nothing to keep */
    }
    await opfsRemove(FILE);
    await opfsRemove(WAL);
    const engine = new WasmEngine(await boot({ allowOpfs: true }));
    engine.storageNote = `The stored database could not be opened (${reason}); a copy was kept as ${FILE}.unreadable and an empty database started.`;
    return engine;
  }
}
