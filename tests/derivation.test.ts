import { beforeEach, describe, expect, it } from 'vitest';
import type { Derivation, Diagram, Table } from '../src/shared/types';
import { derivationSummaries, derivationSummary, derivationValue, flowDerivations, groupDerivations, isDerivationComplete, matchColumnsByName } from '../src/lib/derivation';
import { createColumn, createDerivation, createRelationship, createTable, derivationsMatchedByName, emptyDiagram, flowCopyForTable, pruneRelationships } from '../src/lib/model';
import { useStore } from '../src/store/useStore';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { sampleDiagram } from '../src/lib/sample';

function rollup(partial: Partial<Derivation>): Derivation {
  return createDerivation({ targetColumnId: 'col', expression: 'quantity', aggregate: 'SUM', groupBy: ['product_id'], ...partial });
}

describe('derivation formatting', () => {
  it('wraps the expression in the aggregate, or leaves it alone', () => {
    expect(derivationValue(rollup({ expression: 'quantity * unit_price_cents' }))).toBe('SUM(quantity * unit_price_cents)');
    expect(derivationValue(rollup({ aggregate: undefined, expression: 'status' }))).toBe('status');
    expect(derivationValue(rollup({ aggregate: 'COUNT', expression: '' }))).toBe('COUNT(*)');
    expect(derivationValue(rollup({ aggregate: undefined, expression: '  ' }))).toBe('');
  });

  it('summarises a derivation as one line of SQL-ish text', () => {
    const d = rollup({ expression: 'quantity * unit_price_cents', groupBy: ['product_id', 'day'], filter: "status = 'paid'" });
    expect(derivationSummary(d, 'revenue_cents')).toBe("revenue_cents = SUM(quantity * unit_price_cents) GROUP BY product_id, day WHERE status = 'paid'");
    expect(derivationSummary(rollup({ groupBy: [], filter: '' }), 'units_sold')).toBe('units_sold = SUM(quantity)');
    // an entry that points nowhere still renders, so the editor can show it
    expect(derivationSummary(rollup({ aggregate: undefined, expression: '', groupBy: [] }), undefined)).toBe('? = ?');
  });

  it('knows which entries the generator can use', () => {
    expect(isDerivationComplete(rollup({}))).toBe(true);
    expect(isDerivationComplete(rollup({ targetColumnId: '' }))).toBe(false);
    expect(isDerivationComplete(rollup({ aggregate: undefined, expression: '' }))).toBe(false);
  });

  it('buckets entries that share a grouping and a filter', () => {
    const a = rollup({ filter: 'x = 1' });
    const b = rollup({ expression: 'quantity * unit_price_cents', filter: 'x = 1' });
    const c = rollup({ groupBy: ['day'] });
    const groups = groupDerivations([a, b, c]);
    expect(groups).toHaveLength(2);
    expect(groups[0].entries).toEqual([a, b]);
    expect(groups[0]).toMatchObject({ groupBy: ['product_id'], filter: 'x = 1' });
    expect(groups[1].entries).toEqual([c]);
  });

  it('ignores derivations on foreign keys', () => {
    const fk = createRelationship({ kind: 'fk', sourceTableId: 'a', sourceColumnIds: ['c'], targetTableId: 'b', targetColumnIds: ['d'], derivations: [rollup({})] });
    expect(flowDerivations(fk)).toEqual([]);
    expect(flowDerivations({ ...fk, kind: 'flow' })).toHaveLength(1);
  });
});

describe('the sample diagram', () => {
  it('describes the nightly rollup with structured derivations next to the free-text query', () => {
    const d = sampleDiagram();
    const flow = d.relationships.find((r) => r.name === 'nightly rollup')!;
    const daily = d.tables.find((t) => t.name === 'daily_sales')!;
    expect(derivationSummaries(flow, daily)).toEqual([
      "day = CAST(orders.placed_at AS DATE) GROUP BY product_id, CAST(orders.placed_at AS DATE) WHERE orders.status = 'paid'",
      "units_sold = SUM(quantity) GROUP BY product_id, CAST(orders.placed_at AS DATE) WHERE orders.status = 'paid'",
      "revenue_cents = SUM(quantity * unit_price_cents) GROUP BY product_id, CAST(orders.placed_at AS DATE) WHERE orders.status = 'paid'",
    ]);
    // both forms coexist: the query still carries the join the structure cannot express
    expect(flow.query).toContain('JOIN orders o ON o.id = oi.order_id');
    for (const dv of flow.derivations!) expect(daily.columns.some((c) => c.id === dv.targetColumnId)).toBe(true);
  });
});

describe('derivation persistence', () => {
  it('survives a save/load round-trip', () => {
    const d = sampleDiagram();
    const back = parseDiagramFile(serializeDiagram(d));
    const flow = back.relationships.find((r) => r.name === 'nightly rollup')!;
    expect(flow.derivations).toEqual(d.relationships.find((r) => r.name === 'nightly rollup')!.derivations);
    expect(flow.derivations).toHaveLength(3);
    expect(flow.derivations![2]).toMatchObject({ expression: 'quantity * unit_price_cents', aggregate: 'SUM', groupBy: ['product_id', 'CAST(orders.placed_at AS DATE)'], filter: "orders.status = 'paid'" });
    // a sequence operation round-trips too
    const gaps = back.relationships.find((r) => r.name === 'gap between orders')!;
    expect(gaps.derivations![2].window).toEqual({ fn: 'DIFF', orderBy: ['placed_at'], partitionBy: ['customer_id'] });
  });

  it('loads files written before derivations existed', () => {
    const d = parseDiagramFile(
      JSON.stringify({
        tables: [{ id: 't1', name: 'x', columns: [{ id: 'c1', name: 'id' }] }],
        relationships: [{ id: 'r1', kind: 'flow', sourceTableId: 't1', targetTableId: 't1', query: 'INSERT ...' }],
      }),
    );
    expect(d.relationships[0].derivations).toBeUndefined();
    expect(d.relationships[0].query).toBe('INSERT ...');
  });

  it('sanitises hand-edited entries', () => {
    const d = parseDiagramFile(
      JSON.stringify({
        tables: [{ id: 't1', name: 'x', columns: [{ id: 'c1', name: 'id' }] }],
        relationships: [
          {
            id: 'r1',
            kind: 'flow',
            sourceTableId: 't1',
            targetTableId: 't1',
            derivations: [
              { id: 'd1', targetColumnId: 'c1', expression: 'n', aggregate: 'DROP TABLE', groupBy: ['a', 7], filter: '', window: { fn: 'EXPLODE', orderBy: ['n'] } },
              'nonsense',
              {},
              { id: 'd3', targetColumnId: 'c1', expression: 'n', groupBy: [], window: { fn: 'LAG', orderBy: ['n', 3], partitionBy: 'x' } },
            ],
          },
        ],
      }),
    );
    const dvs = d.relationships[0].derivations!;
    expect(dvs).toHaveLength(3);
    expect(dvs[0]).toEqual({ id: 'd1', targetColumnId: 'c1', expression: 'n', groupBy: ['a'] });
    expect(dvs[1]).toMatchObject({ targetColumnId: '', expression: '', groupBy: [] });
    expect(dvs[1].id).toBeTruthy();
    expect(dvs[2].window).toEqual({ fn: 'LAG', orderBy: ['n'], partitionBy: [] });
  });
});

describe('pruneRelationships', () => {
  it('drops derivations whose target column was deleted', () => {
    const d = sampleDiagram();
    const daily = d.tables.find((t) => t.name === 'daily_sales')!;
    daily.columns = daily.columns.filter((c) => c.name !== 'revenue_cents');
    const pruned = pruneRelationships(d);
    const flow = pruned.relationships.find((r) => r.name === 'nightly rollup')!;
    expect(flow.derivations).toHaveLength(2);
    expect(derivationSummaries(flow, daily)).toEqual([
      "day = CAST(orders.placed_at AS DATE) GROUP BY product_id, CAST(orders.placed_at AS DATE) WHERE orders.status = 'paid'",
      "units_sold = SUM(quantity) GROUP BY product_id, CAST(orders.placed_at AS DATE) WHERE orders.status = 'paid'",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* One source feeding several look-alike tables                        */
/* ------------------------------------------------------------------ */

/**
 * The shape this is all for: a `runs` table whose columns several other tables
 * repeat verbatim, so every flow out of it is the same four passthroughs.
 */
function lookAlikeDiagram() {
  const shape = () => [
    createColumn({ name: 'start_time', type: 'TIMESTAMPTZ' }),
    createColumn({ name: 'stop_time', type: 'TIMESTAMPTZ' }),
    createColumn({ name: 'name', type: 'TEXT' }),
    createColumn({ name: 'size', type: 'BIGINT' }),
  ];
  const runs = createTable({ name: 'runs', columns: [createColumn({ name: 'id', type: 'BIGSERIAL', primaryKey: true }), ...shape()] });
  const uploads = createTable({ name: 'uploads', columns: shape() });
  const renders = createTable({ name: 'renders', columns: shape() });
  // Same four columns under a different house style, plus one nothing feeds.
  const backups = createTable({
    name: 'backups',
    columns: [
      createColumn({ name: 'startTime', type: 'TIMESTAMPTZ' }),
      createColumn({ name: 'stopTime', type: 'TIMESTAMPTZ' }),
      createColumn({ name: 'Name', type: 'TEXT' }),
      createColumn({ name: 'checksum', type: 'TEXT' }),
    ],
  });
  const flow = createRelationship({ kind: 'flow', sourceTableId: runs.id, sourceColumnIds: [], targetTableId: uploads.id, targetColumnIds: [] });
  const d: Diagram = { ...emptyDiagram(), tables: [runs, uploads, renders, backups], relationships: [flow] };
  return { d, runs, uploads, renders, backups, flow };
}

const colId = (t: Table, name: string) => t.columns.find((c) => c.name === name)!.id;

describe("matching a flow's columns by name", () => {
  it('pairs every target column a source column of the same name can fill', () => {
    const { runs, uploads } = lookAlikeDiagram();
    const matches = matchColumnsByName(runs.columns, uploads.columns, []);
    expect(matches.map((m) => `${m.targetColumnName} = ${m.sourceColumnName}`)).toEqual([
      'start_time = start_time',
      'stop_time = stop_time',
      'name = name',
      'size = size',
    ]);
    expect(matches.every((m) => m.exact)).toBe(true);
  });

  it('sees through case and word separators, and says when it did', () => {
    const { runs, backups } = lookAlikeDiagram();
    const matches = matchColumnsByName(runs.columns, backups.columns, []);
    expect(matches.map((m) => [m.targetColumnName, m.sourceColumnName, m.exact])).toEqual([
      ['startTime', 'start_time', false],
      ['stopTime', 'stop_time', false],
      ['Name', 'name', false],
    ]);
  });

  it('leaves columns a derivation already fills alone, so a second run adds nothing', () => {
    const { runs, uploads } = lookAlikeDiagram();
    const existing = [createDerivation({ targetColumnId: colId(uploads, 'size'), expression: 'size * 2' })];
    expect(matchColumnsByName(runs.columns, uploads.columns, existing).map((m) => m.targetColumnName)).toEqual(['start_time', 'stop_time', 'name']);
    const all = matchColumnsByName(runs.columns, uploads.columns, []).map((m) => createDerivation({ targetColumnId: m.targetColumnId, expression: m.sourceColumnName }));
    expect(matchColumnsByName(runs.columns, uploads.columns, all)).toEqual([]);
  });

  it('refuses to guess when two source columns normalize to the same name', () => {
    const source = [createColumn({ name: 'stop_time' }), createColumn({ name: 'stopTime' }), createColumn({ name: 'size' })];
    const target = [createColumn({ name: 'stoptime' }), createColumn({ name: 'stop_time' }), createColumn({ name: 'size' })];
    // "stoptime" could be either spelling, so it is left for the user; the exact
    // spelling next to it is unambiguous and still matched.
    expect(matchColumnsByName(source, target, []).map((m) => m.targetColumnName)).toEqual(['stop_time', 'size']);
  });

  it('builds plain passthroughs that share the grouping and filter already there', () => {
    const { runs, uploads } = lookAlikeDiagram();
    const existing = [createDerivation({ targetColumnId: colId(uploads, 'size'), expression: 'size', aggregate: 'SUM', groupBy: ['name'], filter: 'size > 0' })];
    const made = derivationsMatchedByName(runs, uploads, existing);
    expect(made).toHaveLength(3);
    expect(made[0]).toMatchObject({ targetColumnId: colId(uploads, 'start_time'), expression: 'start_time', groupBy: ['name'], filter: 'size > 0' });
    // The aggregate is not inherited: a name match carries a column across, it does not roll one up.
    expect(made.every((m) => m.aggregate === undefined)).toBe(true);
    expect(new Set(made.map((m) => m.id)).size).toBe(3);
  });
});

describe('copying a flow onto another table', () => {
  it('re-points the derivations at the columns the new table spells the same way', () => {
    const { runs, uploads, backups, flow } = lookAlikeDiagram();
    flow.derivations = derivationsMatchedByName(runs, uploads, []);
    flow.query = 'INSERT INTO uploads ...';
    flow.name = 'nightly copy';
    const copy = flowCopyForTable(flow, uploads, backups);
    expect(copy.targetTableId).toBe(backups.id);
    expect(copy.name).toBe('nightly copy');
    // The tagged query names the old target table, so it is deliberately dropped.
    expect(copy.query).toBeUndefined();
    expect(copy.derivations!.map((dv) => [backups.columns.find((c) => c.id === dv.targetColumnId)!.name, dv.expression])).toEqual([
      ['startTime', 'start_time'],
      ['stopTime', 'stop_time'],
      ['Name', 'name'],
    ]);
    // `size` has no counterpart on backups, so that derivation is dropped rather
    // than left pointing at a column of another table.
    expect(copy.derivations).toHaveLength(3);
    expect(copy.derivations!.some((dv) => dv.id === flow.derivations![0].id)).toBe(false);
  });
});

describe('the store actions behind both', () => {
  beforeEach(() => {
    useStore.setState({ past: [], future: [] });
  });

  it('fills a flow once and then has nothing left to add', () => {
    const { d, flow, uploads } = lookAlikeDiagram();
    useStore.setState({ diagram: d, past: [], future: [] });
    expect(useStore.getState().fillFlowByName(flow.id)).toBe(4);
    expect(useStore.getState().fillFlowByName(flow.id)).toBe(0);
    const after = useStore.getState().diagram.relationships[0];
    expect(after.derivations).toHaveLength(4);
    expect(derivationSummaries(after, uploads)).toEqual(['start_time = start_time', 'stop_time = stop_time', 'name = name', 'size = size']);
    // One history entry, so one undo puts the four back where they were.
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('draws the same flow into the other tables, skipping the ones already fed', () => {
    const { d, flow, runs, renders, backups } = lookAlikeDiagram();
    useStore.setState({ diagram: d, past: [], future: [] });
    useStore.getState().fillFlowByName(flow.id);
    // uploads is the flow's own target and runs is its source: neither can be a copy.
    const made = useStore.getState().copyFlowToTables(flow.id, [renders.id, backups.id, runs.id, d.tables[1].id]);
    expect(made).toHaveLength(2);
    const rels = useStore.getState().diagram.relationships;
    expect(rels).toHaveLength(3);
    expect(rels.filter((r) => r.sourceTableId === runs.id)).toHaveLength(3);
    expect(rels.find((r) => r.targetTableId === renders.id)!.derivations).toHaveLength(4);
    expect(rels.find((r) => r.targetTableId === backups.id)!.derivations).toHaveLength(3);
    // Running it again would only duplicate edges that already exist.
    expect(useStore.getState().copyFlowToTables(flow.id, [renders.id, backups.id])).toEqual([]);
  });
});
