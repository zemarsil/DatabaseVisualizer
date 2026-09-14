"""Everything about taking an order."""

from .inventory import reserve_stock
from .money import to_cents


class OrderService:
    """One instance per request; holds the database connection."""

    def __init__(self, conn):
        self.conn = conn

    def place_order(self, email, cart):
        """Turn a cart into an order and its lines, then reserve the stock."""
        cur = self.conn.cursor()
        cur.execute("SELECT id FROM customers WHERE email = %s", (email,))
        customer_id = cur.fetchone()[0]
        total = self.total_cents(cart)
        cur.execute(
            "INSERT INTO orders (customer_id, status, total_cents)"
            " VALUES (%s, 'pending', %s) RETURNING id",
            (customer_id, total),
        )
        order_id = cur.fetchone()[0]
        for line in cart:
            cur.execute(
                """
                INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents)
                VALUES (%s, %s, %s, %s)
                """,
                (order_id, line["book_id"], line["quantity"], line["price"]),
            )
            reserve_stock(self.conn, line["book_id"], line["warehouse"], line["quantity"])
        return order_id

    def total_cents(self, cart):
        """Price the cart where the database cannot see it."""
        return sum(to_cents(line["price"]) * line["quantity"] for line in cart)

    def history(self, customer_id):
        cur = self.conn.cursor()
        cur.execute(
            "SELECT o.id, o.placed_at, c.email FROM orders o"
            " JOIN customers c ON c.id = o.customer_id"
            " WHERE o.customer_id = %s ORDER BY o.placed_at DESC",
            (customer_id,),
        )
        return cur.fetchall()
