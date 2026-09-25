/**
 * Stored procedures and functions: a code node that lives in the database.
 *
 * The same few routines are pushed through every path the app has for them —
 * generated DDL per engine, the DDL read back, a live PostgreSQL (PGlite) that
 * runs the DDL and reports it through the server's own catalog query, a
 * migration against that report, the linter, the file format and the code
 * starter of a function that calls one — so the paths cannot drift apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Diagram, IntrospectResponse, Program } from '../src/shared/types';
import { canStepName, stepOpsForKind } from '../src/shared/types';
import { parseRoutineParams } from '../src/shared/routines';
import { createColumn, createProgram, createProgramStep, createTable, emptyDiagram } from '../src/lib/model';
import {
  bodyFromSteps,
  createProcedureParam,
  dropProcedureStatement,
  procedureDdl,
  procedureSignature,
  proceduresFromRoutines,
  stepsFromBody,
} from '../src/lib/procedures';
import { generateDropStatements, generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { parseSql, undoDelimiters } from '../src/lib/sql/parser';
import { introspectionToDiagram } from '../src/lib/introspectImport';
import { diagramEmphasis, describeContents } from '../src/lib/emphasis';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { lintDiagram } from '../src/lib/lint';
import { diffDiagramAgainst } from '../src/lib/migrate/diff';
import { generateMigration } from '../src/lib/migrate/alter';
import { generateProgramCode } from '../src/lib/code/generate';
import { generateMarkdown } from '../src/lib/markdownExport';
import { programLinks } from '../src/lib/programs';
import { INTROSPECT_QUERIES, routineFromRow } from '../server/db/postgres';

/** Orders, an archive, and a procedure that moves one into the other. */
function shop(dialect: Diagram['dialect'] = 'postgresql'): { d: Diagram; archive: Program; total: Program } {
  const d = emptyDiagram(dialect, 'Shop');
  const orders = createTable({
    name: 'orders',
    columns: [
      createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }),
      createColumn({ name: 'placed_at', type: 'DATE' }),
      createColumn({ name: 'total_cents', type: 'INTEGER' }),
    ],
  });
  const archived = createTable({
    name: 'orders_archive',
    columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'placed_at', type: 'DATE' })],
  });
  d.tables.push(orders, archived);
  const archive = createProgram({
    name: 'archive_orders',
    kind: 'procedure',
    language: 'other',
    params: [createProcedureParam({ name: 'cutoff', type: 'DATE' })],
    comment: 'Moves orders placed before the cutoff into the archive.',
    steps: [
      createProgramStep({ op: 'read', tableId: orders.id, columnIds: [orders.columns[0].id, orders.columns[1].id] }),
      createProgramStep({ op: 'write', tableId: archived.id, sql: 'INSERT INTO orders_archive (id, placed_at) SELECT id, placed_at FROM orders WHERE placed_at < cutoff' }),
      createProgramStep({ op: 'write', tableId: orders.id, sql: 'DELETE FROM orders WHERE placed_at < cutoff' }),
    ],
  });
  const total = createProgram({
    name: 'order_total',
    kind: 'procedure',
    language: 'other',
    params: [createProcedureParam({ name: 'p_id', type: 'INTEGER' })],
    returns: 'INTEGER',
    routineLanguage: 'sql',
    body: 'SELECT total_cents FROM orders WHERE id = p_id;',
    steps: [createProgramStep({ op: 'read', tableId: orders.id, sql: 'SELECT total_cents FROM orders WHERE id = p_id' })],
  });
  d.programs.push(archive, total);
  return { d, archive, total };
}

describe('the model', () => {
  it('lets a procedure read, write, work and call other routines, and nothing else', () => {
    expect(stepOpsForKind('procedure')).toEqual(['read', 'write', 'compute', 'call']);
    expect(canStepName('call', 'procedure', 'procedure')).toBe(true);
    expect(canStepName('call', 'function', 'procedure')).toBe(false);
    // Code outside the database calls a procedure, and does nothing else to one.
    expect(canStepName('call', 'procedure', 'function')).toBe(true);
    expect(canStepName('import', 'procedure', 'module')).toBe(false);
  });

  it('draws the arrows to tables from the steps, like any other code node', () => {
    const { d, archive } = shop();
    const links = programLinks(d).filter((l) => l.programId === archive.id);
    expect(links.map((l) => l.op)).toEqual(['read', 'write', 'write']);
  });

  it('counts as the schema half of the diagram, not the code map', () => {
    const d = emptyDiagram('postgresql');
    d.programs.push(createProgram({ name: 'p', kind: 'procedure', language: 'other' }));
    expect(diagramEmphasis(d)).toBe('data');
    d.programs.push(createProgram({ name: 'worker', language: 'python' }));
    expect(diagramEmphasis(d)).toBe('both');
    expect(describeContents(d)).toBe('1 procedure and 1 code node');
  });

  it('writes a signature a reader can scan', () => {
    const { archive, total } = shop();
    expect(procedureSignature(archive)).toBe('archive_orders(cutoff DATE)');
    expect(procedureSignature(total)).toBe('order_total(p_id INTEGER) → INTEGER');
  });
});

describe('the generated DDL', () => {
  it('creates procedures after the tables on PostgreSQL, with the body in dollar quotes', () => {
    const { d } = shop();
    const g = generateSchema(d);
    const create = g.statements.find((s) => s.startsWith('CREATE OR REPLACE PROCEDURE'))!;
    expect(create).toContain('CREATE OR REPLACE PROCEDURE archive_orders(cutoff DATE)\nLANGUAGE plpgsql\nAS $$\nBEGIN');
    expect(create).toContain('INSERT INTO orders_archive (id, placed_at) SELECT id, placed_at FROM orders WHERE placed_at < cutoff;');
    expect(create).toContain('-- SELECT id, placed_at FROM orders;');
    expect(create.endsWith('END;\n$$;')).toBe(true);
    expect(g.statements).toContain("COMMENT ON PROCEDURE archive_orders(IN DATE) IS 'Moves orders placed before the cutoff into the archive.';");
    const fn = g.statements.find((s) => s.includes('FUNCTION order_total'))!;
    expect(fn).toBe('CREATE OR REPLACE FUNCTION order_total(p_id INTEGER)\nRETURNS INTEGER\nLANGUAGE sql\nAS $$\nSELECT total_cents FROM orders WHERE id = p_id;\n$$;');
    // After every CREATE TABLE.
    expect(g.statements.findIndex((s) => s.includes('PROCEDURE'))).toBeGreaterThan(g.statements.findIndex((s) => s.includes('CREATE TABLE orders_archive')));
    expect(g.script).toContain('-- Procedures');
    expect(g.warnings).toEqual([]);
  });

  it('picks a dollar-quote tag the body does not contain', () => {
    const d = emptyDiagram('postgresql');
    const p = createProgram({ name: 'quoted', kind: 'procedure', language: 'other', body: "BEGIN\n  RAISE NOTICE '$$';\nEND;" });
    d.programs.push(p);
    const { statements } = procedureDdl(d, p);
    expect(statements[0]).toContain('AS $body$\n');
    expect(statements[0].endsWith('$body$;')).toBe(true);
  });

  it('writes MariaDB with modes, a COMMENT characteristic, and DELIMITER only in the script', () => {
    const { d, archive } = shop('mariadb');
    archive.params![0].mode = 'in';
    archive.params!.push(createProcedureParam({ name: 'moved', type: 'INT', mode: 'out' }));
    const ddl = procedureDdl(d, archive);
    expect(ddl.statements).toHaveLength(1);
    expect(ddl.statements[0].startsWith("CREATE OR REPLACE PROCEDURE archive_orders(IN cutoff DATE, OUT moved INT)\nCOMMENT 'Moves orders placed before the cutoff into the archive.'\nBEGIN")).toBe(true);
    expect(ddl.statements[0]).not.toContain('DELIMITER');
    expect(ddl.script.startsWith('DELIMITER //\n')).toBe(true);
    expect(ddl.script.endsWith('END //\nDELIMITER ;')).toBe(true);
  });

  it('ends a MariaDB statement once, however the body was typed', () => {
    const d = emptyDiagram('mariadb');
    const p = createProgram({ name: 'p', kind: 'procedure', language: 'other', body: 'BEGIN\n  SELECT 1;\nEND;\n' });
    const ddl = procedureDdl(d, p);
    expect(ddl.statements[0].endsWith('END;')).toBe(true);
    expect(ddl.statements[0]).not.toContain(';;');
    expect(ddl.script).toContain('END //');
  });

  it('says what MariaDB cannot do rather than writing it', () => {
    const d = emptyDiagram('mariadb');
    const p = createProgram({
      name: 'f',
      kind: 'procedure',
      language: 'other',
      returns: 'INT',
      params: [createProcedureParam({ name: 'x', type: 'INT', mode: 'out', defaultValue: '1' })],
      body: 'RETURN 1',
    });
    const warnings: string[] = [];
    const ddl = procedureDdl(d, p, warnings);
    expect(ddl.statements[0]).toBe('CREATE OR REPLACE FUNCTION f(x INT)\nRETURNS INT\nRETURN 1;');
    expect(warnings).toHaveLength(2);
  });

  it('documents a procedure on an engine that has none, and runs nothing', () => {
    const { d } = shop('sqlite');
    const g = generateSchema(d);
    expect(g.statements.some((s) => /PROCEDURE|FUNCTION/.test(s))).toBe(false);
    expect(g.script).toContain('-- procedure archive_orders(cutoff DATE) (SQLite cannot create it)');
    expect(g.warnings.filter((w) => w.includes('no stored procedures'))).toHaveLength(2);
  });

  it('drops procedures before the tables they read', () => {
    const { d } = shop();
    const drops = generateDropStatements(d);
    expect(drops.slice(0, 2)).toEqual(['DROP FUNCTION IF EXISTS order_total(IN INTEGER);', 'DROP PROCEDURE IF EXISTS archive_orders(IN DATE);']);
    expect(dropProcedureStatement({ name: 'p', params: [] }, 'sqlite')).toBeNull();
  });

  it('writes an empty BEGIN … END for a procedure with nothing in it, which both engines accept', () => {
    const d = emptyDiagram('postgresql');
    const p = createProgram({ name: 'noop', kind: 'procedure', language: 'other' });
    expect(bodyFromSteps(d, p)).toBe('BEGIN\nEND;');
    expect(bodyFromSteps(d, p, 'mariadb')).toBe('BEGIN\nEND');
  });

  it('writes a CALL for a call step, and leaves one that needs arguments as a comment', () => {
    const { d, archive } = shop();
    const noop = createProgram({ name: 'refresh_stats', kind: 'procedure', language: 'other' });
    d.programs.push(noop);
    const caller = createProgram({
      name: 'nightly',
      kind: 'procedure',
      language: 'other',
      steps: [createProgramStep({ op: 'call', codeId: noop.id }), createProgramStep({ op: 'call', codeId: archive.id })],
    });
    d.programs.push(caller);
    const body = bodyFromSteps(d, caller);
    expect(body).toContain('\n  CALL refresh_stats();');
    expect(body).toContain('\n  -- CALL archive_orders(cutoff);');
  });
});

describe('reading DDL back', () => {
  it('reads a PostgreSQL function and procedure, dollar quotes and all', () => {
    const res = parseSql(
      `CREATE TABLE orders (id int PRIMARY KEY, total_cents int);
       CREATE OR REPLACE FUNCTION public.order_total(p_id integer, OUT cents integer, INOUT note text DEFAULT 'x')
         RETURNS integer LANGUAGE sql STABLE RETURNS NULL ON NULL INPUT COST 10
         AS $fn$ SELECT total_cents FROM orders WHERE id = p_id; $fn$;
       CREATE PROCEDURE bump() LANGUAGE plpgsql AS $$
       BEGIN
         UPDATE orders SET total_cents = total_cents + 1;
       END;
       $$;
       COMMENT ON PROCEDURE bump() IS 'Adds a cent';`,
      'postgresql',
    );
    expect(res.errors).toEqual([]);
    expect(res.routines).toHaveLength(2);
    const [fn, proc] = res.routines!;
    expect(fn).toMatchObject({ schema: 'public', name: 'order_total', kind: 'function', returns: 'integer', language: 'sql', body: ' SELECT total_cents FROM orders WHERE id = p_id; ' });
    expect(fn.params).toEqual([
      { name: 'p_id', type: 'integer' },
      { name: 'cents', type: 'integer', mode: 'out' },
      { name: 'note', type: 'text', mode: 'inout', defaultValue: "'x'" },
    ]);
    expect(proc).toMatchObject({ name: 'bump', kind: 'procedure', language: 'plpgsql', comment: 'Adds a cent' });
    expect(proc.body).toContain('UPDATE orders SET total_cents = total_cents + 1;');
  });

  it('reads a MariaDB script written for the command-line client, DELIMITER and nested blocks included', () => {
    const script = `CREATE TABLE orders (id INT PRIMARY KEY, status VARCHAR(20));
CREATE TABLE audit (id INT PRIMARY KEY, n INT);
DELIMITER //
CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE close_orders(IN p_status VARCHAR(20), OUT p_n INT)
  COMMENT 'Closes them'
  MODIFIES SQL DATA
main: BEGIN
  DECLARE done INT DEFAULT 0;
  IF p_status = 'x' THEN
    LEAVE main;
  END IF;
  SELECT COUNT(*) INTO p_n FROM orders WHERE status = p_status;
  UPDATE orders SET status = CASE WHEN status = p_status THEN 'closed' ELSE status END;
  BEGIN
    INSERT INTO audit (id, n) VALUES (1, p_n);
  END;
END main //
CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC RETURN x * 2 //
DELIMITER ;
CREATE TABLE after_it (id INT PRIMARY KEY);`;
    const res = parseSql(script, 'mariadb');
    expect(res.errors).toEqual([]);
    expect(res.tables.map((t) => t.name)).toEqual(['orders', 'audit', 'after_it']);
    expect(res.routines!.map((r) => r.name)).toEqual(['close_orders', 'twice']);
    const [close, twice] = res.routines!;
    expect(close.params).toEqual([
      { name: 'p_status', type: 'VARCHAR(20)' },
      { name: 'p_n', type: 'INT', mode: 'out' },
    ]);
    expect(close.comment).toBe('Closes them');
    expect(close.language).toBeUndefined();
    expect(close.body.startsWith('main: BEGIN')).toBe(true);
    expect(close.body.endsWith('END main')).toBe(true);
    expect(twice).toMatchObject({ kind: 'function', returns: 'INT', body: 'RETURN x * 2' });
  });

  it('keeps every line where it was when it undoes DELIMITER', () => {
    const script = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END $$\nDELIMITER ;\nCREATE TABLE t (id INT, x TEXT DEFAULT \'$$\');';
    const out = undoDelimiters(script);
    expect(out.length).toBe(script.length);
    expect(out.split('\n').length).toBe(script.split('\n').length);
    expect(out).toContain("DEFAULT '$$'");
    expect(out).toContain('END ; ');
    expect(undoDelimiters('SELECT 1;')).toBe('SELECT 1;');
  });

  it('reads the steps a body implies: reads before writes, one per table, calls to known routines', () => {
    const { d } = shop();
    const byName = (n: string) => d.tables.find((t) => t.name === n);
    const other = createProgram({ name: 'refresh_stats', kind: 'procedure', language: 'other' });
    const steps = stepsFromBody(
      `DECLARE n int;
       BEGIN
         SELECT count(*) INTO n FROM orders WHERE placed_at < now();
         IF n > 0 THEN
           INSERT INTO orders_archive SELECT id, placed_at FROM orders;
         END IF;
         CALL refresh_stats();
         CALL somebody_elses();
         UPDATE temp_table SET x = 1;
       END;`,
      byName,
      (n) => (n === 'refresh_stats' ? other : undefined),
    );
    expect(steps.map((s) => `${s.op} ${s.tableId ? byName('orders')!.id === s.tableId ? 'orders' : 'orders_archive' : s.codeId === other.id ? 'refresh_stats' : '?'}`)).toEqual([
      'read orders',
      'read orders',
      'write orders_archive',
      'call refresh_stats',
    ]);
    expect(steps[0].sql).toBe('SELECT count(*) INTO n FROM orders WHERE placed_at < now()');
    expect(steps[2].sql).toBe('INSERT INTO orders_archive SELECT id, placed_at FROM orders');
  });

  it('brings a PostgreSQL script home whole: tables, procedures, and the steps someone drew', () => {
    const { d, archive } = shop();
    archive.steps[0].note = 'find the old ones';
    const script = generateSchema(d).script;
    const back = importSql(script, 'postgresql');
    expect(back.errors).toEqual([]);
    const procedures = back.programs.filter((p) => p.kind === 'procedure');
    expect(procedures.map((p) => p.name)).toEqual(['archive_orders', 'order_total']);
    const a = procedures[0];
    expect(a.params).toMatchObject([{ name: 'cutoff', type: 'DATE' }]);
    expect(a.comment).toBe(archive.comment);
    // The annotated steps win over the ones the body would have implied.
    expect(a.steps.map((s) => s.op)).toEqual(['read', 'write', 'write']);
    expect(a.steps[0].note).toBe('find the old ones');
    // The body is what the DDL created, so exporting it again changes nothing.
    const again = { ...emptyDiagram('postgresql'), tables: back.tables, programs: back.programs };
    expect(generateSchema(again).statements.filter((s) => /PROCEDURE|FUNCTION/.test(s))).toEqual(generateSchema(d).statements.filter((s) => /PROCEDURE|FUNCTION/.test(s)));
    const f = procedures[1];
    expect(f).toMatchObject({ returns: 'INTEGER', routineLanguage: 'sql', body: 'SELECT total_cents FROM orders WHERE id = p_id;' });
  });

  it('brings a MariaDB script home through its DELIMITER lines', () => {
    const { d } = shop('mariadb');
    const back = importSql(generateSchema(d).script, 'mariadb');
    expect(back.errors).toEqual([]);
    expect(back.programs.filter((p) => p.kind === 'procedure').map((p) => [p.name, p.returns ?? null])).toEqual([
      ['archive_orders', null],
      ['order_total', 'INTEGER'],
    ]);
  });

  it('keeps a procedure on SQLite in the annotation block, body and all, since the DDL cannot carry it', () => {
    const { d, total } = shop('sqlite');
    const back = importSql(generateSchema(d).script, 'sqlite');
    const f = back.programs.find((p) => p.name === 'order_total')!;
    expect(f).toMatchObject({ kind: 'procedure', returns: 'INTEGER', body: total.body, routineLanguage: 'sql' });
    expect(f.params).toMatchObject([{ name: 'p_id', type: 'INTEGER' }]);
  });

  it('turns a plain CREATE PROCEDURE into a node whose steps come from its body', () => {
    const back = importSql(
      `CREATE TABLE jobs (id int PRIMARY KEY, state text);
       CREATE PROCEDURE reset_jobs() LANGUAGE sql AS $$ UPDATE jobs SET state = 'queued'; $$;`,
      'postgresql',
    );
    const p = back.programs.find((x) => x.name === 'reset_jobs')!;
    expect(p.kind).toBe('procedure');
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ op: 'write', tableId: back.tables[0].id, sql: "UPDATE jobs SET state = 'queued'" });
  });

  it('splits the parameter text PostgreSQL reports', () => {
    expect(parseRoutineParams('integer, double precision, "Weird Name" text, VARIADIC xs int[]', true)).toEqual([
      { name: 'arg1', type: 'integer' },
      { name: 'arg2', type: 'double precision' },
      { name: 'Weird Name', type: 'text' },
      { name: 'xs', type: 'int[]' },
    ]);
  });
});

describe('the rest of the app', () => {
  it('saves and loads every field, and drops what does not belong', () => {
    const { d } = shop();
    const module = createProgram({ name: 'orders.py', kind: 'module', language: 'python', body: 'x', returns: 'int' } as Partial<Program>);
    d.programs.push(module);
    d.programs[0].parentId = module.id;
    const back = parseDiagramFile(serializeDiagram(d));
    const archive = back.programs.find((p) => p.name === 'archive_orders')!;
    expect(archive.parentId).toBeUndefined();
    expect(archive.params).toEqual(d.programs[0].params);
    expect(archive.language).toBe('other');
    const total = back.programs.find((p) => p.name === 'order_total')!;
    expect(total).toMatchObject({ returns: 'INTEGER', routineLanguage: 'sql', body: 'SELECT total_cents FROM orders WHERE id = p_id;' });
    const m = back.programs.find((p) => p.name === 'orders.py')!;
    expect(m.body).toBeUndefined();
    expect(m.returns).toBeUndefined();
  });

  it('lints what a procedure cannot be', () => {
    const { d, archive } = shop('sqlite');
    const helper = createProgram({ name: 'helper', kind: 'function', language: 'python' });
    d.programs.push(helper);
    archive.steps.push(createProgramStep({ op: 'call', codeId: helper.id }));
    // A program may share a procedure's name: they live in different places.
    d.programs.push(createProgram({ name: 'archive_orders', language: 'python' }));
    const rules = lintDiagram(d).map((f) => f.rule);
    expect(rules.filter((r) => r === 'procedure-unsupported')).toHaveLength(2);
    expect(rules).toContain('procedure-step-mismatch');
    expect(rules).not.toContain('duplicate-program-name');
    const imports = createProgram({ name: 'caller', kind: 'function', language: 'python', steps: [createProgramStep({ op: 'import', codeId: archive.id })] });
    d.programs.push(imports);
    const finding = lintDiagram(d).find((f) => f.rule === 'procedure-step-mismatch' && f.programId === imports.id)!;
    expect(finding.message).toContain('only ever called');
  });

  it('gives a function that calls a procedure a CALL through its driver, not a stub', () => {
    const { d, archive } = shop();
    const job = createProgram({ name: 'nightly', language: 'python', steps: [createProgramStep({ op: 'call', codeId: archive.id })] });
    d.programs.push(job);
    const code = generateProgramCode(d, job);
    expect(code).toContain('CALL archive_orders(%s)');
    expect(code).toContain('cur.execute(CALL_ARCHIVE_ORDERS, (cutoff,))');
    expect(code).not.toContain('NotImplementedError');
  });

  it('lists procedures in the Markdown data dictionary with their body', () => {
    const { d } = shop();
    const md = generateMarkdown(d);
    expect(md).toContain('## Procedures');
    expect(md).toContain('`order_total(p_id INTEGER) → INTEGER` · function');
    expect(md).not.toContain('## Code');
  });

  it('reads the steps of every routine in a batch, calls between them included', () => {
    const [a, b] = proceduresFromRoutines(
      [
        { name: 'a', kind: 'procedure', params: [], body: 'BEGIN CALL b(); END;' },
        { name: 'b', kind: 'procedure', params: [], body: 'BEGIN END;' },
      ],
      () => undefined,
    );
    expect(a.steps).toMatchObject([{ op: 'call', codeId: b.id, code: 'CALL b();' }]);
  });
});

describe('against a live PostgreSQL', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    const { d } = shop();
    for (const s of generateSchema(d).statements) await db.exec(s);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('creates what the script says, and the procedure runs', async () => {
    await db.exec(`INSERT INTO orders VALUES (1, '2020-01-01', 500), (2, '2030-01-01', 700)`);
    await db.exec(`CALL archive_orders('2025-01-01')`);
    expect((await db.query('SELECT id FROM orders_archive')).rows).toEqual([{ id: 1 }]);
    expect((await db.query('SELECT id FROM orders')).rows).toEqual([{ id: 2 }]);
    expect((await db.query('SELECT order_total(2) AS t')).rows).toEqual([{ t: 700 }]);
  });

  it('reads the routines back with the server query, and a migration finds nothing to do', async () => {
    const rows = (await db.query<Parameters<typeof routineFromRow>[0]>(INTROSPECT_QUERIES.routines)).rows;
    const routines = rows.map(routineFromRow);
    expect(routines.map((r) => [r.name, r.kind])).toEqual([
      ['archive_orders', 'procedure'],
      ['order_total', 'function'],
    ]);
    expect(routines[0].params).toEqual([{ name: 'cutoff', type: 'date' }]);
    expect(routines[0].comment).toBe('Moves orders placed before the cutoff into the archive.');
    expect(routines[1]).toMatchObject({ returns: 'integer', language: 'sql' });

    const res: IntrospectResponse = { serverVersion: 'pglite', tables: [], routines };
    const { d } = shop();
    const { changes } = diffDiagramAgainst(d, res);
    expect(changes.filter((c) => c.group.startsWith('routine:'))).toEqual([]);

    // And the database read into a diagram draws the procedure's steps from its body.
    const imported = introspectionToDiagram(res, 'postgresql', d);
    const archive = imported.programs.find((p) => p.name === 'archive_orders')!;
    expect(archive.steps.map((s) => s.op)).toEqual(['read', 'write', 'write']);
  });

  it('replaces a changed body in place and recreates a changed signature', async () => {
    const rows = (await db.query<Parameters<typeof routineFromRow>[0]>(INTROSPECT_QUERIES.routines)).rows;
    const res: IntrospectResponse = { serverVersion: 'pglite', tables: [], routines: rows.map(routineFromRow) };
    const { d, archive, total } = shop();
    archive.steps.pop();
    total.params!.push(createProcedureParam({ name: 'p_extra', type: 'INTEGER', defaultValue: '0' }));
    d.programs.push(createProgram({ name: 'brand_new', kind: 'procedure', language: 'other' }));
    const { changes, current } = diffDiagramAgainst(d, res);
    const routineChanges = changes.filter((c) => c.group.startsWith('routine:'));
    expect(routineChanges.map((c) => [c.op.kind, c.risk])).toEqual([
      ['replace-routine', 'safe'],
      ['replace-routine', 'risky'],
      ['create-routine', 'safe'],
    ]);
    const migration = generateMigration(d, routineChanges, current);
    expect(migration.statements[0]).toBe('DROP FUNCTION IF EXISTS public.order_total(IN integer);');
    for (const s of migration.statements) await db.exec(s);
    expect((await db.query('SELECT order_total(2, 0) AS t')).rows).toEqual([{ t: 700 }]);
    const after = (await db.query<Parameters<typeof routineFromRow>[0]>(INTROSPECT_QUERIES.routines)).rows.map(routineFromRow);
    expect(diffDiagramAgainst(d, { serverVersion: 'pglite', tables: [], routines: after }).changes.filter((c) => c.group.startsWith('routine:'))).toEqual([]);

    // A procedure the diagram no longer has is dropped, and never by default.
    const without = shop().d;
    without.programs = without.programs.filter((p) => p.name !== 'archive_orders');
    const dropped = diffDiagramAgainst(without, { serverVersion: 'pglite', tables: [], routines: after }).changes.find((c) => c.op.kind === 'drop-routine' && c.op.routine.name === 'archive_orders')!;
    expect(dropped.defaultOn).toBe(false);
  });
});
