import { describe, expect, it } from 'vitest';
import { relationshipVerb, type Diagram, type Relationship } from '../src/shared/types';
import { generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { annotationComment, collectAnnotations, readAnnotations } from '../src/lib/sql/annotations';
import { createDerivation, createGroup, createRelationship, createTable, emptyDiagram } from '../src/lib/model';

const SHOP = `
CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE);
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  payload JSONB,
  placed_at TIMESTAMP,
  total NUMERIC(10,2)
);
CREATE TABLE daily_totals (day DATE PRIMARY KEY, revenue NUMERIC(12,2), gap NUMERIC(12,2));
CREATE TABLE line_items (order_id BIGINT, sku TEXT);
CREATE TABLE reports (id INT PRIMARY KEY);
`;

const ROLLUP_SQL = `INSERT INTO daily_totals (day, revenue)
SELECT CAST(placed_at AS DATE), SUM(total)
FROM orders
WHERE total > 0
GROUP BY 1;`;

/** A diagram with one of every connection kind, each carrying the SQL and prose a user would tag on. */
function shop(): Diagram {
  const d = emptyDiagram('postgresql', 'Shop');
  const r = importSql(SHOP, 'postgresql');
  d.tables = r.tables;
  d.relationships = r.relationships;

  const table = (name: string) => d.tables.find((t) => t.name === name)!;
  const column = (t: string, c: string) => table(t).columns.find((x) => x.name === c)!.id;

  // the foreign key the DDL already carries, plus what it cannot say
  const fk = d.relationships.find((x) => x.kind === 'fk')!;
  fk.verb = 'belongs-to';
  fk.inverseName = 'has';
  fk.query = 'SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id;';
  fk.note = 'One customer, many orders.';

  d.relationships.push(
    createRelationship({
      kind: 'flow',
      verb: 'feeds',
      name: 'nightly rollup',
      sourceTableId: table('orders').id,
      sourceColumnIds: [],
      targetTableId: table('daily_totals').id,
      targetColumnIds: [],
      query: ROLLUP_SQL,
      note: 'Runs at 03:00 UTC.',
      derivations: [
        createDerivation({ targetColumnId: column('daily_totals', 'revenue'), expression: 'total', aggregate: 'SUM', groupBy: ['CAST(placed_at AS DATE)'], filter: "status = 'paid'" }),
        createDerivation({
          targetColumnId: column('daily_totals', 'gap'),
          expression: 'placed_at',
          aggregate: 'AVG',
          groupBy: [],
          window: { fn: 'DIFF', orderBy: ['placed_at'], partitionBy: ['customer_id'] },
        }),
      ],
    }),
    createRelationship({
      kind: 'embed',
      verb: 'serializes',
      name: 'items in payload',
      sourceTableId: table('orders').id,
      sourceColumnIds: [column('orders', 'payload')],
      targetTableId: table('line_items').id,
      targetColumnIds: [],
      query: "SELECT jsonb_array_elements(payload) FROM orders;",
    }),
    createRelationship({
      kind: 'dependency',
      verb: 'uses',
      sourceTableId: table('reports').id,
      sourceColumnIds: [],
      targetTableId: table('orders').id,
      targetColumnIds: [],
      note: 'The weekly report reads orders directly.',
    }),
  );
  return d;
}

/** Export to SQL and read the script straight back, the way a saved .sql file comes home. */
function roundTrip(d: Diagram): { script: string; relationships: Relationship[]; warnings: string[]; names: Map<string, string> } {
  const script = generateSchema(d).script;
  const back = importSql(script, d.dialect);
  return { script, relationships: back.relationships, warnings: back.warnings, names: new Map(back.tables.map((t) => [t.id, t.name])) };
}

describe('connection metadata in the generated script', () => {
  it('brings every connection back, with the SQL tagged on it', () => {
    const { script, relationships, warnings, names } = roundTrip(shop());
    expect(warnings).toEqual([]);
    const find = (kind: string, from: string, to: string) =>
      relationships.find((r) => r.kind === kind && names.get(r.sourceTableId) === from && names.get(r.targetTableId) === to);

    // the block is a comment: nothing in it is executable
    for (const line of script.slice(script.indexOf('-- dbviz:connections')).split('\n')) {
      if (line.trim()) expect(line.startsWith('--')).toBe(true);
    }

    const fk = find('fk', 'orders', 'customers')!;
    expect(fk).toBeDefined();
    expect(relationships.filter((r) => r.kind === 'fk')).toHaveLength(1); // enriched, not duplicated
    expect(fk.onDelete).toBe('CASCADE');
    expect(relationshipVerb(fk).forward).toBe('belongs to');
    expect(fk.inverseName).toBe('has');
    expect(fk.query).toContain('JOIN customers');
    expect(fk.note).toBe('One customer, many orders.');

    const flow = find('flow', 'orders', 'daily_totals')!;
    expect(flow.name).toBe('nightly rollup');
    expect(flow.query).toBe(ROLLUP_SQL);
    expect(flow.note).toBe('Runs at 03:00 UTC.');
    expect(flow.derivations).toHaveLength(2);
    const revenue = flow.derivations![0];
    expect(revenue.aggregate).toBe('SUM');
    expect(revenue.expression).toBe('total');
    expect(revenue.groupBy).toEqual(['CAST(placed_at AS DATE)']);
    expect(revenue.filter).toBe("status = 'paid'");
    expect(flow.derivations![1].window).toEqual({ fn: 'DIFF', orderBy: ['placed_at'], partitionBy: ['customer_id'] });

    const embed = find('embed', 'orders', 'line_items')!;
    expect(embed.query).toContain('jsonb_array_elements');
    // the column the rows are serialized into survives, because columns are named too
    const orders = [...names.entries()].find(([, n]) => n === 'orders')![0];
    const payload = { id: embed.sourceColumnIds[0] };
    expect(payload.id).toBeTruthy();
    expect(relationships.some((r) => r.sourceTableId === orders && r.kind === 'embed')).toBe(true);

    const dep = find('dependency', 'reports', 'orders')!;
    expect(dep.note).toBe('The weekly report reads orders directly.');
    expect(relationshipVerb(dep).forward).toBe('uses');
  });

  it('names the derived target column rather than its id, so a re-import resolves it', () => {
    const { relationships, names } = roundTrip(shop());
    const flow = relationships.find((r) => r.kind === 'flow')!;
    const target = relationships.length && names.get(flow.targetTableId);
    expect(target).toBe('daily_totals');
    // the ids are fresh, so the derivation can only have found its column by name
    expect(flow.derivations!.every((dv) => dv.targetColumnId)).toBe(true);
  });

  it('settles down: every round trip after the first writes the same block', () => {
    const again = (script: string) => {
      const d = emptyDiagram('postgresql', 'Shop');
      const back = importSql(script, 'postgresql');
      d.tables = back.tables;
      d.relationships = back.relationships;
      return generateSchema(d).script;
    };
    // The first pass does add one thing: an unnamed foreign key comes back
    // carrying the constraint name the DDL had to invent for it.
    const second = again(generateSchema(shop()).script);
    expect(readAnnotations(again(second)).annotations).toEqual(readAnnotations(second).annotations);
  });

  it('writes nothing when every connection is already a foreign key', () => {
    const d = emptyDiagram('postgresql', 'Plain');
    const r = importSql('CREATE TABLE a (id INT PRIMARY KEY);\nCREATE TABLE b (a_id INT REFERENCES a(id));', 'postgresql');
    d.tables = r.tables;
    d.relationships = r.relationships;
    const script = generateSchema(d).script;
    expect(script).not.toContain('dbviz:connections');
    expect(importSql(script, 'postgresql').warnings).toEqual([]);
  });

  it('keeps a foreign key the generator could not emit, so nothing local is lost', () => {
    // A cycle pushes one foreign key out of the CREATE TABLE and into an ALTER;
    // one that fails to emit at all still has to come back.
    const d = shop();
    const a = collectAnnotations(d, new Set());
    expect(a.connections.some((c) => c.kind === 'fk' && c.from === 'orders' && c.to === 'customers')).toBe(true);
  });

  it('leaves out a connection into another database, which the script never creates', () => {
    const d = shop();
    const g = createGroup({ name: 'Warehouse', external: true });
    d.groups.push(g);
    d.tables.find((t) => t.name === 'customers')!.groupId = g.id;
    const a = collectAnnotations(d, new Set());
    expect(a.connections.some((c) => c.to === 'customers')).toBe(false);
    // everything that stayed at home is still there
    expect(a.connections.some((c) => c.kind === 'flow' && c.to === 'daily_totals')).toBe(true);
  });

  it('reports a connection whose other end is not in the script', () => {
    const d = shop();
    const script = generateSchema(d).script;
    // drop the dependency's source table from the DDL but leave the block alone
    const trimmed = script.replace(/CREATE TABLE reports \([^;]*\);/, '');
    const back = importSql(trimmed, 'postgresql');
    expect(back.warnings.some((w) => w.includes('reports') && w.includes('not restored'))).toBe(true);
    expect(back.tables.some((t) => t.name === 'reports')).toBe(false);
  });

  it('does not add a connection the diagram already has', () => {
    const d = shop();
    const script = generateSchema(d).script;
    const first = importSql(script, 'postgresql');
    const loaded = { ...d, tables: first.tables, relationships: first.relationships };
    // re-importing only the block, with no CREATE TABLE to rename anything
    const blockOnly = annotationComment(collectAnnotations(loaded, new Set(first.relationships.filter((r) => r.kind === 'fk').map((r) => r.id))));
    const again = importSql(blockOnly, 'postgresql', loaded);
    expect(again.relationships).toEqual([]);
    expect(again.warnings.some((w) => w.includes('already in the diagram'))).toBe(true);
  });

  it('keeps two connections of one kind between the same pair apart', () => {
    const d = emptyDiagram('postgresql', 'Twins');
    const a = createTable({ name: 'events' });
    const b = createTable({ name: 'rollup' });
    d.tables = [a, b];
    d.relationships = [
      createRelationship({ kind: 'flow', name: 'hourly', sourceTableId: a.id, sourceColumnIds: [], targetTableId: b.id, targetColumnIds: [], query: 'SELECT 1;' }),
      createRelationship({ kind: 'flow', name: 'nightly', sourceTableId: a.id, sourceColumnIds: [], targetTableId: b.id, targetColumnIds: [], query: 'SELECT 2;' }),
    ];
    const back = importSql(generateSchema(d).script, 'postgresql');
    expect(back.relationships.map((r) => r.name)).toEqual(['hourly', 'nightly']);
    expect(back.relationships.map((r) => r.query)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('reads both blocks when two exported scripts are pasted together', () => {
    const first = emptyDiagram('postgresql', 'One');
    const a = createTable({ name: 'a' });
    const b = createTable({ name: 'b' });
    first.tables = [a, b];
    first.relationships = [createRelationship({ kind: 'dependency', sourceTableId: a.id, sourceColumnIds: [], targetTableId: b.id, targetColumnIds: [], note: 'first' })];

    const second = emptyDiagram('postgresql', 'Two');
    const c = createTable({ name: 'c' });
    const e = createTable({ name: 'd' });
    second.tables = [c, e];
    second.relationships = [createRelationship({ kind: 'dependency', sourceTableId: c.id, sourceColumnIds: [], targetTableId: e.id, targetColumnIds: [], note: 'second' })];

    const back = importSql(`${generateSchema(first).script}\n${generateSchema(second).script}`, 'postgresql');
    expect(back.warnings).toEqual([]);
    expect(back.relationships.map((r) => r.note).sort()).toEqual(['first', 'second']);
  });

  it('imports the schema anyway when the block is damaged', () => {
    const script = generateSchema(shop()).script;
    const broken = script.replace('"connections"', '"connections');
    const back = importSql(broken, 'postgresql');
    expect(back.tables.length).toBeGreaterThan(0);
    expect(back.warnings.some((w) => w.includes('could not be read'))).toBe(true);
  });

  it('says so rather than guessing when the block is from a newer build', () => {
    const script = generateSchema(shop()).script.replace('dbviz:connections v1', 'dbviz:connections v2');
    const back = importSql(script, 'postgresql');
    expect(back.warnings.some((w) => w.includes('version 2'))).toBe(true);
    expect(back.relationships.filter((r) => r.kind === 'flow')).toHaveLength(0);
  });

  it('leaves a script that has no block exactly as it was', () => {
    const back = importSql(SHOP, 'postgresql');
    expect(back.warnings).toEqual([]);
    expect(back.relationships).toHaveLength(1);
  });

  it('survives a query containing comment markers and quotes', () => {
    const d = emptyDiagram('postgresql', 'Edge');
    const a = createTable({ name: 'a' });
    const b = createTable({ name: 'b' });
    d.tables = [a, b];
    const query = "/* a block comment */ SELECT '--not a comment', \"quoted\" FROM a; -- trailing\nSELECT 1;";
    d.relationships = [createRelationship({ kind: 'dependency', sourceTableId: a.id, sourceColumnIds: [], targetTableId: b.id, targetColumnIds: [], query })];
    const script = generateSchema(d).script;
    const back = importSql(script, 'postgresql');
    expect(back.relationships).toHaveLength(1);
    expect(back.relationships[0].query).toBe(query);
  });
});
