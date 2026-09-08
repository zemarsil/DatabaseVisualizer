import { useMemo } from 'react';
import { Database, ScanSearch } from 'lucide-react';
import type { Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { viewSourcesFromSql } from '@/lib/sql/views';

/** The SELECT behind a view and the tables that feed it. */
export function ViewEditor({ table }: { table: Table }) {
  const diagram = useStore((s) => s.diagram);
  const updateTable = useStore((s) => s.updateTable);
  const addRelationship = useStore((s) => s.addRelationship);
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const toast = useStore((s) => s.toast);

  const sources = useMemo(
    () =>
      diagram.relationships
        .filter((r) => r.kind === 'flow' && r.targetTableId === table.id)
        .map((r) => diagram.tables.find((t) => t.id === r.sourceTableId))
        .filter((t): t is Table => Boolean(t)),
    [diagram, table.id],
  );

  const detect = () => {
    const candidates = diagram.tables.filter((t) => t.id !== table.id).map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
    const found = viewSourcesFromSql(table.viewSql ?? '', candidates);
    let added = 0;
    for (const name of found) {
      const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
      const src = diagram.tables.find((t) => t.id !== table.id && (t.name === bare || `${t.schema}.${t.name}` === name));
      if (!src || sources.some((s) => s.id === src.id)) continue;
      addRelationship({ kind: 'flow', name: 'view source', sourceTableId: src.id, sourceColumnIds: [], targetTableId: table.id, targetColumnIds: [] });
      added++;
    }
    setSelection({ tableIds: [table.id], noteIds: [], relationshipId: null });
    toast(added ? 'success' : 'info', added ? `Linked ${added} source table${added === 1 ? '' : 's'} to the view.` : found.length ? 'Every table in the SELECT is already linked.' : 'No table names from the diagram were found in the SELECT.');
  };

  const materialized = table.materialized === true;
  // PostgreSQL is the only dialect here with materialized views; the checkbox
  // stays visible on the others so the flag is not silently lost when a diagram
  // is switched over and back, but it says what the script will actually say.
  const supportsMaterialized = diagram.dialect === 'postgresql';
  const engine = diagram.dialect === 'mariadb' ? 'MariaDB' : 'SQLite';

  return (
    <>
      <div className="field">
        <span className="field__label">View definition (SELECT …)</span>
        <textarea
          className="textarea textarea--mono"
          rows={8}
          value={table.viewSql ?? ''}
          onChange={(e) => updateTable(table.id, { viewSql: e.target.value })}
          placeholder={`SELECT o.id, c.email\nFROM orders o\nJOIN customers c ON c.id = o.customer_id`}
          spellCheck={false}
        />
        <span className="field__hint">
          Written into the script as {materialized && supportsMaterialized ? 'CREATE MATERIALIZED VIEW' : 'CREATE VIEW'} after every table. Columns below are
          optional and only affect how the node is drawn.
        </span>
      </div>
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={materialized} onChange={(e) => updateTable(table.id, { materialized: e.target.checked || undefined })} />
          <span>
            <Database size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            Materialized (store the rows, refresh on demand)
          </span>
        </label>
        <div className="field__hint">
          {materialized
            ? supportsMaterialized
              ? 'Rows are stored and only change on REFRESH MATERIALIZED VIEW: reads are as cheap as a table, at the cost of showing the data as of the last refresh.'
              : `${engine} has no materialized views, so the script falls back to a plain CREATE VIEW and the rows are recomputed on every query. The setting is kept for when you switch back to PostgreSQL.`
            : 'Off: the SELECT runs afresh on every query, so results are always current.'}
        </div>
      </div>
      <div className="field">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="field__label">Source tables ({sources.length})</span>
          <button className="btn btn--sm" onClick={detect} disabled={!table.viewSql?.trim()} title="Find diagram tables named in the SELECT and link them">
            <ScanSearch /> Detect from SQL
          </button>
        </div>
        {sources.length === 0 && <div className="faint small">No sources linked yet. Drag another table's orange header handle onto this view, or detect them from the SQL.</div>}
        <div className="chip-list">
          {sources.map((s) => (
            <button
              key={s.id}
              className="chip chip--on"
              onClick={() => {
                setSelection({ tableIds: [s.id], noteIds: [], relationshipId: null });
                focusTable(s.id);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
