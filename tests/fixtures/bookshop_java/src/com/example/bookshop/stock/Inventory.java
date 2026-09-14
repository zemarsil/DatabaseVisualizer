package com.example.bookshop.stock;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.List;

/** Stock bookkeeping. Nothing here knows what an order is. */
public final class Inventory {
    private static final String LOCK =
            "SELECT on_hand FROM stock_levels WHERE book_id = ? AND warehouse_code = ? FOR UPDATE";

    /** Lock the stock row, check there is enough, and take the quantity off on_hand. */
    public static void reserveStock(Connection conn, long bookId, String code, int quantity) throws Exception {
        PreparedStatement lock = conn.prepareStatement(LOCK);
        lock.setLong(1, bookId);
        lock.setString(2, code);
        ResultSet rows = lock.executeQuery();
        rows.next();
        if (rows.getInt(1) < quantity) {
            throw new IllegalStateException("not enough stock");
        }
        PreparedStatement take = conn.prepareStatement(
                "UPDATE stock_levels SET on_hand = on_hand - ? WHERE book_id = ? AND warehouse_code = ?");
        take.executeUpdate();
        audit(conn, "reserve", bookId);
    }

    /** Everything on the shelves of one warehouse. */
    public static List<StockRow> warehouseStock(Connection conn, String code) throws Exception {
        PreparedStatement statement = conn.prepareStatement("SELECT * FROM stock_levels WHERE warehouse_code = ?");
        statement.setString(1, code);
        return StockRow.of(statement.executeQuery());
    }

    static void audit(Connection conn, String action, long bookId) throws Exception {
        String note = "Update the stock count whenever an order is placed.";
        PreparedStatement statement = conn.prepareStatement(
                "INSERT INTO audit_log (action, book_id, at) VALUES (?, ?, now())");
        statement.executeUpdate();
    }

    /** How many rows there are in a table nobody knows the name of until it runs. */
    public static long countRows(Connection conn, String table) throws Exception {
        PreparedStatement statement = conn.prepareStatement("SELECT count(*) FROM \"" + table + "\"");
        return 0;
    }
}
