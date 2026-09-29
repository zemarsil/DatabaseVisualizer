import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, Box, Braces, ChevronDown, ChevronUp, ChevronsUpDown, Cpu, DatabaseZap, FileCode, FileInput, Import, Layers, SquareFunction, Terminal, TriangleAlert, type LucideIcon } from 'lucide-react';
import { codeKindMeta, codeKindOf, programLanguageMeta, programRoleMeta, type CodeKind, type Program, type ProgramStepOp } from '@shared/types';
import { paletteHue } from '@/lib/palette';
import { sameData } from '@/lib/stableList';
import { procedureSignature } from '@/lib/procedures';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import '@/styles/programs.css';

/**
 * What one step row shows. Resolved by the canvas rather than looked up here,
 * so the node re-renders only when what it draws actually changes.
 */
export interface ProgramStepView {
  id: string;
  op: ProgramStepOp;
  /** Table name on a read or write, code node name on a call, import, extends or load, null on a compute step. */
  target: string | null;
  columns: string[];
  /** The step names something the diagram no longer has. */
  missing: boolean;
  /** Prose, shown on a compute step and in every step's tooltip. */
  note: string;
  hasCode: boolean;
}

export interface ProgramNodeData extends Record<string, unknown> {
  program: Program;
  steps: ProgramStepView[];
  /** Names of tables this node both reads and writes: the actual round trips. */
  roundTrips: string[];
  /** "api/orders.py/place_order": where this node sits, for the tooltip. */
  path: string;
  /** Members a collapsed container is hiding; 0 for a leaf or an expanded one. */
  hiddenMembers: number;
  /** True while zoomed out far enough that only the header is worth drawing. */
  lod: boolean;
  dimmed: boolean;
  traceRole: 'from' | 'to' | 'via' | null;
  picking: boolean;
  renaming: boolean;
}

export type ProgramNodeType = Node<ProgramNodeData, 'program'>;

export const PROGRAM_DRAG_HANDLE = undefined;

export const KIND_ICON: Record<CodeKind, LucideIcon> = {
  program: Terminal,
  module: FileCode,
  class: Box,
  function: SquareFunction,
  data: Braces,
  procedure: DatabaseZap,
};

const OP_ICON: Record<ProgramStepOp, LucideIcon> = {
  read: ArrowDownToLine,
  write: ArrowUpFromLine,
  compute: Cpu,
  call: ArrowUpRight,
  import: Import,
  extends: Layers,
  load: FileInput,
};

interface StepRowProps {
  step: ProgramStepView;
  /** 0-based position in the node, shown 1-based. */
  index: number;
  active: boolean;
  procedure: boolean;
}

/**
 * One step row. Memoized on what it shows, because a node re-renders on every
 * frame it is dragged and a long procedure has a hundred of these: rebuilding
 * all of them to move the box they sit in was most of the cost of the drag.
 */
function StepRowInner({ step: s, index, active, procedure }: StepRowProps) {
  const Icon = OP_ICON[s.op];
  const rowClasses = ['program-node__step', `program-node__step--${s.op}`];
  if (active) rowClasses.push('program-node__step--active');
  if (s.missing) rowClasses.push('program-node__step--missing');
  const label = s.op === 'compute' ? s.note || 'compute' : (s.target ?? (s.op === 'read' || s.op === 'write' ? '(missing table)' : '(missing code)'));
  const tip = [
    s.op === 'compute' ? (procedure ? 'Procedural work inside the database' : 'Work the database never sees') : `${s.op} ${s.target ?? '?'}`,
    s.columns.length ? s.columns.join(', ') : '',
    s.note && s.op !== 'compute' ? s.note : '',
    s.missing ? 'What this step names is no longer in the diagram.' : '',
    s.hasCode ? 'Carries code.' : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      className={rowClasses.join(' ')}
      title={tip}
      // Clicking a step hands the inspector the one to open on, so the
      // canvas and the editor stay pointed at the same thing.
      onClick={() => useUi.getState().setActiveProgramStepId(s.id)}
    >
      <span className="program-node__num">{index + 1}</span>
      <Icon className="program-node__op" />
      <span className="program-node__label">{label}</span>
      {s.columns.length > 0 && <span className="program-node__cols">{s.columns.join(', ')}</span>}
      {s.missing && <TriangleAlert className="program-node__warn" />}
      <Handle type="source" position={Position.Left} id={`${s.id}|l`} className="program-node__step-handle program-node__step-handle--left" />
      <Handle type="source" position={Position.Right} id={`${s.id}|r`} className="program-node__step-handle program-node__step-handle--right" />
    </div>
  );
}

// The canvas derives the step views afresh whenever the node changes, so they
// are compared by what they say rather than by identity.
const StepRow = memo(StepRowInner, (a, b) => a.index === b.index && a.active === b.active && a.procedure === b.procedure && sameData(a.step, b.step));

/** The in-place rename box, the same one a table header gets. */
function RenameInput({ program }: { program: Program }) {
  const [value, setValue] = useState(program.name);
  const ref = useRef<HTMLInputElement>(null);
  const updateProgram = useStore((s) => s.updateProgram);
  const setRenaming = useUi((s) => s.setRenamingNodeId);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const next = value.trim();
    if (next && next !== program.name) updateProgram(program.id, { name: next });
    setRenaming(null);
  };
  return (
    <input
      ref={ref}
      className="table-node__rename program-node__rename nodrag"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setRenaming(null);
      }}
      spellCheck={false}
    />
  );
}

function ProgramNodeInner({ data, selected }: NodeProps<ProgramNodeType>) {
  const { program, steps, roundTrips, path, hiddenMembers, lod, dimmed, traceRole, picking, renaming } = data;
  const activeStepId = useUi((s) => s.activeProgramStepId);
  const lang = programLanguageMeta(program.language);
  const kind = codeKindOf(program);
  const kindMeta = codeKindMeta(kind);
  const role = kind === 'program' && program.role ? programRoleMeta(program.role) : null;
  const KindIcon = KIND_ICON[kind];
  const container = kindMeta.container;

  const classes = ['program-node', `program-node--${kind}`];
  if (selected) classes.push('program-node--selected');
  if (dimmed) classes.push('program-node--dim');
  if (traceRole) classes.push('program-node--trace');
  if (picking) classes.push('program-node--pick');
  // A folded container stacks like a pile of nodes; a folded procedure just draws less.
  if (program.collapsed && container) classes.push('program-node--collapsed');

  const procedure = kind === 'procedure';
  const folded = procedure && Boolean(program.collapsed) && steps.length > 0;
  const tooltip = [
    procedure ? procedureSignature(program) : '',
    program.comment || '',
    program.entrypoint ? `in ${program.entrypoint}` : '',
    path.includes('/') ? path : '',
  ]
    .filter(Boolean)
    .join('\n');
  // A procedure's badge says which of the two routines it is, since that is
  // what decides how anything calls it: CALL for one, inside a query for the other.
  const badge = procedure ? (program.returns?.trim() ? 'Function' : 'Procedure') : kind === 'program' ? lang.label : kindMeta.label;

  return (
    <div className={classes.join(' ')} style={{ '--hue': paletteHue(program.color) } as React.CSSProperties}>
      <div
        className="program-node__header"
        title={tooltip || undefined}
        onDoubleClick={(e) => {
          e.stopPropagation();
          useUi.getState().setRenamingNodeId(program.id);
        }}
      >
        <KindIcon className="program-node__prompt" />
        <span
          className="program-node__lang"
          title={procedure ? `Stored ${badge.toLowerCase()}: the database runs it` : kind === 'program' ? `Written in ${lang.label}` : `${kindMeta.label}, in ${lang.label}`}
        >
          {badge}
        </span>
        {renaming ? <RenameInput program={program} /> : <span className="program-node__name">{program.name || `Untitled ${kindMeta.label.toLowerCase()}`}</span>}
        {role && (
          <span className="program-node__role" title={role.hint}>
            {role.label}
          </span>
        )}
        {traceRole && <span className="program-node__role program-node__role--trace">{traceRole === 'from' ? 'FROM' : traceRole === 'to' ? 'TO' : 'VIA'}</span>}
        {container && program.collapsed && !lod && (
          <button
            type="button"
            className="program-node__fold nodrag"
            title={`Expand: show the ${hiddenMembers} node${hiddenMembers === 1 ? '' : 's'} inside`}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().setCodeCollapsed([program.id], false);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <ChevronsUpDown />
          </button>
        )}
        {procedure && steps.length > 0 && !lod && (
          <button
            type="button"
            className="program-node__fold nodrag"
            title={folded ? 'Show the steps' : 'Hide the steps'}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().setCodeCollapsed([program.id], !folded);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {folded ? <ChevronDown /> : <ChevronUp />}
          </button>
        )}
        <Handle type="source" position={Position.Left} id={`${program.id}|hdrl`} className="program-node__handle program-node__handle--left" />
        <Handle type="source" position={Position.Right} id={`${program.id}|hdr`} className="program-node__handle" />
      </div>

      {!lod && (
        <div className="program-node__steps">
          {steps.length === 0 && !hiddenMembers && <div className="program-node__empty">{kind === 'function' ? 'no steps yet' : container ? 'nothing inside yet' : 'no steps yet'}</div>}
          {folded && (
            <div className="program-node__step program-node__step--folded" title="Steps hidden. Click to show them." onClick={() => useStore.getState().setCodeCollapsed([program.id], false)}>
              <span className="program-node__num">…</span>
              <ChevronsUpDown className="program-node__op" />
              <span className="program-node__label program-node__label--folded">
                {steps.length} step{steps.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
          {(folded ? [] : steps).map((s, i) => (
            <StepRow key={s.id} step={s} index={i} active={s.id === activeStepId} procedure={procedure} />
          ))}
          {hiddenMembers > 0 && (
            <div
              className="program-node__step program-node__step--folded"
              title="Everything inside this container, folded away. Double-click the chevron, or use the inspector, to expand it."
              onClick={() => useStore.getState().setCodeCollapsed([program.id], false)}
            >
              <span className="program-node__num">…</span>
              <ChevronsUpDown className="program-node__op" />
              <span className="program-node__label program-node__label--folded">
                {hiddenMembers} node{hiddenMembers === 1 ? '' : 's'} inside
              </span>
            </div>
          )}
        </div>
      )}

      {!lod && !folded && roundTrips.length > 0 && (
        <div className="program-node__footer" title="Tables this node both reads and writes">
          round trip: {roundTrips.join(', ')}
        </div>
      )}
    </div>
  );
}

export const ProgramNode = memo(ProgramNodeInner);
