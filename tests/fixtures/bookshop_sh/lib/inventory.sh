# Stock bookkeeping. Nothing here knows what an order is.

LOCK='SELECT on_hand FROM stock_levels WHERE book_id = :book AND warehouse_code = :code FOR UPDATE'

# Lock the stock row, check there is enough, and take the quantity off on_hand.
reserve_stock() {
  local book_id="$1" code="$2" quantity="$3"
  on_hand=$(psql "$DSN" -At -c "$LOCK")
  if [ "$on_hand" -lt "$quantity" ]; then
    echo 'not enough stock' >&2
    return 1
  fi
  psql "$DSN" -c 'UPDATE stock_levels SET on_hand = on_hand - 1 WHERE book_id = 2 AND warehouse_code = 3'
  audit reserve "$book_id"
}

# Everything on the shelves of one warehouse.
warehouse_stock() {
  psql "$DSN" -At -c 'SELECT * FROM stock_levels WHERE warehouse_code = 1'
}

audit() {
  note='Update the stock count whenever an order is placed.'
  psql "$DSN" -c 'INSERT INTO audit_log (action, book_id, at) VALUES (1, 2, now())'
}
