import { describe, expect, it } from 'vitest';
import { buildJoinQuery, findPath, reachableTables } from '../src/lib/trace';
import { layoutDiagram } from '../src/lib/layout';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { sampleDiagram } from '../src/lib/sample';
import { pruneRelationships } from '../src/lib/model';

describe('findPath', () => {
  it('finds the shortest chain between two tables and builds a join', () => {
    const d = sampleDiagram();
    const customers = d.tables.find((t) => t.name === 'customers')!;
    const products = d.tables.find((t) => t.name === 'products')!;
    const res = findPath(d, customers.id, products.id);
    expect(res).not.toBeNull();
    expect(res!.tableIds.map((id) => d.tables.find((t) => t.id === id)!.name)).toEqual(['customers', 'orders', 'order_items', 'products']);
    expect(res!.hops).toHaveLength(3);
    const q = buildJoinQuery(d, res!);
    expect(q).toContain('FROM customers AS t0');
    expect(q).toContain('JOIN orders AS t1 ON t0.id = t1.customer_id');
    expect(q).toContain('JOIN order_items AS t2 ON t1.id = t2.order_id');
    expect(q).toContain('JOIN products AS t3 ON t2.product_id = t3.id');
  });

  it('returns null when no path exists and handles same-table', () => {
    const d = sampleDiagram();
    d.relationships = [];
    const [a, b] = d.tables;
    expect(findPath(d, a.id, b.id)).toBeNull();
    expect(findPath(d, a.id, a.id)?.tableIds).toEqual([a.id]);
  });

  it('follows data-flow links too', () => {
    const d = sampleDiagram();
    const addresses = d.tables.find((t) => t.name === 'addresses')!;
    const daily = d.tables.find((t) => t.name === 'daily_sales')!;
    const res = findPath(d, addresses.id, daily.id)!;
    expect(res).not.toBeNull();
    expect(reachableTables(d, addresses.id).size).toBe(d.tables.length);
  });
});

describe('layoutDiagram', () => {
  it('assigns non-overlapping positions and ranks parents before children', () => {
    const d = sampleDiagram();
    const pos = layoutDiagram(d, { direction: 'LR' });
    const byName = (n: string) => pos[d.tables.find((t) => t.name === n)!.id];
    expect(Object.keys(pos)).toHaveLength(d.tables.length);
    expect(byName('customers').x).toBeLessThan(byName('orders').x);
    expect(byName('orders').x).toBeLessThan(byName('order_items').x);
    // no two nodes share the same top-left corner
    const keys = new Set(Object.values(pos).map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(d.tables.length);
  });
});

describe('diagram file round-trip', () => {
  it('serialises and parses back to an equal diagram', () => {
    const d = sampleDiagram();
    const text = serializeDiagram(d);
    const back = parseDiagramFile(text);
    expect(back).toEqual(d);
  });

  it('rejects files that are not diagrams', () => {
    expect(() => parseDiagramFile('not json')).toThrow(/JSON/);
    expect(() => parseDiagramFile('{"foo": 1}')).toThrow(/tables/);
  });

  it('tolerates missing optional fields', () => {
    const d = parseDiagramFile(JSON.stringify({ tables: [{ id: 't1', name: 'x', columns: [{ id: 'c1', name: 'id' }] }] }));
    expect(d.dialect).toBe('postgresql');
    expect(d.tables[0].columns[0].type).toBe('TEXT');
    expect(d.tables[0].indexes).toEqual([]);
    expect(d.relationships).toEqual([]);
  });
});

describe('pruneRelationships', () => {
  it('drops relationships whose tables or columns vanished', () => {
    const d = sampleDiagram();
    const before = d.relationships.length;
    d.tables = d.tables.filter((t) => t.name !== 'orders');
    const pruned = pruneRelationships(d);
    expect(pruned.relationships.length).toBeLessThan(before);
    expect(pruned.relationships.every((r) => pruned.tables.some((t) => t.id === r.sourceTableId))).toBe(true);
  });
});
