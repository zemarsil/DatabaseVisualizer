// Package main wires the routes up. Everything here is reached by the
// framework, never by our own code.
package main

import (
	"net/http"

	"example.com/bookshop/inventory"
	"example.com/bookshop/orders"
)

// PlaceOrderRoute takes a checkout and turns it into an order.
func PlaceOrderRoute(w http.ResponseWriter, r *http.Request) {
	service := orders.NewService(db)
	id, err := service.PlaceOrder(r.FormValue("email"), cartOf(r))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, id)
}

func StockRoute(w http.ResponseWriter, r *http.Request) {
	rows, err := inventory.WarehouseStock(db, r.PathValue("code"))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, rows)
}
