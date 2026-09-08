/**
 * A small SQL expression language: what a derivation's expression, filter,
 * grouping key and ordering key are written in.
 *
 * It covers the scalar subset of SQL that describes how one row turns into
 * another: arithmetic, comparisons, AND/OR/NOT with SQL's three-valued NULL
 * logic, IN / BETWEEN / LIKE / IS NULL, CASE, CAST (both spellings), EXTRACT,
 * and the common scalar functions. Dates and timestamps are ISO strings, and
 * subtracting two of them gives days (dates) or seconds (timestamps), which is
 * what "time between consecutive readings" needs.
 *
 * Column references come in two shapes: a bare name is a column of the table
 * the expression runs on, and table.column reaches a column of a table the
 * source points at through foreign keys. Resolution is the caller's business
 * (see EvalContext); the language only carries the reference.
 */
import { tokenize, type Token } from '../sql/tokenizer';

export type Value = null | boolean | number | string;

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '||' | '=' | '<>' | '<' | '<=' | '>' | '>=' | 'AND' | 'OR';

export type Expr =
  | { kind: 'literal'; value: Value }
  | { kind: 'column'; table: string | null; name: string }
  | { kind: 'star' }
  | { kind: 'unary'; op: '-' | '+' | 'NOT'; arg: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'is'; arg: Expr; not: boolean; what: 'NULL' | 'TRUE' | 'FALSE' }
  | { kind: 'in'; arg: Expr; list: Expr[]; not: boolean }
  | { kind: 'between'; arg: Expr; lo: Expr; hi: Expr; not: boolean }
  | { kind: 'like'; arg: Expr; pattern: Expr; not: boolean; caseInsensitive: boolean }
  | { kind: 'case'; operand: Expr | null; whens: { when: Expr; then: Expr }[]; else: Expr | null }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'cast'; arg: Expr; type: string }
  | { kind: 'extract'; field: string; arg: Expr };

export interface ColumnRef {
  /** null: a column of the table the expression runs on. */
  table: string | null;
  name: string;
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** The simulation's clock, so NOW() and friends are deterministic. */
export const SIMULATION_NOW = '2025-01-01 09:00:00';

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

const COMPARISONS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);
const TYPE_TAILS = new Set(['PRECISION', 'VARYING', 'ZONE', 'TIME', 'WITH', 'WITHOUT', 'UNSIGNED']);

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[], private readonly text: string) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.tokens[this.i];
    if (t.type !== 'eof') this.i++;
    return t;
  }
  private isWord(...words: string[]): boolean {
    const t = this.peek();
    return t.type === 'word' && words.includes(t.upper);
  }
  private isPunct(...values: string[]): boolean {
    const t = this.peek();
    return t.type === 'punct' && values.includes(t.value);
  }
  private fail(message: string, at: Token = this.peek()): never {
    const where = at.type === 'eof' ? 'at the end' : `at "${this.text.slice(at.start, at.end)}"`;
    throw new ExpressionError(`${message} ${where}`);
  }
  private expectPunct(value: string): void {
    if (!this.isPunct(value)) this.fail(`Expected "${value}"`);
    this.next();
  }
  private expectWord(word: string): void {
    if (!this.isWord(word)) this.fail(`Expected ${word}`);
    this.next();
  }

  parse(): Expr {
    if (this.peek().type === 'eof') throw new ExpressionError('The expression is empty');
    const e = this.parseOr();
    if (this.peek().type !== 'eof') this.fail('Unexpected input');
    return e;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isWord('OR')) {
      this.next();
      left = { kind: 'binary', op: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isWord('AND')) {
      this.next();
      left = { kind: 'binary', op: 'AND', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.isWord('NOT')) {
      this.next();
      return { kind: 'unary', op: 'NOT', arg: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseConcat();
    for (;;) {
      if (this.isWord('IS')) {
        this.next();
        let not = false;
        if (this.isWord('NOT')) {
          this.next();
          not = true;
        }
        if (this.isWord('NULL', 'TRUE', 'FALSE')) {
          const what = this.next().upper as 'NULL' | 'TRUE' | 'FALSE';
          left = { kind: 'is', arg: left, not, what };
          continue;
        }
        this.fail('Expected NULL, TRUE or FALSE after IS');
      }
      let not = false;
      if (this.isWord('NOT') && this.peek(1).type === 'word' && ['IN', 'BETWEEN', 'LIKE', 'ILIKE'].includes(this.peek(1).upper)) {
        this.next();
        not = true;
      }
      if (this.isWord('IN')) {
        this.next();
        this.expectPunct('(');
        const list: Expr[] = [];
        if (!this.isPunct(')')) {
          list.push(this.parseOr());
          while (this.isPunct(',')) {
            this.next();
            list.push(this.parseOr());
          }
        }
        this.expectPunct(')');
        left = { kind: 'in', arg: left, list, not };
        continue;
      }
      if (this.isWord('BETWEEN')) {
        this.next();
        const lo = this.parseConcat();
        this.expectWord('AND');
        const hi = this.parseConcat();
        left = { kind: 'between', arg: left, lo, hi, not };
        continue;
      }
      if (this.isWord('LIKE', 'ILIKE')) {
        const caseInsensitive = this.next().upper === 'ILIKE';
        left = { kind: 'like', arg: left, pattern: this.parseConcat(), not, caseInsensitive };
        continue;
      }
      if (not) this.fail('Expected IN, BETWEEN or LIKE after NOT');
      const t = this.peek();
      if (t.type === 'punct' && COMPARISONS.has(t.value)) {
        this.next();
        const op = (t.value === '!=' ? '<>' : t.value) as BinaryOp;
        left = { kind: 'binary', op, left, right: this.parseConcat() };
        continue;
      }
      return left;
    }
  }

  private parseConcat(): Expr {
    let left = this.parseAdditive();
    while (this.isPunct('||')) {
      this.next();
      left = { kind: 'binary', op: '||', left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isPunct('+', '-')) {
      const op = this.next().value as BinaryOp;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isPunct('*', '/', '%')) {
      const op = this.next().value as BinaryOp;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isPunct('-', '+')) {
      const op = this.next().value as '-' | '+';
      return { kind: 'unary', op, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    while (this.isPunct('::')) {
      this.next();
      e = { kind: 'cast', arg: e, type: this.parseTypeName() };
    }
    return e;
  }

  /** A type name: one word, an optional (args) and the odd trailing word ("DOUBLE PRECISION"). */
  private parseTypeName(): string {
    const t = this.peek();
    if (t.type !== 'word') this.fail('Expected a type name');
    let name = this.next().upper;
    while (this.peek().type === 'word' && TYPE_TAILS.has(this.peek().upper)) name += ` ${this.next().upper}`;
    if (this.isPunct('(')) {
      this.next();
      let depth = 1;
      while (depth > 0 && this.peek().type !== 'eof') {
        const p = this.next();
        if (p.type === 'punct' && p.value === '(') depth++;
        else if (p.type === 'punct' && p.value === ')') depth--;
      }
    }
    return name;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && t.value === '(') {
      this.next();
      const e = this.parseOr();
      this.expectPunct(')');
      return e;
    }
    if (t.type === 'punct' && t.value === '*') {
      this.next();
      return { kind: 'star' };
    }
    if (t.type === 'number') {
      this.next();
      return { kind: 'literal', value: Number(t.value) };
    }
    if (t.type === 'string') {
      this.next();
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'quoted') {
      this.next();
      return this.finishColumn(t.value);
    }
    if (t.type === 'word') {
      switch (t.upper) {
        case 'NULL':
          this.next();
          return { kind: 'literal', value: null };
        case 'TRUE':
          this.next();
          return { kind: 'literal', value: true };
        case 'FALSE':
          this.next();
          return { kind: 'literal', value: false };
        case 'CASE':
          this.next();
          return this.parseCase();
        case 'CAST': {
          this.next();
          this.expectPunct('(');
          const arg = this.parseOr();
          this.expectWord('AS');
          const type = this.parseTypeName();
          this.expectPunct(')');
          return { kind: 'cast', arg, type };
        }
        case 'EXTRACT': {
          this.next();
          this.expectPunct('(');
          const f = this.next();
          if (f.type !== 'word') this.fail('Expected a field name (YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, EPOCH, DOW) after EXTRACT(', f);
          this.expectWord('FROM');
          const arg = this.parseOr();
          this.expectPunct(')');
          return { kind: 'extract', field: f.upper, arg };
        }
        case 'CURRENT_DATE':
        case 'CURRENT_TIMESTAMP':
        case 'CURRENT_TIME':
        case 'LOCALTIMESTAMP':
          this.next();
          if (this.isPunct('(')) {
            this.next();
            this.expectPunct(')');
          }
          return { kind: 'call', name: t.upper, args: [] };
        default:
          break;
      }
      this.next();
      if (this.isPunct('(')) {
        this.next();
        const args: Expr[] = [];
        // TIMESTAMPDIFF(HOUR, a, b): the unit is a bare keyword, not a column.
        if ((t.upper === 'TIMESTAMPDIFF' || t.upper === 'TIMESTAMPADD') && this.peek().type === 'word' && this.peek(1).type === 'punct' && this.peek(1).value === ',') {
          args.push({ kind: 'literal', value: this.next().upper });
          this.next();
        }
        if (!this.isPunct(')')) {
          args.push(this.parseOr());
          while (this.isPunct(',')) {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expectPunct(')');
        return { kind: 'call', name: t.upper, args };
      }
      return this.finishColumn(t.value);
    }
    return this.fail('Unexpected token');
  }

  /** `name` alone, or `name.column` when a dot follows. */
  private finishColumn(first: string): Expr {
    if (this.isPunct('.')) {
      this.next();
      const c = this.next();
      if (c.type !== 'word' && c.type !== 'quoted') this.fail('Expected a column name after "."', c);
      return { kind: 'column', table: first, name: c.value };
    }
    return { kind: 'column', table: null, name: first };
  }

  private parseCase(): Expr {
    const operand = this.isWord('WHEN') ? null : this.parseOr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.isWord('WHEN')) {
      this.next();
      const when = this.parseOr();
      this.expectWord('THEN');
      whens.push({ when, then: this.parseOr() });
    }
    if (!whens.length) this.fail('Expected WHEN after CASE');
    let elseExpr: Expr | null = null;
    if (this.isWord('ELSE')) {
      this.next();
      elseExpr = this.parseOr();
    }
    this.expectWord('END');
    return { kind: 'case', operand, whens, else: elseExpr };
  }
}

const parseCache = new Map<string, Expr>();

/** Parse an expression, throwing ExpressionError with a readable message. Results are cached by text. */
export function parseExpression(text: string): Expr {
  const key = text.trim();
  const hit = parseCache.get(key);
  if (hit) return hit;
  let tokens: Token[];
  try {
    tokens = tokenize(key);
  } catch (e) {
    throw new ExpressionError(e instanceof Error ? e.message : String(e));
  }
  const expr = new Parser(tokens, key).parse();
  if (parseCache.size > 500) parseCache.clear();
  parseCache.set(key, expr);
  return expr;
}

/** True when the text is a lone "*" (COUNT(*)). */
export function isStar(e: Expr): boolean {
  return e.kind === 'star';
}

/** Every column reference in an expression, in order of appearance (duplicates kept). */
export function collectReferences(e: Expr, out: ColumnRef[] = []): ColumnRef[] {
  switch (e.kind) {
    case 'column':
      out.push({ table: e.table, name: e.name });
      break;
    case 'unary':
      collectReferences(e.arg, out);
      break;
    case 'binary':
      collectReferences(e.left, out);
      collectReferences(e.right, out);
      break;
    case 'is':
      collectReferences(e.arg, out);
      break;
    case 'in':
      collectReferences(e.arg, out);
      for (const x of e.list) collectReferences(x, out);
      break;
    case 'between':
      collectReferences(e.arg, out);
      collectReferences(e.lo, out);
      collectReferences(e.hi, out);
      break;
    case 'like':
      collectReferences(e.arg, out);
      collectReferences(e.pattern, out);
      break;
    case 'case':
      if (e.operand) collectReferences(e.operand, out);
      for (const w of e.whens) {
        collectReferences(w.when, out);
        collectReferences(w.then, out);
      }
      if (e.else) collectReferences(e.else, out);
      break;
    case 'call':
      for (const a of e.args) collectReferences(a, out);
      break;
    case 'cast':
    case 'extract':
      collectReferences(e.arg, out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Literal values a column is compared with, e.g. status = 'paid' or
 * status IN ('paid', 'shipped'): the simulator seeds those values into the
 * column so a filter has something to match.
 */
export function collectComparedLiterals(e: Expr, out: { ref: ColumnRef; value: Value }[] = []): { ref: ColumnRef; value: Value }[] {
  const lit = (x: Expr): Value | undefined => (x.kind === 'literal' ? x.value : undefined);
  switch (e.kind) {
    case 'binary':
      if (['=', '<>'].includes(e.op)) {
        if (e.left.kind === 'column' && lit(e.right) !== undefined) out.push({ ref: e.left, value: lit(e.right)! });
        else if (e.right.kind === 'column' && lit(e.left) !== undefined) out.push({ ref: e.right, value: lit(e.left)! });
      }
      collectComparedLiterals(e.left, out);
      collectComparedLiterals(e.right, out);
      break;
    case 'in':
      if (e.arg.kind === 'column') for (const x of e.list) if (lit(x) !== undefined) out.push({ ref: e.arg, value: lit(x)! });
      break;
    case 'unary':
      collectComparedLiterals(e.arg, out);
      break;
    case 'case':
      for (const w of e.whens) collectComparedLiterals(w.when, out);
      break;
    default:
      break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

interface Temporal {
  ms: number;
  dateOnly: boolean;
}

const TEMPORAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(?:\s*(?:Z|[+-]\d{2}(?::?\d{2})?))?$/;

/** Parse an ISO-ish date or timestamp string (what the seed generator and databases hand back). */
export function parseTemporal(v: Value): Temporal | null {
  if (typeof v !== 'string') return null;
  const m = TEMPORAL_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), frac ? Math.round(Number(`0.${frac}`) * 1000) : 0);
  if (Number.isNaN(ms)) return null;
  return { ms, dateOnly: h === undefined };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function formatTimestamp(ms: number): string {
  const dt = new Date(ms);
  return `${formatDate(ms)} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

function formatTemporal(t: Temporal): string {
  return t.dateOnly ? formatDate(t.ms) : formatTimestamp(t.ms);
}

const NUMERIC_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

export function isNumericString(v: Value): boolean {
  return typeof v === 'string' && NUMERIC_RE.test(v);
}

/** Coerce to a number for arithmetic; a string that is not a number is an error rather than a silent 0. */
export function toNumber(v: Value, what = 'value'): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && NUMERIC_RE.test(v)) return Number(v);
  throw new ExpressionError(`${what} "${String(v)}" is not a number`);
}

/**
 * SQL comparison. null when either side is NULL; numbers compare numerically
 * (a numeric string next to a number is read as a number), everything else
 * as text, which puts ISO dates and timestamps in chronological order.
 */
export function compareValues(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = typeof a === 'number' ? a : isNumericString(a) ? Number(a) : NaN;
    const nb = typeof b === 'number' ? b : isNumericString(b) ? Number(b) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
    a = String(a);
    b = String(b);
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Ordering for sorts: NULLs first, like PostgreSQL's ASC default reversed... kept simple: NULLs last. */
export function orderValues(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareValues(a, b) ?? 0;
}

/** Display form of a value: NULL, TRUE/FALSE, numbers without float noise. */
export function formatValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(6)));
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface EvalContext {
  /**
   * The value of a column on the current row. `table` is null for the table
   * the expression runs on. Implementations throw ExpressionError for a column
   * that does not exist or a table that cannot be reached.
   */
  column(table: string | null, name: string): Value;
}

function and(a: Value, b: Value): Value {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return truthy(a) && truthy(b);
}

function or(a: Value, b: Value): Value {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return truthy(a) || truthy(b);
}

function truthy(v: Value): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (NUMERIC_RE.test(v)) return Number(v) !== 0;
  return v.toLowerCase() === 'true' || v.toLowerCase() === 't';
}

function bool(v: Value): boolean | null {
  return v === null ? null : truthy(v);
}

function arithmetic(op: BinaryOp, a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  const ta = parseTemporal(a);
  const tb = parseTemporal(b);
  if (op === '-' && ta && tb) {
    // date - date is a number of days, timestamp - timestamp a number of seconds
    if (ta.dateOnly && tb.dateOnly) return Math.round((ta.ms - tb.ms) / 86_400_000);
    return (ta.ms - tb.ms) / 1000;
  }
  if ((op === '+' || op === '-') && (ta || tb) && !(ta && tb)) {
    // date +/- n adds days; timestamp +/- n adds seconds
    const t = ta ?? tb!;
    const n = toNumber(ta ? b : a);
    if (!ta && op === '-') throw new ExpressionError('A number minus a date has no meaning');
    const delta = (op === '-' ? -n : n) * (t.dateOnly ? 86_400_000 : 1000);
    return formatTemporal({ ms: t.ms + delta, dateOnly: t.dateOnly });
  }
  const x = toNumber(a);
  const y = toNumber(b);
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      if (y === 0) return null;
      return x / y;
    case '%':
      if (y === 0) return null;
      return x % y;
    default:
      throw new ExpressionError(`Unknown operator ${op}`);
  }
}

function likeToRegex(pattern: string, caseInsensitive: boolean): RegExp {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$', caseInsensitive ? 'is' : 's');
}

function castValue(v: Value, type: string): Value {
  if (v === null) return null;
  const t = type.toUpperCase();
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|INT2|INT4|INT8)$/.test(t)) {
    const n = typeof v === 'string' && !NUMERIC_RE.test(v) ? Number.parseFloat(v) : toNumber(v);
    if (Number.isNaN(n)) throw new ExpressionError(`"${String(v)}" cannot be cast to ${t}`);
    return Math.trunc(n);
  }
  if (/^(NUMERIC|DECIMAL|REAL|FLOAT|DOUBLE|DOUBLE PRECISION|FLOAT4|FLOAT8|MONEY)$/.test(t)) {
    const n = typeof v === 'string' ? Number.parseFloat(v) : toNumber(v);
    if (Number.isNaN(n)) throw new ExpressionError(`"${String(v)}" cannot be cast to ${t}`);
    return n;
  }
  if (/^(TEXT|VARCHAR|CHAR|CHARACTER VARYING|CHARACTER|STRING|CITEXT)$/.test(t)) return formatValue(v);
  if (/^(BOOL|BOOLEAN)$/.test(t)) return truthy(v);
  if (t === 'DATE') {
    const tm = parseTemporal(v);
    if (!tm) throw new ExpressionError(`"${String(v)}" is not a date`);
    return formatDate(tm.ms);
  }
  if (/^(TIMESTAMP|TIMESTAMPTZ|DATETIME|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITHOUT TIME ZONE)$/.test(t)) {
    const tm = parseTemporal(v);
    if (!tm) throw new ExpressionError(`"${String(v)}" is not a timestamp`);
    return formatTimestamp(tm.ms);
  }
  return v;
}

function temporalArg(v: Value, fn: string): Temporal {
  const t = parseTemporal(v);
  if (!t) throw new ExpressionError(`${fn} needs a date or timestamp, got "${String(v)}"`);
  return t;
}

function extractField(field: string, v: Value): Value {
  if (v === null) return null;
  const t = temporalArg(v, `EXTRACT(${field})`);
  const d = new Date(t.ms);
  switch (field) {
    case 'YEAR':
      return d.getUTCFullYear();
    case 'MONTH':
      return d.getUTCMonth() + 1;
    case 'DAY':
      return d.getUTCDate();
    case 'HOUR':
      return d.getUTCHours();
    case 'MINUTE':
      return d.getUTCMinutes();
    case 'SECOND':
      return d.getUTCSeconds();
    case 'DOW':
      return d.getUTCDay();
    case 'DOY': {
      const start = Date.UTC(d.getUTCFullYear(), 0, 1);
      return Math.floor((t.ms - start) / 86_400_000) + 1;
    }
    case 'EPOCH':
      return t.ms / 1000;
    case 'WEEK': {
      const start = Date.UTC(d.getUTCFullYear(), 0, 1);
      return Math.floor((t.ms - start) / (7 * 86_400_000)) + 1;
    }
    default:
      throw new ExpressionError(`Unknown EXTRACT field ${field}`);
  }
}

function dateTrunc(unit: string, v: Value): Value {
  if (v === null) return null;
  const t = temporalArg(v, 'DATE_TRUNC');
  const d = new Date(t.ms);
  const u = unit.toLowerCase();
  let ms: number;
  switch (u) {
    case 'year':
      ms = Date.UTC(d.getUTCFullYear(), 0, 1);
      break;
    case 'quarter':
      ms = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
      break;
    case 'month':
      ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      break;
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
      break;
    }
    case 'day':
      ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      break;
    case 'hour':
      ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
      break;
    case 'minute':
      ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
      break;
    default:
      throw new ExpressionError(`Unknown DATE_TRUNC unit '${unit}'`);
  }
  return t.dateOnly && ['year', 'quarter', 'month', 'week', 'day'].includes(u) ? formatDate(ms) : formatTimestamp(ms);
}

function str(v: Value): string {
  return formatValue(v);
}

function callFunction(name: string, args: Value[]): Value {
  const a = args[0];
  const nullIn = (n: number) => args.slice(0, n).some((x) => x === null);
  switch (name) {
    // --- null handling
    case 'COALESCE':
    case 'IFNULL':
    case 'NVL':
      return args.find((x) => x !== null) ?? null;
    case 'NULLIF':
      return compareValues(args[0], args[1]) === 0 ? null : args[0];
    case 'IIF':
    case 'IF':
      return truthy(args[0]) ? (args[1] ?? null) : (args[2] ?? null);
    case 'GREATEST':
      if (args.some((x) => x === null)) return null;
      return args.reduce((m, x) => (compareValues(x, m)! > 0 ? x : m));
    case 'LEAST':
      if (args.some((x) => x === null)) return null;
      return args.reduce((m, x) => (compareValues(x, m)! < 0 ? x : m));
    // --- numbers
    case 'ABS':
      return a === null ? null : Math.abs(toNumber(a));
    case 'ROUND': {
      if (nullIn(1)) return null;
      const places = args[1] === undefined || args[1] === null ? 0 : toNumber(args[1]);
      const f = Math.pow(10, places);
      return Math.round(toNumber(a) * f) / f;
    }
    case 'FLOOR':
      return a === null ? null : Math.floor(toNumber(a));
    case 'CEIL':
    case 'CEILING':
      return a === null ? null : Math.ceil(toNumber(a));
    case 'TRUNC':
    case 'TRUNCATE':
      return a === null ? null : Math.trunc(toNumber(a));
    case 'SQRT':
      return a === null ? null : Math.sqrt(toNumber(a));
    case 'POWER':
    case 'POW':
      return nullIn(2) ? null : Math.pow(toNumber(args[0]), toNumber(args[1]));
    case 'MOD':
      return nullIn(2) ? null : toNumber(args[0]) % toNumber(args[1]);
    case 'SIGN':
      return a === null ? null : Math.sign(toNumber(a));
    case 'LN':
      return a === null ? null : Math.log(toNumber(a));
    case 'LOG':
    case 'LOG10':
      return a === null ? null : Math.log10(toNumber(a));
    case 'EXP':
      return a === null ? null : Math.exp(toNumber(a));
    // --- text
    case 'UPPER':
    case 'UCASE':
      return a === null ? null : str(a).toUpperCase();
    case 'LOWER':
    case 'LCASE':
      return a === null ? null : str(a).toLowerCase();
    case 'INITCAP':
      return a === null ? null : str(a).toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
    case 'LENGTH':
    case 'CHAR_LENGTH':
    case 'CHARACTER_LENGTH':
    case 'LEN':
      return a === null ? null : str(a).length;
    case 'TRIM':
      return a === null ? null : str(a).trim();
    case 'LTRIM':
      return a === null ? null : str(a).replace(/^\s+/, '');
    case 'RTRIM':
      return a === null ? null : str(a).replace(/\s+$/, '');
    case 'SUBSTR':
    case 'SUBSTRING': {
      if (nullIn(2)) return null;
      const s = str(a);
      const start = Math.max(1, toNumber(args[1])) - 1;
      const len = args[2] === undefined || args[2] === null ? undefined : toNumber(args[2]);
      return len === undefined ? s.slice(start) : s.slice(start, start + Math.max(0, len));
    }
    case 'LEFT':
      return nullIn(2) ? null : str(a).slice(0, Math.max(0, toNumber(args[1])));
    case 'RIGHT': {
      if (nullIn(2)) return null;
      const n = Math.max(0, toNumber(args[1]));
      const s = str(a);
      return n === 0 ? '' : s.slice(-n);
    }
    case 'CONCAT':
      return args.map((x) => (x === null ? '' : str(x))).join('');
    case 'CONCAT_WS':
      return args
        .slice(1)
        .filter((x) => x !== null)
        .map(str)
        .join(a === null ? '' : str(a));
    case 'REPLACE':
      return nullIn(3) ? null : str(a).split(str(args[1])).join(str(args[2]));
    case 'REVERSE':
      return a === null ? null : [...str(a)].reverse().join('');
    case 'REPEAT':
      return nullIn(2) ? null : str(a).repeat(Math.max(0, toNumber(args[1])));
    case 'POSITION':
    case 'INSTR':
    case 'STRPOS':
      return nullIn(2) ? null : (name === 'POSITION' ? str(args[1]).indexOf(str(a)) : str(a).indexOf(str(args[1]))) + 1;
    // --- dates
    case 'NOW':
    case 'CURRENT_TIMESTAMP':
    case 'LOCALTIMESTAMP':
    case 'SYSDATE':
    case 'GETDATE':
      return SIMULATION_NOW;
    case 'CURRENT_DATE':
    case 'CURDATE':
    case 'TODAY':
      return SIMULATION_NOW.slice(0, 10);
    case 'CURRENT_TIME':
    case 'CURTIME':
      return SIMULATION_NOW.slice(11);
    case 'DATE':
      return a === null ? null : formatDate(temporalArg(a, 'DATE').ms);
    case 'TIME':
      return a === null ? null : formatTimestamp(temporalArg(a, 'TIME').ms).slice(11);
    case 'YEAR':
    case 'MONTH':
    case 'DAY':
    case 'HOUR':
    case 'MINUTE':
    case 'SECOND':
      return extractField(name, a);
    case 'DAYOFWEEK':
      return a === null ? null : (extractField('DOW', a) as number) + 1;
    case 'DAYOFYEAR':
      return extractField('DOY', a);
    case 'DATE_TRUNC':
      return nullIn(2) ? null : dateTrunc(str(a), args[1]);
    case 'DATE_PART':
      return nullIn(2) ? null : extractField(str(a).toUpperCase(), args[1]);
    case 'JULIANDAY':
      return a === null ? null : temporalArg(a, 'JULIANDAY').ms / 86_400_000 + 2440587.5;
    case 'UNIXEPOCH':
    case 'UNIX_TIMESTAMP':
    case 'EPOCH':
      return a === null ? null : temporalArg(a, name).ms / 1000;
    case 'DATEDIFF': {
      // MariaDB / SQL Server order: DATEDIFF(later, earlier) in days
      if (nullIn(2)) return null;
      return Math.round((temporalArg(args[0], 'DATEDIFF').ms - temporalArg(args[1], 'DATEDIFF').ms) / 86_400_000);
    }
    case 'TIMESTAMPDIFF': {
      if (nullIn(3)) return null;
      const unit = str(a).toUpperCase();
      const diff = temporalArg(args[2], 'TIMESTAMPDIFF').ms - temporalArg(args[1], 'TIMESTAMPDIFF').ms;
      const per: Record<string, number> = { SECOND: 1000, MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000, WEEK: 7 * 86_400_000 };
      if (!per[unit]) throw new ExpressionError(`Unsupported TIMESTAMPDIFF unit ${unit}`);
      return Math.trunc(diff / per[unit]);
    }
    case 'AGE':
      return nullIn(1) ? null : arithmetic('-', args[1] === undefined ? SIMULATION_NOW : args[1], a);
    // --- misc
    case 'RANDOM':
    case 'RAND':
      return 0.5;
    case 'MD5':
    case 'HASH':
      return a === null ? null : str(a).split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
    default:
      throw new ExpressionError(`Unknown function ${name}()`);
  }
}

/** Evaluate an expression on one row. Throws ExpressionError for anything that cannot be computed. */
export function evaluate(e: Expr, ctx: EvalContext): Value {
  switch (e.kind) {
    case 'literal':
      return e.value;
    case 'column':
      return ctx.column(e.table, e.name);
    case 'star':
      throw new ExpressionError('"*" only makes sense under COUNT');
    case 'unary': {
      const v = evaluate(e.arg, ctx);
      if (e.op === 'NOT') {
        const b = bool(v);
        return b === null ? null : !b;
      }
      if (v === null) return null;
      return e.op === '-' ? -toNumber(v) : toNumber(v);
    }
    case 'binary': {
      if (e.op === 'AND') return and(evaluate(e.left, ctx), evaluate(e.right, ctx));
      if (e.op === 'OR') return or(evaluate(e.left, ctx), evaluate(e.right, ctx));
      const l = evaluate(e.left, ctx);
      const r = evaluate(e.right, ctx);
      switch (e.op) {
        case '||':
          return l === null || r === null ? null : str(l) + str(r);
        case '=':
        case '<>':
        case '<':
        case '<=':
        case '>':
        case '>=': {
          const c = compareValues(l, r);
          if (c === null) return null;
          switch (e.op) {
            case '=':
              return c === 0;
            case '<>':
              return c !== 0;
            case '<':
              return c < 0;
            case '<=':
              return c <= 0;
            case '>':
              return c > 0;
            default:
              return c >= 0;
          }
        }
        default:
          return arithmetic(e.op, l, r);
      }
    }
    case 'is': {
      const v = evaluate(e.arg, ctx);
      let hit: boolean;
      if (e.what === 'NULL') hit = v === null;
      else hit = v !== null && truthy(v) === (e.what === 'TRUE');
      return e.not ? !hit : hit;
    }
    case 'in': {
      const v = evaluate(e.arg, ctx);
      if (v === null) return null;
      let sawNull = false;
      for (const x of e.list) {
        const c = compareValues(v, evaluate(x, ctx));
        if (c === null) sawNull = true;
        else if (c === 0) return !e.not;
      }
      if (sawNull) return null;
      return e.not;
    }
    case 'between': {
      const v = evaluate(e.arg, ctx);
      const lo = compareValues(v, evaluate(e.lo, ctx));
      const hi = compareValues(v, evaluate(e.hi, ctx));
      const inside = and(lo === null ? null : lo >= 0, hi === null ? null : hi <= 0);
      if (inside === null) return null;
      return e.not ? !truthy(inside) : truthy(inside);
    }
    case 'like': {
      const v = evaluate(e.arg, ctx);
      const p = evaluate(e.pattern, ctx);
      if (v === null || p === null) return null;
      const hit = likeToRegex(str(p), e.caseInsensitive).test(str(v));
      return e.not ? !hit : hit;
    }
    case 'case': {
      const operand = e.operand ? evaluate(e.operand, ctx) : undefined;
      for (const w of e.whens) {
        const test = evaluate(w.when, ctx);
        const hit = operand === undefined ? truthy(test) : compareValues(operand, test) === 0;
        if (hit) return evaluate(w.then, ctx);
      }
      return e.else ? evaluate(e.else, ctx) : null;
    }
    case 'call':
      return callFunction(
        e.name,
        e.args.map((a) => evaluate(a, ctx)),
      );
    case 'cast':
      return castValue(evaluate(e.arg, ctx), e.type);
    case 'extract':
      return extractField(e.field, evaluate(e.arg, ctx));
    default:
      throw new ExpressionError('Unsupported expression');
  }
}

/** a - b with the same rules as the "-" operator (dates give days, timestamps seconds). */
export function subtractValues(a: Value, b: Value): Value {
  return arithmetic('-', a, b);
}

/** Parse and evaluate in one go, for callers with a single row. */
export function evaluateText(text: string, ctx: EvalContext): Value {
  return evaluate(parseExpression(text), ctx);
}

/** Render an expression back to SQL-ish text (used for explanations, not for generated scripts). */
export function exprToString(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      if (e.value === null) return 'NULL';
      if (typeof e.value === 'string') return `'${e.value.replace(/'/g, "''")}'`;
      return formatValue(e.value);
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name;
    case 'star':
      return '*';
    case 'unary':
      return e.op === 'NOT' ? `NOT ${exprToString(e.arg)}` : `${e.op}${exprToString(e.arg)}`;
    case 'binary':
      return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
    case 'is':
      return `${exprToString(e.arg)} IS ${e.not ? 'NOT ' : ''}${e.what}`;
    case 'in':
      return `${exprToString(e.arg)} ${e.not ? 'NOT ' : ''}IN (${e.list.map(exprToString).join(', ')})`;
    case 'between':
      return `${exprToString(e.arg)} ${e.not ? 'NOT ' : ''}BETWEEN ${exprToString(e.lo)} AND ${exprToString(e.hi)}`;
    case 'like':
      return `${exprToString(e.arg)} ${e.not ? 'NOT ' : ''}${e.caseInsensitive ? 'ILIKE' : 'LIKE'} ${exprToString(e.pattern)}`;
    case 'case':
      return `CASE ${e.operand ? exprToString(e.operand) + ' ' : ''}${e.whens.map((w) => `WHEN ${exprToString(w.when)} THEN ${exprToString(w.then)}`).join(' ')}${e.else ? ` ELSE ${exprToString(e.else)}` : ''} END`;
    case 'call':
      return `${e.name}(${e.args.map(exprToString).join(', ')})`;
    case 'cast':
      return `CAST(${exprToString(e.arg)} AS ${e.type})`;
    case 'extract':
      return `EXTRACT(${e.field} FROM ${exprToString(e.arg)})`;
    default:
      return '?';
  }
}
