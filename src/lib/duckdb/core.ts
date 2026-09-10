/**
 * The DuckDB engine logic that does not care where DuckDB runs: batches of
 * statements with a transaction around them, capped queries, introspection.
 * The browser engine (wasm.ts) drives it through a Web Worker; the tests drive
 * it through the same WebAssembly build loaded into Node. Both hand it a
 * `DuckdbSession`, which is the whole contract.
 */
import type { ExtensionsResponse, IntrospectResponse, QueryResult, StatementResult } from '@shared/types';
import type { RecordBatch, Table } from 'apache-arrow';
import { duckdbTableCount, duckdbVersion, introspectDuckdb, listDuckdbExtensions } from './catalog';
import { batchRows, columnNames, tableRows } from './values';

export interface DuckdbSession {
  /** Run SQL (one statement or several) and return the last result set. */
  query(sql: string): Promise<Table>;
  /** Start a query and hand back its record batches as they arrive, so a row cap can stop early. */
  stream(sql: string): Promise<AsyncIterable<RecordBatch> | Iterable<RecordBatch>>;
  /** Abandon a streamed query that was not read to the end. */
  cancel(): Promise<void>;
}

/** Statement keywords after which the database may have changed. */
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'COPY', 'INSTALL', 'LOAD', 'ATTACH', 'DETACH', 'IMPORT', 'EXPORT', 'CALL',
  'PRAGMA', 'SET', 'RESET', 'CHECKPOINT', 'VACUUM', 'COMMENT', 'MERGE', 'UPSERT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'USE',
]);

export function firstKeyword(sql: string): string | undefined {
  const m = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\(?\s*([A-Za-z]+)/.exec(sql);
  return m?.[1]?.toUpperCase();
}

export function isWriteSql(sql: string): boolean {
  const kw = firstKeyword(sql);
  return Boolean(kw && WRITE_KEYWORDS.has(kw));
}

/** The result shapes DuckDB uses for statements that return no rows: a Count for DML, a Success for the rest. */
function isStatusResult(columns: string[]): boolean {
  return columns.length === 1 && (columns[0] === 'Count' || columns[0] === 'Success');
}

export class DuckdbCore {
  constructor(private readonly session: DuckdbSession) {}

  /** Rows with plain values (lists as arrays), for catalog reads. */
  readonly run = async (sql: string): Promise<unknown[][]> => tableRows(await this.session.query(sql), 'plain');

  /**
   * Run statements in order. With stopOnError the batch runs inside one
   * transaction that is rolled back on the first failure; DuckDB's DDL is
   * transactional, so a half-applied schema never survives.
   */
  async exec(statements: string[], stopOnError: boolean): Promise<StatementResult[]> {
    const results: StatementResult[] = [];
    if (stopOnError) await this.session.query('BEGIN TRANSACTION');
    let failed = false;
    for (let i = 0; i < statements.length; i++) {
      const sql = statements[i];
      const t0 = Date.now();
      try {
        await this.session.query(sql);
        results.push({ index: i, sql, ok: true, durationMs: Date.now() - t0 });
      } catch (e) {
        results.push({ index: i, sql, ok: false, error: errorMessage(e), durationMs: Date.now() - t0 });
        if (stopOnError) {
          failed = true;
          break;
        }
      }
    }
    if (stopOnError) {
      try {
        await this.session.query(failed ? 'ROLLBACK' : 'COMMIT');
      } catch (e) {
        // A statement that aborted the transaction on its own leaves nothing to roll back.
        if (!failed) results.push({ index: statements.length, sql: 'COMMIT', ok: false, error: errorMessage(e), durationMs: 0 });
      }
    }
    return results;
  }

  /** One query (or script; the last result set is returned), capped at maxRows. */
  async query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult> {
    try {
      return await this.queryRows(sql, opts);
    } catch (e) {
      // A trap inside the engine gets its explanation; anything else is rethrown as it came.
      const message = errorMessage(e);
      throw message === rawMessage(e).trim() ? e : new Error(message);
    }
  }

  private async queryRows(sql: string, opts?: { maxRows?: number }): Promise<QueryResult> {
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : 500;
    const t0 = Date.now();
    const command = lastKeyword(sql);
    const reader = await this.session.stream(sql);
    let columns: string[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    let stopped = false;
    for await (const batch of reader) {
      if (!columns.length) columns = columnNames(batch);
      if (batch.numRows === 0) continue;
      const converted = batchRows(batch, 'cell');
      for (const row of converted) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      if (truncated) {
        stopped = true;
        break;
      }
    }
    if (stopped) await this.session.cancel();
    const durationMs = Date.now() - t0;
    if (isStatusResult(columns) && command && WRITE_KEYWORDS.has(command)) {
      const count = columns[0] === 'Count' && rows[0] ? Number(rows[0][0]) : 0;
      return { columns: [], rows: [], rowCount: Number.isFinite(count) ? count : 0, truncated: false, durationMs, command };
    }
    return { columns, rows, rowCount: rows.length, truncated, durationMs, command };
  }

  introspect(): Promise<IntrospectResponse> {
    return introspectDuckdb(this.run);
  }

  extensions(engineLabel = ''): Promise<ExtensionsResponse> {
    return listDuckdbExtensions(this.run, engineLabel);
  }

  version(): Promise<string> {
    return duckdbVersion(this.run);
  }

  tableCount(): Promise<number> {
    return duckdbTableCount(this.run);
  }

  /** Flush the write-ahead log into the database file; a no-op for an in-memory database. */
  async checkpoint(): Promise<void> {
    try {
      await this.session.query('CHECKPOINT');
    } catch {
      /* inside a transaction, or nothing to do */
    }
  }
}

/** The keyword of the last statement of a script: the one whose result comes back. */
function lastKeyword(sql: string): string | undefined {
  const statements = splitTopLevel(sql);
  return firstKeyword(statements[statements.length - 1] ?? sql);
}

/** Split on top-level semicolons, respecting quotes and comments. */
function splitTopLevel(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim().length > 0);
}

/**
 * A trap inside the compiled engine surfaces as one of these bare messages.
 * In practice they come from an extension DuckDB tried to load on first use
 * (json for a JSON column, for instance) when extensions.duckdb.org could not
 * be reached: the download fails inside a call that cannot report it.
 */
const ENGINE_TRAP = /^(RuntimeError: )?(unreachable|table index is out of bounds|null function or function signature mismatch|memory access out of bounds|index out of bounds|Aborted\(.*\))$/i;

export function errorMessage(e: unknown): string {
  const raw = rawMessage(e).trim();
  if (ENGINE_TRAP.test(raw)) {
    return `The DuckDB engine stopped inside a native call ("${raw}"). That usually means an extension it loads on first use, such as json for a JSON column, could not be fetched from extensions.duckdb.org. Run LOAD json (or the extension's name) in the Query tab to see the exact reason.`;
  }
  return raw;
}

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
