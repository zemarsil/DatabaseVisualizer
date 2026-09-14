import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronsDownUp } from 'lucide-react';
import { codeKindMeta, codeKindOf, type Program } from '@shared/types';
import { paletteHue } from '@/lib/palette';
import { useStore } from '@/store/useStore';
import { KIND_ICON } from './ProgramNode';

/**
 * An expanded container — a program, a module or a class with members drawn
 * inside it — as the region around them.
 *
 * It is the same idea as a table group and deliberately looks like one: a
 * derived rectangle, a title pill that is the only part that takes the pointer,
 * clicks passing through everywhere else so the members underneath stay
 * usable. The differences are what a container is: it has a kind, it can be
 * folded to one node with the chevron, and it is a thing arrows can point at,
 * which a group never is.
 */
export interface CodeGroupNodeData extends Record<string, unknown> {
  program: Program;
  /** Members drawn inside, at any depth. */
  memberCount: number;
  depth: number;
  selected: boolean;
  dimmed: boolean;
  /** A code node is being dragged and would land in this container if dropped now. */
  dropTarget: boolean;
  traceRole: 'from' | 'to' | 'via' | null;
}

export type CodeGroupNodeType = Node<CodeGroupNodeData, 'codegroup'>;

export const CODE_GROUP_DRAG_HANDLE = '.code-group__header';

function CodeGroupNodeInner({ data }: NodeProps<CodeGroupNodeType>) {
  const { program, memberCount, depth, selected, dimmed, dropTarget, traceRole } = data;
  const kind = codeKindOf(program);
  const Icon = KIND_ICON[kind];
  const classes = ['code-group', `code-group--${kind}`, `code-group--depth-${Math.min(depth, 3)}`];
  if (selected) classes.push('code-group--selected');
  if (dropTarget) classes.push('code-group--drop');
  if (dimmed) classes.push('code-group--dim');
  if (traceRole) classes.push('code-group--trace');
  return (
    <div className={classes.join(' ')} style={{ '--hue': paletteHue(program.color) } as React.CSSProperties}>
      <div className="code-group__header" title={program.comment || program.entrypoint || `${codeKindMeta(kind).label}: ${program.name}`}>
        <Icon />
        <span className="code-group__kind">{codeKindMeta(kind).label}</span>
        <span className="code-group__name">{program.name || `Untitled ${codeKindMeta(kind).label.toLowerCase()}`}</span>
        <span className="code-group__count">{memberCount}</span>
        {traceRole && <span className="code-group__badge">{traceRole === 'from' ? 'FROM' : traceRole === 'to' ? 'TO' : 'VIA'}</span>}
        <button
          type="button"
          className="code-group__fold nodrag"
          title={`Collapse ${program.name} to one node`}
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().setCodeCollapsed([program.id], true);
          }}
        >
          <ChevronsDownUp />
        </button>
        {/* Arrows to an expanded container meet its title, so the handle lives on the pill. */}
        <Handle type="source" position={Position.Right} id={`${program.id}|hdr`} className="code-group__handle" />
      </div>
    </div>
  );
}

export const CodeGroupNode = memo(CodeGroupNodeInner);
