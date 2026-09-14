// Prices, in the one unit the schema stores.

export function toCents(price: number): number {
  return Math.round(price * 100);
}
