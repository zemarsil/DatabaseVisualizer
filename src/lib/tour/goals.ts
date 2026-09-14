/**
 * What a walkthrough step is *for*, written once and used twice.
 *
 * A step in docs/walkthroughs/ declares its outcome as one or more goals:
 *
 *     goals:
 *       - table | authors
 *       - fk | books.author_id -> authors.id
 *
 * The tour reads that single declaration two ways. `evaluateGoal` asks "has the
 * reader done this yet?", which is what turns the coach mark green and what
 * **Check** reports line by line. `applyGoal` asks "do it for them", which is
 * what **Do it for me** runs when someone would rather watch than type. Because
 * both come off the same sentence they cannot drift apart: a step the tour can
 * perform is by construction a step it can recognise.
 *
 * The whole-diagram verbs (`contains`, `lint clean`, `simulate`, `kinds`, …)
 * are not reimplemented here — they are delegated to
 * src/lib/walkthroughChecks.ts, the module CI already runs against every
 * companion diagram, so a step goal and a front-matter check mean exactly the
 * same thing when they say the same words.
 */
import {
  AGGREGATE_FUNCTIONS,
  RELATIONSHIP_VERBS,
  REFERENTIAL_ACTIONS,
  WINDOW_FUNCTIONS,
  codeKindOf,
  isCodeKind,
  isWindowFunction,
  relationshipVerb,
  type AggregateFunction,
  type CodeKind,
  type Column,
  type Derivation,
  type Diagram,
  type Dialect,
  type Relationship,
  type RelationshipKind,
  type Table,
  type TableDisplay,
} from '@shared/types';
import {
  createColumn,
  createCustomType,
  createCustomTypeField,
  createDerivation,
  createExtension,
  createGroup,
  createIndex,
  createProgram,
  createProgramStep,
  createRelationship,
  createTable,
  extensionByName,
  tableById,
} from '@/lib/model';
import { findCodeByPath, nextCodePosition } from '@/lib/codemap';
import { nextProgramPosition } from '@/lib/programs';
import { importSql } from '@/lib/sql/import';
import { findCodeRef, parseCodeRef, runWalkthroughCheck, splitArrow } from '@/lib/walkthroughChecks';

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface Goal {
  /** The line as written in the walkthrough, e.g. "fk | books.author_id -> authors.id". */
  raw: string;
  verb: string;
  arg: string;
}

export interface GoalStatus {
  goal: Goal;
  ok: boolean;
  /** One line a reader can act on, whether it passed or failed. */
  detail: string;
  /** Whether **Do it for me** could make this goal true. */
  fixable: boolean;
}

/**
 * The part of the app a goal can see that is not the diagram: which drawer tab
 * is in front, what is selected, whether a simulation or a trace is running.
 * Passed in rather than read from the stores so goals stay pure and testable.
 */
export interface TourView {
  /** Drawer tab currently in front, or null when the drawer is closed. */
  drawerTab: string | null;
  selectedTableIds: string[];
  selectedRelationshipId: string | null;
  showCardinality: boolean;
  /** Table a data-flow simulation is currently feeding, if any. */
  simulateTargetId: string | null;
  /** Tables on the current trace result, in order, or null when there is none. */
  tracePath: string[] | null;
  /** Table or code node whose neighbourhood is focused, if any. */
  focusTableId: string | null;
  /** Code nodes picked up on the canvas. */
  selectedProgramIds: string[];
}

export const EMPTY_VIEW: TourView = {
  drawerTab: null,
  selectedTableIds: [],
  selectedRelationshipId: null,
  showCardinality: true,
  simulateTargetId: null,
  tracePath: null,
  focusTableId: null,
  selectedProgramIds: [],
};

export interface GoalContext {
  diagram: Diagram;
  view: TourView;
  /** The step's fenced code block, when it has one: what `viewsql` and `query` write. */
  code?: string;
}

/** The handful of app actions a view goal can perform for the reader. */
export interface TourViewApi {
  openDrawer: (tab: string) => void;
  selectTable: (id: string) => void;
  selectRelationship: (id: string) => void;
  setShowCardinality: (on: boolean) => void;
  startSimulation: (tableId: string) => void;
  runTrace: (fromId: string, toId: string) => void;
  setFocus: (tableId: string | null) => void;
  selectCode: (id: string) => void;
}

type Outcome = { ok: boolean; detail: string };

interface GoalSpec {
  /** What goes after the "|", for the validator and the format doc. `null` means the verb takes nothing. */
  arg: string | null;
  check: (arg: string, ctx: GoalContext) => Outcome;
  /** Makes the goal true by editing the diagram. `d` is a mutable draft. */
  apply?: (arg: string, d: Diagram, ctx: GoalContext) => boolean;
  /** Makes the goal true by driving the UI instead of the diagram. */
  applyView?: (arg: string, ctx: GoalContext, api: TourViewApi) => boolean;
}

/* ------------------------------------------------------------------ */
/* Small parsers                                                       */
/* ------------------------------------------------------------------ */

/** "fk | a.b -> c.d" -> { verb: 'fk', arg: 'a.b -> c.d' }. Same split as walkthroughChecks. */
export function parseGoal(raw: string): Goal {
  const cut = raw.indexOf('|');
  return cut === -1 ? { raw, verb: raw.trim(), arg: '' } : { raw, verb: raw.slice(0, cut).trim(), arg: raw.slice(cut + 1).trim() };
}

/** Splits an argument on its first " : ", the separator between a subject and what it should be. */
function splitOn(arg: string, sep = ':'): [string, string] {
  const i = arg.indexOf(sep);
  return i === -1 ? [arg.trim(), ''] : [arg.slice(0, i).trim(), arg.slice(i + sep.length).trim()];
}

function commas(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function eq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** Whitespace-insensitive comparison, for SQL fragments a reader may lay out differently. */
function sameSql(a: string | undefined, b: string | undefined): boolean {
  const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return flat(a) === flat(b);
}

function findTable(d: Diagram, name: string): Table | undefined {
  return d.tables.find((t) => eq(t.name, name));
}

/** "orders.status" -> the table and the column, either of which may be missing. */
function findColumn(d: Diagram, ref: string): { table?: Table; column?: Column; tableName: string; columnName: string } {
  const dot = ref.lastIndexOf('.');
  const tableName = dot === -1 ? ref.trim() : ref.slice(0, dot).trim();
  const columnName = dot === -1 ? '' : ref.slice(dot + 1).trim();
  const table = findTable(d, tableName);
  return { table, column: table?.columns.find((c) => eq(c.name, columnName)), tableName, columnName };
}

/** "a -> b" -> ["a", "b"]. */
function arrow(arg: string): [string, string] {
  const [a, b] = arg.split('->');
  return [(a ?? '').trim(), (b ?? '').trim()];
}

function relBetween(d: Diagram, fromName: string, toName: string, kind?: RelationshipKind): Relationship | undefined {
  const from = findTable(d, fromName);
  const to = findTable(d, toName);
  if (!from || !to) return undefined;
  return d.relationships.find((r) => r.sourceTableId === from.id && r.targetTableId === to.id && (!kind || r.kind === kind));
}

function nameOf(d: Diagram, id: string): string {
  return tableById(d, id)?.name ?? '?';
}

/**
 * Where a table the tour adds should land: the next free cell of the 340 x 300
 * grid the companion diagrams are laid out on, filling rows left to right, so a
 * diagram built by **Do it for me** looks like the one in docs/.
 */
function nextSlot(d: Diagram): { x: number; y: number } {
  const taken = new Set(d.tables.map((t) => `${Math.round(t.position.x / 340)},${Math.round(t.position.y / 300)}`));
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 5; col++) {
      if (!taken.has(`${col},${row}`)) return { x: col * 340, y: row * 300 };
    }
  }
  return { x: 0, y: d.tables.length * 300 };
}

/** The auto-incrementing key type a new table gets, spelled this dialect's way. */
function keyType(dialect: Dialect): string {
  return dialect === 'postgresql' ? 'BIGSERIAL' : dialect === 'mariadb' ? 'BIGINT' : 'INTEGER';
}

/* ------------------------------------------------------------------ */
/* Relationship goals                                                  */
/* ------------------------------------------------------------------ */

/** `fk | books.author_id -> authors.id` — the pair of columns is the whole point of a foreign key. */
function fkCheck(arg: string, { diagram: d }: GoalContext): Outcome {
  const [from, to] = arrow(arg);
  const src = findColumn(d, from);
  const tgt = findColumn(d, to);
  if (!src.column) return { ok: false, detail: `${from} does not exist yet, so nothing can reference ${to}.` };
  if (!tgt.column) return { ok: false, detail: `${to} does not exist yet.` };
  const hit = d.relationships.some(
    (r) => r.kind === 'fk' && r.sourceTableId === src.table!.id && r.targetTableId === tgt.table!.id && r.sourceColumnIds.includes(src.column!.id) && r.targetColumnIds.includes(tgt.column!.id),
  );
  return hit ? { ok: true, detail: `${from} references ${to}.` } : { ok: false, detail: `no foreign key runs from ${from} to ${to} yet.` };
}

function fkApply(arg: string, d: Diagram): boolean {
  const [from, to] = arrow(arg);
  const src = findColumn(d, from);
  const tgt = findColumn(d, to);
  if (!src.table || !src.column || !tgt.table || !tgt.column) return false;
  if (fkCheck(arg, { diagram: d, view: EMPTY_VIEW }).ok) return false;
  d.relationships.push(
    createRelationship({ kind: 'fk', sourceTableId: src.table.id, sourceColumnIds: [src.column.id], targetTableId: tgt.table.id, targetColumnIds: [tgt.column.id] }),
  );
  return true;
}

/** The three connection kinds that carry no column pair: flow, embed, dependency. */
function looseLink(kind: Exclude<RelationshipKind, 'fk'>, label: string): GoalSpec {
  return {
    arg: kind === 'embed' ? 'container.column -> embedded_table' : 'source_table -> target_table',
    check: (arg, { diagram: d }) => {
      const [from, to] = arrow(arg);
      const src = kind === 'embed' ? findColumn(d, from) : { table: findTable(d, from), column: undefined };
      const tgt = findTable(d, to);
      if (!src.table) return { ok: false, detail: `there is no ${from.split('.')[0]} to connect from.` };
      if (!tgt) return { ok: false, detail: `there is no ${to} to connect to.` };
      const hit = d.relationships.find(
        (r) => r.kind === kind && r.sourceTableId === src.table!.id && r.targetTableId === tgt.id && (kind !== 'embed' || !src.column || r.sourceColumnIds[0] === src.column.id),
      );
      return hit ? { ok: true, detail: `${from} → ${to} is a ${label}.` } : { ok: false, detail: `no ${label} runs from ${from} to ${to} yet.` };
    },
    apply: (arg, d) => {
      const [from, to] = arrow(arg);
      const src = kind === 'embed' ? findColumn(d, from) : { table: findTable(d, from), column: undefined as Column | undefined };
      const tgt = findTable(d, to);
      if (!src.table || !tgt) return false;
      const existing = d.relationships.find((r) => r.sourceTableId === src.table!.id && r.targetTableId === tgt.id && r.kind === kind);
      if (existing) return false;
      d.relationships.push(
        createRelationship({
          kind,
          sourceTableId: src.table.id,
          sourceColumnIds: src.column ? [src.column.id] : [],
          targetTableId: tgt.id,
          targetColumnIds: [],
        }),
      );
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Derivations                                                         */
/* ------------------------------------------------------------------ */

interface ParsedDerivation {
  aggregate?: AggregateFunction;
  windowFn?: string;
  expression: string;
  groupBy: string[];
  orderBy: string[];
  partitionBy: string[];
  filter?: string;
}

/**
 * "SUM(quantity) group by product_id" or "AVG(DIFF(placed_at)) order by placed_at",
 * i.e. the summary the inspector prints for a derived column, read back in.
 */
function parseDerivation(spec: string): ParsedDerivation {
  const clause = (name: string) => {
    const m = new RegExp(`\\s${name}\\s+([^|]*?)(?=\\s(?:group by|order by|partition by|where)\\s|$)`, 'i').exec(spec);
    return m ? m[1].trim() : '';
  };
  const groupBy = commas(clause('group by'));
  const orderBy = commas(clause('order by'));
  const partitionBy = commas(clause('partition by'));
  const filter = clause('where') || undefined;
  const head = spec.split(/\s(?:group by|order by|partition by|where)\s/i)[0].trim();

  let expression = head;
  let aggregate: AggregateFunction | undefined;
  let windowFn: string | undefined;
  const outer = /^([A-Za-z_]+)\s*\((.*)\)$/.exec(expression);
  if (outer && AGGREGATE_FUNCTIONS.includes(outer[1].toUpperCase() as AggregateFunction)) {
    aggregate = outer[1].toUpperCase() as AggregateFunction;
    expression = outer[2].trim();
  }
  const inner = /^([A-Za-z_]+)\s*\((.*)\)$/.exec(expression);
  if (inner && isWindowFunction(inner[1].toUpperCase())) {
    windowFn = inner[1].toUpperCase();
    expression = inner[2].trim();
  } else if (WINDOW_FUNCTIONS.some((w) => !w.needsExpression && eq(w.id, expression.replace(/\(\s*\)$/, '')))) {
    windowFn = expression.replace(/\(\s*\)$/, '').toUpperCase();
    expression = '';
  }
  return { aggregate, windowFn, expression, groupBy, orderBy, partitionBy, filter };
}

function derivationMatches(dv: Derivation, want: ParsedDerivation): boolean {
  if ((dv.aggregate ?? '') !== (want.aggregate ?? '')) return false;
  if ((dv.window?.fn ?? '') !== (want.windowFn ?? '')) return false;
  return sameSql(dv.expression, want.expression);
}

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every whole-diagram verb from src/lib/walkthroughChecks.ts is also a step
 * goal, so a final step can assert exactly what the front matter asserts.
 * None of them can be applied: "lint clean" describes an outcome, not an edit.
 */
const DELEGATED: Record<string, string | null> = {
  contains: 'text the generated script must contain',
  omits: 'text the generated script must not contain',
  tables: 'every table name in the diagram, comma separated',
  views: 'every view name in the diagram, comma separated',
  groups: 'every group name in the diagram, comma separated',
  types: 'every custom type name in the diagram, comma separated',
  extensions: 'every extension name in the diagram, comma separated',
  kinds: 'relationship counts per kind, e.g. "fk:3, flow:1"',
  indexes: 'total number of indexes across every table',
  derivations: 'total number of derivations across every flow',
  'lint clean': null,
  'lint errors': 'the exact number of errors Problems reports',
  simulate: 'a table that must simulate with rows and no warnings',
  trace: 'two tables or code nodes as "a -> b" with a path between them',
};

const delegated: Record<string, GoalSpec> = Object.fromEntries(
  Object.entries(DELEGATED).map(([verb, arg]) => [
    verb,
    {
      arg,
      check: (a: string, ctx: GoalContext) => {
        const r = runWalkthroughCheck(a ? `${verb} | ${a}` : verb, ctx.diagram, { ordered: false });
        return { ok: r.ok, detail: r.detail };
      },
    } satisfies GoalSpec,
  ]),
);

export const GOALS: Record<string, GoalSpec> = {
  ...delegated,

  /* ---- tables, views, columns ---- */

  table: {
    arg: 'a table name that must exist',
    check: (arg, { diagram: d }) => {
      const t = findTable(d, arg);
      return t && t.kind !== 'view' ? { ok: true, detail: `${arg} is on the canvas.` } : { ok: false, detail: `there is no table called ${arg} yet.` };
    },
    apply: (arg, d) => {
      if (findTable(d, arg)) return false;
      d.tables.push(createTable({ name: arg, position: nextSlot(d), columns: [createColumn({ name: 'id', type: keyType(d.dialect), primaryKey: true, nullable: false, autoIncrement: true })] }));
      return true;
    },
  },

  view: {
    arg: 'a view name that must exist',
    check: (arg, { diagram: d }) => {
      const t = findTable(d, arg);
      if (!t) return { ok: false, detail: `there is no node called ${arg} yet.` };
      return t.kind === 'view' ? { ok: true, detail: `${arg} is a view.` } : { ok: false, detail: `${arg} exists but is still a table, not a view.` };
    },
    apply: (arg, d) => {
      const t = findTable(d, arg);
      if (t) {
        if (t.kind === 'view') return false;
        t.kind = 'view';
        return true;
      }
      d.tables.push(createTable({ name: arg, kind: 'view', position: nextSlot(d), viewSql: '' }));
      return true;
    },
  },

  extension: {
    arg: 'an extension the diagram must declare, e.g. vector',
    check: (arg, { diagram: d }) => {
      const e = extensionByName(d, arg);
      return e ? { ok: true, detail: `${arg} is declared.` } : { ok: false, detail: `the diagram does not declare the ${arg} extension yet.` };
    },
    apply: (arg, d) => {
      if (extensionByName(d, arg)) return false;
      d.extensions.push(createExtension({ name: arg }));
      return true;
    },
  },

  'no table': {
    arg: 'a table name that must be gone',
    check: (arg, { diagram: d }) => (findTable(d, arg) ? { ok: false, detail: `${arg} is still on the canvas.` } : { ok: true, detail: `${arg} is gone.` }),
    apply: (arg, d) => {
      const t = findTable(d, arg);
      if (!t) return false;
      d.tables = d.tables.filter((x) => x.id !== t.id);
      d.relationships = d.relationships.filter((r) => r.sourceTableId !== t.id && r.targetTableId !== t.id);
      return true;
    },
  },

  column: {
    arg: 'table.column, optionally " : TYPE"',
    check: (arg, { diagram: d }) => {
      const [ref, type] = splitOn(arg);
      const { table, column, columnName, tableName } = findColumn(d, ref);
      if (!table) return { ok: false, detail: `there is no ${tableName} to hold ${columnName}.` };
      if (!column) return { ok: false, detail: `${tableName} has no ${columnName} column yet.` };
      if (type && !eq(column.type, type)) return { ok: false, detail: `${ref} is ${column.type}, not ${type}.` };
      return { ok: true, detail: type ? `${ref} is ${type}.` : `${ref} exists.` };
    },
    apply: (arg, d) => {
      const [ref, type] = splitOn(arg);
      const { table, column, columnName } = findColumn(d, ref);
      if (!table || !columnName) return false;
      if (column) {
        if (!type || eq(column.type, type)) return false;
        column.type = type;
        return true;
      }
      table.columns.push(createColumn({ name: columnName, type: type || 'TEXT' }));
      return true;
    },
  },

  'no column': {
    arg: 'table.column that must be gone',
    check: (arg, { diagram: d }) => {
      const { column, tableName, columnName } = findColumn(d, arg);
      return column ? { ok: false, detail: `${tableName} still has ${columnName}.` } : { ok: true, detail: `${arg} is gone.` };
    },
    apply: (arg, d) => {
      const { table, column } = findColumn(d, arg);
      if (!table || !column) return false;
      table.columns = table.columns.filter((c) => c.id !== column.id);
      table.indexes = table.indexes.map((i) => ({ ...i, columnIds: i.columnIds.filter((id) => id !== column.id) })).filter((i) => i.columnIds.length > 0);
      return true;
    },
  },

  flags: {
    arg: 'table.column : pk nn uq ai, each optionally negated with "-"',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      const { column, tableName, columnName } = findColumn(d, ref);
      if (!column) return { ok: false, detail: `${tableName} has no ${columnName} column yet.` };
      const wrong = want
        .split(/\s+/)
        .filter(Boolean)
        .filter((f) => {
          const on = !f.startsWith('-');
          return flagOf(column, f.replace(/^-/, '')) !== on;
        });
      return wrong.length ? { ok: false, detail: `${ref} should be ${want.replace(/-/g, 'not ')}; ${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} wrong.` } : { ok: true, detail: `${ref} is ${want.replace(/-/g, 'not ')}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      const { column } = findColumn(d, ref);
      if (!column) return false;
      let changed = false;
      for (const f of want.split(/\s+/).filter(Boolean)) {
        const on = !f.startsWith('-');
        if (setFlag(column, f.replace(/^-/, ''), on)) changed = true;
      }
      return changed;
    },
  },

  default: {
    arg: 'table.column : the default expression',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      const { column, tableName, columnName } = findColumn(d, ref);
      if (!column) return { ok: false, detail: `${tableName} has no ${columnName} column yet.` };
      return sameSql(column.defaultValue, want) ? { ok: true, detail: `${ref} defaults to ${want}.` } : { ok: false, detail: `${ref} defaults to ${column.defaultValue || 'nothing'}, not ${want}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      const { column } = findColumn(d, ref);
      if (!column || sameSql(column.defaultValue, want)) return false;
      column.defaultValue = want;
      return true;
    },
  },

  check: {
    arg: 'table.column : expression for a column CHECK, or table : expression for a table one',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      if (ref.includes('.')) {
        const { column, tableName, columnName } = findColumn(d, ref);
        if (!column) return { ok: false, detail: `${tableName} has no ${columnName} column yet.` };
        return sameSql(column.check, want) ? { ok: true, detail: `${ref} checks ${want}.` } : { ok: false, detail: `${ref} has no CHECK reading ${want}.` };
      }
      const t = findTable(d, ref);
      if (!t) return { ok: false, detail: `there is no table called ${ref}.` };
      return t.checks.some((c) => sameSql(c, want)) ? { ok: true, detail: `${ref} checks ${want}.` } : { ok: false, detail: `${ref} has no table-level CHECK reading ${want}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      if (ref.includes('.')) {
        const { column } = findColumn(d, ref);
        if (!column || sameSql(column.check, want)) return false;
        column.check = want;
        return true;
      }
      const t = findTable(d, ref);
      if (!t || t.checks.some((c) => sameSql(c, want))) return false;
      t.checks.push(want);
      return true;
    },
  },

  schema: {
    arg: 'table : schema name',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      const t = findTable(d, ref);
      if (!t) return { ok: false, detail: `there is no table called ${ref}.` };
      return eq(t.schema ?? '', want) ? { ok: true, detail: `${ref} lives in ${want || 'the default schema'}.` } : { ok: false, detail: `${ref} is in ${t.schema || 'the default schema'}, not ${want}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      const t = findTable(d, ref);
      if (!t || eq(t.schema ?? '', want)) return false;
      t.schema = want || undefined;
      return true;
    },
  },

  collapsed: {
    arg: 'table : full, keys or header',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      const t = findTable(d, ref);
      if (!t) return { ok: false, detail: `there is no table called ${ref}.` };
      const now = t.collapsed ?? 'full';
      return eq(now, want) ? { ok: true, detail: `${ref} is showing ${want === 'full' ? 'every column' : want}.` } : { ok: false, detail: `${ref} is showing ${now === 'full' ? 'every column' : now}, not ${want}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      const t = findTable(d, ref);
      if (!t) return false;
      const next = want === 'full' ? undefined : (want as TableDisplay);
      if (t.collapsed === next) return false;
      t.collapsed = next;
      return true;
    },
  },

  materialized: {
    arg: 'view : on or off',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      const t = findTable(d, ref);
      if (!t) return { ok: false, detail: `there is no view called ${ref}.` };
      const on = !!t.materialized;
      return on === (want === 'on') ? { ok: true, detail: `${ref} is ${on ? '' : 'not '}materialized.` } : { ok: false, detail: `${ref} is ${on ? '' : 'not '}materialized; it should be ${want === 'on' ? '' : 'not '}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      const t = findTable(d, ref);
      if (!t || !!t.materialized === (want === 'on')) return false;
      t.materialized = want === 'on';
      return true;
    },
  },

  viewsql: {
    arg: "a view name; the step's ```sql block is what gets written",
    check: (arg, { diagram: d }) => {
      const t = findTable(d, arg);
      if (!t) return { ok: false, detail: `there is no view called ${arg} yet.` };
      return t.viewSql?.trim() ? { ok: true, detail: `${arg} has a SELECT.` } : { ok: false, detail: `${arg} has no SELECT yet.` };
    },
    apply: (arg, d, ctx) => {
      const t = findTable(d, arg);
      if (!t || !ctx.code || sameSql(t.viewSql, ctx.code)) return false;
      t.kind = 'view';
      t.viewSql = ctx.code;
      return true;
    },
  },

  import: {
    arg: "the tables the step's ```sql block brings in, comma separated",
    check: (arg, { diagram: d }) => {
      const want = commas(arg);
      const missing = want.filter((n) => !findTable(d, n));
      return missing.length ? { ok: false, detail: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the diagram yet.` } : { ok: true, detail: `${want.join(', ')} came in from the script.` };
    },
    apply: (arg, d, ctx) => {
      if (!ctx.code) return false;
      // Running the script twice would land a second copy under a renamed name,
      // so it only runs while none of its tables are here yet.
      if (commas(arg).some((n) => findTable(d, n))) return false;
      const r = importSql(ctx.code, d.dialect, d);
      if (!r.tables.length) return false;
      const below = d.tables.reduce((y, t) => Math.max(y, t.position.y), 0) + 400;
      for (const t of r.tables) t.position = { x: t.position.x, y: t.position.y + below };
      d.tables.push(...r.tables);
      d.relationships.push(...r.relationships);
      if (r.customTypes.length) d.customTypes.push(...r.customTypes);
      return true;
    },
  },

  /* ---- connections ---- */

  fk: { arg: 'child.column -> parent.column', check: fkCheck, apply: fkApply },
  flow: looseLink('flow', 'data flow'),
  embed: looseLink('embed', 'serialized copy'),
  dependency: looseLink('dependency', 'dependency'),

  reads: {
    arg: 'a sentence like "books belongs to authors"',
    check: (arg, { diagram: d }) => {
      const found = matchReads(d, arg);
      if (!found.rel) return { ok: false, detail: found.detail };
      const v = relationshipVerb(found.rel);
      return eq(v.forward, found.phrase) ? { ok: true, detail: `it reads "${arg}".` } : { ok: false, detail: `it reads "${nameOf(d, found.rel.sourceTableId)} ${v.forward} ${nameOf(d, found.rel.targetTableId)}", not "${arg}".` };
    },
    apply: (arg, d) => {
      const found = matchReads(d, arg);
      if (!found.rel) return false;
      const meta = RELATIONSHIP_VERBS.find((v) => eq(v.forward, found.phrase) && v.kinds.includes(found.rel!.kind));
      if (!meta || found.rel.verb === meta.id) return false;
      found.rel.verb = meta.id;
      return true;
    },
  },

  label: {
    arg: 'source -> target : the label or constraint name',
    check: (arg, { diagram: d }) => {
      const [ends, want] = splitOn(arg);
      const [from, to] = arrow(ends);
      const r = relBetween(d, from, to);
      if (!r) return { ok: false, detail: `there is no connection from ${from} to ${to} yet.` };
      return eq(r.name ?? '', want) ? { ok: true, detail: `the connection is named "${want}".` } : { ok: false, detail: `the connection is named "${r.name || 'nothing'}", not "${want}".` };
    },
    apply: (arg, d) => {
      const [ends, want] = splitOn(arg);
      const [from, to] = arrow(ends);
      const r = relBetween(d, from, to);
      if (!r || eq(r.name ?? '', want)) return false;
      r.name = want;
      return true;
    },
  },

  'reverse label': {
    arg: 'source -> target : how the far end reads',
    check: (arg, { diagram: d }) => {
      const [ends, want] = splitOn(arg);
      const [from, to] = arrow(ends);
      const r = relBetween(d, from, to);
      if (!r) return { ok: false, detail: `there is no connection from ${from} to ${to} yet.` };
      return eq(r.inverseName ?? '', want) ? { ok: true, detail: `the far end reads "${want}".` } : { ok: false, detail: `the far end reads "${r.inverseName || relationshipVerb(r).inverse}", not "${want}".` };
    },
    apply: (arg, d) => {
      const [ends, want] = splitOn(arg);
      const [from, to] = arrow(ends);
      const r = relBetween(d, from, to);
      if (!r || eq(r.inverseName ?? '', want)) return false;
      r.inverseName = want;
      return true;
    },
  },

  ondelete: {
    arg: 'child -> parent : NO ACTION, RESTRICT, CASCADE, SET NULL or SET DEFAULT',
    check: (arg, { diagram: d }) => {
      const [ends, want] = splitOn(arg);
      const [from, to] = arrow(ends);
      const r = relBetween(d, from, to, 'fk');
      if (!r) return { ok: false, detail: `there is no foreign key from ${from} to ${to} yet.` };
      const now = r.onDelete ?? 'NO ACTION';
      return eq(now, want) ? { ok: true, detail: `deleting a ${to} row is ${want}.` } : { ok: false, detail: `on delete is ${now}, not ${want}.` };
    },
    apply: (arg, d) => {
      const [ends, want] = splitOn(arg);
      const [from, to] = arrow(ends);
      const r = relBetween(d, from, to, 'fk');
      const action = REFERENTIAL_ACTIONS.find((a) => eq(a, want));
      if (!r || !action || r.onDelete === action) return false;
      r.onDelete = action;
      return true;
    },
  },

  query: {
    arg: "source -> target; the step's ```sql block is what gets tagged onto the connection",
    check: (arg, { diagram: d }) => {
      const [from, to] = arrow(arg);
      const r = relBetween(d, from, to);
      if (!r) return { ok: false, detail: `there is no connection from ${from} to ${to} yet.` };
      return r.query?.trim() ? { ok: true, detail: `${from} → ${to} carries a tagged query.` } : { ok: false, detail: `${from} → ${to} has no tagged query yet.` };
    },
    apply: (arg, d, ctx) => {
      const [from, to] = arrow(arg);
      const r = relBetween(d, from, to);
      if (!r || !ctx.code || sameSql(r.query, ctx.code)) return false;
      r.query = ctx.code;
      return true;
    },
  },

  derivation: {
    arg: 'target.column : an expression like SUM(quantity), optionally "group by …" / "order by …" / "where …"',
    check: (arg, { diagram: d }) => {
      const [ref, spec] = splitOn(arg);
      const { table, column, tableName, columnName } = findColumn(d, ref);
      if (!table) return { ok: false, detail: `there is no ${tableName} to derive into.` };
      if (!column) return { ok: false, detail: `${tableName} has no ${columnName} column to derive.` };
      const want = parseDerivation(spec);
      const dv = d.relationships.flatMap((r) => (r.targetTableId === table.id ? (r.derivations ?? []) : [])).find((x) => x.targetColumnId === column.id);
      if (!dv) return { ok: false, detail: `nothing fills ${ref} yet.` };
      return derivationMatches(dv, want) ? { ok: true, detail: `${ref} is derived as ${spec.split(/\s(?:group by|order by|partition by|where)\s/i)[0]}.` } : { ok: false, detail: `${ref} is derived, but not as ${spec}.` };
    },
    apply: (arg, d) => {
      const [ref, spec] = splitOn(arg);
      const { table, column } = findColumn(d, ref);
      if (!table || !column) return false;
      const flow = d.relationships.find((r) => r.kind === 'flow' && r.targetTableId === table.id);
      if (!flow) return false;
      const want = parseDerivation(spec);
      flow.derivations ??= [];
      const existing = flow.derivations.find((x) => x.targetColumnId === column.id);
      if (existing && derivationMatches(existing, want)) return false;
      const made = createDerivation({
        targetColumnId: column.id,
        expression: want.expression,
        aggregate: want.aggregate ?? null,
        groupBy: want.groupBy,
        filter: want.filter,
        window: want.windowFn && isWindowFunction(want.windowFn) ? { fn: want.windowFn, orderBy: want.orderBy, partitionBy: want.partitionBy } : undefined,
      });
      if (existing) flow.derivations = flow.derivations.map((x) => (x.id === existing.id ? { ...made, id: existing.id } : x));
      else flow.derivations.push(made);
      return true;
    },
  },

  /* ---- indexes ---- */

  index: { arg: 'table (col, col)', ...indexSpec(false) },
  'unique index': { arg: 'table (col, col)', ...indexSpec(true) },

  /* ---- regions and types ---- */

  group: { arg: 'Name, optionally " : member, member"', ...groupSpec(false) },
  'external group': { arg: 'Name, optionally " : member, member"', ...groupSpec(true) },

  enum: {
    arg: 'name : value, value, value',
    check: (arg, { diagram: d }) => {
      const [name, values] = splitOn(arg);
      const t = d.customTypes.find((c) => eq(c.name, name));
      if (!t) return { ok: false, detail: `there is no type called ${name} yet.` };
      if (t.kind !== 'enum') return { ok: false, detail: `${name} is a composite type, not an enum.` };
      const want = commas(values);
      const got = t.values ?? [];
      return !want.length || want.join(',') === got.join(',') ? { ok: true, detail: `${name} is an enum of ${got.join(', ')}.` } : { ok: false, detail: `${name} holds ${got.join(', ') || 'nothing'}, not ${want.join(', ')}.` };
    },
    apply: (arg, d) => {
      const [name, values] = splitOn(arg);
      const want = commas(values);
      const t = d.customTypes.find((c) => eq(c.name, name));
      if (t) {
        if ((t.values ?? []).join(',') === want.join(',')) return false;
        t.kind = 'enum';
        t.values = want;
        return true;
      }
      d.customTypes.push(createCustomType({ name, kind: 'enum', values: want.length ? want : ['value_1'] }));
      return true;
    },
  },

  composite: {
    arg: 'name : field TYPE, field TYPE',
    check: (arg, { diagram: d }) => {
      const [name, fields] = splitOn(arg);
      const t = d.customTypes.find((c) => eq(c.name, name));
      if (!t) return { ok: false, detail: `there is no type called ${name} yet.` };
      if (t.kind !== 'composite') return { ok: false, detail: `${name} is an enum, not a composite type.` };
      const want = commas(fields).map((f) => f.split(/\s+/)[0].toLowerCase());
      const got = (t.fields ?? []).map((f) => f.name.toLowerCase());
      const missing = want.filter((f) => !got.includes(f));
      return missing.length ? { ok: false, detail: `${name} is missing ${missing.join(', ')}.` } : { ok: true, detail: `${name} has ${got.join(', ')}.` };
    },
    apply: (arg, d) => {
      const [name, fields] = splitOn(arg);
      const want = commas(fields).map((f) => {
        const [fname, ...rest] = f.split(/\s+/);
        return createCustomTypeField({ name: fname, type: rest.join(' ') || 'TEXT' });
      });
      const t = d.customTypes.find((c) => eq(c.name, name));
      if (t) {
        const got = (t.fields ?? []).map((f) => f.name.toLowerCase());
        const add = want.filter((f) => !got.includes(f.name.toLowerCase()));
        if (!add.length && t.kind === 'composite') return false;
        t.kind = 'composite';
        t.fields = [...(t.fields ?? []).filter((f) => f.name !== 'field_1'), ...add];
        return true;
      }
      d.customTypes.push(createCustomType({ name, kind: 'composite', fields: want.length ? want : undefined }));
      return true;
    },
  },

  dialect: {
    arg: 'postgresql, mariadb, sqlite or duckdb',
    check: (arg, { diagram: d }) => (d.dialect === arg ? { ok: true, detail: `the dialect is ${arg}.` } : { ok: false, detail: `the dialect is ${d.dialect}, not ${arg}.` }),
    apply: (arg, d) => {
      if (d.dialect === arg) return false;
      d.dialect = arg as Dialect;
      return true;
    },
  },

  /* ---- the code map ---- */

  code: {
    arg: 'a kind and a path, e.g. "function checkout.py/place_order"',
    check: (arg, ctx) => {
      const r = runWalkthroughCheck(`code | ${arg}`, ctx.diagram, { ordered: false });
      return { ok: r.ok, detail: r.detail };
    },
    apply: (arg, d) => {
      const { kind, path } = parseCodeRef(arg);
      const existing = findCodeByPath(d, path);
      if (existing) {
        if (!kind || codeKindOf(existing) === kind) return false;
        existing.kind = kind === 'program' ? undefined : (kind as CodeKind);
        return true;
      }
      // The node goes inside the container the path names, which has to exist
      // already: a walkthrough builds a map from the outside in.
      const cut = path.lastIndexOf('/');
      const name = cut === -1 ? path : path.slice(cut + 1);
      const parent = cut === -1 ? undefined : findCodeByPath(d, path.slice(0, cut));
      if (cut !== -1 && !parent) return false;
      const chosen: CodeKind = kind && isCodeKind(kind) ? kind : parent ? 'function' : 'program';
      const position = nextCodePosition(d, parent?.id, nextProgramPosition(d));
      d.programs.push(
        createProgram({
          name,
          ...(chosen !== 'program' ? { kind: chosen } : {}),
          ...(parent ? { parentId: parent.id, language: parent.language } : {}),
          position,
        }),
      );
      return true;
    },
  },

  calls: codeLinkSpec('calls', 'call'),
  imports: codeLinkSpec('imports', 'import'),
  extends: codeLinkSpec('extends', 'extends'),
  'reads table': tableStepSpec('reads table', 'read'),
  'writes table': tableStepSpec('writes table', 'write'),

  'code collapsed': {
    arg: 'a code path : on or off',
    check: (arg, { diagram: d }) => {
      const [ref, want] = splitOn(arg);
      const found = findCodeRef(d, ref);
      if (!found.node) return { ok: false, detail: found.detail };
      const on = Boolean(found.node.collapsed);
      return on === (want === 'on') ? { ok: true, detail: `${found.node.name} is ${on ? 'collapsed' : 'expanded'}.` } : { ok: false, detail: `${found.node.name} is ${on ? 'collapsed' : 'expanded'}; it should be ${want === 'on' ? 'collapsed' : 'expanded'}.` };
    },
    apply: (arg, d) => {
      const [ref, want] = splitOn(arg);
      const found = findCodeRef(d, ref);
      if (!found.node || Boolean(found.node.collapsed) === (want === 'on')) return false;
      if (want === 'on') found.node.collapsed = true;
      else delete found.node.collapsed;
      return true;
    },
  },

  /* ---- what is on screen ---- */

  'select code': {
    arg: 'the path of a code node that must be selected',
    check: (arg, { diagram: d, view }) => {
      const found = findCodeRef(d, arg);
      if (!found.node) return { ok: false, detail: found.detail };
      return view.selectedProgramIds.includes(found.node.id) ? { ok: true, detail: `${found.node.name} is selected.` } : { ok: false, detail: `${found.node.name} is not selected yet.` };
    },
    applyView: (arg, ctx, api) => {
      const found = findCodeRef(ctx.diagram, arg);
      if (!found.node) return false;
      api.selectCode(found.node.id);
      return true;
    },
  },

  open: {
    arg: 'a drawer tab id, e.g. sql or problems',
    check: (arg, { view }) => (view.drawerTab === arg ? { ok: true, detail: `the ${arg} tab is in front.` } : { ok: false, detail: `the ${arg} tab is not open.` }),
    applyView: (arg, _ctx, api) => {
      api.openDrawer(arg);
      return true;
    },
  },

  'select table': {
    arg: 'a table name that must be selected',
    check: (arg, { diagram: d, view }) => {
      const t = findTable(d, arg);
      if (!t) return { ok: false, detail: `there is no table called ${arg}.` };
      return view.selectedTableIds.includes(t.id) ? { ok: true, detail: `${arg} is selected.` } : { ok: false, detail: `${arg} is not selected yet.` };
    },
    applyView: (arg, ctx, api) => {
      const t = findTable(ctx.diagram, arg);
      if (!t) return false;
      api.selectTable(t.id);
      return true;
    },
  },

  'select connection': {
    arg: 'source -> target of the connection that must be selected',
    check: (arg, { diagram: d, view }) => {
      const [from, to] = arrow(arg);
      const r = relBetween(d, from, to);
      if (!r) return { ok: false, detail: `there is no connection from ${from} to ${to}.` };
      return view.selectedRelationshipId === r.id ? { ok: true, detail: `the ${from} → ${to} connection is selected.` } : { ok: false, detail: `select the ${from} → ${to} connection to see it in the inspector.` };
    },
    applyView: (arg, ctx, api) => {
      const [from, to] = arrow(arg);
      const r = relBetween(ctx.diagram, from, to);
      if (!r) return false;
      api.selectRelationship(r.id);
      return true;
    },
  },

  cardinality: {
    arg: 'on or off',
    check: (arg, { view }) => (view.showCardinality === (arg === 'on') ? { ok: true, detail: `cardinality labels are ${arg}.` } : { ok: false, detail: `cardinality labels are ${view.showCardinality ? 'on' : 'off'}, not ${arg}.` }),
    applyView: (arg, _ctx, api) => {
      api.setShowCardinality(arg === 'on');
      return true;
    },
  },

  simulating: {
    arg: 'the table a simulation must be feeding',
    check: (arg, { diagram: d, view }) => {
      const t = findTable(d, arg);
      if (!t) return { ok: false, detail: `there is no table called ${arg}.` };
      return view.simulateTargetId === t.id ? { ok: true, detail: `a simulation is feeding ${arg}.` } : { ok: false, detail: `nothing is simulating into ${arg} yet.` };
    },
    applyView: (arg, ctx, api) => {
      const t = findTable(ctx.diagram, arg);
      if (!t) return false;
      api.startSimulation(t.id);
      return true;
    },
  },

  traced: {
    arg: 'from -> to, the two ends of a trace that must have run',
    check: (arg, { diagram: d, view }) => {
      // Either end may be a code node: a trace walks calls as well as keys.
      const [from, to] = arrow(arg);
      const a = findTable(d, from) ?? findCodeByPath(d, from);
      const b = findTable(d, to) ?? findCodeByPath(d, to);
      if (!a || !b) return { ok: false, detail: `there is no table or code node called ${!a ? from : to}.` };
      const path = view.tracePath ?? [];
      const hit = path.length >= 2 && ((path[0] === a.id && path[path.length - 1] === b.id) || (path[0] === b.id && path[path.length - 1] === a.id));
      return hit ? { ok: true, detail: `Trace is showing ${from} → ${to}.` } : { ok: false, detail: `no trace between ${from} and ${to} is on screen yet.` };
    },
    applyView: (arg, ctx, api) => {
      const [from, to] = arrow(arg);
      const a = findTable(ctx.diagram, from) ?? findCodeByPath(ctx.diagram, from);
      const b = findTable(ctx.diagram, to) ?? findCodeByPath(ctx.diagram, to);
      if (!a || !b) return false;
      api.runTrace(a.id, b.id);
      return true;
    },
  },

  focus: {
    arg: 'the table or code node whose neighbourhood must be focused, or "none"',
    check: (arg, { diagram: d, view }) => {
      if (arg === 'none') return view.focusTableId ? { ok: false, detail: 'focus mode is still on.' } : { ok: true, detail: 'focus mode is off.' };
      const t = findTable(d, arg) ?? findCodeByPath(d, arg);
      if (!t) return { ok: false, detail: `there is no table or code node called ${arg}.` };
      return view.focusTableId === t.id ? { ok: true, detail: `the canvas is focused on ${arg}.` } : { ok: false, detail: `the canvas is not focused on ${arg} yet.` };
    },
    applyView: (arg, ctx, api) => {
      const t = arg === 'none' ? undefined : (findTable(ctx.diagram, arg) ?? findCodeByPath(ctx.diagram, arg));
      api.setFocus(t?.id ?? null);
      return true;
    },
  },
};

/* ------------------------------------------------------------------ */
/* Code-map spec builders                                              */
/* ------------------------------------------------------------------ */

/** `calls | a -> b`, `imports | a -> b`, `extends | a -> b`: a step on a naming b. */
function codeLinkSpec(verb: 'calls' | 'imports' | 'extends', op: 'call' | 'import' | 'extends'): GoalSpec {
  return {
    arg: 'from -> to, as code paths',
    check: (arg, ctx) => {
      const r = runWalkthroughCheck(`${verb} | ${arg}`, ctx.diagram, { ordered: false });
      return { ok: r.ok, detail: r.detail };
    },
    apply: (arg, d) => {
      const [fromRef, toRef] = splitArrow(arg);
      const from = findCodeRef(d, fromRef).node;
      const to = findCodeRef(d, toRef).node;
      if (!from || !to || from.id === to.id) return false;
      if (from.steps.some((s) => s.op === op && s.codeId === to.id)) return false;
      from.steps.push(createProgramStep({ op, codeId: to.id }));
      return true;
    },
  };
}

/** `reads table | code -> table`, `writes table | code -> table`: a read or write step on the code node. */
function tableStepSpec(verb: 'reads table' | 'writes table', op: 'read' | 'write'): GoalSpec {
  return {
    arg: 'code path -> table name',
    check: (arg, ctx) => {
      const r = runWalkthroughCheck(`${verb} | ${arg}`, ctx.diagram, { ordered: false });
      return { ok: r.ok, detail: r.detail };
    },
    apply: (arg, d) => {
      const [codeRef, tableName] = splitArrow(arg);
      const from = findCodeRef(d, codeRef).node;
      const table = findTable(d, tableName);
      if (!from || !table) return false;
      if (from.steps.some((s) => s.op === op && s.tableId === table.id)) return false;
      from.steps.push(createProgramStep({ op, tableId: table.id }));
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared spec builders                                                */
/* ------------------------------------------------------------------ */

function flagOf(c: Column, flag: string): boolean {
  switch (flag.toLowerCase()) {
    case 'pk':
      return c.primaryKey;
    case 'nn':
      return !c.nullable;
    case 'uq':
      return c.unique;
    case 'ai':
      return c.autoIncrement;
    default:
      return false;
  }
}

function setFlag(c: Column, flag: string, on: boolean): boolean {
  if (flagOf(c, flag) === on) return false;
  switch (flag.toLowerCase()) {
    case 'pk':
      c.primaryKey = on;
      if (on) c.nullable = false;
      return true;
    case 'nn':
      c.nullable = !on;
      return true;
    case 'uq':
      c.unique = on;
      return true;
    case 'ai':
      c.autoIncrement = on;
      return true;
    default:
      return false;
  }
}

/** "orders (customer_id, placed_at)" -> the table and the column names, in order. */
function parseIndexArg(arg: string): { tableName: string; columns: string[] } {
  const m = /^([^(]+)\(([^)]*)\)/.exec(arg);
  return m ? { tableName: m[1].trim(), columns: commas(m[2]) } : { tableName: arg.trim(), columns: [] };
}

function indexSpec(unique: boolean): Omit<GoalSpec, 'arg'> {
  const what = unique ? 'unique index' : 'index';
  return {
    check: (arg, { diagram: d }) => {
      const { tableName, columns } = parseIndexArg(arg);
      const t = findTable(d, tableName);
      if (!t) return { ok: false, detail: `there is no table called ${tableName}.` };
      const wantIds = columns.map((n) => t.columns.find((c) => eq(c.name, n))?.id);
      if (wantIds.some((id) => !id)) return { ok: false, detail: `${tableName} has no ${columns[wantIds.findIndex((id) => !id)]} column to index.` };
      const hit = t.indexes.find((i) => i.unique === unique && i.columnIds.join(',') === wantIds.join(','));
      if (hit) return { ok: true, detail: `${tableName} has a ${what} on (${columns.join(', ')}).` };
      const loose = t.indexes.find((i) => [...i.columnIds].sort().join(',') === [...(wantIds as string[])].sort().join(','));
      if (loose && loose.columnIds.join(',') !== wantIds.join(','))
        return { ok: false, detail: `${tableName} indexes those columns in the order ${loose.columnIds.map((id) => t.columns.find((c) => c.id === id)?.name).join(', ')}, not ${columns.join(', ')}.` };
      if (loose) return { ok: false, detail: `the index on ${tableName} (${columns.join(', ')}) is ${unique ? 'not unique' : 'unique'} and should be ${unique ? 'unique' : 'not'}.` };
      return { ok: false, detail: `${tableName} has no ${what} on (${columns.join(', ')}) yet.` };
    },
    apply: (arg, d) => {
      const { tableName, columns } = parseIndexArg(arg);
      const t = findTable(d, tableName);
      if (!t) return false;
      const ids = columns.map((n) => t.columns.find((c) => eq(c.name, n))?.id).filter((x): x is string => !!x);
      if (ids.length !== columns.length) return false;
      const same = t.indexes.find((i) => [...i.columnIds].sort().join(',') === [...ids].sort().join(','));
      if (same) {
        if (same.columnIds.join(',') === ids.join(',') && same.unique === unique) return false;
        same.columnIds = ids;
        same.unique = unique;
        return true;
      }
      t.indexes.push(createIndex({ columnIds: ids, unique, name: `${unique ? 'uq' : 'idx'}_${t.name}_${columns.join('_')}` }));
      return true;
    },
  };
}

function groupSpec(external: boolean): Omit<GoalSpec, 'arg'> {
  const what = external ? 'external region' : 'region';
  return {
    check: (arg, { diagram: d }) => {
      const [name, members] = splitOn(arg);
      const g = d.groups.find((x) => eq(x.name, name));
      if (!g) return { ok: false, detail: `there is no region called ${name} yet.` };
      if (g.external !== external) return { ok: false, detail: `${name} is ${g.external ? 'marked external' : 'not marked external'}; it should be ${external ? '' : 'not '}.` };
      const want = commas(members);
      const got = d.tables.filter((t) => t.groupId === g.id).map((t) => t.name);
      const missing = want.filter((n) => !got.some((h) => eq(h, n)));
      return missing.length ? { ok: false, detail: `${name} does not hold ${missing.join(', ')} yet.` } : { ok: true, detail: `${name} is a ${what} holding ${got.join(', ') || 'nothing'}.` };
    },
    apply: (arg, d) => {
      const [name, members] = splitOn(arg);
      let g = d.groups.find((x) => eq(x.name, name));
      let changed = false;
      if (!g) {
        g = createGroup({ name, external, color: external ? 'purple' : 'slate', position: nextSlot(d) });
        d.groups.push(g);
        changed = true;
      }
      if (g.external !== external) {
        g.external = external;
        changed = true;
      }
      for (const n of commas(members)) {
        const t = findTable(d, n);
        if (t && t.groupId !== g.id) {
          t.groupId = g.id;
          changed = true;
        }
      }
      return changed;
    },
  };
}

/** Reads "books belongs to authors" back into the connection it describes. */
function matchReads(d: Diagram, sentence: string): { rel?: Relationship; phrase: string; detail: string } {
  const words = sentence.trim().split(/\s+/);
  if (words.length < 3) return { phrase: '', detail: `"${sentence}" is not a sentence like "books belongs to authors".` };
  const from = words[0];
  const to = words[words.length - 1];
  const phrase = words.slice(1, -1).join(' ');
  const rel = relBetween(d, from, to);
  return rel ? { rel, phrase, detail: '' } : { phrase, detail: `there is no connection from ${from} to ${to} yet.` };
}

/* ------------------------------------------------------------------ */
/* What a step is about                                                */
/* ------------------------------------------------------------------ */

/** Verbs whose subject is a connection rather than a table. */
const CONNECTION_VERBS = new Set(['fk', 'flow', 'embed', 'dependency', 'reads', 'label', 'reverse label', 'ondelete', 'query', 'select connection', 'derivation']);
/** Verbs whose subject is a table. */
const TABLE_VERBS = new Set(['table', 'view', 'column', 'no column', 'flags', 'default', 'check', 'schema', 'collapsed', 'materialized', 'viewsql', 'index', 'unique index', 'select table']);
/** Verbs whose subject is a code node: the one the step is about, or the one a call leaves. */
const CODE_VERBS = new Set(['code', 'calls', 'imports', 'extends', 'reads table', 'writes table', 'code collapsed', 'select code']);

export type Subject = { kind: 'table'; id: string } | { kind: 'relationship'; id: string } | { kind: 'code'; id: string };

/**
 * The thing on the canvas a step is about, read off its goals.
 *
 * The inspector shows whatever is selected, so a step that points at **Reads
 * as** or at the **Indexes** section is pointing at something that is only on
 * screen once the right connection or table is picked. Rather than make every
 * such step spell that out, the tour works it out from what the step is for —
 * which is the same thing the prose is about to tell the reader to select.
 */
export function subjectOfStep(goals: Goal[], d: Diagram): Subject | null {
  for (const g of goals) {
    if (CONNECTION_VERBS.has(g.verb)) {
      const rel = connectionSubject(g, d);
      if (rel) return { kind: 'relationship', id: rel.id };
      continue;
    }
    if (CODE_VERBS.has(g.verb)) {
      const ref = g.arg.includes('->') ? splitArrow(g.arg)[0] : splitOn(g.arg)[0];
      const node = findCodeRef(d, ref).node;
      if (node) return { kind: 'code', id: node.id };
      continue;
    }
    if (!TABLE_VERBS.has(g.verb)) continue;
    const subject = splitOn(g.arg)[0];
    const name = g.verb === 'index' || g.verb === 'unique index' ? parseIndexArg(g.arg).tableName : subject.includes('.') ? subject.slice(0, subject.lastIndexOf('.')) : subject;
    const t = findTable(d, name);
    if (t) return { kind: 'table', id: t.id };
  }
  return null;
}

function connectionSubject(g: Goal, d: Diagram): Relationship | undefined {
  if (g.verb === 'reads') return matchReads(d, g.arg).rel;
  if (g.verb === 'derivation') {
    const t = findTable(d, splitOn(g.arg)[0].split('.')[0]);
    return t ? d.relationships.find((r) => r.kind === 'flow' && r.targetTableId === t.id) : undefined;
  }
  const [from, to] = arrow(splitOn(g.arg)[0]);
  const fromName = from.includes('.') ? from.slice(0, from.lastIndexOf('.')) : from;
  const toName = to.includes('.') ? to.slice(0, to.lastIndexOf('.')) : to;
  return relBetween(d, fromName, toName);
}

/* ------------------------------------------------------------------ */
/* The two things a goal does                                          */
/* ------------------------------------------------------------------ */

export const GOAL_VERBS = Object.keys(GOALS);

/** True when **Do it for me** can make this goal true, which is not every goal. */
export function isFixable(goal: Goal): boolean {
  const spec = GOALS[goal.verb];
  return !!spec && (!!spec.apply || !!spec.applyView);
}

/** True when applying this goal drives the UI rather than editing the diagram. */
export function isViewGoal(goal: Goal): boolean {
  return !!GOALS[goal.verb]?.applyView;
}

export function evaluateGoal(goal: Goal, ctx: GoalContext): GoalStatus {
  const spec = GOALS[goal.verb];
  if (!spec) return { goal, ok: false, detail: `unknown goal verb "${goal.verb}".`, fixable: false };
  const out = spec.check(goal.arg, ctx);
  return { goal, ok: out.ok, detail: out.detail, fixable: isFixable(goal) };
}

export function evaluateGoals(goals: Goal[], ctx: GoalContext): GoalStatus[] {
  return goals.map((g) => evaluateGoal(g, ctx));
}

/** Applies the diagram half of a goal to a mutable draft. Returns whether anything changed. */
export function applyGoal(goal: Goal, draft: Diagram, ctx: GoalContext): boolean {
  const spec = GOALS[goal.verb];
  return spec?.apply ? spec.apply(goal.arg, draft, ctx) : false;
}

/** Applies the on-screen half of a goal. Returns whether anything was done. */
export function applyViewGoal(goal: Goal, ctx: GoalContext, api: TourViewApi): boolean {
  const spec = GOALS[goal.verb];
  return spec?.applyView ? spec.applyView(goal.arg, ctx, api) : false;
}
