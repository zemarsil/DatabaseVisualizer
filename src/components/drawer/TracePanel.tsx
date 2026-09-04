import { useMemo } from 'react';
import { ArrowRight, Copy, Crosshair, Route, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { buildJoinQuery } from '@/lib/trace';

export function TracePanel() {
  const diagram = useStore((s) => s.diagram);
  const trace = useStore((s) => s.trace);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const runTrace = useStore((s) => s.runTrace);
  const clearTrace = useStore((s) => s.clearTrace);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const toast = useStore((s) => s.toast);

  const tables = useMemo(() => [...diagram.tables].sort((a, b) => a.name.localeCompare(b.name)), [diagram.tables]);
  const query = useMemo(() => (trace.result ? buildJoinQuery(diagram, trace.result) : ''), [diagram, trace.result]);
  const name = (id: string) => diagram.tables.find((t) => t.id === id)?.name ?? '?';
  const colName = (tableId: string, colId: string) => diagram.tables.find((t) => t.id === tableId)?.columns.find((c) => c.id === colId)?.name ?? '?';

  return (
    <div className="drawer__split">
      <div className="drawer__col">
        <h3>Trace a connection</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          <select className="select select--sm grow" value={trace.fromId ?? ''} onChange={(e) => setTraceEndpoints(e.target.value || null, trace.toId)}>
            <option value="">From table…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <ArrowRight size={14} className="faint" />
          <select className="select select--sm grow" value={trace.toId ?? ''} onChange={(e) => setTraceEndpoints(trace.fromId, e.target.value || null)}>
            <option value="">To table…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn--primary" onClick={runTrace} disabled={!trace.fromId || !trace.toId}>
            <Route /> Trace
          </button>
          <button className={`btn${trace.picking ? ' btn--active' : ''}`} onClick={() => setTracePicking(!trace.picking)}>
            <Crosshair /> {trace.picking ? 'Picking… (click two tables)' : 'Pick on canvas'}
          </button>
          <span className="grow" />
          <button className="btn btn--ghost" onClick={clearTrace} disabled={!trace.fromId && !trace.toId && !trace.result}>
            <X /> Clear
          </button>
        </div>
        <div className="small muted">
          Finds the shortest chain of foreign keys and data-flow links between two tables (direction is ignored). Tables and edges off the path are dimmed on
          the canvas until you clear the trace.
        </div>
        {trace.searched && !trace.result && trace.fromId && trace.toId && (
          <div className="badge badge--danger" style={{ marginTop: 10, height: 'auto', padding: '6px 10px' }}>
            No connection between {name(trace.fromId)} and {name(trace.toId)}.
          </div>
        )}
        {trace.result && (
          <div className="trace-path">
            {trace.result.tableIds.map((id, i) => (
              <span key={id} className="row" style={{ gap: 6 }}>
                {i > 0 && (
                  <span className="trace-path__hop" title={trace.result!.hops[i - 1].relationship.kind === 'fk' ? 'foreign key' : 'data flow'}>
                    <ArrowRight />
                  </span>
                )}
                <button
                  className="trace-path__table"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setSelection({ tableIds: [id], relationshipId: null, noteIds: [] });
                    focusTable(id);
                  }}
                >
                  {name(id)}
                </button>
              </span>
            ))}
          </div>
        )}
        {trace.result && trace.result.hops.length > 0 && (
          <ul className="msg-list" style={{ marginTop: 0 }}>
            {trace.result.hops.map((h, i) => {
              const r = h.relationship;
              const pairs = r.sourceColumnIds.map((sid, k) => `${name(r.sourceTableId)}.${colName(r.sourceTableId, sid)} = ${name(r.targetTableId)}.${colName(r.targetTableId, r.targetColumnIds[k])}`);
              return (
                <li key={i}>
                  <button className="chip" style={{ marginRight: 6 }} onClick={() => setSelection({ relationshipId: r.id, tableIds: [], noteIds: [] })}>
                    {r.kind === 'fk' ? 'FK' : 'flow'}
                  </button>
                  {r.kind === 'fk' ? pairs.join(' AND ') : `${h.from.name} → ${h.to.name}${r.name ? ` (${r.name})` : ''}`}
                  {r.query && <span className="badge badge--accent" style={{ marginLeft: 6 }}>tagged query</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="drawer__col">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Join along the path</h3>
          <span className="grow" />
          <button
            className="btn btn--sm"
            disabled={!query}
            onClick={() => {
              void navigator.clipboard.writeText(query);
              toast('success', 'Join query copied.');
            }}
          >
            <Copy /> Copy
          </button>
        </div>
        <pre className="code-block code-block--fill">{query || '-- Trace two tables to get a SELECT that joins every table on the path.'}</pre>
      </div>
    </div>
  );
}
