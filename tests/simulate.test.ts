import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { createDerivation, createRelationship, emptyDiagram } from '../src/lib/model';
import { sampleDiagram } from '../src/lib/sample';
import { generateFlowSql, generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { rowsAtStage, simulateFlows, simulationTargets, type SimRow } from '../src/lib/simulate/engine';
import { collectComparedLiterals, collectReferences, evaluateText, exprToString, parseExpression, type Value } from '../src/lib/simulate/expression';
import { derivationSummary, isDerivationComplete } from '../src/lib/derivation';
import { lintDiagram } from '../src/lib/lint';

/* ------------------------------------------------------------------ */
/* Expression language                                                 */
/* ------------------------------------------------------------------ */

const row: Record<string, Value> = { quantity: 3, unit_price_cents: 250, status: 'paid', key3: 4, ts: '2025-01-02 10:00:00', ts0: '2025-01-01 09:30:00', d: '2025-03-04', n: null, name: 'Ada' };
const ctx = {
  column: (table: string | null, name: string): Value => {
    if (table === 'orders' && name === 'status') return 'paid';
    if (table) throw new Error(`no ${table}`);
    if (!(name in row)) throw new Error(`no column ${name}`);
    return row[name];
  },
};
const ev = (text: string) => evaluateText(text, ctx);

describe('expression language', () => {
  it('does arithmetic, comparisons and text', () => {
    expect(ev('quantity * unit_price_cents')).toBe(750);
    expect(ev('(quantity + 1) / 2')).toBe(2);
    expect(ev('7 % 4')).toBe(3);
    expect(ev('-quantity')).toBe(-3);
    expect(ev('key3 >= 4')).toBe(true);
    expect(ev("status = 'paid'")).toBe(true);
    expect(ev("status <> 'paid'")).toBe(false);
    expect(ev("status != 'paid'")).toBe(false);
    expect(ev("UPPER(status) || '!'")).toBe('PAID!');
    expect(ev("LENGTH(name)")).toBe(3);
    expect(ev("SUBSTR(name, 2, 1)")).toBe('d');
    expect(ev("name LIKE 'A%'")).toBe(true);
    expect(ev("name ILIKE 'a_a'")).toBe(true);
    expect(ev("status IN ('paid', 'shipped')")).toBe(true);
    expect(ev("status NOT IN ('paid', 'shipped')")).toBe(false);
    expect(ev('quantity BETWEEN 1 AND 5')).toBe(true);
    expect(ev("CASE WHEN quantity > 2 THEN 'bulk' ELSE 'single' END")).toBe('bulk');
    expect(ev("CASE status WHEN 'paid' THEN 1 ELSE 0 END")).toBe(1);
    expect(ev('ROUND(quantity / 7.0, 2)')).toBe(0.43);
  });

  it('follows SQL three-valued logic for NULL', () => {
    expect(ev('n = 1')).toBeNull();
    expect(ev('n IS NULL')).toBe(true);
    expect(ev('n IS NOT NULL')).toBe(false);
    expect(ev('n AND FALSE')).toBe(false);
    expect(ev('n AND TRUE')).toBeNull();
    expect(ev('n OR TRUE')).toBe(true);
    expect(ev('NOT n')).toBeNull();
    expect(ev('COALESCE(n, 7) + 1')).toBe(8);
    expect(ev("n IN (1, 2)")).toBeNull();
    expect(ev('n + 1')).toBeNull();
  });

  it('subtracts timestamps in seconds and dates in days, and casts', () => {
    expect(ev('ts - ts0')).toBe(88_200);
    expect(ev("d - '2025-03-01'")).toBe(3);
    expect(ev('d + 3')).toBe('2025-03-07');
    expect(ev('CAST(ts AS DATE)')).toBe('2025-01-02');
    expect(ev('ts::date')).toBe('2025-01-02');
    expect(ev('EXTRACT(YEAR FROM ts)')).toBe(2025);
    expect(ev("DATE_TRUNC('month', ts)")).toBe('2025-01-01 00:00:00');
    expect(ev('CAST(quantity AS TEXT)')).toBe('3');
    expect(ev("CAST('12' AS INTEGER) + 1")).toBe(13);
    expect(ev('DATE(ts)')).toBe('2025-01-02');
    expect(ev('TIMESTAMPDIFF(HOUR, ts0, ts)')).toBe(24);
  });

  it('reaches other tables as table.column and reports what it cannot resolve', () => {
    expect(ev("orders.status = 'paid' AND key3 >= 4")).toBe(true);
    expect(() => ev('nope')).toThrow(/no column nope/);
    expect(() => ev('FOO(1)')).toThrow(/Unknown function FOO/);
    expect(() => ev('quantity +')).toThrow(/Unexpected token/);
    expect(() => ev('1 2')).toThrow(/Unexpected input/);
    expect(() => ev("'abc' * 2")).toThrow(/not a number/);
  });

  it('lists references, compared literals and prints itself back', () => {
    expect(collectReferences(parseExpression("orders.status = 'paid' AND quantity > 1"))).toEqual([
      { table: 'orders', name: 'status' },
      { table: null, name: 'quantity' },
    ]);
    const lits = collectComparedLiterals(parseExpression("orders.status = 'paid' AND tier IN ('a', 'b') AND x <> 3"));
    expect(lits.map((l) => [l.ref.table, l.ref.name, l.value])).toEqual([
      ['orders', 'status', 'paid'],
      [null, 'tier', 'a'],
      [null, 'tier', 'b'],
      [null, 'x', 3],
    ]);
    expect(exprToString(parseExpression('CASE WHEN a THEN 1 ELSE 2 END + CAST(b AS INT)'))).toBe('CASE WHEN a THEN 1 ELSE 2 END + CAST(b AS INT)');
  });
});

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

function two(sql: string): Diagram {
  const d = emptyDiagram('postgresql', 'test');
  const r = importSql(sql, 'postgresql');
  d.tables = r.tables;
  d.relationships = r.relationships;
  return d;
}

const col = (d: Diagram, table: string, column: string) => d.tables.find((t) => t.name === table)!.columns.find((c) => c.name === column)!.id;
const tbl = (d: Diagram, table: string) => d.tables.find((t) => t.name === table)!.id;
const named = (d: Diagram, table: string, rows: SimRow[]) =>
  rows.map((r) => Object.fromEntries(d.tables.find((t) => t.name === table)!.columns.map((c) => [c.name, r[c.id] ?? null])));

describe('simulateFlows', () => {
  it('fills B.key1 with the average of A.key2 grouped by A.key1', () => {
    // "key1 for table B gets its values from Table A by taking the average of its key2 with a group by of its key1"
    const d = two(`CREATE TABLE a (id INT PRIMARY KEY, key1 INT, key2 INT); CREATE TABLE b (id SERIAL PRIMARY KEY, key1 NUMERIC);`);
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 'a'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 'b'),
        targetColumnIds: [],
        derivations: [createDerivation({ targetColumnId: col(d, 'b', 'key1'), expression: 'key2', aggregate: 'AVG', groupBy: ['key1'] })],
      }),
    );
    const a = tbl(d, 'a');
    const mk = (id: number, key1: number, key2: number): SimRow => ({ [col(d, 'a', 'id')]: id, [col(d, 'a', 'key1')]: key1, [col(d, 'a', 'key2')]: key2 });
    const res = simulateFlows(d, tbl(d, 'b'), { inputRows: { [a]: [mk(1, 10, 4), mk(2, 20, 100), mk(3, 10, 6), mk(4, 20, 50), mk(5, 30, 7)] } });
    expect(res.warnings).toEqual([]);
    expect(res.stages).toHaveLength(1);
    expect(res.stages[0].warnings).toEqual([]);
    expect(named(d, 'b', res.rows[tbl(d, 'b')])).toEqual([
      { id: 1, key1: 5 },
      { id: 2, key1: 75 },
      { id: 3, key1: 7 },
    ]);
    // lineage: the second B row came from A rows 2 and 4
    expect(res.origins[tbl(d, 'b')][1]!.sourceRows).toEqual([1, 3]);
    expect(res.origins[tbl(d, 'b')][1]!.explain.join('\n')).toContain('key1 = AVG(key2) over 2 rows');
    expect(res.roles).toEqual({ [a]: 'input', [tbl(d, 'b')]: 'derived' });
  });

  it('fills C with the time between consecutive D points where key3 >= 4', () => {
    // "populate Table C by looking at the time differences between sequential points in Table D only where key3 >= 4"
    const d = two(`CREATE TABLE d (id INT PRIMARY KEY, ts TIMESTAMP, key3 INT); CREATE TABLE c (id SERIAL PRIMARY KEY, point_id INT, gap_seconds INT);`);
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 'd'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 'c'),
        targetColumnIds: [],
        derivations: [
          createDerivation({ targetColumnId: col(d, 'c', 'point_id'), expression: 'id', filter: 'key3 >= 4' }),
          createDerivation({ targetColumnId: col(d, 'c', 'gap_seconds'), expression: 'ts', filter: 'key3 >= 4', window: { fn: 'DIFF', orderBy: ['ts'], partitionBy: [] } }),
        ],
      }),
    );
    const mk = (id: number, ts: string, key3: number): SimRow => ({ [col(d, 'd', 'id')]: id, [col(d, 'd', 'ts')]: ts, [col(d, 'd', 'key3')]: key3 });
    // deliberately out of time order, with one row filtered out
    const rows = [mk(1, '2025-01-01 10:00:00', 5), mk(2, '2025-01-01 10:00:30', 1), mk(3, '2025-01-01 10:02:00', 4), mk(4, '2025-01-01 10:01:00', 9)];
    const res = simulateFlows(d, tbl(d, 'c'), { inputRows: { [tbl(d, 'd')]: rows } });
    expect(res.stages[0].warnings).toEqual([]);
    expect(named(d, 'c', res.rows[tbl(d, 'c')])).toEqual([
      { id: 1, point_id: 1, gap_seconds: null },
      { id: 2, point_id: 3, gap_seconds: 60 },
      { id: 3, point_id: 4, gap_seconds: 60 },
    ]);
    // row 2 of C (point 3) was computed from D rows 3 and 4 (its predecessor in time order)
    expect(res.origins[tbl(d, 'c')][1]!.sourceRows).toEqual([2, 3]);
    expect(res.stages[0].matchedRows).toEqual([0, 2, 3]);
  });

  it('runs every window function', () => {
    const d = two(`CREATE TABLE s (id INT PRIMARY KEY, grp TEXT, v INT); CREATE TABLE t (id SERIAL PRIMARY KEY, lag_v INT, lead_v INT, run INT, avg NUMERIC, n INT, rnk INT);`);
    const win = (fn: 'LAG' | 'LEAD' | 'RUNNING_SUM' | 'RUNNING_AVG' | 'ROW_NUMBER' | 'RANK', target: string) =>
      createDerivation({ targetColumnId: col(d, 't', target), expression: 'v', window: { fn, orderBy: ['v'], partitionBy: ['grp'] } });
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 's'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 't'),
        targetColumnIds: [],
        derivations: [win('LAG', 'lag_v'), win('LEAD', 'lead_v'), win('RUNNING_SUM', 'run'), win('RUNNING_AVG', 'avg'), win('ROW_NUMBER', 'n'), win('RANK', 'rnk')],
      }),
    );
    const mk = (id: number, grp: string, v: number): SimRow => ({ [col(d, 's', 'id')]: id, [col(d, 's', 'grp')]: grp, [col(d, 's', 'v')]: v });
    const res = simulateFlows(d, tbl(d, 't'), { inputRows: { [tbl(d, 's')]: [mk(1, 'x', 3), mk(2, 'y', 8), mk(3, 'x', 1), mk(4, 'x', 3)] } });
    expect(res.stages[0].warnings).toEqual([]);
    const out = named(d, 't', res.rows[tbl(d, 't')]).map(({ id: _id, ...rest }) => rest);
    // output rows follow source order; the window is computed in (grp, v) order
    expect(out).toEqual([
      { lag_v: 1, lead_v: 3, run: 4, avg: 2, n: 2, rnk: 2 }, // x:3 (first of the tie)
      { lag_v: null, lead_v: null, run: 8, avg: 8, n: 1, rnk: 1 }, // y:8
      { lag_v: null, lead_v: 3, run: 1, avg: 1, n: 1, rnk: 1 }, // x:1
      { lag_v: 3, lead_v: null, run: 7, avg: 7 / 3, n: 3, rnk: 2 }, // x:3 (ties with the other 3)
    ]);
  });

  it('averages a sequence result: window first, then aggregate', () => {
    const d = two(`CREATE TABLE s (id INT PRIMARY KEY, grp TEXT, v INT); CREATE TABLE t (grp TEXT, mean_step NUMERIC);`);
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 's'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 't'),
        targetColumnIds: [],
        derivations: [createDerivation({ targetColumnId: col(d, 't', 'mean_step'), expression: 'v', aggregate: 'AVG', groupBy: ['grp'], window: { fn: 'DIFF', orderBy: ['v'], partitionBy: ['grp'] } })],
      }),
    );
    const mk = (id: number, grp: string, v: number): SimRow => ({ [col(d, 's', 'id')]: id, [col(d, 's', 'grp')]: grp, [col(d, 's', 'v')]: v });
    const res = simulateFlows(d, tbl(d, 't'), { inputRows: { [tbl(d, 's')]: [mk(1, 'x', 1), mk(2, 'x', 4), mk(3, 'x', 10), mk(4, 'y', 5)] } });
    expect(res.stages[0].warnings).toEqual([]);
    // x: steps 3 and 6 -> mean 4.5; y: a single point has no step
    expect(named(d, 't', res.rows[tbl(d, 't')])).toEqual([
      { grp: 'x', mean_step: 4.5 },
      { grp: 'y', mean_step: null },
    ]);
    // and the SQL for it is the subquery form
    const sql = generateFlowSql(d, d.relationships.find((r) => r.kind === 'flow')!.id);
    expect(sql).toContain('FROM (');
    expect(sql).toContain('SELECT grp AS grp, v - LAG(v) OVER (PARTITION BY grp ORDER BY v) AS mean_step');
    expect(sql).toContain(') AS w\nGROUP BY grp;');
  });

  it('reads other tables through foreign keys, plants filter values in the seed and records lineage', () => {
    const d = sampleDiagram();
    const daily = tbl(d, 'daily_sales');
    const res = simulateFlows(d, daily, { rows: 12, seed: 4 });
    expect(res.warnings).toEqual([]);
    expect(res.stages).toHaveLength(1);
    const stage = res.stages[0];
    expect(stage.warnings).toEqual([]);
    // orders is not on the flow path but is read through order_items.order_id
    expect(res.roles[tbl(d, 'orders')]).toBe('lookup');
    expect(stage.lookupTableIds).toEqual([tbl(d, 'orders')]);
    expect(stage.reads.some((r) => r.tableId === tbl(d, 'orders') && r.columnId === col(d, 'orders', 'status'))).toBe(true);
    // the seed made some orders 'paid' because the filter asks for it, so rows flowed
    const orders = res.rows[tbl(d, 'orders')];
    const paid = new Set(orders.filter((o) => o[col(d, 'orders', 'status')] === 'paid').map((o) => o[col(d, 'orders', 'id')]));
    expect(paid.size).toBeGreaterThan(0);
    expect(stage.producedRange[1]).toBeGreaterThan(0);
    // every produced row descends only from order_items whose order is paid, and sums what they hold
    const items = res.rows[tbl(d, 'order_items')];
    for (const [i, out] of res.rows[daily].entries()) {
      const origin = res.origins[daily][i]!;
      expect(origin.stage).toBe(0);
      for (const src of origin.sourceRows) expect(paid.has(items[src][col(d, 'order_items', 'order_id')])).toBe(true);
      const units = origin.sourceRows.reduce((s, src) => s + Number(items[src][col(d, 'order_items', 'quantity')]), 0);
      expect(out[col(d, 'daily_sales', 'units_sold')]).toBe(units);
      expect(String(out[col(d, 'daily_sales', 'day')])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(stage.writes).toContain(col(d, 'daily_sales', 'product_id'));
    expect(rowsAtStage(res, daily, -1)).toBe(0);
    expect(rowsAtStage(res, daily, 0)).toBe(res.rows[daily].length);
    expect(simulationTargets(d).map((t) => t.name)).toEqual(['customers', 'daily_sales', 'order_gaps']);
  });

  it('feeds the sample order_gaps table one row per paid order with the gap to the previous one', () => {
    const d = sampleDiagram();
    const gaps = tbl(d, 'order_gaps');
    const res = simulateFlows(d, gaps, { rows: 10, seed: 1 });
    expect(res.stages[0].warnings).toEqual([]);
    const out = res.rows[gaps];
    expect(out.length).toBeGreaterThan(1);
    const orders = res.rows[tbl(d, 'orders')];
    const byCustomer = new Map<Value, number>();
    for (const [i, row] of out.entries()) {
      const c = row[col(d, 'order_gaps', 'customer_id')];
      const gap = row[col(d, 'order_gaps', 'gap_seconds')];
      const origin = res.origins[gaps][i]!;
      if (byCustomer.has(c)) {
        expect(origin.sourceRows).toHaveLength(2);
        expect(typeof gap).toBe('number');
      }
      byCustomer.set(c, (byCustomer.get(c) ?? 0) + 1);
      // every source row is a paid order
      for (const src of origin.sourceRows) expect(orders[src][col(d, 'orders', 'status')]).toBe('paid');
    }
    // the external CRM feeds customers across the database boundary
    const res2 = simulateFlows(d, tbl(d, 'customers'), { rows: 6, seed: 2 });
    expect(res2.stages[0].warnings).toEqual([]);
    expect(res2.roles[tbl(d, 'crm_accounts')]).toBe('lookup');
    expect(res2.rows[tbl(d, 'customers')].length).toBeGreaterThan(0);
  });

  it('chains flows in dependency order and lets a later flow read a derived table', () => {
    const d = two(`CREATE TABLE raw (id INT PRIMARY KEY, v INT);
      CREATE TABLE mid (id SERIAL PRIMARY KEY, doubled INT);
      CREATE TABLE fin (total INT);`);
    const flow = (from: string, to: string, dv: ReturnType<typeof createDerivation>) =>
      createRelationship({ kind: 'flow', sourceTableId: tbl(d, from), sourceColumnIds: [], targetTableId: tbl(d, to), targetColumnIds: [], derivations: [dv] });
    d.relationships.push(
      flow('mid', 'fin', createDerivation({ targetColumnId: col(d, 'fin', 'total'), expression: 'doubled', aggregate: 'SUM' })),
      flow('raw', 'mid', createDerivation({ targetColumnId: col(d, 'mid', 'doubled'), expression: 'v * 2' })),
    );
    const mk = (id: number, v: number): SimRow => ({ [col(d, 'raw', 'id')]: id, [col(d, 'raw', 'v')]: v });
    const res = simulateFlows(d, tbl(d, 'fin'), { inputRows: { [tbl(d, 'raw')]: [mk(1, 1), mk(2, 2), mk(3, 3)] } });
    expect(res.stages.map((s) => s.label)).toEqual(['raw → mid', 'mid → fin']);
    expect(named(d, 'mid', res.rows[tbl(d, 'mid')]).map((r) => r.doubled)).toEqual([2, 4, 6]);
    expect(named(d, 'fin', res.rows[tbl(d, 'fin')])).toEqual([{ total: 12 }]);
    expect(res.tableIds).toEqual([tbl(d, 'raw'), tbl(d, 'mid'), tbl(d, 'fin')]);
    expect(rowsAtStage(res, tbl(d, 'mid'), 0)).toBe(3);
    expect(rowsAtStage(res, tbl(d, 'fin'), 0)).toBe(0);
    expect(rowsAtStage(res, tbl(d, 'fin'), 1)).toBe(1);
  });

  it('explains what is missing instead of failing silently', () => {
    const d = two(`CREATE TABLE a (id INT PRIMARY KEY, v INT); CREATE TABLE b (id INT PRIMARY KEY, w INT); CREATE TABLE c (id INT PRIMARY KEY, x INT);`);
    // no flow at all
    expect(simulateFlows(d, tbl(d, 'c')).warnings[0]).toMatch(/No data flow feeds c/);
    // a flow with no derivations, a bad expression, and an unreachable table
    d.relationships.push(
      createRelationship({ kind: 'flow', sourceTableId: tbl(d, 'a'), sourceColumnIds: [], targetTableId: tbl(d, 'b'), targetColumnIds: [] }),
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 'b'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 'c'),
        targetColumnIds: [],
        derivations: [
          createDerivation({ targetColumnId: col(d, 'c', 'x'), expression: 'w +' }),
          createDerivation({ targetColumnId: col(d, 'c', 'id'), expression: 'a.v' }),
        ],
      }),
    );
    const res = simulateFlows(d, tbl(d, 'c'), { rows: 3 });
    expect(res.stages[0].warnings[0]).toMatch(/no derived columns yet/);
    expect(res.stages[1].warnings.join('\n')).toMatch(/Unexpected token/);
    expect(res.stages[1].warnings.join('\n')).toMatch(/"a" is not reachable from b through foreign keys/);
    // a cycle is broken rather than looped
    d.relationships.push(
      createRelationship({ kind: 'flow', sourceTableId: tbl(d, 'c'), sourceColumnIds: [], targetTableId: tbl(d, 'a'), targetColumnIds: [], derivations: [createDerivation({ targetColumnId: col(d, 'a', 'v'), expression: 'x' })] }),
    );
    const cyc = simulateFlows(d, tbl(d, 'c'), { rows: 3 });
    expect(cyc.warnings.join('\n')).toMatch(/form a cycle/);
    expect(cyc.stages.length).toBeLessThan(3);
  });

  it('applies cell overrides to seeded input rows', () => {
    const d = two(`CREATE TABLE a (id INT PRIMARY KEY, v INT); CREATE TABLE b (total INT);`);
    d.relationships.push(
      createRelationship({ kind: 'flow', sourceTableId: tbl(d, 'a'), sourceColumnIds: [], targetTableId: tbl(d, 'b'), targetColumnIds: [], derivations: [createDerivation({ targetColumnId: col(d, 'b', 'total'), expression: 'v', aggregate: 'SUM' })] }),
    );
    const base = simulateFlows(d, tbl(d, 'b'), { rows: 4, seed: 1 });
    const before = base.rows[tbl(d, 'b')][0][col(d, 'b', 'total')] as number;
    const first = base.rows[tbl(d, 'a')][0][col(d, 'a', 'v')] as number;
    const changed = simulateFlows(d, tbl(d, 'b'), { rows: 4, seed: 1, overrides: { [tbl(d, 'a')]: { 0: { [col(d, 'a', 'v')]: first + 1000 } } } });
    expect(changed.rows[tbl(d, 'b')][0][col(d, 'b', 'total')]).toBe(before + 1000);
  });
});

/* ------------------------------------------------------------------ */
/* Windows in the model, the summaries, the lint and the script        */
/* ------------------------------------------------------------------ */

describe('window derivations', () => {
  it('summarise and complete like the rest of the model', () => {
    const dv = createDerivation({ targetColumnId: 'c', expression: 'placed_at', window: { fn: 'DIFF', orderBy: ['placed_at'], partitionBy: ['customer_id'] }, filter: "status = 'paid'" });
    expect(derivationSummary(dv, 'gap')).toBe("gap = DIFF(placed_at) OVER (PARTITION BY customer_id ORDER BY placed_at) WHERE status = 'paid'");
    expect(derivationSummary({ ...dv, aggregate: 'AVG', groupBy: ['customer_id'] }, 'mean_gap')).toBe(
      "mean_gap = AVG(DIFF(placed_at) OVER (PARTITION BY customer_id ORDER BY placed_at)) GROUP BY customer_id WHERE status = 'paid'",
    );
    expect(derivationSummary(createDerivation({ targetColumnId: 'c', window: { fn: 'ROW_NUMBER', orderBy: ['ts DESC'], partitionBy: [] } }), 'n')).toBe('n = ROW_NUMBER() OVER (ORDER BY ts DESC)');
    expect(isDerivationComplete(dv)).toBe(true);
    expect(isDerivationComplete({ ...dv, window: { fn: 'DIFF', orderBy: [], partitionBy: [] } })).toBe(false);
    expect(isDerivationComplete(createDerivation({ targetColumnId: 'c', window: { fn: 'RANK', orderBy: ['v'], partitionBy: [] } }))).toBe(true);
    expect(isDerivationComplete(createDerivation({ targetColumnId: 'c', window: { fn: 'LAG', orderBy: ['v'], partitionBy: [] } }))).toBe(false);
  });

  it('are written as the right window function per dialect', () => {
    for (const [dialect, expected] of [
      ['postgresql', 'EXTRACT(EPOCH FROM (placed_at - LAG(placed_at) OVER (PARTITION BY customer_id ORDER BY placed_at)))'],
      ['mariadb', 'TIMESTAMPDIFF(SECOND, LAG(placed_at) OVER (PARTITION BY customer_id ORDER BY placed_at), placed_at)'],
      ['sqlite', '(julianday(placed_at) - julianday(LAG(placed_at) OVER (PARTITION BY customer_id ORDER BY placed_at))) * 86400'],
    ] as const) {
      const d = { ...sampleDiagram(), dialect };
      const flow = d.relationships.find((r) => r.name === 'gap between orders')!;
      const sql = generateFlowSql(d, flow.id);
      expect(sql).toContain(`INSERT INTO order_gaps (customer_id, order_id, gap_seconds)`);
      expect(sql).toContain(expected);
      expect(sql).toContain("WHERE status = 'paid'");
    }
    // dates subtract in days; running totals and ranks get their frame
    const d = two(`CREATE TABLE s (id INT PRIMARY KEY, day DATE, amount INT); CREATE TABLE t (days INT, running INT, rnk INT);`);
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 's'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 't'),
        targetColumnIds: [],
        derivations: [
          createDerivation({ targetColumnId: col(d, 't', 'days'), expression: 'day', window: { fn: 'DIFF', orderBy: ['day'], partitionBy: [] } }),
          createDerivation({ targetColumnId: col(d, 't', 'running'), expression: 'amount', window: { fn: 'RUNNING_SUM', orderBy: ['day'], partitionBy: [] } }),
          createDerivation({ targetColumnId: col(d, 't', 'rnk'), window: { fn: 'RANK', orderBy: ['amount DESC'], partitionBy: [] } }),
        ],
      }),
    );
    const id = d.relationships.find((r) => r.kind === 'flow')!.id;
    expect(generateFlowSql(d, id)).toBe(
      'INSERT INTO t (days, running, rnk)\nSELECT day - LAG(day) OVER (ORDER BY day), SUM(amount) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), RANK() OVER (ORDER BY amount DESC)\nFROM s;',
    );
    expect(generateFlowSql({ ...d, dialect: 'mariadb' }, id)).toContain('DATEDIFF(day, LAG(day) OVER (ORDER BY day))');
    expect(generateFlowSql({ ...d, dialect: 'sqlite' }, id)).toContain('julianday(day) - julianday(LAG(day) OVER (ORDER BY day))');
  });

  it('warn about references the diagram cannot join, and lint incomplete sequences', () => {
    const d = two(`CREATE TABLE s (id INT PRIMARY KEY, v INT); CREATE TABLE other (id INT PRIMARY KEY, w INT); CREATE TABLE t (x INT);`);
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        sourceTableId: tbl(d, 's'),
        sourceColumnIds: [],
        targetTableId: tbl(d, 't'),
        targetColumnIds: [],
        derivations: [createDerivation({ targetColumnId: col(d, 't', 'x'), expression: 'other.w + v' }), createDerivation({ targetColumnId: col(d, 't', 'x'), expression: 'v', window: { fn: 'LAG', orderBy: [], partitionBy: [] } })],
      }),
    );
    const out = generateSchema(d);
    expect(out.warnings.join('\n')).toMatch(/"other.w" is not reachable through foreign keys/);
    expect(out.script).toContain('SELECT other.w + v');
    expect(lintDiagram(d).some((f) => f.rule === 'derivation-incomplete')).toBe(true);
  });
});
