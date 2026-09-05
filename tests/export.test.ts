import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { importSql } from '../src/lib/sql/import';
import { createGroup, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { exportMermaid, mermaidName, mermaidType } from '../src/lib/export/mermaid';
import { exportDbml } from '../src/lib/export/dbml';
import { exportDiagram } from '../src/lib/export';
import { generateMarkdown } from '../src/lib/markdownExport';

const SQL = `
CREATE TYPE order_status AS ENUM ('pending', 'paid');
CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, note TEXT);
COMMENT ON COLUMN customers.note IS 'Free "text"';
CREATE TABLE orders (id BIGSERIAL PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE, status order_status, total NUMERIC(10,2));
CREATE TABLE profiles (customer_id INTEGER PRIMARY KEY REFERENCES customers(id));
CREATE TABLE order_items (order_id BIGINT NOT NULL REFERENCES orders(id), line INT, PRIMARY KEY (order_id, line));
CREATE INDEX idx_orders_customer ON orders (customer_id);
`;

function diagram(): Diagram {
  const d = emptyDiagram('postgresql', 'Shop');
  const r = importSql(SQL, 'postgresql');
  d.tables = r.tables;
  d.relationships = r.relationships;
  d.customTypes = r.customTypes;
  const daily = createTable({ name: 'daily_sales', kind: 'view', viewSql: 'SELECT 1' });
  d.tables.push(daily);
  const orders = d.tables.find((t) => t.name === 'orders')!;
  d.relationships.push(createRelationship({ kind: 'flow', sourceTableId: orders.id, sourceColumnIds: [], targetTableId: daily.id, targetColumnIds: [], name: 'nightly' }));
  const g = createGroup({ name: 'Warehouse', external: true });
  d.groups.push(g);
  d.tables.find((t) => t.name === 'profiles')!.groupId = g.id;
  return d;
}

describe('exportMermaid', () => {
  it('sanitises names and types', () => {
    expect(mermaidName('public.my table')).toBe('public_my_table');
    expect(mermaidType('DOUBLE PRECISION')).toBe('DOUBLE_PRECISION');
    expect(mermaidType('NUMERIC(10,2)')).toBe('NUMERIC(10_2)');
    expect(mermaidType('TEXT[]')).toBe('TEXT[]');
  });

  it('writes entities with keys, comments and relationships with the right cardinality', () => {
    const out = exportMermaid(diagram());
    expect(out.startsWith('erDiagram')).toBe(true);
    expect(out).toContain('customers {');
    expect(out).toContain('INTEGER id PK');
    expect(out).toContain('VARCHAR(255) email UK');
    expect(out).toContain(`TEXT note "Free 'text'"`);
    expect(out).toContain('INTEGER customer_id FK');
    // optional many-to-one, non-identifying
    expect(out).toContain('customers |o..o{ orders : "customer_id"');
    // identifying one-to-one (profiles.customer_id is the PK)
    expect(out).toContain('customers ||--|| profiles : "customer_id"');
    // identifying many-to-one (order_id is part of the composite PK)
    expect(out).toContain('orders ||--o{ order_items : "order_id"');
    expect(out).toContain('%% view: daily_sales');
    expect(out).toContain('%% external: Warehouse');
    expect(out).toContain('orders }o..o{ daily_sales : "nightly"');
  });

  it('can leave documentation links and comments out', () => {
    const out = exportMermaid(diagram(), { includeComments: false, includeDocumentation: false });
    expect(out).not.toContain('nightly');
    expect(out).not.toContain('Free');
  });
});

describe('exportDbml', () => {
  it('emits project, enum, tables, indexes, refs, groups and notes', () => {
    const out = exportDbml(diagram());
    expect(out).toContain("database_type: 'PostgreSQL'");
    expect(out).toContain('Enum order_status {\n  pending\n  paid\n}');
    expect(out).toContain('Table customers');
    expect(out).toContain('id INTEGER [pk, increment]');
    expect(out).toContain('email VARCHAR(255) [not null, unique]');
    expect(out).toContain('(order_id, line) [pk]');
    expect(out).toContain("(customer_id) [name: 'idx_orders_customer']");
    expect(out).toContain('Ref: orders.customer_id > customers.id [delete: cascade]');
    expect(out).toContain('TableGroup Warehouse {\n  profiles');
    expect(out).toContain('// view\nTable daily_sales');
    expect(out).toContain('Note link_1_flow');
  });
});

describe('generateMarkdown additions', () => {
  it('adds a summary, a mermaid block, types, groups, view SQL and back references', () => {
    const md = generateMarkdown(diagram());
    expect(md).toContain('PostgreSQL · 4 tables · 1 view');
    expect(md).toContain('```mermaid\nerDiagram');
    expect(md).toContain('## Custom types');
    expect(md).toContain('| order_status | enum | pending, paid |');
    expect(md).toContain('## Groups');
    expect(md).toContain('### daily_sales _(view)_');
    expect(md).toContain('```sql\nSELECT 1\n```');
    expect(md).toContain('**Referenced by** [orders](#orders), [profiles](#profiles)');
    expect(md).toContain('orders feeds daily_sales (nightly)');
  });

  it('keeps the empty diagram output minimal', () => {
    expect(generateMarkdown(emptyDiagram('postgresql', 'Empty'))).toBe('# Empty\n');
  });
});

describe('exportDiagram', () => {
  it('picks filenames and mime types per format', () => {
    const d = diagram();
    expect(exportDiagram(d, 'sql').filename).toBe('shop.sql');
    expect(exportDiagram(d, 'mermaid').filename).toBe('shop.mmd');
    expect(exportDiagram(d, 'dbml').filename).toBe('shop.dbml');
    expect(exportDiagram(d, 'markdown').mime).toBe('text/markdown');
    expect(exportDiagram(d, 'sql').text).toContain('CREATE TABLE');
  });
});
