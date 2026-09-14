// Everything about taking an order.

const { reserveStock } = require('./inventory');
const { toCents } = require('./money');

const INSERT_ORDER = `
INSERT INTO orders (customer_id, status, total_cents)
VALUES ($1, 'pending', $2)
RETURNING id
`;

/** One per request; holds the pool. */
class OrderService {
  constructor(pool) {
    this.pool = pool;
  }

  /** Turn a cart into an order and its lines, then reserve the stock. */
  async placeOrder(email, cart) {
    const found = await this.pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    const customerId = found.rows[0].id;
    const total = this.totalCents(cart);
    const created = await this.pool.query(INSERT_ORDER, [customerId, total]);
    for (const line of cart) {
      await this.pool.query(
        'INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)',
        [created.rows[0].id, line.bookId, line.quantity, line.priceCents],
      );
      await reserveStock(this.pool, line.bookId, line.warehouse, line.quantity);
    }
    return created.rows[0].id;
  }

  /** Price the cart where the database cannot see it. */
  totalCents(cart) {
    return cart.reduce((sum, line) => sum + toCents(line.priceCents) * line.quantity, 0);
  }
}

module.exports = { OrderService };
