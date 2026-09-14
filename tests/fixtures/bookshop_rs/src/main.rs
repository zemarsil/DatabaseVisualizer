//! Routes. Everything here is reached by the framework, never by our own code.

mod inventory;
mod orders;

use orders::OrderService;

/// Take a checkout and turn it into an order.
#[post("/orders")]
async fn place_order_route(state: State, body: Checkout) -> Result<Json<Created>> {
    let service = OrderService::new(state.pool.clone());
    let id = service.place_order(&body.email, &body.cart).await?;
    Ok(Json(Created { id }))
}

#[get("/stock/{code}")]
async fn stock_route(state: State, code: String) -> Result<Json<Vec<StockRow>>> {
    let rows = inventory::warehouse_stock(&state.pool, &code).await?;
    Ok(Json(rows))
}

#[tokio::main]
async fn main() -> Result<()> {
    serve().await
}
