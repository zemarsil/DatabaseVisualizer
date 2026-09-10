import type { Dialect } from '@shared/types';

/** Words that must be quoted when used as identifiers, in either dialect. */
const RESERVED = new Set(
  `ADD ALL ALTER AND ANY AS ASC BETWEEN BY CASE CHECK COLLATE COLUMN CONSTRAINT CREATE CROSS CURRENT_DATE
   CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DELETE DESC DISTINCT DROP ELSE END EXISTS FALSE FOR
   FOREIGN FROM FULL GRANT GROUP HAVING IN INDEX INNER INSERT INTERVAL INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL
   ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE THEN TO TRUE UNION UNIQUE UPDATE USER USING
   VALUES WHEN WHERE WITH ROW ROWS RANGE OFFSET FETCH NATURAL EXCEPT INTERSECT ONLY BOTH LEADING TRAILING
   PLACING SIMILAR SOME SYMMETRIC ASYMMETRIC LOCALTIME LOCALTIMESTAMP SESSION_USER DO RETURNING WINDOW OVER
   PARTITION LATERAL CAST ARRAY ANALYZE ANALYSE AUTHORIZATION BINARY COLUMNS CONCURRENTLY FREEZE ILIKE ISNULL
   NOTNULL VERBOSE ACCESSIBLE ASENSITIVE BEFORE BIGINT BLOB CALL CHANGE CHAR CHARACTER CONDITION CONTINUE
   CONVERT CURSOR DATABASE DATABASES DAY_HOUR DEC DECIMAL DECLARE DELAYED DESCRIBE DETERMINISTIC DISTINCTROW
   DIV DOUBLE DUAL EACH ELSEIF ENCLOSED ESCAPED EXIT EXPLAIN FLOAT FORCE FULLTEXT GENERAL GROUPS HIGH_PRIORITY
   IF IGNORE INFILE INOUT INSENSITIVE INT INTEGER ITERATE KEYS KILL LEAVE LINES LOAD LOCK LONG LOOP LOW_PRIORITY
   MATCH MOD MODIFIES NO_WRITE_TO_BINLOG NUMERIC OPTIMIZE OPTION OPTIONALLY OUT OUTFILE PROCEDURE PURGE READ
   READS REAL REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN REVOKE RLIKE SCHEMA SCHEMAS
   SENSITIVE SEPARATOR SHOW SIGNAL SMALLINT SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SSL STARTING
   TERMINATED TINYINT TRIGGER UNDO UNLOCK UNSIGNED USAGE UTC_DATE UTC_TIME UTC_TIMESTAMP VARCHAR VARYING WHILE
   WRITE XOR YEAR_MONTH ZEROFILL`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Words DuckDB alone refuses as bare identifiers, on top of the shared set: its
 * own reserved keywords (PIVOT, QUALIFY, SUMMARIZE…) and the "type/function"
 * keywords its parser cannot take as a column name (AT, MAP, STRUCT…). Read
 * off `duckdb_keywords()` of the engine the app ships.
 */
const DUCKDB_RESERVED = new Set(
  `LAMBDA PIVOT PIVOT_LONGER PIVOT_WIDER QUALIFY SUMMARIZE UNPIVOT VARIADIC DEFERRABLE INITIALLY
   ANTI ASOF AT COLLATION GENERATED GLOB MAP OVERLAPS POSITIONAL SEMI STRUCT TABLESAMPLE TRY_CAST UNPACK`
    .split(/\s+/)
    .filter(Boolean),
);

export function isReserved(name: string, dialect?: Dialect): boolean {
  const upper = name.toUpperCase();
  if (RESERVED.has(upper)) return true;
  return dialect === 'duckdb' && DUCKDB_RESERVED.has(upper);
}

/** Quote an identifier only when needed, in the dialect's style. */
export function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === 'postgresql') {
    if (/^[a-z_][a-z0-9_]*$/.test(name) && !isReserved(name)) return name;
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (dialect === 'sqlite' || dialect === 'duckdb') {
    // Both keep identifier case and compare case-insensitively, so plain names stay bare.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isReserved(name, dialect)) return name;
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isReserved(name)) return name;
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Quote a qualified name (schema.table) part by part. */
export function quoteQualified(name: string, schema: string | undefined, dialect: Dialect): string {
  // SQLite has attached databases rather than schemas; a schema prefix would name a database that is not attached.
  if (dialect === 'sqlite') return quoteIdent(name, dialect);
  return schema ? `${quoteIdent(schema, dialect)}.${quoteIdent(name, dialect)}` : quoteIdent(name, dialect);
}

export function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Common types offered as autocomplete suggestions in the column editor. */
export const TYPE_SUGGESTIONS: Record<Dialect, string[]> = {
  postgresql: [
    'SERIAL', 'BIGSERIAL', 'SMALLINT', 'INTEGER', 'BIGINT', 'NUMERIC(10,2)', 'REAL', 'DOUBLE PRECISION', 'MONEY',
    'BOOLEAN', 'VARCHAR(255)', 'CHAR(1)', 'TEXT', 'BYTEA', 'UUID', 'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ',
    'INTERVAL', 'JSON', 'JSONB', 'INET', 'CIDR', 'MACADDR', 'POINT', 'TEXT[]', 'INTEGER[]', 'TSVECTOR', 'XML',
  ],
  mariadb: [
    'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INT UNSIGNED', 'BIGINT', 'BIGINT UNSIGNED', 'DECIMAL(10,2)',
    'FLOAT', 'DOUBLE', 'BIT(1)', 'BOOLEAN', 'CHAR(1)', 'VARCHAR(255)', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT',
    'LONGTEXT', 'BINARY(16)', 'VARBINARY(255)', 'BLOB', 'LONGBLOB', 'UUID', 'DATE', 'TIME', 'DATETIME',
    'TIMESTAMP', 'YEAR', 'JSON', "ENUM('a','b')", "SET('a','b')", 'INET6', 'POINT', 'GEOMETRY',
  ],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'VARCHAR(255)', 'DECIMAL(10,2)', 'JSON'],
  duckdb: [
    'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT', 'UINTEGER', 'UBIGINT', 'USMALLINT', 'UTINYINT', 'DECIMAL(18,3)',
    'FLOAT', 'DOUBLE', 'BOOLEAN', 'VARCHAR', 'VARCHAR(255)', 'TEXT', 'BLOB', 'UUID', 'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ',
    'INTERVAL', 'JSON', 'BIT', 'INTEGER[]', 'VARCHAR[]', 'DOUBLE[3]', 'STRUCT(x INTEGER, y INTEGER)', 'MAP(VARCHAR, INTEGER)',
    "UNION(num INTEGER, str VARCHAR)", "ENUM('a', 'b')",
  ],
};

/** Normalise a raw SQL type for comparisons: upper-case, single spaces, no space before '('. */
export function normalizeType(type: string): string {
  return type
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*,\s*/g, ',')
    .replace(/^([a-z0-9_ ]+)/i, (m) => m.toUpperCase())
    .replace(/\)\s*([a-z ]+)$/i, (_m, tail: string) => ')' + ' ' + tail.trim().toUpperCase());
}

interface TypeParts {
  base: string;
  args: string | null;
  /** Trailing modifiers such as UNSIGNED, ZEROFILL, WITH TIME ZONE, [] */
  suffix: string;
}

function splitType(type: string): TypeParts {
  const norm = normalizeType(type);
  const m = /^([A-Z0-9_ ]+?)(?:\(([^)]*)\))?((?:\s*\[\])*|\s+[A-Z ]+)?$/.exec(norm);
  if (!m) return { base: norm, args: null, suffix: '' };
  return { base: m[1].trim(), args: m[2] ?? null, suffix: (m[3] ?? '').trim() };
}

export function isIntegerType(type: string): boolean {
  const { base } = splitType(type);
  return /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT1|INT2|INT4|INT8|INT128|SERIAL|BIGSERIAL|SMALLSERIAL|HUGEINT|UHUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|SHORT|LONG|SIGNED)$/.test(base);
}

export function isSerialType(type: string): boolean {
  return /^(SERIAL|BIGSERIAL|SMALLSERIAL)$/.test(splitType(type).base);
}

/**
 * Translate a column type between dialects. Unknown types pass through
 * untouched; the caller can warn the user. The autoIncrement flag is handled
 * by the generator, so SERIAL simply becomes an integer here.
 */
export function translateType(type: string, from: Dialect, to: Dialect): string {
  if (from === to) return type;
  if (to === 'duckdb') return toDuckdb(type, from);
  if (from === 'duckdb') return fromDuckdb(type, to);
  const { base, args, suffix } = splitType(type);
  const withArgs = (b: string, a: string | null = args) => (a ? `${b}(${a})` : b);
  const isArray = suffix.includes('[]');

  if (to === 'sqlite') {
    if (isArray) return 'TEXT';
    switch (base) {
      case 'INT': case 'INTEGER': case 'SMALLINT': case 'BIGINT': case 'TINYINT': case 'MEDIUMINT':
      case 'SERIAL': case 'BIGSERIAL': case 'SMALLSERIAL': case 'INT2': case 'INT4': case 'INT8': case 'OID':
        return args === '1' && base === 'TINYINT' ? 'BOOLEAN' : 'INTEGER';
      case 'REAL': case 'FLOAT': case 'DOUBLE': case 'DOUBLE PRECISION': case 'FLOAT4': case 'FLOAT8': return 'REAL';
      case 'NUMERIC': case 'DECIMAL': case 'DEC': case 'FIXED': return withArgs('NUMERIC');
      case 'MONEY': return 'NUMERIC(19,4)';
      case 'BOOLEAN': case 'BOOL': return 'BOOLEAN';
      case 'BIT': return args === '1' || !args ? 'BOOLEAN' : 'INTEGER';
      case 'VARCHAR': case 'CHARACTER VARYING': case 'NVARCHAR': return withArgs('VARCHAR');
      case 'CHAR': case 'CHARACTER': case 'NCHAR': return withArgs('CHAR');
      case 'TEXT': case 'TINYTEXT': case 'MEDIUMTEXT': case 'LONGTEXT': case 'CITEXT': case 'CLOB': return 'TEXT';
      case 'JSON': case 'JSONB': case 'UUID': case 'XML': case 'TSVECTOR': case 'INTERVAL': case 'INET': case 'INET6': case 'INET4':
      case 'CIDR': case 'MACADDR': case 'ENUM': case 'SET': case 'POINT': case 'GEOMETRY': case 'LINESTRING': case 'POLYGON': case 'HSTORE':
        return 'TEXT';
      case 'BYTEA': case 'BLOB': case 'TINYBLOB': case 'MEDIUMBLOB': case 'LONGBLOB': case 'VARBINARY': case 'BINARY': case 'BIT VARYING': case 'VARBIT': return 'BLOB';
      case 'DATE': return 'DATE';
      case 'TIME': case 'TIMETZ': case 'TIME WITH TIME ZONE': return 'TIME';
      case 'TIMESTAMP': case 'TIMESTAMPTZ': case 'TIMESTAMP WITH TIME ZONE': case 'DATETIME': return 'DATETIME';
      case 'YEAR': return 'INTEGER';
      default: return type;
    }
  }
  if (from === 'sqlite') {
    const pg = to === 'postgresql';
    switch (base) {
      case 'INTEGER': case 'INT': return pg ? 'INTEGER' : 'INT';
      case 'REAL': return pg ? 'DOUBLE PRECISION' : 'DOUBLE';
      case 'TEXT': return 'TEXT';
      case 'BLOB': return pg ? 'BYTEA' : 'LONGBLOB';
      case 'BOOLEAN': return 'BOOLEAN';
      case 'DATETIME': return pg ? 'TIMESTAMP' : 'DATETIME';
      case 'NUMERIC': case 'DECIMAL': return withArgs(pg ? 'NUMERIC' : 'DECIMAL');
      case 'VARCHAR': return withArgs('VARCHAR', args ?? '255');
      case 'CHAR': return withArgs('CHAR');
      case 'DATE': case 'TIME': return base;
      default: return type;
    }
  }

  if (to === 'mariadb') {
    if (isArray) return 'JSON';
    switch (base) {
      case 'SERIAL': case 'INT4': case 'INTEGER': return 'INT';
      case 'BIGSERIAL': case 'INT8': return 'BIGINT';
      case 'SMALLSERIAL': case 'INT2': return 'SMALLINT';
      case 'BOOL': return 'BOOLEAN';
      case 'CHARACTER VARYING': return withArgs('VARCHAR', args ?? '255');
      case 'VARCHAR': return withArgs('VARCHAR', args ?? '255');
      case 'CHARACTER': return withArgs('CHAR');
      case 'TIMESTAMPTZ': case 'TIMESTAMP WITH TIME ZONE': return withArgs('TIMESTAMP');
      case 'TIMESTAMP':
        return suffix.includes('WITH TIME ZONE') && !suffix.includes('WITHOUT') ? withArgs('TIMESTAMP') : withArgs('DATETIME');
      case 'TIMETZ': case 'TIME WITH TIME ZONE': return 'TIME';
      case 'JSONB': return 'JSON';
      case 'BYTEA': return 'LONGBLOB';
      case 'NUMERIC': return withArgs('DECIMAL');
      case 'REAL': case 'FLOAT4': return 'FLOAT';
      case 'DOUBLE PRECISION': case 'FLOAT8': return 'DOUBLE';
      case 'MONEY': return 'DECIMAL(19,4)';
      case 'INET': return 'VARCHAR(45)';
      case 'CIDR': return 'VARCHAR(49)';
      case 'MACADDR': return 'VARCHAR(17)';
      case 'INTERVAL': return 'VARCHAR(64)';
      case 'TSVECTOR': case 'XML': return 'TEXT';
      case 'OID': return 'INT UNSIGNED';
      case 'BIT VARYING': case 'VARBIT': return 'BIT(64)';
      default: return type;
    }
  }

  // to === 'postgresql'
  const unsigned = suffix.includes('UNSIGNED');
  switch (base) {
    case 'TINYINT': return args === '1' ? 'BOOLEAN' : 'SMALLINT';
    case 'SMALLINT': return unsigned ? 'INTEGER' : 'SMALLINT';
    case 'MEDIUMINT': return 'INTEGER';
    case 'INT': case 'INTEGER': return unsigned ? 'BIGINT' : 'INTEGER';
    case 'BIGINT': return unsigned ? 'NUMERIC(20)' : 'BIGINT';
    case 'BIT': return args === '1' || !args ? 'BOOLEAN' : withArgs('BIT');
    case 'DOUBLE': return 'DOUBLE PRECISION';
    case 'FLOAT': return args && args.includes(',') ? 'REAL' : 'REAL';
    case 'DECIMAL': case 'DEC': case 'FIXED': return withArgs('NUMERIC');
    case 'DATETIME': return 'TIMESTAMP';
    case 'TIMESTAMP': return 'TIMESTAMPTZ';
    case 'YEAR': return 'SMALLINT';
    case 'TINYTEXT': case 'MEDIUMTEXT': case 'LONGTEXT': return 'TEXT';
    case 'TINYBLOB': case 'BLOB': case 'MEDIUMBLOB': case 'LONGBLOB': case 'VARBINARY': case 'BINARY': return 'BYTEA';
    case 'JSON': return 'JSONB';
    case 'ENUM': case 'SET': return 'TEXT';
    case 'INET6': case 'INET4': return 'INET';
    case 'GEOMETRY': case 'POINT': case 'LINESTRING': case 'POLYGON': return base === 'POINT' ? 'POINT' : 'TEXT';
    case 'VARCHAR': return withArgs('VARCHAR');
    case 'CHAR': return withArgs('CHAR');
    default: return type;
  }
}

/* ------------------------------------------------------------------ */
/* DuckDB                                                              */
/* ------------------------------------------------------------------ */

/**
 * DuckDB's nested type constructors, which splitType cannot take apart:
 * a LIST or ARRAY suffix (`INTEGER[]`, `DOUBLE[3]`), or STRUCT / MAP / UNION /
 * inline ENUM with their own parenthesised bodies.
 */
function duckdbListElement(norm: string): string | null {
  const m = /^(.*?)\s*\[\s*\d*\s*\]$/.exec(norm);
  return m ? m[1].trim() : null;
}

function isDuckdbNested(norm: string): boolean {
  return /^(STRUCT|MAP|UNION)\s*\(/i.test(norm);
}

/**
 * A column type as DuckDB spells it. DuckDB's type system is PostgreSQL's with
 * unsigned and 128-bit integers, LIST / STRUCT / MAP on top, and no length on
 * VARCHAR (a declared length is accepted and ignored, so it is kept as
 * documentation).
 */
function toDuckdb(type: string, from: Dialect): string {
  const norm = normalizeType(type);
  const { base, args, suffix } = splitType(norm);
  const withArgs = (b: string, a: string | null = args) => (a ? `${b}(${a})` : b);
  const unsigned = suffix.includes('UNSIGNED');
  if (suffix.includes('[]')) {
    // A PostgreSQL array becomes a DuckDB list of the translated element type.
    const element = norm.replace(/(\s*\[\])+$/, '');
    return `${toDuckdb(element, from)}[]`;
  }
  switch (base) {
    case 'SERIAL': case 'INT4': case 'INT': case 'INTEGER': case 'MEDIUMINT': return unsigned ? 'UINTEGER' : 'INTEGER';
    case 'BIGSERIAL': case 'INT8': case 'BIGINT': return unsigned ? 'UBIGINT' : 'BIGINT';
    case 'SMALLSERIAL': case 'INT2': case 'SMALLINT': return unsigned ? 'USMALLINT' : 'SMALLINT';
    case 'TINYINT':
      if (from === 'mariadb' && args === '1') return 'BOOLEAN';
      return unsigned ? 'UTINYINT' : 'TINYINT';
    case 'BOOL': case 'BOOLEAN': return 'BOOLEAN';
    case 'BIT':
      // MariaDB's BIT(1) is its boolean; PostgreSQL's BIT(n) is a bit string, which DuckDB has too.
      if (from === 'mariadb' && (args === '1' || !args)) return 'BOOLEAN';
      return 'BIT';
    case 'BIT VARYING': case 'VARBIT': return 'BIT';
    case 'NUMERIC': case 'DECIMAL': case 'DEC': case 'FIXED': return withArgs('DECIMAL');
    case 'MONEY': return 'DECIMAL(19,4)';
    case 'REAL': return from === 'sqlite' ? 'DOUBLE' : 'FLOAT';
    case 'FLOAT4': return 'FLOAT';
    case 'FLOAT': return from === 'mariadb' && args && Number(args.split(',')[0]) > 24 ? 'DOUBLE' : 'FLOAT';
    case 'DOUBLE': case 'DOUBLE PRECISION': case 'FLOAT8': return 'DOUBLE';
    case 'CHAR': case 'CHARACTER': case 'NCHAR': return withArgs('CHAR');
    case 'VARCHAR': case 'CHARACTER VARYING': case 'NVARCHAR': return withArgs('VARCHAR');
    case 'TEXT': case 'TINYTEXT': case 'MEDIUMTEXT': case 'LONGTEXT': case 'CITEXT': case 'CLOB': return 'VARCHAR';
    case 'BYTEA': case 'BLOB': case 'TINYBLOB': case 'MEDIUMBLOB': case 'LONGBLOB': case 'VARBINARY': case 'BINARY': return 'BLOB';
    case 'DATE': return 'DATE';
    case 'TIME': return suffix.includes('WITH TIME ZONE') && !suffix.includes('WITHOUT') ? 'TIMETZ' : 'TIME';
    case 'TIMETZ': case 'TIME WITH TIME ZONE': return 'TIMETZ';
    case 'TIMESTAMP':
      // MariaDB's TIMESTAMP is stored normalised to UTC, which is what TIMESTAMPTZ means.
      return (suffix.includes('WITH TIME ZONE') && !suffix.includes('WITHOUT')) || from === 'mariadb' ? 'TIMESTAMPTZ' : 'TIMESTAMP';
    case 'TIMESTAMPTZ': case 'TIMESTAMP WITH TIME ZONE': return 'TIMESTAMPTZ';
    case 'DATETIME': return 'TIMESTAMP';
    case 'YEAR': return 'SMALLINT';
    case 'INTERVAL': return 'INTERVAL';
    case 'JSON': case 'JSONB': return 'JSON';
    case 'UUID': return 'UUID';
    // MariaDB's inline ENUM('a','b') is legal DuckDB as written; SET has no counterpart.
    case 'ENUM': return args ? withArgs('ENUM') : 'VARCHAR';
    case 'SET': return 'VARCHAR';
    case 'INET': return 'INET';
    case 'INET6': case 'INET4': return 'VARCHAR(45)';
    case 'CIDR': return 'VARCHAR(49)';
    case 'MACADDR': return 'VARCHAR(17)';
    case 'XML': case 'TSVECTOR': case 'HSTORE': return 'VARCHAR';
    case 'POINT': case 'LINESTRING': case 'POLYGON': case 'GEOMETRY': case 'GEOGRAPHY': return 'GEOMETRY';
    case 'OID': return 'UINTEGER';
    default: return type;
  }
}

/**
 * A DuckDB type in PostgreSQL's spelling, the nearest engine. Lists become
 * arrays element by element; STRUCT / MAP / UNION have no relational
 * counterpart and become JSONB; unsigned and 128-bit integers widen to what
 * still holds every value.
 */
function duckdbToPostgres(type: string): string {
  const norm = normalizeType(type);
  const element = duckdbListElement(norm);
  if (element !== null) return `${duckdbToPostgres(element)}[]`;
  if (isDuckdbNested(norm)) return 'JSONB';
  if (/^ENUM\s*\(/i.test(norm)) return 'TEXT';
  const { base, args } = splitType(norm);
  const withArgs = (b: string, a: string | null = args) => (a ? `${b}(${a})` : b);
  switch (base) {
    case 'HUGEINT': case 'UHUGEINT': case 'INT128': return 'NUMERIC(39,0)';
    case 'UBIGINT': return 'NUMERIC(20,0)';
    case 'UINTEGER': return 'BIGINT';
    case 'USMALLINT': return 'INTEGER';
    case 'UTINYINT': case 'TINYINT': case 'INT1': case 'SHORT': return 'SMALLINT';
    case 'SIGNED': case 'INT': case 'INT4': return 'INTEGER';
    case 'LONG': case 'INT8': return 'BIGINT';
    case 'INT2': return 'SMALLINT';
    case 'STRING': case 'BPCHAR': return 'TEXT';
    case 'FLOAT': case 'FLOAT4': return 'REAL';
    case 'DOUBLE': case 'FLOAT8': return 'DOUBLE PRECISION';
    case 'DECIMAL': case 'DEC': return withArgs('NUMERIC');
    case 'BLOB': case 'BINARY': case 'VARBINARY': return 'BYTEA';
    case 'DATETIME': case 'TIMESTAMP_S': case 'TIMESTAMP_MS': case 'TIMESTAMP_NS': return 'TIMESTAMP';
    case 'BIT': case 'BITSTRING': return 'VARBIT';
    case 'JSON': return 'JSONB';
    case 'VARINT': case 'BIGNUM': return 'NUMERIC';
    case 'LOGICAL': case 'BOOL': return 'BOOLEAN';
    default: return type;
  }
}

function fromDuckdb(type: string, to: Dialect): string {
  const pg = duckdbToPostgres(type);
  if (to === 'postgresql') return pg;
  if (to === 'mariadb') {
    // MariaDB has unsigned integers of its own, so keep them rather than widening.
    const { base, suffix } = splitType(normalizeType(type));
    if (!suffix.includes('[]')) {
      switch (base) {
        case 'UTINYINT': return 'TINYINT UNSIGNED';
        case 'USMALLINT': return 'SMALLINT UNSIGNED';
        case 'UINTEGER': return 'INT UNSIGNED';
        case 'UBIGINT': return 'BIGINT UNSIGNED';
        case 'TINYINT': case 'INT1': return 'TINYINT';
        default: break;
      }
    }
  }
  return translateType(pg, 'postgresql', to);
}
