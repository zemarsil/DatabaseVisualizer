// Stock bookkeeping. Nothing here knows what an order is.

import type { Pool } from 'pg';

const LOCK = 'SELECT on_hand FROM stock_levels WHERE book_id = $1 AND warehouse_code = $2 FOR UPDATE';

/** Lock the stock row, check there is enough, and take the quantity off on_hand. */
export async function reserveStock(pool: Pool, bookId: number, code: string, quantity: number): Promise<void> {
  const locked = await pool.query(LOCK, [bookId, code]);
  if (locked.rows[0].on_hand < quantity) {
    throw new Error('not enough stock');
  }
  await pool.query(
    'UPDATE stock_levels SET on_hand = on_hand - $1 WHERE book_id = $2 AND warehouse_code = $3',
    [quantity, bookId, code],
  );
  await audit(pool, 'reserve', bookId);
}

/** Everything on the shelves of one warehouse. */
export async function warehouseStock(pool: Pool, code: string): Promise<Row[]> {
  const { rows } = await pool.query('SELECT * FROM stock_levels WHERE warehouse_code = $1', [code]);
  return rows;
}

async function audit(pool: Pool, action: string, bookId: number): Promise<void> {
  const note = 'Update the stock count whenever an order is placed.';
  await pool.query('INSERT INTO audit_log (action, book_id, at) VALUES ($1, $2, now())', [action, bookId]);
}

/** How many rows there are in a table nobody knows the name of until it runs. */
export async function countRows(pool: Pool, table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) FROM "${table}"`);
  return rows[0].count;
}
