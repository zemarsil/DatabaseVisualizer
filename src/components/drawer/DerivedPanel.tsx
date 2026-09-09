import { useMemo } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Crosshair, Eye, GitBranch, Sigma, Table2, X } from 'lucide-react';
import type { Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import {
  buildLineage,
  columnOrigin,
  derivedColumnIds,
  downstream,
  flattenLineage,
  lineageTotals,
  upstream,
  viewInputTables,
  type Lineage,
  type LineageNode,
} from '@/lib/lineage';
import '@/styles/derived.css';

/** The lineage tree as rows: one per column, indented by how far along the chain it sits. */
function LineageTree({ lineage, root, empty }: { lineage: Lineage; root: LineageNode; empty: string }) {
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const showLineage = useUi((s) => s.showLineage);
  const rows = flattenLineage(root);
  if (!rows.length) return <div className="small muted">{empty}</div>;
  return (
    <ul className="lineage-tree">
      {rows.map((n, i) => {
        const table = lineage.tableById.get(n.tableId);
        const column = lineage.columnById.get(n.columnId);
        const edge = n.edge;
        const flowFrom = edge ? lineage.tableById.get(edge.sourceTableId)?.name : undefined;
        const flowTo = edge ? lineage.tableById.get(edge.targetTableId)?.name : undefined;
        return (
          <li key={`${n.columnId}:${i}`} className="lineage-tree__row" style={{ paddingLeft: 6 + (n.depth - 1) * 18 }}>
            <span className="lineage-tree__rail" aria-hidden="true" />
            <button
              className="lineage-tree__column"
              title="Show this column's own lineage"
              onClick={() => {
                showLineage(n.columnId);
                if (table) focusTable(table.id);
              }}
            >
              {table?.kind === 'view' ? <Eye /> : <Table2 />}
              {table?.name ?? '?'}.<strong>{column?.name ?? '?'}</strong>
            </button>
            {edge && (
              <button
                className="lineage-tree__edge"
                title={`Edit this data flow (${flowFrom} → ${flowTo})`}
                onClick={() => setSelection({ relationshipId: edge.relationshipId, tableIds: [], noteIds: [] })}
              >
                <GitBranch />
                <span className="lineage-tree__edge-text">
                  {edge.summary} · in {flowFrom} → {flowTo}
                </span>
              </button>
            )}
            {n.repeated && <span className="badge badge--danger">already on this path</span>}
            {n.truncated && <span className="badge">more beyond this</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** One table's derived columns in the left-hand list. */
function TableEntry({ lineage, table, activeColumnId }: { lineage: Lineage; table: Table; activeColumnId: string | null }) {
  const showLineage = useUi((s) => s.showLineage);
  const focusTable = useStore((s) => s.focusTable);
  const ids = derivedColumnIds(lineage, table);
  const isView = table.kind === 'view';
  return (
    <div className="derived-table">
      <div className="derived-table__head">
        {isView ? <Eye /> : <Table2 />}
        <strong>{table.name || 'untitled'}</strong>
        <span className="badge badge--flow">
          {ids.length} of {table.columns.length}
        </span>
        {isView && <span className="badge">{table.materialized ? 'MAT VIEW' : 'VIEW'}</span>}
      </div>
      <ul className="derived-table__cols">
        {ids.map((id) => {
          const column = lineage.columnById.get(id);
          const entries = lineage.filledBy.get(id) ?? [];
          return (
            <li key={id}>
              <button
                className={`derived-col${activeColumnId === id ? ' derived-col--active' : ''}`}
                onClick={() => {
                  showLineage(id);
                  focusTable(table.id);
                }}
              >
                <Sigma />
                <span className="derived-col__name">{column?.name ?? '?'}</span>
                <span className="derived-col__how">
                  {entries.length
                    ? entries.map((e) => e.summary).join(' · ')
                    : isView
                      ? 'computed by the view’s SELECT'
                      : 'computed by a data flow'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The Derived tab: every column the schema computes rather than stores, and for
 * any one of them the chain it comes from and the chain that reads it. Picking a
 * column here also points the canvas lens at it, so the list and the diagram
 * always agree about what is being looked at.
 */
export function DerivedPanel() {
  const diagram = useStore((s) => s.diagram);
  const selection = useStore((s) => s.selection);
  const lens = useUi((s) => s.derived);
  const setDerived = useUi((s) => s.setDerived);
  const showLineage = useUi((s) => s.showLineage);

  const lineage = useMemo(() => buildLineage(diagram), [diagram]);
  const totals = useMemo(() => lineageTotals(lineage, diagram), [lineage, diagram]);
  const tables = useMemo(() => diagram.tables.filter((t) => derivedColumnIds(lineage, t).length > 0), [diagram.tables, lineage]);

  const columnId = lens?.columnId ?? null;
  const focusTableId = columnId ? (lineage.tableOfColumn.get(columnId) ?? null) : null;
  const focusColumn = columnId ? lineage.columnById.get(columnId) : undefined;
  const focusTable = focusTableId ? lineage.tableById.get(focusTableId) : undefined;
  const origin = columnId ? columnOrigin(lineage, columnId) : null;

  const up = useMemo(() => (columnId ? upstream(lineage, columnId) : null), [lineage, columnId]);
  const down = useMemo(() => (columnId ? downstream(lineage, columnId) : null), [lineage, columnId]);
  const viewInputs = useMemo(() => (origin === 'view' && focusTableId ? viewInputTables(diagram, focusTableId) : []), [origin, focusTableId, diagram]);

  // A column picked in the diagram is the obvious thing to explain next.
  const selectedTable = selection.tableIds.length === 1 ? diagram.tables.find((t) => t.id === selection.tableIds[0]) : undefined;

  return (
    <div className="drawer__split">
      <div className="drawer__col">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Derived columns</h3>
          <span className="grow" />
          <button
            className={`btn btn--sm${lens ? ' btn--active' : ''}`}
            title="Paint the canvas by what is computed and what is stored (D)"
            onClick={() => setDerived(lens ? null : { columnId: null, downstream: true })}
          >
            <Sigma /> {lens ? 'Lens on' : 'Lens off'}
          </button>
          {columnId && (
            <button className="btn btn--sm btn--ghost" title="Back to every derived column" onClick={() => showLineage(null)}>
              <X /> Clear
            </button>
          )}
        </div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          A column is <strong>computed</strong> when a data flow fills it — through a derived-column entry, or by carrying a group key of the same name over —
          and when it belongs to a view, whose SELECT produces every one of its columns. Everything else is stored: rows arrive carrying the value.
        </div>
        {tables.length === 0 ? (
          <div className="small muted">
            Nothing in this diagram is computed yet. Drag the orange handle in a table header onto another table to draw a data flow, select the edge, and add
            one derived column per column the flow fills. A view counts too: switch a table to <em>View</em> and paste its SELECT.
            {selectedTable && <> Right now {selectedTable.name} stores all {selectedTable.columns.length} of its columns.</>}
          </div>
        ) : (
          <>
            <div className="small muted" style={{ marginBottom: 8 }}>
              <strong>{totals.derived}</strong> computed across {totals.tables} table{totals.tables === 1 ? '' : 's'}, <strong>{totals.stored}</strong> stored.
              Pick one to see where its value comes from.
            </div>
            <div className="derived-list">
              {tables.map((t) => (
                <TableEntry key={t.id} lineage={lineage} table={t} activeColumnId={columnId} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="drawer__col">
        {!columnId || !focusColumn || !focusTable ? (
          <div className="small muted">
            Pick a derived column on the left — or right-click a column on the canvas and choose <em>Show where this comes from</em> — and its chain appears
            here: every column read to produce it, and everything computed from it in turn.
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>
                {focusTable.name}.{focusColumn.name}
              </h3>
              <span className="badge badge--flow">{origin === 'view' ? 'view column' : origin === 'derived' ? 'computed' : 'stored'}</span>
              <span className="grow" />
              <button
                className="btn btn--sm btn--ghost"
                title="Zoom to this table on the canvas"
                onClick={() => {
                  useStore.getState().selectTable(focusTable.id);
                  useStore.getState().focusTable(focusTable.id);
                }}
              >
                <Crosshair /> Show
              </button>
            </div>
            {origin === 'view' && (
              <div className="small muted" style={{ marginBottom: 10 }}>
                {focusTable.materialized ? 'A materialized view' : 'A view'}: every column comes out of its SELECT, so there is no per-column formula to read.
                {viewInputs.length ? <> It is fed by {viewInputs.map((t) => t.name).join(', ')}.</> : <> Draw data flows into it (or use <em>Detect from SQL</em>) to record which tables it reads.</>}
              </div>
            )}
            <div className="derived-list">
            <div className="derived-section">
              <div className="derived-section__head">
                <ArrowUpFromLine /> What it is computed from
              </div>
              <LineageTree
                lineage={lineage}
                root={up!}
                empty={
                  origin === 'stored'
                    ? 'Nothing: rows arrive with this value already in them. It is where data enters the schema.'
                    : 'No columns resolved. The entries filling it may name columns that do not exist — Problems will say which.'
                }
              />
            </div>
            <div className="derived-section">
              <div className="derived-section__head">
                <ArrowDownToLine /> What is computed from it
              </div>
              <LineageTree lineage={lineage} root={down!} empty="Nothing reads this column to compute anything else." />
            </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
