import { describe, expect, it } from 'vitest';
import type { Derivation } from '../src/shared/types';
import { derivationSummaries, derivationSummary, derivationValue, flowDerivations, groupDerivations, isDerivationComplete } from '../src/lib/derivation';
import { createDerivation, createRelationship, pruneRelationships } from '../src/lib/model';
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
      "units_sold = SUM(quantity) GROUP BY product_id, day WHERE status = 'paid'",
      "revenue_cents = SUM(quantity * unit_price_cents) GROUP BY product_id, day WHERE status = 'paid'",
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
    expect(flow.derivations).toHaveLength(2);
    expect(flow.derivations![1]).toMatchObject({ expression: 'quantity * unit_price_cents', aggregate: 'SUM', groupBy: ['product_id', 'day'], filter: "status = 'paid'" });
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
              { id: 'd1', targetColumnId: 'c1', expression: 'n', aggregate: 'DROP TABLE', groupBy: ['a', 7], filter: '' },
              'nonsense',
              {},
            ],
          },
        ],
      }),
    );
    const dvs = d.relationships[0].derivations!;
    expect(dvs).toHaveLength(2);
    expect(dvs[0]).toEqual({ id: 'd1', targetColumnId: 'c1', expression: 'n', groupBy: ['a'] });
    expect(dvs[1]).toMatchObject({ targetColumnId: '', expression: '', groupBy: [] });
    expect(dvs[1].id).toBeTruthy();
  });
});

describe('pruneRelationships', () => {
  it('drops derivations whose target column was deleted', () => {
    const d = sampleDiagram();
    const daily = d.tables.find((t) => t.name === 'daily_sales')!;
    daily.columns = daily.columns.filter((c) => c.name !== 'revenue_cents');
    const pruned = pruneRelationships(d);
    const flow = pruned.relationships.find((r) => r.name === 'nightly rollup')!;
    expect(flow.derivations).toHaveLength(1);
    expect(derivationSummaries(flow, daily)).toEqual(["units_sold = SUM(quantity) GROUP BY product_id, day WHERE status = 'paid'"]);
  });
});
