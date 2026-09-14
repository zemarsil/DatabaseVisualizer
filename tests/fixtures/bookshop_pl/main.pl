#!/usr/bin/env perl
# Where the service starts.

use strict;
use warnings;
use DBI;
use Bookshop::Orders;

sub main {
    my $dbh = DBI->connect($ENV{DATABASE_URL}, '', '', { RaiseError => 1 });
    my $service = { dbh => $dbh };
    return $service;
}

main() unless caller;
