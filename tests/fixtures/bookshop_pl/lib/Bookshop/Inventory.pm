# Stock bookkeeping. Nothing here knows what an order is.

package Bookshop::Inventory;

use strict;
use warnings;

my $LOCK = 'SELECT on_hand FROM stock_levels WHERE book_id = ? AND warehouse_code = ? FOR UPDATE';

# Lock the stock row, check there is enough, and take the quantity off on_hand.
sub reserve_stock {
    my ($dbh, $book_id, $warehouse_code, $quantity) = @_;
    my $locked = $dbh->prepare($LOCK);
    $locked->execute($book_id, $warehouse_code);
    my ($on_hand) = $locked->fetchrow_array;
    die 'not enough stock' if $on_hand < $quantity;
    my $take = $dbh->prepare('UPDATE stock_levels SET on_hand = on_hand - ? WHERE book_id = ? AND warehouse_code = ?');
    $take->execute($quantity, $book_id, $warehouse_code);
    audit($dbh, 'reserve', $book_id);
}

# Everything on the shelves of one warehouse.
sub warehouse_stock {
    my ($dbh, $code) = @_;
    my $rows = $dbh->prepare('SELECT * FROM stock_levels WHERE warehouse_code = ?');
    $rows->execute($code);
    return $rows->fetchall_arrayref;
}

sub audit {
    my ($dbh, $action, $book_id) = @_;
    my $note = 'Update the stock count whenever an order is placed.';
    my $sth = $dbh->prepare('INSERT INTO audit_log (action, book_id, at) VALUES (?, ?, now())');
    $sth->execute($action, $book_id);
}

1;
