import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Braces, ChevronDown, ChevronRight, ChevronUp, Eye, KeyRound, Link2, Sigma } from 'lucide-react';
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
  /** Columns a data flow fills, so they carry the Σ mark instead of reading as stored. */
  derivedColumnIds: string[];
  /** What fills each of those, one line per formula, for the mark's own tooltip. */
  derivedSummaries: Record<string, string>;
  /** How the derived lens paints this table, or null while the lens is off. */
  lens?: NodeLens | null;
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

/**
 * The derived lens, per table: which of its columns feed somebody else's
 * computation, and — while the lens is pointed at one column — which of them sit
 * on that column's chain. (Which columns are *computed* is `derivedColumnIds`,
 * because that mark is on whether the lens is or not.)
 */
export interface NodeLens {
  /** Columns a derivation reads. A column can be both read and computed. */
  sourceColumnIds: string[];
  /** Columns on the focused column's own chain; empty when the lens is showing the whole diagram. */
  lineageColumnIds: string[];
  /** The one column the lineage was asked about. */
  focusColumnId: string | null;
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
  const { table, fkColumnIds, embedColumnIds, derivedColumnIds, derivedSummaries, visibleColumns, display, lod, joinTable, dimmed, traceRole, picking, renaming } = data;
  const sim = data.simulation ?? null;
  const lens = data.lens ?? null;
  const fkSet = new Set(fkColumnIds);
  const embedSet = new Set(embedColumnIds);
  const derivedSet = new Set(derivedColumnIds);
  const sourceSet = new Set(lens?.sourceColumnIds ?? []);
  const lineageSet = lens?.lineageColumnIds.length ? new Set(lens.lineageColumnIds) : null;
  const readSet = new Set(sim?.active ? sim.readColumnIds : []);
  const writtenSet = new Set(sim?.active ? sim.writtenColumnIds : []);
  const isView = table.kind === 'view';
  const classes = ['table-node'];
  if (selected) classes.push('table-node--selected');
  if (traceRole) classes.push('table-node--trace');
  if (sim) classes.push(`table-node--sim-${sim.role}`);
  if (sim?.active) classes.push('table-node--sim-active');
  if (sim?.isTarget) classes.push('table-node--sim-target');
  if (lens) classes.push('table-node--lens');
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
          {derivedColumnIds.length > 0 && !isView && (
            <span
              className="table-node__badge table-node__badge--derived"
              title={`${derivedColumnIds.length} of ${table.columns.length} columns are computed by a data flow rather than stored`}
            >
              Σ {derivedColumnIds.length}
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
          const isDerived = derivedSet.has(c.id);
          const isSource = sourceSet.has(c.id);
          // Off the chain the lens is following, so the row steps back rather than disappearing.
          const offChain = Boolean(lineageSet && !lineageSet.has(c.id));
          const classes = ['table-node__row'];
          if (c.primaryKey) classes.push('table-node__row--pk');
          if (readSet.has(c.id)) classes.push('table-node__row--read');
          if (writtenSet.has(c.id)) classes.push('table-node__row--written');
          if (lens) {
            if (isDerived) classes.push('table-node__row--derived');
            if (isSource) classes.push('table-node__row--feeds');
            if (offChain) classes.push('table-node__row--offchain');
            if (c.id === lens.focusColumnId) classes.push('table-node__row--lineage-root');
          }
          // While the lens is on, a row says where its value comes from; the
          // column's own comment follows it rather than being displaced by it.
          const lensRole = !lens
            ? null
            : isDerived && isSource
              ? 'computed here, and read by another flow'
              : isDerived
                ? 'computed by a data flow'
                : isSource
                  ? 'read by a data flow to compute something else'
                  : 'stored';
          const lensTitle = lensRole ? [`${c.name}: ${lensRole}`, c.comment].filter(Boolean).join('\n') : undefined;
          return (
            <div
              key={c.id}
              className={classes.join(' ')}
              title={
                readSet.has(c.id)
                  ? `${c.name}: read by the flow in play`
                  : writtenSet.has(c.id)
                    ? `${c.name}: written by the flow in play`
                    : (lensTitle ?? c.comment ?? undefined) || undefined
              }
              /* Read by the canvas so a right-click on this row opens the column menu. */
              data-column-id={c.id}
            >
              {!isView && <Handle type="source" position={Position.Left} id={`${c.id}|l`} className="col-handle col-handle--left" />}
              <span
                className={`col-icon${c.primaryKey ? ' col-icon--pk' : isFk ? ' col-icon--fk' : isEmbed ? ' col-icon--embed' : isDerived ? ' col-icon--derived' : ''}`}
                /* The Σ explains itself on hover, so the formula is one pointer away without opening a panel. */
                title={isDerived && !c.primaryKey && !isFk ? derivedSummaries[c.id] : undefined}
              >
                {c.primaryKey ? <KeyRound /> : isFk ? <Link2 /> : isEmbed ? <Braces /> : isDerived ? <Sigma /> : null}
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
