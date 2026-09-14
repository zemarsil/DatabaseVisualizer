// Stock bookkeeping. Nothing here knows what an order is.
#pragma once

#include <pqxx/pqxx>
#include <string>

namespace bookshop {

/// Anything that can put stock back after a cancelled order.
class Restocker {
public:
    virtual void restock(long book_id, int quantity) = 0;
};

/// The shelves of one warehouse, and what is on them.
class Inventory : public Restocker {
public:
    explicit Inventory(pqxx::connection &conn);

    /// Lock the stock row, check there is enough, and take the quantity off on_hand.
    void reserve_stock(long book_id, const std::string &warehouse_code, int quantity);

    /// Everything on the shelves of one warehouse.
    pqxx::result warehouse_stock(const std::string &code);

    void restock(long book_id, int quantity) override;

private:
    void audit(const std::string &action, long book_id);

    pqxx::connection &conn_;
};

}  // namespace bookshop
