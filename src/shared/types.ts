/**
 * Core data model shared by the browser client and the local API server.
 *
 * A Diagram is the unit that gets saved/loaded (.dbviz.json). Everything the
 * canvas shows is derived from it: tables become nodes, relationships become
 * edges.
 */

export type Dialect = 'postgresql' | 'mariadb';

export const DIALECTS: { id: Dialect; label: string; defaultPort: number; defaultUser: string; image: string }[] = [
  { id: 'postgresql', label: 'PostgreSQL', defaultPort: 5432, defaultUser: 'postgres', image: 'postgres:16' },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, defaultUser: 'root', image: 'mariadb:11' },
];

export type ReferentialAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export const REFERENTIAL_ACTIONS: ReferentialAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

export interface Column {
  id: string;
  name: string;
  /** Raw SQL type as the user typed it, e.g. "VARCHAR(255)" or "INT UNSIGNED". */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** SERIAL / IDENTITY (PostgreSQL) or AUTO_INCREMENT (MariaDB). */
  autoIncrement: boolean;
  /** Raw default expression, e.g. "now()" or "'pending'" or "0". */
  defaultValue?: string;
  /** CHECK constraint body (without the CHECK keyword or outer parens). */
  check?: string;
  comment?: string;
}

export interface Index {
  id: string;
  name: string;
  columnIds: string[];
  unique: boolean;
}

export type CustomTypeKind = 'enum' | 'composite';

export interface CustomTypeField {
  id: string;
  name: string;
  /** Raw SQL type, same convention as Column.type. Can itself be another custom type's name. */
  type: string;
  comment?: string;
}

/**
 * A user-defined type, scoped to the whole diagram so it can be reused across
 * tables/columns the way a real CREATE TYPE would be. Two kinds:
 *  - enum: a fixed set of string values (Postgres: CREATE TYPE ... AS ENUM;
 *    MariaDB has no named enum type, so it's inlined as ENUM(...) per column).
 *  - composite: named sub-fields, like a struct (Postgres: CREATE TYPE ... AS
 *    (...); MariaDB has no equivalent and falls back to JSON).
 */
export interface CustomType {
  id: string;
  name: string;
  kind: CustomTypeKind;
  /** enum kind only, ordered. */
  values?: string[];
  /** composite kind only. */
  fields?: CustomTypeField[];
  comment?: string;
}

export interface Table {
  id: string;
  name: string;
  schema?: string;
  columns: Column[];
  indexes: Index[];
  /** Table-level CHECK constraints (bodies only). */
  checks: string[];
  position: { x: number; y: number };
  /** Key into the palette in src/lib/palette.ts. */
  color: string;
  comment?: string;
}

/**
 * fk   -> a real FOREIGN KEY constraint, emitted into DDL. sourceTable holds
 *         the referencing columns, targetTable the referenced ones.
 * flow -> a data-flow annotation: "rows in target are derived from source via
 *         this query". Drawn dashed, never emitted into DDL.
 */
export type RelationshipKind = 'fk' | 'flow';

export type AggregateFunction = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';

export const AGGREGATE_FUNCTIONS: AggregateFunction[] = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];

/**
 * One derived column on a flow relationship: "this target column is filled with
 * <aggregate>(<expression>) computed over source rows, grouped by <groupBy> and
 * restricted by <filter>".
 *
 * This is the structured counterpart of Relationship.query: enough shape for the
 * app to render a summary and generate an INSERT ... SELECT skeleton, without
 * pretending to be a SQL parser. Anything that does not fit (extra joins, window
 * functions, upsert logic) still belongs in the free-text query, which coexists
 * with these entries rather than being replaced by them.
 */
export interface Derivation {
  id: string;
  /**
   * Column of the relationship's target table that this derivation populates.
   * Empty (or pointing at a deleted column) means the entry is incomplete: it is
   * kept but skipped by the generator.
   */
  targetColumnId: string;
  /** Source-side expression as free text, e.g. "quantity * unit_price_cents". */
  expression: string;
  /** Aggregate wrapped around the expression; null/undefined means a plain per-row value. */
  aggregate?: AggregateFunction | null;
  /**
   * Grouping keys as free text: usually source column names ("product_id"), but
   * a key may also be an expression or a column pulled in by a join ("day").
   */
  groupBy: string[];
  /** Optional WHERE-style condition, free text, e.g. "status = 'paid'". */
  filter?: string;
}

export interface Relationship {
  id: string;
  kind: RelationshipKind;
  /** Referencing (child / "many") table. */
  sourceTableId: string;
  sourceColumnIds: string[];
  /** Referenced (parent / "one") table. */
  targetTableId: string;
  targetColumnIds: string[];
  /** Constraint name for FKs; free label for flows. */
  name?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  /** Optional SQL that explains how data crosses this connection. */
  query?: string;
  /** Free-text note shown next to the query. */
  note?: string;
  /**
   * Structured "how each target column is computed" metadata for flow links, one
   * entry per derived target column. Coexists with `query`: the structured form
   * drives the summaries and the generated skeleton, the free text covers what it
   * cannot express.
   */
  derivations?: Derivation[];
}

export interface Note {
  id: string;
  text: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  color: string;
}

export interface Diagram {
  version: 1;
  name: string;
  dialect: Dialect;
  tables: Table[];
  relationships: Relationship[];
  notes: Note[];
  customTypes: CustomType[];
  /** Saved viewport, purely cosmetic. */
  viewport?: { x: number; y: number; zoom: number };
}

/* ------------------------------------------------------------------ */
/* Server API contracts                                                */
/* ------------------------------------------------------------------ */

export interface ConnectionConfig {
  dialect: Dialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  dialect: Dialect | null;
  managed: boolean;
  /** Host port bound to the database port, if any. */
  hostPort: number | null;
  /** Best-effort connection details recovered from the container's env. */
  connection: Partial<ConnectionConfig> | null;
}

export interface CreateContainerRequest {
  dialect: Dialect;
  name: string;
  hostPort: number;
  password: string;
  database: string;
  user?: string;
  /** Docker image tag override, e.g. "postgres:15". */
  image?: string;
}

export interface ApplySchemaRequest {
  connection: ConnectionConfig;
  statements: string[];
  /** Stop executing after the first failure (default true). */
  stopOnError?: boolean;
}

export interface StatementResult {
  index: number;
  sql: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface ApplySchemaResponse {
  ok: boolean;
  results: StatementResult[];
}

/** Normalised schema returned by /api/db/introspect. */
export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  comment: string | null;
}

export interface IntrospectedForeignKey {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface IntrospectedTable {
  schema: string;
  name: string;
  comment: string | null;
  columns: IntrospectedColumn[];
  primaryKey: string[];
  uniques: { name: string; columns: string[] }[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: IntrospectedForeignKey[];
}

export interface IntrospectResponse {
  serverVersion: string;
  tables: IntrospectedTable[];
}
