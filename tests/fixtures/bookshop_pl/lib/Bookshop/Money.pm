# Money, in the only unit the database stores it in. Touches nothing.

package Bookshop::Money;

use strict;
use warnings;

sub to_cents {
    my ($amount) = @_;
    return int($amount * 100 + 0.5);
}

1;
