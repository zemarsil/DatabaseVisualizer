// Stock bookkeeping. Nothing here knows what an order is.

const LOCK = 'SELECT on_hand FROM stock_levels WHERE book_id = $1 AND warehouse_code = $2 FOR UPDATE';

/** Lock the stock row, check there is enough, and take the quantity off on_hand. */
async function reserveStock(pool, bookId, code, quantity) {
  const locked = await pool.query(LOCK, [bookId, code]);
  if (locked.rows[0].on_hand < quantity) {
    throw new Error('not enough stock');
  }
  await pool.query('UPDATE stock_levels SET on_hand = on_hand - $1 WHERE book_id = $2 AND warehouse_code = $3', [
    quantity,
    bookId,
    code,
  ]);
  await audit(pool, 'reserve', bookId);
}

/** Everything on the shelves of one warehouse. */
async function warehouseStock(pool, code) {
  const { rows } = await pool.query('SELECT * FROM stock_levels WHERE warehouse_code = $1', [code]);
  return rows;
}

async function audit(pool, action, bookId) {
  const note = 'Update the stock count whenever an order is placed.';
  await pool.query('INSERT INTO audit_log (action, book_id, at) VALUES ($1, $2, now())', [action, bookId]);
}

module.exports = { reserveStock, warehouseStock, audit };
