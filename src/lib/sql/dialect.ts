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

export function isReserved(name: string): boolean {
  return RESERVED.has(name.toUpperCase());
}

/** Quote an identifier only when needed, in the dialect's style. */
export function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === 'postgresql') {
    if (/^[a-z_][a-z0-9_]*$/.test(name) && !isReserved(name)) return name;
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isReserved(name)) return name;
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Quote a qualified name (schema.table) part by part. */
export function quoteQualified(name: string, schema: string | undefined, dialect: Dialect): string {
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
  return /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL)$/.test(base);
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
  const { base, args, suffix } = splitType(type);
  const withArgs = (b: string, a: string | null = args) => (a ? `${b}(${a})` : b);
  const isArray = suffix.includes('[]');

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
