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
 * How a connection is *realised in the database*. This is the mechanical half
 * of a relationship: it decides what reaches the DDL, whether a trace can JOIN
 * across the connection, and how the edge is drawn.
 *
 * fk         -> a real FOREIGN KEY constraint, emitted into DDL. sourceTable holds
 *               the referencing columns, targetTable the referenced ones.
 * flow       -> a data-flow annotation: "rows in target are derived from source via
 *               this query". Drawn dashed, never emitted into DDL.
 * embed      -> the target's rows live *inside* a column of the source, serialised
 *               (JSONB, an array, a blob, a packed string). Nothing constrains that,
 *               so nothing is emitted into DDL; sourceColumnIds[0] is the column
 *               holding them.
 * dependency -> a logical dependency with nothing enforcing it and no rows moving:
 *               "source uses target" via application code, a view, or a job.
 */
export type RelationshipKind = 'fk' | 'flow' | 'embed' | 'dependency';

export interface RelationshipKindMeta {
  id: RelationshipKind;
  label: string;
  /** Compact tag for chips and lists. */
  short: string;
  hint: string;
  /** Matching column pairs are the whole point of the connection (and required). */
  needsColumnPairs: boolean;
  /** The connection turns into executable DDL. */
  emitsDdl: boolean;
  /** A trace can build a JOIN condition from it. */
  joinable: boolean;
}

export const RELATIONSHIP_KINDS: RelationshipKindMeta[] = [
  {
    id: 'fk',
    label: 'Foreign key',
    short: 'FK',
    hint: 'A real FOREIGN KEY constraint. It is written into the CREATE TABLE script and the database enforces it.',
    needsColumnPairs: true,
    emitsDdl: true,
    joinable: true,
  },
  {
    id: 'flow',
    label: 'Data flow',
    short: 'flow',
    hint: 'Rows in the target are produced from the source by an ETL step, a rollup, or a trigger. Drawn dashed; never emitted as DDL.',
    needsColumnPairs: false,
    emitsDdl: false,
    joinable: false,
  },
  {
    id: 'embed',
    label: 'Serialized',
    short: 'embed',
    hint: "The target's rows are stored serialized inside one column of the source (JSONB, an array, a blob). No constraint exists to emit, so it is documentation only.",
    needsColumnPairs: false,
    emitsDdl: false,
    joinable: false,
  },
  {
    id: 'dependency',
    label: 'Dependency',
    short: 'uses',
    hint: 'The source depends on the target without a constraint and without moving rows: a view, a job, or application code reads it. Documentation only.',
    needsColumnPairs: false,
    emitsDdl: false,
    joinable: false,
  },
];

/**
 * How a connection *reads in English*. This is the semantic half: it never
 * changes the DDL, it changes the sentence the diagram tells you.
 *
 * Every verb is stored in the source -> target direction, so its inverse is
 * what you get reading the edge backwards. That is where "has", "contains" and
 * "used by" come from: they are the inverses of "belongs to", "is part of" and
 * "uses", which is also why they need no separate connection of their own.
 */
export type RelationshipVerb =
  | 'references'
  | 'belongs-to'
  | 'part-of'
  | 'extends'
  | 'uses'
  | 'feeds'
  | 'mirrors'
  | 'serializes'
  | 'embeds';

export interface RelationshipVerbMeta {
  id: RelationshipVerb;
  /** Reads source -> target: "order_items belongs to orders". */
  forward: string;
  /** Reads target -> source: "orders has order_items". */
  inverse: string;
  /** Kinds this verb can describe. */
  kinds: RelationshipKind[];
  hint: string;
}

export const RELATIONSHIP_VERBS: RelationshipVerbMeta[] = [
  {
    id: 'references',
    forward: 'references',
    inverse: 'referenced by',
    kinds: ['fk'],
    hint: 'A plain association: the child points at a row of the parent and nothing is implied about ownership.',
  },
  {
    id: 'belongs-to',
    forward: 'belongs to',
    inverse: 'has',
    kinds: ['fk'],
    hint: 'Ownership: the parent has these rows. Usually paired with ON DELETE CASCADE.',
  },
  {
    id: 'part-of',
    forward: 'is part of',
    inverse: 'contains',
    kinds: ['fk'],
    hint: 'Composition: the child is a piece of the parent and is meaningless on its own (an order line, an invoice row).',
  },
  {
    id: 'extends',
    forward: 'extends',
    inverse: 'extended by',
    kinds: ['fk'],
    hint: 'Subtyping: the child adds columns to one row of the parent, usually sharing its primary key.',
  },
  {
    id: 'uses',
    forward: 'uses',
    inverse: 'used by',
    kinds: ['fk', 'dependency'],
    hint: 'Consumption: the source reads the target (a lookup table, reference data, a service another job depends on).',
  },
  {
    id: 'feeds',
    forward: 'feeds',
    inverse: 'fed by',
    kinds: ['flow'],
    hint: 'The source is the input the target is built from.',
  },
  {
    id: 'mirrors',
    forward: 'mirrors',
    inverse: 'mirrored by',
    kinds: ['flow'],
    hint: 'The target is kept as a copy of the source by replication or change data capture.',
  },
  {
    id: 'serializes',
    forward: 'serializes',
    inverse: 'serialized into',
    kinds: ['embed'],
    hint: "The source stores the target's rows encoded in a column instead of joining to them.",
  },
  {
    id: 'embeds',
    forward: 'embeds',
    inverse: 'embedded in',
    kinds: ['embed'],
    hint: "The target's shape is inlined into the source as a nested document or array.",
  },
];

/** Verb used when a relationship does not name one. */
export const DEFAULT_VERBS: Record<RelationshipKind, RelationshipVerb> = {
  fk: 'references',
  flow: 'feeds',
  embed: 'serializes',
  dependency: 'uses',
};

export interface Relationship {
  id: string;
  kind: RelationshipKind;
  /**
   * How the connection reads, source -> target. Omitted means DEFAULT_VERBS[kind],
   * which is what every file written before verbs existed means.
   */
  verb?: RelationshipVerb;
  /** Referencing (child / "many") table; the container for an embed. */
  sourceTableId: string;
  /** For an embed, [0] is the column the target is serialized into. */
  sourceColumnIds: string[];
  /** Referenced (parent / "one") table; the embedded shape for an embed. */
  targetTableId: string;
  targetColumnIds: string[];
  /** Constraint name for FKs; free label for everything else. */
  name?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  /** Optional SQL that explains how data crosses this connection. */
  query?: string;
  /** Free-text note shown next to the query. */
  note?: string;
}

const KIND_FALLBACK = RELATIONSHIP_KINDS[0];

export function kindMeta(kind: RelationshipKind): RelationshipKindMeta {
  return RELATIONSHIP_KINDS.find((k) => k.id === kind) ?? KIND_FALLBACK;
}

export function isRelationshipKind(v: unknown): v is RelationshipKind {
  return typeof v === 'string' && RELATIONSHIP_KINDS.some((k) => k.id === v);
}

export function verbsForKind(kind: RelationshipKind): RelationshipVerbMeta[] {
  return RELATIONSHIP_VERBS.filter((v) => v.kinds.includes(kind));
}

/**
 * Keep a verb and a kind consistent. Returns undefined when the verb is absent
 * or does not apply to the kind, which callers read as "the kind's default" —
 * so switching kind in the inspector never leaves a nonsense pairing behind.
 */
export function normalizeVerb(kind: RelationshipKind, verb: unknown): RelationshipVerb | undefined {
  const meta = RELATIONSHIP_VERBS.find((v) => v.id === verb);
  return meta && meta.kinds.includes(kind) ? meta.id : undefined;
}

export function relationshipVerb(r: Pick<Relationship, 'kind' | 'verb'>): RelationshipVerbMeta {
  const id = normalizeVerb(r.kind, r.verb) ?? DEFAULT_VERBS[r.kind] ?? DEFAULT_VERBS.fk;
  return RELATIONSHIP_VERBS.find((v) => v.id === id)!;
}

/** The verb as read from one end: "order_items belongs to orders" / "orders has order_items". */
export function verbLabel(r: Pick<Relationship, 'kind' | 'verb'>, direction: 'forward' | 'inverse'): string {
  const v = relationshipVerb(r);
  return direction === 'forward' ? v.forward : v.inverse;
}

/** Full sentence for a connection, e.g. "orders contains order_items". */
export function describeRelationship(r: Pick<Relationship, 'kind' | 'verb'>, sourceName: string, targetName: string, direction: 'forward' | 'inverse' = 'forward'): string {
  return direction === 'forward'
    ? `${sourceName} ${verbLabel(r, 'forward')} ${targetName}`
    : `${targetName} ${verbLabel(r, 'inverse')} ${sourceName}`;
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
