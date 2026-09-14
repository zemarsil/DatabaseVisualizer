// Package orders is everything about taking an order.
package orders

import (
	"database/sql"

	"example.com/bookshop/inventory"
	"example.com/bookshop/money"
)

const insertOrder = `
INSERT INTO orders (customer_id, status, total_cents)
VALUES ($1, 'pending', $2) RETURNING id
`

// Service holds the connection for one request.
type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// PlaceOrder turns a cart into an order and its lines, then reserves the stock.
func (s *Service) PlaceOrder(email string, cart []Line) (int64, error) {
	var customerID int64
	err := s.db.QueryRow("SELECT id FROM customers WHERE email = $1", email).Scan(&customerID)
	if err != nil {
		return 0, err
	}
	total := s.TotalCents(cart)
	var orderID int64
	if err := s.db.QueryRow(insertOrder, customerID, total).Scan(&orderID); err != nil {
		return 0, err
	}
	for _, line := range cart {
		_, err := s.db.Exec(
			"INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
			orderID, line.BookID, line.Quantity, line.PriceCents)
		if err != nil {
			return 0, err
		}
		if err := inventory.ReserveStock(s.db, line.BookID, line.Warehouse, line.Quantity); err != nil {
			return 0, err
		}
	}
	return orderID, nil
}

// TotalCents prices the cart where the database cannot see it.
func (s *Service) TotalCents(cart []Line) int64 {
	var total int64
	for _, line := range cart {
		total += money.ToCents(line.PriceCents) * int64(line.Quantity)
	}
	return total
}

func (s *Service) History(customerID int64) (*sql.Rows, error) {
	return s.db.Query(
		"SELECT o.id, o.placed_at, c.email FROM orders o "+
			"JOIN customers c ON c.id = o.customer_id "+
			"WHERE o.customer_id = $1 ORDER BY o.placed_at DESC",
		customerID)
}
