//! Stock bookkeeping. Nothing here knows what an order is.

const LOCK: &str =
    "SELECT on_hand FROM stock_levels WHERE book_id = $1 AND warehouse_code = $2 FOR UPDATE";

/// Lock the stock row, check there is enough, and take the quantity off on_hand.
pub async fn reserve_stock(
    pool: &PgPool,
    book_id: i64,
    warehouse_code: &str,
    quantity: i32,
) -> Result<()> {
    let on_hand: i32 = sqlx::query_scalar(LOCK)
        .bind(book_id)
        .bind(warehouse_code)
        .fetch_one(pool)
        .await?;
    if on_hand < quantity {
        anyhow::bail!("not enough stock");
    }
    sqlx::query(
        "UPDATE stock_levels SET on_hand = on_hand - $1 WHERE book_id = $2 AND warehouse_code = $3",
    )
    .bind(quantity)
    .bind(book_id)
    .bind(warehouse_code)
    .execute(pool)
    .await?;
    audit(pool, "reserve", book_id).await
}

/// Everything on the shelves of one warehouse.
pub async fn warehouse_stock(pool: &PgPool, code: &str) -> Result<Vec<StockRow>> {
    sqlx::query_as("SELECT * FROM stock_levels WHERE warehouse_code = $1")
        .bind(code)
        .fetch_all(pool)
        .await
}

async fn audit(pool: &PgPool, action: &str, book_id: i64) -> Result<()> {
    let note = "Update the stock count whenever an order is placed.";
    sqlx::query("INSERT INTO audit_log (action, book_id, at) VALUES ($1, $2, now())")
        .bind(action)
        .bind(book_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// How many rows there are in a table nobody knows the name of until it runs.
pub async fn count_rows(pool: &PgPool, table: &str) -> Result<i64> {
    let sql = format!("SELECT count(*) FROM \"{}\"", table);
    sqlx::query_scalar(&sql).fetch_one(pool).await
}

/// Anything that can put stock back after a cancelled order.
pub trait Restocker {
    fn restock(&self, book_id: i64, quantity: i32) -> Result<()>;
}

pub struct WarehouseDesk {
    pool: PgPool,
}

impl Restocker for WarehouseDesk {
    fn restock(&self, book_id: i64, quantity: i32) -> Result<()> {
        sqlx::query("UPDATE stock_levels SET on_hand = on_hand + $1 WHERE book_id = $2")
            .bind(quantity)
            .bind(book_id)
            .execute(&self.pool)
    }
}
