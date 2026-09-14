/**
 * The connection metadata a schema script carries in its comments.
 *
 * A `.sql` file can only say what an engine understands, and most of what the
 * diagram knows about a connection has no SQL to be written in: a data flow, a
 * serialized copy, a dependency, the verb the connection reads with, the query
 * tagged onto it, the derivations behind a rollup. All of that used to reach
 * the exported script as prose — good to read, impossible to read back — so a
 * script that came home from a text editor arrived as bare foreign keys.
 *
 * The generator therefore also writes it as one JSON payload inside `--`
 * comments at the end of the script, and Import SQL reads it back. Two
 * consequences shape the format:
 *
 *  - It names tables and columns, never ids. A re-import mints fresh ids, and
 *    the script may be merged into a diagram whose ids came from somewhere
 *    else entirely; names are the only identity the two sides share.
 *  - It is line comments, not a block comment. A tagged query is free text and
 *    may well contain `*​/`, which would end a block comment early; `--` per
 *    line cannot be closed by anything the payload contains, because JSON
 *    escapes every newline inside a string.
 *
 * Nothing here is executable and nothing here is required: an engine ignores
 * the block, and deleting it costs only the annotations.
 */
import {
  AGGREGATE_FUNCTIONS,
  DEFAULT_VERBS,
  REFERENTIAL_ACTIONS,
  isCodeKind,
  isProgramLanguage,
  isProgramRole,
  isProgramStepOp,
  isRelationshipKind,
  isWindowFunction,
  normalizeVerb,
  programStepOpMeta,
  settleCodeNode,
  type AggregateFunction,
  type CodeKind,
  type Diagram,
  type ProgramLanguage,
  type ProgramRole,
  type ProgramStepOp,
  type ReferentialAction,
  type Relationship,
  type RelationshipKind,
  type RelationshipVerb,
  type WindowFunction,
} from '@shared/types';
import { externalTableIds } from '../groups';
import { codePath } from '../codemap';

/** Opening marker; the version lets a later format change be recognised rather than misread. */
const BEGIN = '-- dbviz:connections v1';
const END = '-- dbviz:end';
const BEGIN_RE = /^--\s*dbviz:connections\s+v(\d+)\s*$/i;
const END_RE = /^--\s*dbviz:end\s*$/i;

/** One derived column of a flow, with the target column named rather than referenced by id. */
export interface AnnotatedDerivation {
  /** Name of the target column this fills. */
  target: string;
  expression: string;
  aggregate?: AggregateFunction;
  groupBy?: string[];
  filter?: string;
  window?: { fn: WindowFunction; orderBy?: string[]; partitionBy?: string[] };
}

/** One connection as the script carries it. Tables and columns are named, not identified. */
export interface AnnotatedConnection {
  kind: RelationshipKind;
  verb?: RelationshipVerb;
  from: string;
  fromColumns?: string[];
  to: string;
  toColumns?: string[];
  name?: string;
  inverseName?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  /** The SQL tagged onto the connection, verbatim. */
  query?: string;
  note?: string;
  derivations?: AnnotatedDerivation[];
}

/** One step of a program, with its table and columns named rather than identified. */
export interface AnnotatedProgramStep {
  op: ProgramStepOp;
  /** Table name; absent on a compute step, and on a step whose table is gone. */
  table?: string;
  columns?: string[];
  /** The code node a call, import or extends step names, as a path ("api/orders.py/place_order"); absent when it is gone. */
  target?: string;
  sql?: string;
  code?: string;
  note?: string;
}

/**
 * One code node as the script carries it. Containment is written as the
 * parent's path rather than its id, for the reason everything else here is
 * named: an id means nothing once the file has been re-imported, and a path
 * is the one identity a node has that survives that.
 */
export interface AnnotatedProgram {
  name: string;
  /** Absent means a program. */
  kind?: CodeKind;
  /** Path of the container this node sits in, e.g. "api/orders.py". */
  parent?: string;
  collapsed?: boolean;
  language: ProgramLanguage;
  role?: ProgramRole;
  entrypoint?: string;
  comment?: string;
  steps: AnnotatedProgramStep[];
}

export interface SqlAnnotations {
  connections: AnnotatedConnection[];
  /** Absent in every block written before programs existed. */
  programs?: AnnotatedProgram[];
}

/**
 * Whether the script would lose something by not annotating this connection.
 *
 * A foreign key that reached the DDL already says who points at whom and what
 * happens on delete; it needs a block only for what the constraint cannot hold.
 * Everything else — a flow, an embed, a dependency, and any foreign key the
 * generator could not emit (one crossing into another database, one touching a
 * view) — exists nowhere else in the file, so it is always annotated.
 */
export function carriesMoreThanDdl(r: Relationship, emittedAsDdl: boolean): boolean {
  if (!emittedAsDdl) return true;
  const verb = normalizeVerb(r.kind, r.verb);
  return Boolean(
    r.query?.trim() ||
      r.note?.trim() ||
      r.inverseName?.trim() ||
      (verb && verb !== DEFAULT_VERBS[r.kind]) ||
      r.derivations?.length,
  );
}

function trimmed(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

function cleanList(v: string[] | undefined): string[] | undefined {
  const list = (v ?? []).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * The connections of a diagram that are worth writing down, in diagram order.
 * `emittedAsDdl` is the set of relationship ids the generator turned into real
 * statements; everything not in it is documentation the file would otherwise lose.
 *
 * A connection with an end in an external group is left out on purpose. Those
 * tables live in another database and the script does not create them, so there
 * would be nothing at the far end to attach the connection to on the way back;
 * the "External sources" appendix is where that part of the picture is kept.
 */
export function collectAnnotations(d: Diagram, emittedAsDdl: ReadonlySet<string>): SqlAnnotations {
  const external = externalTableIds(d);
  const tableName = new Map(d.tables.map((t) => [t.id, t.name] as const));
  // Per table, not diagram-wide: a name may only be written down for a column
  // of the table the connection says it belongs to.
  const columnsOf = new Map<string, Map<string, string>>(d.tables.map((t) => [t.id, new Map(t.columns.map((c) => [c.id, c.name] as const))] as const));
  const names = (tableId: string, ids: string[]) => {
    const byId = columnsOf.get(tableId);
    return ids.map((id) => byId?.get(id)).filter((n): n is string => Boolean(n));
  };

  const connections: AnnotatedConnection[] = [];
  for (const r of d.relationships) {
    const from = tableName.get(r.sourceTableId);
    const to = tableName.get(r.targetTableId);
    // A connection with an end that is not in the diagram, or that is in another
    // database, draws nothing and can point at nothing on the way back.
    if (!from || !to) continue;
    if (external.has(r.sourceTableId) || external.has(r.targetTableId)) continue;
    if (!carriesMoreThanDdl(r, emittedAsDdl.has(r.id))) continue;

    const targetColumns = columnsOf.get(r.targetTableId);
    const derivations: AnnotatedDerivation[] = [];
    for (const dv of r.kind === 'flow' ? (r.derivations ?? []) : []) {
      const target = targetColumns?.get(dv.targetColumnId);
      // An entry with no target column fills nothing; it is an unfinished edit,
      // not a fact about the schema.
      if (!target) continue;
      derivations.push({
        target,
        expression: dv.expression,
        ...(dv.aggregate ? { aggregate: dv.aggregate } : {}),
        ...(cleanList(dv.groupBy) ? { groupBy: cleanList(dv.groupBy) } : {}),
        ...(trimmed(dv.filter) ? { filter: trimmed(dv.filter) } : {}),
        ...(dv.window
          ? {
              window: {
                fn: dv.window.fn,
                ...(cleanList(dv.window.orderBy) ? { orderBy: cleanList(dv.window.orderBy) } : {}),
                ...(cleanList(dv.window.partitionBy) ? { partitionBy: cleanList(dv.window.partitionBy) } : {}),
              },
            }
          : {}),
      });
    }

    const fromColumns = names(r.sourceTableId, r.sourceColumnIds);
    const toColumns = names(r.targetTableId, r.targetColumnIds);
    const verb = normalizeVerb(r.kind, r.verb);
    connections.push({
      kind: r.kind,
      ...(verb ? { verb } : {}),
      from,
      ...(fromColumns.length ? { fromColumns } : {}),
      to,
      ...(toColumns.length ? { toColumns } : {}),
      ...(trimmed(r.name) ? { name: trimmed(r.name) } : {}),
      ...(trimmed(r.inverseName) ? { inverseName: trimmed(r.inverseName) } : {}),
      ...(r.onDelete && r.onDelete !== 'NO ACTION' ? { onDelete: r.onDelete } : {}),
      ...(r.onUpdate && r.onUpdate !== 'NO ACTION' ? { onUpdate: r.onUpdate } : {}),
      ...(trimmed(r.query) ? { query: trimmed(r.query) } : {}),
      ...(trimmed(r.note) ? { note: trimmed(r.note) } : {}),
      ...(derivations.length ? { derivations } : {}),
    });
  }
  // A program is documentation with no DDL of its own, so it is always carried.
  // Its steps name tables, and a step pointing at a table the script does not
  // define keeps its prose and its code while losing only the pointer: the code
  // is the part nobody can reconstruct. The same goes for the code inside it
  // and for a call to a node that is gone.
  const codeById = new Map(d.programs.map((p) => [p.id, p]));
  const pathOf = (id: string | undefined) => {
    const node = id ? codeById.get(id) : undefined;
    return node ? codePath(d, node, codeById) : undefined;
  };
  const programs: AnnotatedProgram[] = d.programs.map((prg) => ({
    name: prg.name,
    ...(prg.kind && prg.kind !== 'program' ? { kind: prg.kind } : {}),
    ...(pathOf(prg.parentId) ? { parent: pathOf(prg.parentId) } : {}),
    ...(prg.collapsed ? { collapsed: true } : {}),
    language: prg.language,
    ...(prg.role ? { role: prg.role } : {}),
    ...(trimmed(prg.entrypoint) ? { entrypoint: trimmed(prg.entrypoint) } : {}),
    ...(trimmed(prg.comment) ? { comment: trimmed(prg.comment) } : {}),
    steps: prg.steps.map((s) => {
      const meta = programStepOpMeta(s.op);
      const table = meta.touchesDatabase ? tableName.get(s.tableId ?? '') : undefined;
      const columns = table ? names(s.tableId!, s.columnIds) : [];
      const target = meta.namesCode ? pathOf(s.codeId) : undefined;
      return {
        op: s.op,
        ...(table ? { table } : {}),
        ...(columns.length ? { columns } : {}),
        ...(target ? { target } : {}),
        ...(trimmed(s.sql) ? { sql: trimmed(s.sql) } : {}),
        ...(trimmed(s.code) ? { code: trimmed(s.code) } : {}),
        ...(trimmed(s.note) ? { note: trimmed(s.note) } : {}),
      };
    }),
  }));

  return { connections, ...(programs.length ? { programs } : {}) };
}

/**
 * The annotations as the commented block that ends the script, or '' when there
 * is nothing to carry. The prose above the payload is for whoever opens the
 * file in an editor and wonders what they are allowed to delete.
 */
export function annotationComment(a: SqlAnnotations): string {
  if (!a.connections.length && !a.programs?.length) return '';
  const payload = JSON.stringify(a, null, 2)
    .split('\n')
    .map((l) => `-- ${l}`.trimEnd())
    .join('\n');
  return [
    '-- ----------------------------------------------------------------',
    '-- Connection metadata: the same connections once more, in the form Import SQL',
    '-- reads. It is how this script comes home with its data flows, its verbs, its',
    '-- notes, its tagged queries and the programs that talk to it still on it.',
    '-- Tables and columns are named here rather than numbered, so renaming one',
    '-- above renames it here too. No engine reads any of this: delete the block and',
    '-- the schema still runs, only the annotations are gone.',
    BEGIN,
    payload,
    END,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Reading it back                                                     */
/* ------------------------------------------------------------------ */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map((x) => x.trim()) : [];
}

function action(v: unknown): ReferentialAction | undefined {
  return REFERENTIAL_ACTIONS.includes(v as ReferentialAction) ? (v as ReferentialAction) : undefined;
}

function derivation(v: unknown): AnnotatedDerivation | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const target = str(o.target);
  if (!target) return null;
  const aggregate = AGGREGATE_FUNCTIONS.includes(o.aggregate as AggregateFunction) ? (o.aggregate as AggregateFunction) : undefined;
  const w = o.window && typeof o.window === 'object' ? (o.window as Record<string, unknown>) : null;
  const groupBy = strList(o.groupBy);
  return {
    target,
    expression: typeof o.expression === 'string' ? o.expression : '',
    ...(aggregate ? { aggregate } : {}),
    ...(groupBy.length ? { groupBy } : {}),
    ...(str(o.filter) ? { filter: str(o.filter) } : {}),
    ...(w && isWindowFunction(w.fn) ? { window: { fn: w.fn, orderBy: strList(w.orderBy), partitionBy: strList(w.partitionBy) } } : {}),
  };
}

function connection(v: unknown): AnnotatedConnection | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const from = str(o.from);
  const to = str(o.to);
  if (!from || !to) return null;
  const kind: RelationshipKind = isRelationshipKind(o.kind) ? o.kind : 'fk';
  const fromColumns = strList(o.fromColumns);
  const toColumns = strList(o.toColumns);
  const derivations = (Array.isArray(o.derivations) ? o.derivations : []).map(derivation).filter((x): x is AnnotatedDerivation => x !== null);
  return {
    kind,
    ...(normalizeVerb(kind, o.verb) ? { verb: normalizeVerb(kind, o.verb) } : {}),
    from: from.trim(),
    ...(fromColumns.length ? { fromColumns } : {}),
    to: to.trim(),
    ...(toColumns.length ? { toColumns } : {}),
    ...(str(o.name) ? { name: str(o.name) } : {}),
    ...(str(o.inverseName) ? { inverseName: str(o.inverseName) } : {}),
    ...(action(o.onDelete) ? { onDelete: action(o.onDelete) } : {}),
    ...(action(o.onUpdate) ? { onUpdate: action(o.onUpdate) } : {}),
    ...(str(o.query) ? { query: str(o.query) } : {}),
    ...(str(o.note) ? { note: str(o.note) } : {}),
    ...(derivations.length ? { derivations } : {}),
  };
}

function programStep(v: unknown): AnnotatedProgramStep | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const op = isProgramStepOp(o.op) ? o.op : 'read';
  const meta = programStepOpMeta(op);
  const columns = strList(o.columns);
  return {
    op,
    ...(meta.touchesDatabase && str(o.table) ? { table: str(o.table)!.trim() } : {}),
    ...(meta.touchesDatabase && columns.length ? { columns } : {}),
    ...(meta.namesCode && str(o.target) ? { target: str(o.target)!.trim() } : {}),
    ...(meta.touchesDatabase && str(o.sql) ? { sql: str(o.sql) } : {}),
    ...(str(o.code) ? { code: str(o.code) } : {}),
    ...(str(o.note) ? { note: str(o.note) } : {}),
  };
}

function program(v: unknown): AnnotatedProgram | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  // Settled the same way the file loader settles it, so a block pasted from
  // one script into another cannot smuggle in a data file that runs.
  const settled = settleCodeNode(isCodeKind(o.kind) ? o.kind : 'program', isProgramLanguage(o.language) ? o.language : 'other');
  return {
    name: name.trim(),
    ...(settled.kind !== 'program' ? { kind: settled.kind } : {}),
    ...(str(o.parent) ? { parent: str(o.parent)!.trim() } : {}),
    ...(o.collapsed === true ? { collapsed: true } : {}),
    language: settled.language,
    ...(isProgramRole(o.role) && settled.kind === 'program' ? { role: o.role } : {}),
    ...(str(o.entrypoint) ? { entrypoint: str(o.entrypoint) } : {}),
    ...(str(o.comment) ? { comment: str(o.comment) } : {}),
    steps: settled.kind === 'data' ? [] : (Array.isArray(o.steps) ? o.steps : []).map(programStep).filter((s): s is AnnotatedProgramStep => s !== null),
  };
}

/**
 * Pull the annotation blocks out of a script.
 *
 * More than one is normal: pasting two exported scripts together should give
 * you the connections of both, exactly as it gives you the tables of both, so
 * every block is read and their connections concatenated in file order.
 *
 * Returns null when there is no block at all, and null plus an error when
 * every block found was unreadable — a damaged one is reported by the importer
 * as a warning, because a script is still a script without its annotations.
 */
export function readAnnotations(sql: string): { annotations: SqlAnnotations | null; error?: string } {
  const lines = sql.split(/\r?\n/);
  const connections: AnnotatedConnection[] = [];
  const programs: AnnotatedProgram[] = [];
  let found = 0;
  let error: string | undefined;
  const fail = (message: string) => {
    if (!error) error = message;
  };

  for (let i = 0; i < lines.length; i++) {
    const m = BEGIN_RE.exec(lines[i].trim());
    if (!m) continue;
    found++;
    if (Number(m[1]) !== 1) {
      fail(`This script's connection metadata is version ${Number(m[1])} and this build reads version 1; those connections were not restored.`);
      continue;
    }

    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (END_RE.test(line)) break;
      // The payload is contiguous line comments; anything else means the block
      // was cut short and whatever follows is not ours to read.
      if (!line.startsWith('--')) break;
      body.push(line.replace(/^--\s?/, ''));
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body.join('\n'));
    } catch {
      fail("This script's connection metadata could not be read; those connections were not restored.");
      continue;
    }
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    for (const c of Array.isArray(o.connections) ? o.connections : []) {
      const parsed = connection(c);
      if (parsed) connections.push(parsed);
    }
    for (const pr of Array.isArray(o.programs) ? o.programs : []) {
      const parsed = program(pr);
      if (parsed) programs.push(parsed);
    }
  }

  if (!found) return { annotations: null };
  // A block that yielded nothing at all and reported a problem is unreadable; a
  // block that yielded only programs is perfectly good.
  if (!connections.length && !programs.length && error) return { annotations: null, error };
  return { annotations: { connections, ...(programs.length ? { programs } : {}) }, ...(error ? { error } : {}) };
}
