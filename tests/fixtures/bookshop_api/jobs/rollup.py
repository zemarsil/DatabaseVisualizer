"""Last night's orders, totalled per book per day."""

from .base import BaseJob

TABLE = "daily_sales"


class RollupJob(BaseJob):
    """Fills daily_sales from the orders placed since the last run."""

    def run(self):
        self.refresh_totals()
        cur = self.conn.cursor()
        cur.execute(
            f"""
            INSERT INTO {TABLE} (book_id, day, units, revenue_cents)
            SELECT i.book_id, date(o.placed_at), sum(i.quantity), sum(i.unit_price_cents * i.quantity)
            FROM order_items i
            JOIN orders o ON o.id = i.order_id
            WHERE o.placed_at >= %s
            GROUP BY 1, 2
            """,
            (self.since(),),
        )

    def refresh_totals(self):
        """Rebuild book_totals from daily_sales."""
        cur = self.conn.cursor()
        cur.execute("DELETE FROM book_totals; INSERT INTO book_totals (book_id, total_units, total_revenue_cents) "
                    "SELECT book_id, sum(units), sum(revenue_cents) FROM daily_sales GROUP BY book_id")

    def since(self):
        return "yesterday"
