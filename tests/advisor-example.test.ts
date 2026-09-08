import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseDiagramFile } from '@/lib/io';
import { generateSchema } from '@/lib/sql/generator';

const FILE = 'docs/examples/orders-rollup.dbviz.json';

/** Guards the example that docs/ADVISOR_OUTPUT_FORMAT.md points advisor agents at. */
describe(FILE, () => {
  const diagram = parseDiagramFile(readFileSync(FILE, 'utf8'));

  it('loads with every part of the model intact', () => {
    expect(diagram.dialect).toBe('postgresql');
    expect(diagram.tables.map((t) => t.name)).toEqual(['crm_contacts', 'customers', 'orders', 'customer_month_totals', 'v_customer_dashboard']);
    expect(diagram.customTypes.map((t) => t.name)).toEqual(['order_status']);
    expect(diagram.groups.map((g) => g.name)).toEqual(['CRM (read-only)']);
    expect(diagram.tables.find((t) => t.name === 'crm_contacts')!.groupId).toBe(diagram.groups[0].id);
    expect(diagram.tables.find((t) => t.name === 'v_customer_dashboard')!.kind).toBe('view');
    expect(diagram.notes).toHaveLength(2);
  });

  it('keeps every relationship kind the doc documents', () => {
    const byKind = (kind: string) => diagram.relationships.filter((r) => r.kind === kind);
    expect(byKind('fk')).toHaveLength(3);
    expect(byKind('flow')).toHaveLength(1);
    expect(byKind('dependency')).toHaveLength(1);

    const flow = byKind('flow')[0];
    expect(flow.verb).toBe('feeds');
    expect(flow.inverseName).toBe('rolled up from');
    expect(flow.derivations).toHaveLength(2);
    // every derivation fills a real column of the target table
    const rollup = diagram.tables.find((t) => t.name === 'customer_month_totals')!;
    for (const d of flow.derivations!) expect(rollup.columns.some((c) => c.id === d.targetColumnId)).toBe(true);
  });

  it('generates the DDL the recommendation describes', () => {
    const { script } = generateSchema(diagram);
    expect(script).toContain("CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');");
    expect(script).toContain('CREATE TABLE public.customer_month_totals');
    expect(script).toContain('PRIMARY KEY (customer_id, month)');
    expect(script).toContain('CREATE INDEX orders_customer_id_placed_at_idx ON public.orders (customer_id, placed_at);');
    expect(script).toContain('COMMENT ON COLUMN public.customers.email');
    expect(script).toContain('CREATE VIEW public.v_customer_dashboard AS');
    // the external CRM table is documented, never created
    expect(script).not.toContain('CREATE TABLE crm_contacts');
    // flow and dependency edges are documentation, never constraints
    expect(script).not.toContain('REFERENCES public.customer_month_totals');
    expect(script).toContain('ON CONFLICT (customer_id, month) DO UPDATE');
  });

  it('passes its own validator with no errors or warnings', () => {
    const out = execFileSync('node', ['scripts/validate-dbviz.mjs', FILE], { encoding: 'utf8' });
    expect(out).toContain('OK');
  });
});
