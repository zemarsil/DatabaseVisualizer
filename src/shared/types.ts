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
