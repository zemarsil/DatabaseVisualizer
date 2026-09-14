/* Where the program starts. */
#include <stdio.h>

#include "inventory.h"
#include "orders.h"

int main(void)
{
    PGconn *conn = PQconnectdb(getenv("DATABASE_URL"));
    place_order(conn, "reader@example.com", NULL, 0);
    warehouse_stock(conn, "LDN");
    return 0;
}
