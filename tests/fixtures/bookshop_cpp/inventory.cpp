#include "inventory.hpp"

namespace bookshop {

static const char *LOCK = R"sql(
SELECT on_hand FROM stock_levels
WHERE book_id = $1 AND warehouse_code = $2
FOR UPDATE
)sql";

Inventory::Inventory(pqxx::connection &conn) : conn_(conn) {}

void Inventory::reserve_stock(long book_id, const std::string &warehouse_code, int quantity) {
    pqxx::work tx{conn_};
    auto locked = tx.exec_params(LOCK, book_id, warehouse_code);
    if (locked[0][0].as<int>() < quantity) {
        throw std::runtime_error("not enough stock");
    }
    tx.exec_params(
        "UPDATE stock_levels SET on_hand = on_hand - $1 "
        "WHERE book_id = $2 AND warehouse_code = $3",
        quantity, book_id, warehouse_code);
    audit("reserve", book_id);
    tx.commit();
}

pqxx::result Inventory::warehouse_stock(const std::string &code) {
    pqxx::work tx{conn_};
    return tx.exec_params("SELECT * FROM stock_levels WHERE warehouse_code = $1", code);
}

void Inventory::restock(long book_id, int quantity) {
    pqxx::work tx{conn_};
    tx.exec_params("UPDATE stock_levels SET on_hand = on_hand + $1 WHERE book_id = $2", quantity, book_id);
    tx.commit();
}

void Inventory::audit(const std::string &action, long book_id) {
    const std::string note = "Update the stock count whenever an order is placed.";
    pqxx::work tx{conn_};
    tx.exec_params("INSERT INTO audit_log (action, book_id, at) VALUES ($1, $2, now())", action, book_id);
    tx.commit();
}

}  // namespace bookshop
