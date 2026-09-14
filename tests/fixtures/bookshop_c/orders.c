/* Everything about taking an order. */
#include "orders.h"
#include "inventory.h"
#include "money.h"

static const char *INSERT_ORDER =
    "INSERT INTO orders (customer_id, status, total_cents) "
    "VALUES ($1, 'pending', $2) RETURNING id";

static long total_cents(const struct line *cart, int lines);

/* Turn a cart into an order and its lines, then reserve the stock. */
long place_order(PGconn *conn, const char *email, const struct line *cart, int lines)
{
    const char *values[4];
    PGresult *found = PQexecParams(conn, "SELECT id FROM customers WHERE email = $1",
                                   1, NULL, values, NULL, NULL, 0);
    long customer_id = atol(PQgetvalue(found, 0, 0));
    long total = total_cents(cart, lines);
    PGresult *created = PQexecParams(conn, INSERT_ORDER, 2, NULL, values, NULL, NULL, 0);
    long order_id = atol(PQgetvalue(created, 0, 0));
    for (int i = 0; i < lines; i++) {
        PQexecParams(conn,
                     "INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents) "
                     "VALUES ($1, $2, $3, $4)",
                     4, NULL, values, NULL, NULL, 0);
        reserve_stock(conn, cart[i].book_id, cart[i].warehouse, cart[i].quantity);
    }
    return order_id;
}

/* Price the cart where the database cannot see it. */
static long total_cents(const struct line *cart, int lines)
{
    long total = 0;
    for (int i = 0; i < lines; i++) {
        total += to_cents(cart[i].price) * cart[i].quantity;
    }
    return total;
}
