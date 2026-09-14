// Where the program starts.
#include <iostream>

#include "inventory.hpp"
#include "orders.hpp"

int main() {
    pqxx::connection conn{std::getenv("DATABASE_URL")};
    bookshop::Inventory inventory{conn};
    bookshop::OrderService service{conn, inventory};
    service.place_order("reader@example.com", {});
    std::cout << inventory.warehouse_stock("LDN").size() << "\n";
    return 0;
}
