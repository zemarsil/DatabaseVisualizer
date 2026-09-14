/* Everything about taking an order. */
#ifndef BOOKSHOP_ORDERS_H
#define BOOKSHOP_ORDERS_H

#include <libpq-fe.h>

long place_order(PGconn *conn, const char *email, const struct line *cart, int lines);

#endif
