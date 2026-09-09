import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Braces, ChevronDown, ChevronRight, ChevronUp, Eye, KeyRound, Link2 } from 'lucide-react';
import type { Column, Table } from '@shared/types';
import { paletteHue } from '@/lib/palette';
import { nextDisplay, type TableDisplayMode } from '@/lib/visibleColumns';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';

export interface TableNodeData extends Record<string, unknown> {
  table: Table;
  fkColumnIds: string[];
  /** Columns holding another table serialized inside them. */
  embedColumnIds: string[];
  /** Columns actually drawn (all, keys only, or none when collapsed to the header). */
  visibleColumns: Column[];
  display: TableDisplayMode;
  /** True while zoomed out far enough that every table shows its header only. */
  lod: boolean;
  joinTable: boolean;
  dimmed: boolean;
  traceRole: 'from' | 'to' | 'via' | null;
  picking: boolean;
  renaming: boolean;
  /** How the table takes part in the running data-flow simulation, if one is on. */
  simulation?: NodeSimulation | null;
}

/** input -> seeded raw rows, derived -> filled by flows, lookup -> read through a foreign key. */
export interface NodeSimulation {
  role: 'input' | 'derived' | 'lookup';
  /** Rows the table holds at the current stage of playback. */
  rowCount: number;
  /** The stage in play reads from or writes to this table. */
  active: boolean;
  /** The table the simulation was asked about. */
  isTarget: boolean;
  readColumnIds: string[];
  writtenColumnIds: string[];
}

export type TableNodeType = Node<TableNodeData, 'table'>;

export const HEADER_HANDLE_SUFFIX = '|hdr';

function RenameInput({ table }: { table: Table }) {
  const [value, setValue] = useState(table.name);
  const ref = useRef<HTMLInputElement>(null);
  const updateTable = useStore((s) => s.updateTable);
  const setRenaming = useUi((s) => s.setRenamingTableId);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const next = value.trim();
    if (next && next !== table.name) updateTable(table.id, { name: next });
    setRenaming(null);
  };
  /** Tab carries on into the inspector rather than the collapse button behind the input. */
  const commitAndOpenInspector = () => {
    commit();
    const s = useStore.getState();
    s.setInspectorOpen(true);
    s.focusInspectorField('schema');
  };
  return (
    <input
      ref={ref}
      className="table-node__rename nodrag"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setRenaming(null);
        else if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          commitAndOpenInspector();
        }
      }}
      spellCheck={false}
    />
  );
}

function TableNodeInner({ data, selected }: NodeProps<TableNodeType>) {
  const { table, fkColumnIds, embedColumnIds, visibleColumns, display, lod, joinTable, dimmed, traceRole, picking, renaming } = data;
  const sim = data.simulation ?? null;
  const fkSet = new Set(fkColumnIds);
  const embedSet = new Set(embedColumnIds);
  const readSet = new Set(sim?.active ? sim.readColumnIds : []);
  const writtenSet = new Set(sim?.active ? sim.writtenColumnIds : []);
  const isView = table.kind === 'view';
  const classes = ['table-node'];
  if (selected) classes.push('table-node--selected');
  if (traceRole) classes.push('table-node--trace');
  if (sim) classes.push(`table-node--sim-${sim.role}`);
  if (sim?.active) classes.push('table-node--sim-active');
  if (sim?.isTarget) classes.push('table-node--sim-target');
  if (dimmed) classes.push('table-node--dim');
  if (picking) classes.push('table-node--pick');
  if (isView) classes.push('table-node--view');
  if (display !== 'full') classes.push(`table-node--${display}`);
  const hidden = table.columns.length - visibleColumns.length;

  const cycle = (e: React.MouseEvent) => {
    e.stopPropagation();
    useStore.getState().setTableDisplay([table.id], nextDisplay(table.collapsed));
  };
  const Chevron = display === 'full' ? ChevronUp : display === 'keys' ? ChevronRight : ChevronDown;

  return (
    <div className={classes.join(' ')} style={{ '--hue': paletteHue(table.color) } as React.CSSProperties} title={table.comment || undefined}>
      <div
        className="table-node__header"
        onDoubleClick={(e) => {
          e.stopPropagation();
          useUi.getState().setRenamingTableId(table.id);
        }}
      >
        {isView && <Eye className="table-node__kind-icon" />}
        {renaming ? <RenameInput table={table} /> : <span className="table-node__name">{table.name || 'untitled'}</span>}
        {table.schema && <span className="table-node__schema">{table.schema}</span>}
        <div className="table-node__badges">
          {isView && <span className="table-node__badge table-node__badge--view">{table.materialized ? 'MAT VIEW' : 'VIEW'}</span>}
          {joinTable && !isView && (
            <span className="table-node__badge table-node__badge--join" title="Join table: every key column references another table (many-to-many)">
              N:M
            </span>
          )}
          {traceRole && <span className="table-node__badge">{traceRole === 'from' ? 'FROM' : traceRole === 'to' ? 'TO' : 'VIA'}</span>}
          {sim && (
            <span
              className={`table-node__badge table-node__badge--sim-${sim.role}`}
              title={sim.role === 'input' ? 'Raw input: sample rows' : sim.role === 'lookup' ? 'Read through a foreign key' : 'Derived: filled by the data flows'}
            >
              {sim.rowCount} row{sim.rowCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {!lod && table.columns.length > 0 && (
          <button
            type="button"
            className="table-node__collapse nodrag"
            title={display === 'full' ? 'Show keys only' : display === 'keys' ? 'Show header only' : 'Show all columns'}
            onClick={cycle}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Chevron />
          </button>
        )}
        <Handle
          type="source"
          position={Position.Right}
          id={`${table.id}${HEADER_HANDLE_SUFFIX}`}
          className="flow-handle"
          title={isView ? 'Drag to another table to say what feeds this view' : 'Drag to another table to link the two tables (a data flow by default; change the kind in the inspector)'}
        />
      </div>
      <div className="table-node__rows">
        {table.columns.length === 0 && <div className="table-node__empty">{isView ? (table.viewSql?.trim() ? 'columns come from the SELECT' : 'no SELECT yet') : 'no columns yet'}</div>}
        {display === 'header' && table.columns.length > 0 && (
          <div className="table-node__empty">
            {table.columns.length} column{table.columns.length === 1 ? '' : 's'}
          </div>
        )}
        {visibleColumns.map((c) => {
          const isFk = fkSet.has(c.id);
          const isEmbed = !c.primaryKey && !isFk && embedSet.has(c.id);
          return (
            <div
              key={c.id}
              className={`table-node__row${c.primaryKey ? ' table-node__row--pk' : ''}${readSet.has(c.id) ? ' table-node__row--read' : ''}${writtenSet.has(c.id) ? ' table-node__row--written' : ''}`}
              title={readSet.has(c.id) ? `${c.name}: read by the flow in play` : writtenSet.has(c.id) ? `${c.name}: written by the flow in play` : c.comment || undefined}
              /* Read by the canvas so a right-click on this row opens the column menu. */
              data-column-id={c.id}
            >
              {!isView && <Handle type="source" position={Position.Left} id={`${c.id}|l`} className="col-handle col-handle--left" />}
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
              {!isView && <Handle type="source" position={Position.Right} id={`${c.id}|r`} className="col-handle col-handle--right" />}
            </div>
          );
        })}
        {display === 'keys' && hidden > 0 && (
          <div className="table-node__more" onClick={cycle} title="Show all columns">
            +{hidden} more column{hidden === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeInner);
