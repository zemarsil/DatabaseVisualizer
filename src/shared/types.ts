/**
 * Core data model shared by the browser client and the local API server.
 *
 * A Diagram is the unit that gets saved/loaded (.dbviz.json). Everything the
 * canvas shows is derived from it: tables become nodes, relationships become
 * edges, and the code map's programs, modules, classes and functions become
 * nodes of their own. Both halves are optional — a diagram holding only code is
 * as complete as one holding only tables.
 */

export type Dialect = 'postgresql' | 'mariadb' | 'sqlite' | 'duckdb';

/**
 * Dialects whose engine runs inside the browser (sql.js for SQLite, DuckDB-Wasm
 * for DuckDB): no server, no Docker, no host or port to connect to.
 */
export type EmbeddedDialect = 'sqlite' | 'duckdb';

/** Dialects that run as a server the API talks to (everything except the in-browser engines). */
export type ServerDialect = Exclude<Dialect, EmbeddedDialect>;

export interface DialectMeta {
  id: Dialect;
  label: string;
  /** False for SQLite and DuckDB, which run inside the browser and need no server or Docker. */
  server: boolean;
  defaultPort: number;
  defaultUser: string;
  image: string;
}

export const DIALECTS: DialectMeta[] = [
  { id: 'postgresql', label: 'PostgreSQL', server: true, defaultPort: 5432, defaultUser: 'postgres', image: 'postgres:16' },
  { id: 'mariadb', label: 'MariaDB', server: true, defaultPort: 3306, defaultUser: 'root', image: 'mariadb:11' },
  { id: 'sqlite', label: 'SQLite (in browser)', server: false, defaultPort: 0, defaultUser: '', image: '' },
  { id: 'duckdb', label: 'DuckDB (in browser)', server: false, defaultPort: 0, defaultUser: '', image: '' },
];

export const SERVER_DIALECTS = DIALECTS.filter((d) => d.server);

export const EMBEDDED_DIALECTS: EmbeddedDialect[] = ['sqlite', 'duckdb'];

export function isEmbeddedDialect(d: Dialect): d is EmbeddedDialect {
  return d === 'sqlite' || d === 'duckdb';
}

export function isServerDialect(d: Dialect): d is ServerDialect {
  return !isEmbeddedDialect(d);
}

/**
 * The engine's name as it reads mid-sentence. DIALECTS labels the in-browser
 * engines "SQLite (in browser)" / "DuckDB (in browser)", which is right for a
 * picker and wrong for a message.
 */
export function engineName(d: Dialect): string {
  switch (d) {
    case 'postgresql':
      return 'PostgreSQL';
    case 'mariadb':
      return 'MariaDB';
    case 'sqlite':
      return 'SQLite';
    case 'duckdb':
      return 'DuckDB';
    default:
      return d;
  }
}

export function dialectLabel(d: Dialect): string {
  return DIALECTS.find((x) => x.id === d)?.label ?? d;
}

/* ------------------------------------------------------------------ */
/* Extensions                                                          */
/* ------------------------------------------------------------------ */

/**
 * An engine extension the schema depends on: PostGIS, pgvector, pg_trgm, a
 * MariaDB storage-engine plugin, an SQLite loadable module.
 *
 * Only the declaration is stored — the name, and optionally where and which
 * version — never the extension's own definitions. What an extension *provides*
 * (its types, its functions, its index methods) lives in a catalog outside the
 * diagram (src/lib/extensions), so a file stays small and still loads on a
 * machine that has never heard of the extension: the DDL is generated from the
 * name alone, and only the autocomplete and the lint hints go quiet.
 */
export interface DiagramExtension {
  id: string;
  /** Exactly as the engine spells it: "postgis", "vector", "uuid-ossp", "ha_connect". */
  name: string;
  /** PostgreSQL: the schema to install into. Omitted means the server's default. */
  schema?: string;
  /** Pinned version, e.g. "3.4.2". Omitted means whatever the server offers. */
  version?: string;
  /** Why this schema needs it. */
  comment?: string;
}

/** A type an extension adds, as it would be written in a column definition. */
export interface ExtensionType {
  /** Base name, e.g. "geometry" or "vector". */
  name: string;
  /** How the type reads with its arguments filled in, e.g. "vector(1536)"; used for autocomplete. */
  example?: string;
  summary?: string;
}

/** A function an extension adds. `name` is the bare name; `example` is a call you could paste into a DEFAULT. */
export interface ExtensionFunction {
  name: string;
  example?: string;
  summary?: string;
}

/** How the engine is told to enable an extension, which decides what the generator writes. */
export type ExtensionInstall =
  /** PostgreSQL: CREATE EXTENSION IF NOT EXISTS ... */
  | 'create-extension'
  /** MariaDB: INSTALL SONAME '...' */
  | 'install-soname'
  /** DuckDB: INSTALL name; LOAD name; — fetched once from the extension repository, loaded per session. */
  | 'install-load'
  /** SQLite: loaded by the client before it opens the database; nothing executable to emit. */
  | 'client-loaded'
  /** Compiled into the engine (SQLite FTS5, PostgreSQL plpgsql, DuckDB's core_functions): present or not, never installed. */
  | 'built-in';

/**
 * What one extension is and what it brings with it. Definitions come from three
 * places, and `source` says which: `bundled` (shipped with the app), `pack`
 * (a JSON file the user loaded) and `database` (read back off a live server,
 * which is the only one that is authoritative for that server).
 */
export interface ExtensionDef {
  name: string;
  dialect: Dialect;
  /** Display name, e.g. "PostGIS". Defaults to `name` when absent. */
  label?: string;
  summary?: string;
  install?: ExtensionInstall;
  docsUrl?: string;
  types?: ExtensionType[];
  functions?: ExtensionFunction[];
  /**
   * Index access methods it *adds*, e.g. pgvector's ["hnsw", "ivfflat"] — the
   * same thing a server reports for it. Most extensions add none: gist, gin,
   * spgist and brin are built into PostgreSQL, and an extension supplies
   * operator classes for them, which belong in `operatorClasses`.
   */
  indexMethods?: string[];
  /** Operator classes it adds, e.g. ["gin_trgm_ops"]. */
  operatorClasses?: string[];
  /** Other extensions that must be enabled first. */
  requires?: string[];
  /** Anything worth knowing before enabling it: privileges, licensing, gotchas. */
  note?: string;
  source?: 'bundled' | 'pack' | 'database';
  /** Id of the pack this definition came from, when source is 'pack'. */
  packId?: string;
}

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

/** table -> a real table. view -> CREATE VIEW; its SELECT lives in viewSql and its inputs are flow links. */
export type TableKind = 'table' | 'view';

/**
 * How long a table's data lives. Absent means an ordinary, permanent table.
 *
 * - `unlogged`: kept but not written to the write-ahead log, so writes are
 *   faster and the rows are lost after a crash. PostgreSQL only.
 * - `temporary`: dropped automatically, when the session ends (or, with
 *   `onCommit: 'drop'`, when the transaction does). Every dialect has one.
 */
export type TableStorage = 'unlogged' | 'temporary';

/** What a PostgreSQL temporary table does at the end of each transaction. */
export type TempOnCommit = 'preserve' | 'delete' | 'drop';

/** How much of a table the canvas shows. Undefined means every column. */
export type TableDisplay = 'keys' | 'header';

export interface Table {
  id: string;
  name: string;
  schema?: string;
  /** Defaults to 'table' when absent. */
  kind?: TableKind;
  /** The SELECT body of a view (without CREATE VIEW ... AS). Ignored for tables. */
  viewSql?: string;
  /**
   * A view whose rows are stored and refreshed on demand rather than recomputed
   * on every query. PostgreSQL only: MariaDB and SQLite have no materialized
   * views, so the generator falls back to a plain CREATE VIEW there (with a
   * warning). The flag is kept either way, so switching dialect and back does
   * not lose it. Ignored when kind is not 'view'.
   */
  materialized?: boolean;
  /**
   * Unlogged or temporary instead of permanent (see TableStorage). Ignored for
   * views. Kept when the dialect cannot express it, so switching dialect and
   * back does not lose it; the generator warns and writes a plain table.
   */
  storage?: TableStorage;
  /** For a temporary table on PostgreSQL: what happens to its rows at commit. Absent means PRESERVE ROWS, the default. */
  onCommit?: TempOnCommit;
  columns: Column[];
  indexes: Index[];
  /** Table-level CHECK constraints (bodies only). */
  checks: string[];
  position: { x: number; y: number };
  /** Key into the palette in src/lib/palette.ts. */
  color: string;
  comment?: string;
  /** Group this table belongs to, if any (see Group). */
  groupId?: string;
  /** Collapsed rendering on the canvas; saved with the diagram because it is part of how a big schema is read. */
  collapsed?: TableDisplay;
}

/**
 * A labelled region of the canvas that keeps a set of tables together, e.g.
 * the tables that live in another database you read from.
 *
 * Membership lives on the tables (Table.groupId) and the region's rectangle is
 * derived from where its members sit, so auto-layout, imports and drags can
 * never leave a group and its box out of sync.
 */
export interface Group {
  id: string;
  name: string;
  /** Key into the palette in src/lib/palette.ts. */
  color: string;
  /**
   * True when these tables live in a different database: they document a source
   * you query rather than part of the schema being designed, so they are left
   * out of the generated CREATE TABLE script and out of anything run against a
   * live database.
   */
  external: boolean;
  /** Free text: which database this is, how it is reached, who owns it. */
  note?: string;
  /** Where the region sits while it has no member tables to derive it from. */
  position: { x: number; y: number };
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
    hint: "The target's rows are stored serialized inside one column of the source (JSONB, an array, a blob, a composite type). No constraint exists to emit, so it is documentation only.",
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

export type AggregateFunction = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';

export const AGGREGATE_FUNCTIONS: AggregateFunction[] = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];

/**
 * Sequence ("window") operations: the value of a row computed from its
 * neighbours once the source rows are put in order.
 *
 *  LAG / LEAD    -> the expression's value on the previous / next row
 *  DIFF          -> this row's value minus the previous row's ("time since the
 *                   last reading"); for dates and timestamps the result is a
 *                   number of days / seconds
 *  RUNNING_SUM   -> cumulative total up to and including this row
 *  RUNNING_AVG   -> cumulative average up to and including this row
 *  ROW_NUMBER    -> 1-based position in the order (the expression is ignored)
 *  RANK          -> like ROW_NUMBER but rows that tie share a rank
 */
export type WindowFunction = 'LAG' | 'LEAD' | 'DIFF' | 'RUNNING_SUM' | 'RUNNING_AVG' | 'ROW_NUMBER' | 'RANK';

export interface WindowFunctionMeta {
  id: WindowFunction;
  label: string;
  hint: string;
  /** ROW_NUMBER and RANK count rows; they never look at the expression. */
  needsExpression: boolean;
}

export const WINDOW_FUNCTIONS: WindowFunctionMeta[] = [
  { id: 'DIFF', label: 'Change since the previous row', hint: 'This row minus the previous one, e.g. the seconds between two readings.', needsExpression: true },
  { id: 'LAG', label: 'Previous row’s value', hint: 'The value the expression had on the row before this one (NULL on the first row).', needsExpression: true },
  { id: 'LEAD', label: 'Next row’s value', hint: 'The value the expression has on the row after this one (NULL on the last row).', needsExpression: true },
  { id: 'RUNNING_SUM', label: 'Running total', hint: 'Sum of the expression over every row up to and including this one.', needsExpression: true },
  { id: 'RUNNING_AVG', label: 'Running average', hint: 'Average of the expression over every row up to and including this one.', needsExpression: true },
  { id: 'ROW_NUMBER', label: 'Row number', hint: '1, 2, 3… in the given order, restarting in every partition.', needsExpression: false },
  { id: 'RANK', label: 'Rank', hint: 'Position in the given order; rows with equal ordering values share a rank.', needsExpression: false },
];

export function isWindowFunction(v: unknown): v is WindowFunction {
  return typeof v === 'string' && WINDOW_FUNCTIONS.some((w) => w.id === v);
}

export function windowMeta(fn: WindowFunction): WindowFunctionMeta {
  return WINDOW_FUNCTIONS.find((w) => w.id === fn) ?? WINDOW_FUNCTIONS[0];
}

/**
 * How a sequence derivation orders its rows: `orderBy` decides which row is
 * "previous" (a key may end in DESC), `partitionBy` restarts the sequence for
 * every distinct combination of keys, e.g. one series per sensor.
 */
export interface DerivationWindow {
  fn: WindowFunction;
  orderBy: string[];
  partitionBy: string[];
}

/**
 * One derived column on a flow relationship: "this target column is filled with
 * <aggregate>(<expression>) computed over source rows, grouped by <groupBy> and
 * restricted by <filter>", optionally after a sequence operation put the rows
 * in order and looked at their neighbours (<window>).
 *
 * Expressions, filters and keys are written in SQL. They may name a column of
 * the source table directly ("quantity") or a column of any table the source
 * points at through a chain of foreign keys as table.column ("orders.status"
 * from order_items): the app resolves the lookup from the diagram's foreign
 * keys, so the diagram itself says how the tables combine.
 *
 * This is the structured counterpart of Relationship.query: enough shape for the
 * app to render a summary, generate an INSERT ... SELECT and simulate the rows
 * that would move. Anything that does not fit (joins that are not foreign keys,
 * upsert logic) still belongs in the free-text query, which coexists with these
 * entries rather than being replaced by them.
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
   * a key may also be an expression ("CAST(orders.placed_at AS DATE)").
   */
  groupBy: string[];
  /** Optional WHERE-style condition, free text, e.g. "status = 'paid'". */
  filter?: string;
  /**
   * Sequence operation applied to the expression before any aggregate: the rows
   * are ordered, each row's value is computed from its neighbours, and only then
   * are rows grouped and aggregated (an AVG of DIFFs is "the mean gap").
   */
  window?: DerivationWindow;
}

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
  /** Constraint name for FKs; free label for everything else. Reads source -> target. */
  name?: string;
  /** Overrides the verb's inverse phrasing on the target end, e.g. "used by" against a "has". */
  inverseName?: string;
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

/* ------------------------------------------------------------------ */
/* Programs: the work that happens outside the database                */
/* ------------------------------------------------------------------ */

/**
 * The language a program is written in.
 *
 * The list is short on purpose: it exists so the app can pick a driver, a
 * comment marker and a placeholder style when it writes starter code, not to
 * catalogue every language there is. Anything not here is 'other', which still
 * gets a node, steps, prose and highlighting — only the generated skeleton
 * falls back to plain comments around the SQL.
 *
 * The last two are not languages anything runs. YAML and JSON hold values, so
 * a node written in one is a data file rather than code: see `data` below.
 */
export type ProgramLanguage =
  | 'python'
  | 'rust'
  | 'go'
  | 'cpp'
  | 'c'
  | 'java'
  | 'javascript'
  | 'typescript'
  | 'perl'
  | 'shell'
  | 'yaml'
  | 'json'
  | 'other';

export interface ProgramLanguageMeta {
  id: ProgramLanguage;
  label: string;
  /** Extension a saved snippet gets, and the fence tag in exported Markdown. */
  extension: string;
  /** Line-comment marker, used by the generated skeleton and the code scanner. */
  comment: string;
  /**
   * Values, not instructions: nothing computes in this language, so a node
   * written in it can only be a data file something else loads. Set on YAML
   * and JSON, and the reason `CodeKind` has a 'data' member.
   */
  data?: boolean;
}

export const PROGRAM_LANGUAGES: ProgramLanguageMeta[] = [
  { id: 'python', label: 'Python', extension: 'py', comment: '#' },
  { id: 'rust', label: 'Rust', extension: 'rs', comment: '//' },
  { id: 'go', label: 'Go', extension: 'go', comment: '//' },
  { id: 'cpp', label: 'C++', extension: 'cpp', comment: '//' },
  { id: 'c', label: 'C', extension: 'c', comment: '//' },
  { id: 'java', label: 'Java', extension: 'java', comment: '//' },
  { id: 'javascript', label: 'JavaScript', extension: 'js', comment: '//' },
  { id: 'typescript', label: 'TypeScript', extension: 'ts', comment: '//' },
  { id: 'perl', label: 'Perl', extension: 'pl', comment: '#' },
  { id: 'shell', label: 'Shell', extension: 'sh', comment: '#' },
  { id: 'yaml', label: 'YAML', extension: 'yaml', comment: '#', data: true },
  // JSON proper has no comment syntax at all. The marker is what the editor's
  // comment key writes and what the outline falls back to, and `//` is what
  // every editor and every JSONC-tolerant parser reads, so it is the least
  // wrong answer to a question the format does not have one for.
  { id: 'json', label: 'JSON', extension: 'json', comment: '//', data: true },
  { id: 'other', label: 'Other', extension: 'txt', comment: '#' },
];

export function isProgramLanguage(v: unknown): v is ProgramLanguage {
  return typeof v === 'string' && PROGRAM_LANGUAGES.some((l) => l.id === v);
}

/** The languages that hold values rather than code, in the order they are offered. */
export const DATA_LANGUAGES: ProgramLanguage[] = PROGRAM_LANGUAGES.filter((l) => l.data).map((l) => l.id);

/** The one a data file falls back to when something has to pick. */
export const DEFAULT_DATA_LANGUAGE: ProgramLanguage = 'yaml';

/** Whether nothing runs in this language: YAML and JSON, and nothing else. */
export function isDataLanguage(v: unknown): v is ProgramLanguage {
  return typeof v === 'string' && PROGRAM_LANGUAGES.some((l) => l.id === v && l.data === true);
}

const LANGUAGE_FALLBACK = PROGRAM_LANGUAGES[PROGRAM_LANGUAGES.length - 1];

export function programLanguageMeta(id: ProgramLanguage): ProgramLanguageMeta {
  return PROGRAM_LANGUAGES.find((l) => l.id === id) ?? LANGUAGE_FALLBACK;
}

/**
 * How the program runs. Documentation only: it changes the badge on the node
 * and the word the summaries use, never the generated code.
 */
export type ProgramRole = 'service' | 'job' | 'script' | 'etl';

export interface ProgramRoleMeta {
  id: ProgramRole;
  label: string;
  hint: string;
}

export const PROGRAM_ROLES: ProgramRoleMeta[] = [
  { id: 'service', label: 'Service', hint: 'Long-lived: it is up, holding connections, answering requests.' },
  { id: 'job', label: 'Scheduled job', hint: 'Woken on a timer or a queue, does its pass, exits.' },
  { id: 'script', label: 'Script', hint: 'Run by hand when someone needs it.' },
  { id: 'etl', label: 'ETL / pipeline', hint: 'Moves data in bulk from somewhere to somewhere else.' },
];

export function isProgramRole(v: unknown): v is ProgramRole {
  return typeof v === 'string' && PROGRAM_ROLES.some((r) => r.id === v);
}

export function programRoleMeta(id: ProgramRole): ProgramRoleMeta {
  return PROGRAM_ROLES.find((r) => r.id === id) ?? PROGRAM_ROLES[0];
}

/**
 * What one step of a program does.
 *
 * read    -> it runs a SELECT: rows travel from the table into the program.
 * write   -> it runs an INSERT, UPDATE or DELETE: rows travel the other way.
 * compute -> it does something the database never sees. This is the step that
 *            justifies the whole node: a rollup that could have been SQL does
 *            not need a program, and a fit, a render, a model call or a request
 *            to somebody else's API cannot be SQL at all.
 * call    -> it hands control (or data) to another code node: a function it
 *            calls, a class it constructs, a service it sends work to.
 * import  -> it depends on another module or the names inside one. Drawn
 *            separately from a call because "this file needs that file" is a
 *            fact about the build, not about what happens at run time.
 * extends -> the class this one inherits from.
 * load    -> it reads values out of a data file: a YAML or JSON file of
 *            settings, fixtures or a lookup table. Separate from an import
 *            because it happens at run time and the thing it names runs
 *            nothing, and separate from a read because a file is not a table.
 *
 * The last four name a code node rather than a table, and they are what turns
 * a program into a map of a codebase: a function body is a list of the things
 * it does, and a call is a row that names another function.
 */
export type ProgramStepOp = 'read' | 'write' | 'compute' | 'call' | 'import' | 'extends' | 'load';

export interface ProgramStepOpMeta {
  id: ProgramStepOp;
  label: string;
  /** Compact tag for the canvas and chip lists. */
  short: string;
  hint: string;
  /** The step names a table. */
  touchesDatabase: boolean;
  /** The step names another code node. Never true together with touchesDatabase. */
  namesCode: boolean;
}

export const PROGRAM_STEP_OPS: ProgramStepOpMeta[] = [
  { id: 'read', label: 'Read', short: 'read', hint: 'A SELECT: rows leave the table and arrive in the program.', touchesDatabase: true, namesCode: false },
  { id: 'write', label: 'Write', short: 'write', hint: 'An INSERT, UPDATE or DELETE: the program puts rows back.', touchesDatabase: true, namesCode: false },
  { id: 'compute', label: 'Compute', short: 'compute', hint: 'Work the database never sees, and the reason the program exists.', touchesDatabase: false, namesCode: false },
  { id: 'call', label: 'Call', short: 'call', hint: 'Hands control or data to another function, class or program.', touchesDatabase: false, namesCode: true },
  { id: 'import', label: 'Import', short: 'import', hint: 'Depends on another module, or on a name defined in one.', touchesDatabase: false, namesCode: true },
  { id: 'extends', label: 'Extends', short: 'extends', hint: 'Inherits from another class.', touchesDatabase: false, namesCode: true },
  { id: 'load', label: 'Load', short: 'load', hint: 'Reads values out of a YAML or JSON file: settings, fixtures, a lookup table.', touchesDatabase: false, namesCode: true },
];

/** The ops that name a code node rather than a table. */
export const CODE_STEP_OPS: ProgramStepOp[] = ['call', 'import', 'extends', 'load'];

export function isCodeStepOp(op: ProgramStepOp): op is 'call' | 'import' | 'extends' | 'load' {
  return op === 'call' || op === 'import' || op === 'extends' || op === 'load';
}

/**
 * Whether a step of this op may name a node of this kind.
 *
 * The one hard rule the data files bring with them: a data file is loaded and
 * never anything else — it cannot be called, imported or inherited from,
 * because there is nothing in it to run — and a load names a data file and
 * nothing else, because reading values out of a function is not a thing.
 */
export function canStepName(op: ProgramStepOp, kind: CodeKind, from?: CodeKind): boolean {
  if (!isCodeStepOp(op)) return false;
  // A procedure runs inside the database, so the only code it can reach is
  // another routine there, and the only thing anything does to one is call it:
  // there is no importing a stored procedure, or inheriting from it.
  if (from === 'procedure' && kind !== 'procedure') return false;
  if (kind === 'procedure') return op === 'call';
  return op === 'load' ? kind === 'data' : kind !== 'data';
}

/**
 * The ops a node of this kind may have steps of. A data file runs nothing, so
 * none; a procedure reads, writes, works and calls other routines, all inside
 * the database, and has no imports, bases or files to load.
 */
export function stepOpsForKind(kind: CodeKind): ProgramStepOp[] {
  if (kind === 'data') return [];
  if (kind === 'procedure') return ['read', 'write', 'compute', 'call'];
  return PROGRAM_STEP_OPS.map((o) => o.id);
}

export function isProgramStepOp(v: unknown): v is ProgramStepOp {
  return typeof v === 'string' && PROGRAM_STEP_OPS.some((o) => o.id === v);
}

export function programStepOpMeta(id: ProgramStepOp): ProgramStepOpMeta {
  return PROGRAM_STEP_OPS.find((o) => o.id === id) ?? PROGRAM_STEP_OPS[0];
}

/**
 * The op as the verb a sentence about it uses: "place_order *loads* config.yaml".
 *
 * Here rather than in the four places that were each spelling it out, because
 * a fifth op arriving should not mean finding them all again.
 */
const STEP_VERBS: Record<ProgramStepOp, string> = {
  read: 'reads',
  write: 'writes',
  compute: 'computes',
  call: 'calls',
  import: 'imports',
  extends: 'extends',
  load: 'loads',
};

export function stepVerb(op: ProgramStepOp): string {
  return STEP_VERBS[op] ?? op;
}

/**
 * One thing the program does, in the order it does it.
 *
 * The order is the point. A diagram can already say "this table feeds that
 * one"; what it could not say is that something outside reads a row, thinks
 * about it somewhere the database cannot see, and comes back to write the
 * answer down. Written as steps, that round trip reads off the canvas in
 * order: read jobs, compute, write results, update jobs.
 */
export interface ProgramStep {
  id: string;
  op: ProgramStepOp;
  /**
   * Table this step reads or writes. Always absent for a compute step, which
   * by definition does not touch the database, and for the steps that name
   * code; a step whose table was deleted keeps its prose and its code and is
   * reported by the linter.
   */
  tableId?: string;
  /**
   * Columns of that table the step touches. Empty means the whole row, which
   * is both the honest default and what `SELECT *` deserves to be called.
   */
  columnIds: string[];
  /**
   * The code node a call, import or extends step names. Only ever set on
   * those ops. Like `tableId` it is allowed to dangle: the node it pointed at
   * may be deleted, and the step's code and note survive it.
   */
  codeId?: string;
  /** The statement the program issues, as SQL. Meaningless on a compute step. */
  sql?: string;
  /** Host-language code for this step, in the program's language. */
  code?: string;
  /** What this step is for, in prose. */
  note?: string;
}

/**
 * What a code node is: a runnable program, one of the things a program is
 * made of, or the data file one of them reads.
 *
 * The first four kinds are the four levels a person drawing a codebase by hand
 * reaches for — files as the big boxes, classes inside them, functions as the
 * nodes — plus the program that runs it all as the root. Anything finer
 * (a method is a function inside a class; a package is a module inside a
 * module) is nesting, not a new kind, which keeps the vocabulary short enough
 * to read off a badge.
 *
 * 'data' is the one that is not code at all: a YAML or JSON file a program
 * pulls settings, fixtures or a lookup table out of. It is a kind of its own
 * rather than a module written in YAML because the difference is real and
 * worth enforcing — no computation happens in there, so it holds nothing, does
 * nothing, and the only arrow that may touch it is a load.
 *
 * 'procedure' is the other side of the line a program draws. A program is the
 * caller, outside the database; a stored procedure (or stored function) is
 * code the database itself holds and runs. It has steps like any other node —
 * what it reads, what it writes, what it calls, in order — but it is part of
 * the schema: the script creates it, a migration replaces it, reading a live
 * database brings it back. So it stands at the top level, never inside a
 * module, and it counts as the data half of the diagram rather than the code
 * half. See src/lib/procedures.ts.
 */
export type CodeKind = 'program' | 'module' | 'class' | 'function' | 'data' | 'procedure';

export interface CodeKindMeta {
  id: CodeKind;
  label: string;
  /** Plural, for counts and headings. */
  plural: string;
  hint: string;
  /** Can hold other code nodes. A function is the leaf of the map on purpose. */
  container: boolean;
  /** Kinds this one may sit inside. Empty means it is only ever a root. */
  parents: CodeKind[];
}

export const CODE_KINDS: CodeKindMeta[] = [
  { id: 'program', label: 'Program', plural: 'programs', hint: 'Something that runs: a service, a job, a script. The root of a code map.', container: true, parents: [] },
  { id: 'module', label: 'Module', plural: 'modules', hint: 'A file or a package: the big box the classes and functions live in.', container: true, parents: ['program', 'module'] },
  { id: 'class', label: 'Class', plural: 'classes', hint: 'A class, a struct, a type with methods.', container: true, parents: ['program', 'module', 'class'] },
  { id: 'function', label: 'Function', plural: 'functions', hint: 'A function or a method: the node whose steps say what it does.', container: false, parents: ['program', 'module', 'class'] },
  { id: 'data', label: 'Data file', plural: 'data files', hint: 'A YAML or JSON file other code loads. Nothing runs in it, so it has no steps.', container: false, parents: ['program', 'module'] },
  {
    id: 'procedure',
    label: 'Procedure',
    plural: 'procedures',
    hint: 'A stored procedure or function: code the database runs itself, created by the schema script alongside the tables it reads and writes.',
    container: false,
    parents: [],
  },
];

export function isCodeKind(v: unknown): v is CodeKind {
  return typeof v === 'string' && CODE_KINDS.some((k) => k.id === v);
}

export function codeKindMeta(kind: CodeKind): CodeKindMeta {
  return CODE_KINDS.find((k) => k.id === kind) ?? CODE_KINDS[0];
}

/** The kind of a code node, which every file written before code maps existed left unsaid. */
export function codeKindOf(p: Pick<Program, 'kind'>): CodeKind {
  return p.kind ?? 'program';
}

/** Whether a node of `child` kind may sit inside one of `parent` kind. */
export function canContain(parent: CodeKind, child: CodeKind): boolean {
  return codeKindMeta(parent).container && codeKindMeta(child).parents.includes(parent);
}

/** A node that holds values rather than code: a YAML or JSON file. */
export function isDataNode(p: Pick<Program, 'kind'>): boolean {
  return codeKindOf(p) === 'data';
}

/** A stored procedure or function: code the database holds, part of the schema rather than the code map. */
export function isProcedure(p: Pick<Program, 'kind'>): boolean {
  return codeKindOf(p) === 'procedure';
}

/**
 * The language a node of this kind may keep, or the one it has to take instead.
 *
 * Kind and language are two halves of one fact for the data files, so changing
 * either moves the other rather than leaving a YAML function or a data file
 * written in Go on the canvas. This is the "the kind was just changed" half;
 * `kindForLanguage` is the other, and `settleCodeNode` is for a file that
 * arrives disagreeing with itself.
 */
export function languageForKind(kind: CodeKind, language: ProgramLanguage): ProgramLanguage {
  // A procedure is written in the engine's own language, which the dialect
  // decides; the host-language field has nothing to say about it.
  if (kind === 'procedure') return 'other';
  if (kind === 'data') return isDataLanguage(language) ? language : DEFAULT_DATA_LANGUAGE;
  return isDataLanguage(language) ? 'other' : language;
}

/** The kind a node written in this language may keep, or the one it has to take. */
export function kindForLanguage(language: ProgramLanguage, kind: CodeKind): CodeKind {
  if (kind === 'procedure') return kind;
  if (isDataLanguage(language)) return 'data';
  return kind === 'data' ? 'module' : kind;
}

/**
 * Kind and language settled against each other, for a file or a paste that may
 * claim both. Either side saying "data file" is taken at its word, because a
 * node nothing runs is the safer reading of a disagreement: it loses no code,
 * since a data node never had any.
 */
export function settleCodeNode(kind: CodeKind, language: ProgramLanguage): { kind: CodeKind; language: ProgramLanguage } {
  if (kind === 'procedure') return { kind, language: 'other' };
  if (kind !== 'data' && !isDataLanguage(language)) return { kind, language };
  return { kind: 'data', language: isDataLanguage(language) ? language : DEFAULT_DATA_LANGUAGE };
}

/** How a procedure parameter is passed. Absent means IN, which is what an unmarked parameter is on every engine. */
export type ProcedureParamMode = 'in' | 'out' | 'inout';

export const PROCEDURE_PARAM_MODES: ProcedureParamMode[] = ['in', 'out', 'inout'];

export function isProcedureParamMode(v: unknown): v is ProcedureParamMode {
  return v === 'in' || v === 'out' || v === 'inout';
}

/** One parameter of a stored procedure or function. */
export interface ProcedureParam {
  id: string;
  name: string;
  /** Raw SQL type, the same convention as Column.type, and translated with it when the dialect changes. */
  type: string;
  /** Absent means IN. */
  mode?: ProcedureParamMode;
  /** PostgreSQL only: the DEFAULT a caller may leave the argument out for. */
  defaultValue?: string;
}

/**
 * The language a PostgreSQL routine body is written in. MariaDB has only one
 * (SQL/PSM, its BEGIN … END compound statements), SQLite and DuckDB have no
 * stored procedures at all, so the field only ever means something there.
 */
export type RoutineLanguage = 'plpgsql' | 'sql';

export function isRoutineLanguage(v: unknown): v is RoutineLanguage {
  return v === 'plpgsql' || v === 'sql';
}

/**
 * A program that talks to the database from outside it — and, since code maps,
 * every other piece of code on the canvas: the modules a program is made of,
 * the classes in them, the functions in those.
 *
 * Everything else on the canvas is something the database contains. Code is the
 * opposite: it is the caller, and the diagram holds it because where a
 * computation happens is a design decision worth drawing. The edges from a node
 * are not stored — they are derived from `steps`, the same way a group's
 * rectangle is derived from its member tables — so a node can never carry an
 * edge that means nothing, and reordering a step moves its arrow with it. A
 * step naming a table is the arrow that only this app can draw: the function
 * and the table it reads, in one picture.
 *
 * Containment is a pointer on the child (`parentId`), never a list on the
 * parent, for the same reason membership of a group lives on the table: the
 * region drawn around a module is derived from where its members sit, so the
 * two can never disagree about who is inside.
 */
export interface Program {
  id: string;
  name: string;
  /** Absent means 'program', which is what every file written before code maps existed means. */
  kind?: CodeKind;
  /** The container this node sits inside. Absent means it stands at the top level. */
  parentId?: string;
  /**
   * Drawn as one node with its members hidden, every arrow that touched a
   * member gathered onto it. Saved with the diagram, like a table's collapsed
   * display, because it is part of how a big map is read.
   */
  collapsed?: boolean;
  language: ProgramLanguage;
  /** Absent means unspecified; the node then shows the language alone. Programs only. */
  role?: ProgramRole;
  /** Where the code lives: a path, a module, a binary, a container; for a function, a signature if you like. */
  entrypoint?: string;
  /**
   * Where the node sits. For an expanded container this is only the anchor the
   * region falls back to while it has no members; the region itself is derived.
   */
  position: { x: number; y: number };
  /** Key into the palette in src/lib/palette.ts. */
  color: string;
  /** What the program is for. */
  comment?: string;
  /** Always empty on a data file, which runs nothing and so does nothing in order. */
  steps: ProgramStep[];
  /**
   * The code itself, as it was pasted: a function, a class, a whole file. Kept
   * so the steps read out of it can be read again, and so the part of the code
   * no step claims is not lost. The steps stay what the canvas draws; this is
   * where they came from, and editing it redraws nothing until it is read
   * again. Never on a data file, which holds no code, or a procedure, whose
   * code is its `body`. See src/lib/code/read.ts.
   */
  source?: string;

  /*
   * The fields below belong to procedures alone, and are dropped from every
   * other kind. A procedure's steps are still what draws its arrows; these are
   * what turns it into a CREATE statement.
   */
  /** The schema the routine is created in. Absent means the default one. */
  schema?: string;
  /** In declaration order. Absent or empty means it takes none. */
  params?: ProcedureParam[];
  /**
   * A return type makes the routine a stored *function* (CREATE FUNCTION …
   * RETURNS, called inside a query) rather than a procedure (CREATE PROCEDURE,
   * run with CALL). Written as the engine spells it: "integer", "TABLE (id int)",
   * "SETOF orders", "trigger".
   */
  returns?: string;
  /**
   * The body as the engine stores it: on PostgreSQL what goes between the dollar
   * quotes (a plpgsql BEGIN … END; block, or plain statements for LANGUAGE sql),
   * on MariaDB the routine body (usually one BEGIN … END compound statement).
   * Absent means the body is written from the steps, so a procedure sketched as
   * steps is already one the database can create.
   */
  body?: string;
  /** PostgreSQL only; absent means plpgsql. */
  routineLanguage?: RoutineLanguage;
}

export interface Diagram {
  version: 1;
  name: string;
  /**
   * What this diagram leans towards: 'code' a code map, 'data' a schema, 'both'
   * no preference. Absent means nobody has said — on an empty canvas that is
   * what puts the opening choice in front of you, and everywhere else it is
   * read off what has been drawn. The rules live in src/lib/emphasis.ts, which
   * is the only place that should read this field directly: what is on the
   * canvas outranks it, so the raw value answers fewer questions than it looks
   * like it does. An emphasis never removes a feature, so nothing may branch on
   * it for anything but what to put on screen.
   */
  emphasis?: 'code' | 'data' | 'both';
  /**
   * The engine a schema is written for. Always set, including on a code map
   * that will never generate a line of DDL, because a code map that later
   * grows a table should not have to be asked which engine it meant.
   */
  dialect: Dialect;
  tables: Table[];
  relationships: Relationship[];
  notes: Note[];
  groups: Group[];
  customTypes: CustomType[];
  /** Engine extensions this schema depends on. Empty for files written before extensions existed. */
  extensions: DiagramExtension[];
  /**
   * The code side of the diagram: programs that talk to this schema from
   * outside it, and the modules, classes and functions inside them. The key
   * predates code maps and was kept, because renaming a shipped key buys
   * nothing a `kind` field does not. Empty for files written before programs
   * existed, which is why nothing may assume the array is there without going
   * through the loader in src/lib/io.ts.
   */
  programs: Program[];
  /** Saved viewport, purely cosmetic. */
  viewport?: { x: number; y: number; zoom: number };
}

/**
 * One diagram inside a workspace. The id is the diagram's identity across a
 * session: its tab, its parked editing state and its checkpoints all hang off
 * it, while the diagram itself stays exactly the shape it has always been.
 */
export interface Sheet {
  id: string;
  diagram: Diagram;
}

/**
 * A workspace is what you save: several diagrams side by side, the way a
 * spreadsheet holds several worksheets. Files written before workspaces
 * existed are a bare `Diagram` and load as a workspace of one.
 */
export interface Workspace {
  version: 1;
  name: string;
  /** Tab order. Never empty. */
  sheets: Sheet[];
  /** The sheet that opens with the workspace; always one of `sheets`. */
  activeSheetId: string;
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

/** Run an ad-hoc query. The server wraps it in a transaction that is rolled back unless allowWrites is set. */
export interface QueryRequest {
  connection: ConnectionConfig;
  sql: string;
  /** Cap on returned rows (default 500). The result reports whether it was hit. */
  maxRows?: number;
  /** Permit statements other than SELECT/WITH/EXPLAIN/SHOW/DESCRIBE/VALUES and commit their effect. Default false. */
  allowWrites?: boolean;
}

/** One result set. Cell values are JSON-safe: bigints, dates and buffers are rendered to strings. */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows returned (after the cap) or rows affected for a statement that returns none. */
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  /** Statement tag when the driver reports one, e.g. "SELECT" or "INSERT". */
  command?: string;
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
  /** Absent means a plain table. */
  kind?: 'table' | 'view';
  /** The view's SELECT, for kind === 'view'. */
  viewSql?: string | null;
  /** True for a PostgreSQL materialized view (pg_class.relkind 'm'). */
  materialized?: boolean;
  /** True for a PostgreSQL unlogged table (pg_class.relpersistence 'u'). */
  unlogged?: boolean;
  comment: string | null;
  columns: IntrospectedColumn[];
  primaryKey: string[];
  uniques: { name: string; columns: string[] }[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: IntrospectedForeignKey[];
}

/**
 * One extension as a live server reports it. Unlike a catalog definition this is
 * authoritative for that server: `installed` says whether it is enabled here,
 * and for an installed one the provided types/functions/index methods are read
 * back from the catalogs rather than guessed.
 */
export interface DatabaseExtension {
  name: string;
  installed: boolean;
  installedVersion?: string;
  defaultVersion?: string;
  /** Schema it was installed into (PostgreSQL). */
  schema?: string;
  comment?: string;
  requires?: string[];
  /** Provided objects, for an installed extension. Long lists are capped; see `functionCount`. */
  types?: string[];
  functions?: string[];
  /** How many functions it really provides, when `functions` was capped. */
  functionCount?: number;
  indexMethods?: string[];
  operatorClasses?: string[];
}

export interface ExtensionsResponse {
  serverVersion: string;
  extensions: DatabaseExtension[];
  /** Set when the engine has no installable extensions and the list describes what is compiled in. */
  note?: string;
}

/** A stored procedure or function as a live server reports it. */
export interface IntrospectedRoutine {
  schema: string;
  name: string;
  kind: 'procedure' | 'function';
  params: { name: string; type: string; mode?: ProcedureParamMode; defaultValue?: string }[];
  /** Functions only. */
  returns?: string;
  /** PostgreSQL's language name, e.g. plpgsql or sql. */
  language?: string;
  body: string;
  comment: string | null;
}

export interface IntrospectResponse {
  serverVersion: string;
  tables: IntrospectedTable[];
  /** Stored procedures and functions (PostgreSQL and MariaDB); absent from engines that have none. */
  routines?: IntrospectedRoutine[];
  /** Named enum types (PostgreSQL and DuckDB). */
  enums?: { schema: string; name: string; values: string[] }[];
  /** Extensions installed in this database, so importing a schema brings its dependencies with it. */
  extensions?: { name: string; schema?: string; version?: string }[];
}
