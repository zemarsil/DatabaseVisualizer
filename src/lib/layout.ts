import dagre from '@dagrejs/dagre';
import type { Diagram, Relationship, RelationshipKind } from '@shared/types';
import { estimateNodeSize } from './geometry';
import { estimateProgramSize, programTableIds } from './programs';
import { effectiveDisplay, visibleColumns } from './visibleColumns';

/**
 * Which end of a connection should be ranked first, and how hard dagre should
 * try to keep the two tables apart in adjacent ranks.
 *
 * The rule is "whatever the other end depends on comes first": the referenced
 * parent before its children, the upstream table before what is derived from
 * it, the container before the shape serialized inside it, the provider before
 * its consumer.
 */
const RANK_RULES: Record<RelationshipKind, { fromTarget: boolean; weight: number }> = {
  fk: { fromTarget: true, weight: 2 },
  flow: { fromTarget: false, weight: 1 },
  embed: { fromTarget: false, weight: 2 },
  dependency: { fromTarget: true, weight: 1 },
};

function rankEdge(r: Relationship): { from: string; to: string; weight: number } {
  const rule = RANK_RULES[r.kind] ?? RANK_RULES.fk;
  return rule.fromTarget
    ? { from: r.targetTableId, to: r.sourceTableId, weight: rule.weight }
    : { from: r.sourceTableId, to: r.targetTableId, weight: rule.weight };
}

export type LayoutDirection = 'LR' | 'TB';

export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Measured node sizes from the canvas; falls back to estimates. */
  sizes?: Record<string, { width: number; height: number }>;
  nodeSpacing?: number;
  rankSpacing?: number;
}

/**
 * "Detangle": a layered (Sugiyama-style) layout. Tables are ranked by the
 * rules above — whatever the other end depends on comes first — and dagre's
 * crossing-minimisation orders each layer so that edges cross as little as
 * possible. Disconnected components are packed side by side.
 *
 * Grouped tables are handed to dagre as clusters, so a group's tables stay
 * together and no ungrouped table is dropped in the middle of a region.
 */
export function layoutDiagram(diagram: Diagram, opts: LayoutOptions = {}): Record<string, { x: number; y: number }> {
  const fkColumns = new Map<string, Set<string>>();
  for (const r of diagram.relationships) {
    if (r.kind !== 'fk') continue;
    if (!fkColumns.has(r.sourceTableId)) fkColumns.set(r.sourceTableId, new Set());
    for (const id of r.sourceColumnIds) fkColumns.get(r.sourceTableId)!.add(id);
  }
  const usedGroups = new Set(diagram.tables.map((t) => t.groupId).filter((id): id is string => Boolean(id) && diagram.groups.some((g) => g.id === id)));

  const build = (withClusters: boolean) => {
    const direction = opts.direction ?? 'LR';
    const g = new dagre.graphlib.Graph({ multigraph: true, compound: withClusters });
    g.setGraph({
      rankdir: direction,
      // Clusters need more room: the region border and its title bar have to
      // fit between a group's tables and whatever is laid out next to them.
      nodesep: opts.nodeSpacing ?? (withClusters ? 84 : 60),
      ranksep: opts.rankSpacing ?? (withClusters ? 140 : 120),
      marginx: 40,
      marginy: 40,
      ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const t of diagram.tables) {
      const size = opts.sizes?.[t.id] ?? estimateNodeSize(visibleColumns(t, effectiveDisplay(t, false), fkColumns.get(t.id) ?? new Set()));
      g.setNode(t.id, { width: size.width, height: size.height });
    }

    if (withClusters) {
      for (const id of usedGroups) g.setNode(id, {});
      for (const t of diagram.tables) {
        if (t.groupId && usedGroups.has(t.groupId)) g.setParent(t.id, t.groupId);
      }
    }

    const seen = new Set<string>();
    for (const r of diagram.relationships) {
      if (r.sourceTableId === r.targetTableId) continue;
      if (!g.hasNode(r.sourceTableId) || !g.hasNode(r.targetTableId)) continue;
      const { from, to, weight } = rankEdge(r);
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      g.setEdge(from, to, { weight }, r.id);
    }

    dagre.layout(g);

    const positions: Record<string, { x: number; y: number }> = {};
    for (const t of diagram.tables) {
      const n = g.node(t.id);
      if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      // dagre reports centres; React Flow wants top-left corners.
      positions[t.id] = { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) };
    }
    return positions;
  };

  const tables = usedGroups.size === 0 ? build(false) : clusteredOrPlain();

  function clusteredOrPlain(): Record<string, { x: number; y: number }> {
    try {
      const clustered = build(true);
      // dagre's cluster support can bail out on awkward graphs; a result that is
      // missing tables is worse than an ungrouped layout.
      if (Object.keys(clustered).length === diagram.tables.length) return clustered;
    } catch {
      /* fall through to the plain layout */
    }
    return build(false);
  }

  return { ...tables, ...placePrograms(diagram, tables, opts) };
}

/**
 * Where the programs go once the tables are placed.
 *
 * They are deliberately kept out of the ranking. A program is not part of the
 * schema's dependency order — it is the caller, and putting it in a rank would
 * push apart tables that belong next to each other to make room for something
 * the database does not contain. Instead each program is parked in a margin
 * beside the tables it touches: to their left when the layout runs left to
 * right, above them when it runs top to bottom, so its arrows come in from the
 * outside rather than through the middle of the diagram.
 *
 * Programs sharing that margin are stacked rather than overlapped, and one that
 * touches nothing goes at the end of the stack, since there is nothing to sit
 * beside.
 */
function placePrograms(
  diagram: Diagram,
  tables: Record<string, { x: number; y: number }>,
  opts: LayoutOptions,
): Record<string, { x: number; y: number }> {
  if (!diagram.programs.length) return {};
  const horizontal = (opts.direction ?? 'LR') === 'LR';
  const sizeOf = (id: string) => opts.sizes?.[id] ?? estimateNodeSize(diagram.tables.find((t) => t.id === id)?.columns ?? []);
  const MARGIN = 120;
  const GAP = 40;

  let minX = Infinity;
  let minY = Infinity;
  for (const t of diagram.tables) {
    const at = tables[t.id];
    if (!at) continue;
    minX = Math.min(minX, at.x);
    minY = Math.min(minY, at.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }

  const widest = Math.max(...diagram.programs.map((p) => estimateProgramSize(p).width));
  const out: Record<string, { x: number; y: number }> = {};
  // Where the next program goes along the margin, so two never land on each other.
  let cursor = Infinity;

  const ordered = [...diagram.programs].sort((a, b) => {
    const centre = (id: string) => {
      const ids = programTableIds(diagram.programs.find((p) => p.id === id)!).filter((tid) => tables[tid]);
      if (!ids.length) return Infinity;
      const values = ids.map((tid) => (horizontal ? tables[tid].y + sizeOf(tid).height / 2 : tables[tid].x + sizeOf(tid).width / 2));
      return values.reduce((s, v) => s + v, 0) / values.length;
    };
    return centre(a.id) - centre(b.id);
  });

  for (const prg of ordered) {
    const size = estimateProgramSize(prg);
    const touched = programTableIds(prg).filter((id) => tables[id]);
    // Line the program up with the middle of what it touches, then push it clear
    // of whatever was placed before it in the same margin.
    const middle = touched.length
      ? touched.reduce((sum, id) => sum + (horizontal ? tables[id].y + sizeOf(id).height / 2 : tables[id].x + sizeOf(id).width / 2), 0) / touched.length
      : cursor;
    const along = Number.isFinite(middle) ? middle - (horizontal ? size.height : size.width) / 2 : minY;
    const placed = Number.isFinite(cursor) ? Math.max(along, cursor) : along;
    out[prg.id] = horizontal
      ? { x: Math.round(minX - widest - MARGIN), y: Math.round(placed) }
      : { x: Math.round(placed), y: Math.round(minY - size.height - MARGIN) };
    cursor = placed + (horizontal ? size.height : size.width) + GAP;
  }
  return out;
}
