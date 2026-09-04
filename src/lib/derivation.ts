/**
 * Helpers for the structured `derivation` metadata on flow relationships.
 *
 * These are pure string/shape utilities shared by the inspector, the canvas edge
 * label and the SQL generator, so a derivation reads the same everywhere. They
 * deliberately do not parse SQL: expressions, grouping keys and filters are the
 * user's text, passed through as written.
 */
import type { Derivation, Relationship, Table } from '@shared/types';

/** Structured derivations of a relationship; always empty for foreign keys. */
export function flowDerivations(r: Relationship): Derivation[] {
  return r.kind === 'flow' ? (r.derivations ?? []) : [];
}

/** The source-side value: "SUM(quantity * unit_price_cents)", "COUNT(*)", "status". */
export function derivationValue(d: Derivation): string {
  const expr = d.expression.trim();
  if (!d.aggregate) return expr;
  if (!expr) return d.aggregate === 'COUNT' ? 'COUNT(*)' : `${d.aggregate}()`;
  return `${d.aggregate}(${expr})`;
}

export function derivationGroupBy(d: Derivation): string[] {
  return d.groupBy.map((g) => g.trim()).filter(Boolean);
}

/** A derivation is usable once it names a target column and produces a value. */
export function isDerivationComplete(d: Derivation): boolean {
  return Boolean(d.targetColumnId) && Boolean(derivationValue(d));
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
