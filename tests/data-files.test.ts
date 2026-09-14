import { beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_LANGUAGES,
  PROGRAM_LANGUAGES,
  canStepName,
  isDataLanguage,
  isDataNode,
  kindForLanguage,
  languageForKind,
  settleCodeNode,
  type Diagram,
  type Program,
} from '../src/shared/types';
import { createColumn, createProgram, createProgramStep, createTable, emptyDiagram } from '../src/lib/model';
import { generateProgramCode, hasStarter, programCodeFilename } from '../src/lib/code/generate';
import { driverFor, hasDriver } from '../src/lib/code/drivers';
import { highlightCode } from '../src/lib/code/highlight';
import { codeLinks, defaultCodeOp, canLinkCode } from '../src/lib/codemap';
import { describeProgram } from '../src/lib/programs';
import { lintDiagram } from '../src/lib/lint';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { useStore } from '../src/store/useStore';

/**
 * The two halves of what a node may be written in.
 *
 * Perl and the shell are code: they reach a database, so they get a driver, a
 * starter and a place in the scanner. YAML and JSON are not: nothing runs in
 * one, so a node written in one is a data file — a kind of its own that holds
 * nothing, does nothing, and is only ever on the end of a load. These tests are
 * about that line staying where it is, whichever way a node arrives.
 */

/** A scorer, its settings file, and the two tables it works between. */
function scorer(dialect: Diagram['dialect'] = 'postgresql', dataLanguage: 'yaml' | 'json' = 'yaml'): {
  d: Diagram;
  program: Program;
  settings: Program;
} {
  const d = emptyDiagram(dialect, 'Job runner');
  const jobs = createTable({
    name: 'jobs',
    columns: [
      createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false }),
      createColumn({ name: 'payload', type: 'TEXT' }),
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
  const settings = createProgram({
    name: `settings.${dataLanguage}`,
    kind: 'data',
    language: dataLanguage,
    entrypoint: `config/settings.${dataLanguage}`,
    comment: 'Thresholds the scorer reads.',
  });
  const program = createProgram({
    name: 'scorer',
    language: 'perl',
    role: 'job',
    comment: 'Scores every pending job.',
    steps: [
      createProgramStep({ op: 'load', codeId: settings.id, note: 'thresholds' }),
      createProgramStep({ op: 'read', tableId: jobs.id, columnIds: [jobs.columns[0].id, jobs.columns[1].id] }),
      createProgramStep({ op: 'compute', note: 'score the payload' }),
      createProgramStep({ op: 'write', tableId: results.id, columnIds: [results.columns[1].id, results.columns[2].id] }),
    ],
  });
  d.programs = [program, settings];
  return { d, program, settings };
}

describe('the languages a code node may be written in', () => {
  it('offers the ones that reach a database, and no longer the two that never did', () => {
    const ids = PROGRAM_LANGUAGES.map((l) => l.id);
    expect(ids).toContain('perl');
    expect(ids).toContain('shell');
    // C# and Ruby had a label and nothing behind it: no driver, no scanner.
    expect(ids).not.toContain('csharp');
    expect(ids).not.toContain('ruby');
  });

  it('knows which of them nothing runs in', () => {
    expect(DATA_LANGUAGES).toEqual(['yaml', 'json']);
    expect(isDataLanguage('yaml')).toBe(true);
    expect(isDataLanguage('perl')).toBe(false);
    // Every data language is one a starter would never be generated for.
    for (const id of DATA_LANGUAGES) expect(hasDriver(id, 'postgresql')).toBe(false);
  });

  it('reaches every engine Perl has a DBD for, and says nothing about the one it has not', () => {
    for (const dialect of ['postgresql', 'mariadb', 'sqlite'] as const) {
      expect(driverFor('perl', dialect)?.label).toMatch(/through DBI/);
    }
    // No DBD::DuckDB worth naming, so the pairing falls back to the outline.
    expect(hasDriver('perl', 'duckdb')).toBe(false);
    const { d, program } = scorer('duckdb');
    const code = generateProgramCode(d, program);
    expect(code).toContain('No driver template exists for Perl on duckdb yet');
    expect(code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))).toEqual([]);
  });

  it('colours a sigil as a variable, and a key as a key', () => {
    const perl = highlightCode('my $dbh = DBI->connect($DSN);', 'perl');
    expect(perl.find((s) => s.text === 'my')?.cls).toBe('keyword');
    expect(perl.find((s) => s.text === '$dbh')?.cls).toBe('param');
    const yaml = highlightCode('warehouse: main\n# which shelves\nretries: 3\n', 'yaml');
    expect(yaml.find((s) => s.text === 'warehouse')?.cls).toBe('column');
    expect(yaml.find((s) => s.text.startsWith('#'))?.cls).toBe('comment');
    expect(yaml.find((s) => s.text === '3')?.cls).toBe('number');
    const json = highlightCode('{ "currency": "GBP" }', 'json');
    expect(json.find((s) => s.text === '"currency"')?.cls).toBe('column');
    expect(json.find((s) => s.text === '"GBP"')?.cls).toBe('string');
  });
});

describe('a data file', () => {
  it('settles its kind and its language against each other, whichever one was set', () => {
    // The language was picked: the node becomes a data file.
    expect(settleCodeNode('function', 'yaml')).toEqual({ kind: 'data', language: 'yaml' });
    expect(kindForLanguage('json', 'module')).toBe('data');
    // The kind was picked: the language follows it.
    expect(languageForKind('data', 'python')).toBe('yaml');
    expect(languageForKind('data', 'json')).toBe('json');
    // And leaving a data file behind leaves its language behind too.
    expect(languageForKind('function', 'yaml')).toBe('other');
    expect(kindForLanguage('python', 'data')).toBe('module');
    // Anything that is already consistent is left exactly as it is.
    expect(settleCodeNode('class', 'perl')).toEqual({ kind: 'class', language: 'perl' });
  });

  it('is the only thing a load may name, and is never called, imported or inherited from', () => {
    expect(canStepName('load', 'data')).toBe(true);
    expect(canStepName('load', 'function')).toBe(false);
    for (const op of ['call', 'import', 'extends'] as const) {
      expect(canStepName(op, 'data')).toBe(false);
      expect(canStepName(op, 'function')).toBe(true);
    }
    // A drag onto one can only have meant a load; a drag out of one is refused.
    expect(defaultCodeOp({ kind: 'function' }, { kind: 'data' })).toBe('load');
    expect(canLinkCode({ kind: 'data' }, { kind: 'function' })).toBe(false);
    expect(canLinkCode({ kind: 'function' }, { kind: 'data' })).toBe(true);
    expect(canLinkCode({ kind: 'function' }, { kind: 'data' }, 'call')).toBe(false);
  });

  it('loses steps written on it by a file, rather than loading a node that could never run them', () => {
    const { d, settings } = scorer();
    const written = JSON.parse(serializeDiagram(d)) as Record<string, unknown>;
    const programs = written.programs as Record<string, unknown>[];
    const file = programs.find((p) => p.id === settings.id)!;
    file.steps = [{ id: 'stp_x', op: 'read', tableId: d.tables[0].id, columnIds: [] }];
    const back = parseDiagramFile(JSON.stringify(written));
    expect(back.programs.find((p) => p.id === settings.id)!.steps).toEqual([]);
    // And the load step pointing at it survives the round trip.
    expect(back.programs.find((p) => p.id === scorerId(back))!.steps[0]).toMatchObject({ op: 'load', codeId: settings.id });
  });

  it('loads as a data file when a file claims it is a function written in YAML', () => {
    const { d, settings } = scorer();
    const written = JSON.parse(serializeDiagram(d)) as Record<string, unknown>;
    const programs = written.programs as Record<string, unknown>[];
    programs.find((p) => p.id === settings.id)!.kind = 'function';
    const back = parseDiagramFile(JSON.stringify(written));
    const file = back.programs.find((p) => p.id === settings.id)!;
    expect(file.kind).toBe('data');
    expect(isDataNode(file)).toBe(true);
  });

  it('draws one arrow, from the code that reads it', () => {
    const { d, program, settings } = scorer();
    const links = codeLinks(d);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromId: program.id, toId: settings.id, op: 'load' });
    expect(describeProgram(d, settings)).toBe('settings.yaml, a YAML data file, is loaded by scorer.');
    expect(describeProgram(d, program)).toContain('loads settings.yaml');
  });

  it('gets the file as its starter: the prose above it in YAML, and nothing at all in JSON', () => {
    const { d, settings } = scorer();
    expect(hasStarter(d, settings)).toBe(true);
    expect(programCodeFilename(settings)).toBe('settings.yaml');
    const yaml = generateProgramCode(d, settings);
    expect(yaml).toContain('# settings.yaml — a data file in the "Job runner" diagram.');
    expect(yaml).toContain('# Thresholds the scorer reads.');
    expect(yaml.split('\n').filter((l) => l.trim() && !l.startsWith('#'))).toEqual([]);
    // A comment in a JSON file is a JSON file that will not parse.
    const json = scorer('postgresql', 'json');
    expect(generateProgramCode(json.d, json.settings)).toBe('{}\n');
  });

  it('is reported by Problems when nothing reads it, and when a step says the wrong thing about it', () => {
    const { d, program, settings } = scorer();
    expect(lintDiagram(d).map((f) => f.rule)).not.toContain('code-data-unread');
    // Take the load away and the file is on the canvas for no reason.
    program.steps = program.steps.filter((s) => s.op !== 'load');
    expect(lintDiagram(d).map((f) => f.rule)).toContain('code-data-unread');
    // Point a call at it and the step says something that cannot happen.
    program.steps.push(createProgramStep({ op: 'call', codeId: settings.id }));
    const mismatch = lintDiagram(d).find((f) => f.rule === 'code-step-op-mismatch');
    expect(mismatch?.message).toContain('which is a data file');
    expect(mismatch?.fix?.label).toBe('Make it a load');
  });

  it('rides the annotation block out of a script and back in', () => {
    const { d } = scorer();
    const script = generateSchema(d).script;
    const back = importSql(script, 'postgresql');
    const file = back.programs.find((p) => p.name === 'settings.yaml')!;
    expect(file.kind).toBe('data');
    expect(file.language).toBe('yaml');
    expect(file.steps).toEqual([]);
    const scorerBack = back.programs.find((p) => p.name === 'scorer')!;
    expect(scorerBack.steps.find((s) => s.op === 'load')?.codeId).toBe(file.id);
  });
});

describe('the line a load step comes out as', () => {
  const load = (language: Program['language'], data: 'yaml' | 'json' = 'yaml') => {
    const { d, program } = scorer('postgresql', data);
    return generateProgramCode(d, { ...program, language });
  };

  it('is the call that language would really make, with the import it needs', () => {
    expect(load('python')).toContain('with open("config/settings.yaml", encoding="utf-8") as f:');
    expect(load('python')).toContain('settings = yaml.safe_load(f)');
    expect(load('python')).toContain('import yaml  # pip install PyYAML');
    expect(load('python', 'json')).toContain('settings = json.load(f)');
    expect(load('python', 'json')).toContain('import json');
    expect(load('javascript')).toContain("const settings = YAML.parse(await readFile(\"config/settings.yaml\", 'utf8'));");
    expect(load('javascript', 'json')).toContain('JSON.parse(await readFile("config/settings.json"');
    expect(load('rust')).toContain('let settings: serde_yaml::Value = serde_yaml::from_str(&std::fs::read_to_string("config/settings.yaml")?)?;');
    expect(load('go', 'json')).toContain('settingsBytes, err := os.ReadFile("config/settings.json")');
    expect(load('java')).toContain('JsonNode settings = new ObjectMapper(new YAMLFactory()).readTree(new File("config/settings.yaml"));');
    expect(load('cpp', 'json')).toContain('nlohmann::json settings = nlohmann::json::parse(settings_file);');
    expect(load('perl')).toContain("my $settings = LoadFile('config/settings.yaml');");
    expect(load('perl')).toContain('use YAML::XS qw(LoadFile);');
    expect(load('shell', 'json')).toContain("settings=$(jq -c . 'config/settings.json')");
  });

  it('says what C has no parser for rather than inventing one', () => {
    expect(load('c', 'json')).toContain('// config/settings.json: C has no parser of its own — read the file, then cJSON_Parse.');
  });

  it('mentions a library only when the file actually reads that format', () => {
    expect(load('python', 'json')).not.toContain('import yaml');
    expect(load('javascript', 'json')).not.toContain("import YAML from 'yaml';");
  });
});

describe('the Perl and shell starters', () => {
  it('writes Perl through DBI: a heredoc for the statement, a handle for the work', () => {
    const { d, program } = scorer();
    const code = generateProgramCode(d, program);
    expect(code).toContain('#!/usr/bin/env perl');
    expect(code).toContain('use DBI;');
    expect(code).toContain("my $DSN = $ENV{DATABASE_URL} // 'dbi:Pg:dbname=postgres;host=localhost;port=5432';");
    expect(code).toContain("my $READ_JOBS = <<'SQL';");
    expect(code).toContain('my $sth = $dbh->prepare($READ_JOBS);');
    expect(code).toContain('while (my $row = $sth->fetchrow_hashref) {');
    // `use strict` means an undeclared parameter is a compile error, not a hole.
    expect(code).toContain('my ($job_id, $score);  # fill these in');
    expect(code).toContain('$dbh->commit;');
    expect(code).toContain('main() unless caller;');
  });

  it('writes the shell against psql, with the only bound parameters any of these CLIs have', () => {
    const { d, program } = scorer();
    const code = generateProgramCode(d, { ...program, language: 'shell' });
    expect(code).toContain('#!/usr/bin/env bash');
    expect(code).toContain('set -euo pipefail');
    expect(code).toContain("Values are passed with -v and read back as :'p1', which psql quotes for you.");
    expect(code).toContain('read_jobs_sql() {');
    expect(code).toContain("  cat <<'SQL'");
    expect(code).toContain('rows=$(psql "$DSN"');
    expect(code).toContain('-v p1="$job_id" -v p2="$score"');
    // An empty result set must not run the row loop once.
    expect(code).toContain('[ -n "$row" ] || continue');
  });

  it('says out loud that the other three CLIs paste a value into the statement', () => {
    const { d, program } = scorer('sqlite');
    const code = generateProgramCode(d, { ...program, language: 'shell' });
    expect(code).toContain('has no bound parameters, so a value reaches a statement by the shell pasting it in');
    // …which is why that one statement's heredoc is the interpolating kind.
    expect(code).toContain('write_results_sql() {\n  cat <<SQL');
    expect(code).toContain("VALUES ('${p1}', '${p2}')");
    expect(code).toContain('p1="$job_id"');
    expect(code).toContain("read_jobs_sql() {\n  cat <<'SQL'");
  });
});

describe('the editor, through the store', () => {
  beforeEach(() => {
    const { d } = scorer();
    useStore.setState({ diagram: d, past: [], future: [] });
  });

  const find = (name: string) => useStore.getState().diagram.programs.find((p) => p.name === name)!;

  it('moves the language when the kind changes, and the kind when the language does', () => {
    const module = useStore.getState().addProgram({ kind: 'module', name: 'orders.pl', language: 'perl' });
    useStore.getState().updateProgram(module, { kind: 'data' });
    expect(find('orders.pl').language).toBe('yaml');
    // …and the other way round: nothing runs in JSON, so this is a data file.
    useStore.getState().updateProgram(module, { kind: 'module', language: 'perl' });
    useStore.getState().updateProgram(module, { language: 'json' });
    expect(find('orders.pl').kind).toBe('data');
    // Leaving the kind behind leaves the language behind with it.
    useStore.getState().updateProgram(module, { kind: 'module' });
    expect(find('orders.pl').language).toBe('other');
  });

  it('takes the steps off a node that becomes a data file, and Ctrl+Z puts them back', () => {
    const id = find('scorer').id;
    expect(find('scorer').steps.length).toBe(4);
    useStore.getState().updateProgram(id, { kind: 'data' });
    expect(find('scorer').steps).toEqual([]);
    useStore.getState().undo();
    expect(find('scorer').steps.length).toBe(4);
  });

  it('names a new data file after its language, and refuses an arrow out of one', () => {
    const id = useStore.getState().addProgram({ kind: 'data' });
    expect(find('new_data.yaml')).toBeDefined();
    // Nothing runs in it, so there is nothing for an arrow to leave.
    expect(useStore.getState().connectCode(id, find('scorer').id)).toBeNull();
    // And an arrow into one is the load it can only be.
    const step = useStore.getState().connectCode(find('scorer').id, id);
    expect(step).not.toBeNull();
    expect(find('scorer').steps.find((s) => s.id === step)?.op).toBe('load');
  });
});

/** The id of the scorer in a diagram that has been through a file. */
function scorerId(d: Diagram): string {
  return d.programs.find((p) => p.name === 'scorer')!.id;
}
