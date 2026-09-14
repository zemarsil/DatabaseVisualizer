// Prices, in the one unit the schema stores.

function toCents(price) {
  return Math.round(price * 100);
}

module.exports = { toCents };
