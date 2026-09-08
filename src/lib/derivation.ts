/**
 * Helpers for the structured `derivation` metadata on flow relationships.
 *
 * These are pure string/shape utilities shared by the inspector, the canvas edge
 * label, the SQL generator and the simulator, so a derivation reads the same
 * everywhere. They deliberately do not parse SQL: expressions, grouping keys and
 * filters are the user's text, passed through as written.
 */
import { windowMeta, type Derivation, type DerivationWindow, type Relationship, type Table } from '@shared/types';

/** Structured derivations of a relationship; always empty for foreign keys. */
export function flowDerivations(r: Relationship): Derivation[] {
  return r.kind === 'flow' ? (r.derivations ?? []) : [];
}

function cleanKeys(keys: string[] | undefined): string[] {
  return (keys ?? []).map((k) => k.trim()).filter(Boolean);
}

/** The OVER (...) clause of a window as text: "PARTITION BY device_id ORDER BY ts". */
export function windowClause(w: DerivationWindow): string {
  const parts: string[] = [];
  const partition = cleanKeys(w.partitionBy);
  const order = cleanKeys(w.orderBy);
  if (partition.length) parts.push(`PARTITION BY ${partition.join(', ')}`);
  if (order.length) parts.push(`ORDER BY ${order.join(', ')}`);
  return parts.join(' ');
}

/**
 * The value before any aggregate: the expression itself, or the sequence
 * operation applied to it, e.g. "DIFF(placed_at) OVER (PARTITION BY customer_id
 * ORDER BY placed_at)". Documentation form: the SQL generator writes the real
 * per-dialect window function.
 */
export function derivationRowValue(d: Derivation): string {
  const expr = d.expression.trim();
  if (!d.window) return expr;
  const meta = windowMeta(d.window.fn);
  const inner = meta.needsExpression ? expr : '';
  if (meta.needsExpression && !inner) return '';
  return `${d.window.fn}(${inner}) OVER (${windowClause(d.window)})`;
}

/** The source-side value: "SUM(quantity * unit_price_cents)", "COUNT(*)", "status". */
export function derivationValue(d: Derivation): string {
  const inner = derivationRowValue(d);
  if (!d.aggregate) return inner;
  if (!inner) return d.aggregate === 'COUNT' ? 'COUNT(*)' : `${d.aggregate}()`;
  return `${d.aggregate}(${inner})`;
}

export function derivationGroupBy(d: Derivation): string[] {
  return cleanKeys(d.groupBy);
}

/**
 * A derivation is usable once it names a target column and produces a value. A
 * sequence operation additionally needs an order, or "previous row" means nothing.
 */
export function isDerivationComplete(d: Derivation): boolean {
  if (!d.targetColumnId || !derivationValue(d)) return false;
  if (d.window && cleanKeys(d.window.orderBy).length === 0) return false;
  return true;
}

/**
 * One-line summary, e.g.
 * "revenue_cents = SUM(quantity * unit_price_cents) GROUP BY product_id, day WHERE status = 'paid'".
 */
export function derivationSummary(d: Derivation, targetColumnName?: string): string {
  const value = derivationValue(d) || '?';
  const parts = [`${targetColumnName || '?'} = ${value}`];
  const groups = derivationGroupBy(d);
  if (groups.length) parts.push(`GROUP BY ${groups.join(', ')}`);
  const filter = d.filter?.trim();
  if (filter) parts.push(`WHERE ${filter}`);
  return parts.join(' ');
}

/** Name of the column a derivation fills, or undefined if it points nowhere. */
export function derivationTargetName(d: Derivation, targetTable: Pick<Table, 'columns'> | undefined): string | undefined {
  return targetTable?.columns.find((c) => c.id === d.targetColumnId)?.name;
}

/** Summaries for every derivation on a flow, in editor order. */
export function derivationSummaries(r: Relationship, targetTable: Pick<Table, 'columns'> | undefined): string[] {
  return flowDerivations(r).map((d) => derivationSummary(d, derivationTargetName(d, targetTable)));
}

/**
 * Derivations that share a grouping and a filter can be written as one
 * INSERT ... SELECT, so bucket them by that signature (order preserved).
 */
export function groupDerivations(entries: Derivation[]): { groupBy: string[]; filter: string; entries: Derivation[] }[] {
  const out: { groupBy: string[]; filter: string; entries: Derivation[] }[] = [];
  for (const d of entries) {
    const groupBy = derivationGroupBy(d);
    const filter = d.filter?.trim() ?? '';
    const key = out.find((g) => g.filter === filter && g.groupBy.length === groupBy.length && g.groupBy.every((x, i) => x === groupBy[i]));
    if (key) key.entries.push(d);
    else out.push({ groupBy, filter, entries: [d] });
  }
  return out;
}

/** An ordering key split into its expression and direction: "ts DESC" -> { expression: "ts", desc: true }. */
export function parseOrderKey(key: string): { expression: string; desc: boolean } {
  const m = /^(.*?)\s+(ASC|DESC)\s*$/i.exec(key.trim());
  if (m) return { expression: m[1].trim(), desc: m[2].toUpperCase() === 'DESC' };
  return { expression: key.trim(), desc: false };
}
