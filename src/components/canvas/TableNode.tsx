import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Braces, KeyRound, Link2 } from 'lucide-react';
import type { Table } from '@shared/types';
import { paletteHue } from '@/lib/palette';

export interface TableNodeData extends Record<string, unknown> {
  table: Table;
  fkColumnIds: string[];
  /** Columns holding another table serialized inside them. */
  embedColumnIds: string[];
  dimmed: boolean;
  traceRole: 'from' | 'to' | 'via' | null;
  picking: boolean;
}

export type TableNodeType = Node<TableNodeData, 'table'>;

export const HEADER_HANDLE_SUFFIX = '|hdr';

function TableNodeInner({ data, selected }: NodeProps<TableNodeType>) {
  const { table, fkColumnIds, embedColumnIds, dimmed, traceRole, picking } = data;
  const fkSet = new Set(fkColumnIds);
  const embedSet = new Set(embedColumnIds);
  const classes = ['table-node'];
  if (selected) classes.push('table-node--selected');
  if (traceRole) classes.push('table-node--trace');
  if (dimmed) classes.push('table-node--dim');
  if (picking) classes.push('table-node--pick');

  return (
    <div className={classes.join(' ')} style={{ '--hue': paletteHue(table.color) } as React.CSSProperties} title={table.comment || undefined}>
      <div className="table-node__header">
        <span className="table-node__name">{table.name || 'untitled'}</span>
        {table.schema && <span className="table-node__schema">{table.schema}</span>}
        <div className="table-node__badges">
          {traceRole && <span className="table-node__badge">{traceRole === 'from' ? 'FROM' : traceRole === 'to' ? 'TO' : 'VIA'}</span>}
        </div>
        <Handle
          type="source"
          position={Position.Right}
          id={`${table.id}${HEADER_HANDLE_SUFFIX}`}
          className="flow-handle"
          title="Drag to another table to link the two tables (a data flow by default; change the kind in the inspector)"
        />
      </div>
      <div className="table-node__rows">
        {table.columns.length === 0 && <div className="table-node__empty">no columns yet</div>}
        {table.columns.map((c) => {
          const isFk = fkSet.has(c.id);
          const isEmbed = !c.primaryKey && !isFk && embedSet.has(c.id);
          return (
            <div key={c.id} className={`table-node__row${c.primaryKey ? ' table-node__row--pk' : ''}`} title={c.comment || undefined}>
              <Handle type="source" position={Position.Left} id={`${c.id}|l`} className="col-handle col-handle--left" />
              <span className={`col-icon${c.primaryKey ? ' col-icon--pk' : isFk ? ' col-icon--fk' : isEmbed ? ' col-icon--embed' : ''}`}>
                {c.primaryKey ? <KeyRound /> : isFk ? <Link2 /> : isEmbed ? <Braces /> : null}
              </span>
              <span className="col-name">{c.name}</span>
              <span className="col-type">{c.type}</span>
              <span className="col-flags">
                {!c.nullable && !c.primaryKey && <span className="col-flag">NN</span>}
                {c.unique && !c.primaryKey && <span className="col-flag">UQ</span>}
                {c.autoIncrement && <span className="col-flag">AI</span>}
              </span>
              <Handle type="source" position={Position.Right} id={`${c.id}|r`} className="col-handle col-handle--right" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeInner);
