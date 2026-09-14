package com.example.bookshop;

import com.example.bookshop.stock.Inventory;
import java.sql.Connection;
import java.util.List;

/** Routes. Everything here is reached by the framework, never by our own code. */
public class Routes {
    private final Connection conn;

    public Routes(Connection conn) {
        this.conn = conn;
    }

    /** Take a checkout and turn it into an order. */
    @PostMapping("/orders")
    public long placeOrderRoute(Checkout body) throws Exception {
        OrderService service = new OrderService(conn);
        return service.placeOrder(body.email(), body.cart());
    }

    @GetMapping("/stock/{code}")
    public List<StockRow> stockRoute(String code) throws Exception {
        return Inventory.warehouseStock(conn, code);
    }
}
