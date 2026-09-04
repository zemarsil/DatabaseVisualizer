import type { Diagram } from '@shared/types';
import { layoutDiagram } from './layout';
import { createNote, createRelationship, emptyDiagram } from './model';
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
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

export function sampleDiagram(): Diagram {
  const d = emptyDiagram('postgresql', 'Shop example');
  const imported = importSql(SAMPLE_SQL, 'postgresql');
  d.tables = imported.tables;
  d.relationships = imported.relationships;

  const orderItems = d.tables.find((t) => t.name === 'order_items');
  const daily = d.tables.find((t) => t.name === 'daily_sales');
  const orders = d.tables.find((t) => t.name === 'orders');
  if (orderItems && daily && orders) {
    d.relationships.push(
      createRelationship({
        kind: 'flow',
        name: 'nightly rollup',
        sourceTableId: orderItems.id,
        sourceColumnIds: [],
        targetTableId: daily.id,
        targetColumnIds: [],
        note: 'Runs at 02:00 via cron; replaces the previous day.',
        query: `INSERT INTO daily_sales (day, product_id, units_sold, revenue_cents)
SELECT o.placed_at::date, oi.product_id,
       SUM(oi.quantity), SUM(oi.quantity * oi.unit_price_cents)
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.placed_at::date = CURRENT_DATE - 1
  AND o.status = 'paid'
GROUP BY 1, 2;`,
      }),
    );
  }

  const positions = layoutDiagram(d, { direction: 'LR' });
  for (const t of d.tables) t.position = positions[t.id] ?? t.position;

  d.notes.push(
    createNote({
      text: 'Tip: drag from a column handle to another column to add a foreign key. Select an edge to tag it with a query.',
      position: { x: 40, y: -140 },
      width: 300,
      height: 90,
    }),
  );
  return d;
}
