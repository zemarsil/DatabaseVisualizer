// Everything about taking an order.

import type { Pool } from 'pg';
import { reserveStock } from './inventory.js';
import { toCents } from './money.js';

const INSERT_ORDER = `
INSERT INTO orders (customer_id, status, total_cents)
VALUES ($1, 'pending', $2)
RETURNING id
`;

/** One per request; holds the pool. */
export class OrderService {
  constructor(private readonly pool: Pool) {}

  /** Turn a cart into an order and its lines, then reserve the stock. */
  async placeOrder(email: string, cart: Line[]): Promise<number> {
    const found = await this.pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    const customerId = found.rows[0].id;
    const total = this.totalCents(cart);
    const created = await this.pool.query(INSERT_ORDER, [customerId, total]);
    const orderId = created.rows[0].id;
    for (const line of cart) {
      await this.pool.query(
        'INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)',
        [orderId, line.bookId, line.quantity, line.priceCents],
      );
      await reserveStock(this.pool, line.bookId, line.warehouse, line.quantity);
    }
    return orderId;
  }

  /** Price the cart where the database cannot see it. */
  totalCents(cart: Line[]): number {
    return cart.reduce((sum, line) => sum + toCents(line.priceCents) * line.quantity, 0);
  }

  async history(customerId: number): Promise<Row[]> {
    const { rows } = await this.pool.query(
      'SELECT o.id, o.placed_at, c.email FROM orders o ' +
        'JOIN customers c ON c.id = o.customer_id ' +
        'WHERE o.customer_id = $1 ORDER BY o.placed_at DESC',
      [customerId],
    );
    return rows;
  }
}
