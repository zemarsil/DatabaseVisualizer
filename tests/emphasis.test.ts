import { describe, expect, it } from 'vitest';
import type { Diagram, Program } from '../src/shared/types';
import { describeContents, diagramEmphasis, hasContent, isBlankDiagram, showsDatabaseTools, showsStartScreen } from '../src/lib/emphasis';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { createProgram, createTable, emptyDiagram } from '../src/lib/model';

function withCode(d: Diagram, ...names: string[]): Diagram {
  const programs: Program[] = names.map((name) => createProgram({ name, language: 'python', position: { x: 0, y: 0 } }));
  return { ...d, programs: [...d.programs, ...programs] };
}

function withTables(d: Diagram, ...names: string[]): Diagram {
  return { ...d, tables: [...d.tables, ...names.map((name) => createTable({ name, position: { x: 0, y: 0 }, columns: [] }))] };
}

describe('what a diagram is about', () => {
  it('asks on a canvas with nothing on it and nothing chosen', () => {
    const d = emptyDiagram('postgresql');
    expect(isBlankDiagram(d)).toBe(true);
    expect(showsStartScreen(d)).toBe(true);
    // Nothing is hidden before the question is answered: an empty canvas is
    // about both, so the opening card is never shown over a stripped workbench.
    expect(diagramEmphasis(d)).toBe('both');
    expect(showsDatabaseTools(d)).toBe(true);
  });

  it('stops asking once any of the three answers is given', () => {
    for (const emphasis of ['code', 'data', 'both'] as const) {
      expect(showsStartScreen({ ...emptyDiagram('postgresql'), emphasis })).toBe(false);
    }
  });

  it('reads a file written before emphasis existed off its contents', () => {
    const code = withCode(emptyDiagram('postgresql'), 'ingest.py');
    const data = withTables(emptyDiagram('postgresql'), 'orders');
    expect(code.emphasis).toBeUndefined();
    expect(diagramEmphasis(code)).toBe('code');
    expect(diagramEmphasis(data)).toBe('data');
    expect(diagramEmphasis(withCode(data, 'ingest.py'))).toBe('both');
  });

  it('hides the database half only for a code map', () => {
    expect(showsDatabaseTools(withCode(emptyDiagram('postgresql'), 'ingest.py'))).toBe(false);
    expect(showsDatabaseTools(withTables(emptyDiagram('postgresql'), 'orders'))).toBe(true);
    expect(showsDatabaseTools(withCode(withTables(emptyDiagram('postgresql'), 'orders'), 'ingest.py'))).toBe(true);
  });

  it('lets content outrank a stale choice, but only by adding', () => {
    // A table on a diagram marked "code" must not hide the tools that table needs.
    const grown = withTables({ ...emptyDiagram('postgresql'), emphasis: 'code' }, 'orders');
    expect(diagramEmphasis(grown)).toBe('both');
    expect(showsDatabaseTools(grown)).toBe(true);
    // ...and the same the other way round.
    expect(diagramEmphasis(withCode({ ...emptyDiagram('postgresql'), emphasis: 'data' }, 'ingest.py'))).toBe('both');
  });

  it('keeps a code map a code map when the last node is deleted', () => {
    // Without the stored field this would fall back to "both" and the database
    // tooling would reappear the moment someone cleared the canvas.
    expect(diagramEmphasis({ ...emptyDiagram('postgresql'), emphasis: 'code' })).toBe('code');
    expect(showsDatabaseTools({ ...emptyDiagram('postgresql'), emphasis: 'code' })).toBe(false);
  });

  it('treats an explicit "both" as a decision, not a default', () => {
    // Someone who asked to mix freely and then drew only code still wanted both.
    const d = withCode({ ...emptyDiagram('postgresql'), emphasis: 'both' }, 'ingest.py');
    expect(diagramEmphasis(d)).toBe('both');
    expect(showsDatabaseTools(d)).toBe(true);
  });

  it('counts custom types and extensions as a schema', () => {
    const d = { ...emptyDiagram('postgresql'), customTypes: [{ id: 'ct1', name: 'status', kind: 'enum' as const, values: ['paid'] }] };
    expect(isBlankDiagram(d)).toBe(false);
    expect(diagramEmphasis(d)).toBe('data');
  });
});

describe('a code map is a whole file', () => {
  it('loads a diagram with no tables array at all', () => {
    const text = JSON.stringify({
      version: 1,
      name: 'Scanned',
      emphasis: 'code',
      dialect: 'postgresql',
      programs: [{ id: 'p1', name: 'ingest.py', kind: 'module', language: 'python', position: { x: 0, y: 0 }, color: 'slate', steps: [] }],
    });
    const d = parseDiagramFile(text);
    expect(d.tables).toEqual([]);
    expect(d.programs).toHaveLength(1);
    expect(d.emphasis).toBe('code');
    expect(showsDatabaseTools(d)).toBe(false);
  });

  it('still refuses a file that is neither', () => {
    expect(() => parseDiagramFile(JSON.stringify({ version: 1, name: 'Nope', dialect: 'postgresql' }))).toThrow(/tables/);
  });

  it('round-trips the emphasis, and leaves it out when nobody set one', () => {
    const chosen = { ...emptyDiagram('postgresql'), emphasis: 'code' as const };
    expect(parseDiagramFile(serializeDiagram(chosen)).emphasis).toBe('code');
    const unsaid = withTables(emptyDiagram('postgresql'), 'orders');
    expect(JSON.parse(serializeDiagram(unsaid)).emphasis).toBeUndefined();
    expect(parseDiagramFile(serializeDiagram(unsaid)).emphasis).toBeUndefined();
  });

  it('ignores an emphasis a hand-edited file made up', () => {
    const text = JSON.stringify({ version: 1, name: 'Odd', dialect: 'postgresql', emphasis: 'sideways', tables: [], programs: [] });
    expect(parseDiagramFile(text).emphasis).toBeUndefined();
  });
});

describe('saying what is on a diagram', () => {
  it('counts both halves, not tables alone', () => {
    const d = withCode(withTables(emptyDiagram('postgresql'), 'orders', 'customers'), 'ingest.py');
    expect(describeContents(d)).toBe('2 tables and 1 code node');
    expect(describeContents(withCode(emptyDiagram('postgresql'), 'ingest.py'))).toBe('1 code node');
    expect(describeContents(emptyDiagram('postgresql'))).toBe('');
  });

  it('agrees with hasContent about what is worth confirming', () => {
    const code = withCode(emptyDiagram('postgresql'), 'ingest.py');
    expect(hasContent(code)).toBe(true);
    expect(describeContents(code)).not.toBe('');
  });
});
