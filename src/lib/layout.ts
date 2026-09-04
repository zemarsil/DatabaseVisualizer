import dagre from '@dagrejs/dagre';
import type { Diagram } from '@shared/types';
import { estimateNodeSize } from './geometry';

export type LayoutDirection = 'LR' | 'TB';

export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Measured node sizes from the canvas; falls back to estimates. */
  sizes?: Record<string, { width: number; height: number }>;
  nodeSpacing?: number;
  rankSpacing?: number;
}

/**
 * "Detangle": a layered (Sugiyama-style) layout. Tables are ranked so that
 * referenced tables sit to the left (or top) of the tables that reference
 * them, and dagre's crossing-minimisation orders each layer so that edges
 * cross as little as possible. Disconnected components are packed side by
 * side.
 *
 * Tables that share a schema form a group. Dagre's compound-graph support
 * (setParent) keeps each group's tables contiguous through ranking and
 * ordering, so detangle can reflow a diagram without pulling a table out of
 * its schema's cluster or dropping an unrelated table in the middle of one.
 */
export function layoutDiagram(diagram: Diagram, opts: LayoutOptions = {}): Record<string, { x: number; y: number }> {
  const direction = opts.direction ?? 'LR';
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  g.setGraph({
    rankdir: direction,
    nodesep: opts.nodeSpacing ?? 60,
    ranksep: opts.rankSpacing ?? 120,
    marginx: 40,
    marginy: 40,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const t of diagram.tables) {
    const size = opts.sizes?.[t.id] ?? estimateNodeSize(t.columns);
    g.setNode(t.id, { width: size.width, height: size.height });
  }

  // Cluster tables by schema so a group's members stay together.
  const groupCounts = new Map<string, number>();
  for (const t of diagram.tables) {
    if (!t.schema) continue;
    groupCounts.set(t.schema, (groupCounts.get(t.schema) ?? 0) + 1);
  }
  for (const t of diagram.tables) {
    if (!t.schema || (groupCounts.get(t.schema) ?? 0) < 2) continue;
    const clusterId = `cluster:${t.schema}`;
    if (!g.hasNode(clusterId)) g.setNode(clusterId, {});
    g.setParent(t.id, clusterId);
  }

  const seen = new Set<string>();
  for (const r of diagram.relationships) {
    if (r.sourceTableId === r.targetTableId) continue;
    if (!g.hasNode(r.sourceTableId) || !g.hasNode(r.targetTableId)) continue;
    // Edge direction: parent (referenced) -> child (referencing), so parents rank first.
    const key = `${r.targetTableId}->${r.sourceTableId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    g.setEdge(r.targetTableId, r.sourceTableId, { weight: r.kind === 'fk' ? 2 : 1 }, r.id);
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const t of diagram.tables) {
    const n = g.node(t.id);
    if (!n) continue;
    // dagre reports centres; React Flow wants top-left corners.
    positions[t.id] = { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) };
  }
  return positions;
}
