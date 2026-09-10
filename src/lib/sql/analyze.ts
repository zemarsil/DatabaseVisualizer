/**
 * What the SQL editors can say about the text while it is being typed: the
 * tables a statement reads and writes, the mistakes that are cheap to spot
 * (an unclosed string, an extra parenthesis, a table the diagram does not
 * have), and — for the expression fields of a data flow — whether the
 * simulator's own expression parser accepts it and knows every column it
 * names. Finding out here beats finding out at simulate time.
 */
import { collectReferences, parseExpression } from '../simulate/expression';
import { tokenize } from './tokenizer';
import { SQL_FUNCTIONS, SQL_KEYWORDS, scanSql, type SqlScope, type SqlScopeTable, type SqlSegment } from './highlight';

export interface SqlDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** Offsets into the text, when the message is about one place in it. */
  start?: number;
  end?: number;
}

export interface TableReference {
  /** As written, without quotes; may be schema.table. */
  name: string;
  alias?: string;
  role: 'read' | 'write';
  start: number;
  end: number;
}

const solid = (text: string): SqlSegment[] => scanSql(text).filter((s) => s.kind !== 'space' && s.kind !== 'comment');
const isName = (s: SqlSegment | undefined): s is SqlSegment => Boolean(s) && (s!.kind === 'word' || s!.kind === 'quoted');
const unquote = (s: SqlSegment): string => (s.kind === 'quoted' ? s.text.slice(1, -1).replace(/""|``/g, (m) => m[0]) : s.text);
const upper = (s: SqlSegment | undefined): string => (s && s.kind === 'word' ? s.text.toUpperCase() : '');

/**
 * Tables a statement names after FROM, JOIN, INSERT INTO, UPDATE and DELETE
 * FROM, with the alias each is given. Names introduced by WITH are not
 * tables and are left out.
 */
export function referencedTables(text: string): TableReference[] {
  const segs = solid(text);
  const ctes = new Set<string>();
  for (let i = 0; i + 2 < segs.length; i++) {
    if (isName(segs[i]) && upper(segs[i + 1]) === 'AS' && segs[i + 2].text === '(' && (upper(segs[i - 1]) === 'WITH' || upper(segs[i - 1]) === 'RECURSIVE' || segs[i - 1]?.text === ',' || segs[i - 1]?.text === ')')) {
      // "x AS (" after WITH, or after the comma / close paren of an earlier CTE
      ctes.add(unquote(segs[i]).toLowerCase());
    }
  }
  const out: TableReference[] = [];
  const takeName = (j: number, role: 'read' | 'write'): number => {
    if (!isName(segs[j])) return j;
    const first = segs[j];
    let name = unquote(first);
    let end = first.end;
    if (segs[j + 1]?.text === '.' && isName(segs[j + 2])) {
      name = `${name}.${unquote(segs[j + 2])}`;
      end = segs[j + 2].end;
      j += 2;
    }
    if (segs[j + 1]?.text === '(' && role !== 'write') return j + 1; // a function call in FROM; INSERT INTO t (cols) is a table
    if (SQL_KEYWORDS.has(name.toUpperCase()) && first.kind === 'word') return j; // FROM ( ... ) or a stray keyword
    let alias: string | undefined;
    let k = j + 1;
    if (upper(segs[k]) === 'AS') k++;
    const a = segs[k];
    if (a && a.kind === 'word' && !SQL_KEYWORDS.has(a.text.toUpperCase()) && !SQL_FUNCTIONS.has(a.text.toUpperCase())) {
      alias = a.text;
      j = k;
    } else if (a && a.kind === 'quoted' && upper(segs[k - 1]) === 'AS') {
      alias = unquote(a);
      j = k;
    }
    if (!ctes.has(name.toLowerCase())) out.push({ name, alias, role, start: first.start, end });
    return j;
  };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind !== 'word') continue;
    const up = s.text.toUpperCase();
    if (up === 'FROM' || up === 'JOIN') {
      // DELETE FROM writes; every other FROM reads
      const role: 'read' | 'write' = up === 'FROM' && upper(segs[i - 1]) === 'DELETE' ? 'write' : 'read';
      let j = i + 1;
      if (upper(segs[j]) === 'ONLY' || upper(segs[j]) === 'LATERAL') j++;
      for (;;) {
        const after = takeName(j, role);
        if (after === j) break;
        // FROM a, b: a comma list of sources (JOIN takes one)
        if (up === 'FROM' && segs[after + 1]?.text === ',') {
          j = after + 2;
          continue;
        }
        break;
      }
    } else if (up === 'INTO' && (upper(segs[i - 1]) === 'INSERT' || upper(segs[i - 1]) === 'REPLACE' || upper(segs[i - 1]) === 'MERGE')) {
      takeName(i + 1, 'write');
    } else if (up === 'UPDATE' && upper(segs[i - 1]) !== 'DO' && upper(segs[i - 1]) !== 'KEY' && upper(segs[i - 1]) !== 'FOR' && upper(segs[i - 1]) !== 'ON') {
      let j = i + 1;
      if (upper(segs[j]) === 'ONLY') j++;
      takeName(j, 'write');
    }
  }
  return out;
}

function offsetOf(text: string, line: number, col: number): number {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  return Math.min(text.length, pos + Math.max(0, col - 1));
}

/** Unclosed strings and comments (from the strict tokenizer) and unbalanced parentheses. */
function lexicalProblems(text: string): SqlDiagnostic[] {
  const out: SqlDiagnostic[] = [];
  try {
    tokenize(text);
  } catch (e) {
    const err = e as { message?: string; line?: number; col?: number };
    const start = typeof err.line === 'number' && typeof err.col === 'number' ? offsetOf(text, err.line, err.col) : undefined;
    out.push({ severity: 'error', message: err.message ?? String(e), start, end: start === undefined ? undefined : start + 1 });
    return out; // the rest of the text is inside the literal; counting parens there would only add noise
  }
  const open: number[] = [];
  for (const s of scanSql(text)) {
    if (s.kind !== 'punct') continue;
    if (s.text === '(') open.push(s.start);
    else if (s.text === ')') {
      if (open.length === 0) out.push({ severity: 'error', message: 'Closing parenthesis without an opening one', start: s.start, end: s.end });
      else open.pop();
    }
  }
  if (open.length) {
    const at = open[open.length - 1];
    out.push({ severity: 'error', message: open.length === 1 ? 'Parenthesis never closed' : `${open.length} parentheses never closed`, start: at, end: at + 1 });
  }
  return out;
}

function tableIndex(scope: SqlScope | undefined): Map<string, SqlScopeTable> {
  const tables = new Map<string, SqlScopeTable>();
  for (const t of scope?.tables ?? []) {
    tables.set(t.name.toLowerCase(), t);
    if (t.schema) tables.set(`${t.schema}.${t.name}`.toLowerCase(), t);
  }
  return tables;
}

/**
 * Problems with a statement: lexical ones, and — given a scope — tables it
 * names that the diagram does not have. Aliases and CTEs are not mistakes.
 */
export function checkStatement(text: string, scope?: SqlScope): SqlDiagnostic[] {
  if (!text.trim()) return [];
  const out = lexicalProblems(text);
  if (scope && out.length === 0) {
    const tables = tableIndex(scope);
    const seen = new Set<string>();
    for (const ref of referencedTables(text)) {
      const key = ref.name.toLowerCase();
      const bare = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
      if (tables.has(key) || tables.has(bare) || seen.has(key)) continue;
      seen.add(key);
      out.push({ severity: 'warning', message: `${ref.name} is not a table in this diagram`, start: ref.start, end: ref.end });
    }
  }
  return out.sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
}

/** Where a word first appears in the text outside strings and comments, for pointing at it. */
function findWord(text: string, name: string, qualifier: string | null): { start: number; end: number } | null {
  const segs = scanSql(text);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind !== 'word' && s.kind !== 'quoted') continue;
    if (unquote(s).toLowerCase() !== name.toLowerCase()) continue;
    // the previous solid segment must (not) be a dot, to match qualified against qualified
    let p = i - 1;
    while (p >= 0 && segs[p].kind === 'space') p--;
    const qualified = p >= 0 && segs[p].text === '.';
    if (qualified !== Boolean(qualifier)) continue;
    if (qualifier) {
      let q = p - 1;
      while (q >= 0 && segs[q].kind === 'space') q--;
      if (q < 0 || unquote(segs[q]).toLowerCase() !== qualifier.toLowerCase()) continue;
      return { start: segs[q].start, end: s.end };
    }
    return { start: s.start, end: s.end };
  }
  return null;
}

/**
 * Problems with a derivation expression, filter or key: what the expression
 * language rejects, and column names it cannot resolve. A bare name must be
 * a column of the primary table; `table.column` must name a scope table
 * (reached through a foreign key) and one of its columns.
 */
export function checkExpression(text: string, scope?: SqlScope, opts: { lenient?: boolean } = {}): SqlDiagnostic[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '*') return [];
  let expr;
  try {
    expr = parseExpression(trimmed);
  } catch (e) {
    // Lenient: a CHECK may use syntax the simulator's language does not have (a regex match, an array); only what parses is checked.
    if (opts.lenient) return [];
    return [{ severity: 'error', message: e instanceof Error ? e.message : String(e) }];
  }
  if (!scope) return [];
  const tables = tableIndex(scope);
  const primary = scope.primary ? tables.get(scope.primary.toLowerCase()) : undefined;
  const out: SqlDiagnostic[] = [];
  const seen = new Set<string>();
  for (const ref of collectReferences(expr)) {
    const key = `${ref.table ?? ''}.${ref.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // CURRENT_TIMESTAMP, CURRENT_DATE and friends are written without parentheses and parse as bare names
    if (!ref.table && (SQL_FUNCTIONS.has(ref.name.toUpperCase()) || SQL_KEYWORDS.has(ref.name.toUpperCase()))) continue;
    const where = findWord(text, ref.name, ref.table) ?? {};
    if (ref.table) {
      const t = tables.get(ref.table.toLowerCase());
      if (!t) {
        const reach = scope.primary ? ` from ${scope.primary}` : '';
        out.push({ severity: 'warning', message: `${ref.table} is not a table the expression can reach${reach}`, ...where });
      } else if (!t.columns.some((c) => c.name.toLowerCase() === ref.name.toLowerCase())) {
        out.push({ severity: 'warning', message: `${t.name} has no column ${ref.name}`, ...where });
      }
    } else {
      const owner = primary ?? null;
      const known = owner ? owner.columns.some((c) => c.name.toLowerCase() === ref.name.toLowerCase()) : [...tables.values()].some((t) => t.columns.some((c) => c.name.toLowerCase() === ref.name.toLowerCase()));
      if (!known) {
        const elsewhere = [...new Set([...tables.values()].filter((t) => t !== owner && t.columns.some((c) => c.name.toLowerCase() === ref.name.toLowerCase())).map((t) => t.name))];
        const hint = elsewhere.length ? ` — write ${elsewhere[0]}.${ref.name} to read it through the foreign key` : '';
        out.push({ severity: 'warning', message: owner ? `${ref.name} is not a column of ${owner.name}${hint}` : `${ref.name} is not a column of any table here`, ...where });
      }
    }
  }
  return out;
}

export interface StatementRange {
  start: number;
  end: number;
  text: string;
}

/** The statements of a script, split at semicolons outside strings, comments and parentheses. Empty ones are dropped. */
export function splitStatements(text: string): StatementRange[] {
  const out: StatementRange[] = [];
  let depth = 0;
  let start = 0;
  const cut = (end: number) => {
    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    const body = slice.trim();
    if (body) out.push({ start: start + lead, end: start + lead + body.length, text: body });
    start = end;
  };
  for (const s of scanSql(text)) {
    if (s.kind !== 'punct') continue;
    if (s.text === '(') depth++;
    else if (s.text === ')') depth = Math.max(0, depth - 1);
    else if (s.text === ';' && depth === 0) {
      cut(s.end);
      start = s.end;
    }
  }
  cut(text.length);
  return out;
}

/**
 * The statement the caret is in, for "run what is under the cursor": the one
 * whose range contains the caret, else the nearest one before it, else the
 * whole text.
 */
export function statementAt(text: string, caret: number): StatementRange {
  const all = splitStatements(text);
  if (all.length <= 1) return all[0] ?? { start: 0, end: text.length, text: text.trim() };
  const hit = all.find((s) => caret >= s.start && caret <= s.end);
  if (hit) return hit;
  // between statements: the caret sits in the whitespace after one
  const before = [...all].reverse().find((s) => s.end <= caret);
  return before ?? all[0];
}
