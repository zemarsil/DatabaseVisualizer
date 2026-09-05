/**
 * Driver-independent helpers for the query runner: JSON-safe cell values,
 * statement splitting and the read-only guard. No driver imports, so the
 * unit tests can load this file directly.
 */

const MAX_BYTES_SHOWN = 256;

/** Make a driver value JSON-safe and readable in a grid. */
export function serializeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) {
    const n = Math.min(v.length, MAX_BYTES_SHOWN);
    let hex = '';
    for (let i = 0; i < n; i++) hex += v[i].toString(16).padStart(2, '0');
    return `\\x${hex}${v.length > n ? '…' : ''}`;
  }
  if (Array.isArray(v)) return v.map(serializeCell);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  return String(v);
}

export function serializeRows(rows: unknown[][]): unknown[][] {
  return rows.map((r) => r.map(serializeCell));
}

/**
 * Split a script on top-level semicolons, respecting single/double/backtick
 * quotes, line and block comments, and $tag$ dollar quoting. Empty statements
 * are dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && ch === "'") {
          j += 2;
          continue;
        }
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
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? n : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
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
  return out.filter((s) => stripComments(s).trim().length > 0);
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function firstKeyword(sql: string): string {
  const m = /^\s*\(?\s*([A-Za-z]+)/.exec(stripComments(sql));
  return m ? m[1].toUpperCase() : '';
}

const READ_ONLY = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'ANALYZE']);

/** True when every statement in the script only reads. */
export function isReadOnlySql(sql: string): boolean {
  const statements = splitStatements(sql);
  if (statements.length === 0) return false;
  return statements.every((s) => READ_ONLY.has(firstKeyword(s)));
}
