import type { Dialect, ReferentialAction } from '@shared/types';
import { SqlSyntaxError, tokenize, type Token } from './tokenizer';
import { parseRoutineParams } from '@shared/routines';

/* ------------------------------------------------------------------ */
/* Output model                                                        */
/* ------------------------------------------------------------------ */

export interface ParsedReference {
  name?: string;
  refSchema?: string;
  refTable: string;
  /** Empty when the DDL omitted the column list (PostgreSQL then uses the PK). */
  refColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface ParsedColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue?: string;
  check?: string;
  comment?: string;
  references?: ParsedReference;
}

export interface ParsedForeignKey extends ParsedReference {
  columns: string[];
}

export interface ParsedIndex {
  name?: string;
  columns: string[];
  unique: boolean;
}

export interface ParsedTable {
  schema?: string;
  name: string;
  columns: ParsedColumn[];
  primaryKey: string[];
  uniques: { name?: string; columns: string[] }[];
  indexes: ParsedIndex[];
  checks: string[];
  foreignKeys: ParsedForeignKey[];
  comment?: string;
}

export interface ParseMessage {
  message: string;
  line: number;
  col: number;
}

export interface ParsedCompositeType {
  name: string;
  fields: { name: string; type: string }[];
}

export interface ParsedView {
  schema?: string;
  name: string;
  /** Explicit column list, when the statement had one. */
  columns: string[];
  /** Raw SELECT body, as written. */
  sql: string;
  /** Table names referenced after FROM / JOIN (best effort). */
  sources: string[];
  materialized?: boolean;
}

export interface ParsedExtension {
  name: string;
  /** PostgreSQL: WITH SCHEMA ... */
  schema?: string;
  /** PostgreSQL: VERSION '...' */
  version?: string;
}

/** A stored procedure or function: CREATE PROCEDURE / CREATE FUNCTION. */
export interface ParsedRoutine {
  schema?: string;
  name: string;
  kind: 'procedure' | 'function';
  params: { name: string; type: string; mode?: 'in' | 'out' | 'inout'; defaultValue?: string }[];
  /** Functions only: the RETURNS clause as written. */
  returns?: string;
  /** PostgreSQL's LANGUAGE, lower-cased; absent on MariaDB, which has one. */
  language?: string;
  /** PostgreSQL: what was inside the quotes after AS. MariaDB: the routine body, BEGIN … END included. */
  body: string;
  comment?: string;
}

export interface ParseResult {
  tables: ParsedTable[];
  views: ParsedView[];
  /** Absent from results built before procedures existed; the importer treats that as none. */
  routines?: ParsedRoutine[];
  extensions: ParsedExtension[];
  enums: { name: string; values: string[] }[];
  compositeTypes: ParsedCompositeType[];
  errors: ParseMessage[];
  warnings: ParseMessage[];
  statementCount: number;
}

/* ------------------------------------------------------------------ */
/* Keyword sets                                                        */
/* ------------------------------------------------------------------ */

const CONSTRAINT_STARTERS = new Set([
  'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'AUTO_INCREMENT', 'AUTOINCREMENT',
  'GENERATED', 'COLLATE', 'COMMENT', 'KEY', 'ON', 'INVISIBLE', 'VISIBLE', 'AS', 'CHARSET', 'DEFERRABLE',
  'INITIALLY', 'FIRST', 'AFTER', 'STORAGE', 'COMPRESSION', 'ENCODE',
]);

const TABLE_CONSTRAINT_STARTERS = new Set([
  'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'INDEX', 'KEY', 'FULLTEXT', 'SPATIAL', 'EXCLUDE', 'LIKE', 'PERIOD',
]);

const TYPE_WORDS = new Set([
  'INT', 'INTEGER', 'SMALLINT', 'BIGINT', 'TINYINT', 'MEDIUMINT', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'INT2', 'INT4',
  'INT8', 'NUMERIC', 'DECIMAL', 'DEC', 'FLOAT', 'REAL', 'DOUBLE', 'BOOLEAN', 'BOOL', 'CHAR', 'CHARACTER', 'VARCHAR',
  'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'BYTEA', 'BINARY',
  'VARBINARY', 'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIMETZ', 'INTERVAL', 'YEAR', 'JSON', 'JSONB',
  'UUID', 'ENUM', 'SET', 'BIT', 'MONEY', 'INET', 'INET6', 'CIDR', 'MACADDR', 'POINT', 'GEOMETRY', 'XML', 'TSVECTOR',
  'OID', 'FLOAT4', 'FLOAT8', 'NUMBER', 'NVARCHAR', 'NCHAR', 'CLOB', 'LONG', 'FIXED', 'CITEXT', 'HSTORE', 'ARRAY',
  // DuckDB
  'HUGEINT', 'UHUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'INT1', 'INT128', 'SHORT', 'SIGNED', 'STRING',
  'STRUCT', 'MAP', 'UNION', 'LIST', 'BITSTRING', 'VARINT', 'BIGNUM', 'TIMESTAMP_S', 'TIMESTAMP_MS', 'TIMESTAMP_NS', 'LOGICAL', 'BPCHAR',
]);

const ACTIONS: Record<string, ReferentialAction> = {
  CASCADE: 'CASCADE',
  RESTRICT: 'RESTRICT',
  'SET NULL': 'SET NULL',
  'SET DEFAULT': 'SET DEFAULT',
  'NO ACTION': 'NO ACTION',
};

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

class Parser {
  private pos = 0;
  readonly result: ParseResult & { routines: ParsedRoutine[] } = { tables: [], views: [], routines: [], extensions: [], enums: [], compositeTypes: [], errors: [], warnings: [], statementCount: 0 };

  constructor(private readonly sql: string, private readonly tokens: Token[], private readonly dialect: Dialect) {}

  /* ---------- token helpers ---------- */

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  private isWord(...words: string[]): boolean {
    const t = this.peek();
    return t.type === 'word' && words.includes(t.upper);
  }

  private isPunct(p: string, k = 0): boolean {
    const t = this.peek(k);
    return t.type === 'punct' && t.value === p;
  }

  private acceptWord(...words: string[]): Token | null {
    return this.isWord(...words) ? this.next() : null;
  }

  private acceptPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.next();
      return true;
    }
    return false;
  }

  private fail(message: string, t: Token = this.peek()): never {
    throw new SqlSyntaxError(message, t.line, t.col);
  }

  private expectWord(...words: string[]): Token {
    if (!this.isWord(...words)) this.fail(`Expected ${words.join(' or ')} but found ${this.describe(this.peek())}`);
    return this.next();
  }

  private expectPunct(p: string): Token {
    if (!this.isPunct(p)) this.fail(`Expected "${p}" but found ${this.describe(this.peek())}`);
    return this.next();
  }

  private describe(t: Token): string {
    if (t.type === 'eof') return 'end of input';
    if (t.type === 'string') return `string '${t.value}'`;
    return `"${t.value}"`;
  }

  private isIdent(t: Token = this.peek()): boolean {
    return t.type === 'word' || t.type === 'quoted';
  }

  private parseIdent(): string {
    const t = this.peek();
    if (t.type === 'quoted') {
      this.next();
      return t.value;
    }
    if (t.type === 'word') {
      this.next();
      // PostgreSQL folds unquoted identifiers to lower case.
      return this.dialect === 'postgresql' ? t.value.toLowerCase() : t.value;
    }
    return this.fail(`Expected an identifier but found ${this.describe(t)}`);
  }

  private parseQualifiedName(): { schema?: string; name: string } {
    const parts = [this.parseIdent()];
    while (this.isPunct('.')) {
      this.next();
      parts.push(this.parseIdent());
    }
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
    return { schema, name };
  }

  private warn(message: string, t: Token = this.peek()) {
    this.result.warnings.push({ message, line: t.line, col: t.col });
  }

  /** Skip tokens until a top-level (depth 0) token matching one of `stops`; does not consume it. */
  private skipUntil(stops: string[]): void {
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') return;
      if (t.type === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') {
          if (depth === 0 && stops.includes(')')) return;
          depth = Math.max(0, depth - 1);
        } else if (depth === 0 && stops.includes(t.value)) return;
      }
      this.next();
    }
  }

  private skipStatement(): void {
    this.skipUntil([';']);
    this.acceptPunct(';');
  }

  /** Consume a balanced parenthesised group and return the raw text inside it. */
  private parseParenRaw(): string {
    const open = this.expectPunct('(');
    let depth = 1;
    let last = open;
    while (depth > 0) {
      const t = this.next();
      if (t.type === 'eof') this.fail('Unbalanced parentheses', open);
      if (t.type === 'punct' && t.value === '(') depth++;
      if (t.type === 'punct' && t.value === ')') depth--;
      last = t;
    }
    return this.sql.slice(open.end, last.start).trim();
  }

  private skipBalancedIfParen(): void {
    if (this.isPunct('(')) this.parseParenRaw();
  }

  /** Raw expression text until a top-level ',' / ')' / ';' or a constraint keyword. */
  private parseExpressionRaw(stopWords: Set<string>): string {
    const first = this.peek();
    if (first.type === 'eof') this.fail('Expected an expression');
    let depth = 0;
    let last: Token | null = null;
    let count = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (t.type === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (t.value === ',' || t.value === ';')) break;
      }
      if (depth === 0 && t.type === 'word' && count > 0 && stopWords.has(t.upper)) {
        // "NOT NULL" ends the expression, but "IS NOT NULL" inside a CHECK does not; DEFAULT exprs are simple.
        break;
      }
      if (depth === 0 && t.type === 'word' && count === 0 && t.upper === 'NOT') break;
      this.next();
      last = t;
      count++;
    }
    if (!last) this.fail('Expected an expression', first);
    return this.sql.slice(first.start, last.end).trim();
  }

  /** A plain column reference: `a`, `a DESC`, `a(10)` (MariaDB prefix length) - not an expression. */
  private isSimpleListItem(): boolean {
    if (!this.isIdent()) return false;
    const n1 = this.peek(1);
    if (n1.type === 'punct' && (n1.value === ',' || n1.value === ')')) return true;
    if (n1.type === 'word') return true;
    if (n1.type === 'punct' && n1.value === '(') {
      const n2 = this.peek(2);
      const n3 = this.peek(3);
      return n2.type === 'number' && n3.type === 'punct' && n3.value === ')';
    }
    return false;
  }

  /** ( a, b(10) DESC, c ) -> ['a','b','c']; expression items are kept as raw text. */
  private parseColumnList(): string[] {
    const open = this.expectPunct('(');
    const cols: string[] = [];
    if (this.isPunct(')')) {
      this.next();
      return cols;
    }
    for (;;) {
      if (this.isSimpleListItem()) {
        const name = this.parseIdent();
        // prefix length / collation / direction noise
        if (this.isPunct('(')) this.parseParenRaw();
        while (this.peek().type === 'word') {
          const w = this.next();
          if (w.upper === 'COLLATE') this.next();
        }
        cols.push(name);
      } else {
        // an expression such as lower(email)
        const start = this.peek();
        let depth = 0;
        let last = start;
        while (!(depth === 0 && (this.isPunct(',') || this.isPunct(')')))) {
          const t = this.next();
          if (t.type === 'eof') this.fail('Unterminated column list', open);
          if (t.type === 'punct' && t.value === '(') depth++;
          if (t.type === 'punct' && t.value === ')') depth--;
          last = t;
        }
        cols.push(this.sql.slice(start.start, last.end).trim());
      }
      if (this.acceptPunct(',')) continue;
      this.expectPunct(')');
      return cols;
    }
  }

  /* ---------- statements ---------- */

  parse(): ParseResult {
    while (this.peek().type !== 'eof') {
      if (this.acceptPunct(';')) continue;
      const startTok = this.peek();
      this.result.statementCount++;
      try {
        this.parseStatement();
      } catch (e) {
        if (e instanceof SqlSyntaxError) {
          this.result.errors.push({ message: e.message, line: e.line, col: e.col });
          this.skipStatement();
        } else {
          throw e;
        }
      }
      if (this.peek() === startTok) this.skipStatement(); // safety: always make progress
    }
    return this.result;
  }

  private parseStatement(): void {
    const t = this.peek();
    if (t.type !== 'word') {
      this.warn(`Skipped unrecognised statement starting with ${this.describe(t)}`);
      this.skipStatement();
      return;
    }
    switch (t.upper) {
      case 'CREATE':
        this.parseCreate();
        return;
      case 'ALTER':
        this.parseAlter();
        return;
      case 'COMMENT':
        this.parseCommentOn();
        return;
      case 'INSTALL':
        this.parseInstall();
        return;
      case 'LOAD':
        this.parseLoad();
        return;
      case 'SET':
      case 'USE':
      case 'BEGIN':
      case 'START':
      case 'COMMIT':
      case 'LOCK':
      case 'UNLOCK':
      case 'SELECT':
      case 'PRAGMA':
        this.skipStatement();
        return;
      case 'DROP':
        this.skipStatement();
        return;
      default:
        this.warn(`Skipped ${t.value.toUpperCase()} statement (only CREATE TABLE / VIEW / INDEX / TYPE / EXTENSION / PROCEDURE / FUNCTION, ALTER TABLE, COMMENT ON and INSTALL / LOAD are imported)`);
        this.skipStatement();
    }
  }

  private parseCreate(): void {
    const start = this.expectWord('CREATE');
    if (this.acceptWord('OR')) this.expectWord('REPLACE');
    let unique = false;
    let materialized = false;
    for (;;) {
      if (this.isWord('TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'UNIQUE', 'MATERIALIZED', 'RECURSIVE')) {
        const w = this.next().upper;
        if (w === 'UNIQUE') unique = true;
        if (w === 'MATERIALIZED') materialized = true;
        continue;
      }
      // MariaDB view prefixes: ALGORITHM = MERGE, DEFINER = user@host, SQL SECURITY DEFINER
      if (this.isWord('ALGORITHM', 'DEFINER')) {
        this.next();
        this.acceptPunct('=');
        this.next();
        while (this.isPunct('@')) {
          this.next();
          this.next();
        }
        continue;
      }
      if (this.isWord('SQL') && this.peek(1).type === 'word' && this.peek(1).upper === 'SECURITY') {
        this.next();
        this.next();
        this.next();
        continue;
      }
      break;
    }
    if (this.isWord('TABLE')) {
      this.parseCreateTable();
      return;
    }
    if (this.isWord('VIEW')) {
      this.parseCreateView(materialized);
      return;
    }
    if (this.isWord('INDEX')) {
      this.parseCreateIndex(unique);
      return;
    }
    if (this.isWord('TYPE')) {
      this.parseCreateType();
      return;
    }
    if (this.isWord('EXTENSION')) {
      this.parseCreateExtension();
      return;
    }
    if (this.isWord('PROCEDURE', 'FUNCTION')) {
      this.parseCreateRoutine();
      return;
    }
    if (this.isWord('SEQUENCE')) {
      // A sequence is how PostgreSQL (pg_dump) and DuckDB spell an auto-increment
      // column; the column's nextval() default is what the diagram records.
      this.next();
      const name = this.isIdent() || this.isWord('IF') ? (this.acceptWord('IF') ? (this.expectWord('NOT'), this.expectWord('EXISTS'), this.parseQualifiedName().name) : this.parseQualifiedName().name) : '';
      this.warn(`CREATE SEQUENCE ${name} is not imported on its own: the column whose default reads nextval() from it is marked auto-increment instead`, start);
      this.skipStatement();
      return;
    }
    const what = this.peek().type === 'word' ? this.peek().upper : '?';
    this.warn(`Skipped CREATE ${what} statement`, start);
    this.skipStatement();
  }

  /** True at a top-level WITH that starts `WITH [CASCADED|LOCAL] CHECK OPTION`. */
  private atCheckOption(): boolean {
    if (!this.isWord('WITH')) return false;
    const n1 = this.peek(1);
    if (n1.type !== 'word') return false;
    if (n1.upper === 'CHECK') return true;
    return (n1.upper === 'CASCADED' || n1.upper === 'LOCAL') && this.peek(2).type === 'word' && this.peek(2).upper === 'CHECK';
  }

  /** Words that cannot start a table reference after FROM / JOIN. */
  private static readonly NOT_A_TABLE = new Set([
    'SELECT', 'WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'LEFT', 'RIGHT',
    'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'WITH', 'AS', 'AND', 'OR', 'NOT', 'CASE', 'WHEN', 'VALUES', 'WINDOW', 'FETCH', 'FOR',
  ]);

  /** Consume `[schema.]table [alias]` after FROM / JOIN and record the reference. Returns false when there is none (subquery, function). */
  private readTableRef(sources: string[], aliases?: Map<string, string>): boolean {
    this.acceptWord('ONLY', 'LATERAL');
    const t = this.peek();
    if (!this.isIdent(t)) return false;
    if (t.type === 'word' && Parser.NOT_A_TABLE.has(t.upper)) return false;
    if (this.isPunct('(', 1)) return false; // function call
    const { schema, name } = this.parseQualifiedName();
    const full = schema ? `${schema}.${name}` : name;
    if (!sources.includes(full)) sources.push(full);
    // optional alias
    if (this.acceptWord('AS')) {
      if (this.isIdent()) aliases?.set(this.next().value.toLowerCase(), full);
    } else if (this.isIdent() && !(this.peek().type === 'word' && Parser.NOT_A_TABLE.has(this.peek().upper))) {
      aliases?.set(this.next().value.toLowerCase(), full);
    }
    return true;
  }

  private parseCreateView(materialized: boolean): void {
    const start = this.expectWord('VIEW');
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    const { schema, name } = this.parseQualifiedName();
    const columns = this.isPunct('(') ? this.parseColumnList() : [];
    if (this.isWord('WITH') && this.isPunct('(', 1)) {
      this.next();
      this.parseParenRaw();
    }
    if (!this.isWord('AS')) {
      this.warn(`Skipped CREATE VIEW ${name}: expected AS`, start);
      this.skipStatement();
      return;
    }
    this.next();
    const first = this.peek();
    const bodyPos = this.pos;
    const sources: string[] = [];
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (t.type === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') depth = Math.max(0, depth - 1);
        else if (t.value === ';' && depth === 0) break;
      }
      if (depth === 0 && this.atCheckOption()) break;
      if (t.type === 'word' && (t.upper === 'FROM' || t.upper === 'JOIN')) {
        this.next();
        if (this.readTableRef(sources) && t.upper === 'FROM') {
          while (this.isPunct(',')) {
            this.next();
            if (!this.readTableRef(sources)) break;
          }
        }
        continue;
      }
      this.next();
    }
    const bodyEnd = this.pos;
    // Work out the column types now, so a later CREATE TABLE ... AS SELECT can read from this view.
    if (first.type === 'word' && first.upper === 'SELECT') {
      const warnings = this.result.warnings.length;
      this.pos = bodyPos;
      try {
        const cols = this.deriveColumns(`View ${name}`, columns);
        if (cols.length) this.viewColumns.set(name.toLowerCase(), cols);
      } catch {
        // best effort: the view is still recorded below
      }
      this.pos = bodyEnd;
      this.result.warnings.length = warnings; // a view's own untyped columns are not an import problem
    }
    const last = this.tokens[this.pos - 1];
    const sql = last && last.end > first.start ? this.sql.slice(first.start, last.end).trim() : '';
    this.skipStatement();
    if (!sql) {
      this.warn(`CREATE VIEW ${name} has no SELECT body`, start);
      return;
    }
    const existing = this.result.views.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
    if (existing !== -1) this.result.views.splice(existing, 1);
    this.result.views.push({ schema, name, columns, sql, sources, materialized: materialized || undefined });
  }

  /** Words that describe a routine between its parameter list and its body, on either engine. */
  private static readonly ROUTINE_CHARACTERISTICS = new Set([
    // PostgreSQL
    'IMMUTABLE', 'STABLE', 'VOLATILE', 'STRICT', 'CALLED', 'EXTERNAL', 'SECURITY', 'PARALLEL', 'COST', 'ROWS', 'SUPPORT', 'LEAKPROOF', 'WINDOW', 'TRANSFORM',
    // MariaDB
    'ON', 'NULL', 'INPUT', 'SAFE', 'UNSAFE', 'RESTRICTED',
    // MariaDB
    'DETERMINISTIC', 'NOT', 'CONTAINS', 'NO', 'READS', 'MODIFIES', 'SQL', 'DATA', 'INVOKER', 'DEFINER',
  ]);

  /** Where a RETURNS clause ends: the next characteristic, the body, or the end of the statement. */
  private static readonly AFTER_RETURNS = new Set([...Parser.ROUTINE_CHARACTERISTICS, 'LANGUAGE', 'AS', 'BEGIN', 'RETURN', 'COMMENT', 'SET', 'CHARSET', 'COLLATE']);

  /**
   * CREATE [OR REPLACE] PROCEDURE | FUNCTION name (params) … body.
   *
   * PostgreSQL puts the body in a string after AS (dollar-quoted, as a rule),
   * or since version 14 writes it inline as BEGIN ATOMIC … END or RETURN expr.
   * MariaDB writes it inline: one statement, or a BEGIN … END compound whose
   * semicolons are why a script moves the DELIMITER first (parseSql undoes
   * that before this ever sees the tokens). The inline forms are found by
   * counting blocks: BEGIN and CASE open one, END closes one, and END IF,
   * END LOOP, END WHILE, END REPEAT and END FOR close control flow whose
   * opening word was never counted.
   */
  private parseCreateRoutine(): void {
    const kw = this.next();
    const kind: ParsedRoutine['kind'] = kw.upper === 'FUNCTION' ? 'function' : 'procedure';
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    const { schema, name } = this.parseQualifiedName();
    const params = this.isPunct('(') ? parseRoutineParams(this.parseParenRaw(), this.dialect === 'postgresql') : [];
    let returns: string | undefined;
    let language: string | undefined;
    let body: string | undefined;
    let comment: string | undefined;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof' || (t.type === 'punct' && t.value === ';')) break;
      if (this.acceptWord('RETURNS')) {
        // RETURNS NULL ON NULL INPUT is PostgreSQL's STRICT, not a return type.
        if (this.isWord('NULL')) continue;
        const first = this.peek();
        let last: Token | null = null;
        let depth = 0;
        for (;;) {
          const x = this.peek();
          if (x.type === 'eof') break;
          if (x.type === 'punct') {
            if (x.value === '(') depth++;
            else if (x.value === ')') depth--;
            else if (x.value === ';' && depth === 0) break;
          }
          if (depth === 0 && last && ((x.type === 'word' && Parser.AFTER_RETURNS.has(x.upper)) || x.type === 'string')) break;
          last = this.next();
        }
        if (last) returns = this.sql.slice(first.start, last.end).trim();
        continue;
      }
      if (this.acceptWord('LANGUAGE')) {
        const l = this.next().value.toLowerCase();
        // MariaDB's LANGUAGE SQL is the only language it has, and says nothing.
        if (this.dialect === 'postgresql') language = l;
        continue;
      }
      if (this.acceptWord('AS')) {
        const b = this.next();
        if (b.type === 'string') body = b.value;
        // AS 'obj_file', 'link_symbol': a C function; the second string names the symbol.
        if (this.acceptPunct(',')) this.next();
        continue;
      }
      if (this.acceptWord('COMMENT')) {
        this.acceptPunct('=');
        const c = this.next();
        if (c.type === 'string') comment = c.value;
        continue;
      }
      if (this.isWord('SET') && this.dialect === 'postgresql') {
        // SET configuration_parameter { TO | = } value | FROM CURRENT
        this.next();
        this.skipUntil([';']);
        break;
      }
      if (t.type === 'word' && t.upper === 'BEGIN') {
        body = this.readBlock();
        break;
      }
      // A labelled compound statement: `main: BEGIN … END main`.
      if (this.isIdent(t) && this.isPunct(':', 1) && this.peek(2).type === 'word' && this.peek(2).upper === 'BEGIN') {
        const label = this.next();
        this.next();
        const block = this.readBlock();
        body = `${label.value}: ${block}`;
        if (this.isIdent() && this.peek().value.toLowerCase() === label.value.toLowerCase()) body += ` ${this.next().value}`;
        break;
      }
      if (t.type === 'word' && Parser.ROUTINE_CHARACTERISTICS.has(t.upper)) {
        this.next();
        // COST 100, ROWS 1000
        if (this.peek().type === 'number') this.next();
        continue;
      }
      // Anything else starts a single-statement body (MariaDB, or PostgreSQL's RETURN expr).
      const first = this.peek();
      this.skipUntil([';']);
      const last = this.tokens[this.pos - 1];
      body = last && last.end > first.start ? this.sql.slice(first.start, last.end).trim() : '';
      break;
    }
    this.skipStatement();
    if (body === undefined) {
      this.warn(`CREATE ${kw.upper} ${name} has no body, so it was skipped`, kw);
      return;
    }
    const existing = this.result.routines.findIndex((r) => r.name.toLowerCase() === name.toLowerCase() && (r.schema ?? '') === (schema ?? ''));
    if (existing !== -1) this.result.routines.splice(existing, 1);
    this.result.routines.push({
      ...(schema ? { schema } : {}),
      name,
      kind,
      params,
      ...(kind === 'function' && returns ? { returns } : {}),
      ...(language ? { language } : {}),
      body,
      ...(comment ? { comment } : {}),
    });
  }

  /** BEGIN … END with everything nested inside it, as raw text; consumes it. */
  private readBlock(): string {
    const first = this.expectWord('BEGIN');
    let depth = 1;
    let last = first;
    while (depth > 0) {
      const t = this.next();
      if (t.type === 'eof') this.fail('BEGIN without a matching END', first);
      last = t;
      if (t.type !== 'word') continue;
      if (t.upper === 'BEGIN' || t.upper === 'CASE') depth++;
      else if (t.upper === 'END') {
        const n = this.peek();
        if (n.type === 'word' && ['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(n.upper)) {
          last = this.next();
          continue;
        }
        if (n.type === 'word' && n.upper === 'CASE') last = this.next();
        depth--;
      }
    }
    return this.sql.slice(first.start, last.end);
  }

  private parseCreateTable(): void {
    this.expectWord('TABLE');
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    const { schema, name } = this.parseQualifiedName();
    const table: ParsedTable = { schema, name, columns: [], primaryKey: [], uniques: [], indexes: [], checks: [], foreignKeys: [] };

    if (this.isWord('AS') || (this.isPunct('(') && this.isColumnListThenAs())) {
      this.parseCreateTableAs(table);
      return;
    }

    if (!this.isPunct('(')) {
      this.warn(`Skipped CREATE TABLE ${name}: only column-list definitions are supported (not AS SELECT / PARTITION OF / LIKE)`);
      this.skipStatement();
      return;
    }
    this.expectPunct('(');
    if (!this.isPunct(')')) {
      for (;;) {
        this.parseTableItem(table);
        if (this.acceptPunct(',')) continue;
        break;
      }
    }
    this.expectPunct(')');

    // table options up to ';'
    while (this.peek().type !== 'eof' && !this.isPunct(';')) {
      if (this.isWord('COMMENT')) {
        this.next();
        this.acceptPunct('=');
        const s = this.next();
        if (s.type === 'string') table.comment = s.value;
        continue;
      }
      if (this.isPunct('(')) {
        this.parseParenRaw();
        continue;
      }
      this.next();
    }
    this.acceptPunct(';');

    // A column-level PRIMARY KEY becomes the table PK if none was declared.
    if (table.primaryKey.length === 0) {
      table.primaryKey = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    }
    for (const c of table.columns) {
      if (table.primaryKey.includes(c.name)) {
        c.primaryKey = true;
        c.nullable = false;
      }
    }
    // Single-column UNIQUE constraints collapse onto the column.
    table.uniques = table.uniques.filter((u) => {
      if (u.columns.length === 1) {
        const c = table.columns.find((col) => col.name === u.columns[0]);
        if (c) {
          c.unique = true;
          return false;
        }
      }
      return true;
    });

    const existing = this.findTable(table.name, table.schema);
    if (existing) {
      this.warn(`Table ${table.name} is defined more than once; the later definition replaces the earlier one`);
      this.result.tables.splice(this.result.tables.indexOf(existing), 1);
    }
    this.result.tables.push(table);
  }

  /** At `(`: is this `(a, b, c) AS …` (CTAS with renamed columns) rather than a column-definition list? */
  private isColumnListThenAs(): boolean {
    let depth = 0;
    for (let k = 0; ; k++) {
      const t = this.peek(k);
      if (t.type === 'eof') return false;
      if (t.type === 'punct' && t.value === '(') depth++;
      else if (t.type === 'punct' && t.value === ')' && --depth === 0) {
        const n = this.peek(k + 1);
        return n.type === 'word' && n.upper === 'AS';
      } else if (depth === 1 && t.type === 'word' && k > 0 && this.peek(k - 1).type === 'word' && !(this.peek(k - 1).upper === 'AS')) {
        return false; // "name type" – a real column definition
      }
    }
  }

  /**
   * CREATE TABLE name [(cols)] AS SELECT … : the columns come from the select list.
   * See `deriveColumns` for how each column's type is found.
   */
  private parseCreateTableAs(table: ParsedTable): void {
    const renamed = this.isPunct('(') ? this.parseColumnList() : [];
    this.expectWord('AS');
    const sel = this.peek();
    if (!(sel.type === 'word' && sel.upper === 'SELECT')) {
      this.warn(`Skipped CREATE TABLE ${table.name}: only AS SELECT is supported after AS`, sel);
      this.skipStatement();
      return;
    }
    const cols = this.deriveColumns(table.name, renamed);
    this.skipStatement();
    table.columns.push(...cols);

    const existing = this.findTable(table.name, table.schema);
    if (existing) {
      this.warn(`Table ${table.name} is defined more than once; the later definition replaces the earlier one`);
      this.result.tables.splice(this.result.tables.indexOf(existing), 1);
    }
    this.result.tables.push(table);
  }

  /** Columns (with types) of each view seen so far, worked out from its SELECT; keyed by lower-cased name. */
  private readonly viewColumns = new Map<string, ParsedColumn[]>();

  /** The columns of a table or view defined earlier in the script, by (optionally schema-qualified) name. */
  private relationColumns(ref: string): ParsedColumn[] | undefined {
    const dot = ref.lastIndexOf('.');
    const name = ref.slice(dot + 1);
    const t = this.findTable(name, dot === -1 ? undefined : ref.slice(0, dot));
    return t?.columns ?? this.viewColumns.get(name.toLowerCase());
  }

  /**
   * Read a SELECT at the cursor (up to the end of the statement, not consumed)
   * and return one column per select-list item.
   *
   * A column's type is, in order: the type of the source column it copies (a
   * table or view defined earlier in the script), else whatever its expression
   * pins down (`::type`, CAST, coalesce / CASE branches, comparisons, literals,
   * count / row_number), else `text` with a warning.
   */
  private deriveColumns(owner: string, renamed: string[]): ParsedColumn[] {
    const sel = this.expectWord('SELECT');
    this.acceptWord('DISTINCT', 'ALL');

    // 1. split the select list on top-level commas
    const items: Token[][] = [[]];
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (t.type === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0 && t.value === ';') break;
        else if (depth === 0 && t.value === ',') {
          this.next();
          items.push([]);
          continue;
        }
      }
      if (depth === 0 && t.type === 'word' && ['FROM', 'UNION', 'INTERSECT', 'EXCEPT', 'WHERE', 'LIMIT'].includes(t.upper)) break;
      items[items.length - 1].push(this.next());
    }

    // 2. the rest of the statement: which relations it reads, under which aliases
    const sources: string[] = [];
    const aliases = new Map<string, string>();
    depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (t.type === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') depth = Math.max(0, depth - 1);
        else if (t.value === ';' && depth === 0) break;
      }
      if (t.type === 'word' && (t.upper === 'FROM' || t.upper === 'JOIN')) {
        this.next();
        if (this.readTableRef(sources, aliases) && t.upper === 'FROM') {
          while (this.isPunct(',')) {
            this.next();
            if (!this.readTableRef(sources, aliases)) break;
          }
        }
        continue;
      }
      this.next();
    }

    const sourceCols = sources.map((s) => this.relationColumns(s)).filter((x): x is ParsedColumn[] => !!x);
    const scopeOf = (qualifier: string | undefined): ParsedColumn[][] => {
      if (!qualifier) return sourceCols;
      const cols = this.relationColumns(aliases.get(qualifier.toLowerCase()) ?? qualifier);
      return cols ? [cols] : [];
    };
    const lookup = (qualifier: string | undefined, col: string): ParsedColumn | undefined => {
      for (const cols of scopeOf(qualifier)) {
        const c = cols.find((x) => x.name.toLowerCase() === col.toLowerCase());
        if (c) return c;
      }
      return undefined;
    };

    // 3. one column per select item
    const out: ParsedColumn[] = [];
    const guessed: string[] = [];
    const push = (col: ParsedColumn) => {
      if (out.some((c) => c.name === col.name)) this.warn(`${owner}: column ${col.name} appears twice in the select list`, sel);
      else out.push(col);
    };
    for (const item of items) {
      if (item.length === 0) continue;
      // trailing alias: `AS x` or a bare identifier after an expression
      let alias: string | undefined;
      let expr = item;
      const last = item[item.length - 1];
      const before = item[item.length - 2];
      if (before && before.type === 'word' && before.upper === 'AS' && this.isIdent(last)) {
        alias = this.identText(last);
        expr = item.slice(0, -2);
      } else if (
        item.length >= 2 &&
        this.isIdent(last) &&
        !(last.type === 'word' && (Parser.NOT_A_TABLE.has(last.upper) || last.upper === 'END' || last.upper === 'NULL')) &&
        !(before.type === 'punct' && (before.value === '.' || before.value === '::')) &&
        !(before.type === 'word' && ['DISTINCT', 'NOT', 'IS', 'AND', 'OR', 'THEN', 'ELSE', 'WHEN', 'BY', 'DESC', 'ASC'].includes(before.upper)) &&
        !(before.type === 'punct' && before.value !== ')' && before.value !== ']')
      ) {
        alias = this.identText(last);
        expr = item.slice(0, -1);
      }
      // plain [qualifier.]column, or `*` / `q.*`
      const isRef = expr.every((t, i) => (i % 2 === 0 ? this.isIdent(t) || (t.type === 'punct' && t.value === '*') : t.type === 'punct' && t.value === '.'));
      const refName = isRef ? expr[expr.length - 1] : undefined;
      if (refName && refName.type === 'punct') {
        const scope = scopeOf(expr.length === 3 ? this.identText(expr[0]) : undefined);
        if (scope.length === 0) this.warn(`${owner}: SELECT * from a relation that is not defined in this script; columns not imported`, sel);
        for (const cols of scope) for (const c of cols) push({ ...c, primaryKey: false, unique: false, autoIncrement: false, references: undefined, check: undefined });
        continue;
      }
      const qualifier = isRef && expr.length === 3 ? this.identText(expr[0]) : undefined;
      const name = alias ?? (refName ? this.identText(refName) : undefined);
      if (!name) {
        this.warn(`${owner}: a select-list expression has no alias, so it was skipped`, item[0]);
        continue;
      }
      const src = refName ? lookup(qualifier, this.identText(refName)) : undefined;
      let type = src?.type ?? this.inferType(expr, lookup);
      if (!type) {
        type = 'text';
        guessed.push(name);
      }
      push({ name, type, nullable: src ? src.nullable : true, primaryKey: false, unique: false, autoIncrement: false });
    }
    renamed.forEach((n, i) => {
      if (out[i]) out[i].name = n;
    });
    if (guessed.length) this.warn(`${owner}: could not infer a type for ${guessed.join(', ')}; using text`, sel);
    return out;
  }

  private identText(t: Token): string {
    return t.type === 'word' && this.dialect === 'postgresql' ? t.value.toLowerCase() : t.value;
  }

  /** Split tokens on top-level commas. */
  private static splitArgs(toks: Token[]): Token[][] {
    const args: Token[][] = [[]];
    let d = 0;
    for (const t of toks) {
      if (t.type === 'punct' && t.value === '(') d++;
      else if (t.type === 'punct' && t.value === ')') d--;
      if (d === 0 && t.type === 'punct' && t.value === ',') args.push([]);
      else args[args.length - 1].push(t);
    }
    return args;
  }

  /** The type of a select-list expression, when its shape pins one down. */
  private inferType(expr: Token[], lookup: (q: string | undefined, col: string) => ParsedColumn | undefined): string | undefined {
    if (expr.length === 0) return undefined;
    const isP = (t: Token | undefined, v: string) => t?.type === 'punct' && t.value === v;

    // The type named by a `::type` (first top-level one) or CAST(… AS type).
    const readType = (from: number): string | undefined => {
      const words: string[] = [];
      for (let i = from; i < expr.length; i++) {
        const t = expr[i];
        if (t.type === 'word') words.push(t.upper);
        else if (isP(t, '(') && words.length) {
          let d = 0;
          let j = i;
          for (; j < expr.length; j++) {
            if (isP(expr[j], '(')) d++;
            if (isP(expr[j], ')') && --d === 0) break;
          }
          words[words.length - 1] += this.sql.slice(t.start, expr[Math.min(j, expr.length - 1)].end);
          i = j;
        } else break;
      }
      return words.length ? words.join(' ') : undefined;
    };
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      if (isP(expr[i], '(')) depth++;
      else if (isP(expr[i], ')')) depth--;
      else if (depth === 0 && isP(expr[i], '::')) return readType(i + 1);
    }
    const head = expr[0].type === 'word' ? expr[0].upper : '';
    if (head === 'CAST' && isP(expr[1], '(')) {
      let d = 0;
      for (let i = 1; i < expr.length; i++) {
        if (isP(expr[i], '(')) d++;
        else if (isP(expr[i], ')')) d--;
        else if (d === 1 && expr[i].type === 'word' && expr[i].upper === 'AS') return readType(i + 1);
      }
      return undefined;
    }

    // Whole expression is one function call: f( … )
    if (expr[0].type === 'word' && isP(expr[1], '(')) {
      let d = 0;
      let close = -1;
      for (let i = 1; i < expr.length; i++) {
        if (isP(expr[i], '(')) d++;
        else if (isP(expr[i], ')') && --d === 0) {
          close = i;
          break;
        }
      }
      const wholeCall = close === expr.length - 1 || (expr[close + 1]?.type === 'word' && expr[close + 1].upper === 'OVER');
      if (close !== -1 && wholeCall) {
        if (['COUNT', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE'].includes(head)) return 'BIGINT';
        if (['COALESCE', 'NULLIF', 'IFNULL', 'GREATEST', 'LEAST'].includes(head)) {
          for (const arg of Parser.splitArgs(expr.slice(2, close))) {
            const ty = this.inferType(arg, lookup);
            if (ty) return ty;
          }
        }
        if (['EXISTS'].includes(head)) return 'BOOLEAN';
        return undefined;
      }
    }
    // A parenthesised whole expression
    if (isP(expr[0], '(') && isP(expr[expr.length - 1], ')')) {
      let d = 0;
      let wraps = true;
      for (let i = 0; i < expr.length - 1; i++) {
        if (isP(expr[i], '(')) d++;
        else if (isP(expr[i], ')') && --d === 0) wraps = false;
      }
      if (wraps) return this.inferType(expr.slice(1, -1), lookup);
    }

    // CASE: the type of the first THEN / ELSE branch that has one
    if (head === 'CASE') {
      const branches: Token[][] = [];
      let d = 0;
      let cur: Token[] | null = null;
      for (let i = 1; i < expr.length; i++) {
        const t = expr[i];
        if (isP(t, '(')) d++;
        else if (isP(t, ')')) d--;
        const kw = d === 0 && t.type === 'word' ? t.upper : '';
        if (kw === 'THEN' || kw === 'ELSE') {
          cur = [];
          branches.push(cur);
        } else if (kw === 'WHEN' || kw === 'END') cur = null;
        else if (cur) cur.push(t);
      }
      for (const b of branches) {
        const ty = this.inferType(b, lookup);
        if (ty) return ty;
      }
      return undefined;
    }

    // A single literal, or a reference to a column we know
    if (expr.length === 1) {
      const t = expr[0];
      if (t.type === 'string') return 'TEXT';
      if (t.type === 'number') return /[.eE]/.test(t.value) ? 'NUMERIC' : 'INT';
      if (t.type === 'word' && (t.upper === 'TRUE' || t.upper === 'FALSE')) return 'BOOLEAN';
    }
    if ((expr.length === 1 && this.isIdent(expr[0])) || (expr.length === 3 && this.isIdent(expr[0]) && isP(expr[1], '.') && this.isIdent(expr[2]))) {
      const known = lookup(expr.length === 3 ? this.identText(expr[0]) : undefined, this.identText(expr[expr.length - 1]));
      if (known) return known.type;
    }

    // A top-level comparison / logical operator makes the whole expression a boolean
    depth = 0;
    for (const t of expr) {
      if (isP(t, '(')) depth++;
      else if (isP(t, ')')) depth--;
      else if (depth === 0 && t.type === 'punct' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.value)) return 'BOOLEAN';
      else if (depth === 0 && t.type === 'word' && ['AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN'].includes(t.upper)) return 'BOOLEAN';
    }
    return undefined;
  }

  private looksLikeTableConstraint(): boolean {
    const t = this.peek();
    if (t.type !== 'word' || !TABLE_CONSTRAINT_STARTERS.has(t.upper)) return false;
    if (t.upper === 'KEY' || t.upper === 'INDEX' || t.upper === 'UNIQUE' || t.upper === 'CHECK' || t.upper === 'LIKE') {
      const n1 = this.peek(1);
      if (n1.type === 'punct' && n1.value === '(') return true;
      if (n1.type === 'word' && TYPE_WORDS.has(n1.upper)) return false; // e.g. a column named `key`
      if (n1.type === 'word' && (n1.upper === 'KEY' || n1.upper === 'INDEX')) return true;
      if (this.isIdent(n1)) {
        const n2 = this.peek(2);
        if (n2.type === 'punct' && n2.value === '(') return true;
        if (n2.type === 'word' && n2.upper === 'USING') return true;
        return false;
      }
      return false;
    }
    return true;
  }

  private parseTableItem(table: ParsedTable): void {
    if (this.looksLikeTableConstraint()) {
      this.parseTableConstraint(table, [',', ')']);
      return;
    }
    table.columns.push(this.parseColumnDef());
  }

  /* ---------- column definitions ---------- */

  private parseType(): string {
    const words: string[] = [];
    let args: string | null = null;
    // A DuckDB STRUCT(...) / MAP(...) / UNION(...) keeps its body verbatim: the
    // field names inside are identifiers, not something to upper-case.
    let nested = false;
    let arraySuffix = '';
    for (;;) {
      const t = this.peek();
      if (t.type === 'word') {
        const u = t.upper;
        if (u === 'CHARACTER' && this.peek(1).type === 'word' && this.peek(1).upper === 'SET') break;
        if ((u === 'WITH' || u === 'WITHOUT') && this.peek(1).type === 'word' && this.peek(1).upper === 'TIME') {
          this.next();
          this.expectWord('TIME');
          this.expectWord('ZONE');
          words.push(u, 'TIME', 'ZONE');
          continue;
        }
        if (CONSTRAINT_STARTERS.has(u) && words.length > 0) break;
        if (words.length > 0 && (args !== null || nested) && !/^(UNSIGNED|SIGNED|ZEROFILL|ARRAY|PRECISION|VARYING|BINARY)$/.test(u)) break;
        if (words.length === 0 && /^(STRUCT|MAP|UNION)$/.test(u) && this.isPunct('(', 1)) {
          this.next();
          const body = this.parseParenRaw().replace(/\s+/g, ' ');
          words.push(`${u}(${body})`);
          nested = true;
          continue;
        }
        this.next();
        words.push(u);
        continue;
      }
      if (t.type === 'quoted' && words.length === 0) {
        // quoted type name such as "MyEnum"
        this.next();
        words.push(t.value);
        continue;
      }
      if (t.type === 'punct' && t.value === '(' && words.length > 0 && args === null && !nested) {
        args = this.parseTypeArgs();
        continue;
      }
      if (t.type === 'punct' && t.value === '[' && words.length > 0) {
        // PostgreSQL arrays and DuckDB lists are `type[]`; DuckDB's fixed-size ARRAY is `type[n]`.
        this.next();
        let size = '';
        if (this.peek().type === 'number') size = this.next().value;
        this.expectPunct(']');
        arraySuffix += `[${size}]`;
        continue;
      }
      break;
    }
    if (words.length === 0) this.fail(`Expected a column type but found ${this.describe(this.peek())}`);
    return words.join(' ') + (args !== null ? `(${args})` : '') + arraySuffix;
  }

  /** Normalised argument text: NUMERIC(10, 2) -> "10,2", ENUM('a', 'b') -> "'a','b'". */
  private parseTypeArgs(): string {
    const open = this.expectPunct('(');
    const parts: string[] = [];
    let cur = '';
    let depth = 0;
    let prevType: string | null = null;
    for (;;) {
      const t = this.next();
      if (t.type === 'eof') this.fail('Unbalanced parentheses in type', open);
      if (t.type === 'punct' && t.value === ')' && depth === 0) break;
      if (t.type === 'punct' && t.value === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        prevType = null;
        continue;
      }
      if (t.type === 'punct' && t.value === '(') depth++;
      if (t.type === 'punct' && t.value === ')') depth--;
      const text = t.type === 'string' ? `'${t.value.replace(/'/g, "''")}'` : t.type === 'word' ? t.value.toUpperCase() : t.value;
      if (prevType && prevType !== 'punct' && t.type !== 'punct') cur += ' ';
      cur += text;
      prevType = t.type;
    }
    parts.push(cur.trim());
    return parts.filter((p) => p.length > 0).join(',');
  }

  private parseColumnDef(): ParsedColumn {
    const name = this.parseIdent();
    const type = this.parseType();
    const col: ParsedColumn = { name, type, nullable: true, primaryKey: false, unique: false, autoIncrement: false };
    if (/^(SERIAL|BIGSERIAL|SMALLSERIAL)$/.test(type)) {
      col.autoIncrement = true;
      col.nullable = false;
      col.type = type === 'SERIAL' ? 'INTEGER' : type === 'BIGSERIAL' ? 'BIGINT' : 'SMALLINT';
    }
    let pendingName: string | undefined;
    const stop = new Set([...CONSTRAINT_STARTERS, 'NULL']);

    for (;;) {
      const t = this.peek();
      if (t.type !== 'word') break;
      switch (t.upper) {
        case 'CONSTRAINT':
          this.next();
          pendingName = this.parseIdent();
          continue;
        case 'NOT':
          this.next();
          if (this.acceptWord('DEFERRABLE')) continue;
          this.expectWord('NULL');
          col.nullable = false;
          continue;
        case 'NULL':
          this.next();
          col.nullable = true;
          continue;
        case 'PRIMARY':
          this.next();
          this.expectWord('KEY');
          col.primaryKey = true;
          col.nullable = false;
          continue;
        case 'KEY':
          this.next();
          col.primaryKey = true;
          col.nullable = false;
          continue;
        case 'UNIQUE':
          this.next();
          this.acceptWord('KEY');
          col.unique = true;
          continue;
        case 'DEFAULT':
          this.next();
          col.defaultValue = this.parseExpressionRaw(stop);
          continue;
        case 'REFERENCES':
          this.next();
          col.references = this.parseReferencesClause(pendingName);
          pendingName = undefined;
          continue;
        case 'CHECK':
          this.next();
          col.check = this.parseParenRaw();
          while (this.isWord('NOT', 'NO')) {
            this.next();
            this.next(); // NOT ENFORCED / NO INHERIT
          }
          continue;
        case 'AUTO_INCREMENT':
        case 'AUTOINCREMENT':
          this.next();
          col.autoIncrement = true;
          continue;
        case 'GENERATED': {
          this.next();
          if (this.acceptWord('ALWAYS')) {
            /* ok */
          } else if (this.acceptWord('BY')) {
            this.expectWord('DEFAULT');
          }
          this.expectWord('AS');
          if (this.acceptWord('IDENTITY')) {
            col.autoIncrement = true;
            this.skipBalancedIfParen();
          } else if (this.isPunct('(')) {
            const expr = this.parseParenRaw();
            this.acceptWord('STORED', 'VIRTUAL', 'PERSISTENT');
            this.warn(`Generated expression on ${name} (${expr}) is not modelled and was dropped`, t);
          }
          continue;
        }
        case 'AS': {
          this.next();
          const expr = this.parseParenRaw();
          this.acceptWord('STORED', 'VIRTUAL', 'PERSISTENT');
          this.warn(`Generated expression on ${name} (${expr}) is not modelled and was dropped`, t);
          continue;
        }
        case 'COLLATE':
          this.next();
          this.next();
          continue;
        case 'CHARACTER':
          this.next();
          this.expectWord('SET');
          this.next();
          continue;
        case 'CHARSET':
          this.next();
          this.next();
          continue;
        case 'COMMENT': {
          this.next();
          const s = this.next();
          if (s.type === 'string') col.comment = s.value;
          continue;
        }
        case 'ON':
          this.next();
          this.expectWord('UPDATE');
          this.parseExpressionRaw(stop);
          continue;
        case 'INVISIBLE':
        case 'VISIBLE':
          this.next();
          continue;
        case 'DEFERRABLE':
          this.next();
          continue;
        case 'INITIALLY':
          this.next();
          this.next();
          continue;
        case 'FIRST':
          this.next();
          continue;
        case 'AFTER':
          this.next();
          this.parseIdent();
          continue;
        case 'STORAGE':
        case 'COMPRESSION':
        case 'ENCODE':
          this.next();
          this.next();
          continue;
        default:
          break;
      }
      break;
    }
    return col;
  }

  private parseReferencesClause(name?: string): ParsedReference {
    const { schema, name: refTable } = this.parseQualifiedName();
    const refColumns = this.isPunct('(') ? this.parseColumnList() : [];
    const ref: ParsedReference = { name, refSchema: schema, refTable, refColumns, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };
    for (;;) {
      if (this.acceptWord('MATCH')) {
        this.next();
        continue;
      }
      if (this.isWord('ON') && this.peek(1).type === 'word' && (this.peek(1).upper === 'DELETE' || this.peek(1).upper === 'UPDATE')) {
        this.next();
        const which = this.next().upper;
        const action = this.parseAction();
        if (which === 'DELETE') ref.onDelete = action;
        else ref.onUpdate = action;
        continue;
      }
      if (this.isWord('NOT') && this.peek(1).type === 'word' && this.peek(1).upper === 'DEFERRABLE') {
        this.next();
        this.next();
        continue;
      }
      if (this.acceptWord('DEFERRABLE')) continue;
      if (this.acceptWord('INITIALLY')) {
        this.next();
        continue;
      }
      break;
    }
    return ref;
  }

  private parseAction(): ReferentialAction {
    const t = this.next();
    if (t.type !== 'word') this.fail('Expected a referential action', t);
    if (t.upper === 'SET' || t.upper === 'NO') {
      const t2 = this.next();
      const key = `${t.upper} ${t2.upper}`;
      if (!(key in ACTIONS)) this.fail(`Unknown referential action ${key}`, t);
      return ACTIONS[key];
    }
    if (!(t.upper in ACTIONS)) this.fail(`Unknown referential action ${t.value}`, t);
    return ACTIONS[t.upper];
  }

  /* ---------- table constraints ---------- */

  private parseTableConstraint(table: ParsedTable, stops: string[]): void {
    let cname: string | undefined;
    if (this.acceptWord('CONSTRAINT')) {
      if (!this.isWord('PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'INDEX', 'KEY', 'EXCLUDE')) cname = this.parseIdent();
    }
    const t = this.peek();
    const upper = t.type === 'word' ? t.upper : '';
    switch (upper) {
      case 'PRIMARY': {
        this.next();
        this.expectWord('KEY');
        this.skipIndexNameAndType();
        table.primaryKey = this.parseColumnList();
        break;
      }
      case 'UNIQUE': {
        this.next();
        this.acceptWord('INDEX', 'KEY');
        const iname = this.skipIndexNameAndType();
        const cols = this.parseColumnList();
        if (cols.length === 1) {
          const c = table.columns.find((col) => col.name === cols[0]);
          if (c) {
            c.unique = true;
            break;
          }
        }
        table.uniques.push({ name: cname ?? iname, columns: cols });
        break;
      }
      case 'FOREIGN': {
        this.next();
        this.expectWord('KEY');
        const iname = this.skipIndexNameAndType();
        const cols = this.parseColumnList();
        this.expectWord('REFERENCES');
        const ref = this.parseReferencesClause(cname ?? iname);
        table.foreignKeys.push({ ...ref, columns: cols });
        break;
      }
      case 'CHECK': {
        this.next();
        table.checks.push(this.parseParenRaw());
        break;
      }
      case 'INDEX':
      case 'KEY': {
        this.next();
        const iname = this.skipIndexNameAndType();
        const cols = this.parseColumnList();
        table.indexes.push({ name: cname ?? iname, columns: cols, unique: false });
        break;
      }
      case 'FULLTEXT':
      case 'SPATIAL': {
        this.next();
        this.acceptWord('INDEX', 'KEY');
        const iname = this.skipIndexNameAndType();
        const cols = this.parseColumnList();
        table.indexes.push({ name: cname ?? iname, columns: cols, unique: false });
        this.warn(`${upper} index ${iname ?? ''} on ${table.name} imported as a plain index`, t);
        break;
      }
      default:
        this.warn(`Skipped unsupported table constraint starting with ${this.describe(t)} in ${table.name}`, t);
    }
    // trailing options: USING BTREE, COMMENT '...', DEFERRABLE, NOT ENFORCED ...
    this.skipUntil(stops);
  }

  /** Optional index name and USING clause: `idx_name USING BTREE (`. Returns the name if present. */
  private skipIndexNameAndType(): string | undefined {
    let name: string | undefined;
    if (this.isIdent() && !this.isWord('USING')) {
      name = this.parseIdent();
    }
    if (this.acceptWord('USING')) this.next();
    return name;
  }

  /* ---------- other statements ---------- */

  private parseAlter(): void {
    const start = this.expectWord('ALTER');
    if (this.isWord('SEQUENCE')) {
      // pg_dump's ALTER SEQUENCE ... OWNED BY: the sequence is already implied by the column's nextval() default.
      this.skipStatement();
      return;
    }
    if (!this.isWord('TABLE')) {
      this.warn(`Skipped ALTER ${this.peek().value.toUpperCase()} statement`, start);
      this.skipStatement();
      return;
    }
    this.next();
    this.acceptWord('ONLY');
    if (this.acceptWord('IF')) this.expectWord('EXISTS');
    const { schema, name } = this.parseQualifiedName();
    const table = this.findTable(name, schema);
    if (!table) {
      this.warn(`ALTER TABLE ${name} refers to a table that is not defined in this script; skipped`, start);
      this.skipStatement();
      return;
    }
    for (;;) {
      if (this.acceptWord('ADD')) {
        if (this.acceptWord('COLUMN') || !this.looksLikeTableConstraint()) {
          if (this.acceptWord('IF')) {
            this.expectWord('NOT');
            this.expectWord('EXISTS');
          }
          const col = this.parseColumnDef();
          table.columns.push(col);
          if (col.primaryKey) table.primaryKey = [col.name];
        } else {
          this.parseTableConstraint(table, [',', ';']);
        }
      } else if (this.acceptWord('ALTER', 'MODIFY', 'CHANGE')) {
        // ALTER COLUMN x SET NOT NULL / SET DEFAULT are the common pg_dump forms.
        this.acceptWord('COLUMN');
        const colName = this.parseIdent();
        const col = table.columns.find((c) => c.name === colName);
        if (this.acceptWord('SET')) {
          if (this.acceptWord('NOT')) {
            this.expectWord('NULL');
            if (col) col.nullable = false;
          } else if (this.acceptWord('DEFAULT')) {
            const v = this.parseExpressionRaw(new Set());
            if (col) col.defaultValue = v;
          }
        } else if (this.acceptWord('DROP')) {
          if (this.acceptWord('NOT')) {
            this.expectWord('NULL');
            if (col) col.nullable = true;
          } else if (this.acceptWord('DEFAULT')) {
            if (col) delete col.defaultValue;
          }
        }
        this.skipUntil([',', ';']);
      } else {
        this.warn(`Skipped unsupported ALTER TABLE action on ${name}`, this.peek());
        this.skipUntil([',', ';']);
      }
      if (this.acceptPunct(',')) continue;
      break;
    }
    // apply late PK declarations
    for (const c of table.columns) {
      if (table.primaryKey.includes(c.name)) {
        c.primaryKey = true;
        c.nullable = false;
      }
    }
    this.acceptPunct(';');
  }

  private parseCreateIndex(unique: boolean): void {
    const start = this.expectWord('INDEX');
    this.acceptWord('CONCURRENTLY');
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    let iname: string | undefined;
    if (!this.isWord('ON')) iname = this.parseIdent();
    this.expectWord('ON');
    this.acceptWord('ONLY');
    const { schema, name } = this.parseQualifiedName();
    if (this.acceptWord('USING')) this.next();
    const cols = this.parseColumnList();
    this.skipStatement();
    const table = this.findTable(name, schema);
    if (!table) {
      this.warn(`CREATE INDEX on ${name} refers to a table that is not defined in this script; skipped`, start);
      return;
    }
    table.indexes.push({ name: iname, columns: cols, unique });
  }

  private parseCreateType(): void {
    this.expectWord('TYPE');
    const { name } = this.parseQualifiedName();
    // PostgreSQL spells a composite type AS (...), DuckDB AS STRUCT(...).
    const asStruct = this.isWord('AS') && this.peek(1).type === 'word' && this.peek(1).upper === 'STRUCT' && this.isPunct('(', 2);
    if (this.isWord('AS') && this.peek(1).type === 'word' && this.peek(1).upper === 'ENUM') {
      this.next(); // AS
      this.next(); // ENUM
      const open = this.expectPunct('(');
      const values: string[] = [];
      while (!this.isPunct(')')) {
        const t = this.next();
        if (t.type === 'eof') this.fail('Unterminated ENUM list', open);
        if (t.type === 'string') values.push(t.value);
      }
      this.next();
      this.result.enums.push({ name, values });
    } else if (this.isWord('AS') && (this.isPunct('(', 1) || asStruct)) {
      this.next(); // AS
      if (asStruct) this.next(); // STRUCT
      const open = this.expectPunct('(');
      const fields: { name: string; type: string }[] = [];
      while (!this.isPunct(')')) {
        if (this.peek().type === 'eof') this.fail('Unterminated type body', open);
        const fname = this.parseIdent();
        const ftype = this.parseType();
        fields.push({ name: fname, type: ftype });
        if (!this.acceptPunct(',')) break;
      }
      this.expectPunct(')');
      this.result.compositeTypes.push({ name, fields });
    } else {
      this.warn(`Skipped CREATE TYPE ${name} (only ENUM and composite "AS (...)" / "AS STRUCT(...)" types are recorded)`);
    }
    this.skipStatement();
  }

  /** CREATE EXTENSION [IF NOT EXISTS] name [WITH] [SCHEMA s] [VERSION 'v'] [CASCADE] */
  private parseCreateExtension(): void {
    this.expectWord('EXTENSION');
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    const name = this.parseIdent();
    let schema: string | undefined;
    let version: string | undefined;
    this.acceptWord('WITH');
    for (;;) {
      if (this.acceptWord('SCHEMA')) {
        schema = this.parseIdent();
        continue;
      }
      if (this.acceptWord('VERSION')) {
        const t = this.next();
        // The version can be written as a string or as a bare identifier.
        version = t.type === 'string' ? t.value : t.value;
        continue;
      }
      // CASCADE creates the dependencies too; it changes nothing we record.
      if (this.acceptWord('CASCADE')) continue;
      break;
    }
    this.skipStatement();
    this.addExtension({ name, schema, version });
  }

  /** MariaDB: INSTALL SONAME 'x' / INSTALL PLUGIN x SONAME 'y'. Both name a plugin library. */
  private parseInstall(): void {
    const start = this.expectWord('INSTALL');
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    if (this.acceptWord('SONAME')) {
      const t = this.next();
      // The library name is what MariaDB records, minus the platform suffix.
      if (t.type === 'string' || t.type === 'word') this.addExtension({ name: t.value.replace(/\.(so|dll|dylib)$/i, '') });
      this.skipStatement();
      return;
    }
    if (this.acceptWord('PLUGIN')) {
      const plugin = this.parseIdent();
      let soname = plugin;
      if (this.acceptWord('SONAME')) {
        const t = this.next();
        if (t.type === 'string' || t.type === 'word') soname = t.value.replace(/\.(so|dll|dylib)$/i, '');
      }
      this.addExtension({ name: soname });
      this.skipStatement();
      return;
    }
    // DuckDB: INSTALL name [FROM repository]. The name may be bare, quoted or a string.
    const t = this.peek();
    if (t.type === 'word' || t.type === 'quoted' || t.type === 'string') {
      this.next();
      this.addExtension({ name: t.value });
      this.skipStatement();
      return;
    }
    this.warn('Skipped INSTALL statement', start);
    this.skipStatement();
  }

  /** DuckDB: LOAD name activates an installed extension for the session; it names the same extension INSTALL did. */
  private parseLoad(): void {
    const start = this.expectWord('LOAD');
    const t = this.peek();
    // MariaDB's LOAD DATA / LOAD XML / LOAD INDEX move rows, not extensions.
    if ((t.type === 'word' && !/^(DATA|XML|INDEX)$/.test(t.upper)) || t.type === 'quoted' || t.type === 'string') {
      this.next();
      this.addExtension({ name: t.value });
      this.skipStatement();
      return;
    }
    this.warn('Skipped LOAD statement', start);
    this.skipStatement();
  }

  /** An engine can only enable an extension once, so a repeat in the script is not a second one. */
  private addExtension(e: ParsedExtension): void {
    const name = e.name.trim();
    if (!name) return;
    if (this.result.extensions.some((x) => x.name.toLowerCase() === name.toLowerCase())) return;
    this.result.extensions.push({ ...e, name });
  }

  private parseCommentOn(): void {
    const start = this.expectWord('COMMENT');
    this.expectWord('ON');
    const kind = this.next();
    if (kind.upper === 'TABLE' || kind.upper === 'COLUMN') {
      const parts = [this.parseIdent()];
      while (this.acceptPunct('.')) parts.push(this.parseIdent());
      this.expectWord('IS');
      const s = this.next();
      const text = s.type === 'string' ? s.value : null;
      if (kind.upper === 'TABLE') {
        const tname = parts[parts.length - 1];
        const table = this.findTable(tname, parts.length > 1 ? parts[parts.length - 2] : undefined);
        if (table) table.comment = text ?? undefined;
        else this.warn(`COMMENT ON TABLE ${tname}: table not found`, start);
      } else {
        const cname = parts[parts.length - 1];
        const tname = parts[parts.length - 2];
        const table = tname ? this.findTable(tname, parts.length > 2 ? parts[parts.length - 3] : undefined) : undefined;
        const col = table?.columns.find((c) => c.name === cname);
        if (col) col.comment = text ?? undefined;
        else this.warn(`COMMENT ON COLUMN ${parts.join('.')}: column not found`, start);
      }
    } else if (kind.upper === 'PROCEDURE' || kind.upper === 'FUNCTION') {
      const { schema, name } = this.parseQualifiedName();
      if (this.isPunct('(')) this.parseParenRaw();
      this.expectWord('IS');
      const s = this.next();
      const routine = this.result.routines.find((r) => r.name.toLowerCase() === name.toLowerCase() && (!schema || !r.schema || r.schema === schema));
      if (routine) routine.comment = s.type === 'string' ? s.value : undefined;
      else this.warn(`COMMENT ON ${kind.upper} ${name}: ${kind.value.toLowerCase()} not found`, start);
    } else {
      this.warn(`Skipped COMMENT ON ${kind.value.toUpperCase()}`, start);
    }
    this.skipStatement();
  }

  private findTable(name: string, schema?: string): ParsedTable | undefined {
    const exact = this.result.tables.find((t) => t.name === name && (!schema || !t.schema || t.schema === schema));
    if (exact) return exact;
    const lower = name.toLowerCase();
    return this.result.tables.find((t) => t.name.toLowerCase() === lower);
  }
}

/**
 * The `DELIMITER` lines of a mysql / mariadb client script, undone.
 *
 * DELIMITER is not SQL: it tells the command-line client to stop splitting at
 * `;` so a procedure body full of semicolons reaches the server whole. The
 * parser reads a body by counting its BEGIN and END instead, so here each
 * DELIMITER line is blanked and every use of the custom delimiter is turned
 * back into `;`. Both are replaced with text of the same length, so every line
 * and column a message reports still points at the script as it was pasted.
 * Strings and comments are left alone: a `//` inside a string is not a
 * delimiter.
 */
export function undoDelimiters(sql: string): string {
  if (!/^[ \t]*DELIMITER[ \t]/im.test(sql)) return sql;
  let out = '';
  let delim = ';';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const lineStart = i === 0 || sql[i - 1] === '\n';
    if (lineStart) {
      const eol = sql.indexOf('\n', i);
      const line = sql.slice(i, eol === -1 ? n : eol);
      const m = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*\r?$/i.exec(line);
      if (m) {
        delim = m[1];
        out += ' '.repeat(line.length);
        i += line.length;
        continue;
      }
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== ch) j += sql[j] === '\\' ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (delim !== ';' && sql.startsWith(delim, i)) {
      out += ';' + ' '.repeat(delim.length - 1);
      i += delim.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Parse a DDL script. Never throws for SQL errors: they are collected in `errors`. */
export function parseSql(sql: string, dialect: Dialect): ParseResult {
  let tokens: Token[];
  const text = undoDelimiters(sql);
  try {
    tokens = tokenize(text, { bracketIdentifiers: dialect === 'sqlite' });
  } catch (e) {
    if (e instanceof SqlSyntaxError) {
      return { tables: [], views: [], routines: [], extensions: [], enums: [], compositeTypes: [], errors: [{ message: e.message, line: e.line, col: e.col }], warnings: [], statementCount: 0 };
    }
    throw e;
  }
  return new Parser(text, tokens, dialect).parse();
}
