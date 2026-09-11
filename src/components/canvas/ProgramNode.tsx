import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowDownToLine, ArrowUpFromLine, Cpu, Terminal, TriangleAlert } from 'lucide-react';
import { programLanguageMeta, programRoleMeta, type Program, type ProgramStepOp } from '@shared/types';
import { paletteHue } from '@/lib/palette';
import { useUi } from '@/store/useUi';
import '@/styles/programs.css';

/**
 * What one step row shows. Resolved by the canvas rather than looked up here,
 * so the node re-renders only when what it draws actually changes.
 */
export interface ProgramStepView {
  id: string;
  op: ProgramStepOp;
  /** Table name, or null on a compute step. */
  table: string | null;
  columns: string[];
  /** The step names a table the diagram no longer has. */
  missing: boolean;
  /** Prose, shown on a compute step and in every step's tooltip. */
  note: string;
  hasCode: boolean;
}

export interface ProgramNodeData extends Record<string, unknown> {
  program: Program;
  steps: ProgramStepView[];
  /** Names of tables this program both reads and writes: the actual round trips. */
  roundTrips: string[];
  dimmed: boolean;
}

export type ProgramNodeType = Node<ProgramNodeData, 'program'>;

export const PROGRAM_DRAG_HANDLE = undefined;

const OP_ICON: Record<ProgramStepOp, typeof Cpu> = {
  read: ArrowDownToLine,
  write: ArrowUpFromLine,
  compute: Cpu,
};

function ProgramNodeInner({ data, selected }: NodeProps<ProgramNodeType>) {
  const { program, steps, roundTrips, dimmed } = data;
  const setActiveStep = useUi((s) => s.setActiveProgramStepId);
  const activeStepId = useUi((s) => s.activeProgramStepId);
  const lang = programLanguageMeta(program.language);
  const role = program.role ? programRoleMeta(program.role) : null;

  const classes = ['program-node'];
  if (selected) classes.push('program-node--selected');
  if (dimmed) classes.push('program-node--dim');

  return (
    <div className={classes.join(' ')} style={{ '--hue': paletteHue(program.color) } as React.CSSProperties}>
      <div className="program-node__header" title={program.comment || program.entrypoint || undefined}>
        <Terminal className="program-node__prompt" />
        <span className="program-node__lang" title={`Written in ${lang.label}`}>
          {lang.label}
        </span>
        <span className="program-node__name">{program.name || 'Untitled program'}</span>
        {role && (
          <span className="program-node__role" title={role.hint}>
            {role.label}
          </span>
        )}
        <Handle type="source" position={Position.Right} id={`${program.id}|hdr`} className="program-node__handle" />
      </div>

      <div className="program-node__steps">
        {steps.length === 0 && <div className="program-node__empty">no steps yet</div>}
        {steps.map((s, i) => {
          const Icon = OP_ICON[s.op];
          const rowClasses = ['program-node__step', `program-node__step--${s.op}`];
          if (s.id === activeStepId) rowClasses.push('program-node__step--active');
          if (s.missing) rowClasses.push('program-node__step--missing');
          const label = s.op === 'compute' ? s.note || 'compute' : (s.table ?? '(missing table)');
          const tooltip = [
            s.op === 'compute' ? 'Work the database never sees' : `${s.op} ${s.table ?? '?'}`,
            s.columns.length ? s.columns.join(', ') : '',
            s.note && s.op !== 'compute' ? s.note : '',
            s.missing ? 'This table is no longer in the diagram.' : '',
            s.hasCode ? 'Carries code.' : '',
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div
              key={s.id}
              className={rowClasses.join(' ')}
              title={tooltip}
              // Clicking a step hands the inspector the one to open on, so the
              // canvas and the editor stay pointed at the same thing.
              onClick={() => setActiveStep(s.id)}
            >
              <span className="program-node__num">{i + 1}</span>
              <Icon className="program-node__op" />
              <span className="program-node__label">{label}</span>
              {s.columns.length > 0 && <span className="program-node__cols">{s.columns.join(', ')}</span>}
              {s.missing && <TriangleAlert className="program-node__warn" />}
              <Handle type="source" position={Position.Left} id={`${s.id}|l`} className="program-node__step-handle program-node__step-handle--left" />
              <Handle type="source" position={Position.Right} id={`${s.id}|r`} className="program-node__step-handle program-node__step-handle--right" />
            </div>
          );
        })}
      </div>

      {roundTrips.length > 0 && (
        <div className="program-node__footer" title="Tables this program both reads and writes">
          round trip: {roundTrips.join(', ')}
        </div>
      )}
    </div>
  );
}

export const ProgramNode = memo(ProgramNodeInner);
