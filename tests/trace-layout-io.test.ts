import { describe, expect, it } from 'vitest';
import { describeRelationship, normalizeVerb, relationshipVerb, verbsForKind } from '../src/shared/types';
import { buildJoinQuery, describeHop, findPath, reachableTables } from '../src/lib/trace';
import { layoutDiagram } from '../src/lib/layout';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { sampleDiagram } from '../src/lib/sample';
import { createRelationship, pruneRelationships, relationshipKindPatch } from '../src/lib/model';

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

  it('annotates hops the database cannot join instead of inventing a condition', () => {
    const d = sampleDiagram();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    const orderItems = d.tables.find((t) => t.name === 'order_items')!;
    const embed = d.relationships.find((r) => r.kind === 'embed')!;
    // isolate the serialized link so the trace has to walk it
    d.relationships = [embed];
    const res = findPath(d, orders.id, orderItems.id)!;
    expect(res.hops).toHaveLength(1);
    expect(describeHop(d, res.hops[0])).toContain('orders serializes order_items');
    const q = buildJoinQuery(d, res);
    expect(q).toContain('CROSS JOIN order_items AS t1');
    expect(q).toContain('stored in orders.items_snapshot');
    expect(q).not.toContain('JOIN order_items AS t1 ON');
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

describe('relationship verbs', () => {
  it('reads a connection in both directions', () => {
    const r = createRelationship({ kind: 'fk', verb: 'part-of', sourceTableId: 'a', sourceColumnIds: [], targetTableId: 'b', targetColumnIds: [] });
    expect(describeRelationship(r, 'order_items', 'orders', 'forward')).toBe('order_items is part of orders');
    expect(describeRelationship(r, 'order_items', 'orders', 'inverse')).toBe('orders contains order_items');
    const owned = { kind: 'fk', verb: 'belongs-to' } as const;
    expect(describeRelationship(owned, 'addresses', 'customers', 'inverse')).toBe('customers has addresses');
    const dep = { kind: 'dependency', verb: 'uses' } as const;
    expect(describeRelationship(dep, 'report', 'orders', 'inverse')).toBe('orders used by report');
  });

  it('falls back to the kind default and drops verbs that do not fit the kind', () => {
    expect(relationshipVerb({ kind: 'fk' }).id).toBe('references');
    expect(relationshipVerb({ kind: 'embed' }).id).toBe('serializes');
    // "feeds" only describes a data flow, so a foreign key carrying it reads as a plain reference
    expect(normalizeVerb('fk', 'feeds')).toBeUndefined();
    expect(relationshipVerb({ kind: 'fk', verb: 'feeds' }).id).toBe('references');
    expect(normalizeVerb('dependency', 'uses')).toBe('uses');
    expect(verbsForKind('flow').map((v) => v.id)).toEqual(['feeds', 'mirrors']);
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

  it('keeps the kind and verb of every connection through a round-trip', () => {
    const d = sampleDiagram();
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.relationships.map((r) => r.kind).sort()).toEqual(d.relationships.map((r) => r.kind).sort());
    const embed = back.relationships.find((r) => r.kind === 'embed')!;
    expect(embed.verb).toBe('serializes');
    expect(back.relationships.find((r) => r.verb === 'part-of')).toBeDefined();
  });

  it('reads files written before kinds and verbs existed', () => {
    const d = parseDiagramFile(
      JSON.stringify({
        tables: [
          { id: 't1', name: 'a', columns: [{ id: 'c1', name: 'id' }] },
          { id: 't2', name: 'b', columns: [{ id: 'c2', name: 'a_id' }] },
        ],
        relationships: [
          { id: 'r1', sourceTableId: 't2', sourceColumnIds: ['c2'], targetTableId: 't1', targetColumnIds: ['c1'] },
          { id: 'r2', kind: 'wormhole', sourceTableId: 't2', sourceColumnIds: ['c2'], targetTableId: 't1', targetColumnIds: ['c1'], verb: 'nibbles' },
        ],
      }),
    );
    expect(d.relationships.map((r) => r.kind)).toEqual(['fk', 'fk']);
    expect(d.relationships.every((r) => r.verb === undefined)).toBe(true);
    expect(relationshipVerb(d.relationships[0]).forward).toBe('references');
  });

  it('round-trips custom types (enum and composite)', () => {
    const d = sampleDiagram();
    d.customTypes.push(
      { id: 'ct1', name: 'mood', kind: 'enum', values: ['sad', 'happy'] },
      { id: 'ct2', name: 'address', kind: 'composite', fields: [{ id: 'f1', name: 'street', type: 'TEXT' }] },
    );
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.customTypes).toEqual(d.customTypes);
  });

  it('tolerates missing optional fields', () => {
    const d = parseDiagramFile(JSON.stringify({ tables: [{ id: 't1', name: 'x', columns: [{ id: 'c1', name: 'id' }] }] }));
    expect(d.dialect).toBe('postgresql');
    expect(d.tables[0].columns[0].type).toBe('TEXT');
    expect(d.tables[0].indexes).toEqual([]);
    expect(d.relationships).toEqual([]);
    expect(d.customTypes).toEqual([]);
  });
});

describe('relationshipKindPatch', () => {
  it('anchors a serialized copy to one column and drops the target side', () => {
    const d = sampleDiagram();
    const fk = d.relationships.find((r) => r.kind === 'fk' && r.sourceColumnIds.length > 0)!;
    expect(relationshipKindPatch(d, fk, 'embed')).toEqual({
      kind: 'embed',
      sourceColumnIds: [fk.sourceColumnIds[0]],
      targetColumnIds: [],
    });
  });

  it('fills in a column pair when something becomes a foreign key', () => {
    const d = sampleDiagram();
    const flow = d.relationships.find((r) => r.kind === 'flow')!;
    const src = d.tables.find((t) => t.id === flow.sourceTableId)!;
    const tgt = d.tables.find((t) => t.id === flow.targetTableId)!;
    expect(relationshipKindPatch(d, flow, 'fk')).toEqual({
      kind: 'fk',
      sourceColumnIds: [src.columns[0].id],
      targetColumnIds: [(tgt.columns.find((c) => c.primaryKey) ?? tgt.columns[0]).id],
    });
  });

  it('keeps the columns a foreign key already has', () => {
    const d = sampleDiagram();
    const dep = d.relationships.find((r) => r.kind === 'dependency')!;
    dep.sourceColumnIds = [d.tables.find((t) => t.id === dep.sourceTableId)!.columns[1].id];
    dep.targetColumnIds = [d.tables.find((t) => t.id === dep.targetTableId)!.columns[1].id];
    expect(relationshipKindPatch(d, dep, 'fk')).toEqual({
      kind: 'fk',
      sourceColumnIds: dep.sourceColumnIds,
      targetColumnIds: dep.targetColumnIds,
    });
  });

  it('touches nothing but the kind for the table-to-table kinds', () => {
    const d = sampleDiagram();
    const fk = d.relationships.find((r) => r.kind === 'fk')!;
    expect(relationshipKindPatch(d, fk, 'flow')).toEqual({ kind: 'flow' });
    expect(relationshipKindPatch(d, fk, 'dependency')).toEqual({ kind: 'dependency' });
  });

  it('cannot invent a column pair when a table has none', () => {
    const d = sampleDiagram();
    const flow = d.relationships.find((r) => r.kind === 'flow')!;
    d.tables.find((t) => t.id === flow.sourceTableId)!.columns = [];
    // the caller disables the row in that case; the patch stays honest either way
    expect(relationshipKindPatch(d, flow, 'fk')).toEqual({ kind: 'fk' });
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

  it('keeps table-to-table kinds when their anchor column is deleted, but drops a foreign key', () => {
    const d = sampleDiagram();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    // the serialized copy is anchored to items_snapshot; the FK needs customer_id
    orders.columns = orders.columns.filter((c) => c.name !== 'items_snapshot' && c.name !== 'customer_id');
    const fksFromOrders = (rels: typeof d.relationships) => rels.filter((r) => r.kind === 'fk' && r.sourceTableId === orders.id).length;
    expect(fksFromOrders(d.relationships)).toBe(2);
    const pruned = pruneRelationships(d);
    // the foreign key lost its column and goes; the serialized copy stays, just unanchored
    expect(fksFromOrders(pruned.relationships)).toBe(1);
    const embed = pruned.relationships.find((r) => r.kind === 'embed')!;
    expect(embed).toBeDefined();
    expect(embed.sourceColumnIds).toEqual([]);
  });
});
