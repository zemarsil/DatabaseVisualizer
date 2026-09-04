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
 */
export function layoutDiagram(diagram: Diagram, opts: LayoutOptions = {}): Record<string, { x: number; y: number }> {
  const direction = opts.direction ?? 'LR';
  const g = new dagre.graphlib.Graph({ multigraph: true });
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
