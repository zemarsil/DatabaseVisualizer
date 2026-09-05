import { beforeEach, describe, expect, it } from 'vitest';
import { firstKeyword, isReadOnlySql, serializeCell, splitStatements } from '../server/db/values';
import { clearHistory, loadHistory, pushHistory } from '../src/lib/queryHistory';

describe('serializeCell', () => {
  it('makes driver values JSON-safe', () => {
    expect(serializeCell(null)).toBeNull();
    expect(serializeCell(undefined)).toBeNull();
    expect(serializeCell(10n)).toBe('10');
    expect(serializeCell(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)))).toBe('2024-01-02T03:04:05.000Z');
    expect(serializeCell(Buffer.from([0xde, 0xad]))).toBe('\\xdead');
    expect(String(serializeCell(Buffer.alloc(300)))).toMatch(/…$/);
    expect(serializeCell([1n, [new Date(0)]])).toEqual(['1', ['1970-01-01T00:00:00.000Z']]);
    expect(serializeCell({ a: 1 })).toBe('{"a":1}');
    expect(serializeCell('x')).toBe('x');
    expect(serializeCell(true)).toBe(true);
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const sql = `SELECT ';' AS a; -- comment; not a split\nSELECT "b;c" /* ; */ FROM t;\nSELECT $$x;y$$;\n\n;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(`SELECT ';' AS a`);
    expect(parts[1]).toContain('"b;c"');
    expect(parts[2]).toBe('SELECT $$x;y$$');
    expect(splitStatements('  ')).toEqual([]);
    expect(splitStatements('-- only a comment')).toEqual([]);
  });
});

describe('isReadOnlySql', () => {
  it('accepts read statements and rejects writes anywhere in the script', () => {
    expect(isReadOnlySql('SELECT 1')).toBe(true);
    expect(isReadOnlySql('  -- note\n  with x as (select 1) select * from x')).toBe(true);
    expect(isReadOnlySql('EXPLAIN SELECT 1; SHOW TABLES')).toBe(true);
    expect(isReadOnlySql('SELECT 1; DELETE FROM t')).toBe(false);
    expect(isReadOnlySql('insert into t values (1)')).toBe(false);
    expect(isReadOnlySql('')).toBe(false);
    expect(firstKeyword('/* c */ (SELECT 1)')).toBe('SELECT');
  });
});

describe('queryHistory', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it('keeps distinct queries newest first with a cap', () => {
    pushHistory('select 1');
    pushHistory('select 2');
    pushHistory('select 1 ');
    const h = loadHistory();
    expect(h.map((e) => e.sql)).toEqual(['select 1', 'select 2']);
    for (let i = 0; i < 40; i++) pushHistory(`select ${i + 10}`);
    expect(loadHistory()).toHaveLength(30);
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});
