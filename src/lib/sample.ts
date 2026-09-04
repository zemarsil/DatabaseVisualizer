import type { Diagram, RelationshipVerb } from '@shared/types';
import { layoutDiagram } from './layout';
import { createDerivation, createGroup, createNote, createRelationship, emptyDiagram } from './model';
import { importSql } from './sql/import';

const SAMPLE_SQL = `
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE customers IS 'People who can place orders';

CREATE TABLE addresses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  line1 VARCHAR(200) NOT NULL,
  city VARCHAR(80) NOT NULL,
  country CHAR(2) NOT NULL DEFAULT 'US'
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  ship_to_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  items_snapshot JSONB
);
CREATE INDEX idx_orders_customer ON orders (customer_id);

CREATE TABLE order_items (
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE daily_sales (
  day DATE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  units_sold INTEGER NOT NULL,
  revenue_cents BIGINT NOT NULL,
  PRIMARY KEY (day, product_id)
);
COMMENT ON TABLE daily_sales IS 'Nightly rollup built from order_items';
`;

/** A second database the shop reads from but does not own. */
const CRM_SQL = `
CREATE TABLE crm_accounts (
  account_id INTEGER PRIMARY KEY,
  company VARCHAR(200) NOT NULL,
  tier VARCHAR(20) NOT NULL,
  signed_at DATE NOT NULL
);

CREATE TABLE crm_contacts (
  contact_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES crm_accounts(account_id),
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(120) NOT NULL
);
`;

export function sampleDiagram(): Diagram {
  const d = emptyDiagram('postgresql', 'Shop example');
  const imported = importSql(SAMPLE_SQL, 'postgresql');
  d.tables = imported.tables;
  d.relationships = imported.relationships;

  const orderItems = d.tables.find((t) => t.name === 'order_items');
  const daily = d.tables.find((t) => t.name === 'daily_sales');
  const orders = d.tables.find((t) => t.name === 'orders');

  // Show what each reading of a foreign key looks like: customers *has*
  // addresses, orders *contains* its items, orders merely *uses* an address.
  const setVerb = (tableName: string, columnName: string, verb: RelationshipVerb) => {
    const t = d.tables.find((x) => x.name === tableName);
    const col = t?.columns.find((c) => c.name === columnName);
    const rel = col && d.relationships.find((r) => r.kind === 'fk' && r.sourceTableId === t!.id && r.sourceColumnIds[0] === col.id);
    if (rel) rel.verb = verb;
  };
  setVerb('addresses', 'customer_id', 'belongs-to');
  setVerb('order_items', 'order_id', 'part-of');
  setVerb('orders', 'ship_to_id', 'uses');

  if (orderItems && daily && orders) {
    const dailyCol = (name: string) => daily.columns.find((c) => c.name === name)?.id ?? '';
    // Two derived columns off one flow, both rolled up the same way. The free-text
    // query below says the same thing plus the join to orders, which the structured
    // form does not model - the two are meant to be read side by side.
    const rollup = { groupBy: ['product_id', 'day'], filter: "status = 'paid'", aggregate: 'SUM' as const };
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        name: 'nightly rollup',
        sourceTableId: orderItems.id,
        sourceColumnIds: [],
        targetTableId: daily.id,
        targetColumnIds: [],
        note: 'Runs at 02:00 via cron; replaces the previous day.',
        derivations: [
          createDerivation({ ...rollup, targetColumnId: dailyCol('units_sold'), expression: 'quantity' }),
          createDerivation({ ...rollup, targetColumnId: dailyCol('revenue_cents'), expression: 'quantity * unit_price_cents' }),
        ],
        query: `INSERT INTO daily_sales (day, product_id, units_sold, revenue_cents)
SELECT o.placed_at::date, oi.product_id,
       SUM(oi.quantity), SUM(oi.quantity * oi.unit_price_cents)
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.placed_at::date = CURRENT_DATE - 1
  AND o.status = 'paid'
GROUP BY 1, 2;`,
      }),
      createRelationship({
        kind: 'embed',
        verb: 'serializes',
        name: 'priced-at-purchase copy',
        sourceTableId: orders.id,
        sourceColumnIds: [orders.columns.find((c) => c.name === 'items_snapshot')?.id ?? ''].filter(Boolean),
        targetTableId: orderItems.id,
        targetColumnIds: [],
        note: 'Frozen JSON copy of the lines as they were when the order was placed. No constraint enforces it.',
      }),
      createRelationship({
        kind: 'dependency',
        verb: 'uses',
        name: 'rollup reads placed_at / status',
        sourceTableId: daily.id,
        sourceColumnIds: [],
        targetTableId: orders.id,
        targetColumnIds: [],
        note: 'The nightly job joins orders for the date and the paid filter, but no column of daily_sales points at it.',
      }),
    );
  }

  // The CRM lives in its own database: grouped, marked external, so the schema
  // script documents it instead of trying to create it.
  const crm = importSql(CRM_SQL, 'postgresql', d);
  const crmGroup = createGroup({ name: 'CRM (read-only)', color: 'purple', external: true, note: 'Reporting replica; we only ever SELECT from it.' });
  for (const t of crm.tables) t.groupId = crmGroup.id;
  d.groups.push(crmGroup);
  d.tables.push(...crm.tables);
  d.relationships.push(...crm.relationships);

  const contacts = crm.tables.find((t) => t.name === 'crm_contacts');
  const customers = d.tables.find((t) => t.name === 'customers');
  if (contacts && customers) {
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        name: 'nightly customer sync',
        sourceTableId: contacts.id,
        sourceColumnIds: [],
        targetTableId: customers.id,
        targetColumnIds: [],
        note: 'Pulled from the CRM database; no foreign key, the tables are not in the same server.',
        query: `INSERT INTO customers (email, full_name)
SELECT c.email, c.full_name
FROM crm_contacts c
JOIN crm_accounts a ON a.account_id = c.account_id
WHERE a.tier <> 'churned'
ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name;`,
      }),
    );
  }

  const positions = layoutDiagram(d, { direction: 'LR' });
  for (const t of d.tables) t.position = positions[t.id] ?? t.position;

  d.notes.push(
    createNote({
      text: 'Tip: drag from a column handle to another column to add a foreign key. Select any edge to change its kind (foreign key, data flow, serialized, dependency) and how it reads.\nThe dashed region is a second database: press G to make one of your own.',
      position: { x: 40, y: -140 },
      width: 300,
      height: 90,
    }),
  );
  return d;
}
