/**
 * Stored procedures and functions: code the database holds and runs itself.
 *
 * A procedure is drawn as a code node, because what it *does* has exactly the
 * shape a program's work has — an ordered list of reads, writes, work and calls
 * — and the arrows to the tables it touches are derived from those steps the
 * same way. What sets it apart is where it lives. A program is the caller,
 * outside the database; a procedure is part of the schema. So it is created by
 * the generated script after the tables and views it names, replaced by a
 * migration, read back off a live database, and imported from a pasted
 * `CREATE PROCEDURE`.
 *
 * Two things describe a procedure, and they are kept in step rather than
 * merged:
 *
 *  - the steps, which are what the canvas draws and what a reader scans;
 *  - the body, which is what the engine runs.
 *
 * A body typed or imported is the truth for the DDL, verbatim. A procedure with
 * no body yet gets one written from its steps, so a procedure sketched as four
 * steps is already one the database can create. Going the other way,
 * `stepsFromBody` reads a body and draws the steps it implies, which is what an
 * import does and what the inspector's "Detect steps" button does — the same
 * move "Detect from SQL" makes for a view.
 */
import {
  engineName,
  isProcedure,
  isRoutineLanguage,
  type Diagram,
  type Dialect,
  type Program,
  type ProcedureParam,
  type ProcedureParamMode,
  type ProgramStep,
  type Table,
} from '@shared/types';
import { newId } from './ids';
import { createProgram, createProgramStep } from './model';
import { describeStep } from './programs';
import { referencedTables, splitStatements } from './sql/analyze';
import { scanSql } from './sql/highlight';
import { quoteIdent, quoteQualified, quoteString, translateType } from './sql/dialect';
import { parseSql, type ParsedRoutine } from './sql/parser';

/** Engines with stored procedures. SQLite has none; DuckDB has macros, which are expressions rather than routines. */
export function dialectHasProcedures(dialect: Dialect): boolean {
  return dialect === 'postgresql' || dialect === 'mariadb';
}

/** A routine with a return type is a stored function; without one, a procedure. */
export function isStoredFunction(p: Pick<Program, 'returns'>): boolean {
  return Boolean(p.returns?.trim());
}

export function routineKeyword(p: Pick<Program, 'returns'>): 'PROCEDURE' | 'FUNCTION' {
  return isStoredFunction(p) ? 'FUNCTION' : 'PROCEDURE';
}

/** "procedure" or "function", for sentences. */
export function routineNoun(p: Pick<Program, 'returns'>): string {
  return isStoredFunction(p) ? 'stored function' : 'stored procedure';
}

/** The diagram's procedures, in diagram order. */
export function proceduresOf(d: Diagram): Program[] {
  return d.programs.filter(isProcedure);
}

/** Parameters with a name and a type; half-typed rows in the editor are kept but never emitted. */
export function usableParams(p: Program): ProcedureParam[] {
  return (p.params ?? []).filter((x) => x.name.trim() && x.type.trim());
}

export function createProcedureParam(partial: Partial<ProcedureParam> = {}): ProcedureParam {
  const { id, ...rest } = partial;
  return { id: id ?? newId('param'), name: '', type: '', ...rest };
}

function modeWord(mode: ProcedureParamMode | undefined): string {
  return mode === 'out' ? 'OUT' : mode === 'inout' ? 'INOUT' : 'IN';
}

/**
 * The routine as a reader wants to see it named: "archive_orders(IN before date)"
 * or "order_total(order_id integer) → numeric". For the node, the tooltip and
 * the exports; the DDL spells it per engine instead.
 */
export function procedureSignature(p: Program): string {
  const params = usableParams(p).map((x) => `${x.mode && x.mode !== 'in' ? `${modeWord(x.mode)} ` : ''}${x.name} ${x.type}`);
  const head = `${p.schema ? `${p.schema}.` : ''}${p.name}(${params.join(', ')})`;
  return isStoredFunction(p) ? `${head} → ${p.returns!.trim()}` : head;
}

/**
 * The parameter list for a CREATE statement.
 *
 * PostgreSQL writes the mode only when it is not IN and allows a DEFAULT;
 * MariaDB writes modes on a procedure, allows none on a function (a function's
 * parameters are always IN there), and has no parameter defaults at all.
 */
function paramList(p: Program, dialect: Dialect, warnings: string[]): string {
  const fn = isStoredFunction(p);
  return usableParams(p)
    .map((x) => {
      const name = quoteIdent(x.name.trim(), dialect);
      const type = x.type.trim();
      if (dialect === 'mariadb') {
        if (x.defaultValue?.trim()) warnings.push(`MariaDB parameters have no defaults, so the default on ${p.name}.${x.name} was left out.`);
        if (fn) {
          if (x.mode && x.mode !== 'in') warnings.push(`MariaDB functions take IN parameters only, so ${p.name}.${x.name} was written as IN.`);
          return `${name} ${type}`;
        }
        return `${modeWord(x.mode)} ${name} ${type}`;
      }
      const mode = x.mode && x.mode !== 'in' ? `${modeWord(x.mode)} ` : '';
      const def = x.defaultValue?.trim() ? ` DEFAULT ${x.defaultValue.trim()}` : '';
      return `${mode}${name} ${type}${def}`;
    })
    .join(', ');
}

/**
 * The argument types PostgreSQL identifies a routine by, for COMMENT ON and
 * DROP. Modes are written out, because PostgreSQL 14 counts a procedure's OUT
 * parameters in its signature and a function's not, and an explicit mode is
 * the one spelling both read the same way.
 */
function pgArgTypes(p: Program): string {
  return usableParams(p)
    .map((x) => `${modeWord(x.mode)} ${x.type.trim()}`)
    .join(', ');
}

function qualifiedName(p: Program, dialect: Dialect): string {
  return quoteQualified(p.name.trim(), p.schema?.trim() || undefined, dialect);
}

/** A dollar-quote tag the body does not itself contain. */
export function dollarTag(body: string): string {
  if (!body.includes('$$')) return '$$';
  for (let i = 0; ; i++) {
    const tag = `$body${i || ''}$`;
    if (!body.includes(tag)) return tag;
  }
}

/* ------------------------------------------------------------------ */
/* The body, written from the steps                                    */
/* ------------------------------------------------------------------ */

function ensureSemicolon(sql: string): string {
  const t = sql.trim();
  return /;\s*$/.test(t) ? t : `${t};`;
}

function indent(text: string, by = '  '): string {
  return text
    .split('\n')
    .map((l) => (l.trim() ? by + l : l))
    .join('\n');
}

/** The statement a step's placeholder suggests, so the comment says what to write rather than only that something is missing. */
function suggestedStatement(s: ProgramStep, table: Table | undefined, dialect: Dialect): string {
  const name = table ? quoteQualified(table.name, table.schema, dialect) : '?';
  const cols = table ? s.columnIds.map((id) => table.columns.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n)) : [];
  if (s.op === 'read') return `SELECT ${cols.length ? cols.map((c) => quoteIdent(c, dialect)).join(', ') : '*'} FROM ${name}`;
  return cols.length ? `INSERT INTO ${name} (${cols.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES (…)` : `INSERT INTO ${name} … / UPDATE ${name} SET …`;
}

/**
 * The body a procedure's steps describe, for when nobody has written one.
 *
 * Each step becomes a numbered comment saying what it is, followed by the
 * statement it carries. A read or write with no SQL yet gets the statement it
 * would be as a comment, and a call to a routine that takes no arguments gets
 * its CALL, so the result always creates: an empty BEGIN … END is a valid
 * body on both engines, which is what a placeholder-only body amounts to.
 * Consecutive steps carrying the very same statement (an INSERT … SELECT that
 * reads one table and writes another) write it once.
 */
export function bodyFromSteps(d: Diagram, p: Program, dialect: Dialect = d.dialect): string {
  const tableById = new Map(d.tables.map((t) => [t.id, t] as const));
  const codeById = new Map(d.programs.map((x) => [x.id, x] as const));
  const lines: string[] = [];
  let lastSql = '';
  p.steps.forEach((s, i) => {
    const table = s.tableId ? tableById.get(s.tableId) : undefined;
    const target = s.codeId ? codeById.get(s.codeId) : undefined;
    lines.push(`-- ${i + 1}. ${describeStep(s, table, target)}${s.note?.trim() && s.op !== 'compute' ? ` — ${s.note.trim()}` : ''}`);
    if (s.op === 'read' || s.op === 'write') {
      const sql = s.sql?.trim();
      if (sql) {
        if (sql !== lastSql) lines.push(ensureSemicolon(sql));
        lastSql = sql;
      } else lines.push(`-- ${suggestedStatement(s, table, dialect)};`);
      return;
    }
    lastSql = '';
    if (s.op === 'compute') {
      if (s.code?.trim()) lines.push(s.code.trim());
      return;
    }
    if (s.op === 'call') {
      if (s.code?.trim()) {
        lines.push(ensureSemicolon(s.code));
        return;
      }
      // Arguments are the one thing the diagram cannot know, so a call that
      // needs any is left as a comment naming them rather than guessed at.
      const call = target && isProcedure(target) ? callStatement(target, dialect, { inPlpgsql: dialect === 'postgresql' ? (p.routineLanguage ?? 'plpgsql') === 'plpgsql' : true }) : null;
      const needsArgs = !target || usableParams(target).some((x) => !(isStoredFunction(target) && x.mode === 'out'));
      lines.push(call && !needsArgs ? call : `-- ${call ?? `CALL ${target?.name ?? '?'}(…);`}`);
    }
  });
  const inner = lines.join('\n');
  if (dialect === 'postgresql' && (p.routineLanguage ?? 'plpgsql') === 'sql') return inner;
  if (dialect === 'postgresql') return inner ? `BEGIN\n${indent(inner)}\nEND;` : 'BEGIN\nEND;';
  return inner ? `BEGIN\n${indent(inner)}\nEND` : 'BEGIN\nEND';
}

/** What the DDL writes as the body: the one typed or imported, else the one the steps describe. */
export function procedureBody(d: Diagram, p: Program, dialect: Dialect = d.dialect): string {
  return p.body?.trim() ? p.body.replace(/^\s*\n/, '').replace(/\s+$/, '') : bodyFromSteps(d, p, dialect);
}

/**
 * How code calls the routine: CALL for a procedure, and for a function the
 * statement that evaluates it and throws the value away (PERFORM inside
 * PL/pgSQL, DO on MariaDB). Arguments are written as the parameter names, which
 * is what a reader fills in.
 */
export function callStatement(p: Program, dialect: Dialect, opts: { inPlpgsql?: boolean } = { inPlpgsql: true }): string {
  const args = usableParams(p)
    .filter((x) => !(isStoredFunction(p) && x.mode === 'out'))
    .map((x) => x.name.trim())
    .join(', ');
  const call = `${qualifiedName(p, dialect)}(${args})`;
  if (!isStoredFunction(p)) return `CALL ${call};`;
  if (dialect === 'postgresql') return opts.inPlpgsql ? `PERFORM ${call};` : `SELECT ${call};`;
  return opts.inPlpgsql ? `DO ${call};` : `SELECT ${call};`;
}

/* ------------------------------------------------------------------ */
/* DDL                                                                 */
/* ------------------------------------------------------------------ */

export interface ProcedureDdl {
  /** What a driver runs, in order: the CREATE, then any COMMENT ON. Empty on an engine with no procedures. */
  statements: string[];
  /** The same for a person reading the script: MariaDB's body wrapped in DELIMITER, or a commented-out copy where the engine cannot run it. */
  script: string;
}

/**
 * CREATE [OR REPLACE] PROCEDURE / FUNCTION for one procedure, per engine.
 *
 * OR REPLACE is written on both engines that have procedures, so the script can
 * be run again over a database that already has them — the same reason views
 * are written that way on MariaDB. On SQLite and DuckDB there is nothing to
 * run, and the procedure is written into the script as a comment rather than
 * dropped, so the file still documents it (the annotation block is what brings
 * it back on import).
 */
export function procedureDdl(d: Diagram, p: Program, warnings: string[] = [], dialect: Dialect = d.dialect): ProcedureDdl {
  const name = p.name.trim();
  if (!name) {
    warnings.push('A procedure has no name, so it was left out of the script.');
    return { statements: [], script: '' };
  }
  const body = procedureBody(d, p, dialect);
  const keyword = routineKeyword(p);
  const fn = isStoredFunction(p);

  if (!dialectHasProcedures(dialect)) {
    warnings.push(`${engineName(dialect)} has no stored procedures, so ${name} is written into the script as a comment rather than created.`);
    const sig = procedureSignature(p);
    const lines = [`-- ${keyword.toLowerCase()} ${sig} (${engineName(dialect)} cannot create it)`];
    if (p.comment?.trim()) lines.push(...p.comment.trim().split('\n').map((l) => `--   ${l}`));
    lines.push(...body.split('\n').map((l) => `--   ${l}`));
    return { statements: [], script: lines.join('\n') };
  }

  const params = paramList(p, dialect, warnings);
  const head = `CREATE OR REPLACE ${keyword} ${qualifiedName(p, dialect)}(${params})`;

  if (dialect === 'postgresql') {
    const language = isRoutineLanguage(p.routineLanguage) ? p.routineLanguage : 'plpgsql';
    const tag = dollarTag(body);
    const create = [head, ...(fn ? [`RETURNS ${p.returns!.trim()}`] : []), `LANGUAGE ${language}`, `AS ${tag}`, body, `${tag};`].join('\n');
    const statements = [create];
    if (p.comment?.trim()) statements.push(`COMMENT ON ${keyword} ${qualifiedName(p, dialect)}(${pgArgTypes(p)}) IS ${quoteString(p.comment.trim())};`);
    return { statements, script: statements.join('\n') };
  }

  // MariaDB. The comment is a characteristic of the routine rather than a statement of its own.
  const characteristics: string[] = [];
  if (fn) characteristics.push(`RETURNS ${p.returns!.trim()}`);
  if (p.comment?.trim()) characteristics.push(`COMMENT ${quoteString(p.comment.trim())}`);
  // The statement ends where the body does, so a body typed with its own
  // closing `END;` must not end up as `END;;`.
  const create = [head, ...characteristics, body.replace(/[\s;]+$/, '')].join('\n');
  // A driver sends one statement at a time and needs no delimiter games; the
  // mariadb command-line client splits at every ';', so the script has to move
  // the delimiter out of the body's way first.
  return { statements: [`${create};`], script: ['DELIMITER //', `${create} //`, 'DELIMITER ;'].join('\n') };
}

/** DROP for one procedure, or null where the engine has none. */
export function dropProcedureStatement(p: Pick<Program, 'name' | 'schema' | 'returns' | 'params'>, dialect: Dialect): string | null {
  if (!dialectHasProcedures(dialect) || !p.name.trim()) return null;
  const keyword = routineKeyword(p);
  const name = quoteQualified(p.name.trim(), p.schema?.trim() || undefined, dialect);
  if (dialect === 'postgresql') return `DROP ${keyword} IF EXISTS ${name}(${pgArgTypes(p as Program)});`;
  return `DROP ${keyword} IF EXISTS ${name};`;
}

/* ------------------------------------------------------------------ */
/* Steps, read out of a body                                           */
/* ------------------------------------------------------------------ */

const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);
const READ_WORDS = new Set(['SELECT', 'WITH', 'PERFORM']);

/** Where the first top-level word of a set starts in a statement, or -1. */
function firstTopLevel(text: string, words: Set<string>): number {
  let depth = 0;
  let prev = '';
  for (const s of scanSql(text)) {
    if (s.kind === 'space' || s.kind === 'comment') continue;
    if (s.kind === 'punct') {
      if (s.text === '(') depth++;
      else if (s.text === ')') depth = Math.max(0, depth - 1);
      prev = s.text;
      continue;
    }
    const up = s.kind === 'word' ? s.text.toUpperCase() : '';
    // The REPLACE of CREATE OR REPLACE is not MariaDB's REPLACE INTO.
    if (depth === 0 && words.has(up) && !(up === 'REPLACE' && prev === 'OR')) return s.start;
    prev = up;
  }
  return -1;
}

/**
 * The table or view a statement makes or empties: `CREATE [OR REPLACE]
 * [TEMP | UNLOGGED | MATERIALIZED …] TABLE | VIEW [IF NOT EXISTS] name` or
 * `TRUNCATE [TABLE] [ONLY] name`. A procedure that builds a table is writing
 * it as surely as one that inserts into it, and the canvas should say so.
 */
function madeOrEmptied(text: string): { name: string; at: number } | null {
  const segs = scanSql(text).filter((x) => x.kind !== 'space' && x.kind !== 'comment');
  const up = (i: number) => (segs[i]?.kind === 'word' ? segs[i].text.toUpperCase() : '');
  const nameAt = (i: number): string | null => {
    if (!segs[i] || (segs[i].kind !== 'word' && segs[i].kind !== 'quoted')) return null;
    let j = i;
    while (segs[j + 1]?.text === '.' && segs[j + 2]) j += 2;
    return segs[j].text.replace(/^["`]|["`]$/g, '');
  };
  const at = segs.findIndex((x) => x.kind === 'word' && /^(CREATE|TRUNCATE)$/i.test(x.text));
  if (at < 0) return null;
  let i = at + 1;
  if (up(at) === 'TRUNCATE') {
    if (up(i) === 'TABLE') i++;
    if (up(i) === 'ONLY') i++;
  } else {
    if (up(i) === 'OR' && up(i + 1) === 'REPLACE') i += 2;
    while (['TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'MATERIALIZED', 'RECURSIVE'].includes(up(i))) i++;
    if (up(i) !== 'TABLE' && up(i) !== 'VIEW') return null;
    i++;
    if (up(i) === 'IF' && up(i + 1) === 'NOT' && up(i + 2) === 'EXISTS') i += 3;
  }
  const name = nameAt(i);
  return name ? { name, at: segs[at].start } : null;
}

/** A read inside `FOR r IN SELECT … LOOP` ends where the loop body begins. */
function cutAtLoop(text: string): string {
  let depth = 0;
  for (const s of scanSql(text)) {
    if (s.kind === 'punct') {
      if (s.text === '(') depth++;
      else if (s.text === ')') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && s.kind === 'word' && s.text.toUpperCase() === 'LOOP') return text.slice(0, s.start).trim();
  }
  return text.trim();
}

/** `CALL name(...)` at the top level of a statement: the routine it names, bare. */
function calledRoutine(text: string): string | null {
  const segs = scanSql(text).filter((s) => s.kind !== 'space' && s.kind !== 'comment');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].kind !== 'word' || segs[i].text.toUpperCase() !== 'CALL') continue;
    let j = i + 1;
    const unq = (t: string) => t.replace(/^["`]|["`]$/g, '');
    let name = unq(segs[j].text);
    while (segs[j + 1]?.text === '.' && segs[j + 2]) {
      name = unq(segs[j + 2].text);
      j += 2;
    }
    return name;
  }
  return null;
}

/**
 * The steps a body implies, in the order it does things.
 *
 * Every statement is read for the tables it names — FROM and JOIN read,
 * INSERT INTO, UPDATE and DELETE FROM write — and for a CALL of another
 * routine. Control flow (IF, LOOP, DECLARE, RETURN) draws nothing of its own:
 * a step is something that touches data, and the statements inside the control
 * flow are what do. Each step keeps the statement it came from as its SQL, so
 * nothing the body said is lost from the step list. Names that resolve to no
 * table (a temporary table, a CTE the scanner missed) and calls to routines the
 * diagram does not hold are left out rather than drawn to nowhere.
 */
export function stepsFromBody(
  body: string,
  resolveTable: (name: string) => Table | undefined,
  resolveRoutine: (name: string) => Program | undefined = () => undefined,
): ProgramStep[] {
  const steps: ProgramStep[] = [];
  const bare = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name);
  for (const stmt of splitStatements(body)) {
    const text = stmt.text.replace(/;\s*$/, '');
    const called = calledRoutine(text);
    if (called) {
      const target = resolveRoutine(called);
      if (target) steps.push(createProgramStep({ op: 'call', codeId: target.id, code: ensureSemicolon(text.slice(firstTopLevel(text, new Set(['CALL'])))) }));
      continue;
    }
    const made = madeOrEmptied(text);
    const refs = [...referencedTables(text), ...(made ? [{ name: made.name, role: 'write' as const }] : [])];
    if (!refs.length) continue;
    const writeAt = made ? made.at : firstTopLevel(text, WRITE_WORDS);
    const readAt = firstTopLevel(text, READ_WORDS);
    const writeSql = writeAt >= 0 ? text.slice(writeAt).trim() : '';
    const readSql = readAt >= 0 && (writeAt < 0 || readAt < writeAt) ? cutAtLoop(text.slice(readAt)) : writeSql || text.trim();
    const seen = new Set<string>();
    // Reads first: a statement reads its sources before it writes its target.
    for (const role of ['read', 'write'] as const) {
      for (const ref of refs) {
        if (ref.role !== role) continue;
        const table = resolveTable(ref.name) ?? resolveTable(bare(ref.name));
        if (!table) continue;
        const key = `${role}:${table.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        steps.push(createProgramStep({ op: role, tableId: table.id, sql: role === 'write' ? writeSql || text.trim() : readSql }));
      }
    }
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* From a parsed or introspected routine                               */
/* ------------------------------------------------------------------ */

/** A routine as the SQL parser and the introspection both hand it over. */
export type RoutineSource = ParsedRoutine;

/**
 * Procedure nodes for a set of routines, their steps read out of their bodies.
 *
 * Done as a batch because a body may CALL another routine of the same batch,
 * and that call can only be drawn once every node has an id. `existing` is the
 * diagram's own procedures, which a call may also reach.
 */
export function proceduresFromRoutines(routines: RoutineSource[], resolveTable: (name: string) => Table | undefined, existing: Program[] = []): Program[] {
  const nodes = routines.map((r) =>
    createProgram({
      name: r.name,
      kind: 'procedure',
      language: 'other',
      ...(r.schema ? { schema: r.schema } : {}),
      params: r.params.map((x) => createProcedureParam({ name: x.name, type: x.type, ...(x.mode && x.mode !== 'in' ? { mode: x.mode } : {}), ...(x.defaultValue ? { defaultValue: x.defaultValue } : {}) })),
      ...(r.kind === 'function' && r.returns?.trim() ? { returns: r.returns.trim() } : {}),
      ...(isRoutineLanguage(r.language?.toLowerCase()) && r.language!.toLowerCase() !== 'plpgsql' ? { routineLanguage: r.language!.toLowerCase() as 'sql' } : {}),
      body: r.body.replace(/^\s*\n/, '').replace(/\s+$/, ''),
      ...(r.comment?.trim() ? { comment: r.comment.trim() } : {}),
      color: 'teal',
    }),
  );
  const all = [...nodes, ...existing.filter(isProcedure)];
  const resolveRoutine = (name: string) => all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  for (const node of nodes) node.steps = stepsFromBody(node.body ?? '', resolveTable, resolveRoutine);
  return nodes;
}

/* ------------------------------------------------------------------ */
/* A whole CREATE statement, pasted into an existing procedure         */
/* ------------------------------------------------------------------ */

/**
 * Whether text is a CREATE PROCEDURE / FUNCTION statement rather than a body:
 * what a person pastes when they copy a routine out of a migration file, pg_dump
 * or a SQL client. A leading DELIMITER line (the mariadb client's) is allowed.
 */
export function looksLikeCreateRoutine(text: string): boolean {
  // Anywhere a statement can start, so a paste that restates the tables and
  // views before the procedure counts too; a commented-out one does not.
  return /(?:^|[;\n])\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION)\b/i.test(text);
}

export interface RoutineDefinition {
  /** Every field the statement decides, absent ones set to undefined so they clear what was there. */
  patch: Pick<Program, 'name' | 'schema' | 'params' | 'returns' | 'routineLanguage' | 'body' | 'comment'>;
  /** The steps its body implies, read against the diagram's tables and procedures. */
  steps: ProgramStep[];
  warnings: string[];
}

/**
 * Read a pasted CREATE [OR REPLACE] PROCEDURE / FUNCTION into the fields of a
 * procedure: its name, schema, parameters, return type, body language, body
 * (only what is inside the dollar quotes, or the BEGIN … END), and a COMMENT
 * if the paste carries one. Null when the text holds no routine the parser can
 * read, so the caller can let the paste land as plain text instead.
 *
 * A paste may restate the tables and views the routine works on, or hold
 * several routines. `prefer` picks the routine by name (the one the procedure
 * is already called), else the first is read; everything else in the paste is
 * the caller's to import beside it.
 */
export function readCreateRoutine(text: string, d: Diagram, prefer?: string): RoutineDefinition | null {
  const res = parseSql(text, d.dialect);
  const routines = res.routines ?? [];
  if (!routines.length) return null;
  const warnings = res.errors.map((e) => `line ${e.line}: ${e.message}`);
  // Of several, the one this procedure is already called, else the first.
  const chosen = routines.find((r) => prefer && r.name.toLowerCase() === prefer.toLowerCase()) ?? routines[0];
  const byName = (name: string) => d.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
  const [def] = proceduresFromRoutines([chosen], byName, d.programs);
  return {
    patch: {
      name: def.name,
      schema: def.schema,
      params: def.params?.length ? def.params : undefined,
      returns: def.returns,
      routineLanguage: def.routineLanguage,
      body: def.body?.trim() ? def.body : undefined,
      // A statement with no COMMENT says nothing about what the routine is
      // for, so what the diagram already says is kept.
      ...(def.comment ? { comment: def.comment } : {}),
    },
    steps: def.steps,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Keeping procedures in step with the rest of the diagram             */
/* ------------------------------------------------------------------ */

/** Parameter and return types translated along with the columns when the dialect changes. */
export function translateProcedureTypes(p: Program, from: Dialect, to: Dialect): void {
  for (const x of p.params ?? []) if (x.type.trim()) x.type = translateType(x.type, from, to);
  if (p.returns?.trim() && !/^(TABLE|SETOF)\b/i.test(p.returns.trim())) p.returns = translateType(p.returns, from, to);
}

/**
 * A body reduced to what matters for "is it the same routine": comments,
 * whitespace and case gone. Engines store a body as it was written (PostgreSQL's
 * prosrc, MariaDB's ROUTINE_DEFINITION), so this only has to forgive the
 * formatting a person or a dump tool might have changed.
 */
export function normalizeBody(body: string): string {
  return body
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;=<>])\s*/g, '$1')
    .replace(/;+\s*$/, '')
    .trim()
    .toLowerCase();
}
