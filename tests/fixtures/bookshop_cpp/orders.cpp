#include "orders.hpp"

#include "money.hpp"

namespace bookshop {

static const char *INSERT_ORDER = R"sql(
INSERT INTO orders (customer_id, status, total_cents)
VALUES ($1, 'pending', $2)
RETURNING id
)sql";

OrderService::OrderService(pqxx::connection &conn, Inventory &inventory)
    : conn_(conn), inventory_(inventory) {}

long OrderService::place_order(const std::string &email, const std::vector<Line> &cart) {
    pqxx::work tx{conn_};
    auto found = tx.exec_params("SELECT id FROM customers WHERE email = $1", email);
    long customer_id = found[0][0].as<long>();
    long total = total_cents(cart);
    auto created = tx.exec_params(INSERT_ORDER, customer_id, total);
    long order_id = created[0][0].as<long>();
    for (const auto &line : cart) {
        tx.exec_params(
            "INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents) "
            "VALUES ($1, $2, $3, $4)",
            order_id, line.book_id, line.quantity, line.price_cents);
        inventory_.reserve_stock(line.book_id, line.warehouse, line.quantity);
    }
    tx.commit();
    return order_id;
}

long OrderService::total_cents(const std::vector<Line> &cart) const {
    long total = 0;
    for (const auto &line : cart) {
        total += to_cents(line.price_cents) * line.quantity;
    }
    return total;
}

}  // namespace bookshop
