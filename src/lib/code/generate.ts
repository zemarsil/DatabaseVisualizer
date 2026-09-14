/**
 * Starter code for a code node, generated from its steps and from what it holds.
 *
 * The app already writes SQL from the diagram — DDL, joins, INSERT … SELECT,
 * seed rows, ALTERs. This is the same idea pointed outward: the diagram knows
 * the table names, the column names, the engine and the order the program does
 * things in, so it can write the client side of the conversation too, with the
 * right driver for the language and parameters spelled the way that driver
 * expects.
 *
 * A code map made that a question of more than one node. A module *is* a file,
 * and a file holds the classes and functions drawn inside it; a class holds its
 * methods. So the starter for a container is the whole file: its members are
 * written out as real definitions, nested exactly as the canvas nests them,
 * with one namespace for the SQL constants and the stubs so two functions can
 * never collide. The one line that is not crossed is the file boundary: a
 * module inside a module is a file of its own, gets its own starter, and is
 * named in the header rather than inlined, which is the same reason a program
 * does not swallow its modules.
 *
 * Two things it deliberately does not do. It does not invent a WHERE clause,
 * because guessing which rows a program wants is guessing at the whole program;
 * a step's own SQL is used verbatim when it has any. And it never claims to be
 * finished: compute steps and calls come out as stubs that raise, because the
 * work that happens outside the database is exactly the part the diagram cannot
 * know.
 *
 * Signatures come from the node when the node gives one. `entrypoint` is free
 * text — a path for a module, a signature for a function if you like one — and
 * a signature written in the file's own language is used verbatim, because it
 * is something the reader said rather than something the app guessed. Failing
 * that one is synthesised from the name. Either way the connection is the same
 * bargain: a function whose signature already names it is handed it, and one
 * that does not opens its own, because the diagram does not say where a
 * connection comes from and a starter that will not run is worse than a blunt
 * one.
 *
 * The one shape it does assume is the common one: once a function has read
 * something, everything after that read happens per row. That is what a worker
 * looks like, and it is said out loud in the generated header so a reader can
 * disagree with it in one edit.
 */
import {
  codeKindOf,
  isCodeStepOp,
  isDataNode,
  programLanguageMeta,
  programRoleMeta,
  type CodeKind,
  type Column,
  type Diagram,
  type Dialect,
  type Program,
  type ProgramLanguage,
  type ProgramStep,
  type ProgramStepOp,
  type Table,
} from '@shared/types';
import { quoteIdent, quoteQualified } from '../sql/dialect';
import { describeProgram } from '../programs';
import { codeChildren } from '../codemap';
import { driverFor, hasDriver, type Driver, type DriverShape } from './drivers';

/** One step with everything the emitters need already resolved. */
export interface ProgramCodeStep {
  /** 1-based position in the node the step belongs to. */
  index: number;
  op: ProgramStepOp;
  table: Table | undefined;
  columns: Column[];
  /** The code node a call, import or extends step names, when it is still there. */
  target: Program | undefined;
  /** The step's own SQL, or one written for it. Empty on anything but a read or a write. */
  sql: string;
  /** True when the SQL above was written by the app rather than by the user. */
  generated: boolean;
  /** The note as it was typed, with no op or table name folded into it. */
  note: string;
  /** Identifier stem, snake_case: "read_jobs", "compute_2". */
  slug: string;
  /** Names to bind, in placeholder order. Empty when the SQL takes none. */
  params: string[];
  /** True when the step comes out as a stub for the reader to fill in. */
  stub: boolean;
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

function sanitize(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return cleaned || 'step';
}

export function upperSnake(slug: string): string {
  return slug.toUpperCase();
}

export function camel(slug: string): string {
  return slug.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function pascal(slug: string): string {
  const c = camel(slug);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** A node name as a snake_case identifier: "OrderService" -> "order_service". */
function snake(raw: string): string {
  return sanitize(raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

/** A name the reader wrote, kept as they wrote it when it is already an identifier. */
function ident(raw: string): string {
  const t = raw.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : sanitize(t);
}

/** A type name: the node's own spelling when it is already one, PascalCase otherwise. */
function typeName(raw: string): string {
  const t = raw.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : pascal(sanitize(t));
}

/** A file name without its extension: "inventory.py" -> "inventory". */
function stem(raw: string): string {
  const t = raw.trim();
  return t.replace(/\.[A-Za-z0-9]+$/, '') || t;
}

/** "a", "a and b", "a, b and c" — the way the header prose lists what a file holds. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Resolving the steps                                                 */
/* ------------------------------------------------------------------ */

/**
 * Columns a step works on: the ones it names, or the whole table when it names
 * none. A write leaves out generated keys, because a starter that tries to
 * insert its own SERIAL is a starter that fails on first run.
 */
function columnsFor(step: ProgramStep, table: Table | undefined): Column[] {
  if (!table) return [];
  const named = step.columnIds.map((id) => table.columns.find((c) => c.id === id)).filter((c): c is Column => Boolean(c));
  if (named.length) return named;
  if (step.op === 'write') return table.columns.filter((c) => !c.autoIncrement);
  return table.columns;
}

/** SQL for a step that has none of its own. */
function defaultSql(op: ProgramStepOp, table: Table, columns: Column[], dialect: Dialect, ph: Driver['placeholder']): string {
  const name = quoteQualified(table.name, table.schema, dialect);
  const cols = columns.map((c) => quoteIdent(c.name, dialect));
  if (op === 'read') return `SELECT ${cols.length ? cols.join(', ') : '*'}\nFROM ${name}`;
  if (!cols.length) return `INSERT INTO ${name}\nVALUES (...)`;
  return `INSERT INTO ${name} (${cols.join(', ')})\nVALUES (${columns.map((_c, i) => ph(i + 1)).join(', ')})`;
}

/**
 * One node's steps with their SQL, columns and identifiers worked out once, so
 * every emitter reads the same resolved list rather than re-deriving it.
 */
export function resolveSteps(d: Diagram, p: Program, driver?: Driver): ProgramCodeStep[] {
  const ph = driver?.placeholder ?? ((n: number) => `$${n}`);
  const used = new Map<string, number>();
  const unique = (base: string) => {
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}_${seen + 1}`;
  };
  const codeById = new Map(d.programs.map((x) => [x.id, x]));
  return p.steps.map((s, i) => {
    // A call, an import or an extends is work the database never sees. An
    // import is a line in the file's import block and an extends is a word in
    // a class header, both of which the emitters hoist; a call stays a stub
    // named after what it reaches, because the diagram knows *that*
    // place_order is called here, not what calling it takes.
    if (isCodeStepOp(s.op)) {
      const target = s.codeId ? codeById.get(s.codeId) : undefined;
      return {
        index: i + 1,
        op: s.op,
        table: undefined,
        columns: [],
        target,
        sql: '',
        generated: false,
        note: s.note?.trim() ?? '',
        // A load's slug is the name the file it reads is bound to, since that
        // is what the reader will type next; every other code step's slug
        // names the thing it reaches, because that one becomes a stub.
        slug: unique(s.op === 'load' ? dataSlug(target?.name ?? `data_${i + 1}`) : sanitize(`${s.op}_${target?.name ?? `step_${i + 1}`}`)),
        params: [],
        stub: s.op === 'call',
      };
    }
    const table = s.tableId ? d.tables.find((t) => t.id === s.tableId) : undefined;
    const columns = columnsFor(s, table);
    const own = s.sql?.trim() ?? '';
    const generated = !own && s.op !== 'compute' && Boolean(table);
    const sql = s.op === 'compute' ? '' : own || (table ? defaultSql(s.op, table, columns, d.dialect, ph) : '');
    const slug = unique(s.op === 'compute' ? `compute_${i + 1}` : sanitize(`${s.op}_${table?.name ?? 'table'}`));
    return {
      index: i + 1,
      op: s.op,
      table,
      columns,
      target: undefined,
      sql,
      generated,
      note: s.note?.trim() ?? '',
      slug,
      // Only SQL the app wrote has parameters it can name; a statement the user
      // typed is theirs, and guessing at its placeholders would be worse than
      // leaving the argument list empty and saying so.
      params: generated && s.op === 'write' ? columns.map((c) => sanitize(c.name)) : [],
      stub: s.op === 'compute',
    };
  });
}

/* ------------------------------------------------------------------ */
/* Units: what one generated file holds                                */
/* ------------------------------------------------------------------ */

/**
 * One node's contribution to a generated file, with the nodes drawn inside it
 * that share the file.
 *
 * The split between `body`, `imports` and `bases` is what turns a step list
 * into a file rather than a script. An import step is a line at the top of the
 * file, an extends step is a word in the class header, and everything else is a
 * statement in a body — so `orders.py` comes out importing `inventory` instead
 * of calling a stub named after the import, which is what a reader means when
 * they draw that arrow.
 */
export interface CodeUnit {
  node: Program;
  kind: CodeKind;
  /** The container above it in this same file; absent for the file's root. */
  parent?: CodeUnit;
  /** Names from the file's root down to this node, used where a language cannot nest. */
  path: string[];
  steps: ProgramCodeStep[];
  /** The steps that become lines in this unit's body. */
  body: ProgramCodeStep[];
  /** Import steps, which belong at the top of the file rather than in a body. */
  imports: ProgramCodeStep[];
  /** Classes an extends step names, in step order. */
  bases: string[];
  /** Nodes inside it that share this file, nested as the canvas nests them. */
  members: CodeUnit[];
  /** Nodes left out because a module is a file of its own. */
  elsewhere: Program[];
}

/** A module is a file, so it never shares one with its container. */
function sharesFile(child: Program): boolean {
  return codeKindOf(child) !== 'module';
}

/**
 * The tree of units one starter covers, with every identifier in it made
 * unique. Names are only qualified where they would otherwise clash, so a file
 * with one function keeps the short names it has always had and a file with
 * three gets `place_order_compute_2` exactly where it needs it.
 */
export function resolveUnits(d: Diagram, root: Program, driver?: Driver): CodeUnit {
  const children = codeChildren(d);
  const seen = new Set<string>();
  const build = (node: Program, parent: CodeUnit | undefined, path: string[]): CodeUnit => {
    seen.add(node.id);
    const steps = resolveSteps(d, node, driver);
    const unit: CodeUnit = {
      node,
      kind: codeKindOf(node),
      parent,
      path,
      steps,
      body: steps.filter((s) => s.op !== 'import' && s.op !== 'extends'),
      imports: steps.filter((s) => s.op === 'import'),
      bases: steps.filter((s) => s.op === 'extends').map((s) => s.target?.name ?? '').filter(Boolean),
      members: [],
      elsewhere: [],
    };
    // A parent pointer can be made to loop by a hand-edited file; the guard is
    // cheaper than the stack overflow it prevents.
    const kids = (children.get(node.id) ?? []).filter((c) => !seen.has(c.id));
    unit.members = kids.filter(sharesFile).map((c) => build(c, unit, [...path, c.name]));
    unit.elsewhere = kids.filter((c) => !sharesFile(c));
    return unit;
  };
  const tree = build(root, undefined, []);
  disambiguate(flatUnits(tree));
  return tree;
}

/** Every unit in the file, the root first, then depth first. */
export function flatUnits(u: CodeUnit): CodeUnit[] {
  return [u, ...u.members.flatMap(flatUnits)];
}

/**
 * One namespace for the whole file. A slug two units both want is prefixed
 * with the unit that owns it; anything still colliding after that is numbered,
 * which only happens to names that were already ugly.
 */
function disambiguate(units: CodeUnit[]): void {
  const count = new Map<string, number>();
  for (const u of units) for (const s of u.steps) count.set(s.slug, (count.get(s.slug) ?? 0) + 1);
  const taken = new Set<string>();
  for (const u of units) {
    for (const s of u.steps) {
      let slug = (count.get(s.slug) ?? 0) > 1 ? `${snake(u.node.name)}_${s.slug}` : s.slug;
      for (let n = 2; taken.has(slug); n += 1) slug = `${slug}_${n}`;
      taken.add(slug);
      s.slug = slug;
    }
  }
}

/** Every SQL constant the file declares, in reading order. */
function fileSql(root: CodeUnit): ProgramCodeStep[] {
  return flatUnits(root).flatMap((u) => u.body.filter((s) => s.sql));
}

/** Every stub the file declares, with the unit whose body calls it. */
function fileStubs(root: CodeUnit): { unit: CodeUnit; step: ProgramCodeStep }[] {
  return flatUnits(root).flatMap((u) => u.body.filter((s) => s.stub).map((step) => ({ unit: u, step })));
}

/**
 * The units written out as definitions. A class is a definition wherever it
 * appears, so selecting one gives you the class; a module or a program is a
 * file, so its own steps go in `main` and only what it holds is defined.
 */
function definitionsOf(root: CodeUnit): CodeUnit[] {
  return root.kind === 'class' ? [root] : root.members;
}

/**
 * Whether the file gets an entry point. A container that defines things and has
 * no work of its own does not want an empty `main` under it; a node with no
 * members is the plain program this generator started out writing, and keeps
 * one even when it has nothing to say.
 */
function needsMain(root: CodeUnit): boolean {
  if (root.kind === 'class') return false;
  return root.body.length > 0 || root.members.length === 0;
}

/** Steps of a container that have nowhere else to go come out as one method. */
function ownStepsName(u: CodeUnit): string {
  return u.members.some((m) => snake(m.node.name) === 'run') ? `${snake(u.node.name)}_run` : 'run';
}

/* ------------------------------------------------------------------ */
/* Signatures                                                          */
/* ------------------------------------------------------------------ */

/**
 * The signature a node declares, when its `entrypoint` reads as one *in the
 * file's own language*. Both halves of that matter: a path has no parentheses,
 * and a Python `def` inside a Java class would be worse than no signature at
 * all, so each language asks for its own keyword and takes nothing else.
 */
const SIGNATURE_SHAPE: Partial<Record<ProgramLanguage, RegExp>> = {
  python: /^(async\s+)?def\s+[A-Za-z_]\w*\s*\(/,
  rust: /^(pub\s+)?(async\s+)?fn\s+[A-Za-z_]\w*\s*[(<]/,
  go: /^func\s/,
  java: /^[A-Za-z_][\w<>[\],.\s]*\s+[A-Za-z_]\w*\s*\(/,
  javascript: /^(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/,
  typescript: /^(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/,
  c: /^[A-Za-z_][\w\s*]*[\s*]\*?[A-Za-z_]\w*\s*\(/,
  cpp: /^[A-Za-z_][\w\s*:<>]*[\s*]\*?[A-Za-z_]\w*\s*\(/,
  perl: /^sub\s+[A-Za-z_]\w*\s*\(/,
  // `place_order()` and nothing else: the shell's one way of writing a
  // function header, and a word followed by parentheses anywhere else in a
  // script is a call rather than a declaration.
  shell: /^[A-Za-z_]\w*\s*\(\s*\)$/,
};

function declaredSignature(u: CodeUnit, lang: ProgramLanguage): string | undefined {
  if (u.node.language !== lang) return undefined;
  const raw = u.node.entrypoint?.trim();
  if (!raw || raw.includes('\n') || !/\(.*\)/.test(raw)) return undefined;
  const shape = SIGNATURE_SHAPE[lang];
  if (!shape || !shape.test(raw)) return undefined;
  return raw.replace(/[;:{]\s*$/, '').trim();
}

/** Whether a signature already takes the connection, and so should be handed one. */
function takesHandle(signature: string | undefined, handle: string): boolean {
  if (!signature) return false;
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close < open) return false;
  return new RegExp(`\\b${handle}\\b`).test(signature.slice(open + 1, close));
}

/* ------------------------------------------------------------------ */
/* Imports                                                             */
/* ------------------------------------------------------------------ */

interface ImportSpec {
  /** The module the name lives in, with no extension: "inventory". */
  module: string;
  /** The name taken out of it, when the step names something inside a module. */
  name?: string;
  /** What the step said it was for. */
  note: string;
  /** Set when the name it would bind is already something else in this file. */
  alias?: string;
}

/** What an import step is asking for: a module, or a name inside one. */
function importSpec(d: Diagram, s: ProgramCodeStep): ImportSpec | undefined {
  const target = s.target;
  if (!target) return undefined;
  if (codeKindOf(target) === 'module') return { module: stem(target.name), note: s.note };
  const byId = new Map(d.programs.map((x) => [x.id, x]));
  const seen = new Set<string>([target.id]);
  let up = target.parentId ? byId.get(target.parentId) : undefined;
  while (up && codeKindOf(up) !== 'module' && up.parentId && !seen.has(up.parentId)) {
    seen.add(up.id);
    up = byId.get(up.parentId);
  }
  const module = up && codeKindOf(up) === 'module' ? stem(up.name) : undefined;
  return module ? { module, name: target.name, note: s.note } : { module: stem(target.name), note: s.note };
}

/**
 * How each language spells an import. Every one of these parses, and every one
 * of them is a guess at a path only the reader knows — which is why the step's
 * note rides along as a comment rather than being dropped.
 */
const IMPORT_LINE: Partial<Record<ProgramLanguage, (s: ImportSpec) => string>> = {
  python: (s) => `${s.name ? `from ${sanitize(s.module)} import ${ident(s.name)}` : `import ${sanitize(s.module)}`}${s.alias ? ` as ${s.alias}` : ''}`,
  rust: (s) => `use crate::${sanitize(s.module)}${s.name ? `::${snake(s.name)}` : ''}${s.alias ? ` as ${s.alias}` : ''};`,
  // Go imports are paths, and this one goes inside the sorted import block.
  go: (s) => `${s.alias ? `${s.alias} ` : ''}"${s.module}"`,
  java: (s) => `import ${sanitize(s.module)}.${s.name ? typeName(s.name) : '*'};`,
  javascript: (s) => jsImport(s),
  typescript: (s) => jsImport(s),
  c: (s) => `#include "${s.module}.h"`,
  cpp: (s) => `#include "${s.module}.h"`,
  perl: (s) => `use ${typeName(s.module)}${s.name ? ` qw(${ident(s.name)})` : ''};`,
  shell: (s) => `source ${s.module}.sh`,
};

function jsImport(s: ImportSpec): string {
  if (s.name) return `import { ${ident(s.name)}${s.alias ? ` as ${s.alias}` : ''} } from './${s.module}.js';`;
  return `import * as ${s.alias ?? camel(snake(s.module))} from './${s.module}.js';`;
}

/**
 * The name an import introduces into the file, for the languages that bind one.
 * Java and the `#include` languages name nothing, so nothing can collide there.
 */
const IMPORT_BINDS: Partial<Record<ProgramLanguage, (s: ImportSpec) => string>> = {
  python: (s) => (s.name ? ident(s.name) : sanitize(s.module)),
  rust: (s) => (s.name ? snake(s.name) : sanitize(s.module)),
  go: (s) => sanitize(s.module),
  javascript: (s) => (s.name ? ident(s.name) : camel(snake(s.module))),
  typescript: (s) => (s.name ? ident(s.name) : camel(snake(s.module))),
  perl: (s) => (s.name ? ident(s.name) : typeName(s.module)),
  // A sourced shell file binds every function in it at once, so the one name
  // it introduces is the file itself and nothing can collide with it.
  shell: (s) => sanitize(s.module),
};

/** Names the generated file already uses, whatever the diagram is called. */
const RESERVED = ['main', 'run', 'db', 'conn', 'cur', 'pool', 'rows', 'row', 'dsn', 'opendb'];

/**
 * The import lines every unit in the file asks for, deduplicated, in order.
 *
 * Two things are settled here rather than left to the reader. An import of
 * something this same file defines is dropped, because it is already here. And
 * an import whose name is taken by a definition is bound under an alias, since
 * in JavaScript that clash is a syntax error and in Python it is the quieter
 * kind of wrong where the import simply stops working.
 */
function importLines(d: Diagram, root: CodeUnit, lang: ProgramLanguage): string[] {
  const write = IMPORT_LINE[lang];
  if (!write) return [];
  const marker = programLanguageMeta(lang).comment;
  const bind = IMPORT_BINDS[lang];
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const here = flatUnits(root);
  const mine = new Set(here.map((u) => u.node.id));
  const taken = new Set([...here.map((u) => key(u.node.name)), ...RESERVED]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of here) {
    for (const step of u.imports) {
      if (step.target && mine.has(step.target.id)) continue;
      const spec = importSpec(d, step);
      if (!spec) continue;
      const natural = bind?.(spec);
      if (natural) {
        let binding = natural;
        for (let n = 2; taken.has(key(binding)); n += 1) binding = `${natural}${lang === 'javascript' || lang === 'typescript' ? '' : '_'}${n}`;
        taken.add(key(binding));
        if (binding !== natural) spec.alias = binding;
      }
      const line = write(spec);
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(spec.note ? `${line}  ${marker} ${spec.note}` : line);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Data files                                                          */
/* ------------------------------------------------------------------ */

/**
 * A load step, resolved to the three things writing one takes: the name it
 * binds, the file it reads, and which of the two formats that file is in.
 *
 * It is the one step whose target is not code. Everything else a step can name
 * is something that runs; a YAML or JSON file is values, so the line written
 * for it is a read from disk and a parse, and the only question the diagram
 * has to answer is which parser.
 */
interface LoadSpec {
  /** Identifier the file's contents land in: "config" for config.yaml. */
  name: string;
  /** The file, as the node says where it is. */
  path: string;
  /** JSON rather than YAML. */
  json: boolean;
}

/** An identifier for a data file, kept clear of the names the generated file already uses. */
function dataSlug(raw: string): string {
  const base = sanitize(stem(raw));
  return RESERVED.includes(base) ? `${base}_data` : base;
}

function loadSpec(s: ProgramCodeStep): LoadSpec | undefined {
  if (s.op !== 'load' || !s.target) return undefined;
  return { name: s.slug, path: s.target.entrypoint?.trim() || s.target.name, json: s.target.language === 'json' };
}

/** A path as a double-quoted literal, which every language here spells the same way. */
const quoted = (path: string) => JSON.stringify(path);
/** And as a single-quoted one, for Perl and the shell. */
const sq = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;

/**
 * The line a load step comes out as, per language.
 *
 * Each one is the call a reader of that language would actually write, with
 * the library that language actually reaches for: `yaml.safe_load` and
 * `json.load`, serde, Jackson, nlohmann and yaml-cpp, `jq` and `yq`. C is the
 * exception and says so rather than inventing a parser: there is no standard
 * one, so what it gets is the name of the library to add.
 */
const LOAD_LINE: Partial<Record<ProgramLanguage, (l: LoadSpec) => string[]>> = {
  python: (l) => [`with open(${quoted(l.path)}, encoding="utf-8") as f:`, `    ${l.name} = ${l.json ? 'json.load(f)' : 'yaml.safe_load(f)'}`],
  rust: (l) => {
    const crate = l.json ? 'serde_json' : 'serde_yaml';
    return [`let ${l.name}: ${crate}::Value = ${crate}::from_str(&std::fs::read_to_string(${quoted(l.path)})?)?;`];
  },
  go: (l) => {
    const name = camel(l.name);
    return [
      `${name}Bytes, err := os.ReadFile(${quoted(l.path)})`,
      'if err != nil {',
      '\tlog.Fatal(err)',
      '}',
      `var ${name} map[string]any`,
      `if err := ${l.json ? 'json' : 'yaml'}.Unmarshal(${name}Bytes, &${name}); err != nil {`,
      '\tlog.Fatal(err)',
      '}',
    ];
  },
  java: (l) => [`JsonNode ${camel(l.name)} = new ObjectMapper(${l.json ? '' : 'new YAMLFactory()'}).readTree(new File(${quoted(l.path)}));`],
  javascript: (l) => [jsLoad(l)],
  typescript: (l) => [jsLoad(l)],
  c: (l) => [`// ${l.path}: C has no parser of its own — read the file, then ${l.json ? 'cJSON_Parse' : 'yaml_parser_parse'}.`],
  cpp: (l) =>
    l.json
      ? [`std::ifstream ${l.name}_file{${quoted(l.path)}};`, `nlohmann::json ${l.name} = nlohmann::json::parse(${l.name}_file);`]
      : [`YAML::Node ${l.name} = YAML::LoadFile(${quoted(l.path)});`],
  perl: (l) =>
    l.json
      ? [`open my $${l.name}_fh, '<', ${sq(l.path)} or die "${l.path}: $!";`, `my $${l.name} = decode_json(do { local $/; <$${l.name}_fh> });`, `close $${l.name}_fh;`]
      : [`my $${l.name} = LoadFile(${sq(l.path)});`],
  shell: (l) => [`${l.name}=$(${l.json ? 'jq -c .' : "yq -o=json '.'"} ${sq(l.path)})`],
};

function jsLoad(l: LoadSpec): string {
  return `const ${camel(l.name)} = ${l.json ? 'JSON.parse' : 'YAML.parse'}(await readFile(${quoted(l.path)}, 'utf8'));`;
}

/**
 * What reading a data file costs at the top of the file: an import, a crate to
 * add, an include. Asked once per format the file actually loads, so a program
 * that reads no YAML never mentions a YAML library.
 */
const LOAD_IMPORTS: Partial<Record<ProgramLanguage, (json: boolean) => string[]>> = {
  python: (json) => (json ? ['import json'] : ['import yaml  # pip install PyYAML']),
  rust: (json) => (json ? ['// cargo add serde_json'] : ['// cargo add serde_yaml']),
  go: (json) => (json ? ['"encoding/json"'] : ['"gopkg.in/yaml.v3"']),
  java: (json) => [
    'import java.io.File;',
    'import com.fasterxml.jackson.databind.JsonNode;',
    'import com.fasterxml.jackson.databind.ObjectMapper;',
    ...(json ? [] : ['import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;']),
  ],
  javascript: (json) => ["import { readFile } from 'node:fs/promises';", ...(json ? [] : ["import YAML from 'yaml';"])],
  typescript: (json) => ["import { readFile } from 'node:fs/promises';", ...(json ? [] : ["import YAML from 'yaml';"])],
  cpp: (json) => (json ? ['#include <fstream>', '#include <nlohmann/json.hpp>'] : ['#include <yaml-cpp/yaml.h>']),
  perl: (json) => (json ? ['use JSON::PP;'] : ['use YAML::XS qw(LoadFile);']),
};

/** The load step's own lines, or nothing when it names no file to read. */
function loadCode(s: ProgramCodeStep, lang: ProgramLanguage): string[] {
  const spec = loadSpec(s);
  return spec ? (LOAD_LINE[lang]?.(spec) ?? []) : [];
}

/** Every import the file's load steps ask for, once each, JSON before YAML. */
function loadImports(root: CodeUnit, lang: ProgramLanguage): string[] {
  const write = LOAD_IMPORTS[lang];
  if (!write) return [];
  const formats = new Set<boolean>();
  for (const u of flatUnits(root)) for (const s of u.body) {
    const spec = loadSpec(s);
    if (spec) formats.add(spec.json);
  }
  const out: string[] = [];
  for (const json of [true, false]) {
    if (!formats.has(json)) continue;
    for (const line of write(json)) if (!out.includes(line)) out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

/** Prose every language puts at the top, before its own comment syntax is applied. */
function headerLines(d: Diagram, root: CodeUnit, driver: Driver | undefined): string[] {
  const p = root.node;
  const lang = programLanguageMeta(p.language);
  const role = p.role ? programRoleMeta(p.role).label : lang.label;
  const lines = [
    `${p.name} — starter generated from the "${d.name}" diagram.`,
    '',
    describeProgram(d, p),
  ];
  if (p.comment?.trim()) lines.push('', p.comment.trim());
  if (p.entrypoint?.trim()) lines.push('', `Belongs in ${p.entrypoint.trim()}.`);
  lines.push('', `${role}, talking to ${d.dialect}${driver ? ` through ${driver.label}` : ''}.`);
  const held = root.members.flatMap(flatUnits).map((u) => u.node.name);
  if (held.length) {
    lines.push('', `${listOf(held)} ${held.length === 1 ? 'sits' : 'sit'} inside it on the diagram, so ${held.length === 1 ? 'it is' : 'they are'} written out here too.`);
  }
  const away = root.elsewhere.map((x) => x.name);
  if (away.length) {
    lines.push('', `${listOf(away)} ${away.length === 1 ? 'is a module of its own and gets a starter' : 'are modules of their own and get a starter each'}, so nothing of ${away.length === 1 ? 'it' : 'them'} is written here.`);
  }
  // Only the real templates build a row loop, so only they need warning about it.
  if (driver && flatUnits(root).some((u) => u.body.some((s) => s.op === 'read'))) {
    lines.push('', 'Everything after the first read is written inside the row loop, which is what a');
    lines.push('worker usually wants. Move it out if this one does its work in bulk instead.');
  }
  if (driver && definitionsOf(root).some((u) => flatUnits(u).some(needsConnection))) {
    lines.push('', 'A function whose signature names the connection is handed it; one that does not');
    lines.push('opens its own, because the diagram cannot say where yours comes from.');
  }
  return lines;
}

/**
 * The prose that introduces one definition: what it is, what it is for, where
 * it lives. `showNesting` is for the languages that cannot put a definition
 * where the diagram puts it — Rust, Go, C and JavaScript all write a nested
 * class out at the top level — so the comment carries what the indentation
 * cannot.
 */
function unitDoc(d: Diagram, u: CodeUnit, showEntrypoint: boolean, showNesting = false): string[] {
  const lines = [describeProgram(d, u.node)];
  if (u.node.comment?.trim()) lines.push('', u.node.comment.trim());
  if (showNesting && u.path.length > 1) lines.push('', `Drawn inside ${u.path.slice(0, -1).join('/')} on the diagram, which is nesting this language has nowhere to put.`);
  if (showEntrypoint && u.node.entrypoint?.trim()) lines.push('', `Belongs in ${u.node.entrypoint.trim()}.`);
  return lines;
}

function commentBlock(lines: string[], marker: string): string {
  return lines.map((l) => (l ? `${marker} ${l}` : marker)).join('\n');
}

/** The comment that introduces one step, without a comment marker. */
function stepCaption(s: ProgramCodeStep): string {
  if (isCodeStepOp(s.op)) return `Step ${s.index}: ${s.op} ${s.target?.name ?? '(missing code)'}${s.note ? ` — ${s.note}` : ''}.`;
  if (s.op === 'compute') return `Step ${s.index}: ${s.note || 'work the database never sees'}.`;
  const cols = s.columns.map((c) => c.name).join(', ');
  const what = `${s.op} ${s.table?.name ?? '(missing table)'}${cols ? ` (${cols})` : ''}`;
  return `Step ${s.index}: ${what}${s.note ? ` — ${s.note}` : ''}`;
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

function indentAll(lines: string[], pad: string): string[] {
  return lines.map((l) => (l ? pad + l : l));
}

/**
 * Leave exactly `n` blank lines between what has been written and what comes
 * next. Blank lines are the one thing every emitter got subtly wrong when it
 * had to push them by hand, and collapsing them afterwards is not an option:
 * a SQL literal may contain blank lines of its own.
 */
function gap(out: string[], n: number): void {
  while (out.length && out[out.length - 1] === '') out.pop();
  if (!out.length) return;
  for (let i = 0; i < n; i += 1) out.push('');
}

/**
 * Where the row loop opens: just after the first read. -1 when the unit never
 * reads, in which case nothing is wrapped — and also when the read is the last
 * thing it does, because a loop with nothing in it is a syntax error in Python
 * and noise everywhere else.
 */
function loopAt(steps: ProgramCodeStep[]): number {
  const read = steps.findIndex((s) => s.op === 'read');
  return read === steps.length - 1 ? -1 : read;
}

/**
 * Whether a step lands inside the row loop. A stub only has a row to be handed
 * when it does, and a stub declared to take one it is never given is a starter
 * that does not run.
 */
function inRowLoop(u: CodeUnit, s: ProgramCodeStep): boolean {
  const open = loopAt(u.body);
  return open !== -1 && u.body.indexOf(s) > open;
}

interface BodyShape {
  /** Indent of a statement outside the row loop. */
  base: string;
  /** One further level, for statements inside it. */
  step: string;
  /** How the language opens the loop over the rows just read. */
  loopOpen: string;
  /** How it closes; omitted for a language that closes by dedenting. */
  loopClose?: string;
}

/** What one step needs to know about where in the body it landed. */
interface StepContext {
  /** The step sits inside the row loop. */
  inLoop: boolean;
  /**
   * This is the unit's first read, and so the one that binds the plain `rows`.
   * A second read has to bind a name of its own: re-declaring `rows` is a
   * syntax error in JavaScript and in Java, and a confusion everywhere else.
   */
  first: boolean;
}

/**
 * The body of one unit, assembled the same way in every language: one commented
 * block per step, in order, with everything after the first read moved one
 * level in.
 *
 * Shared rather than repeated because the indentation is the part that is easy
 * to get subtly wrong, and a starter that does not parse is worse than none.
 */
function buildBody(steps: ProgramCodeStep[], emit: (s: ProgramCodeStep, ctx: StepContext) => string[], shape: BodyShape): string {
  const open = loopAt(steps);
  const read = steps.findIndex((s) => s.op === 'read');
  const out: string[] = [];
  steps.forEach((s, i) => {
    const inLoop = open !== -1 && i > open;
    const pad = inLoop ? shape.base + shape.step : shape.base;
    // Blank line between blocks, but not directly under the loop header: the
    // first statement of a body belongs against it.
    if (i > 0 && i !== open + 1) out.push('');
    out.push(indent(emit(s, { inLoop, first: i === read }).join('\n'), pad));
    if (i === open) {
      out.push('');
      out.push(shape.base + shape.loopOpen);
    }
  });
  if (open !== -1 && shape.loopClose) out.push(shape.base + shape.loopClose);
  return out.join('\n');
}

/** Whether a unit's body issues SQL, and so needs a connection from somewhere. */
function needsConnection(u: CodeUnit): boolean {
  return u.body.some((s) => s.sql);
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

const PY = '    ';

function pyDoc(lines: string[], pad: string): string[] {
  if (lines.length === 1) return [`${pad}"""${lines[0]}"""`];
  return [`${pad}"""${lines[0]}`, ...indentAll(lines.slice(1), pad), `${pad}"""`];
}

function pyStep(s: ProgramCodeStep, ctx: StepContext): string[] {
  const lines = [`# ${stepCaption(s)}`];
  if (s.stub) lines.push(`result_${s.index} = ${s.slug}(${ctx.inLoop ? 'row' : ''})`);
  else if (s.op === 'load') lines.push(...loadCode(s, 'python'));
  else if (s.op === 'read') lines.push(`cur.execute(${upperSnake(s.slug)})`, `${ctx.first ? 'rows' : `${s.slug}_rows`} = cur.fetchall()`);
  // A one-element tuple needs its comma, or the driver is handed a bare value.
  else if (s.params.length) lines.push(`cur.execute(${upperSnake(s.slug)}, (${s.params.join(', ')}${s.params.length === 1 ? ',' : ''}))`);
  else lines.push('# bind what this statement needs', `cur.execute(${upperSnake(s.slug)}, ())`);
  return lines;
}

/**
 * A unit's steps wrapped in whatever gets them a cursor: the connection it was
 * handed, or one of its own.
 */
function pyBody(u: CodeUnit, driver: Driver, pad: string, handed: boolean): string[] {
  if (!u.body.length) return [];
  if (!needsConnection(u)) return [buildBody(u.body, pyStep, { base: pad, step: PY, loopOpen: 'for row in rows:' })];
  const out = [`${pad}${handed ? 'with conn.cursor() as cur:' : `with ${driver.connect} as conn, conn.cursor() as cur:`}`];
  out.push(buildBody(u.body, pyStep, { base: pad + PY, step: PY, loopOpen: 'for row in rows:' }));
  out.push('');
  // A connection we opened commits before we give it back; one we were handed
  // commits outside the cursor that used it.
  out.push(`${handed ? pad : pad + PY}conn.commit()`);
  return out;
}

function pyFunction(d: Diagram, u: CodeUnit, depth: number, driver: Driver, name?: string, doc?: string[]): string[] {
  const pad = PY.repeat(depth);
  const inner = pad + PY;
  const declared = name ? undefined : declaredSignature(u, 'python');
  const params = [depth > 0 ? 'self' : '', needsConnection(u) ? 'conn' : ''].filter(Boolean).join(', ');
  const line = declared ? `${declared}:` : `def ${name ?? ident(u.node.name)}(${params}):`;
  const out = [`${pad}${line}`];
  out.push(...pyDoc(doc ?? unitDoc(d, u, !declared), inner));
  out.push(...pyBody(u, driver, inner, takesHandle(declared, 'conn') || (!declared && needsConnection(u))));
  return out;
}

function pyClass(d: Diagram, u: CodeUnit, depth: number, driver: Driver): string[] {
  const pad = PY.repeat(depth);
  const bases = u.bases.length ? `(${u.bases.map(typeName).join(', ')})` : '';
  const out = [`${pad}class ${typeName(u.node.name)}${bases}:`];
  out.push(...pyDoc(unitDoc(d, u, true), pad + PY));
  if (u.body.length) {
    gap(out, 1);
    out.push(...pyFunction(d, u, depth + 1, driver, ownStepsName(u), [`The steps drawn on ${u.node.name} itself.`]));
  }
  for (const m of u.members) {
    gap(out, 1);
    out.push(...pyDefinition(d, m, depth + 1, driver));
  }
  return out;
}

function pyDefinition(d: Diagram, u: CodeUnit, depth: number, driver: Driver): string[] {
  return u.kind === 'function' ? pyFunction(d, u, depth, driver) : pyClass(d, u, depth, driver);
}

function emitPython(d: Diagram, root: CodeUnit, driver: Driver): string {
  const out: string[] = [];
  out.push(`"""${headerLines(d, root, driver).join('\n')}\n"""`);
  gap(out, 1);
  out.push(`# ${driver.install}`);
  out.push(...driver.imports, ...loadImports(root, 'python'), ...importLines(d, root, 'python'));
  gap(out, 1);
  out.push(`DSN = os.environ.get("DATABASE_URL", ${JSON.stringify(driver.dsn)})`);

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`# ${stepCaption(s)}`);
    out.push(`${upperSnake(s.slug)} = """\n${s.sql}\n"""`);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 2);
    out.push(`def ${step.slug}(${inRowLoop(unit, step) ? 'row' : ''}):`);
    out.push(`    """${stepCaption(step)}"""`);
    out.push('    raise NotImplementedError');
  }

  for (const u of definitionsOf(root)) {
    gap(out, 2);
    out.push(...pyDefinition(d, u, 0, driver));
  }

  if (needsMain(root)) {
    gap(out, 2);
    out.push('def main() -> None:');
    const body = pyBody(root, driver, PY, false);
    out.push(...(body.length ? body : [`${PY}pass`]));
    gap(out, 2);
    out.push('if __name__ == "__main__":');
    out.push('    main()');
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Rust                                                                */
/* ------------------------------------------------------------------ */

/**
 * sqlx and duckdb-rs are both Rust and share nothing.
 *
 * One hands back a Vec and is awaited; the other holds the statement while the
 * rows are read and is synchronous. Writing sqlx's calls against a
 * `duckdb::Connection` compiles into nothing at all, so the driver decides.
 */
const RUST_SQLX = 'sqlx';

function rustHandle(driver: Driver): string {
  return driver.shape === RUST_SQLX ? 'pool' : 'conn';
}

function rustAsync(driver: Driver): string {
  return driver.shape === RUST_SQLX ? 'async ' : '';
}

function rustLoop(driver: Driver, pad: string): BodyShape {
  return driver.shape === RUST_SQLX
    ? { base: pad, step: '    ', loopOpen: 'for row in rows {', loopClose: '}' }
    : { base: pad, step: '    ', loopOpen: 'while let Some(row) = rows.next()? {', loopClose: '}' };
}

function rustStep(driver: Driver): (s: ProgramCodeStep, ctx: StepContext) => string[] {
  return (s, ctx) => {
    const lines = [`// ${stepCaption(s)}`];
    const rows = ctx.first ? 'rows' : `${s.slug}_rows`;
    if (s.stub) lines.push(`${s.slug}(${ctx.inLoop ? '&row' : ''})?;`);
    else if (s.op === 'load') lines.push(...loadCode(s, 'rust'));
    else if (driver.shape === RUST_SQLX && s.op === 'read') {
      lines.push(`let ${rows} = sqlx::query(${upperSnake(s.slug)}).fetch_all(&pool).await?;`);
    } else if (driver.shape === RUST_SQLX) {
      const binds = s.params.length ? s.params.map((n) => `    .bind(${n})`) : ['    // bind what this statement needs'];
      lines.push(`sqlx::query(${upperSnake(s.slug)})`, ...binds, '    .execute(&pool)', '    .await?;');
    } else if (s.op === 'read') {
      // duckdb-rs holds the statement while the rows are read, so it has to
      // outlive the loop; sqlx hands back a Vec and does not.
      lines.push(`let mut ${s.slug} = conn.prepare(${upperSnake(s.slug)})?;`, `let mut ${rows} = ${s.slug}.query([])?;`);
    } else {
      if (!s.params.length) lines.push('// bind what this statement needs');
      lines.push(`conn.execute(${upperSnake(s.slug)}, params![${s.params.join(', ')}])?;`);
    }
    return lines;
  };
}

/** A unit's steps, after whatever it takes to have a connection in scope. */
function rustBody(u: CodeUnit, driver: Driver, pad: string, handed: boolean): string[] {
  const out: string[] = [];
  if (!handed && needsConnection(u)) {
    out.push(`${pad}let dsn = std::env::var("DATABASE_URL").unwrap_or_else(|_| ${JSON.stringify(driver.dsn)}.into());`);
    out.push(`${pad}let ${rustHandle(driver)} = ${driver.connect};`);
    out.push('');
  }
  if (u.body.length) out.push(buildBody(u.body, rustStep(driver), rustLoop(driver, pad)));
  return out;
}

/**
 * Rust has no class inside a class, so a map that nests them is flattened: one
 * `struct` and one `impl` per class, side by side, in the order they are drawn.
 * The names keep their own spelling, so nothing is lost but the indentation.
 */
function rustDefinitions(d: Diagram, root: CodeUnit, driver: Driver): string[][] {
  const out: string[][] = [];
  for (const u of flatUnits(root)) {
    if (u.kind === 'function') {
      // Methods are written inside their class's impl block, not out here.
      if (u.parent && u.parent.kind === 'class') continue;
      if (u === root) continue;
      out.push(rustFunction(d, u, driver, '', false));
      continue;
    }
    if (u.kind !== 'class') continue;
    const name = typeName(u.node.name);
    const block: string[] = [commentBlock(unitDoc(d, u, true, true), '///')];
    if (u.bases.length) block.push(`// Extends ${u.bases.join(', ')}; Rust has no inheritance, so hold one or implement its trait.`);
    block.push(`pub struct ${name};`);
    block.push('');
    block.push(`impl ${name} {`);
    const inner: string[] = [];
    if (u.body.length) inner.push(...rustFunction(d, u, driver, '    ', true, ownStepsName(u), [`The steps drawn on ${u.node.name} itself.`]));
    for (const m of u.members.filter((x) => x.kind === 'function')) {
      gap(inner, 1);
      inner.push(...rustFunction(d, m, driver, '    ', true));
    }
    block.push(...inner);
    block.push('}');
    out.push(block);
  }
  return out;
}

function rustFunction(d: Diagram, u: CodeUnit, driver: Driver, pad: string, method: boolean, name?: string, doc?: string[]): string[] {
  const declared = name ? undefined : declaredSignature(u, 'rust');
  const params = [method ? '&self' : ''].filter(Boolean).join(', ');
  const head = declared ? `${declared} {` : `pub ${rustAsync(driver)}fn ${name ?? snake(u.node.name)}(${params}) -> anyhow::Result<()> {`;
  const out = [...indentAll(commentBlock(doc ?? unitDoc(d, u, !declared), '///').split('\n'), pad), `${pad}${head}`];
  out.push(...rustBody(u, driver, `${pad}    `, takesHandle(declared, rustHandle(driver))));
  gap(out, 0);
  out.push(`${pad}    Ok(())`);
  out.push(`${pad}}`);
  return out;
}

function emitRust(d: Diagram, root: CodeUnit, driver: Driver): string {
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, root, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  gap(out, 1);
  out.push(...driver.imports, ...loadImports(root, 'rust'), ...importLines(d, root, 'rust'));

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`// ${stepCaption(s)}`);
    out.push(`const ${upperSnake(s.slug)}: &str = r#"\n${s.sql}\n"#;`);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 1);
    out.push(`/// ${stepCaption(step)}`);
    // Generic over the row type so the stub compiles whichever sqlx driver the
    // dialect picked, rather than naming PgRow and breaking on MySQL.
    const inLoop = inRowLoop(unit, step);
    const takes = driver.shape === RUST_SQLX ? '<R: sqlx::Row>(row: &R)' : '(row: &duckdb::Row)';
    out.push(`fn ${step.slug}${inLoop ? takes : '()'} -> anyhow::Result<()> {`);
    out.push('    todo!("the work this program exists to do")');
    out.push('}');
  }

  for (const block of rustDefinitions(d, root, driver)) {
    gap(out, 1);
    out.push(...block);
  }

  if (needsMain(root)) {
    gap(out, 1);
    // duckdb-rs is synchronous, so there is no runtime to start.
    if (driver.shape === RUST_SQLX) out.push('#[tokio::main]');
    out.push(`${rustAsync(driver)}fn main() -> anyhow::Result<()> {`);
    out.push(`    let dsn = std::env::var("DATABASE_URL").unwrap_or_else(|_| ${JSON.stringify(driver.dsn)}.into());`);
    out.push(`    let ${rustHandle(driver)} = ${driver.connect};`);
    out.push('');
    if (root.body.length) out.push(buildBody(root.body, rustStep(driver), rustLoop(driver, '    ')));
    gap(out, 1);
    out.push('    Ok(())');
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

function goStep(s: ProgramCodeStep, ctx: StepContext): string[] {
  const lines = [`// ${stepCaption(s)}`];
  if (s.stub) lines.push(`if err := ${camel(s.slug)}(${ctx.inLoop ? 'rows' : ''}); err != nil {`, '\tlog.Fatal(err)', '}');
  else if (s.op === 'load') lines.push(...loadCode(s, 'go'));
  else if (s.op === 'read') {
    const rows = ctx.first ? 'rows' : `${camel(s.slug)}Rows`;
    lines.push(`${rows}, err := db.Query(${camel(s.slug)}SQL)`, 'if err != nil {', '\tlog.Fatal(err)', '}', `defer ${rows}.Close()`);
  }
  else {
    const args = s.params.length ? `, ${s.params.join(', ')}` : '';
    if (!s.params.length) lines.push('// bind what this statement needs');
    lines.push(`if _, err := db.Exec(${camel(s.slug)}SQL${args}); err != nil {`, '\tlog.Fatal(err)', '}');
  }
  return lines;
}

/**
 * Go has methods but no nested types, so a class becomes a struct with its
 * functions hung off it and anything nested inside that class sits beside it.
 */
function goDefinitions(d: Diagram, root: CodeUnit, driver: Driver): string[][] {
  const out: string[][] = [];
  for (const u of flatUnits(root)) {
    if (u === root && u.kind !== 'class') continue;
    if (u.kind === 'function') {
      const recv = u.parent && u.parent.kind === 'class' ? `(${snake(u.parent.node.name).charAt(0)} *${typeName(u.parent.node.name)}) ` : '';
      out.push(goFunction(d, u, driver, recv));
      continue;
    }
    if (u.kind !== 'class') continue;
    const name = typeName(u.node.name);
    const block = [...commentBlock(unitDoc(d, u, true, true), '//').split('\n')];
    if (u.bases.length) block.push(`// Extends ${u.bases.join(', ')}; Go embeds rather than inherits, so hold one as a field.`);
    block.push(`type ${name} struct{}`);
    out.push(block);
    if (u.body.length) out.push(goFunction(d, u, driver, `(${snake(u.node.name).charAt(0)} *${name}) `, ownStepsName(u), [`The steps drawn on ${u.node.name} itself.`]));
  }
  return out;
}

function goFunction(d: Diagram, u: CodeUnit, driver: Driver, receiver: string, name?: string, doc?: string[]): string[] {
  const declared = name ? undefined : declaredSignature(u, 'go');
  const handed = takesHandle(declared, 'db');
  const head = declared ? `${declared} {` : `func ${receiver}${camel(snake(name ?? u.node.name))}(${needsConnection(u) ? 'db *sql.DB' : ''}) error {`;
  const out = [...commentBlock(doc ?? unitDoc(d, u, !declared), '//').split('\n'), head];
  // A synthesised signature always takes the handle, so only a declared one
  // that forgot it has to open a connection of its own.
  if (declared && !handed && needsConnection(u)) {
    out.push('\tdsn := os.Getenv("DATABASE_URL")');
    out.push('\tif dsn == "" {');
    out.push(`\t\tdsn = ${JSON.stringify(driver.dsn)}`);
    out.push('\t}');
    out.push(`\tdb, err := ${driver.connect}`);
    out.push('\tif err != nil {');
    out.push('\t\treturn err');
    out.push('\t}');
    out.push('\tdefer db.Close()');
    out.push('');
  }
  if (u.body.length) out.push(buildBody(u.body, goStep, { base: '\t', step: '\t', loopOpen: 'for rows.Next() {', loopClose: '}' }));
  gap(out, 0);
  out.push('\treturn nil');
  out.push('}');
  return out;
}

function emitGo(d: Diagram, root: CodeUnit, driver: Driver): string {
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, root, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  gap(out, 1);
  out.push('package main');
  gap(out, 1);
  out.push('import (');
  // gofmt sorts an import block by path, so emit it sorted and save the reader
  // a diff on their first save.
  // A duplicated path is a compile error in Go, and `os` in particular is
  // wanted by both the connection and a load step, so the block is a set.
  const imports = [...new Set(['"log"', '"os"', ...driver.imports, ...loadImports(root, 'go'), ...importLines(d, root, 'go')])].sort((a, b) => {
    const path = (s: string) => s.slice(s.indexOf('"'));
    return path(a).localeCompare(path(b));
  });
  out.push(imports.map((i) => `\t${i}`).join('\n'));
  out.push(')');

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`// ${stepCaption(s)}`);
    out.push(`const ${camel(s.slug)}SQL = \`\n${s.sql}\n\``);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 1);
    out.push(`// ${stepCaption(step)}`);
    const inLoop = inRowLoop(unit, step);
    out.push(`func ${camel(step.slug)}(${inLoop ? 'rows *sql.Rows' : ''}) error {`);
    out.push('\tpanic("the work this program exists to do")');
    out.push('}');
  }

  for (const block of goDefinitions(d, root, driver)) {
    gap(out, 1);
    out.push(...block);
  }

  if (needsMain(root)) {
    gap(out, 1);
    out.push('func main() {');
    out.push('\tdsn := os.Getenv("DATABASE_URL")');
    out.push('\tif dsn == "" {');
    out.push(`\t\tdsn = ${JSON.stringify(driver.dsn)}`);
    out.push('\t}');
    out.push(`\tdb, err := ${driver.connect}`);
    out.push('\tif err != nil {');
    out.push('\t\tlog.Fatal(err)');
    out.push('\t}');
    out.push('\tdefer db.Close()');
    out.push('');
    if (root.body.length) out.push(buildBody(root.body, goStep, { base: '\t', step: '\t', loopOpen: 'for rows.Next() {', loopClose: '}' }));
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Java                                                                */
/* ------------------------------------------------------------------ */

const JAVA = '    ';

function javaStep(s: ProgramCodeStep, ctx: StepContext): string[] {
  const lines = [`// ${stepCaption(s)}`];
  if (s.stub) lines.push(`${camel(s.slug)}(${ctx.inLoop ? 'rows' : ''});`);
  else if (s.op === 'load') lines.push(...loadCode(s, 'java'));
  else if (s.op === 'read')
    lines.push(
      `PreparedStatement ${camel(s.slug)} = conn.prepareStatement(${upperSnake(s.slug)});`,
      `ResultSet ${ctx.first ? 'rows' : `${camel(s.slug)}Rows`} = ${camel(s.slug)}.executeQuery();`,
    );
  else {
    lines.push(`PreparedStatement ${camel(s.slug)} = conn.prepareStatement(${upperSnake(s.slug)});`);
    if (s.params.length) s.params.forEach((n, idx) => lines.push(`${camel(s.slug)}.setObject(${idx + 1}, ${n});`));
    else lines.push('// bind what this statement needs');
    lines.push(`${camel(s.slug)}.executeUpdate();`);
  }
  return lines;
}

function javaBody(u: CodeUnit, driver: Driver, pad: string, handed: boolean): string[] {
  if (!u.body.length) return [];
  if (!needsConnection(u) || handed) return [buildBody(u.body, javaStep, { base: pad, step: JAVA, loopOpen: 'while (rows.next()) {', loopClose: '}' })];
  const out = [`${pad}try (Connection conn = ${driver.connect}) {`];
  out.push(buildBody(u.body, javaStep, { base: pad + JAVA, step: JAVA, loopOpen: 'while (rows.next()) {', loopClose: '}' }));
  out.push(`${pad}}`);
  return out;
}

function javaMethod(d: Diagram, u: CodeUnit, depth: number, driver: Driver, name?: string, doc?: string[]): string[] {
  const pad = JAVA.repeat(depth);
  const declared = name ? undefined : declaredSignature(u, 'java');
  const head = declared
    ? `${/\bthrows\b/.test(declared) ? declared : `${declared} throws Exception`} {`
    : `static void ${camel(snake(name ?? u.node.name))}(${needsConnection(u) ? 'Connection conn' : ''}) throws Exception {`;
  const out = [...indentAll(commentBlock(doc ?? unitDoc(d, u, !declared), '//').split('\n'), pad), `${pad}${head}`];
  out.push(...javaBody(u, driver, pad + JAVA, takesHandle(declared, 'conn') || (!declared && needsConnection(u))));
  out.push(`${pad}}`);
  return out;
}

function javaClass(d: Diagram, u: CodeUnit, depth: number, driver: Driver): string[] {
  const pad = JAVA.repeat(depth);
  const extend = u.bases.length ? ` extends ${typeName(u.bases[0])}` : '';
  const out = [...indentAll(commentBlock(unitDoc(d, u, true), '//').split('\n'), pad), `${pad}static class ${typeName(u.node.name)}${extend} {`];
  out.push(...javaMembers(d, u, depth + 1, driver));
  out.push(`${pad}}`);
  return out;
}

function javaMembers(d: Diagram, u: CodeUnit, depth: number, driver: Driver): string[] {
  const out: string[] = [];
  if (u.body.length && u.kind === 'class') {
    out.push(...javaMethod(d, u, depth, driver, ownStepsName(u), [`The steps drawn on ${u.node.name} itself.`]));
  }
  for (const m of u.members) {
    gap(out, 1);
    out.push(...(m.kind === 'function' ? javaMethod(d, m, depth, driver) : javaClass(d, m, depth, driver)));
  }
  return out;
}

function emitJava(d: Diagram, root: CodeUnit, driver: Driver): string {
  // The file is one class either way; when the node picked *is* a class, that
  // outer class is it, rather than a wrapper with the same thing nested inside.
  // A class keeps the name it was given; a file name becomes a class name,
  // because Java wants Orders.java to hold Orders and orders.py is a file.
  const cls = root.kind === 'class' ? typeName(root.node.name) : pascal(snake(stem(root.node.name)));
  const extend = root.kind === 'class' && root.bases.length ? ` extends ${typeName(root.bases[0])}` : '';
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, root, driver), '//'));
  out.push('//');
  out.push(`// Dependency: ${driver.install}`);
  gap(out, 1);
  out.push(...driver.imports, ...loadImports(root, 'java'), ...importLines(d, root, 'java'));
  gap(out, 1);
  out.push(`public class ${cls}${extend} {`);
  out.push(`    private static final String DSN = System.getenv().getOrDefault("DATABASE_URL", ${JSON.stringify(driver.dsn)});`);

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`    // ${stepCaption(s)}`);
    out.push(`    private static final String ${upperSnake(s.slug)} = """\n${indent(s.sql, '        ')}\n        """;`);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 1);
    out.push(`    // ${stepCaption(step)}`);
    const inLoop = inRowLoop(unit, step);
    out.push(`    private static void ${camel(step.slug)}(${inLoop ? 'ResultSet row' : ''}) {`);
    out.push('        throw new UnsupportedOperationException("the work this program exists to do");');
    out.push('    }');
  }

  const members = javaMembers(d, root, 1, driver);
  if (members.length) {
    gap(out, 1);
    out.push(...members);
  }

  if (needsMain(root)) {
    gap(out, 1);
    out.push('    public static void main(String[] args) throws Exception {');
    const body = javaBody(root, driver, `${JAVA}${JAVA}`, false);
    out.push(...body);
    out.push('    }');
  }
  out.push('}');
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* JavaScript and TypeScript                                           */
/* ------------------------------------------------------------------ */

const JS = '  ';

/**
 * How each Node driver spells "run this and give me the rows" and "run this".
 *
 * They disagree about all of it: node-postgres answers with a result object,
 * the MariaDB connector with the rows themselves, `node:sqlite` with a
 * statement to prepare first and no promise at all, and DuckDB wants the
 * result read before there are rows to walk. One `db.query` for the four of
 * them was right for one of them.
 */
const NODE_CALLS: Partial<Record<DriverShape, { rows: (sql: string, into: string) => string; exec: (sql: string, args: string) => string }>> = {
  pg: {
    rows: (sql, into) => `const { rows${into === 'rows' ? '' : `: ${into}`} } = await db.query(${sql});`,
    exec: (sql, args) => `await db.query(${sql}, [${args}]);`,
  },
  'mariadb-node': {
    rows: (sql, into) => `const ${into} = await db.query(${sql});`,
    exec: (sql, args) => `await db.query(${sql}, [${args}]);`,
  },
  'node-sqlite': {
    rows: (sql, into) => `const ${into} = db.prepare(${sql}).all();`,
    exec: (sql, args) => `db.prepare(${sql}).run(${args});`,
  },
  'duckdb-node': {
    rows: (sql, into) => `const ${into} = await (await db.runAndReadAll(${sql})).getRowObjects();`,
    exec: (sql, args) => `await db.run(${sql}, [${args}]);`,
  },
};

function nodeCalls(driver: Driver) {
  return NODE_CALLS[driver.shape] ?? NODE_CALLS.pg!;
}

function jsStep(driver: Driver): (s: ProgramCodeStep, ctx: StepContext) => string[] {
  const calls = nodeCalls(driver);
  return (s, ctx) => {
    const lines = [`// ${stepCaption(s)}`];
    const sql = `${camel(s.slug)}Sql`;
    if (s.stub) lines.push(`${camel(s.slug)}(${ctx.inLoop ? 'row' : ''});`);
    else if (s.op === 'load') lines.push(...loadCode(s, 'javascript'));
    else if (s.op === 'read') lines.push(calls.rows(sql, ctx.first ? 'rows' : `${camel(s.slug)}Rows`));
    else {
      if (!s.params.length) lines.push('// bind what this statement needs');
      lines.push(calls.exec(sql, s.params.join(', ')));
    }
    return lines;
  };
}

function jsBody(u: CodeUnit, driver: Driver, pad: string, handed: boolean, opener: string): string[] {
  const out: string[] = [];
  if (!handed && needsConnection(u)) {
    out.push(`${pad}const db = ${opener};`);
    out.push('');
  }
  if (u.body.length) out.push(buildBody(u.body, jsStep(driver), { base: pad, step: JS, loopOpen: 'for (const row of rows) {', loopClose: '}' }));
  return out;
}

function jsDoc(lines: string[], pad: string): string[] {
  return [`${pad}/**`, ...lines.map((l) => (l ? `${pad} * ${l}` : `${pad} *`)), `${pad} */`];
}

function jsFunction(d: Diagram, u: CodeUnit, driver: Driver, depth: number, typed: boolean, method: boolean, name?: string, doc?: string[]): string[] {
  const pad = JS.repeat(depth);
  const declared = name ? undefined : declaredSignature(u, typed ? 'typescript' : 'javascript');
  const params = needsConnection(u) ? `db${typed ? ': Db' : ''}` : '';
  const head = declared
    ? `${declared} {`
    : `async ${method ? '' : 'function '}${camel(snake(name ?? u.node.name))}(${params})${typed ? ': Promise<void>' : ''} {`;
  const out = [...jsDoc(doc ?? unitDoc(d, u, !declared), pad), `${pad}${head}`];
  out.push(...jsBody(u, driver, pad + JS, takesHandle(declared, 'db') || (!declared && needsConnection(u)), 'await openDb()'));
  gap(out, 0);
  out.push(`${pad}}`);
  return out;
}

/**
 * A class body holds methods and nothing else in JavaScript, so a class drawn
 * inside a class is written beside it instead, at the top level where the
 * language can take it. Its doc comment says where it sits.
 */
function jsDefinitions(d: Diagram, root: CodeUnit, driver: Driver, typed: boolean): string[][] {
  const out: string[][] = [];
  for (const u of flatUnits(root)) {
    if (u.kind === 'function') {
      if (u === root || (u.parent && u.parent.kind === 'class')) continue;
      out.push(jsFunction(d, u, driver, 0, typed, false));
      continue;
    }
    if (u.kind !== 'class') continue;
    const extend = u.bases.length ? ` extends ${typeName(u.bases[0])}` : '';
    const inner: string[] = [];
    if (u.body.length) inner.push(...jsFunction(d, u, driver, 1, typed, true, ownStepsName(u), [`The steps drawn on ${u.node.name} itself.`]));
    for (const m of u.members.filter((x) => x.kind === 'function')) {
      gap(inner, 1);
      inner.push(...jsFunction(d, m, driver, 1, typed, true));
    }
    out.push([...jsDoc(unitDoc(d, u, true, true), ''), `class ${typeName(u.node.name)}${extend} {`, ...inner, '}']);
  }
  return out;
}

function emitNode(d: Diagram, root: CodeUnit, driver: Driver, typed: boolean): string {
  const lang: ProgramLanguage = typed ? 'typescript' : 'javascript';
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, root, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  gap(out, 1);
  out.push(...driver.imports, ...loadImports(root, lang), ...importLines(d, root, lang));
  gap(out, 1);
  out.push(`const DSN = process.env.DATABASE_URL ?? ${JSON.stringify(driver.dsn)};`);
  // More than one definition means more than one place that wants a
  // connection, so it is opened once behind a name they can all take. The
  // TypeScript alias is inferred from that name rather than written out per
  // driver, which is the one spelling that stays right when the driver changes.
  const shared = definitionsOf(root).some((u) => flatUnits(u).some(needsConnection));
  if (shared) {
    gap(out, 1);
    out.push('async function openDb() {');
    out.push(`  return ${driver.connect};`);
    out.push('}');
    if (typed) {
      gap(out, 1);
      out.push('type Db = Awaited<ReturnType<typeof openDb>>;');
    }
  }

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`// ${stepCaption(s)}`);
    out.push(`const ${camel(s.slug)}Sql = \`\n${s.sql}\n\`;`);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 1);
    out.push(`/** ${stepCaption(step)} */`);
    const inLoop = inRowLoop(unit, step);
    out.push(`function ${camel(step.slug)}(${inLoop ? `row${typed ? ': Record<string, unknown>' : ''}` : ''})${typed ? ': void' : ''} {`);
    out.push("  throw new Error('the work this program exists to do');");
    out.push('}');
  }

  for (const block of jsDefinitions(d, root, driver, typed)) {
    gap(out, 1);
    out.push(...block);
  }

  if (needsMain(root)) {
    gap(out, 1);
    out.push(`async function main()${typed ? ': Promise<void>' : ''} {`);
    out.push(`  const db = ${shared ? 'await openDb()' : driver.connect};`);
    out.push('');
    if (root.body.length) out.push(buildBody(root.body, jsStep(driver), { base: JS, step: JS, loopOpen: 'for (const row of rows) {', loopClose: '}' }));
    out.push('}');
    gap(out, 1);
    out.push('await main();');
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* C and C++                                                           */
/* ------------------------------------------------------------------ */

/**
 * What talking to one engine looks like in C or C++.
 *
 * These two languages have no common database interface — no DB-API, no
 * database/sql, no JDBC — so every pairing is its own conversation: prepare and
 * step for SQLite, exec and tuple counts for libpq, a transaction object for
 * libpqxx. Writing that conversation out is the whole value of a starter here;
 * a comment saying "run READ_JOBS" is worth nothing to anybody.
 */
interface NativeShape {
  /** Headers the file needs beyond the driver's own. */
  extras: string[];
  /** Opening the connection, with `dsn` in scope, ending with `handle` bound. */
  open: string[];
  /** What a function that issues SQL is handed, and what `main` passes for it. */
  handle: { type: string; name: string };
  /** Issuing a read, into the named variable. */
  read: (s: ProgramCodeStep, into: string) => string[];
  /** Issuing a write. */
  write: (s: ProgramCodeStep) => string[];
  loopOpen: string;
  loopClose: string;
  /** Letting go of everything, in the order a reader would. */
  close: string[];
  /** How a compute stub is declared, and how it is called. */
  stub: (slug: string, caption: string, inLoop: boolean) => string[];
  call: (slug: string, inLoop: boolean) => string;
  /** Wrapping for `main`, where the language would rather throw than check. */
  guard?: { open: string; close: string[] };
}

const BIND = '/* bind what this statement needs */';

const C_SHAPES: Partial<Record<DriverShape, NativeShape>> = {
  libpq: {
    extras: ['#include <stdio.h>', '#include <stdlib.h>'],
    open: [
      'PGconn *conn = PQconnectdb(dsn);',
      'if (PQstatus(conn) != CONNECTION_OK) {',
      '    fprintf(stderr, "%s", PQerrorMessage(conn));',
      '    return 1;',
      '}',
    ],
    handle: { type: 'PGconn *', name: 'conn' },
    read: (s, into) => [`PGresult *${into} = PQexec(conn, ${upperSnake(s.slug)});`],
    write: (s) => [
      s.params.length
        ? `const char *${s.slug}_values[${s.params.length}] = {${s.params.map((n) => `/* ${n} */ NULL`).join(', ')}};`
        : BIND,
      `PQclear(PQexecParams(conn, ${upperSnake(s.slug)}, ${s.params.length}, NULL, ${s.params.length ? `${s.slug}_values` : 'NULL'}, NULL, NULL, 0));`,
    ],
    loopOpen: 'for (int row = 0; row < PQntuples(rows); row++) {',
    loopClose: '}',
    close: ['PQfinish(conn);'],
    stub: (slug, caption, inLoop) => [
      `/* ${caption} */`,
      `static void ${slug}(${inLoop ? 'PGresult *rows, int row' : 'void'}) {`,
      '    fprintf(stderr, "not implemented\\n");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? 'rows, row' : ''});`,
  },
  'mysql-c': {
    extras: ['#include <stdio.h>', '#include <stdlib.h>'],
    open: [
      'MYSQL *conn = mysql_init(NULL);',
      'if (!mysql_real_connect(conn, "localhost", "root", "", dsn, 3306, NULL, 0)) {',
      '    fprintf(stderr, "%s", mysql_error(conn));',
      '    return 1;',
      '}',
    ],
    handle: { type: 'MYSQL *', name: 'conn' },
    read: (s, into) => [
      `mysql_query(conn, ${upperSnake(s.slug)});`,
      `MYSQL_RES *${into}_result = mysql_store_result(conn);`,
      `MYSQL_ROW ${into};`,
    ],
    write: (s) => [
      s.params.length ? `/* bind ${s.params.join(', ')} with mysql_stmt_bind_param */` : BIND,
      `mysql_query(conn, ${upperSnake(s.slug)});`,
    ],
    loopOpen: 'while ((rows = mysql_fetch_row(rows_result))) {',
    loopClose: '}',
    close: ['mysql_close(conn);'],
    stub: (slug, caption, inLoop) => [
      `/* ${caption} */`,
      `static void ${slug}(${inLoop ? 'MYSQL_ROW row' : 'void'}) {`,
      '    fprintf(stderr, "not implemented\\n");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? 'rows' : ''});`,
  },
  'sqlite3-c': {
    extras: ['#include <stdio.h>', '#include <stdlib.h>'],
    open: [
      'sqlite3 *db;',
      'if (sqlite3_open(dsn, &db) != SQLITE_OK) {',
      '    fprintf(stderr, "%s", sqlite3_errmsg(db));',
      '    return 1;',
      '}',
    ],
    handle: { type: 'sqlite3 *', name: 'db' },
    read: (s, into) => [`sqlite3_stmt *${into};`, `sqlite3_prepare_v2(db, ${upperSnake(s.slug)}, -1, &${into}, NULL);`],
    write: (s) => [
      `sqlite3_stmt *${s.slug};`,
      `sqlite3_prepare_v2(db, ${upperSnake(s.slug)}, -1, &${s.slug}, NULL);`,
      ...(s.params.length ? s.params.map((n, i) => `/* sqlite3_bind_* (${s.slug}, ${i + 1}, ${n}); */`) : [BIND]),
      `sqlite3_step(${s.slug});`,
      `sqlite3_finalize(${s.slug});`,
    ],
    loopOpen: 'while (sqlite3_step(rows) == SQLITE_ROW) {',
    loopClose: '}',
    close: ['sqlite3_close(db);'],
    stub: (slug, caption, inLoop) => [
      `/* ${caption} */`,
      `static void ${slug}(${inLoop ? 'sqlite3_stmt *row' : 'void'}) {`,
      '    fprintf(stderr, "not implemented\\n");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? 'rows' : ''});`,
  },
  'duckdb-c': {
    extras: ['#include <stdio.h>', '#include <stdlib.h>'],
    open: [
      'duckdb_database database;',
      'duckdb_connection conn;',
      'if (duckdb_open(dsn, &database) == DuckDBError || duckdb_connect(database, &conn) == DuckDBError) {',
      '    fprintf(stderr, "could not open %s\\n", dsn);',
      '    return 1;',
      '}',
    ],
    handle: { type: 'duckdb_connection', name: 'conn' },
    read: (s, into) => [`duckdb_result ${into};`, `duckdb_query(conn, ${upperSnake(s.slug)}, &${into});`],
    write: (s) => [
      s.params.length ? `/* bind ${s.params.join(', ')} with duckdb_prepare and duckdb_bind_* */` : BIND,
      `duckdb_query(conn, ${upperSnake(s.slug)}, NULL);`,
    ],
    loopOpen: 'for (idx_t row = 0; row < duckdb_row_count(&rows); row++) {',
    loopClose: '}',
    close: ['duckdb_disconnect(&conn);', 'duckdb_close(&database);'],
    stub: (slug, caption, inLoop) => [
      `/* ${caption} */`,
      `static void ${slug}(${inLoop ? 'duckdb_result *rows, idx_t row' : 'void'}) {`,
      '    fprintf(stderr, "not implemented\\n");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? '&rows, row' : ''});`,
  },
};

const CPP_SHAPES: Partial<Record<DriverShape, NativeShape>> = {
  libpqxx: {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <stdexcept>', '#include <string>'],
    open: ['pqxx::connection connection{dsn};', 'pqxx::work tx{connection};'],
    handle: { type: 'pqxx::work &', name: 'tx' },
    read: (s, into) => [`pqxx::result ${into} = tx.exec(${upperSnake(s.slug)});`],
    write: (s) =>
      s.params.length
        ? [`tx.exec_params(${upperSnake(s.slug)}, ${s.params.join(', ')});`]
        : ['// bind what this statement needs', `tx.exec_params(${upperSnake(s.slug)});`],
    loopOpen: 'for (const auto &row : rows) {',
    loopClose: '}',
    close: ['tx.commit();'],
    stub: (slug, caption, inLoop) => [
      `/// ${caption}`,
      `static void ${slug}(${inLoop ? 'const pqxx::row &row' : ''}) {`,
      '    throw std::logic_error("the work this program exists to do");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? 'row' : ''});`,
    guard: { open: 'try {', close: ['} catch (const std::exception &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
  'mariadb-cpp': {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <memory>', '#include <stdexcept>'],
    open: [
      'std::unique_ptr<sql::Connection> connection{sql::mariadb::get_driver_instance()->connect(dsn, "root", "")};',
      'sql::Connection &conn = *connection;',
    ],
    handle: { type: 'sql::Connection &', name: 'conn' },
    read: (s, into) => [
      `std::unique_ptr<sql::PreparedStatement> ${s.slug}{conn.prepareStatement(${upperSnake(s.slug)})};`,
      `std::unique_ptr<sql::ResultSet> ${into}{${s.slug}->executeQuery()};`,
    ],
    write: (s) => [
      `std::unique_ptr<sql::PreparedStatement> ${s.slug}{conn.prepareStatement(${upperSnake(s.slug)})};`,
      ...(s.params.length ? s.params.map((n, i) => `${s.slug}->setString(${i + 1}, ${n});`) : ['// bind what this statement needs']),
      `${s.slug}->executeUpdate();`,
    ],
    loopOpen: 'while (rows->next()) {',
    loopClose: '}',
    close: ['conn.close();'],
    stub: (slug, caption, inLoop) => [
      `/// ${caption}`,
      `static void ${slug}(${inLoop ? 'sql::ResultSet &row' : ''}) {`,
      '    throw std::logic_error("the work this program exists to do");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? '*rows' : ''});`,
    guard: { open: 'try {', close: ['} catch (const sql::SQLException &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
  sqlitecpp: {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <stdexcept>'],
    open: ['SQLite::Database db{dsn, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE};'],
    handle: { type: 'SQLite::Database &', name: 'db' },
    read: (s, into) => [`SQLite::Statement ${into}{db, ${upperSnake(s.slug)}};`],
    write: (s) => [
      `SQLite::Statement ${s.slug}{db, ${upperSnake(s.slug)}};`,
      ...(s.params.length ? s.params.map((n, i) => `${s.slug}.bind(${i + 1}, ${n});`) : ['// bind what this statement needs']),
      `${s.slug}.exec();`,
    ],
    loopOpen: 'while (rows.executeStep()) {',
    loopClose: '}',
    close: [],
    stub: (slug, caption, inLoop) => [
      `/// ${caption}`,
      `static void ${slug}(${inLoop ? 'SQLite::Statement &row' : ''}) {`,
      '    throw std::logic_error("the work this program exists to do");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? 'rows' : ''});`,
    guard: { open: 'try {', close: ['} catch (const std::exception &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
  'duckdb-cpp': {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <memory>', '#include <stdexcept>'],
    open: ['duckdb::DuckDB database{dsn};', 'duckdb::Connection conn{database};'],
    handle: { type: 'duckdb::Connection &', name: 'conn' },
    read: (s, into) => [`auto ${into} = conn.Query(${upperSnake(s.slug)});`],
    write: (s) =>
      s.params.length
        ? [`conn.Query(${upperSnake(s.slug)}, ${s.params.join(', ')});`]
        : ['// bind what this statement needs', `conn.Query(${upperSnake(s.slug)});`],
    loopOpen: 'for (idx_t row = 0; row < rows->RowCount(); row++) {',
    loopClose: '}',
    close: [],
    stub: (slug, caption, inLoop) => [
      `/// ${caption}`,
      `static void ${slug}(${inLoop ? 'duckdb::MaterializedQueryResult &rows, idx_t row' : ''}) {`,
      '    throw std::logic_error("the work this program exists to do");',
      '}',
    ],
    call: (slug, inLoop) => `${slug}(${inLoop ? '*rows, row' : ''});`,
    guard: { open: 'try {', close: ['} catch (const std::exception &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
};

function cStep(shape: NativeShape, lang: ProgramLanguage): (s: ProgramCodeStep, ctx: StepContext) => string[] {
  return (s, ctx) => {
    const lines = [`// ${stepCaption(s)}`];
    if (s.stub) lines.push(shape.call(s.slug, ctx.inLoop));
    else if (s.op === 'load') lines.push(...loadCode(s, lang));
    else if (s.op === 'read') lines.push(...shape.read(s, ctx.first ? 'rows' : `${s.slug}_rows`));
    else lines.push(...shape.write(s));
    return lines;
  };
}

/**
 * C has no classes and C++ has them in a header, so the map is flattened into
 * functions named for the path that reached them: `order_service_place_order`.
 * The comment above each says where it came from, which is the part a reader
 * needs to put it back, and each is handed the connection rather than opening
 * one of its own.
 */
function cFunctions(d: Diagram, root: CodeUnit, shape: NativeShape, lang: ProgramLanguage): string[][] {
  const out: string[][] = [];
  for (const u of flatUnits(root)) {
    if (u === root || !u.body.length) continue;
    const name = u.path.map(snake).join('_');
    const takes = needsConnection(u) ? `${shape.handle.type}${shape.handle.name}` : 'void';
    const block = [...commentBlock(unitDoc(d, u, true, true), '//').split('\n'), `static int ${name}(${takes}) {`];
    block.push(buildBody(u.body, cStep(shape, lang), { base: '    ', step: '    ', loopOpen: shape.loopOpen, loopClose: shape.loopClose }));
    block.push('');
    block.push('    return 0;');
    block.push('}');
    out.push(block);
  }
  return out;
}

function emitC(d: Diagram, root: CodeUnit, driver: Driver, cpp: boolean): string {
  const shape = (cpp ? CPP_SHAPES : C_SHAPES)[driver.shape];
  if (!shape) return emitOutline(d, root);
  const lang: ProgramLanguage = cpp ? 'cpp' : 'c';
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, root, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  gap(out, 1);
  out.push(...shape.extras);
  out.push(...driver.imports, ...loadImports(root, lang), ...importLines(d, root, lang));

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`// ${stepCaption(s)}`);
    // One string literal per line keeps the SQL readable in C, where there are
    // no raw strings before C++11's R"(...)".
    const literal = s.sql
      .split('\n')
      .map((l) => `    "${l.replace(/"/g, '\\"')} "`)
      .join('\n');
    out.push(`static const char *${upperSnake(s.slug)} =\n${literal};`);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 1);
    out.push(...shape.stub(step.slug, stepCaption(step), inRowLoop(unit, step)));
  }

  for (const block of cFunctions(d, root, shape, lang)) {
    gap(out, 1);
    out.push(...block);
  }

  const called = flatUnits(root).filter((u) => u !== root && u.body.length);
  const guard = shape.guard;
  const pad = guard ? '        ' : '    ';
  gap(out, 1);
  // C spells an empty parameter list `(void)` and C++ does not, and a reader
  // of either notices the other one's.
  out.push(cpp ? 'int main() {' : 'int main(void) {');
  out.push('    const char *dsn = getenv("DATABASE_URL");');
  out.push(`    if (!dsn) dsn = ${JSON.stringify(driver.dsn)};`);
  if (guard) out.push(`    ${guard.open}`);
  out.push(indent(shape.open.join('\n'), pad));
  if (root.body.length) {
    out.push('');
    out.push(buildBody(root.body, cStep(shape, lang), { base: pad, step: '    ', loopOpen: shape.loopOpen, loopClose: shape.loopClose }));
  }
  for (const u of called) {
    out.push('');
    out.push(`${pad}// ${u.path.join('/')}`);
    out.push(`${pad}${u.path.map(snake).join('_')}(${needsConnection(u) ? shape.handle.name : ''});`);
  }
  if (shape.close.length) {
    out.push('');
    out.push(indent(shape.close.join('\n'), pad));
  }
  if (guard) out.push(...guard.close.map((l) => `    ${l}`));
  out.push('');
  out.push('    return 0;');
  out.push('}');
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Perl                                                                */
/* ------------------------------------------------------------------ */

const PL = '    ';

/**
 * DBI is the client side of Perl, whichever engine is underneath.
 *
 * So there is one shape here rather than four: prepare a statement, execute it
 * with what it binds, walk the rows as hashes. What changes with the dialect is
 * the DSN and the DBD package, and both of those are the driver's business
 * rather than this file's.
 */
function perlStep(s: ProgramCodeStep, ctx: StepContext): string[] {
  const lines = [`# ${stepCaption(s)}`];
  const sth = ctx.first ? 'sth' : `${s.slug}_sth`;
  if (s.stub) lines.push(`${s.slug}(${ctx.inLoop ? '$row' : ''});`);
  else if (s.op === 'load') lines.push(...loadCode(s, 'perl'));
  else if (s.op === 'read') lines.push(`my $${sth} = $dbh->prepare($${upperSnake(s.slug)});`, `$${sth}->execute();`);
  else {
    lines.push(`my $${s.slug}_sth = $dbh->prepare($${upperSnake(s.slug)});`);
    // `use strict` means an undeclared name is a compile error rather than a
    // hole to fill in, so the parameters are declared here and left empty.
    if (s.params.length) lines.push(`my (${s.params.map((n) => `$${n}`).join(', ')});  # fill these in`);
    else lines.push('# bind what this statement needs');
    lines.push(`$${s.slug}_sth->execute(${s.params.map((n) => `$${n}`).join(', ')});`);
  }
  return lines;
}

/** A unit's steps, after whatever it takes to have a handle in scope. */
function perlBody(u: CodeUnit, driver: Driver, pad: string, handed: boolean): string[] {
  if (!u.body.length) return [];
  const out: string[] = [];
  const opens = !handed && needsConnection(u);
  if (opens) {
    out.push(`${pad}my $dbh = ${driver.connect};`);
    out.push('');
  }
  out.push(buildBody(u.body, perlStep, { base: pad, step: PL, loopOpen: 'while (my $row = $sth->fetchrow_hashref) {', loopClose: '}' }));
  // AutoCommit is off in every one of these connections, so the work has to be
  // committed by whoever did it.
  if (needsConnection(u)) {
    out.push('');
    out.push(`${pad}$dbh->commit;`);
  }
  if (opens) out.push(`${pad}$dbh->disconnect;`);
  return out;
}

function perlSub(d: Diagram, u: CodeUnit, driver: Driver, pad: string, method: boolean, name?: string, doc?: string[]): string[] {
  const declared = name ? undefined : declaredSignature(u, 'perl');
  const inner = pad + PL;
  const out = [...indentAll(commentBlock(doc ?? unitDoc(d, u, !declared), '#').split('\n'), pad), `${pad}${declared ? `${declared} {` : `sub ${name ?? snake(u.node.name)} {`}`];
  // A signature Perl only understands with the feature on is written as given;
  // `emitPerl` turns the feature on when any of them is.
  const handed = takesHandle(declared, 'dbh') || (!declared && needsConnection(u));
  if (!declared) {
    const args = [method ? '$self' : '', needsConnection(u) ? '$dbh' : ''].filter(Boolean);
    if (args.length) out.push(`${inner}my (${args.join(', ')}) = @_;`, '');
  }
  const body = perlBody(u, driver, inner, handed);
  out.push(...(body.length ? body : [`${inner}return;`]));
  out.push(`${pad}}`);
  return out;
}

/**
 * A class is a package, and Perl's package block nests, so the shape of the
 * canvas survives into the file unchanged — which is not true of Rust, Go or C,
 * and is the one place Perl's age works in its favour here.
 */
function perlPackage(d: Diagram, u: CodeUnit, driver: Driver, pad: string): string[] {
  const inner = pad + PL;
  const out = [...indentAll(commentBlock(unitDoc(d, u, true), '#').split('\n'), pad), `${pad}package ${typeName(u.node.name)} {`];
  for (const base of u.bases) out.push(`${inner}use parent -norequire, '${typeName(base)}';`);
  if (u.bases.length) out.push('');
  if (u.body.length) out.push(...perlSub(d, u, driver, inner, true, ownStepsName(u), [`The steps drawn on ${u.node.name} itself.`]));
  for (const m of u.members) {
    gap(out, 1);
    out.push(...perlDefinition(d, m, driver, inner));
  }
  gap(out, 0);
  out.push(`${pad}}`);
  return out;
}

function perlDefinition(d: Diagram, u: CodeUnit, driver: Driver, pad: string): string[] {
  return u.kind === 'function' ? perlSub(d, u, driver, pad, Boolean(u.parent && u.parent.kind === 'class')) : perlPackage(d, u, driver, pad);
}

function emitPerl(d: Diagram, root: CodeUnit, driver: Driver): string {
  const out: string[] = ['#!/usr/bin/env perl'];
  out.push(commentBlock(headerLines(d, root, driver), '#'));
  out.push('#');
  out.push(`# ${driver.install}`);
  gap(out, 1);
  out.push(...driver.imports);
  // Signatures are a feature rather than the default, and one is only written
  // when the reader wrote it themselves on a node.
  if (flatUnits(root).some((u) => declaredSignature(u, 'perl'))) {
    out.push("use feature 'signatures';", "no warnings 'experimental::signatures';");
  }
  out.push(...loadImports(root, 'perl'), ...importLines(d, root, 'perl'));
  gap(out, 1);
  out.push(`my $DSN = $ENV{DATABASE_URL} // ${sq(driver.dsn)};`);

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`# ${stepCaption(s)}`);
    // A quoted heredoc: the statement is text, and a `$` in it is a dollar.
    out.push(`my $${upperSnake(s.slug)} = <<'SQL';\n${s.sql}\nSQL`);
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 2);
    out.push(`# ${stepCaption(step)}`);
    out.push(`sub ${step.slug} {`);
    if (inRowLoop(unit, step)) out.push(`${PL}my ($row) = @_;`);
    out.push(`${PL}die 'the work this program exists to do';`);
    out.push('}');
  }

  for (const u of definitionsOf(root)) {
    gap(out, 2);
    out.push(...perlDefinition(d, u, driver, ''));
  }

  if (needsMain(root)) {
    gap(out, 2);
    out.push('sub main {');
    const body = perlBody(root, driver, PL, false);
    out.push(...(body.length ? body : [`${PL}return;`]));
    out.push('}');
    gap(out, 2);
    // `unless caller` so the same file can be run and required.
    out.push('main() unless caller;');
  }
  gap(out, 1);
  out.push('1;');
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

const SH = '  ';

/**
 * How each database's own command takes a statement.
 *
 * And one thing they disagree about that matters more than the flag: psql has
 * parameters and the other three have not. `-v p1=…` with `:'p1'` in the text
 * is interpolated and quoted by psql itself; everywhere else a value gets into
 * the statement because the shell put it there, which the header says out loud
 * rather than leaving the reader to notice.
 */
const CLI: Partial<Record<DriverShape, { statement: (sql: string) => string; binds: boolean }>> = {
  'psql-cli': { statement: (sql) => `-c "${sql}"`, binds: true },
  'mysql-cli': { statement: (sql) => `-e "${sql}"`, binds: false },
  'sqlite-cli': { statement: (sql) => `"${sql}"`, binds: false },
  'duckdb-cli': { statement: (sql) => `-c "${sql}"`, binds: false },
};

function cliFor(driver: Driver) {
  return CLI[driver.shape] ?? CLI['psql-cli']!;
}

/** A statement, as the function that prints it. */
function shellSql(s: ProgramCodeStep): string[] {
  // Unquoted only when the generator itself put a `${p1}` in there: a quoted
  // heredoc keeps a `$1` or a `$$ … $$` in the reader's own SQL intact.
  const interpolates = /\$\{p\d+\}/.test(s.sql);
  return [`${s.slug}_sql() {`, `${SH}cat <<${interpolates ? 'SQL' : "'SQL'"}`, ...s.sql.split('\n'), 'SQL', '}'];
}

function shellLoop(pad: string): BodyShape {
  return {
    base: pad,
    step: SH,
    // `read` on an empty result would still run the body once, which is the
    // one thing a row loop must not do.
    loopOpen: `while IFS=$'\\t' read -r row; do\n${pad}${SH}[ -n "$row" ] || continue`,
    loopClose: 'done <<<"$rows"',
  };
}

function shellStep(driver: Driver): (s: ProgramCodeStep, ctx: StepContext) => string[] {
  const cli = cliFor(driver);
  return (s, ctx) => {
    const lines = [`# ${stepCaption(s)}`];
    const vars = cli.binds ? s.params.map((n, i) => ` -v p${i + 1}="$${n}"`).join('') : '';
    const run = `${driver.connect}${vars} ${cli.statement(`$(${s.slug}_sql)`)}`;
    if (s.stub) lines.push(`${s.slug}${ctx.inLoop ? ' "$row"' : ''}`);
    else if (s.op === 'load') lines.push(...loadCode(s, 'shell'));
    else if (s.op === 'read') lines.push(`${ctx.first ? 'rows' : `${s.slug}_rows`}=$(${run})`);
    else {
      if (!s.params.length) lines.push('# bind what this statement needs');
      // Without bound parameters the value has to be a shell variable the
      // heredoc can see, so it is set on its own line first.
      else if (!cli.binds) lines.push(...s.params.map((n, i) => `p${i + 1}="$${n}"`));
      lines.push(run);
    }
    return lines;
  };
}

/**
 * The shell has functions and nothing else — no classes, no nesting, no
 * modules — so a map is flattened into one function per node named for the
 * path that reached it, exactly as C is, and the comment above each says where
 * on the canvas it came from.
 */
function shellFunctions(d: Diagram, root: CodeUnit, driver: Driver): string[][] {
  const out: string[][] = [];
  for (const u of flatUnits(root)) {
    if (u === root || !u.body.length) continue;
    const block = [...commentBlock(unitDoc(d, u, true, true), '#').split('\n'), `${u.path.map(snake).join('_')}() {`];
    block.push(buildBody(u.body, shellStep(driver), shellLoop(SH)));
    block.push('}');
    out.push(block);
  }
  return out;
}

function emitShell(d: Diagram, root: CodeUnit, driver: Driver): string {
  const cli = cliFor(driver);
  const out: string[] = ['#!/usr/bin/env bash'];
  const header = [...headerLines(d, root, driver), ''];
  header.push(
    cli.binds
      ? "Values are passed with -v and read back as :'p1', which psql quotes for you."
      : `${driver.label} has no bound parameters, so a value reaches a statement by the shell pasting it in. Check anything that came from outside before it gets that far.`,
  );
  out.push(commentBlock(header, '#'));
  out.push('#');
  out.push(`# ${driver.install}`);
  gap(out, 1);
  out.push('set -euo pipefail');
  out.push(...importLines(d, root, 'shell'));
  gap(out, 1);
  out.push(`DSN="\${DATABASE_URL:-${driver.dsn}}"`);

  for (const s of fileSql(root)) {
    gap(out, 1);
    out.push(`# ${stepCaption(s)}`);
    out.push(...shellSql(s));
  }

  for (const { unit, step } of fileStubs(root)) {
    gap(out, 1);
    out.push(`# ${stepCaption(step)}`);
    out.push(`${step.slug}() {`);
    if (inRowLoop(unit, step)) out.push(`${SH}local row="\${1:-}"`);
    out.push(`${SH}echo "${step.slug}: the work this program exists to do" >&2`);
    out.push(`${SH}return 1`);
    out.push('}');
  }

  for (const block of shellFunctions(d, root, driver)) {
    gap(out, 1);
    out.push(...block);
  }

  const called = flatUnits(root).filter((u) => u !== root && u.body.length);
  gap(out, 1);
  out.push('main() {');
  if (root.body.length) out.push(buildBody(root.body, shellStep(driver), shellLoop(SH)));
  for (const u of called) {
    gap(out, 1);
    out.push(`${SH}# ${u.path.join('/')}`);
    out.push(`${SH}${u.path.map(snake).join('_')}`);
  }
  // `set -e` and a function that falls through to nothing do not mix; a colon
  // is the shell's way of saying "this body is deliberately empty".
  if (!root.body.length && !called.length) out.push(`${SH}:`);
  out.push('}');
  gap(out, 1);
  out.push('main "$@"');
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Data files                                                          */
/* ------------------------------------------------------------------ */

/**
 * The starter for a data file, which is the one node whose starter is not a
 * program.
 *
 * There is nothing to generate from steps — a data file has none — so what it
 * can honestly give is the file with what the diagram knows written above it:
 * what it is for, and who reads it. JSON gets none of that and gets the empty
 * document instead, because a comment in a JSON file is a JSON file that will
 * not parse, and inventing keys nobody named would be worse than an empty one.
 */
function emitData(d: Diagram, root: CodeUnit): string {
  const p = root.node;
  if (p.language === 'json') return '{}\n';
  const readers = [...new Set(d.programs.filter((x) => x.steps.some((s) => s.op === 'load' && s.codeId === p.id)).map((x) => x.name))];
  const lines = [`${p.name} — a data file in the "${d.name}" diagram.`, '', describeProgram(d, p)];
  if (p.comment?.trim()) lines.push('', p.comment.trim());
  if (p.entrypoint?.trim()) lines.push('', `Belongs in ${p.entrypoint.trim()}.`);
  lines.push('', readers.length ? 'Which keys are in here is the loading code\'s to say; the diagram only says the file is read.' : 'Nothing in the diagram loads it yet.');
  return `${commentBlock(lines, programLanguageMeta(p.language).comment)}\n`;
}

/* ------------------------------------------------------------------ */
/* The fallback                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a language with no driver template gets: the same steps, the same SQL,
 * the same tree of what holds what, in that language's comment syntax. Useless
 * as a program and honest about it, which beats emitting Python under a C#
 * heading.
 */
function emitOutline(d: Diagram, root: CodeUnit): string {
  const marker = programLanguageMeta(root.node.language).comment;
  const out: string[] = [commentBlock(headerLines(d, root, undefined), marker), ''];
  out.push(
    commentBlock([`No driver template exists for ${programLanguageMeta(root.node.language).label} on ${d.dialect} yet,`, 'so this is the plan rather than the program.'], marker),
  );
  out.push('');
  for (const u of flatUnits(root)) {
    if (u !== root) {
      out.push(commentBlock([`${u.path.join('/')} — ${describeProgram(d, u.node)}`], marker));
      out.push('');
    }
    for (const s of u.steps) {
      out.push(commentBlock([stepCaption(s)], marker));
      if (s.sql) out.push(commentBlock(s.sql.split('\n'), marker));
      out.push('');
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** The starter for a code node, in its own language, against the diagram's engine. */
export function generateProgramCode(d: Diagram, p: Program): string {
  // A data file is not a program and has no driver: what it gets is the file.
  if (isDataNode(p)) return emitData(d, resolveUnits(d, p));
  const driver = driverFor(p.language, d.dialect);
  const root = resolveUnits(d, p, driver);
  if (!driver) return emitOutline(d, root);
  switch (p.language) {
    case 'python':
      return emitPython(d, root, driver);
    case 'rust':
      return emitRust(d, root, driver);
    case 'go':
      return emitGo(d, root, driver);
    case 'java':
      return emitJava(d, root, driver);
    case 'javascript':
      return emitNode(d, root, driver, false);
    case 'typescript':
      return emitNode(d, root, driver, true);
    case 'c':
      return emitC(d, root, driver, false);
    case 'cpp':
      return emitC(d, root, driver, true);
    case 'perl':
      return emitPerl(d, root, driver);
    case 'shell':
      return emitShell(d, root, driver);
    default:
      return emitOutline(d, root);
  }
}

/** Filename a saved starter gets, e.g. "ingest_worker.py" or "orders.py". */
export function programCodeFilename(p: Program): string {
  const ext = programLanguageMeta(p.language).extension;
  return `${sanitize(stem(p.name))}.${ext}`;
}

/** Whether a node's starter has anything in it: its own steps, or something it holds. */
export function hasStarter(d: Diagram, p: Program): boolean {
  // A data file always has one, and it is the whole of what the node is.
  return isDataNode(p) || p.steps.length > 0 || d.programs.some((x) => x.parentId === p.id);
}

export { hasDriver };
