# Everything about taking an order.

package Bookshop::Orders;

use strict;
use warnings;
use Bookshop::Inventory qw(reserve_stock);
use Bookshop::Money qw(to_cents);

my $INSERT_ORDER = <<'SQL';
INSERT INTO orders (customer_id, status, total_cents)
VALUES (?, 'pending', ?) RETURNING id
SQL

# Turn a cart into an order and its lines, then reserve the stock.
sub place_order {
    my ($self, $email, $cart) = @_;
    my $dbh = $self->{dbh};
    my $found = $dbh->prepare("SELECT id FROM customers WHERE email = ?");
    $found->execute($email);
    my ($customer_id) = $found->fetchrow_array;
    my $total = $self->total_cents($cart);
    my $created = $dbh->prepare($INSERT_ORDER);
    $created->execute($customer_id, $total);
    my ($order_id) = $created->fetchrow_array;
    for my $line (@$cart) {
        my $item = $dbh->prepare(<<'SQL');
INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents)
VALUES (?, ?, ?, ?)
SQL
        $item->execute($order_id, $line->{book_id}, $line->{quantity}, $line->{price});
        reserve_stock($dbh, $line->{book_id}, $line->{warehouse}, $line->{quantity});
    }
    return $order_id;
}

# Price the cart where the database cannot see it.
sub total_cents {
    my ($self, $cart) = @_;
    my $sum = 0;
    $sum += to_cents($_->{price}) * $_->{quantity} for @$cart;
    return $sum;
}

1;
