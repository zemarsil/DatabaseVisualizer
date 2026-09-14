/**
 * Starter code for a program, generated from its steps.
 *
 * The app already writes SQL from the diagram — DDL, joins, INSERT … SELECT,
 * seed rows, ALTERs. This is the same idea pointed outward: the diagram knows
 * the table names, the column names, the engine and the order the program does
 * things in, so it can write the client side of the conversation too, with the
 * right driver for the language and parameters spelled the way that driver
 * expects.
 *
 * Two things it deliberately does not do. It does not invent a WHERE clause,
 * because guessing which rows a program wants is guessing at the whole program;
 * a step's own SQL is used verbatim when it has any. And it never claims to be
 * finished: compute steps come out as stubs that raise, because the work that
 * happens outside the database is exactly the part the diagram cannot know.
 *
 * The one shape it does assume is the common one: once a program has read
 * something, everything after that read happens per row. That is what a worker
 * looks like, and it is said out loud in the generated header so a reader can
 * disagree with it in one edit.
 */
import {
  isCodeStepOp,
  programLanguageMeta,
  programRoleMeta,
  type Column,
  type Diagram,
  type Dialect,
  type Program,
  type ProgramStep,
  type ProgramStepOp,
  type Table,
} from '@shared/types';
import { quoteIdent, quoteQualified } from '../sql/dialect';
import { describeProgram } from '../programs';
import { driverFor, hasDriver, type Driver, type DriverShape } from './drivers';

/** One step with everything the emitters need already resolved. */
export interface ProgramCodeStep {
  /** 1-based position in the program. */
  index: number;
  op: ProgramStepOp;
  table: Table | undefined;
  columns: Column[];
  /** The step's own SQL, or one written for it. Empty on a compute step. */
  sql: string;
  /** True when the SQL above was written by the app rather than by the user. */
  generated: boolean;
  note: string;
  /** Identifier stem, snake_case: "read_jobs", "compute_2". */
  slug: string;
  /** Names to bind, in placeholder order. Empty when the SQL takes none. */
  params: string[];
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
 * The program's steps with their SQL, columns and identifiers worked out once,
 * so every emitter reads the same resolved list rather than re-deriving it.
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
    // A call, an import or an extends is work the database never sees, so the
    // starter treats it as a compute stub named after what it reaches: the
    // diagram knows *that* place_order is called here, not what calling it
    // takes, and a stub that raises says so.
    if (isCodeStepOp(s.op)) {
      const target = s.codeId ? codeById.get(s.codeId) : undefined;
      const what = target?.name ?? '(missing code)';
      return {
        index: i + 1,
        op: 'compute',
        table: undefined,
        columns: [],
        sql: '',
        generated: false,
        note: s.note?.trim() ? `${s.op} ${what} — ${s.note.trim()}` : `${s.op} ${what}`,
        slug: unique(sanitize(`${s.op}_${target?.name ?? `step_${i + 1}`}`)),
        params: [],
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
      sql,
      generated,
      note: s.note?.trim() ?? '',
      slug,
      // Only SQL the app wrote has parameters it can name; a statement the user
      // typed is theirs, and guessing at its placeholders would be worse than
      // leaving the argument list empty and saying so.
      params: generated && s.op === 'write' ? columns.map((c) => sanitize(c.name)) : [],
    };
  });
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

/** Prose every language puts at the top, before its own comment syntax is applied. */
function headerLines(d: Diagram, p: Program, driver: Driver | undefined): string[] {
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
  // Only the real templates build a row loop, so only they need warning about it.
  if (driver && p.steps.some((s) => s.op === 'read')) {
    lines.push('', 'Everything after the first read is written inside the row loop, which is what a');
    lines.push('worker usually wants. Move it out if this one does its work in bulk instead.');
  }
  return lines;
}

function commentBlock(lines: string[], marker: string): string {
  return lines.map((l) => (l ? `${marker} ${l}` : marker)).join('\n');
}

/** The comment that introduces one step, without a comment marker. */
function stepCaption(s: ProgramCodeStep): string {
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

/** Steps that issue SQL, i.e. everything but the compute ones. */
function sqlSteps(steps: ProgramCodeStep[]): ProgramCodeStep[] {
  return steps.filter((s) => s.op !== 'compute' && s.sql);
}

/**
 * Where the row loop opens: just after the first read. -1 when the program
 * never reads, in which case nothing is wrapped.
 */
function loopAt(steps: ProgramCodeStep[]): number {
  return steps.findIndex((s) => s.op === 'read');
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

/**
 * The main body, assembled the same way in every language: one commented block
 * per step, in order, with everything after the first read moved one level in.
 *
 * Shared rather than repeated because the indentation is the part that is easy
 * to get subtly wrong, and a starter that does not parse is worse than none.
 */
function buildBody(steps: ProgramCodeStep[], emit: (s: ProgramCodeStep) => string[], shape: BodyShape): string {
  const open = loopAt(steps);
  const out: string[] = [];
  steps.forEach((s, i) => {
    const pad = open !== -1 && i > open ? shape.base + shape.step : shape.base;
    // Blank line between blocks, but not directly under the loop header: the
    // first statement of a body belongs against it.
    if (i > 0 && i !== open + 1) out.push('');
    out.push(indent(emit(s).join('\n'), pad));
    if (i === open) {
      out.push('');
      out.push(shape.base + shape.loopOpen);
    }
  });
  if (open !== -1 && shape.loopClose) out.push(shape.base + shape.loopClose);
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

function emitPython(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver): string {
  const out: string[] = [];
  out.push(`"""${headerLines(d, p, driver).join('\n')}\n"""`);
  out.push('');
  out.push(`# ${driver.install}`);
  out.push(driver.imports.join('\n'));
  out.push('');
  out.push(`DSN = os.environ.get("DATABASE_URL", ${JSON.stringify(driver.dsn)})`);
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`# ${stepCaption(s)}`);
    out.push(`${upperSnake(s.slug)} = """\n${s.sql}\n"""`);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push('');
    out.push(`def ${s.slug}(row):`);
    out.push(`    """${stepCaption(s)}"""`);
    out.push('    raise NotImplementedError');
    out.push('');
  }

  out.push('');
  out.push('def main() -> None:');
  out.push(`    with ${driver.connect} as conn, conn.cursor() as cur:`);
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`# ${stepCaption(s)}`];
        if (s.op === 'compute') lines.push(`result_${s.index} = ${s.slug}(row)`);
        else if (s.op === 'read') lines.push(`cur.execute(${upperSnake(s.slug)})`, 'rows = cur.fetchall()');
        else if (s.params.length) lines.push(`cur.execute(${upperSnake(s.slug)}, (${s.params.join(', ')}))`);
        else lines.push('# bind what this statement needs', `cur.execute(${upperSnake(s.slug)}, ())`);
        return lines;
      },
      { base: '        ', step: '    ', loopOpen: 'for row in rows:' },
    ),
  );
  out.push('');
  out.push('        conn.commit()');
  out.push('');
  out.push('');
  out.push('if __name__ == "__main__":');
  out.push('    main()');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Rust                                                                */
/* ------------------------------------------------------------------ */

function emitRust(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver): string {
  const sqlx = driver.shape === 'sqlx';
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, p, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  out.push('');
  out.push(driver.imports.join('\n'));
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`// ${stepCaption(s)}`);
    out.push(`const ${upperSnake(s.slug)}: &str = r#"\n${s.sql}\n"#;`);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push(`/// ${stepCaption(s)}`);
    // Generic over the row type so the stub compiles whichever driver the
    // dialect picked, rather than naming PgRow and breaking on MySQL.
    out.push(sqlx ? `fn ${s.slug}<R: sqlx::Row>(row: &R) -> anyhow::Result<()> {` : `fn ${s.slug}(row: &duckdb::Row) -> anyhow::Result<()> {`);
    out.push('    todo!("the work this program exists to do")');
    out.push('}');
    out.push('');
  }

  if (sqlx) out.push('#[tokio::main]');
  out.push(`${sqlx ? 'async ' : ''}fn main() -> anyhow::Result<()> {`);
  out.push(`    let dsn = std::env::var("DATABASE_URL").unwrap_or_else(|_| ${JSON.stringify(driver.dsn)}.into());`);
  out.push(`    let ${sqlx ? 'pool' : 'conn'} = ${driver.connect};`);
  out.push('');
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`// ${stepCaption(s)}`];
        if (s.op === 'compute') lines.push(`${s.slug}(&row)?;`);
        else if (sqlx && s.op === 'read') lines.push(`let rows = sqlx::query(${upperSnake(s.slug)}).fetch_all(&pool).await?;`);
        else if (sqlx) {
          const binds = s.params.length ? s.params.map((n) => `    .bind(${n})`) : ['    // bind what this statement needs'];
          lines.push(`sqlx::query(${upperSnake(s.slug)})`, ...binds, '    .execute(&pool)', '    .await?;');
        } else if (s.op === 'read') {
          // duckdb-rs holds the statement while the rows are read, so it has to
          // outlive the loop; sqlx hands back a Vec and does not.
          lines.push(`let mut ${s.slug} = conn.prepare(${upperSnake(s.slug)})?;`, `let mut rows = ${s.slug}.query([])?;`);
        } else {
          if (!s.params.length) lines.push('// bind what this statement needs');
          lines.push(`conn.execute(${upperSnake(s.slug)}, params![${s.params.join(', ')}])?;`);
        }
        return lines;
      },
      sqlx
        ? { base: '    ', step: '    ', loopOpen: 'for row in rows {', loopClose: '}' }
        : { base: '    ', step: '    ', loopOpen: 'while let Some(row) = rows.next()? {', loopClose: '}' },
    ),
  );
  out.push('');
  out.push('    Ok(())');
  out.push('}');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

function emitGo(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver): string {
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, p, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  out.push('');
  out.push('package main');
  out.push('');
  out.push('import (');
  // gofmt sorts an import block by path, so emit it sorted and save the reader
  // a diff on their first save.
  const imports = ['"log"', '"os"', ...driver.imports].sort((a, b) => {
    const path = (s: string) => s.slice(s.indexOf('"'));
    return path(a).localeCompare(path(b));
  });
  out.push(imports.map((i) => `\t${i}`).join('\n'));
  out.push(')');
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`// ${stepCaption(s)}`);
    out.push(`const ${camel(s.slug)}SQL = \`\n${s.sql}\n\``);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push(`// ${stepCaption(s)}`);
    out.push(`func ${camel(s.slug)}(rows *sql.Rows) error {`);
    out.push('\tpanic("the work this program exists to do")');
    out.push('}');
    out.push('');
  }

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
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`// ${stepCaption(s)}`];
        if (s.op === 'compute') lines.push(`if err := ${camel(s.slug)}(rows); err != nil {`, '\tlog.Fatal(err)', '}');
        else if (s.op === 'read')
          lines.push(`rows, err := db.Query(${camel(s.slug)}SQL)`, 'if err != nil {', '\tlog.Fatal(err)', '}', 'defer rows.Close()');
        else {
          const args = s.params.length ? `, ${s.params.join(', ')}` : '';
          if (!s.params.length) lines.push('// bind what this statement needs');
          lines.push(`if _, err := db.Exec(${camel(s.slug)}SQL${args}); err != nil {`, '\tlog.Fatal(err)', '}');
        }
        return lines;
      },
      { base: '\t', step: '\t', loopOpen: 'for rows.Next() {', loopClose: '}' },
    ),
  );
  out.push('}');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Java                                                                */
/* ------------------------------------------------------------------ */

function emitJava(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver): string {
  const cls = pascal(sanitize(p.name));
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, p, driver), '//'));
  out.push('//');
  out.push(`// Dependency: ${driver.install}`);
  out.push('');
  out.push(driver.imports.join('\n'));
  out.push('');
  out.push(`public class ${cls} {`);
  out.push(`    private static final String DSN = System.getenv().getOrDefault("DATABASE_URL", ${JSON.stringify(driver.dsn)});`);
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`    // ${stepCaption(s)}`);
    out.push(`    private static final String ${upperSnake(s.slug)} = """\n${indent(s.sql, '        ')}\n        """;`);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push(`    // ${stepCaption(s)}`);
    out.push(`    private static void ${camel(s.slug)}(ResultSet row) {`);
    out.push('        throw new UnsupportedOperationException("the work this program exists to do");');
    out.push('    }');
    out.push('');
  }

  out.push('    public static void main(String[] args) throws Exception {');
  out.push(`        try (Connection conn = ${driver.connect}) {`);
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`// ${stepCaption(s)}`];
        if (s.op === 'compute') lines.push(`${camel(s.slug)}(rows);`);
        else if (s.op === 'read')
          lines.push(
            `PreparedStatement ${camel(s.slug)} = conn.prepareStatement(${upperSnake(s.slug)});`,
            `ResultSet rows = ${camel(s.slug)}.executeQuery();`,
          );
        else {
          lines.push(`PreparedStatement ${camel(s.slug)} = conn.prepareStatement(${upperSnake(s.slug)});`);
          if (s.params.length) s.params.forEach((n, idx) => lines.push(`${camel(s.slug)}.setObject(${idx + 1}, ${n});`));
          else lines.push('// bind what this statement needs');
          lines.push(`${camel(s.slug)}.executeUpdate();`);
        }
        return lines;
      },
      { base: '            ', step: '    ', loopOpen: 'while (rows.next()) {', loopClose: '}' },
    ),
  );
  out.push('        }');
  out.push('    }');
  out.push('}');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* JavaScript and TypeScript                                           */
/* ------------------------------------------------------------------ */

/** How each Node driver spells "run this and give me the rows" and "run this". */
const NODE_CALLS: Partial<Record<DriverShape, { rows: (sql: string) => string; exec: (sql: string, args: string) => string }>> = {
  pg: {
    rows: (sql) => `const { rows } = await db.query(${sql});`,
    exec: (sql, args) => `await db.query(${sql}, [${args}]);`,
  },
  'mariadb-node': {
    // The MariaDB connector hands back the rows themselves, not a result object.
    rows: (sql) => `const rows = await db.query(${sql});`,
    exec: (sql, args) => `await db.query(${sql}, [${args}]);`,
  },
  'node-sqlite': {
    // node:sqlite is synchronous and statement-first: prepare, then all or run.
    rows: (sql) => `const rows = db.prepare(${sql}).all();`,
    exec: (sql, args) => `db.prepare(${sql}).run(${args});`,
  },
  'duckdb-node': {
    rows: (sql) => `const rows = await (await db.runAndReadAll(${sql})).getRowObjects();`,
    exec: (sql, args) => `await db.run(${sql}, [${args}]);`,
  },
};

function emitNode(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver, typed: boolean): string {
  const calls = NODE_CALLS[driver.shape] ?? NODE_CALLS.pg!;
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, p, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  out.push('');
  out.push(driver.imports.join('\n'));
  out.push('');
  out.push(`const DSN = process.env.DATABASE_URL ?? ${JSON.stringify(driver.dsn)};`);
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`// ${stepCaption(s)}`);
    out.push(`const ${camel(s.slug)}Sql = \`\n${s.sql}\n\`;`);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push(`/** ${stepCaption(s)} */`);
    out.push(`function ${camel(s.slug)}(row${typed ? ': Record<string, unknown>' : ''})${typed ? ': void' : ''} {`);
    out.push("  throw new Error('the work this program exists to do');");
    out.push('}');
    out.push('');
  }

  out.push(`async function main()${typed ? ': Promise<void>' : ''} {`);
  out.push(`  const db = ${driver.connect};`);
  out.push('');
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`// ${stepCaption(s)}`];
        const sql = `${camel(s.slug)}Sql`;
        if (s.op === 'compute') lines.push(`${camel(s.slug)}(row);`);
        else if (s.op === 'read') lines.push(calls.rows(sql));
        else {
          if (!s.params.length) lines.push('// bind what this statement needs');
          lines.push(calls.exec(sql, s.params.join(', ')));
        }
        return lines;
      },
      { base: '  ', step: '  ', loopOpen: 'for (const row of rows) {', loopClose: '}' },
    ),
  );
  out.push('}');
  out.push('');
  out.push('await main();');
  return out.join('\n') + '\n';
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
 * libpqxx. Writing that conversation out is the whole value of the generated
 * file here, and writing a comment saying "run READ_JOBS" instead, which is
 * what this used to do, is worth nothing to anybody.
 */
interface NativeShape {
  /** Headers the file needs beyond the driver's own. */
  extras: string[];
  /** Opening the connection, with `dsn` already in scope. */
  open: string[];
  /** Issuing a read, whose rows the loop below walks. */
  read: (s: ProgramCodeStep) => string[];
  /** Issuing a write. */
  write: (s: ProgramCodeStep) => string[];
  loopOpen: string;
  loopClose: string;
  /** Letting go of everything, in the order a reader would. */
  close: string[];
  /** How a compute stub is declared and called. */
  stub: (slug: string, caption: string) => string[];
  call: (slug: string) => string;
  /** Wrapping, for the languages that want a try block around the lot. */
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
    read: (s) => [`PGresult *rows = PQexec(conn, ${upperSnake(s.slug)});`],
    write: (s) => [
      `${s.params.length ? `const char *${s.slug}_values[${s.params.length}] = {${s.params.map((n) => `/* ${n} */ NULL`).join(', ')}};` : BIND}`,
      `PQclear(PQexecParams(conn, ${upperSnake(s.slug)}, ${s.params.length}, NULL, ${s.params.length ? `${s.slug}_values` : 'NULL'}, NULL, NULL, 0));`,
    ],
    loopOpen: 'for (int row = 0; row < PQntuples(rows); row++) {',
    loopClose: '}',
    close: ['PQclear(rows);', 'PQfinish(conn);'],
    stub: (slug, caption) => [`/* ${caption} */`, `static void ${slug}(PGresult *rows, int row) {`, '    fprintf(stderr, "not implemented\\n");', '}'],
    call: (slug) => `${slug}(rows, row);`,
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
    read: (s) => [`mysql_query(conn, ${upperSnake(s.slug)});`, 'MYSQL_RES *result = mysql_store_result(conn);', 'MYSQL_ROW row;'],
    write: (s) => [s.params.length ? `/* bind ${s.params.join(', ')} with mysql_stmt_bind_param */` : BIND, `mysql_query(conn, ${upperSnake(s.slug)});`],
    loopOpen: 'while ((row = mysql_fetch_row(result))) {',
    loopClose: '}',
    close: ['mysql_free_result(result);', 'mysql_close(conn);'],
    stub: (slug, caption) => [`/* ${caption} */`, `static void ${slug}(MYSQL_ROW row) {`, '    fprintf(stderr, "not implemented\\n");', '}'],
    call: (slug) => `${slug}(row);`,
  },
  'sqlite3-c': {
    extras: ['#include <stdio.h>', '#include <stdlib.h>'],
    open: ['sqlite3 *db;', 'if (sqlite3_open(dsn, &db) != SQLITE_OK) {', '    fprintf(stderr, "%s", sqlite3_errmsg(db));', '    return 1;', '}'],
    read: (s) => [`sqlite3_stmt *rows;`, `sqlite3_prepare_v2(db, ${upperSnake(s.slug)}, -1, &rows, NULL);`],
    write: (s) => [
      `sqlite3_stmt *${s.slug};`,
      `sqlite3_prepare_v2(db, ${upperSnake(s.slug)}, -1, &${s.slug}, NULL);`,
      ...(s.params.length ? s.params.map((n, i) => `/* sqlite3_bind_* (${s.slug}, ${i + 1}, ${n}); */`) : [BIND]),
      `sqlite3_step(${s.slug});`,
      `sqlite3_finalize(${s.slug});`,
    ],
    loopOpen: 'while (sqlite3_step(rows) == SQLITE_ROW) {',
    loopClose: '}',
    close: ['sqlite3_finalize(rows);', 'sqlite3_close(db);'],
    stub: (slug, caption) => [`/* ${caption} */`, `static void ${slug}(sqlite3_stmt *rows) {`, '    fprintf(stderr, "not implemented\\n");', '}'],
    call: (slug) => `${slug}(rows);`,
  },
  'duckdb-c': {
    extras: ['#include <stdio.h>', '#include <stdlib.h>'],
    open: [
      'duckdb_database db;',
      'duckdb_connection conn;',
      'if (duckdb_open(dsn, &db) == DuckDBError || duckdb_connect(db, &conn) == DuckDBError) {',
      '    fprintf(stderr, "could not open %s\\n", dsn);',
      '    return 1;',
      '}',
    ],
    read: (s) => ['duckdb_result rows;', `duckdb_query(conn, ${upperSnake(s.slug)}, &rows);`],
    write: (s) => [s.params.length ? `/* bind ${s.params.join(', ')} with duckdb_prepare and duckdb_bind_* */` : BIND, `duckdb_query(conn, ${upperSnake(s.slug)}, NULL);`],
    loopOpen: 'for (idx_t row = 0; row < duckdb_row_count(&rows); row++) {',
    loopClose: '}',
    close: ['duckdb_destroy_result(&rows);', 'duckdb_disconnect(&conn);', 'duckdb_close(&db);'],
    stub: (slug, caption) => [`/* ${caption} */`, `static void ${slug}(duckdb_result *rows, idx_t row) {`, '    fprintf(stderr, "not implemented\\n");', '}'],
    call: (slug) => `${slug}(&rows, row);`,
  },
};

const CPP_SHAPES: Partial<Record<DriverShape, NativeShape>> = {
  libpqxx: {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <stdexcept>', '#include <string>'],
    open: ['pqxx::connection conn{dsn};', 'pqxx::work tx{conn};'],
    read: (s) => [`pqxx::result rows = tx.exec(${upperSnake(s.slug)});`],
    write: (s) => [
      s.params.length
        ? `tx.exec_params(${upperSnake(s.slug)}, ${s.params.join(', ')});`
        : `// bind what this statement needs\ntx.exec_params(${upperSnake(s.slug)});`,
    ],
    loopOpen: 'for (const auto &row : rows) {',
    loopClose: '}',
    close: ['tx.commit();'],
    stub: (slug, caption) => [`/// ${caption}`, `static void ${slug}(const pqxx::row &row) {`, '    throw std::logic_error("the work this program exists to do");', '}'],
    call: (slug) => `${slug}(row);`,
    guard: { open: 'try {', close: ['} catch (const std::exception &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
  'mariadb-cpp': {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <memory>', '#include <stdexcept>'],
    open: [
      'std::unique_ptr<sql::Connection> conn{sql::mariadb::get_driver_instance()->connect(dsn, "root", "")};',
    ],
    read: (s) => [
      `std::unique_ptr<sql::PreparedStatement> ${s.slug}{conn->prepareStatement(${upperSnake(s.slug)})};`,
      `std::unique_ptr<sql::ResultSet> rows{${s.slug}->executeQuery()};`,
    ],
    write: (s) => [
      `std::unique_ptr<sql::PreparedStatement> ${s.slug}{conn->prepareStatement(${upperSnake(s.slug)})};`,
      ...(s.params.length ? s.params.map((n, i) => `${s.slug}->setString(${i + 1}, ${n});`) : ['// bind what this statement needs']),
      `${s.slug}->executeUpdate();`,
    ],
    loopOpen: 'while (rows->next()) {',
    loopClose: '}',
    close: ['conn->close();'],
    stub: (slug, caption) => [`/// ${caption}`, `static void ${slug}(sql::ResultSet &row) {`, '    throw std::logic_error("the work this program exists to do");', '}'],
    call: (slug) => `${slug}(*rows);`,
    guard: { open: 'try {', close: ['} catch (const sql::SQLException &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
  sqlitecpp: {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <stdexcept>'],
    open: ['SQLite::Database db{dsn, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE};'],
    read: (s) => [`SQLite::Statement rows{db, ${upperSnake(s.slug)}};`],
    write: (s) => [
      `SQLite::Statement ${s.slug}{db, ${upperSnake(s.slug)}};`,
      ...(s.params.length ? s.params.map((n, i) => `${s.slug}.bind(${i + 1}, ${n});`) : ['// bind what this statement needs']),
      `${s.slug}.exec();`,
    ],
    loopOpen: 'while (rows.executeStep()) {',
    loopClose: '}',
    close: [],
    stub: (slug, caption) => [`/// ${caption}`, `static void ${slug}(SQLite::Statement &row) {`, '    throw std::logic_error("the work this program exists to do");', '}'],
    call: (slug) => `${slug}(rows);`,
    guard: { open: 'try {', close: ['} catch (const std::exception &e) {', '    std::cerr << e.what() << "\\n";', '    return 1;', '}'] },
  },
  'duckdb-cpp': {
    extras: ['#include <cstdlib>', '#include <iostream>', '#include <memory>', '#include <stdexcept>'],
    open: ['duckdb::DuckDB database{dsn};', 'duckdb::Connection conn{database};'],
    read: (s) => [`auto rows = conn.Query(${upperSnake(s.slug)});`, 'if (rows->HasError()) {', '    std::cerr << rows->GetError() << "\\n";', '    return 1;', '}'],
    write: (s) => [
      s.params.length
        ? `conn.Query(${upperSnake(s.slug)}, ${s.params.join(', ')});`
        : `// bind what this statement needs\nconn.Query(${upperSnake(s.slug)});`,
    ],
    loopOpen: 'for (idx_t row = 0; row < rows->RowCount(); row++) {',
    loopClose: '}',
    close: [],
    stub: (slug, caption) => [`/// ${caption}`, `static void ${slug}(duckdb::MaterializedQueryResult &rows, idx_t row) {`, '    throw std::logic_error("the work this program exists to do");', '}'],
    call: (slug) => `${slug}(*rows, row);`,
  },
};

function emitNative(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver, cpp: boolean): string {
  const shape = (cpp ? CPP_SHAPES : C_SHAPES)[driver.shape];
  if (!shape) return emitOutline(d, p, steps);
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, p, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  out.push('');
  out.push([...shape.extras, ...driver.imports].join('\n'));
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`// ${stepCaption(s)}`);
    // C has no raw strings before C++11's R"(…)", and one literal per line
    // reads the way the SQL was written either way.
    const literal = s.sql
      .split('\n')
      .map((l) => `    "${l.replace(/"/g, '\\"')} "`)
      .join('\n');
    out.push(`static const char *${upperSnake(s.slug)} =\n${literal};`);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push(...shape.stub(s.slug, stepCaption(s)));
    out.push('');
  }

  const guard = shape.guard;
  // C spells an empty parameter list `(void)` and C++ does not, and a reader
  // of either notices the other one's.
  out.push(cpp ? 'int main() {' : 'int main(void) {');
  out.push('    const char *dsn = getenv("DATABASE_URL");');
  out.push(`    if (!dsn) dsn = ${JSON.stringify(driver.dsn)};`);
  if (guard) out.push(`    ${guard.open}`);
  const pad = guard ? '        ' : '    ';
  out.push(indent(shape.open.join('\n'), pad));
  out.push('');
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`// ${stepCaption(s)}`];
        if (s.op === 'compute') lines.push(shape.call(s.slug));
        else lines.push(...(s.op === 'read' ? shape.read(s) : shape.write(s)));
        return lines;
      },
      { base: pad, step: '    ', loopOpen: shape.loopOpen, loopClose: shape.loopClose },
    ),
  );
  if (shape.close.length) {
    out.push('');
    out.push(indent(shape.close.join('\n'), pad));
  }
  if (guard) out.push(...guard.close.map((l) => `    ${l}`));
  out.push('');
  out.push('    return 0;');
  out.push('}');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* The fallback                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a language with no driver template gets: the same steps, the same SQL,
 * in that language's comment syntax. Useless as a program and honest about it,
 * which beats emitting Python under a C# heading.
 */
function emitOutline(d: Diagram, p: Program, steps: ProgramCodeStep[]): string {
  const marker = programLanguageMeta(p.language).comment;
  const out: string[] = [commentBlock(headerLines(d, p, undefined), marker), ''];
  out.push(commentBlock([`No driver template exists for ${programLanguageMeta(p.language).label} on ${d.dialect} yet,`, 'so this is the plan rather than the program.'], marker));
  out.push('');
  for (const s of steps) {
    out.push(commentBlock([stepCaption(s)], marker));
    if (s.sql) out.push(commentBlock(s.sql.split('\n'), marker));
    out.push('');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** The starter for a program, in its own language, against the diagram's engine. */
export function generateProgramCode(d: Diagram, p: Program): string {
  const driver = driverFor(p.language, d.dialect);
  const steps = resolveSteps(d, p, driver);
  if (!driver) return emitOutline(d, p, steps);
  switch (p.language) {
    case 'python':
      return emitPython(d, p, steps, driver);
    case 'rust':
      return emitRust(d, p, steps, driver);
    case 'go':
      return emitGo(d, p, steps, driver);
    case 'java':
      return emitJava(d, p, steps, driver);
    case 'javascript':
      return emitNode(d, p, steps, driver, false);
    case 'typescript':
      return emitNode(d, p, steps, driver, true);
    case 'c':
      return emitNative(d, p, steps, driver, false);
    case 'cpp':
      return emitNative(d, p, steps, driver, true);
    default:
      return emitOutline(d, p, steps);
  }
}

/** Filename a saved starter gets, e.g. "ingest_worker.py". */
export function programCodeFilename(p: Program): string {
  return `${sanitize(p.name)}.${programLanguageMeta(p.language).extension}`;
}

export { hasDriver };
