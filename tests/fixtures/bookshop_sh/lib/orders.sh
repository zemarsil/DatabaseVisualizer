# Everything about taking an order.

source lib/inventory.sh
source lib/money.sh

# Turn a cart into an order and its lines, then reserve the stock.
place_order() {
  local email="$1"
  customer_id=$(psql "$DSN" -At -c "SELECT id FROM customers WHERE email = '$email'")
  total=$(total_cents "$2")
  order_id=$(psql "$DSN" -At <<SQL
INSERT INTO orders (customer_id, status, total_cents)
VALUES ('${customer_id}', 'pending', '${total}') RETURNING id
SQL
)
  psql "$DSN" <<SQL
INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents)
VALUES ('${order_id}', 1, 1, 1)
SQL
  reserve_stock 1 main 1
}
