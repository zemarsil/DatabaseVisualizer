# Money, in the only unit the database stores it in. Touches nothing.

total_cents() {
  echo $(( ${1:-0} * 100 ))
}
