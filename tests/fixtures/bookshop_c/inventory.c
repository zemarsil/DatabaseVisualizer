/* Stock bookkeeping. Nothing here knows what an order is. */
#include <stdio.h>
#include <string.h>

#include "inventory.h"

static const char *LOCK =
    "SELECT on_hand FROM stock_levels "
    "WHERE book_id = $1 AND warehouse_code = $2 FOR UPDATE";

static void audit(PGconn *conn, const char *action, long book_id);

/* Lock the stock row, check there is enough, and take the quantity off on_hand. */
int reserve_stock(PGconn *conn, long book_id, const char *warehouse_code, int quantity)
{
    const char *values[2];
    PGresult *locked = PQexecParams(conn, LOCK, 2, NULL, values, NULL, NULL, 0);
    if (atoi(PQgetvalue(locked, 0, 0)) < quantity) {
        return -1;
    }
    PQexecParams(conn,
                 "UPDATE stock_levels SET on_hand = on_hand - $1 "
                 "WHERE book_id = $2 AND warehouse_code = $3",
                 3, NULL, values, NULL, NULL, 0);
    audit(conn, "reserve", book_id);
    return 0;
}

/* Everything on the shelves of one warehouse. */
PGresult *warehouse_stock(PGconn *conn, const char *code)
{
    const char *values[1] = {code};
    return PQexecParams(conn, "SELECT * FROM stock_levels WHERE warehouse_code = $1",
                        1, NULL, values, NULL, NULL, 0);
}

static void audit(PGconn *conn, const char *action, long book_id)
{
    const char *note = "Update the stock count whenever an order is placed.";
    PQexec(conn, "INSERT INTO audit_log (action, book_id, at) VALUES ($1, $2, now())");
}

/* How many rows there are in a table nobody knows the name of until it runs. */
long count_rows(PGconn *conn, const char *table)
{
    char sql[256];
    snprintf(sql, sizeof sql, "SELECT count(*) FROM \"%s\"", table);
    PQexec(conn, sql);
    return 0;
}
