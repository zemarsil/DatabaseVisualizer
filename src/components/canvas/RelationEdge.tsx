import { memo, useEffect, useRef } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import { Braces, Code2, GitBranch, Sigma, Waypoints } from 'lucide-react';
import { DEFAULT_VERBS, relationshipVerb, type Relationship, type RelationshipKind, type Table } from '@shared/types';
import { derivationSummaries, flowDerivations } from '@/lib/derivation';
import { HEADER_HEIGHT, estimateNodeSize, rowCenterY } from '@/lib/geometry';

export interface RelationEdgeData extends Record<string, unknown> {
  relationship: Relationship;
  /** Row index of the first source / target column (-1 when the edge anchors on the header). */
  sourceRow: number;
  targetRow: number;
  hue: string;
  dimmed: boolean;
  traced: boolean;
  /** Edge touches the currently selected table. */
  attached: boolean;
  /** Source column is nullable -> optional relationship (drawn with a circle on the "one" side). */
  optional: boolean;
  /** Position of this edge among others sharing the same source/target anchor points (for bowing duplicates apart). */
  siblingIndex: number;
  siblingCount: number;
  /** Cardinality text at each end of a foreign key ("1", "N", "0..1", "0..N"); null hides the labels. */
  cardinality: { source: string; target: string } | null;
  /** How the edge takes part in the running data-flow simulation, if one is on. */
  simulation?: EdgeSimulation | null;
}

/**
 * pending -> a flow that has not run yet, active -> the stage in play (rows are
 * moving), done -> already ran, lookup -> a foreign key the active stage reads
 * through (orders.status from an order_items row).
 */
export interface EdgeSimulation {
  state: 'pending' | 'active' | 'done' | 'lookup';
  /** Rows produced by the stage; the number of dots that travel the edge. */
  packets: number;
  /** Bumps when the stage changes, restarting the animation. */
  nonce: number;
  /** Keep the dots circulating while the stage stays in play. */
  loop: boolean;
}

export type RelationEdgeType = Edge<RelationEdgeData, 'relation'>;

type Side = 'left' | 'right';

const MARKER = 16; // px reserved for the crow's foot / bar between node edge and curve start
const GAP = 28;
const BOW_SPACING = 26; // px separation between duplicate edges sharing the same anchor points

interface Geometry {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sSide: Side;
  tSide: Side;
  path: string;
  labelX: number;
  labelY: number;
}

function computeGeometry(
  s: { x: number; y: number; w: number; h: number },
  t: { x: number; y: number; w: number; h: number },
  sy: number,
  ty: number,
  bowOffset: number,
): Geometry {
  let sSide: Side;
  let tSide: Side;
  if (s.x + s.w + GAP <= t.x) {
    sSide = 'right';
    tSide = 'left';
  } else if (t.x + t.w + GAP <= s.x) {
    sSide = 'left';
    tSide = 'right';
  } else {
    // horizontally overlapping (or the same node): loop out of the side with more room
    const sRight = s.x + s.w;
    const tRight = t.x + t.w;
    const useRight = Math.max(sRight, tRight) - Math.min(s.x, t.x) < 600 || sRight >= tRight;
    sSide = useRight ? 'right' : 'left';
    tSide = sSide;
  }
  const sx = sSide === 'right' ? s.x + s.w : s.x;
  const tx = tSide === 'right' ? t.x + t.w : t.x;
  const sDir = sSide === 'right' ? 1 : -1;
  const tDir = tSide === 'right' ? 1 : -1;

  const p0x = sx + sDir * MARKER;
  const p3x = tx + tDir * MARKER;
  const sameSide = sSide === tSide;
  const dist = Math.abs(p3x - p0x);
  const bend = sameSide ? 70 + Math.min(120, Math.abs(sy - ty) * 0.25) : Math.max(48, Math.min(180, dist * 0.45));
  const c1x = p0x + sDir * bend;
  const c2x = p3x + tDir * bend;
  const c1y = sy + bowOffset;
  const c2y = ty + bowOffset;
  const path = `M ${p0x} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p3x} ${ty}`;
  const labelX = (p0x + 3 * c1x + 3 * c2x + p3x) / 8;
  const labelY = (sy + 3 * c1y + 3 * c2y + ty) / 8;
  return { sx, sy, tx, ty, sSide, tSide, path, labelX, labelY };
}

/** Crow's foot pointing into the node at (x, y). dir is +1 when the curve leaves to the right. */
function crowsFoot(x: number, y: number, dir: number): string {
  const ox = x + dir * MARKER;
  return `M ${ox} ${y} L ${x} ${y - 7} M ${ox} ${y} L ${x} ${y} M ${ox} ${y} L ${x} ${y + 7}`;
}

/** "One" marker: a perpendicular bar. */
function oneBar(x: number, y: number, dir: number): string {
  const bx = x + dir * (MARKER * 0.55);
  return `M ${bx} ${y - 7} L ${bx} ${y + 7} M ${x} ${y} L ${x + dir * MARKER} ${y}`;
}

/** Open "V" head, for dependencies (UML draws an unenforced link this way). */
function openArrow(x: number, y: number, dir: number): string {
  const ox = x + dir * MARKER;
  return `M ${ox} ${y} L ${x} ${y} M ${x + dir * 9} ${y - 6} L ${x} ${y} L ${x + dir * 9} ${y + 6}`;
}

/** Filled head, for data flows: rows really move this way. */
function solidArrow(x: number, y: number, dir: number): string {
  const back = x + dir * 11;
  return `M ${x} ${y} L ${back} ${y - 5.5} L ${back} ${y + 5.5} Z`;
}

/** Filled diamond at the containing table, for a serialized copy (UML composition). */
function diamond(x: number, y: number, dir: number): string {
  const mid = x + dir * (MARKER * 0.5);
  const end = x + dir * MARKER;
  return `M ${x} ${y} L ${mid} ${y - 5} L ${end} ${y} L ${mid} ${y + 5} Z`;
}

const PACKET_DURATION = 1300;
const PACKET_STAGGER = 160;
const PACKET_REST = 700;

/**
 * Dots that travel the edge from source to target, one per produced row (capped),
 * staggered so they read as a stream. Positions come from getPointAtLength on a
 * hidden copy of the path, driven by requestAnimationFrame, so they follow the
 * curve exactly and restart whenever the stage changes.
 */
function Packets({ path, count, nonce, loop, color }: { path: string; count: number; nonce: number; loop: boolean; color: string }) {
  const pathRef = useRef<SVGPathElement>(null);
  const dots = useRef<(SVGCircleElement | null)[]>([]);
  useEffect(() => {
    const p = pathRef.current;
    if (!p || count === 0) return;
    const length = p.getTotalLength();
    const start = performance.now();
    const period = PACKET_DURATION + (count - 1) * PACKET_STAGGER + PACKET_REST;
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = loop ? elapsed % period : elapsed;
      let alive = false;
      dots.current.forEach((dot, i) => {
        if (!dot) return;
        const local = (t - i * PACKET_STAGGER) / PACKET_DURATION;
        if (local < 0 || local >= 1) {
          dot.style.opacity = '0';
          if (local < 0) alive = true;
          return;
        }
        alive = true;
        const eased = local < 0.5 ? 2 * local * local : -1 + (4 - 2 * local) * local;
        const at = p.getPointAtLength(eased * length);
        dot.setAttribute('cx', String(at.x));
        dot.setAttribute('cy', String(at.y));
        dot.style.opacity = local < 0.08 ? String(local / 0.08) : local > 0.92 ? String((1 - local) / 0.08) : '1';
      });
      if (alive || loop) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [path, count, nonce, loop]);
  return (
    <>
      <path ref={pathRef} d={path} fill="none" stroke="none" pointerEvents="none" />
      {Array.from({ length: count }).map((_, i) => (
        <circle
          key={`${nonce}-${i}`}
          ref={(el) => {
            dots.current[i] = el;
          }}
          r={4.5}
          className="edge-packet"
          style={{ fill: color, opacity: 0 }}
        />
      ))}
    </>
  );
}

/** Stroke colour token and dash pattern per kind. */
const EDGE_STYLE: Record<RelationshipKind, { color: string; dash?: string }> = {
  fk: { color: 'var(--edge)' },
  flow: { color: 'var(--flow)', dash: '7 5' },
  embed: { color: 'var(--embed)' },
  dependency: { color: 'var(--dep)', dash: '2 4' },
};

const KIND_ICON: Record<RelationshipKind, typeof GitBranch | null> = {
  fk: null,
  flow: GitBranch,
  embed: Braces,
  dependency: Waypoints,
};

function RelationEdgeInner({ id, source, target, data, selected }: EdgeProps<RelationEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;

  const sTable = (sourceNode.data as { table?: Table }).table;
  const tTable = (targetNode.data as { table?: Table }).table;
  const sEst = estimateNodeSize(sTable?.columns ?? []);
  const tEst = estimateNodeSize(tTable?.columns ?? []);
  const s = {
    x: sourceNode.internals.positionAbsolute.x,
    y: sourceNode.internals.positionAbsolute.y,
    w: sourceNode.measured.width ?? sEst.width,
    h: sourceNode.measured.height ?? sEst.height,
  };
  const t = {
    x: targetNode.internals.positionAbsolute.x,
    y: targetNode.internals.positionAbsolute.y,
    w: targetNode.measured.width ?? tEst.width,
    h: targetNode.measured.height ?? tEst.height,
  };
  const sy = s.y + (data.sourceRow >= 0 ? rowCenterY(data.sourceRow) : HEADER_HEIGHT / 2);
  const ty = t.y + (data.targetRow >= 0 ? rowCenterY(data.targetRow) : HEADER_HEIGHT / 2);
  const bowOffset = data.siblingCount > 1 ? (data.siblingIndex - (data.siblingCount - 1) / 2) * BOW_SPACING : 0;
  const g = computeGeometry(s, t, sy, ty, bowOffset);
  const sDir = g.sSide === 'right' ? 1 : -1;
  const tDir = g.tSide === 'right' ? 1 : -1;

  const r = data.relationship;
  const kind = r.kind;
  const verb = relationshipVerb(r);
  const style = EDGE_STYLE[kind] ?? EDGE_STYLE.fk;
  const hasQuery = Boolean(r.query && r.query.trim());
  // Structured derivations read as "revenue_cents = SUM(...) GROUP BY ..." without
  // anyone having to squint at the tagged query.
  const derivationCount = flowDerivations(r).length;
  const summaries = derivationSummaries(r, tTable);
  const sim = data.simulation ?? null;
  const base = kind === 'fk' && data.attached ? 'var(--edge-strong)' : style.color;
  const simColor = sim ? (sim.state === 'lookup' ? 'var(--dep)' : 'var(--flow)') : null;
  const color = data.traced ? 'var(--trace)' : selected ? 'var(--accent)' : (simColor ?? base);
  const width = sim?.state === 'active' ? 3 : sim?.state === 'done' || sim?.state === 'lookup' ? 2.5 : data.traced || selected ? 2.5 : data.attached ? 2 : 1.5;
  const opacity = data.dimmed ? 0.18 : sim?.state === 'pending' ? 0.55 : 1;
  const markerStyle: React.CSSProperties = { stroke: color, strokeWidth: width, fill: 'none', opacity, transition: 'stroke 0.12s, opacity 0.2s' };
  const filledStyle: React.CSSProperties = { ...markerStyle, fill: color };
  const stub = `M ${g.sx} ${g.sy} L ${g.sx + sDir * MARKER} ${g.sy}`;

  // A plain foreign key stays unlabelled so the canvas keeps quiet; anything
  // that carries meaning (another kind, a chosen verb, a query, a derivation,
  // a written reverse label) says so. The verb reads the edge, the sigma chip
  // counts the derivations.
  const namedVerb = Boolean(r.verb) && r.verb !== DEFAULT_VERBS[kind];
  const customInverse = r.inverseName?.trim();
  const showLabel = kind !== 'fk' || namedVerb || hasQuery || derivationCount > 0 || Boolean(customInverse) || selected || data.traced || sim?.state === 'lookup';
  const labelText = sim?.state === 'lookup' && kind === 'fk' ? 'looked up' : r.name || (kind === 'fk' && !namedVerb ? 'FK' : verb.forward);
  const Icon = hasQuery && kind === 'fk' ? Code2 : KIND_ICON[kind];
  const tooltip = [summaries.join('\n'), hasQuery ? r.query!.trim() : '', r.note?.trim() ?? ''].filter(Boolean).join('\n\n');
  const labelClasses = ['edge-label'];
  if (selected) labelClasses.push('edge-label--selected');
  else if (data.traced) labelClasses.push('edge-label--trace');
  else if (sim?.state === 'active') labelClasses.push('edge-label--sim-active');
  else if (sim?.state === 'lookup') labelClasses.push('edge-label--dependency');
  else if (kind !== 'fk') labelClasses.push(`edge-label--${kind}`);
  else if (hasQuery) labelClasses.push('edge-label--query');
  if (data.dimmed) labelClasses.push('edge-label--dim');

  // How the connection reads from the target's side. A written reverse label is
  // part of the diagram so it always shows; the verb's own inverse would just be
  // noise on every edge, so it waits until the edge is selected or traced.
  const inverseText = customInverse || verb.inverse;
  const showInverseLabel = showLabel && Boolean(customInverse || selected || data.traced);
  const inverseLabelX = g.labelX + (g.tx - g.labelX) * 0.65;
  const inverseLabelY = g.labelY + (g.ty - g.labelY) * 0.65;

  return (
    <>
      <BaseEdge id={id} path={g.path} style={{ stroke: color, strokeWidth: width, opacity, strokeDasharray: sim?.state === 'active' || sim?.state === 'done' ? undefined : style.dash }} interactionWidth={18} />
      {sim?.state === 'active' && <path d={g.path} className="edge-glow" style={{ stroke: color }} />}
      {sim?.state === 'active' && <Packets path={g.path} count={sim.packets} nonce={sim.nonce} loop={sim.loop} color={color} />}
      {kind === 'fk' && (
        <>
          <path d={crowsFoot(g.sx, g.sy, sDir)} style={markerStyle} />
          <path d={oneBar(g.tx, g.ty, tDir)} style={markerStyle} />
          {data.optional && <circle cx={g.sx + sDir * (MARKER + 5)} cy={g.sy} r={3.5} style={{ ...markerStyle, fill: 'var(--canvas-bg)' }} />}
          {data.cardinality && !data.dimmed && (
            <>
              <text className="edge-cardinality" x={g.sx + sDir * (MARKER + 6)} y={g.sy - 7} textAnchor={sDir > 0 ? 'start' : 'end'} style={{ fill: color }}>
                {data.cardinality.source}
              </text>
              <text className="edge-cardinality" x={g.tx + tDir * (MARKER + 6)} y={g.ty - 7} textAnchor={tDir > 0 ? 'start' : 'end'} style={{ fill: color }}>
                {data.cardinality.target}
              </text>
            </>
          )}
        </>
      )}
      {kind === 'flow' && (
        <>
          <path d={stub} style={markerStyle} />
          <path d={`M ${g.tx + tDir * MARKER} ${g.ty} L ${g.tx} ${g.ty}`} style={markerStyle} />
          <path d={solidArrow(g.tx, g.ty, tDir)} style={filledStyle} />
        </>
      )}
      {kind === 'embed' && (
        <>
          <path d={diamond(g.sx, g.sy, sDir)} style={filledStyle} />
          <path d={`M ${g.tx + tDir * MARKER} ${g.ty} L ${g.tx} ${g.ty}`} style={markerStyle} />
        </>
      )}
      {kind === 'dependency' && (
        <>
          <path d={stub} style={markerStyle} />
          <path d={openArrow(g.tx, g.ty, tDir)} style={markerStyle} />
        </>
      )}
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={labelClasses.join(' ')}
            style={{ transform: `translate(-50%, -50%) translate(${g.labelX}px, ${g.labelY}px)` }}
            title={tooltip || undefined}
          >
            {Icon ? <Icon /> : null}
            <span>{labelText}</span>
            {derivationCount > 0 && (
              <span className="edge-label__count" title={summaries.join('\n')}>
                <Sigma />
                {derivationCount}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
      {showInverseLabel && (
        <EdgeLabelRenderer>
          <div
            className={[...labelClasses, 'edge-label--inverse'].join(' ')}
            style={{ transform: `translate(-50%, -50%) translate(${inverseLabelX}px, ${inverseLabelY}px)` }}
            title={`${tTable?.name ?? 'target'} ${inverseText} ${sTable?.name ?? 'source'}`}
          >
            <span>{inverseText}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeInner);
