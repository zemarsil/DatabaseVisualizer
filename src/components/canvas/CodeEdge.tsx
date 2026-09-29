import { memo } from 'react';
import { BaseEdge, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import type { Program } from '@shared/types';
import type { CodeLinkOp } from '@/lib/codemap';
import { estimateProgramSize, isFoldedProcedure, PROGRAM_HEADER_HEIGHT, stepCenterY } from '@/lib/programs';
import { EdgeLabelPortal } from './EdgeLabelPortal';
import { stepHandle } from './stepHandle';

/**
 * The arrow between two code nodes: a call, an import or an extends, one per
 * step while both ends are drawn, or one per (container, container, op) once
 * either end is folded away and the hidden steps are gathered onto it.
 *
 * Drawn apart from a relationship for the same reason a program's table arrows
 * are: nothing here is a fact about the schema. What it carries is either the
 * step number, so a function's body reads off the canvas in order, or the
 * count of gathered steps, so a folded module still says how much of it
 * reaches the other one.
 */
export interface CodeEdgeData extends Record<string, unknown> {
  op: CodeLinkOp;
  /** 1-based position of the step, when the arrow is one step's own. */
  step: number | null;
  /** Steps gathered onto the arrow; 1 for a direct one. */
  count: number;
  /** The step this arrow belongs to, when direct, for its measured handle. */
  stepId: string | null;
  /** Row of the step inside its node, or -1 to leave from the header. */
  stepIndex: number;
  /** What the gathered steps are, one line each, for the tooltip. */
  summary: string[];
  dimmed: boolean;
  highlighted: boolean;
  traced: boolean;
}

export type CodeEdgeType = Edge<CodeEdgeData, 'codelink'>;

const GAP = 26;
const STUB = 12;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function curve(a: Box, ay: number, b: Box, by: number) {
  const aRight = a.x + a.w / 2 <= b.x + b.w / 2;
  const sx = aRight ? a.x + a.w : a.x;
  const tx = aRight ? b.x : b.x + b.w;
  const sDir = aRight ? 1 : -1;
  const reach = Math.max(GAP, Math.abs(tx - sx) / 2);
  const path = `M ${sx} ${ay} C ${sx + sDir * reach} ${ay}, ${tx - sDir * reach} ${by}, ${tx} ${by}`;
  return { path, sx, tx, ty: by, labelX: (sx + tx) / 2, labelY: (ay + by) / 2 };
}

function CodeEdgeInner({ id, source, target, data, selected }: EdgeProps<CodeEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;

  const est = (node: typeof sourceNode) => {
    const prg = (node.data as { program?: Program }).program;
    return prg ? estimateProgramSize(prg) : { width: 260, height: 90 };
  };
  const a: Box = {
    x: sourceNode.internals.positionAbsolute.x,
    y: sourceNode.internals.positionAbsolute.y,
    w: sourceNode.measured.width ?? est(sourceNode).width,
    h: sourceNode.measured.height ?? est(sourceNode).height,
  };
  const b: Box = {
    x: targetNode.internals.positionAbsolute.x,
    y: targetNode.internals.positionAbsolute.y,
    w: targetNode.measured.width ?? est(targetNode).width,
    h: targetNode.measured.height ?? est(targetNode).height,
  };
  // A direct arrow leaves its own step row; a gathered one, or one from an
  // expanded container's region, leaves the header. Both arrive at the header
  // of whatever they reach: a callee is named as a whole.
  const handle = stepHandle(sourceNode.internals.handleBounds?.source ?? undefined, data.stepId);
  const srcProgram = (sourceNode.data as { program?: Program }).program;
  const ay = a.y + (handle ? handle.y + handle.height / 2 : data.stepIndex >= 0 && !(srcProgram && isFoldedProcedure(srcProgram)) ? Math.min(stepCenterY(data.stepIndex), a.h - 8) : PROGRAM_HEADER_HEIGHT / 2);
  const by = b.y + PROGRAM_HEADER_HEIGHT / 2;
  const g = curve(a, ay, b, by);

  const on = selected || data.highlighted || data.traced;
  const color = on ? 'var(--accent)' : 'var(--program)';
  const width = on ? 2.5 : 1.5;
  const opacity = data.dimmed ? 0.16 : 1;
  // A load is the sparsest dash of the four: what it reaches is not code, and
  // the arrow should not read like one program reaching another.
  const dash = data.op === 'import' ? '2 5' : data.op === 'load' ? '1 4' : data.op === 'extends' ? undefined : '6 4';
  const dir = g.tx < g.sx ? 1 : -1;
  // A call ends in an arrowhead, an import and a load in an open one, an
  // extends in the hollow triangle UML draws at the base class.
  const head =
    data.op === 'extends'
      ? `M ${g.tx} ${g.ty} L ${g.tx + dir * STUB} ${g.ty - 6} L ${g.tx + dir * STUB} ${g.ty + 6} Z`
      : `M ${g.tx + dir * STUB} ${g.ty - 5} L ${g.tx} ${g.ty} L ${g.tx + dir * STUB} ${g.ty + 5}`;

  const labelClasses = ['program-edge__label', `program-edge__label--${data.op}`];
  if (on) labelClasses.push('program-edge__label--on');
  if (data.dimmed) labelClasses.push('program-edge__label--dim');
  const tooltip = data.summary.join('\n');

  return (
    <>
      <BaseEdge id={id} path={g.path} style={{ stroke: color, strokeWidth: width, opacity, strokeDasharray: dash }} interactionWidth={16} />
      <path d={head} style={{ stroke: color, strokeWidth: width, fill: data.op === 'extends' ? 'var(--node-bg)' : 'none', opacity }} />
      <EdgeLabelPortal>
        <div className={labelClasses.join(' ')} title={tooltip} style={{ transform: `translate(-50%, -50%) translate(${g.labelX}px, ${g.labelY}px)` }}>
          {data.step !== null ? <span className="program-edge__step">{data.step}</span> : <span className="program-edge__step program-edge__step--count">×{data.count}</span>}
          <span className="program-edge__op">{data.op}</span>
        </div>
      </EdgeLabelPortal>
    </>
  );
}

export const CodeEdge = memo(CodeEdgeInner);
