import dagre from '@dagrejs/dagre';
import { codeKindMeta, codeKindOf, type Diagram, type Program, type Relationship, type RelationshipKind } from '@shared/types';
import { CODE_HEADER, CODE_PADDING, codeChildren, codeDepth, codeDescendantIds, codeVisibility, drawnCodeEdges, EMPTY_CODE_HEIGHT, EMPTY_CODE_WIDTH } from './codemap';
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

  return { ...tables, ...placeCode(diagram, tables, opts) };
}

/**
 * Where the code goes once the tables are placed.
 *
 * It is deliberately kept out of the ranking. A program is not part of the
 * schema's dependency order — it is the caller, and putting it in a rank would
 * push apart tables that belong next to each other to make room for something
 * the database does not contain. Instead the whole code side is laid out as a
 * graph of its own — callers before callees, base classes before the classes
 * that extend them, expanded containers as clusters so a module's functions
 * stay inside its region — and that block is parked in a margin beside the
 * tables it touches: to their left when the layout runs left to right, above
 * them when it runs top to bottom, so its arrows come in from the outside
 * rather than through the middle of the diagram.
 *
 * Collapsed containers are laid out as the single nodes they are drawn as; the
 * members inside them keep their positions, so expanding one later finds them
 * where they were.
 */
function placeCode(
  diagram: Diagram,
  tables: Record<string, { x: number; y: number }>,
  opts: LayoutOptions,
): Record<string, { x: number; y: number }> {
  if (!diagram.programs.length) return {};
  const horizontal = (opts.direction ?? 'LR') === 'LR';
  const vis = codeVisibility(diagram);
  const children = codeChildren(diagram);
  const expanded = new Set(vis.expanded.map((p) => p.id));
  const sizeOf = (p: Program) => opts.sizes?.[p.id] ?? estimateProgramSize(p, { hiddenMembers: vis.hidden.get(p.id) ?? 0 });

  const build = (withClusters: boolean): Record<string, { x: number; y: number }> | null => {
    const g = new dagre.graphlib.Graph({ multigraph: true, compound: withClusters });
    g.setGraph({ rankdir: opts.direction ?? 'LR', nodesep: 40, ranksep: 90, marginx: 0, marginy: 0, ranker: 'network-simplex' });
    g.setDefaultEdgeLabel(() => ({}));
    for (const p of vis.drawn) {
      if (withClusters && expanded.has(p.id)) g.setNode(p.id, {});
      else if (expanded.has(p.id)) continue;
      else {
        const empty = codeKindMeta(codeKindOf(p)).container && !p.collapsed && !(children.get(p.id)?.length ?? 0);
        const size = empty ? { width: EMPTY_CODE_WIDTH, height: EMPTY_CODE_HEIGHT } : sizeOf(p);
        g.setNode(p.id, { width: size.width, height: size.height });
      }
    }
    if (withClusters) {
      for (const p of vis.drawn) {
        if (p.parentId && expanded.has(p.parentId) && g.hasNode(p.id) && g.hasNode(p.parentId)) g.setParent(p.id, p.parentId);
      }
    }
    const seen = new Set<string>();
    for (const e of drawnCodeEdges(diagram, vis)) {
      // Whatever the other end depends on comes first: the callee after its
      // caller, the base class before the class that extends it.
      const [from, to] = e.op === 'extends' ? [e.toId, e.fromId] : [e.fromId, e.toId];
      if (!g.hasNode(from) || !g.hasNode(to)) continue;
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      g.setEdge(from, to, { weight: e.links.length }, e.id);
    }
    dagre.layout(g);
    const out: Record<string, { x: number; y: number }> = {};
    for (const p of vis.drawn) {
      const n = g.node(p.id);
      if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        if (expanded.has(p.id) && !withClusters) continue;
        return null;
      }
      out[p.id] = { x: n.x - (n.width ?? 0) / 2, y: n.y - (n.height ?? 0) / 2 };
    }
    return out;
  };

  let placed: Record<string, { x: number; y: number }> | null = null;
  if (expanded.size) {
    try {
      placed = build(true);
    } catch {
      placed = null;
    }
  }
  placed ??= build(false) ?? {};

  // The block's own bounding box, from the nodes that have a size.
  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  for (const p of vis.drawn) {
    const at = placed[p.id];
    if (!at || expanded.has(p.id)) continue;
    const size = sizeOf(p);
    bMinX = Math.min(bMinX, at.x);
    bMinY = Math.min(bMinY, at.y);
    bMaxX = Math.max(bMaxX, at.x + size.width);
    bMaxY = Math.max(bMaxY, at.y + size.height);
  }
  if (!Number.isFinite(bMinX)) return {};
  // Room for the regions drawn around the members, one level per depth.
  const depth = Math.max(0, ...vis.drawn.map((p) => codeDepth(diagram, p.id)));
  const pad = depth * (CODE_PADDING + CODE_HEADER);

  let minX = Infinity;
  let minY = Infinity;
  for (const t of diagram.tables) {
    const at = tables[t.id];
    if (!at) continue;
    minX = Math.min(minX, at.x);
    minY = Math.min(minY, at.y);
  }
  const MARGIN = 120;
  const tableSize = (id: string) => opts.sizes?.[id] ?? estimateNodeSize(diagram.tables.find((t) => t.id === id)?.columns ?? []);
  // Line the block up with the middle of the tables it touches, like a single
  // program used to be, so the arrows into the schema stay short.
  const touched = [...new Set(diagram.programs.flatMap((p) => programTableIds(p)))].filter((id) => tables[id]);
  const middle = touched.length
    ? touched.reduce((sum, id) => sum + (horizontal ? tables[id].y + tableSize(id).height / 2 : tables[id].x + tableSize(id).width / 2), 0) / touched.length
    : null;

  let dx: number;
  let dy: number;
  if (!Number.isFinite(minX)) {
    dx = 40 + pad - bMinX;
    dy = 40 + pad - bMinY;
  } else if (horizontal) {
    dx = minX - MARGIN - pad - bMaxX;
    dy = (middle ?? minY + (bMaxY - bMinY) / 2) - (bMinY + bMaxY) / 2;
  } else {
    dx = (middle ?? minX + (bMaxX - bMinX) / 2) - (bMinX + bMaxX) / 2;
    dy = minY - MARGIN - pad - bMaxY;
  }

  const out: Record<string, { x: number; y: number }> = {};
  for (const p of vis.drawn) {
    const at = placed[p.id];
    if (!at) continue;
    out[p.id] = { x: Math.round(at.x + dx), y: Math.round(at.y + dy) };
  }
  // Members hidden inside a collapsed container travel with it, so that
  // expanding it later does not scatter them across the old layout.
  for (const c of vis.collapsed) {
    const from = diagram.programs.find((p) => p.id === c.id)!.position;
    const to = out[c.id];
    if (!to) continue;
    for (const id of codeDescendantIds(diagram, c.id, children)) {
      const m = diagram.programs.find((p) => p.id === id)!;
      out[id] = { x: Math.round(m.position.x + (to.x - from.x)), y: Math.round(m.position.y + (to.y - from.y)) };
    }
  }
  return out;
}
