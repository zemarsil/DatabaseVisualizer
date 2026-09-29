import { useMemo } from 'react';
import { ArrowRight, Copy, Crosshair, Play, Route, X } from 'lucide-react';
import { kindMeta } from '@shared/types';
import { selectDiagramContent, useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { codePath } from '@/lib/codemap';
import { flowDerivations } from '@/lib/derivation';
import { buildJoinQuery, describeHop, type PathHop } from '@/lib/trace';
import { diagramScope } from '@/lib/sqlScope';
import { SqlCode } from '../ui/SqlEditor';

export function TracePanel() {
  const diagram = useStore(selectDiagramContent);
  const trace = useStore((s) => s.trace);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const runTrace = useStore((s) => s.runTrace);
  const clearTrace = useStore((s) => s.clearTrace);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const toast = useStore((s) => s.toast);

  const tables = useMemo(() => [...diagram.tables].sort((a, b) => a.name.localeCompare(b.name)), [diagram.tables]);
  // Code nodes are listed by their path, so two methods called `save` can be told apart.
  const code = useMemo(() => diagram.programs.map((p) => ({ id: p.id, label: codePath(diagram, p) })).sort((a, b) => a.label.localeCompare(b.label)), [diagram]);
  const query = useMemo(() => (trace.result ? buildJoinQuery(diagram, trace.result) : ''), [diagram, trace.result]);
  const runsThroughCode = Boolean(trace.result?.hops.some((h) => !h.relationship));
  const name = (id: string) => diagram.tables.find((t) => t.id === id)?.name ?? diagram.programs.find((p) => p.id === id)?.name ?? '?';
  const colName = (tableId: string, colId: string) => diagram.tables.find((t) => t.id === tableId)?.columns.find((c) => c.id === colId)?.name ?? '?';
  const isCode = (id: string) => diagram.programs.some((p) => p.id === id);

  const jumpTo = (id: string) => {
    if (isCode(id)) setSelection({ programIds: [id], tableIds: [], relationshipId: null, noteIds: [] });
    else setSelection({ tableIds: [id], relationshipId: null, noteIds: [] });
    focusTable(id);
  };

  const endpointPicker = (value: string | null, onPick: (id: string | null) => void, placeholder: string) => (
    <select className="select select--sm grow" value={value ?? ''} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {code.length ? (
        <>
          <optgroup label="Tables">
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Code">
            {code.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
        </>
      ) : (
        tables.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))
      )}
    </select>
  );

  const renderHop = (h: PathHop, i: number) => {
    const r = h.relationship;
    if (r) {
      const pairs = r.sourceColumnIds.map((sid, k) => `${name(r.sourceTableId)}.${colName(r.sourceTableId, sid)} = ${name(r.targetTableId)}.${colName(r.targetTableId, r.targetColumnIds[k])}`);
      return (
        <li key={i}>
          <button className="chip" style={{ marginRight: 6 }} onClick={() => setSelection({ relationshipId: r.id, tableIds: [], noteIds: [] })}>
            {kindMeta(r.kind).short}
          </button>
          {r.kind === 'fk' ? pairs.join(' AND ') : describeHop(diagram, h)}
          {flowDerivations(r).length > 0 && (
            <span className="badge badge--flow" style={{ marginLeft: 6 }}>
              {flowDerivations(r).length} derived
            </span>
          )}
          {r.query && <span className="badge badge--accent" style={{ marginLeft: 6 }}>tagged query</span>}
        </li>
      );
    }
    // A hop through code is a step of the node that made it: the chip opens
    // that node in the inspector on the step in question.
    const link = h.link;
    const owner = link?.kind === 'table' ? link.link.programId : link?.kind === 'code' ? link.link.fromId : null;
    const stepId = link?.kind === 'table' ? link.link.stepId : link?.kind === 'code' ? link.link.stepId : null;
    const op = link?.kind === 'table' ? link.link.op : link?.kind === 'code' ? link.link.op : 'step';
    return (
      <li key={i}>
        <button
          className="chip"
          style={{ marginRight: 6 }}
          disabled={!owner}
          onClick={() => {
            if (!owner) return;
            setSelection({ programIds: [owner], tableIds: [], noteIds: [], relationshipId: null });
            useUi.getState().setActiveProgramStepId(stepId);
            useStore.getState().setInspectorOpen(true);
          }}
        >
          {op}
        </button>
        {describeHop(diagram, h)}
      </li>
    );
  };

  return (
    <div className="drawer__split">
      <div className="drawer__col">
        <h3>Trace a connection</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          {endpointPicker(trace.fromId, (id) => setTraceEndpoints(id, trace.toId), 'From…')}
          <ArrowRight size={14} className="faint" />
          {endpointPicker(trace.toId, (id) => setTraceEndpoints(trace.fromId, id), 'To…')}
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn--primary" onClick={runTrace} disabled={!trace.fromId || !trace.toId}>
            <Route /> Trace
          </button>
          <button className={`btn${trace.picking ? ' btn--active' : ''}`} onClick={() => setTracePicking(!trace.picking)}>
            <Crosshair /> {trace.picking ? 'Picking… (click two nodes)' : 'Pick on canvas'}
          </button>
          <span className="grow" />
          <button className="btn btn--ghost" onClick={clearTrace} disabled={!trace.fromId && !trace.toId && !trace.result}>
            <X /> Clear
          </button>
        </div>
        <div className="small muted">
          Finds the shortest chain of connections between two tables, two code nodes, or a table and the code that reaches it (direction is ignored). Only
          foreign keys become JOIN conditions; the other kinds, and every hop through code, are noted as comments. Everything off the path is dimmed on the
          canvas until you clear the trace.
        </div>
        {trace.searched && !trace.result && trace.fromId && trace.toId && (
          <div className="badge badge--danger" style={{ marginTop: 10, height: 'auto', padding: '6px 10px' }}>
            No connection between {name(trace.fromId)} and {name(trace.toId)}.
          </div>
        )}
        {trace.result && (
          <div className="trace-path">
            {trace.result.nodeIds.map((id, i) => (
              <span key={id} className="row" style={{ gap: 6 }}>
                {i > 0 && (
                  <span className="trace-path__hop" title={describeHop(diagram, trace.result!.hops[i - 1])}>
                    <ArrowRight />
                  </span>
                )}
                <button className={`trace-path__table${isCode(id) ? ' trace-path__code' : ''}`} style={{ cursor: 'pointer' }} onClick={() => jumpTo(id)}>
                  {name(id)}
                </button>
              </span>
            ))}
          </div>
        )}
        {trace.result && trace.result.hops.length > 0 && (
          <ul className="msg-list" style={{ marginTop: 0 }}>
            {trace.result.hops.map(renderHop)}
          </ul>
        )}
      </div>
      <div className="drawer__col">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{runsThroughCode ? 'The path, step by step' : 'Join along the path'}</h3>
          <span className="grow" />
          <button
            className="btn btn--sm"
            disabled={!query}
            onClick={() => {
              void navigator.clipboard.writeText(query);
              toast('success', runsThroughCode ? 'Path copied.' : 'Join query copied.');
            }}
          >
            <Copy /> Copy
          </button>
          <button
            className="btn btn--sm"
            disabled={!query || runsThroughCode}
            title={runsThroughCode ? 'A path through code is not a query' : 'Run the join in the Query tab'}
            onClick={() => {
              useUi.getState().setPendingQuery(query, true);
              useStore.getState().openDrawer('query');
            }}
          >
            <Play /> Run
          </button>
        </div>
        <SqlCode sql={query || '-- Trace two tables to get a SELECT that joins every table on the path, or a table and a function to see how the code reaches it.'} scope={diagramScope(diagram)} className="code-block--fill" />
      </div>
    </div>
  );
}
