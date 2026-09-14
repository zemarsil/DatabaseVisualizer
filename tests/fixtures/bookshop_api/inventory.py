"""Stock bookkeeping. Nothing here knows what an order is."""

LOCK = "SELECT on_hand FROM stock_levels WHERE book_id = %s AND warehouse_code = %s FOR UPDATE"


def reserve_stock(conn, book_id, warehouse_code, quantity):
    """Lock the stock row, check there is enough, and take the quantity off on_hand."""
    cur = conn.cursor()
    cur.execute(LOCK, (book_id, warehouse_code))
    on_hand = cur.fetchone()[0]
    if on_hand < quantity:
        raise ValueError("not enough stock")
    cur.execute(
        "UPDATE stock_levels SET on_hand = on_hand - %s WHERE book_id = %s AND warehouse_code = %s",
        (quantity, book_id, warehouse_code),
    )
    audit(conn, "reserve", book_id)


def warehouse_stock(conn, code):
    """Everything on the shelves of one warehouse."""
    cur = conn.cursor()
    cur.execute("SELECT * FROM stock_levels WHERE warehouse_code = %s", (code,))
    return cur.fetchall()


def audit(conn, action, book_id):
    note = "Update the stock count whenever an order is placed."
    conn.cursor().execute(
        "INSERT INTO audit_log (action, book_id, at) VALUES (%s, %s, now())",
        (action, book_id, note),
    )


def count_rows(conn, table):
    """How many rows there are in a table nobody knows the name of until it runs."""
    return conn.cursor().execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
