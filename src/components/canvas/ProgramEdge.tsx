import { memo } from 'react';
import { BaseEdge, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import type { Program, Table } from '@shared/types';
import { estimateNodeSize, HEADER_HEIGHT, rowCenterY } from '@/lib/geometry';
import { estimateProgramSize, isFoldedProcedure, PROGRAM_HEADER_HEIGHT, stepCenterY } from '@/lib/programs';
import { EdgeLabelPortal } from './EdgeLabelPortal';
import { stepHandle } from './stepHandle';

/**
 * The arrow between a program and a table, one per step that names one.
 *
 * It is drawn apart from a relationship on purpose: nothing here is a fact
 * about the schema, and confusing "a Python job writes this table" with a
 * foreign key would be a worse lie than leaving it out. What it does carry is
 * the step number, and that is the whole feature — numbered arrows leaving and
 * returning are how a round trip reads off the canvas without opening anything.
 */
export interface ProgramEdgeData extends Record<string, unknown> {
  /** 1-based position of the step within the program, or null once steps from inside a folded container are gathered onto the arrow. */
  step: number | null;
  /** Steps gathered onto the arrow; 1 for a direct one. */
  count: number;
  /** read -> table to program, write -> program to table. */
  op: 'read' | 'write';
  /** The step this arrow belongs to, used to find its measured handle; null for a gathered arrow. */
  stepId: string | null;
  /** Row index of the step inside the program node, or -1 to leave from the header. */
  stepIndex: number;
  /** Row index of the first named column in the table, or -1 to meet the header. */
  tableRow: number;
  /** Column names this step touches, for the label's tooltip. */
  columns: string[];
  dimmed: boolean;
  /** The program is selected, or this is the step the inspector is on. */
  highlighted: boolean;
  /** The arrow is on the path Trace found. */
  traced: boolean;
  /** Both a read and a write of this table exist, so the pair is a round trip. */
  roundTrip: boolean;
}

export type ProgramEdgeType = Edge<ProgramEdgeData, 'programlink'>;

const GAP = 26;
/** px between the node edge and where the curve starts, matching the relationship edges. */
const STUB = 12;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A flat S-curve between two anchor points, leaving each box on the side that
 * faces the other one. Deliberately simpler than the relationship router: these
 * edges never need crow's feet, optionality circles or bowed-apart siblings,
 * because a program draws at most one arrow per step.
 */
function curve(a: Box, ay: number, b: Box, by: number): { path: string; sx: number; sy: number; tx: number; ty: number; labelX: number; labelY: number } {
  const aRight = a.x + a.w / 2 <= b.x + b.w / 2;
  const sx = aRight ? a.x + a.w : a.x;
  const tx = aRight ? b.x : b.x + b.w;
  const sDir = aRight ? 1 : -1;
  const reach = Math.max(GAP, Math.abs(tx - sx) / 2);
  const c1 = sx + sDir * reach;
  const c2 = tx - sDir * reach;
  const path = `M ${sx} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${tx} ${by}`;
  return { path, sx, sy: ay, tx, ty: by, labelX: (sx + tx) / 2, labelY: (ay + by) / 2 };
}

function ProgramEdgeInner({ id, source, target, data, selected }: EdgeProps<ProgramEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;

  // `source` is always the program and `target` always the table, whichever way
  // the rows actually travel; the arrowhead is what says the direction.
  const prg = (sourceNode.data as { program?: Program }).program;
  const tbl = (targetNode.data as { table?: Table }).table;
  const pEst = prg ? estimateProgramSize(prg) : { width: 260, height: 90 };
  const tEst = estimateNodeSize(tbl?.columns ?? []);
  const p: Box = {
    x: sourceNode.internals.positionAbsolute.x,
    y: sourceNode.internals.positionAbsolute.y,
    w: sourceNode.measured.width ?? pEst.width,
    h: sourceNode.measured.height ?? pEst.height,
  };
  const t: Box = {
    x: targetNode.internals.positionAbsolute.x,
    y: targetNode.internals.positionAbsolute.y,
    w: targetNode.measured.width ?? tEst.width,
    h: targetNode.measured.height ?? tEst.height,
  };
  // React Flow measures the handle on each step row, so ask it where the row
  // actually is rather than re-deriving it from the CSS. The estimate is only
  // the fallback for the frame before the node has been measured.
  const handle = stepHandle(sourceNode.internals.handleBounds?.source ?? undefined, data.stepId);
  // A gathered arrow, or one whose step row is folded away, leaves the header.
  const py = p.y + (handle ? handle.y + handle.height / 2 : data.stepIndex >= 0 && !(prg && isFoldedProcedure(prg)) ? Math.min(stepCenterY(data.stepIndex), p.h - 8) : PROGRAM_HEADER_HEIGHT / 2);
  const ty = t.y + (data.tableRow >= 0 ? rowCenterY(data.tableRow) : HEADER_HEIGHT / 2);
  const g = curve(p, py, t, ty);

  const on = selected || data.highlighted || data.traced;
  const color = on ? 'var(--accent)' : 'var(--program)';
  const width = on ? 2.5 : 1.5;
  const opacity = data.dimmed ? 0.16 : 1;
  // The arrowhead sits at whichever end the rows arrive at, which is the whole
  // difference between a read and a write.
  const head = data.op === 'write' ? { x: g.tx, y: g.ty, dir: g.tx < g.sx ? 1 : -1 } : { x: g.sx, y: g.sy, dir: g.sx < g.tx ? 1 : -1 };
  const arrow = `M ${head.x + head.dir * STUB} ${head.y - 5} L ${head.x} ${head.y} L ${head.x + head.dir * STUB} ${head.y + 5}`;

  const labelClasses = ['program-edge__label'];
  if (on) labelClasses.push('program-edge__label--on');
  if (data.dimmed) labelClasses.push('program-edge__label--dim');

  const tooltip = [
    data.step !== null ? `Step ${data.step}: ${data.op}` : `${data.count} ${data.op} step${data.count === 1 ? '' : 's'} inside this container`,
    data.columns.length ? data.columns.join(', ') : 'the whole row',
    data.roundTrip ? 'Part of a round trip: this program both reads and writes this table.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      <BaseEdge id={id} path={g.path} style={{ stroke: color, strokeWidth: width, opacity, strokeDasharray: '6 4' }} interactionWidth={16} />
      <path d={arrow} style={{ stroke: color, strokeWidth: width, fill: 'none', opacity }} />
      <EdgeLabelPortal>
        <div
          className={labelClasses.join(' ')}
          title={tooltip}
          style={{ transform: `translate(-50%, -50%) translate(${g.labelX}px, ${g.labelY}px)` }}
        >
          {data.step !== null ? <span className="program-edge__step">{data.step}</span> : <span className="program-edge__step program-edge__step--count">×{data.count}</span>}
          <span className="program-edge__op">{data.op}</span>
        </div>
      </EdgeLabelPortal>
    </>
  );
}

export const ProgramEdge = memo(ProgramEdgeInner);
