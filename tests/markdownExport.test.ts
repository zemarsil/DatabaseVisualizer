import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { generateMarkdown } from '../src/lib/markdownExport';
import { importSql } from '../src/lib/sql/import';
import { emptyDiagram } from '../src/lib/model';

function diagramFrom(sql: string, dialect: Diagram['dialect']): Diagram {
  const d = emptyDiagram(dialect, 'Shop');
  const r = importSql(sql, dialect);
  d.tables = r.tables;
  d.relationships = r.relationships;
  return d;
}

const SHOP = `
CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE);
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  total NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0)
);
CREATE INDEX idx_orders_customer ON orders (customer_id);
COMMENT ON TABLE orders IS 'Orders';
`;

describe('generateMarkdown', () => {
  it('renders each table as a markdown table with its columns', () => {
    const d = diagramFrom(SHOP, 'postgresql');
    const md = generateMarkdown(d);
    expect(md).toContain('# Shop');
    expect(md).toContain('### customers');
    expect(md).toContain('### orders');
    expect(md).toContain('| Column | Type | Nullable | Default | Key | Check | Comment |');
    expect(md).toContain('| email | VARCHAR(255) | no |');
    expect(md).toContain('| customer_id | INTEGER | no |');
  });

  it('marks primary and foreign key columns', () => {
    const d = diagramFrom(SHOP, 'postgresql');
    const md = generateMarkdown(d);
    const idRow = md.split('\n').find((l) => l.startsWith('| id |'));
    expect(idRow).toContain('PK');
    const customerIdRow = md.split('\n').find((l) => l.startsWith('| customer_id |'));
    expect(customerIdRow).toContain('FK');
  });

  it('includes a relationships table with source/target columns and actions', () => {
    const d = diagramFrom(SHOP, 'postgresql');
    const md = generateMarkdown(d);
    expect(md).toContain('## Relationships');
    expect(md).toContain('| From table | From columns | To table | To columns | Kind | Name | On delete | On update | Note |');
    expect(md).toContain('| orders | customer_id | customers | id | FK |');
    expect(md).toContain('CASCADE');
  });

  it('includes indexes and table checks', () => {
    const d = diagramFrom(SHOP, 'postgresql');
    const md = generateMarkdown(d);
    expect(md).toContain('**Indexes**');
    expect(md).toContain('idx_orders_customer');
    expect(md).toContain('total >= 0');
  });

  it('handles a diagram with no tables', () => {
    const d = emptyDiagram('postgresql', 'Empty');
    const md = generateMarkdown(d);
    expect(md).toBe('# Empty\n');
  });
});
