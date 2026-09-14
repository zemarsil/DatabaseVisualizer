// Everything about taking an order.
#pragma once

#include <pqxx/pqxx>
#include <vector>

#include "inventory.hpp"

namespace bookshop {

struct Line {
    long book_id;
    int quantity;
    long price_cents;
    std::string warehouse;
};

/// One per request; holds the connection.
class OrderService {
public:
    OrderService(pqxx::connection &conn, Inventory &inventory);

    /// Turn a cart into an order and its lines, then reserve the stock.
    long place_order(const std::string &email, const std::vector<Line> &cart);

    /// Price the cart where the database cannot see it.
    long total_cents(const std::vector<Line> &cart) const;

private:
    pqxx::connection &conn_;
    Inventory &inventory_;
};

}  // namespace bookshop
