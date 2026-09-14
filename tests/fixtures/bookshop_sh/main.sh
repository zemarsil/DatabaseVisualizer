#!/usr/bin/env bash
# Where the service starts.

set -euo pipefail

source lib/orders.sh

DSN="${DATABASE_URL:-postgresql://localhost/bookshop}"

main() {
  settings=$(yq -o=json '.' 'config/settings.yaml')
  rates=$(jq -c . 'config/rates.json')
  place_order "$1" "$2"
}

main "$@"
