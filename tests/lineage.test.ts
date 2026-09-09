import { describe, expect, it } from 'vitest';
import type { Column, Diagram } from '../src/shared/types';
import { createColumn, createDerivation, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import {
  buildLineage,
  columnOrigin,
  derivedColumnIds,
  describeColumnOrigin,
  downstream,
  flattenLineage,
  isDerivedColumn,
  lineageReach,
  lineageTotals,
  upstream,
  viewInputTables,
} from '../src/lib/lineage';
import { generateMarkdown } from '../src/lib/markdownExport';

/**
 * One schema for the whole file: raw `order_items` rows roll up into
 * `daily_sales`, which rolls up again into `monthly_sales`, with `orders`
 * reachable from `order_items` through a foreign key so a derivation can read
 * `orders.status`. A view sits on top of the last table.
 */
function fixture() {
  const col = (name: string, extra: Partial<Column> = {}) => createColumn({ name, ...extra });

  const orderStatus = col('status');
  const orderPlacedAt = col('placed_at', { type: 'DATE' });
  const orderId = col('id', { primaryKey: true });
  const orders = createTable({ name: 'orders', columns: [orderId, orderStatus, orderPlacedAt] });

  const itemOrderId = col('order_id');
  const itemProductId = col('product_id');
  const itemQuantity = col('quantity', { type: 'INTEGER' });
  const itemPrice = col('unit_price_cents', { type: 'INTEGER' });
  const orderItems = createTable({ name: 'order_items', columns: [itemOrderId, itemProductId, itemQuantity, itemPrice] });

  const dayProduct = col('product_id');
  const dayDay = col('day', { type: 'DATE' });
  const dayUnits = col('units_sold', { type: 'INTEGER' });
  const dayRevenue = col('revenue_cents', { type: 'INTEGER' });
  const dailySales = createTable({ name: 'daily_sales', columns: [dayProduct, dayDay, dayUnits, dayRevenue] });

  const monthProduct = col('product_id');
  const monthRevenue = col('revenue_cents', { type: 'INTEGER' });
  const monthlySales = createTable({ name: 'monthly_sales', columns: [monthProduct, monthRevenue] });

  const viewProduct = col('product_id');
  const topProducts = createTable({ name: 'top_products', kind: 'view', viewSql: 'SELECT product_id FROM monthly_sales', columns: [viewProduct] });

  const itemsToOrders = createRelationship({
    kind: 'fk',
    sourceTableId: orderItems.id,
    sourceColumnIds: [itemOrderId.id],
    targetTableId: orders.id,
    targetColumnIds: [orderId.id],
  });

  const rollup = createRelationship({
    kind: 'flow',
    sourceTableId: orderItems.id,
    sourceColumnIds: [],
    targetTableId: dailySales.id,
    targetColumnIds: [],
    derivations: [
      createDerivation({ targetColumnId: dayUnits.id, expression: 'quantity', aggregate: 'SUM', groupBy: ['product_id', 'day'], filter: "orders.status = 'paid'" }),
      createDerivation({ targetColumnId: dayRevenue.id, expression: 'quantity * unit_price_cents', aggregate: 'SUM', groupBy: ['product_id', 'day'] }),
    ],
  });

  const monthRollup = createRelationship({
    kind: 'flow',
    sourceTableId: dailySales.id,
    sourceColumnIds: [],
    targetTableId: monthlySales.id,
    targetColumnIds: [],
    derivations: [createDerivation({ targetColumnId: monthRevenue.id, expression: 'revenue_cents', aggregate: 'SUM', groupBy: ['product_id'] })],
  });

  const viewFlow = createRelationship({
    kind: 'flow',
    sourceTableId: monthlySales.id,
    sourceColumnIds: [],
    targetTableId: topProducts.id,
    targetColumnIds: [],
  });

  const diagram: Diagram = {
    ...emptyDiagram(),
    tables: [orders, orderItems, dailySales, monthlySales, topProducts],
    relationships: [itemsToOrders, rollup, monthRollup, viewFlow],
  };
  return {
    diagram,
    orders,
    orderItems,
    dailySales,
    monthlySales,
    topProducts,
    cols: { orderStatus, itemQuantity, itemPrice, itemProductId, dayProduct, dayDay, dayUnits, dayRevenue, monthProduct, monthRevenue, viewProduct },
    rels: { rollup, monthRollup, itemsToOrders },
  };
}

describe('what a data flow fills', () => {
  it('marks the target column of every complete derivation', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    expect(isDerivedColumn(l, f.cols.dayUnits.id)).toBe(true);
    expect(isDerivedColumn(l, f.cols.dayRevenue.id)).toBe(true);
    expect(columnOrigin(l, f.cols.itemQuantity.id)).toBe('stored');
    expect(l.filledBy.get(f.cols.dayUnits.id)?.[0].summary).toBe("units_sold = SUM(quantity) GROUP BY product_id, day WHERE orders.status = 'paid'");
  });

  it('counts a group key that names a target column as filling it', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    // Neither entry targets product_id or day; both are carried over as group keys.
    const carried = l.filledBy.get(f.cols.dayProduct.id) ?? [];
    expect(carried).toHaveLength(1);
    expect(carried[0].derivation).toBeNull();
    expect(carried[0].groupKey).toBe('product_id');
    expect(carried[0].summary).toBe('product_id = product_id (group key)');
    expect(isDerivedColumn(l, f.cols.dayDay.id)).toBe(true);
  });

  it('leaves an incomplete entry out, the way the generator does', () => {
    const f = fixture();
    const flow = f.diagram.relationships.find((r) => r.id === f.rels.monthRollup.id)!;
    flow.derivations = [createDerivation({ targetColumnId: f.cols.monthRevenue.id, expression: '   ', groupBy: [] })];
    const l = buildLineage(f.diagram);
    expect(isDerivedColumn(l, f.cols.monthRevenue.id)).toBe(false);
  });

  it('ignores an entry pointing at a column that has been deleted', () => {
    const f = fixture();
    const daily = f.diagram.tables.find((t) => t.id === f.dailySales.id)!;
    daily.columns = daily.columns.filter((c) => c.id !== f.cols.dayUnits.id);
    const l = buildLineage(f.diagram);
    expect(l.filledBy.has(f.cols.dayUnits.id)).toBe(false);
    expect(isDerivedColumn(l, f.cols.dayRevenue.id)).toBe(true);
  });

  it('treats every column of a view as computed, without inventing a formula', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    expect(columnOrigin(l, f.cols.viewProduct.id)).toBe('view');
    expect(derivedColumnIds(l, f.topProducts)).toEqual([f.cols.viewProduct.id]);
    expect(describeColumnOrigin(l, f.cols.viewProduct.id)).toBe('Computed by the view’s SELECT');
    expect(viewInputTables(f.diagram, f.topProducts.id).map((t) => t.name)).toEqual(['monthly_sales']);
  });
});

describe('what a derivation reads', () => {
  it('resolves bare names against the source table', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    const revenue = l.filledBy.get(f.cols.dayRevenue.id)![0];
    expect(revenue.inputs.map((i) => i.columnId)).toEqual([f.cols.itemQuantity.id, f.cols.itemPrice.id, f.cols.itemProductId.id]);
    expect(revenue.inputs.every((i) => !i.viaForeignKey)).toBe(true);
  });

  it('follows foreign keys for table.column, and says it did', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    const units = l.filledBy.get(f.cols.dayUnits.id)![0];
    const status = units.inputs.find((i) => i.columnId === f.cols.orderStatus.id);
    expect(status?.viaForeignKey).toBe(true);
    expect(l.feeds.get(f.cols.orderStatus.id)).toHaveLength(1);
  });

  it('drops a reference to a table the source cannot reach', () => {
    const f = fixture();
    const flow = f.diagram.relationships.find((r) => r.id === f.rels.rollup.id)!;
    flow.derivations = [createDerivation({ targetColumnId: f.cols.dayUnits.id, expression: 'customers.name', groupBy: [] })];
    const l = buildLineage(f.diagram);
    expect(l.filledBy.get(f.cols.dayUnits.id)![0].inputs).toEqual([]);
  });

  it('survives an expression that does not parse', () => {
    const f = fixture();
    const flow = f.diagram.relationships.find((r) => r.id === f.rels.rollup.id)!;
    flow.derivations = [createDerivation({ targetColumnId: f.cols.dayUnits.id, expression: 'quantity +', groupBy: [] })];
    const l = buildLineage(f.diagram);
    expect(isDerivedColumn(l, f.cols.dayUnits.id)).toBe(true);
    expect(l.filledBy.get(f.cols.dayUnits.id)![0].inputs).toEqual([]);
  });

  it('reads the columns a sequence operation orders and partitions by', () => {
    const d = emptyDiagram();
    const ts = createColumn({ name: 'ts', type: 'TIMESTAMP' });
    const device = createColumn({ name: 'device_id' });
    const readings = createTable({ name: 'readings', columns: [ts, device] });
    const gap = createColumn({ name: 'gap_seconds', type: 'INTEGER' });
    const gaps = createTable({ name: 'gaps', columns: [gap] });
    d.tables = [readings, gaps];
    d.relationships = [
      createRelationship({
        kind: 'flow',
        sourceTableId: readings.id,
        sourceColumnIds: [],
        targetTableId: gaps.id,
        targetColumnIds: [],
        derivations: [createDerivation({ targetColumnId: gap.id, expression: 'ts', groupBy: [], window: { fn: 'DIFF', orderBy: ['ts DESC'], partitionBy: ['device_id'] } })],
      }),
    ];
    const l = buildLineage(d);
    expect(l.filledBy.get(gap.id)![0].inputs.map((i) => i.columnId).sort()).toEqual([ts.id, device.id].sort());
  });
});

describe('walking the chain', () => {
  it('follows a column back through every flow that feeds it', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    const rows = flattenLineage(upstream(l, f.cols.monthRevenue.id));
    const names = rows.map((n) => `${l.tableById.get(n.tableId)!.name}.${l.columnById.get(n.columnId)!.name}`);
    expect(names).toContain('daily_sales.revenue_cents');
    // …and on through the flow that fills daily_sales.
    expect(names).toContain('order_items.quantity');
    expect(names).toContain('order_items.unit_price_cents');
  });

  it('follows a stored column forward to everything computed from it', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    const rows = flattenLineage(downstream(l, f.cols.itemQuantity.id));
    const names = rows.map((n) => `${l.tableById.get(n.tableId)!.name}.${l.columnById.get(n.columnId)!.name}`);
    expect(names).toContain('daily_sales.units_sold');
    expect(names).toContain('daily_sales.revenue_cents');
    expect(names).toContain('monthly_sales.revenue_cents');
  });

  it('stops rather than looping when two flows feed each other', () => {
    const d = emptyDiagram();
    const a = createColumn({ name: 'total', type: 'INTEGER' });
    const b = createColumn({ name: 'total', type: 'INTEGER' });
    const ta = createTable({ name: 'a', columns: [a] });
    const tb = createTable({ name: 'b', columns: [b] });
    d.tables = [ta, tb];
    d.relationships = [
      createRelationship({ kind: 'flow', sourceTableId: ta.id, sourceColumnIds: [], targetTableId: tb.id, targetColumnIds: [], derivations: [createDerivation({ targetColumnId: b.id, expression: 'total', groupBy: [] })] }),
      createRelationship({ kind: 'flow', sourceTableId: tb.id, sourceColumnIds: [], targetTableId: ta.id, targetColumnIds: [], derivations: [createDerivation({ targetColumnId: a.id, expression: 'total', groupBy: [] })] }),
    ];
    const l = buildLineage(d);
    const rows = flattenLineage(upstream(l, a.id));
    expect(rows.some((n) => n.repeated)).toBe(true);
    expect(rows.length).toBeLessThan(5);
  });

  it('gives up at the depth limit and says so', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    const root = upstream(l, f.cols.monthRevenue.id, { maxDepth: 1 });
    expect(flattenLineage(root).every((n) => n.depth <= 1)).toBe(true);
    expect(flattenLineage(root).some((n) => n.truncated)).toBe(true);
  });

  it('reports the tables and flows a chain touches, for the canvas to highlight', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    // orders is read only by units_sold, which revenue_cents never passes through,
    // so a lineage is narrower than "every table upstream of this one".
    const reach = lineageReach(upstream(l, f.cols.monthRevenue.id));
    expect([...reach.tableIds].sort()).toEqual([f.orderItems.id, f.dailySales.id, f.monthlySales.id].sort());
    expect([...reach.relationshipIds].sort()).toEqual([f.rels.rollup.id, f.rels.monthRollup.id].sort());
    expect(lineageReach(upstream(l, f.cols.dayUnits.id)).tableIds.has(f.orders.id)).toBe(true);
  });
});

describe('summaries', () => {
  it('counts computed against stored across the diagram', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    // daily_sales: 4 of 4 · monthly_sales: revenue_cents and the carried product_id · top_products: 1 view column.
    expect(lineageTotals(l, f.diagram)).toEqual({ derived: 7, tables: 3, stored: 7 });
  });

  it('says what fills a column and where it comes from', () => {
    const f = fixture();
    const l = buildLineage(f.diagram);
    expect(describeColumnOrigin(l, f.cols.dayRevenue.id)).toBe('revenue_cents = SUM(quantity * unit_price_cents) GROUP BY product_id, day — from order_items');
    expect(describeColumnOrigin(l, f.cols.itemQuantity.id)).toBeNull();
  });

  it('is empty for a diagram with no flows at all', () => {
    const d = emptyDiagram();
    d.tables = [createTable({ name: 'people', columns: [createColumn({ name: 'id', primaryKey: true })] })];
    const l = buildLineage(d);
    expect(lineageTotals(l, d)).toEqual({ derived: 0, tables: 0, stored: 1 });
    expect(derivedColumnIds(l, d.tables[0])).toEqual([]);
  });
});

describe('the data dictionary', () => {
  it('flags derived columns and lists how each one is computed', () => {
    const f = fixture();
    const md = generateMarkdown(f.diagram, { includeMermaid: false });
    const daily = md.slice(md.indexOf('### daily_sales'), md.indexOf('### monthly_sales'));
    expect(daily).toContain('| units_sold | INTEGER | yes |  | DERIVED |');
    expect(daily).toContain('**Derived columns**');
    // Underscores are left alone on purpose; a `*` in an expression is escaped.
    expect(daily).toContain('| revenue_cents | revenue_cents = SUM(quantity \\* unit_price_cents) GROUP BY product_id, day | order_items |');
    expect(daily).toContain('| product_id | product_id = product_id (group key) | order_items |');
    // A raw table says nothing about derivations at all.
    const items = md.slice(md.indexOf('### order_items'), md.indexOf('### daily_sales'));
    expect(items).not.toContain('DERIVED');
  });
});
