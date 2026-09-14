//! Everything about taking an order.

use crate::inventory::reserve_stock;
use crate::money::to_cents;

/// One per request; holds the pool.
pub struct OrderService {
    pool: PgPool,
}

impl OrderService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Turn a cart into an order and its lines, then reserve the stock.
    pub async fn place_order(&self, email: &str, cart: &[Line]) -> Result<i64> {
        let customer_id: i64 = sqlx::query_scalar("SELECT id FROM customers WHERE email = $1")
            .bind(email)
            .fetch_one(&self.pool)
            .await?;
        let total = self.total_cents(cart);
        let order_id: i64 = sqlx::query_scalar(
            "INSERT INTO orders (customer_id, status, total_cents) \
             VALUES ($1, 'pending', $2) RETURNING id",
        )
        .bind(customer_id)
        .bind(total)
        .fetch_one(&self.pool)
        .await?;
        for line in cart {
            sqlx::query(
                r#"
                INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents)
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(order_id)
            .bind(line.book_id)
            .bind(line.quantity)
            .bind(line.price)
            .execute(&self.pool)
            .await?;
            reserve_stock(&self.pool, line.book_id, &line.warehouse, line.quantity).await?;
        }
        Ok(order_id)
    }

    /// Price the cart where the database cannot see it.
    fn total_cents(&self, cart: &[Line]) -> i64 {
        cart.iter().map(|line| to_cents(line.price) * line.quantity as i64).sum()
    }

    pub async fn history(&self, customer_id: i64) -> Result<Vec<PgRow>> {
        sqlx::query(
            "SELECT o.id, o.placed_at, c.email FROM orders o \
             JOIN customers c ON c.id = o.customer_id \
             WHERE o.customer_id = $1 ORDER BY o.placed_at DESC",
        )
        .bind(customer_id)
        .fetch_all(&self.pool)
        .await
    }
}
