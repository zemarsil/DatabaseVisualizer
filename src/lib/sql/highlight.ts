/**
 * Syntax colouring for the SQL editors.
 *
 * `scanSql` is a tolerant scanner: unlike the tokenizer the parser uses, it
 * never throws — an unterminated string is a string that runs to the end of
 * the text, an unclosed comment a comment to the end — and it keeps every
 * character, whitespace included, so the segments concatenate back to exactly
 * the input. That is what an overlay highlighter needs: the coloured copy has
 * to wrap and scroll in step with the textarea underneath it.
 *
 * `highlightSql` then classifies the words against the diagram: a word that is
 * a table or column of the scope gets its own colour, so a typo shows up as
 * plain text while you are still typing it.
 */

export type SqlSegmentKind = 'space' | 'comment' | 'string' | 'number' | 'word' | 'quoted' | 'punct' | 'param';

export interface SqlSegment {
  kind: SqlSegmentKind;
  text: string;
  start: number;
  end: number;
}

/** Statement-level words. Uppercased by the formatter, coloured as keywords. */
export const SQL_KEYWORDS = new Set(
  `SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING AS AND OR
   NOT IN IS NULL TRUE FALSE BETWEEN LIKE ILIKE SIMILAR EXISTS ANY ALL SOME CASE WHEN THEN ELSE END DISTINCT UNION INTERSECT
   EXCEPT INSERT INTO VALUES UPDATE SET DELETE RETURNING WITH RECURSIVE CREATE TABLE VIEW MATERIALIZED INDEX UNIQUE PRIMARY
   KEY FOREIGN REFERENCES CONSTRAINT CHECK DEFAULT ALTER ADD DROP COLUMN RENAME TO IF CASCADE RESTRICT TEMP TEMPORARY TYPE
   ENUM EXTENSION SCHEMA SEQUENCE TRIGGER FUNCTION PROCEDURE BEGIN COMMIT ROLLBACK TRANSACTION CONFLICT DO NOTHING DUPLICATE
   REPLACE IGNORE ASC DESC NULLS FIRST LAST OVER PARTITION WINDOW ROWS RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT ROW
   FILTER WITHIN LATERAL ONLY FETCH NEXT FOR SHARE NOWAIT SKIP LOCKED EXPLAIN ANALYZE VACUUM TRUNCATE GRANT REVOKE COMMENT
   COLLATE ESCAPE INTERVAL ARRAY GENERATED ALWAYS IDENTITY AUTO_INCREMENT AUTOINCREMENT UNSIGNED ZEROFILL ENGINE CHARSET
   CHARACTER VARYING WITHOUT ZONE PRECISION NO ACTION DEFERRABLE INITIALLY DEFERRED IMMEDIATE EXCLUDED CONCURRENTLY OWNER
   REFRESH INHERITS LANGUAGE RETURNS DECLARE LOOP WHILE RETURN RAISE NOTICE EXCEPTION GLOBAL LOCAL SESSION ISOLATION LEVEL
   READ WRITE SAVEPOINT RELEASE LOCK MODE ACCESS EXCLUSIVE CAST EXTRACT ESCAPE STRICT IMMUTABLE STABLE VOLATILE`
    .split(/\s+/)
    .filter(Boolean),
);

/** Column types. Coloured a little apart from keywords, and never re-cased by the formatter. */
export const SQL_TYPES = new Set(
  `INT INTEGER BIGINT SMALLINT TINYINT MEDIUMINT SERIAL BIGSERIAL SMALLSERIAL NUMERIC DECIMAL DEC REAL FLOAT FLOAT4 FLOAT8
   DOUBLE MONEY BOOLEAN BOOL TEXT VARCHAR CHAR NCHAR NVARCHAR CLOB DATE TIME TIMESTAMP TIMESTAMPTZ TIMETZ DATETIME YEAR JSON
   JSONB UUID BYTEA BLOB BINARY VARBINARY BIT INET CIDR MACADDR XML POINT LINE POLYGON GEOMETRY GEOGRAPHY VECTOR TSVECTOR
   TSQUERY INT2 INT4 INT8 CITEXT HSTORE OID LONGTEXT MEDIUMTEXT TINYTEXT LONGBLOB MEDIUMBLOB TINYBLOB`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Functions worth offering and colouring. A word is coloured as a function
 * only when a "(" follows it, so a column called `date` stays a column.
 */
export const SQL_FUNCTIONS = new Set(
  `COUNT SUM AVG MIN MAX STRING_AGG GROUP_CONCAT ARRAY_AGG JSON_AGG JSONB_AGG JSON_OBJECT JSON_ARRAY JSON_EXTRACT
   JSON_BUILD_OBJECT JSONB_BUILD_OBJECT JSONB_ARRAY_ELEMENTS JSON_ARRAY_ELEMENTS JSON_EACH JSONB_EACH JSON_VALUE JSON_QUERY
   ROW_NUMBER RANK DENSE_RANK PERCENT_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE NTILE COALESCE NULLIF GREATEST LEAST
   ROUND FLOOR CEIL CEILING ABS MOD POWER POW SQRT EXP LN LOG SIGN TRUNC TRUNCATE RANDOM RAND UPPER LOWER LENGTH CHAR_LENGTH
   CHARACTER_LENGTH SUBSTRING SUBSTR TRIM LTRIM RTRIM REPLACE CONCAT CONCAT_WS LEFT RIGHT POSITION STRPOS INSTR REVERSE
   REPEAT LPAD RPAD INITCAP MD5 SHA256 NOW CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIMESTAMP DATE_TRUNC DATE_PART
   EXTRACT AGE TO_CHAR TO_DATE TO_TIMESTAMP TO_NUMBER DATEDIFF TIMESTAMPDIFF TIMESTAMPADD DATE_ADD DATE_SUB DATE_FORMAT
   STRFTIME JULIANDAY UNIXEPOCH UNIX_TIMESTAMP FROM_UNIXTIME GEN_RANDOM_UUID UUID_GENERATE_V4 UUID CAST CONVERT IF IFNULL
   NVL IIF TYPEOF NEXTVAL CURRVAL SETVAL PERCENTILE_CONT PERCENTILE_DISC BOOL_AND BOOL_OR EVERY VARIANCE STDDEV STDDEV_POP
   STDDEV_SAMP VAR_POP VAR_SAMP ARRAY_LENGTH CARDINALITY UNNEST GENERATE_SERIES REGEXP_REPLACE REGEXP_MATCH REGEXP_MATCHES
   SPLIT_PART FORMAT QUOTE_IDENT QUOTE_LITERAL TO_JSON TO_JSONB ROW_TO_JSON DATE YEAR MONTH DAY HOUR MINUTE SECOND WEEK
   DAYOFWEEK DAYOFYEAR HASH PRINTF TOTAL`
    .split(/\s+/)
    .filter(Boolean),
);

const MULTI_PUNCT = ['::', '<=', '>=', '<>', '!=', '||', '->>', '->', '=>', '@>', '<@', '**', '#>>', '#>', '?|', '?&'];

const WORD_START = /[A-Za-z_\u0080-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** Split SQL into segments that cover every character. Never throws. */
export function scanSql(text: string): SqlSegment[] {
  const out: SqlSegment[] = [];
  const n = text.length;
  let i = 0;
  const push = (kind: SqlSegmentKind, end: number) => {
    if (end > i) out.push({ kind, text: text.slice(i, end), start: i, end });
    i = end;
  };
  while (i < n) {
    const ch = text[i];
    // whitespace, newlines included
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      push('space', j);
      continue;
    }
    // comments
    if ((ch === '-' && text[i + 1] === '-') || ch === '#') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = n;
      push('comment', j);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      push('comment', j);
      continue;
    }
    // dollar-quoted string
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        let j = text.indexOf(tag, i + tag.length);
        j = j === -1 ? n : j + tag.length;
        push('string', j);
        continue;
      }
      // $1 style parameter
      const p = /^\$\d+/.exec(text.slice(i, i + 8));
      if (p) {
        push('param', i + p[0].length);
        continue;
      }
    }
    // string literal ('...' with '' escaping, E'..', N'..')
    if (ch === "'" || ((ch === 'E' || ch === 'N' || ch === 'e' || ch === 'n') && text[i + 1] === "'")) {
      let j = ch === "'" ? i + 1 : i + 2;
      for (;;) {
        if (j >= n) break;
        const c = text[j];
        if (c === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (c === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('string', j);
      continue;
    }
    // quoted identifiers: "pg", `mariadb`, [sqlite] — but arr[1] is a subscript, not a name
    const lastSolid = out.length && out[out.length - 1].kind !== 'space' ? out[out.length - 1] : out.length > 1 ? out[out.length - 2] : null;
    const subscript = ch === '[' && lastSolid !== null && (lastSolid.kind === 'word' || lastSolid.kind === 'quoted' || lastSolid.text === ')' || lastSolid.text === ']');
    if (ch === '"' || ch === '`' || (ch === '[' && !subscript)) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      for (;;) {
        if (j >= n || text[j] === '\n') break;
        if (text[j] === close) {
          if (text[j + 1] === close && close !== ']') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('quoted', j);
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:0x[0-9A-Fa-f]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
      push('number', i + (m ? m[0].length : 1));
      continue;
    }
    // words
    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j])) j++;
      push('word', j);
      continue;
    }
    // :name parameters (but not the :: cast)
    if (ch === ':' && text[i + 1] !== ':' && /[A-Za-z_]/.test(text[i + 1] ?? '')) {
      let j = i + 2;
      while (j < n && WORD_PART.test(text[j])) j++;
      push('param', j);
      continue;
    }
    if (ch === '?') {
      push('param', i + 1);
      continue;
    }
    const op = MULTI_PUNCT.find((p) => text.startsWith(p, i));
    push('punct', i + (op ? op.length : 1));
  }
  return out;
}

/** The tables and columns a piece of SQL can name, for colouring and completion. */
export interface SqlScopeTable {
  name: string;
  schema?: string;
  columns: { name: string; type: string }[];
  /** Shown in the completion list next to the name, e.g. "view" or "through orders.customer_id". */
  hint?: string;
}

export interface SqlScope {
  tables: SqlScopeTable[];
  /**
   * The table an expression runs on: its columns may be named bare. Other
   * tables' columns must be written table.column. Statement-level SQL has no
   * primary table; any scope column may appear bare there.
   */
  primary?: string;
}

export type HighlightClass =
  | 'keyword'
  | 'type'
  | 'function'
  | 'string'
  | 'number'
  | 'comment'
  | 'table'
  | 'column'
  | 'alias'
  | 'unknown'
  | 'quoted'
  | 'param'
  | 'punct'
  | 'text';

export interface HighlightSpan {
  cls: HighlightClass;
  text: string;
  start: number;
  end: number;
}

export interface HighlightOptions {
  /**
   * Expression mode: a bare word that is neither a keyword, a function, a
   * scope column nor an alias is marked unknown, because the expression
   * language cannot resolve it. Statements are too free-form for that.
   */
  strict?: boolean;
}

/** Word segments that are not strings, comments or spaces, with the index of the segment before and after. */
function neighbours(segments: SqlSegment[], i: number): { prev: SqlSegment | null; next: SqlSegment | null } {
  let p = i - 1;
  while (p >= 0 && segments[p].kind === 'space') p--;
  let q = i + 1;
  while (q < segments.length && segments[q].kind === 'space') q++;
  return { prev: p >= 0 ? segments[p] : null, next: q < segments.length ? segments[q] : null };
}

function stripQuotes(text: string): string {
  return text.replace(/^["`[]|["`\]]$/g, '').replace(/""|``/g, (m) => m[0]);
}

/**
 * Aliases declared in the text (`FROM orders o`, `JOIN customers AS c`,
 * `UPDATE t AS u`), lower-cased alias → table name as written.
 */
export function tableAliases(text: string): Map<string, string> {
  const segs = scanSql(text).filter((s) => s.kind !== 'space' && s.kind !== 'comment');
  const out = new Map<string, string>();
  const isName = (s: SqlSegment | undefined) => Boolean(s) && (s!.kind === 'word' || s!.kind === 'quoted');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind !== 'word') continue;
    const up = s.text.toUpperCase();
    if (up !== 'FROM' && up !== 'JOIN' && up !== 'UPDATE' && up !== 'INTO') continue;
    // FROM name [AS] alias
    let j = i + 1;
    if (!isName(segs[j])) continue;
    let name = segs[j].kind === 'quoted' ? stripQuotes(segs[j].text) : segs[j].text;
    // schema.table
    if (segs[j + 1]?.text === '.' && isName(segs[j + 2])) {
      j += 2;
      name = segs[j].kind === 'quoted' ? stripQuotes(segs[j].text) : segs[j].text;
    }
    if (segs[j + 1]?.text === '(') continue; // function in FROM
    j++;
    if (segs[j]?.kind === 'word' && segs[j].text.toUpperCase() === 'AS') j++;
    const alias = segs[j];
    if (!isName(alias) || alias.kind !== 'word') continue;
    const aliasUp = alias.text.toUpperCase();
    if (SQL_KEYWORDS.has(aliasUp) || SQL_FUNCTIONS.has(aliasUp)) continue;
    out.set(alias.text.toLowerCase(), name);
  }
  return out;
}

/** Colour every character of `text`. Spans concatenate back to the input. */
export function highlightSql(text: string, scope?: SqlScope, opts: HighlightOptions = {}): HighlightSpan[] {
  const segments = scanSql(text);
  const tables = new Map<string, SqlScopeTable>();
  for (const t of scope?.tables ?? []) {
    tables.set(t.name.toLowerCase(), t);
    if (t.schema) tables.set(`${t.schema}.${t.name}`.toLowerCase(), t);
  }
  const primary = scope?.primary ? tables.get(scope.primary.toLowerCase()) : undefined;
  const anyColumn = new Set<string>();
  for (const t of scope?.tables ?? []) for (const c of t.columns) anyColumn.add(c.name.toLowerCase());
  const aliases = scope ? tableAliases(text) : new Map<string, string>();

  const out: HighlightSpan[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    let cls: HighlightClass;
    switch (s.kind) {
      case 'space':
        cls = 'text';
        break;
      case 'comment':
      case 'string':
      case 'number':
      case 'param':
      case 'punct':
        cls = s.kind;
        break;
      case 'quoted': {
        const name = stripQuotes(s.text).toLowerCase();
        cls = tables.has(name) ? 'table' : anyColumn.has(name) ? 'column' : 'quoted';
        break;
      }
      case 'word': {
        const up = s.text.toUpperCase();
        const low = s.text.toLowerCase();
        const { prev, next } = neighbours(segments, i);
        const qualified = prev?.text === '.';
        const called = next?.text === '(';
        const bareColumn = primary ? primary.columns.some((c) => c.name.toLowerCase() === low) : anyColumn.has(low);
        if (!qualified && called && SQL_FUNCTIONS.has(up)) cls = 'function';
        else if (!qualified && !called && tables.has(low)) cls = 'table';
        else if (!qualified && !called && bareColumn) cls = 'column'; // a column called date or year is still a column
        else if (!qualified && SQL_KEYWORDS.has(up)) cls = 'keyword';
        else if (!qualified && SQL_TYPES.has(up)) cls = 'type';
        else if (qualified) {
          // table.column or alias.column: look the column up in that table
          let q = i - 1;
          while (q >= 0 && segments[q].kind === 'space') q--;
          q--;
          while (q >= 0 && segments[q].kind === 'space') q--;
          const owner = q >= 0 ? segments[q] : null;
          const ownerName = owner ? (owner.kind === 'quoted' ? stripQuotes(owner.text) : owner.text).toLowerCase() : '';
          const table = tables.get(ownerName) ?? tables.get((aliases.get(ownerName) ?? '').toLowerCase());
          if (table && table.columns.some((c) => c.name.toLowerCase() === low)) cls = 'column';
          else if (tables.has(`${ownerName}.${low}`)) cls = 'table';
          else if (table && opts.strict) cls = 'unknown';
          else cls = 'text';
        } else if (aliases.has(low)) cls = 'alias';
        else if (called) cls = 'function';
        else if (anyColumn.has(low)) cls = 'column';
        else if (opts.strict && scope) cls = 'unknown';
        else cls = 'text';
        break;
      }
      default:
        cls = 'text';
    }
    out.push({ cls, text: s.text, start: s.start, end: s.end });
  }
  return out;
}

/** The segment the caret sits in, or null at a boundary between segments. */
export function segmentAt(segments: SqlSegment[], caret: number): SqlSegment | null {
  for (const s of segments) if (s.start < caret && caret < s.end) return s;
  return null;
}

/**
 * True when the caret is inside a string, a quoted name or a comment, where
 * completion has no business. A literal that is still open (no closing quote
 * yet, or a line comment) counts up to and including its end.
 */
export function inLiteralAt(text: string, caret: number): boolean {
  for (const s of scanSql(text)) {
    if (s.kind !== 'string' && s.kind !== 'comment' && s.kind !== 'quoted') continue;
    if (s.start < caret && caret < s.end) return true;
    if (caret !== s.end) continue;
    if (s.kind === 'comment') return s.text.startsWith('--') || s.text.startsWith('#') || !s.text.endsWith('*/');
    if (s.kind === 'string') return s.text.length < 2 || !s.text.endsWith("'") || s.text === "'";
    const close = s.text[0] === '[' ? ']' : s.text[0];
    return s.text.length < 2 || !s.text.endsWith(close);
  }
  return false;
}
