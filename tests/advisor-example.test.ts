import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDiagramFile } from '@/lib/io';
import { generateSchema } from '@/lib/sql/generator';

/** Guards the example that docs/ADVISOR_OUTPUT_FORMAT.md points advisor agents at. */
describe('docs/examples/orders-rollup.dbviz.json', () => {
  const diagram = parseDiagramFile(readFileSync('docs/examples/orders-rollup.dbviz.json', 'utf8'));

  it('loads with every part of the model intact', () => {
    expect(diagram.dialect).toBe('postgresql');
    expect(diagram.tables.map((t) => t.name)).toEqual(['customers', 'orders', 'customer_month_totals']);
    expect(diagram.relationships.filter((r) => r.kind === 'fk')).toHaveLength(2);
    expect(diagram.relationships.filter((r) => r.kind === 'flow')).toHaveLength(1);
    expect(diagram.notes).toHaveLength(2);
  });

  it('generates the DDL the recommendation describes', () => {
    const { script } = generateSchema(diagram);
    expect(script).toContain('CREATE TABLE public.customer_month_totals');
    expect(script).toContain('PRIMARY KEY (customer_id, month)');
    expect(script).toContain('CREATE INDEX orders_customer_id_placed_at_idx ON public.orders (customer_id, placed_at);');
    expect(script).toContain('COMMENT ON COLUMN public.customers.email');
    // the flow edge is documentation, never a constraint
    expect(script).not.toContain('FOREIGN KEY (customer_id) REFERENCES public.orders');
    expect(script).toContain('ON CONFLICT (customer_id, month) DO UPDATE');
  });
});
