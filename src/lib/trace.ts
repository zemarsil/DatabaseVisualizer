import { describeRelationship, kindMeta, type Diagram, type Relationship, type Table } from '@shared/types';
import { externalTableIds } from './groups';
import { quoteIdent } from './sql/dialect';

export interface PathHop {
  relationship: Relationship;
  /** Table we arrive at on this hop. */
  from: Table;
  to: Table;
  /** True when the hop follows the relationship from target (parent) to source (child). */
  reversed: boolean;
}

export interface TraceResult {
  from: Table;
  to: Table;
  tableIds: string[];
  relationshipIds: string[];
  hops: PathHop[];
}

/**
 * Breadth-first search for the shortest chain of relationships between two
 * tables, treating every relationship (FK or data flow) as undirected.
 * Returns null when the tables are not connected.
 */
export function findPath(d: Diagram, fromId: string, toId: string): TraceResult | null {
  const from = d.tables.find((t) => t.id === fromId);
  const to = d.tables.find((t) => t.id === toId);
  if (!from || !to) return null;
  if (fromId === toId) return { from, to, tableIds: [fromId], relationshipIds: [], hops: [] };

  const adj = new Map<string, { rel: Relationship; next: string }[]>();
  for (const r of d.relationships) {
    if (r.sourceTableId === r.targetTableId) continue;
    if (!adj.has(r.sourceTableId)) adj.set(r.sourceTableId, []);
    if (!adj.has(r.targetTableId)) adj.set(r.targetTableId, []);
    adj.get(r.sourceTableId)!.push({ rel: r, next: r.targetTableId });
    adj.get(r.targetTableId)!.push({ rel: r, next: r.sourceTableId });
  }

  const prev = new Map<string, { tableId: string; rel: Relationship }>();
  const visited = new Set<string>([fromId]);
  const queue = [fromId];
  let found = false;
  while (queue.length && !found) {
    const cur = queue.shift()!;
    for (const { rel, next } of adj.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, { tableId: cur, rel });
      if (next === toId) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }
  if (!found) return null;

  const tableIds: string[] = [];
  const hops: PathHop[] = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur)!;
    const fromT = d.tables.find((t) => t.id === p.tableId)!;
    const toT = d.tables.find((t) => t.id === cur)!;
    hops.unshift({ relationship: p.rel, from: fromT, to: toT, reversed: p.rel.targetTableId === p.tableId });
    tableIds.unshift(cur);
    cur = p.tableId;
  }
  tableIds.unshift(fromId);
  return { from, to, tableIds, relationshipIds: hops.map((h) => h.relationship.id), hops };
}

/** All tables reachable from a table, with their distance in hops. */
export function reachableTables(d: Diagram, fromId: string): Map<string, number> {
  const dist = new Map<string, number>([[fromId, 0]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    const dcur = dist.get(cur)!;
    for (const r of d.relationships) {
      const other = r.sourceTableId === cur ? r.targetTableId : r.targetTableId === cur ? r.sourceTableId : null;
      if (other && !dist.has(other)) {
        dist.set(other, dcur + 1);
        queue.push(other);
      }
    }
  }
  return dist;
}

/**
 * Human-readable description of one hop, in the direction the path walks it:
 * "orders contains order_items", "daily_sales fed by order_items".
 */
export function describeHop(d: Diagram, hop: PathHop): string {
  const r = hop.relationship;
  const src = d.tables.find((t) => t.id === r.sourceTableId)?.name ?? '?';
  const tgt = d.tables.find((t) => t.id === r.targetTableId)?.name ?? '?';
  const sentence = describeRelationship(r, src, tgt, hop.reversed ? 'inverse' : 'forward');
  return r.name ? `${sentence} (${r.name})` : sentence;
}

/** Where an embedded table is stored, e.g. "orders.items_snapshot". */
function embedLocation(d: Diagram, r: Relationship): string | null {
  if (r.kind !== 'embed') return null;
  const src = d.tables.find((t) => t.id === r.sourceTableId);
  const col = src?.columns.find((c) => c.id === r.sourceColumnIds[0]);
  return src && col ? `${src.name}.${col.name}` : null;
}

/**
 * A SELECT that joins every table along a traced path using the FK columns.
 * Only foreign keys carry a join condition; the documentation kinds (data
 * flows, serialized copies, dependencies) are emitted as comments instead.
 */
export function buildJoinQuery(d: Diagram, trace: TraceResult): string {
  const q = (s: string) => quoteIdent(s, d.dialect);
  const alias = (i: number) => `t${i}`;
  const lines: string[] = [];

  // A path that leaves the schema you are designing cannot run as one query.
  const external = externalTableIds(d);
  const crossed = trace.tableIds.filter((id) => external.has(id));
  if (crossed.length && crossed.length < trace.tableIds.length) {
    const names = [...new Set(crossed.map((id) => d.tables.find((t) => t.id === id)?.name ?? '?'))];
    lines.push(`-- Heads up: this path crosses into another database (${names.join(', ')}).`);
    lines.push('-- The query below will not run as one statement; stage those tables first.');
  }

  lines.push(`SELECT ${trace.tableIds.map((_, i) => `${alias(i)}.*`).join(', ')}`);
  lines.push(`FROM ${q(trace.from.name)} AS ${alias(0)}`);
  trace.hops.forEach((hop, i) => {
    const r = hop.relationship;
    const a = `t${i}`;
    const b = `t${i + 1}`;
    if (!kindMeta(r.kind).joinable) {
      const where = embedLocation(d, r);
      lines.push(`-- ${describeHop(d, hop)}: ${kindMeta(r.kind).label.toLowerCase()} link${where ? ` stored in ${where}` : ''}, no join condition`);
      lines.push(`CROSS JOIN ${q(hop.to.name)} AS ${b}`);
      return;
    }
    const src = d.tables.find((t) => t.id === r.sourceTableId)!;
    const tgt = d.tables.find((t) => t.id === r.targetTableId)!;
    const pairs = r.sourceColumnIds.map((sid, k) => {
      const sc = src.columns.find((c) => c.id === sid)?.name ?? '?';
      const tc = tgt.columns.find((c) => c.id === r.targetColumnIds[k])?.name ?? '?';
      // hop.from is either src or tgt; map each side to its alias
      const fromIsSrc = hop.from.id === src.id;
      const left = fromIsSrc ? `${a}.${q(sc)}` : `${a}.${q(tc)}`;
      const right = fromIsSrc ? `${b}.${q(tc)}` : `${b}.${q(sc)}`;
      return `${left} = ${right}`;
    });
    lines.push(`JOIN ${q(hop.to.name)} AS ${b} ON ${pairs.join(' AND ')}`);
  });
  return lines.join('\n') + ';';
}
