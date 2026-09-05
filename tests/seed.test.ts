import { describe, expect, it } from 'vitest';
import { createColumn, createIndex, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { sampleDiagram } from '../src/lib/sample';
import { generateSchema } from '../src/lib/sql/generator';
import { getSqliteEngine } from '../src/lib/sqlite/engine';
import { generateSeed, literal, mulberry32 } from '../src/lib/seed';

describe('seed data', () => {
  it('is deterministic for a given seed and differs for another', () => {
    const d = sampleDiagram();
    const a = generateSeed(d, { rows: 6, seed: 42 });
    const b = generateSeed(d, { rows: 6, seed: 42 });
    const c = generateSeed(d, { rows: 6, seed: 43 });
    expect(a.script).toBe(b.script);
    expect(a.script).not.toBe(c.script);
    expect(a.totalRows).toBe(36); // 6 tables (views and the external CRM group are skipped)
    expect(Object.keys(a.rowCounts)).toHaveLength(6);
    const r = mulberry32(7);
    expect([r(), r()]).toEqual([mulberry32(7)(), mulberry32(7) && (() => { const x = mulberry32(7); x(); return x(); })()]);
  });

  it('orders parents first, points foreign keys at generated parents and never repeats unique values', () => {
    const d = sampleDiagram();
    const out = generateSeed(d, { rows: 5, seed: 1 });
    const names = out.script.split('\n').filter((l) => l.startsWith('-- ') && / \(\d+ rows?\)$/.test(l)).map((l) => l.slice(3).replace(/ \(.*$/, ''));
    expect(names.indexOf('customers')).toBeLessThan(names.indexOf('orders'));
    expect(names.indexOf('orders')).toBeLessThan(names.indexOf('order_items'));
    const customerInsert = out.statements.find((s) => s.startsWith('INSERT INTO customers'))!;
    const emails = [...customerInsert.matchAll(/'([^']+@[^']+)'/g)].map((m) => m[1]);
    expect(new Set(emails).size).toBe(5);
    const orderInsert = out.statements.find((s) => s.startsWith('INSERT INTO orders'))!;
    const rows = orderInsert.split('\n').slice(1);
    for (const row of rows) {
      const customerId = Number(/^\s*\(\d+, (\d+),/.exec(row)?.[1]);
      expect(customerId).toBeGreaterThanOrEqual(1);
      expect(customerId).toBeLessThanOrEqual(5);
    }
  });

  it('honours enums, CHECK lists and ranges, NOT NULL and unique indexes', () => {
    const d = emptyDiagram('postgresql');
    d.customTypes.push({ id: 'ct', name: 'mood', kind: 'enum', values: ['happy', 'sad'] });
    const t = createTable({
      name: 'things',
      columns: [
        createColumn({ name: 'id', type: 'SERIAL', primaryKey: true, autoIncrement: true, nullable: false }),
        createColumn({ name: 'mood', type: 'mood', nullable: false }),
        createColumn({ name: 'size', type: 'VARCHAR(2)', nullable: false, check: "size IN ('S', 'M', 'L')" }),
        createColumn({ name: 'qty', type: 'INTEGER', nullable: false, check: 'qty >= 3 AND qty <= 5' }),
        createColumn({ name: 'code', type: 'VARCHAR(10)', nullable: false }),
        createColumn({ name: 'ok', type: 'BOOLEAN', nullable: false }),
      ],
    });
    t.indexes.push(createIndex({ name: 'uq_code', columnIds: [t.columns[4].id], unique: true }));
    d.tables.push(t);
    const out = generateSeed(d, { rows: 20, seed: 5, nullRate: 0 });
    const rows = out.statements[0].split('\n').slice(1);
    expect(rows).toHaveLength(20);
    const codes = new Set<string>();
    for (const row of rows) {
      const m = /^\s*\((\d+), '(\w+)', '(\w)', (\d+), '([^']+)', (TRUE|FALSE)\)[,;]$/.exec(row);
      expect(m, row).not.toBeNull();
      expect(['happy', 'sad']).toContain(m![2]);
      expect(['S', 'M', 'L']).toContain(m![3]);
      expect(Number(m![4])).toBeGreaterThanOrEqual(3);
      expect(Number(m![4])).toBeLessThanOrEqual(5);
      codes.add(m![5]);
    }
    expect(codes.size).toBe(20);
    expect(out.statements.at(-1)).toContain("setval(pg_get_serial_sequence('things', 'id')");
  });

  it('enumerates join-table pairs without repeating and caps the row count', () => {
    const d = emptyDiagram('sqlite');
    const a = createTable({ name: 'a', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false })] });
    const b = createTable({ name: 'b', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false })] });
    const ab = createTable({
      name: 'ab',
      columns: [createColumn({ name: 'a_id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'b_id', type: 'INTEGER', primaryKey: true, nullable: false })],
    });
    d.tables.push(a, b, ab);
    d.relationships.push(
      createRelationship({ kind: 'fk', sourceTableId: ab.id, sourceColumnIds: [ab.columns[0].id], targetTableId: a.id, targetColumnIds: [a.columns[0].id] }),
      createRelationship({ kind: 'fk', sourceTableId: ab.id, sourceColumnIds: [ab.columns[1].id], targetTableId: b.id, targetColumnIds: [b.columns[0].id] }),
    );
    const out = generateSeed(d, { rows: 3, seed: 1, perTable: { [ab.id]: 20 } });
    expect(out.rowCounts[ab.id]).toBe(9);
    expect(out.warnings.some((w) => w.includes('9 distinct combinations'))).toBe(true);
    const pairs = out.statements.find((s) => s.startsWith('INSERT INTO ab'))!.split('\n').slice(1).map((l) => l.trim().replace(/[,;]$/, ''));
    expect(new Set(pairs).size).toBe(9);
  });

  it('renders literals per dialect', () => {
    const pg = emptyDiagram('postgresql');
    const my = emptyDiagram('mariadb');
    expect(literal(true, pg)).toBe('TRUE');
    expect(literal(true, my)).toBe('1');
    expect(literal(null, pg)).toBe('NULL');
    expect(literal("it's", pg)).toBe("'it''s'");
    expect(literal(12.5, pg)).toBe('12.5');
    expect(literal({ hex: 'ff00' }, pg)).toBe("'\\xff00'");
    expect(literal({ hex: 'ff00' }, my)).toBe("X'ff00'");
  });

  it('inserts into a real SQLite database with every foreign key satisfied', async () => {
    const engine = await getSqliteEngine();
    await engine.reset();
    const d = { ...sampleDiagram(), dialect: 'sqlite' as const };
    await engine.exec(generateSchema(d).statements, true);
    const seed = generateSeed(d, { rows: 12, seed: 9 });
    const results = await engine.exec(seed.statements, true);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const violations = await engine.query('PRAGMA foreign_key_check');
    expect(violations.rows).toEqual([]);
    const count = await engine.query('SELECT COUNT(*) FROM order_items');
    expect(count.rows[0][0]).toBe(12);
  });
});
