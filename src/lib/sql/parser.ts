import type { Dialect, ReferentialAction } from '@shared/types';
import { SqlSyntaxError, tokenize, type Token } from './tokenizer';

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

export interface ParseResult {
  tables: ParsedTable[];
  enums: { name: string; values: string[] }[];
  errors: ParseMessage[];
  warnings: ParseMessage[];
  statementCount: number;
}

/* ------------------------------------------------------------------ */
/* Keyword sets                                                        */
/* ------------------------------------------------------------------ */

const CONSTRAINT_STARTERS = new Set([
  'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'AUTO_INCREMENT',
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
  readonly result: ParseResult = { tables: [], enums: [], errors: [], warnings: [], statementCount: 0 };

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
      case 'SET':
      case 'USE':
      case 'BEGIN':
      case 'START':
      case 'COMMIT':
      case 'LOCK':
      case 'UNLOCK':
      case 'SELECT':
        this.skipStatement();
        return;
      case 'DROP':
        this.skipStatement();
        return;
      default:
        this.warn(`Skipped ${t.value.toUpperCase()} statement (only CREATE TABLE / INDEX / TYPE, ALTER TABLE and COMMENT ON are imported)`);
        this.skipStatement();
    }
  }

  private parseCreate(): void {
    const start = this.expectWord('CREATE');
    if (this.acceptWord('OR')) this.expectWord('REPLACE');
    let unique = false;
    while (this.isWord('TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'UNIQUE')) {
      if (this.next().upper === 'UNIQUE') unique = true;
    }
    if (this.isWord('TABLE')) {
      this.parseCreateTable();
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
    const what = this.peek().type === 'word' ? this.peek().upper : '?';
    this.warn(`Skipped CREATE ${what} statement`, start);
    this.skipStatement();
  }

  private parseCreateTable(): void {
    this.expectWord('TABLE');
    if (this.acceptWord('IF')) {
      this.expectWord('NOT');
      this.expectWord('EXISTS');
    }
    const { schema, name } = this.parseQualifiedName();
    const table: ParsedTable = { schema, name, columns: [], primaryKey: [], uniques: [], indexes: [], checks: [], foreignKeys: [] };

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
        if (words.length > 0 && args !== null && !/^(UNSIGNED|SIGNED|ZEROFILL|ARRAY|PRECISION|VARYING|BINARY)$/.test(u)) break;
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
      if (t.type === 'punct' && t.value === '(' && words.length > 0 && args === null) {
        args = this.parseTypeArgs();
        continue;
      }
      if (t.type === 'punct' && t.value === '[' && words.length > 0) {
        this.next();
        if (this.peek().type === 'number') this.next();
        this.expectPunct(']');
        arraySuffix += '[]';
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
    if (this.acceptWord('AS') && this.acceptWord('ENUM')) {
      const open = this.expectPunct('(');
      const values: string[] = [];
      while (!this.isPunct(')')) {
        const t = this.next();
        if (t.type === 'eof') this.fail('Unterminated ENUM list', open);
        if (t.type === 'string') values.push(t.value);
      }
      this.next();
      this.result.enums.push({ name, values });
    } else {
      this.warn(`Skipped CREATE TYPE ${name} (only ENUM types are recorded)`);
    }
    this.skipStatement();
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

/** Parse a DDL script. Never throws for SQL errors: they are collected in `errors`. */
export function parseSql(sql: string, dialect: Dialect): ParseResult {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (e) {
    if (e instanceof SqlSyntaxError) {
      return { tables: [], enums: [], errors: [{ message: e.message, line: e.line, col: e.col }], warnings: [], statementCount: 0 };
    }
    throw e;
  }
  return new Parser(sql, tokens, dialect).parse();
}
