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
import { driverFor, hasDriver, type Driver } from './drivers';

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
  return p.steps.map((s, i) => {
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
    // Generic over the row type so the stub compiles whichever sqlx driver the
    // dialect picked, rather than naming PgRow and breaking on MySQL.
    out.push(`fn ${s.slug}<R: sqlx::Row>(row: &R) -> anyhow::Result<()> {`);
    out.push('    todo!("the work this program exists to do")');
    out.push('}');
    out.push('');
  }

  out.push('#[tokio::main]');
  out.push('async fn main() -> anyhow::Result<()> {');
  out.push(`    let dsn = std::env::var("DATABASE_URL").unwrap_or_else(|_| ${JSON.stringify(driver.dsn)}.into());`);
  out.push(`    let pool = ${driver.connect};`);
  out.push('');
  out.push(
    buildBody(
      steps,
      (s) => {
        const lines = [`// ${stepCaption(s)}`];
        if (s.op === 'compute') lines.push(`${s.slug}(&row)?;`);
        else if (s.op === 'read') lines.push(`let rows = sqlx::query(${upperSnake(s.slug)}).fetch_all(&pool).await?;`);
        else {
          const binds = s.params.length ? s.params.map((n) => `    .bind(${n})`) : ['    // bind what this statement needs'];
          lines.push(`sqlx::query(${upperSnake(s.slug)})`, ...binds, '    .execute(&pool)', '    .await?;');
        }
        return lines;
      },
      { base: '    ', step: '    ', loopOpen: 'for row in rows {', loopClose: '}' },
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

function emitNode(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver, typed: boolean): string {
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
        if (s.op === 'compute') lines.push(`${camel(s.slug)}(row);`);
        else if (s.op === 'read') lines.push(`const { rows } = await db.query(${camel(s.slug)}Sql);`);
        else {
          if (!s.params.length) lines.push('// bind what this statement needs');
          lines.push(`await db.query(${camel(s.slug)}Sql, [${s.params.join(', ')}]);`);
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

function emitC(d: Diagram, p: Program, steps: ProgramCodeStep[], driver: Driver, cpp: boolean): string {
  const out: string[] = [];
  out.push(commentBlock(headerLines(d, p, driver), '//'));
  out.push('//');
  out.push(`// ${driver.install}`);
  out.push('');
  out.push(cpp ? '#include <iostream>\n#include <string>' : '#include <stdio.h>\n#include <stdlib.h>');
  out.push(driver.imports.join('\n'));
  out.push('');

  for (const s of sqlSteps(steps)) {
    out.push(`// ${stepCaption(s)}`);
    // One string literal per line keeps the SQL readable in C, where there are
    // no raw strings before C++11's R"(...)".
    const literal = s.sql
      .split('\n')
      .map((l) => `    "${l.replace(/"/g, '\\"')} "`)
      .join('\n');
    out.push(`static const char *${upperSnake(s.slug)} =\n${literal};`);
    out.push('');
  }

  for (const s of steps.filter((x) => x.op === 'compute')) {
    out.push(`// ${stepCaption(s)}`);
    out.push(`static void ${s.slug}(void) {`);
    out.push(`    ${cpp ? 'std::cerr << "not implemented\\n";' : 'fprintf(stderr, "not implemented\\n");'}`);
    out.push('}');
    out.push('');
  }

  out.push('int main(void) {');
  out.push(`    const char *dsn = getenv("DATABASE_URL");`);
  out.push(`    if (!dsn) dsn = ${JSON.stringify(driver.dsn)};`);
  out.push(`    // Connect: ${driver.connect}`);
  out.push('');
  for (const s of steps) {
    out.push(`    // ${stepCaption(s)}`);
    if (s.op === 'compute') out.push(`    ${s.slug}();`);
    else out.push(`    // run ${upperSnake(s.slug)}${s.params.length ? ` binding ${s.params.join(', ')}` : ''}`);
  }
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
      return emitC(d, p, steps, driver, false);
    case 'cpp':
      return emitC(d, p, steps, driver, true);
    default:
      return emitOutline(d, p, steps);
  }
}

/** Filename a saved starter gets, e.g. "ingest_worker.py". */
export function programCodeFilename(p: Program): string {
  return `${sanitize(p.name)}.${programLanguageMeta(p.language).extension}`;
}

export { hasDriver };
