import { describeRelationship, kindMeta, stepVerb, type Diagram, type Program, type Relationship, type Table } from '@shared/types';
import { codeLinks, type CodeLink } from './codemap';
import { externalTableIds } from './groups';
import { programLinks, type ProgramLink } from './programs';
import { quoteIdent } from './sql/dialect';

/**
 * One end of a path. Tables and code nodes are both places a trace can start,
 * pass through or end at, which is the whole reason the code side lives on the
 * same canvas: "which function reaches this table, and through what" is one
 * question, and this is the shape that lets it be answered as one.
 */
export interface TraceNode {
  id: string;
  name: string;
  kind: 'table' | 'code';
}

/** The arrow a hop walks when one end of it is code. */
export type TraceLink = { kind: 'table'; link: ProgramLink } | { kind: 'code'; link: CodeLink };

export interface PathHop {
  /** The connection walked, when the hop runs between two tables. */
  relationship?: Relationship;
  /** The derived arrow walked, when the hop touches a code node. Exactly one of the two is set. */
  link?: TraceLink;
  /** Node we leave on this hop. */
  from: TraceNode;
  /** Node we arrive at on this hop. */
  to: TraceNode;
  /** True when the hop follows the arrow backwards: relationship target to source, or against a call. */
  reversed: boolean;
}

export interface TraceResult {
  from: TraceNode;
  to: TraceNode;
  /** Every node on the path, in order, `from` first. */
  nodeIds: string[];
  relationshipIds: string[];
  hops: PathHop[];
}

interface Edge {
  next: string;
  relationship?: Relationship;
  link?: TraceLink;
  /** True when walking from `next`'s side of the arrow is the forward direction. */
  forwardFromHere: boolean;
}

function nodeOf(d: Diagram, id: string): TraceNode | undefined {
  const t = d.tables.find((x) => x.id === id);
  if (t) return { id, name: t.name, kind: 'table' };
  const p = d.programs.find((x) => x.id === id);
  return p ? { id, name: p.name, kind: 'code' } : undefined;
}

/**
 * The undirected graph a trace walks: every relationship between two tables,
 * every arrow a step draws to a table, every call, import and extends between
 * code nodes. Direction is remembered on each edge so a hop can say which way
 * it went, but it is never a reason not to walk it.
 */
function adjacency(d: Diagram): Map<string, Edge[]> {
  const adj = new Map<string, Edge[]>();
  const add = (a: string, b: string, edge: Omit<Edge, 'next' | 'forwardFromHere'>) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ ...edge, next: b, forwardFromHere: true });
    adj.get(b)!.push({ ...edge, next: a, forwardFromHere: false });
  };
  for (const r of d.relationships) {
    if (r.sourceTableId === r.targetTableId) continue;
    add(r.sourceTableId, r.targetTableId, { relationship: r });
  }
  // A read draws rows from the table into the code, a write the other way;
  // "forward" here is the direction the rows travel.
  for (const l of programLinks(d)) {
    if (l.op === 'read') add(l.tableId, l.programId, { link: { kind: 'table', link: l } });
    else add(l.programId, l.tableId, { link: { kind: 'table', link: l } });
  }
  for (const l of codeLinks(d)) {
    if (l.fromId === l.toId) continue;
    add(l.fromId, l.toId, { link: { kind: 'code', link: l } });
  }
  return adj;
}

/**
 * Breadth-first search for the shortest chain between two nodes, tables or
 * code, treating every connection and every derived arrow as undirected.
 * Returns null when they are not connected.
 */
export function findPath(d: Diagram, fromId: string, toId: string): TraceResult | null {
  const from = nodeOf(d, fromId);
  const to = nodeOf(d, toId);
  if (!from || !to) return null;
  if (fromId === toId) return { from, to, nodeIds: [fromId], relationshipIds: [], hops: [] };

  const adj = adjacency(d);
  const prev = new Map<string, { id: string; edge: Edge }>();
  const visited = new Set<string>([fromId]);
  const queue = [fromId];
  let found = false;
  while (queue.length && !found) {
    const cur = queue.shift()!;
    for (const edge of adj.get(cur) ?? []) {
      if (visited.has(edge.next)) continue;
      visited.add(edge.next);
      prev.set(edge.next, { id: cur, edge });
      if (edge.next === toId) {
        found = true;
        break;
      }
      queue.push(edge.next);
    }
  }
  if (!found) return null;

  const nodeIds: string[] = [];
  const hops: PathHop[] = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur)!;
    hops.unshift({
      relationship: p.edge.relationship,
      link: p.edge.link,
      from: nodeOf(d, p.id)!,
      to: nodeOf(d, cur)!,
      reversed: !p.edge.forwardFromHere,
    });
    nodeIds.unshift(cur);
    cur = p.id;
  }
  nodeIds.unshift(fromId);
  return { from, to, nodeIds, relationshipIds: hops.flatMap((h) => (h.relationship ? [h.relationship.id] : [])), hops };
}

/** Every node reachable from one, tables and code alike, with its distance in hops. */
export function reachableNodes(d: Diagram, fromId: string): Map<string, number> {
  const adj = adjacency(d);
  const dist = new Map<string, number>([[fromId, 0]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    const dcur = dist.get(cur)!;
    for (const edge of adj.get(cur) ?? []) {
      if (dist.has(edge.next)) continue;
      dist.set(edge.next, dcur + 1);
      queue.push(edge.next);
    }
  }
  return dist;
}

function codeName(d: Diagram, id: string): string {
  return d.programs.find((p: Program) => p.id === id)?.name ?? '?';
}

/**
 * Human-readable description of one hop, in the direction the path walks it:
 * "orders contains order_items", "daily_sales fed by order_items",
 * "place_order writes orders", "checkout calls place_order".
 */
export function describeHop(d: Diagram, hop: PathHop): string {
  const r = hop.relationship;
  if (r) {
    const src = d.tables.find((t) => t.id === r.sourceTableId)?.name ?? '?';
    const tgt = d.tables.find((t) => t.id === r.targetTableId)?.name ?? '?';
    const sentence = describeRelationship(r, src, tgt, hop.reversed ? 'inverse' : 'forward');
    return r.name ? `${sentence} (${r.name})` : sentence;
  }
  const link = hop.link;
  if (!link) return `${hop.from.name} → ${hop.to.name}`;
  if (link.kind === 'table') {
    const l = link.link;
    const table = d.tables.find((t) => t.id === l.tableId)?.name ?? '?';
    const code = codeName(d, l.programId);
    // Read as the code doing the verb, whichever way the path arrived.
    return l.op === 'read' ? `${code} reads ${table} (step ${l.step})` : `${code} writes ${table} (step ${l.step})`;
  }
  const l = link.link;
  const verb = stepVerb(l.op);
  return `${codeName(d, l.fromId)} ${verb} ${codeName(d, l.toId)} (step ${l.step})`;
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
 *
 * A path that passes through code is not a query at all — a function is not a
 * table you can join — so it comes back as the chain written out in comments,
 * which is still the answer to "how does this reach that".
 */
export function buildJoinQuery(d: Diagram, trace: TraceResult): string {
  const q = (s: string) => quoteIdent(s, d.dialect);
  const alias = (i: number) => `t${i}`;
  const lines: string[] = [];

  if (trace.hops.some((h) => !h.relationship)) {
    lines.push('-- This path runs through code, so there is no single query for it.');
    lines.push(`-- ${trace.from.name} → ${trace.to.name}:`);
    trace.hops.forEach((h, i) => lines.push(`--   ${i + 1}. ${describeHop(d, h)}`));
    return lines.join('\n');
  }

  // A path that leaves the schema you are designing cannot run as one query.
  const external = externalTableIds(d);
  const crossed = trace.nodeIds.filter((id) => external.has(id));
  if (crossed.length && crossed.length < trace.nodeIds.length) {
    const names = [...new Set(crossed.map((id) => d.tables.find((t) => t.id === id)?.name ?? '?'))];
    lines.push(`-- Heads up: this path crosses into another database (${names.join(', ')}).`);
    lines.push('-- The query below will not run as one statement; stage those tables first.');
  }

  lines.push(`SELECT ${trace.nodeIds.map((_, i) => `${alias(i)}.*`).join(', ')}`);
  lines.push(`FROM ${q(trace.from.name)} AS ${alias(0)}`);
  trace.hops.forEach((hop, i) => {
    const r = hop.relationship!;
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

export type { Table as TraceTable };
