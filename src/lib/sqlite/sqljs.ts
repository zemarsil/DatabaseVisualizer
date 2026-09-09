import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { IntrospectResponse, IntrospectedTable, QueryResult, ReferentialAction, StatementResult } from '@shared/types';
import type { SqliteEngine } from './engine';

/* ------------------------------------------------------------------ */
/* Persistence (IndexedDB), no-op outside the browser                  */
/* ------------------------------------------------------------------ */

const IDB_NAME = 'dbviz-sqlite';
const IDB_STORE = 'db';
const IDB_KEY = 'main';
const SAVE_DELAY_MS = 800;

function hasIdb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<Uint8Array | null> {
  if (!hasIdb()) return null;
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : req.result ? new Uint8Array(req.result as ArrayBuffer) : null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

async function idbPut(bytes: Uint8Array): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable: the database still works for this session */
  }
}

/* ------------------------------------------------------------------ */
/* sql.js loading                                                      */
/* ------------------------------------------------------------------ */

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (typeof window === 'undefined') return initSqlJs();
  const { default: wasmUrl } = await import('./wasmUrl');
  return initSqlJs({ locateFile: () => wasmUrl });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function cell(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let hex = '';
    const n = Math.min(v.length, 256);
    for (let i = 0; i < n; i++) hex += v[i].toString(16).padStart(2, '0');
    return `x'${hex}${v.length > n ? '…' : ''}'`;
  }
  return v ?? null;
}

function firstKeyword(sql: string): string | undefined {
  const m = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*([A-Za-z]+)/.exec(sql);
  return m?.[1]?.toUpperCase();
}

const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REPLACE', 'PRAGMA', 'VACUUM', 'REINDEX', 'ATTACH', 'DETACH']);

function action(raw: string | null | undefined): ReferentialAction {
  const r = (raw ?? 'NO ACTION').toUpperCase();
  if (r === 'CASCADE' || r === 'RESTRICT' || r === 'SET NULL' || r === 'SET DEFAULT') return r;
  return 'NO ACTION';
}

/** The SELECT body of a stored CREATE VIEW statement. */
export function viewBody(createSql: string): string {
  const m = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)\s*(?:\([^)]*\))?\s*AS\s+/i.exec(createSql);
  return (m ? createSql.slice(m[0].length) : createSql).trim().replace(/;+$/, '');
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

class SqlJsEngine implements SqliteEngine {
  private db: Database;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly SQL: SqlJsStatic,
    initial: Uint8Array | null,
  ) {
    this.db = this.open(initial);
  }

  private open(bytes: Uint8Array | null): Database {
    const db = bytes ? new this.SQL.Database(bytes) : new this.SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    return db;
  }

  private changed(): void {
    for (const l of this.listeners) l();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void idbPut(this.snapshot());
    }, SAVE_DELAY_MS);
  }

  /** sql.js closes and reopens the connection on export, which drops pragmas; restore them. */
  private snapshot(): Uint8Array {
    const bytes = this.db.export();
    this.db.run('PRAGMA foreign_keys = ON');
    return bytes;
  }

  private runOne(sql: string): { columns: string[]; rows: unknown[][]; truncated: boolean; rowsModified: number } {
    // Prepare + step so we can cap rows; falls back to run() for statements sql.js cannot prepare stepwise.
    const stmt = this.db.prepare(sql);
    try {
      const rows: unknown[][] = [];
      let columns: string[] = [];
      while (stmt.step()) {
        if (!columns.length) columns = stmt.getColumnNames();
        rows.push(stmt.get().map(cell));
      }
      if (!columns.length) columns = stmt.getColumnNames();
      return { columns, rows, truncated: false, rowsModified: this.db.getRowsModified() };
    } finally {
      stmt.free();
    }
  }

  async exec(statements: string[], stopOnError: boolean): Promise<StatementResult[]> {
    const results: StatementResult[] = [];
    // PRAGMA foreign_keys is a no-op inside a transaction, so a script that asks
    // for it (a table rebuild does) gets it applied around the transaction instead.
    const fkPragma = /^\s*PRAGMA\s+foreign_keys\s*=\s*(\w+)\s*;?\s*$/i;
    const wantsFkOff = statements.some((s) => {
      const m = fkPragma.exec(s);
      return m && /^(off|0|false)$/i.test(m[1]);
    });
    if (wantsFkOff) this.db.run('PRAGMA foreign_keys = OFF');
    if (stopOnError) this.db.run('BEGIN');
    let failed = false;
    for (let i = 0; i < statements.length; i++) {
      const sql = statements[i];
      const t0 = Date.now();
      if (fkPragma.test(sql)) {
        results.push({ index: i, sql, ok: true, durationMs: 0 });
        continue;
      }
      try {
        this.db.run(sql);
        results.push({ index: i, sql, ok: true, durationMs: Date.now() - t0 });
      } catch (e) {
        results.push({ index: i, sql, ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 });
        if (stopOnError) {
          failed = true;
          break;
        }
      }
    }
    if (stopOnError) this.db.run(failed ? 'ROLLBACK' : 'COMMIT');
    if (wantsFkOff) this.db.run('PRAGMA foreign_keys = ON');
    if (!failed || !stopOnError) this.changed();
    return results;
  }

  async query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult> {
    const maxRows = opts?.maxRows && opts.maxRows > 0 ? opts.maxRows : 500;
    const t0 = Date.now();
    let last: { columns: string[]; rows: unknown[][]; rowsModified: number } | null = null;
    let writes = false;
    let command: string | undefined;
    for (const stmt of this.db.iterateStatements(sql)) {
      // iterateStatements hands out prepared statements one at a time
      const text = stmt.getSQL();
      command = firstKeyword(text) ?? command;
      if (command && WRITE_KEYWORDS.has(command)) writes = true;
      try {
        const rows: unknown[][] = [];
        let columns: string[] = [];
        while (stmt.step()) {
          if (!columns.length) columns = stmt.getColumnNames();
          if (rows.length <= maxRows) rows.push(stmt.get().map(cell));
        }
        if (!columns.length) columns = stmt.getColumnNames();
        last = { columns, rows, rowsModified: this.db.getRowsModified() };
      } finally {
        stmt.free();
      }
    }
    if (writes) this.changed();
    if (!last) return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: Date.now() - t0, command };
    const truncated = last.rows.length > maxRows;
    const rows = truncated ? last.rows.slice(0, maxRows) : last.rows;
    const isReadOnly = !command || !WRITE_KEYWORDS.has(command);
    return {
      columns: last.columns,
      rows,
      rowCount: last.columns.length || isReadOnly ? rows.length : last.rowsModified,
      truncated,
      durationMs: Date.now() - t0,
      command,
    };
  }

  async introspect(): Promise<IntrospectResponse> {
    const master = this.runOne(`SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    const tables: IntrospectedTable[] = [];
    for (const [name, type, sql] of master.rows as [string, string, string | null][]) {
      if (type === 'view') {
        const cols = this.runOne(`PRAGMA table_info(${q(name)})`).rows as [number, string, string, number, string | null, number][];
        tables.push({
          schema: 'main',
          name,
          kind: 'view',
          viewSql: viewBody(sql ?? ''),
          comment: null,
          columns: cols.map((c) => ({ name: c[1], type: c[2] || 'TEXT', nullable: true, defaultValue: null, autoIncrement: false, comment: null })),
          primaryKey: [],
          uniques: [],
          indexes: [],
          foreignKeys: [],
        });
        continue;
      }
      const cols = this.runOne(`PRAGMA table_info(${q(name)})`).rows as [number, string, string, number, string | null, number][];
      const pk = cols
        .filter((c) => c[5] > 0)
        .sort((a, b) => a[5] - b[5])
        .map((c) => c[1]);
      const hasAutoinc = /\bAUTOINCREMENT\b/i.test(sql ?? '');
      const t: IntrospectedTable = {
        schema: 'main',
        name,
        kind: 'table',
        comment: null,
        columns: cols.map((c) => ({
          name: c[1],
          type: c[2] || 'TEXT',
          nullable: c[3] === 0 && c[5] === 0,
          defaultValue: c[4],
          autoIncrement: hasAutoinc && pk.length === 1 && pk[0] === c[1] && /^INTEGER$/i.test(c[2]),
          comment: null,
        })),
        primaryKey: pk,
        uniques: [],
        indexes: [],
        foreignKeys: [],
      };
      const fks = this.runOne(`PRAGMA foreign_key_list(${q(name)})`).rows as [number, number, string, string, string | null, string, string, string][];
      const grouped = new Map<number, typeof fks>();
      for (const row of fks) {
        if (!grouped.has(row[0])) grouped.set(row[0], []);
        grouped.get(row[0])!.push(row);
      }
      for (const [id, rows] of grouped) {
        rows.sort((a, b) => a[1] - b[1]);
        t.foreignKeys.push({
          name: `fk_${name}_${id}`,
          columns: rows.map((r) => r[3]),
          refSchema: null,
          refTable: rows[0][2],
          refColumns: rows.map((r) => r[4] ?? '').filter(Boolean),
          onDelete: action(rows[0][6]),
          onUpdate: action(rows[0][5]),
        });
      }
      const indexes = this.runOne(`PRAGMA index_list(${q(name)})`).rows as [number, string, number, string, number][];
      for (const [, iname, unique, origin] of indexes) {
        if (origin === 'pk') continue;
        const info = this.runOne(`PRAGMA index_info(${q(iname)})`).rows as [number, number, string | null][];
        const columns = info.sort((a, b) => a[0] - b[0]).map((r) => r[2]).filter((x): x is string => Boolean(x));
        if (!columns.length) continue; // expression index
        if (unique && origin === 'u') t.uniques.push({ name: iname, columns });
        else t.indexes.push({ name: iname, columns, unique: Boolean(unique) });
      }
      tables.push(t);
    }
    return { serverVersion: `SQLite ${await this.version()}`, tables };
  }

  async exportBytes(): Promise<Uint8Array> {
    return this.snapshot();
  }

  async load(bytes: Uint8Array): Promise<void> {
    const next = this.open(bytes);
    this.db.close();
    this.db = next;
    this.changed();
  }

  async reset(): Promise<void> {
    this.db.close();
    this.db = this.open(null);
    this.changed();
  }

  async tableCount(): Promise<number> {
    const r = this.runOne(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    return Number(r.rows[0]?.[0] ?? 0);
  }

  async version(): Promise<string> {
    return String(this.runOne('SELECT sqlite_version()').rows[0]?.[0] ?? '?');
  }

  async compileOptions(): Promise<string[]> {
    try {
      return this.runOne('PRAGMA compile_options').rows.map((r) => String(r[0]));
    } catch {
      // The pragma is itself an optional build feature (SQLITE_OMIT_COMPILEOPTION_DIAGS).
      return [];
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export async function createSqlJsEngine(): Promise<SqliteEngine> {
  const SQL = await loadSqlJs();
  const saved = await idbGet();
  let initial: Uint8Array | null = saved;
  if (saved) {
    // A corrupt blob must not brick the feature: fall back to an empty database.
    try {
      new SQL.Database(saved).close();
    } catch {
      initial = null;
    }
  }
  return new SqlJsEngine(SQL, initial);
}
