// Package inventory is stock bookkeeping. Nothing here knows what an order is.
package inventory

import (
	"database/sql"
	"errors"
	"fmt"
)

const lockRow = `SELECT on_hand FROM stock_levels WHERE book_id = $1 AND warehouse_code = $2 FOR UPDATE`

// Restocker is anything that can put stock back after a cancelled order.
type Restocker interface {
	Restock(bookID int64, quantity int) error
}

// ReserveStock locks the row, checks there is enough, and takes the quantity off.
func ReserveStock(db *sql.DB, bookID int64, warehouseCode string, quantity int) error {
	var onHand int
	if err := db.QueryRow(lockRow, bookID, warehouseCode).Scan(&onHand); err != nil {
		return err
	}
	if onHand < quantity {
		return errors.New("not enough stock")
	}
	_, err := db.Exec(
		"UPDATE stock_levels SET on_hand = on_hand - $1 WHERE book_id = $2 AND warehouse_code = $3",
		quantity, bookID, warehouseCode)
	if err != nil {
		return err
	}
	return Audit(db, "reserve", bookID)
}

// WarehouseStock is everything on the shelves of one warehouse.
func WarehouseStock(db *sql.DB, code string) (*sql.Rows, error) {
	return db.Query("SELECT * FROM stock_levels WHERE warehouse_code = $1", code)
}

func Audit(db *sql.DB, action string, bookID int64) error {
	note := "Update the stock count whenever an order is placed."
	_ = note
	_, err := db.Exec("INSERT INTO audit_log (action, book_id, at) VALUES ($1, $2, now())", action, bookID)
	return err
}

// CountRows counts a table nobody knows the name of until it runs.
func CountRows(db *sql.DB, table string) (int64, error) {
	var n int64
	err := db.QueryRow(fmt.Sprintf(`SELECT count(*) FROM "%s"`, table)).Scan(&n)
	return n, err
}
