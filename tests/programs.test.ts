import { describe, expect, it } from 'vitest';
import type { Diagram, Program } from '../src/shared/types';
import {
  createColumn,
  createProgram,
  createProgramStep,
  createRelationship,
  createTable,
  emptyDiagram,
  pruneRelationships,
  uniqueProgramName,
} from '../src/lib/model';
import { describeProgram, describeStep, programLinks, programRoundTrips, programTableIds, programsForTable } from '../src/lib/programs';
import { generateProgramCode, resolveSteps } from '../src/lib/code/generate';
import { layoutDiagram } from '../src/lib/layout';
import { decodeDiagramFromUrl, encodeDiagramForUrl } from '../src/lib/share';
import { driverFor, hasDriver } from '../src/lib/code/drivers';
import { highlightCode } from '../src/lib/code/highlight';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { lintDiagram } from '../src/lib/lint';
import { generateMarkdown } from '../src/lib/markdownExport';
import { exportMermaid } from '../src/lib/export/mermaid';
import { exportDbml } from '../src/lib/export/dbml';

/**
 * A job runner: the case the whole feature exists for. Something outside the
 * database claims a row, does work the database cannot see, writes the answer
 * somewhere else and marks the original done — a round trip, not a data flow.
 */
function jobRunner(dialect: Diagram['dialect'] = 'postgresql'): { d: Diagram; program: Program } {
  const d = emptyDiagram(dialect, 'Job runner');
  const jobs = createTable({
    name: 'jobs',
    columns: [
      createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false }),
      createColumn({ name: 'payload', type: 'TEXT' }),
      createColumn({ name: 'status', type: 'TEXT', nullable: false }),
    ],
  });
  const results = createTable({
    name: 'results',
    columns: [
      createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false }),
      createColumn({ name: 'job_id', type: 'INTEGER', nullable: false }),
      createColumn({ name: 'score', type: 'DOUBLE PRECISION', nullable: false }),
    ],
  });
  d.tables = [jobs, results];
  d.relationships = [
    createRelationship({
      kind: 'fk',
      sourceTableId: results.id,
      sourceColumnIds: [results.columns[1].id],
      targetTableId: jobs.id,
      targetColumnIds: [jobs.columns[0].id],
    }),
  ];
  const program = createProgram({
    name: 'scorer',
    language: 'python',
    role: 'job',
    entrypoint: 'services/scorer/main.py',
    comment: 'Scores every pending job.',
    steps: [
      createProgramStep({ op: 'read', tableId: jobs.id, columnIds: [jobs.columns[0].id, jobs.columns[1].id], note: 'claim a batch' }),
      createProgramStep({ op: 'compute', note: 'score the payload' }),
      createProgramStep({ op: 'write', tableId: results.id, columnIds: [results.columns[1].id, results.columns[2].id] }),
      createProgramStep({ op: 'write', tableId: jobs.id, columnIds: [jobs.columns[2].id], sql: 'UPDATE jobs SET status = %s WHERE id = %s' }),
    ],
  });
  d.programs = [program];
  return { d, program };
}

const tableId = (d: Diagram, name: string) => d.tables.find((t) => t.name === name)!.id;

describe('the program model', () => {
  it('keeps a compute step free of a table, whatever it is handed', () => {
    const step = createProgramStep({ op: 'compute', tableId: 'tbl_x', columnIds: ['c1', 'c2'] });
    expect(step.tableId).toBeUndefined();
    expect(step.columnIds).toEqual([]);
  });

  it('names a second program rather than letting two share one name', () => {
    const d = emptyDiagram();
    d.programs = [createProgram({ name: 'worker' })];
    expect(uniqueProgramName(d, 'worker')).toBe('worker_2');
    expect(uniqueProgramName(d, 'other')).toBe('other');
  });

  it('reads the round trip off the steps', () => {
    const { d, program } = jobRunner();
    expect(programTableIds(program)).toEqual([tableId(d, 'jobs'), tableId(d, 'results')]);
    // jobs is read at step 1 and written at step 4; results is only written.
    expect(programRoundTrips(program)).toEqual([tableId(d, 'jobs')]);
  });

  it('draws one arrow per database step, numbered by position', () => {
    const { d } = jobRunner();
    const links = programLinks(d);
    expect(links.map((l) => [l.step, l.op])).toEqual([
      [1, 'read'],
      [3, 'write'],
      [4, 'write'],
    ]);
    // The compute step is step 2 and draws nothing, which is why the numbers skip.
    expect(links.some((l) => l.step === 2)).toBe(false);
  });

  it('draws nothing for a step whose table has gone', () => {
    const { d } = jobRunner();
    d.programs[0].steps.push(createProgramStep({ op: 'read', tableId: 'tbl_missing' }));
    expect(programLinks(d)).toHaveLength(3);
  });

  it('describes a program as a sentence, round trips first', () => {
    const { d, program } = jobRunner();
    const sentence = describeProgram(d, program);
    expect(sentence).toContain('reads and writes jobs');
    expect(sentence).toContain('writes results');
    expect(sentence).toContain('1 step of work outside the database');
  });

  it('describes a step with its columns', () => {
    const { d, program } = jobRunner();
    const jobs = d.tables.find((t) => t.name === 'jobs');
    expect(describeStep(program.steps[0], jobs)).toBe('read jobs (id, payload)');
    expect(describeStep(program.steps[1], undefined)).toBe('compute — score the payload');
  });

  it('lists the programs that touch a table', () => {
    const { d } = jobRunner();
    expect(programsForTable(d, tableId(d, 'jobs')).map((p) => p.name)).toEqual(['scorer']);
    expect(programsForTable(d, 'tbl_nothing')).toEqual([]);
  });

  it('keeps a step and its code when the table it named is deleted', () => {
    const { d } = jobRunner();
    const jobs = tableId(d, 'jobs');
    d.programs[0].steps[0].code = 'cur.execute(READ_JOBS)';
    d.tables = d.tables.filter((t) => t.id !== jobs);
    const pruned = pruneRelationships(d);
    const step = pruned.programs[0].steps[0];
    // The pointer dangles on purpose; the code is the part nobody can rebuild.
    expect(step.tableId).toBe(jobs);
    expect(step.code).toBe('cur.execute(READ_JOBS)');
    expect(step.columnIds).toEqual([]);
  });
});

describe('saving and loading', () => {
  it('round-trips a program through a .dbviz.json file', () => {
    const { d } = jobRunner();
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.programs).toHaveLength(1);
    const p = back.programs[0];
    expect(p.name).toBe('scorer');
    expect(p.language).toBe('python');
    expect(p.role).toBe('job');
    expect(p.entrypoint).toBe('services/scorer/main.py');
    expect(p.steps.map((s) => s.op)).toEqual(['read', 'compute', 'write', 'write']);
    expect(p.steps[3].sql).toContain('UPDATE jobs');
  });

  it('loads a file written before programs existed', () => {
    const d = emptyDiagram('postgresql', 'Old');
    const raw = JSON.parse(serializeDiagram(d)) as Record<string, unknown>;
    delete raw.programs;
    expect(parseDiagramFile(JSON.stringify(raw)).programs).toEqual([]);
  });

  it('refuses to load nonsense a hand-edited file smuggles in', () => {
    const { d } = jobRunner();
    const raw = JSON.parse(serializeDiagram(d)) as { programs: Record<string, unknown>[] };
    raw.programs[0].language = 'brainfuck';
    raw.programs[0].steps = [{ id: 's1', op: 'explode', tableId: 'tbl_x', columnIds: ['c1'], sql: 'DROP TABLE jobs' }];
    const back = parseDiagramFile(JSON.stringify(raw));
    expect(back.programs[0].language).toBe('other');
    expect(back.programs[0].steps[0].op).toBe('read');
  });

  it('strips a table from a compute step a hand-edited file gave one', () => {
    const { d } = jobRunner();
    const raw = JSON.parse(serializeDiagram(d)) as { programs: { steps: Record<string, unknown>[] }[] };
    raw.programs[0].steps[1].tableId = 'tbl_jobs';
    raw.programs[0].steps[1].columnIds = ['c1'];
    const back = parseDiagramFile(JSON.stringify(raw));
    expect(back.programs[0].steps[1].tableId).toBeUndefined();
    expect(back.programs[0].steps[1].columnIds).toEqual([]);
  });
});

describe('the SQL script', () => {
  it('carries programs home in the annotation block', () => {
    const { d } = jobRunner();
    d.programs[0].steps[1].code = 'def score(row):\n    return 1.0';
    const script = generateSchema(d).script;
    expect(script).toContain('dbviz:connections');

    const back = importSql(script, 'postgresql');
    expect(back.programs).toHaveLength(1);
    const p = back.programs[0];
    expect(p.name).toBe('scorer');
    expect(p.steps.map((s) => s.op)).toEqual(['read', 'compute', 'write', 'write']);

    // Steps point at the re-imported tables, not at the ids they had before.
    const jobs = back.tables.find((t) => t.name === 'jobs')!;
    expect(p.steps[0].tableId).toBe(jobs.id);
    expect(p.steps[0].columnIds).toEqual(jobs.columns.filter((c) => c.name === 'id' || c.name === 'payload').map((c) => c.id));
    expect(p.steps[1].code).toContain('def score(row)');
  });

  it('writes an annotation block for a diagram that has only programs', () => {
    const d = emptyDiagram('postgresql', 'Just a program');
    d.tables = [createTable({ name: 'events', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true })] })];
    d.programs = [createProgram({ name: 'tailer', language: 'go', steps: [createProgramStep({ op: 'read', tableId: d.tables[0].id })] })];
    const script = generateSchema(d).script;
    expect(script).toContain('dbviz:connections');
    expect(importSql(script, 'postgresql').programs[0].name).toBe('tailer');
  });

  it('keeps a step whose table the script does not define, and says so', () => {
    const { d } = jobRunner();
    const script = generateSchema(d).script;
    // Drop the results table from the script but leave the annotations alone.
    const withoutResults = script.replace(/CREATE TABLE results[\s\S]*?\);\n/, '');
    const back = importSql(withoutResults, 'postgresql');
    const step = back.programs[0].steps[2];
    expect(step.op).toBe('write');
    expect(step.tableId).toBeUndefined();
    expect(back.warnings.join('\n')).toContain('results');
  });
});

describe('the generated starter', () => {
  it('writes Python that names the tables, the columns and the driver', () => {
    const { d, program } = jobRunner();
    const code = generateProgramCode(d, program);
    expect(code).toContain('import psycopg');
    expect(code).toContain('READ_JOBS');
    expect(code).toContain('INSERT INTO results (job_id, score)');
    // psycopg binds with %s, not $1.
    expect(code).toContain('VALUES (%s, %s)');
    expect(code).not.toContain('VALUES ($1, $2)');
    // The compute step is a stub, because the diagram cannot know what it does.
    expect(code).toContain('def compute_2(row):');
    expect(code).toContain('raise NotImplementedError');
  });

  it('puts everything after the first read inside the row loop', () => {
    const { d, program } = jobRunner();
    const lines = generateProgramCode(d, program).split('\n');
    const loop = lines.findIndex((l) => l.trim() === 'for row in rows:');
    const write = lines.findIndex((l) => l.includes('cur.execute(WRITE_RESULTS'));
    expect(loop).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(loop);
    // Inside the loop means indented past the statements before it.
    expect(lines[write].match(/^ */)![0].length).toBeGreaterThan(lines[loop].match(/^ */)![0].length);
  });

  it('changes driver and placeholder style with the engine', () => {
    const { d, program } = jobRunner('mariadb');
    const code = generateProgramCode(d, program);
    expect(code).toContain('import mariadb');
    expect(code).toContain('VALUES (?, ?)');
  });

  it('uses the step’s own SQL verbatim when it has some', () => {
    const { d, program } = jobRunner();
    expect(generateProgramCode(d, program)).toContain('UPDATE jobs SET status = %s WHERE id = %s');
  });

  it('leaves generated keys out of an insert', () => {
    const { d, program } = jobRunner();
    // Clear the chosen columns so the whole table is the default.
    program.steps[2].columnIds = [];
    const code = generateProgramCode(d, program);
    expect(code).toContain('INSERT INTO results (job_id, score)');
    expect(code).not.toMatch(/INSERT INTO results \([^)]*\bid\b/);
  });

  it('writes Rust with the sqlx pool and numbered placeholders', () => {
    const { d, program } = jobRunner();
    const code = generateProgramCode(d, { ...program, language: 'rust' });
    expect(code).toContain('PgPoolOptions');
    expect(code).toContain('VALUES ($1, $2)');
    expect(code).toContain('for row in rows {');
    expect(code.split('\n').filter((l) => l.trim() === '}').length).toBeGreaterThan(0);
  });

  it('writes Go with a sorted import block', () => {
    const { d, program } = jobRunner();
    const code = generateProgramCode(d, { ...program, language: 'go' });
    const block = code.slice(code.indexOf('import ('), code.indexOf(')', code.indexOf('import (')));
    const paths = block
      .split('\n')
      .slice(1)
      .filter((l) => l.includes('"'))
      .map((l) => l.slice(l.indexOf('"')));
    expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
  });

  it('falls back to the plan in comments when no driver template exists', () => {
    const { d, program } = jobRunner();
    expect(hasDriver('csharp', 'postgresql')).toBe(false);
    const code = generateProgramCode(d, { ...program, language: 'csharp' });
    expect(code).toContain('No driver template exists for C#');
    // Every line is a comment: it is a plan, and never pretends to compile.
    expect(code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))).toEqual([]);
  });

  it('gives every step a distinct identifier even when two touch the same table', () => {
    const { d, program } = jobRunner();
    const steps = resolveSteps(d, program, driverFor('python', 'postgresql'));
    expect(new Set(steps.map((s) => s.slug)).size).toBe(steps.length);
  });

  it('survives a program with no steps at all', () => {
    const d = emptyDiagram();
    const empty = createProgram({ name: 'idle', language: 'python' });
    expect(() => generateProgramCode(d, empty)).not.toThrow();
  });
});

describe('code highlighting', () => {
  it('covers every character of the input, in order', () => {
    const code = 'def main():\n    x = "hi"  # a comment\n    return x\n';
    const spans = highlightCode(code, 'python');
    expect(spans.map((s) => s.text).join('')).toBe(code);
    expect(spans.every((s, i) => i === 0 || s.start === spans[i - 1].end)).toBe(true);
  });

  it('knows each language’s own comment marker', () => {
    expect(highlightCode('# hi', 'python').some((s) => s.cls === 'comment')).toBe(true);
    expect(highlightCode('# hi', 'rust').some((s) => s.cls === 'comment')).toBe(false);
    expect(highlightCode('// hi', 'rust').some((s) => s.cls === 'comment')).toBe(true);
  });

  it('reads a Rust raw string as one string, hashes and all', () => {
    const spans = highlightCode('let s = r#"a "quoted" thing"#;', 'rust');
    const str = spans.find((s) => s.cls === 'string')!;
    expect(str.text).toBe('r#"a "quoted" thing"#');
  });

  it('reads a Python triple-quoted string as one string', () => {
    const spans = highlightCode('SQL = """\nSELECT 1\n"""', 'python');
    expect(spans.find((s) => s.cls === 'string')!.text).toBe('"""\nSELECT 1\n"""');
  });

  it('stops an unterminated plain string at the newline', () => {
    const spans = highlightCode('x = "oops\ny = 1\n', 'python');
    expect(spans.find((s) => s.cls === 'string')!.text).toBe('"oops');
  });

  it('claims no keywords for an unknown language but still finds strings', () => {
    const spans = highlightCode('fn main() { let x = "hi"; }', 'other');
    expect(spans.some((s) => s.cls === 'keyword')).toBe(false);
    expect(spans.some((s) => s.cls === 'string')).toBe(true);
  });
});

describe('the linter', () => {
  const rules = (d: Diagram) => lintDiagram(d).map((f) => f.rule);

  it('says nothing about a program that is doing its job', () => {
    const { d } = jobRunner();
    expect(rules(d).filter((r) => r.startsWith('program'))).toEqual([]);
  });

  it('reports a step pointing at a table that is gone, and offers to remove it', () => {
    const { d } = jobRunner();
    d.programs[0].steps[0].tableId = 'tbl_vanished';
    const finding = lintDiagram(d).find((f) => f.rule === 'program-step-missing-table')!;
    expect(finding.severity).toBe('error');
    // Removing a step throws away its code, so it is never a "fix all safe".
    expect(finding.fix!.safe).toBe(false);
    finding.fix!.apply(d);
    expect(d.programs[0].steps).toHaveLength(3);
  });

  it('reports a program writing a column a data flow already computes', () => {
    const { d } = jobRunner();
    const results = d.tables.find((t) => t.name === 'results')!;
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tableId(d, 'jobs'),
        sourceColumnIds: [],
        targetTableId: results.id,
        targetColumnIds: [],
        derivations: [{ id: 'drv1', targetColumnId: results.columns[2].id, expression: 'payload', groupBy: [] }],
      }),
    );
    expect(rules(d)).toContain('program-writes-derived-column');
  });

  it('reports a write to a view', () => {
    const { d } = jobRunner();
    const view = createTable({ name: 'open_jobs', kind: 'view', viewSql: 'SELECT * FROM jobs' });
    d.tables.push(view);
    d.programs[0].steps.push(createProgramStep({ op: 'write', tableId: view.id }));
    expect(rules(d)).toContain('program-writes-view');
  });

  it('reports a step that names no table and a program that names none at all', () => {
    const d = emptyDiagram();
    d.programs = [createProgram({ name: 'drifter', steps: [createProgramStep({ op: 'read' })] })];
    const found = rules(d);
    expect(found).toContain('program-step-without-table');
    expect(found).toContain('program-touches-nothing');
  });

  it('reports two programs sharing a name', () => {
    const { d } = jobRunner();
    d.programs.push(createProgram({ name: 'scorer', language: 'go' }));
    expect(rules(d)).toContain('duplicate-program-name');
  });
});

describe('the other exports', () => {
  it('gives Markdown a section per program and a list on every table it touches', () => {
    const { d } = jobRunner();
    d.programs[0].steps[1].code = 'return sum(row)';
    const md = generateMarkdown(d, { includeMermaid: false });
    expect(md).toContain('## Programs');
    expect(md).toContain('### scorer');
    expect(md).toContain('services/scorer/main.py');
    expect(md).toContain('**Touched from outside the database**');
    expect(md).toContain('```py\nreturn sum(row)\n```');
  });

  it('gives Mermaid an entity per program, marked as one, with a link per step', () => {
    const { d } = jobRunner();
    const mmd = exportMermaid(d);
    expect(mmd).toContain('%% program: scorer (Python)');
    expect(mmd).toContain('read jobs');
    expect(mmd).toContain('"1 read"');
    expect(mmd).toContain('"4 write"');
  });

  it('leaves programs out of Mermaid when documentation is switched off', () => {
    const { d } = jobRunner();
    expect(exportMermaid(d, { includeDocumentation: false })).not.toContain('%% program:');
  });

  it('keeps programs in DBML as notes, since DBML has only tables', () => {
    const { d } = jobRunner();
    const dbml = exportDbml(d);
    expect(dbml).toContain('Note program_scorer');
    expect(dbml).toContain('1. read jobs (id, payload)');
  });
});

describe('auto-layout', () => {
  it('parks a program in the margin beside the tables it touches', () => {
    const { d } = jobRunner();
    const positions = layoutDiagram(d, { direction: 'LR' });
    const program = positions[d.programs[0].id];
    const tables = d.tables.map((t) => positions[t.id]).filter(Boolean);
    expect(program).toBeDefined();
    // Left of every table when the layout runs left to right, so the arrows
    // come in from outside rather than through the middle of the diagram.
    expect(Math.max(...tables.map((t) => t.x))).toBeGreaterThan(program.x);
  });

  it('puts the margin above instead when the layout runs top to bottom', () => {
    const { d } = jobRunner();
    const positions = layoutDiagram(d, { direction: 'TB' });
    const program = positions[d.programs[0].id];
    const tables = d.tables.map((t) => positions[t.id]).filter(Boolean);
    expect(Math.min(...tables.map((t) => t.y))).toBeGreaterThan(program.y);
  });

  it('stacks two programs rather than landing them on each other', () => {
    const { d } = jobRunner();
    d.programs.push(
      createProgram({
        name: 'reporter',
        language: 'go',
        steps: [createProgramStep({ op: 'read', tableId: tableId(d, 'results') })],
      }),
    );
    const positions = layoutDiagram(d, { direction: 'LR' });
    const [a, b] = d.programs.map((p) => positions[p.id]);
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(40);
  });

  it('leaves the table layout alone when there are no programs', () => {
    const { d } = jobRunner();
    const withPrograms = layoutDiagram(d, { direction: 'LR' });
    const without = layoutDiagram({ ...d, programs: [] }, { direction: 'LR' });
    for (const t of d.tables) expect(withPrograms[t.id]).toEqual(without[t.id]);
  });
});

describe('share links', () => {
  it('carries a program in the URL along with everything else', async () => {
    const { d } = jobRunner();
    const back = await decodeDiagramFromUrl(await encodeDiagramForUrl(d));
    expect(back.programs.map((p) => p.name)).toEqual(['scorer']);
    expect(back.programs[0].steps).toHaveLength(4);
  });
});
