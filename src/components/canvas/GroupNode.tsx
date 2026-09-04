import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { Boxes, Database } from 'lucide-react';
import type { Group } from '@shared/types';
import { paletteHue } from '@/lib/palette';

export interface GroupNodeData extends Record<string, unknown> {
  group: Group;
  tableCount: number;
  selected: boolean;
  dimmed: boolean;
  /** A table is being dragged and would land in this group if dropped now. */
  dropTarget: boolean;
}

export type GroupNodeType = Node<GroupNodeData, 'tablegroup'>;

export const GROUP_DRAG_HANDLE = '.group-node__header';

function GroupNodeInner({ data }: NodeProps<GroupNodeType>) {
  const { group, tableCount, selected, dimmed, dropTarget } = data;
  const classes = ['group-node'];
  if (group.external) classes.push('group-node--external');
  if (selected) classes.push('group-node--selected');
  if (dropTarget) classes.push('group-node--drop');
  if (dimmed) classes.push('group-node--dim');

  return (
    <div className={classes.join(' ')} style={{ '--hue': paletteHue(group.color) } as React.CSSProperties}>
      <div className="group-node__header" title={group.note || (group.external ? 'Tables in another database' : undefined)}>
        {group.external ? <Database /> : <Boxes />}
        <span className="group-node__name">{group.name || 'Untitled group'}</span>
        <span className="group-node__count">{tableCount}</span>
        {group.external && <span className="group-node__badge">external</span>}
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeInner);
