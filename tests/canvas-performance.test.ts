import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { createColumn, createNote, createProgram, createProgramStep, createTable, emptyDiagram } from '../src/lib/model';
import { reuseUnchanged, sameData } from '../src/lib/stableList';
import { onlyMoved } from '../src/lib/moves';

describe('sameData', () => {
  it('compares plain data structurally and short-circuits on identity', () => {
    const shared = { big: [1, 2, 3] };
    expect(sameData({ a: 1, b: [1, { c: 'x' }], shared }, { a: 1, b: [1, { c: 'x' }], shared })).toBe(true);
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameData([1, 2], [1, 2, 3])).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameData(null, {})).toBe(false);
    expect(sameData([], {})).toBe(false);
    expect(sameData(Number.NaN, Number.NaN)).toBe(true);
  });

  it('treats anything that is not plain data as equal only to itself', () => {
    const m = new Map([[1, 2]]);
    expect(sameData(m, m)).toBe(true);
    expect(sameData(new Map([[1, 2]]), new Map([[1, 2]]))).toBe(false);
    const f = () => 1;
    expect(sameData({ f }, { f })).toBe(true);
    expect(sameData({ f }, { f: () => 1 })).toBe(false);
  });
});

describe('reuseUnchanged', () => {
  const node = (id: string, x: number, label = id) => ({ id, position: { x, y: 0 }, data: { label, rows: [label] } });

  it('hands back the previous list itself when nothing changed', () => {
    const prev = [node('a', 0), node('b', 10)];
    expect(reuseUnchanged(prev, [node('a', 0), node('b', 10)])).toBe(prev);
  });

  it('keeps an empty list the same object, so an absent kind of arrow never reads as a change', () => {
    const prev: { id: string }[] = [];
    expect(reuseUnchanged(prev, [])).toBe(prev);
    const next = [node('a', 0)];
    expect(reuseUnchanged(prev, next)).toBe(next);
  });

  it('reuses unchanged items and passes changed ones through', () => {
    const prev = [node('a', 0), node('b', 10), node('c', 20)];
    const next = [node('a', 0), node('b', 99), node('c', 20)];
    const out = reuseUnchanged(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(prev[2]);
  });

  it('follows ids rather than positions in the list, and notices a reorder', () => {
    const prev = [node('a', 0), node('b', 10)];
    const out = reuseUnchanged(prev, [node('b', 10), node('a', 0)]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });

  it('notices additions and removals', () => {
    const prev = [node('a', 0), node('b', 10)];
    const grown = reuseUnchanged(prev, [node('a', 0), node('b', 10), node('c', 20)]);
    expect(grown).not.toBe(prev);
    expect(grown[0]).toBe(prev[0]);
    const shrunk = reuseUnchanged(prev, [node('a', 0)]);
    expect(shrunk).not.toBe(prev);
    expect(shrunk[0]).toBe(prev[0]);
  });
});

describe('onlyMoved', () => {
  function diagram(): Diagram {
    const d = emptyDiagram();
    const t = createTable({ name: 'orders', position: { x: 0, y: 0 } });
    t.columns.push(createColumn({ name: 'total' }));
    d.tables.push(t, createTable({ name: 'customers', position: { x: 300, y: 0 } }));
    const p = createProgram({ name: 'rollup', kind: 'procedure', language: 'other' });
    p.steps.push(createProgramStep({ op: 'read', tableId: t.id }));
    d.programs.push(p);
    d.notes.push(createNote({ position: { x: 0, y: 400 } }));
    return d;
  }

  it('is true for a move of a table, a code node or a note, a note resize, and a saved viewport', () => {
    const d = diagram();
    const moved: Diagram = {
      ...d,
      tables: [{ ...d.tables[0], position: { x: 50, y: 60 } }, d.tables[1]],
      programs: [{ ...d.programs[0], position: { x: -200, y: 10 } }],
      notes: [{ ...d.notes[0], position: { x: 5, y: 5 }, width: 400, height: 300 }],
      viewport: { x: 10, y: 20, zoom: 0.5 },
    };
    expect(onlyMoved(d, moved)).toBe(true);
  });

  it('is false for anything that changes what the diagram says', () => {
    const d = diagram();
    expect(onlyMoved(d, { ...d, name: 'other' })).toBe(false);
    expect(onlyMoved(d, { ...d, tables: [{ ...d.tables[0], name: 'purchases' }, d.tables[1]] })).toBe(false);
    expect(onlyMoved(d, { ...d, tables: [{ ...d.tables[0], position: { x: 1, y: 1 }, columns: [] }, d.tables[1]] })).toBe(false);
    expect(onlyMoved(d, { ...d, tables: [d.tables[1], d.tables[0]] })).toBe(false);
    expect(onlyMoved(d, { ...d, tables: [d.tables[0]] })).toBe(false);
    expect(onlyMoved(d, { ...d, programs: [{ ...d.programs[0], steps: [] }] })).toBe(false);
    expect(onlyMoved(d, { ...d, notes: [{ ...d.notes[0], text: 'hello' }] })).toBe(false);
    expect(onlyMoved(d, { ...d, relationships: [...d.relationships] })).toBe(false);
    expect(onlyMoved(d, { ...d, emphasis: 'code' })).toBe(false);
  });

  it('does not let a new field hide behind a moved position', () => {
    const d = diagram();
    const t = d.tables[0];
    expect(onlyMoved(d, { ...d, tables: [{ ...t, position: { x: 9, y: 9 }, comment: 'new' }, d.tables[1]] })).toBe(false);
  });
});
