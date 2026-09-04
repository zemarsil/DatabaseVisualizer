import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import { Code2, GitBranch } from 'lucide-react';
import type { Relationship } from '@shared/types';
import { HEADER_HEIGHT, estimateNodeSize, rowCenterY } from '@/lib/geometry';

export interface RelationEdgeData extends Record<string, unknown> {
  relationship: Relationship;
  /** Row index of the first source / target column (-1 for header-anchored flow edges). */
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

function arrowHead(x: number, y: number, dir: number): string {
  const ox = x + dir * MARKER;
  return `M ${ox} ${y} L ${x} ${y} M ${x + dir * 9} ${y - 6} L ${x} ${y} L ${x + dir * 9} ${y + 6}`;
}

function RelationEdgeInner({ id, source, target, data, selected }: EdgeProps<RelationEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;

  const sTable = (sourceNode.data as { table?: { columns: { name: string; type: string }[] } }).table;
  const tTable = (targetNode.data as { table?: { columns: { name: string; type: string }[] } }).table;
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
  const isFlow = r.kind === 'flow';
  const hasQuery = Boolean(r.query && r.query.trim());
  const color = data.traced ? 'var(--trace)' : selected ? 'var(--accent)' : isFlow ? 'var(--flow)' : data.attached ? 'var(--edge-strong)' : 'var(--edge)';
  const width = data.traced || selected ? 2.5 : data.attached ? 2 : 1.5;
  const opacity = data.dimmed ? 0.18 : 1;
  const markerStyle: React.CSSProperties = { stroke: color, strokeWidth: width, fill: 'none', opacity, transition: 'stroke 0.12s, opacity 0.2s' };

  const showLabel = isFlow || hasQuery || selected || data.traced;
  const labelText = isFlow ? r.name || (hasQuery ? 'query' : 'data flow') : hasQuery ? r.name || 'query' : r.name || 'FK';
  const labelClasses = ['edge-label'];
  if (selected) labelClasses.push('edge-label--selected');
  else if (data.traced) labelClasses.push('edge-label--trace');
  else if (isFlow) labelClasses.push('edge-label--flow');
  else if (hasQuery) labelClasses.push('edge-label--query');
  if (data.dimmed) labelClasses.push('edge-label--dim');

  return (
    <>
      <BaseEdge
        id={id}
        path={g.path}
        style={{ stroke: color, strokeWidth: width, opacity, strokeDasharray: isFlow ? '7 5' : undefined }}
        interactionWidth={18}
      />
      {isFlow ? (
        <>
          <path d={`M ${g.sx} ${g.sy} L ${g.sx + sDir * MARKER} ${g.sy}`} style={{ ...markerStyle, strokeDasharray: undefined }} />
          <path d={arrowHead(g.tx, g.ty, tDir)} style={markerStyle} />
        </>
      ) : (
        <>
          <path d={crowsFoot(g.sx, g.sy, sDir)} style={markerStyle} />
          <path d={oneBar(g.tx, g.ty, tDir)} style={markerStyle} />
          {data.optional && <circle cx={g.sx + sDir * (MARKER + 5)} cy={g.sy} r={3.5} style={{ ...markerStyle, fill: 'var(--canvas-bg)' }} />}
        </>
      )}
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={labelClasses.join(' ')}
            style={{ transform: `translate(-50%, -50%) translate(${g.labelX}px, ${g.labelY}px)` }}
            title={hasQuery ? r.query : r.note || undefined}
          >
            {isFlow ? <GitBranch /> : hasQuery ? <Code2 /> : null}
            <span>{labelText}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeInner);
