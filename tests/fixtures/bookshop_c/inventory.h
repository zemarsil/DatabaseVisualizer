/* Stock bookkeeping. Nothing here knows what an order is. */
#ifndef BOOKSHOP_INVENTORY_H
#define BOOKSHOP_INVENTORY_H

#include <libpq-fe.h>

int reserve_stock(PGconn *conn, long book_id, const char *warehouse_code, int quantity);
PGresult *warehouse_stock(PGconn *conn, const char *code);

#endif
