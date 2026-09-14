package com.example.bookshop;

import com.example.bookshop.stock.Inventory;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.List;

/** Everything about taking an order. One instance per request. */
public class OrderService extends BaseService {
    private static final String INSERT_ORDER = """
            INSERT INTO orders (customer_id, status, total_cents)
            VALUES (?, 'pending', ?)
            """;

    private final Connection conn;

    public OrderService(Connection conn) {
        this.conn = conn;
    }

    /** Turn a cart into an order and its lines, then reserve the stock. */
    public long placeOrder(String email, List<Line> cart) throws Exception {
        long customerId;
        try (PreparedStatement find = conn.prepareStatement("SELECT id FROM customers WHERE email = ?")) {
            find.setString(1, email);
            ResultSet rows = find.executeQuery();
            rows.next();
            customerId = rows.getLong(1);
        }
        long total = totalCents(cart);
        long orderId;
        try (PreparedStatement insert = conn.prepareStatement(INSERT_ORDER)) {
            insert.setLong(1, customerId);
            insert.setLong(2, total);
            insert.executeUpdate();
            orderId = 0;
        }
        for (Line line : cart) {
            try (PreparedStatement item = conn.prepareStatement(
                    "INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents) "
                            + "VALUES (?, ?, ?, ?)")) {
                item.setLong(1, orderId);
                item.executeUpdate();
            }
            Inventory.reserveStock(conn, line.bookId(), line.warehouse(), line.quantity());
        }
        return orderId;
    }

    /** Price the cart where the database cannot see it. */
    public long totalCents(List<Line> cart) {
        long total = 0;
        for (Line line : cart) {
            total += Money.toCents(line.priceCents()) * line.quantity();
        }
        return total;
    }

    public ResultSet history(long customerId) throws Exception {
        PreparedStatement statement = conn.prepareStatement(
                "SELECT o.id, o.placed_at, c.email FROM orders o "
                        + "JOIN customers c ON c.id = o.customer_id "
                        + "WHERE o.customer_id = ? ORDER BY o.placed_at DESC");
        statement.setLong(1, customerId);
        return statement.executeQuery();
    }
}
