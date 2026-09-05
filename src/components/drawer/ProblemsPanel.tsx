import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Link2, Plus, Wand2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { emptySelection } from '@/lib/selection';
import { lintDiagram, summarizeFindings, type LintFinding, type LintSeverity } from '@/lib/lint';
import { suggestForeignKeys, type FkSuggestion } from '@/lib/suggest';
import '@/styles/problems.css';

const ICONS: Record<LintSeverity, React.ReactNode> = {
  error: <AlertCircle className="problem__icon problem__icon--error" />,
  warning: <AlertTriangle className="problem__icon problem__icon--warning" />,
  info: <Info className="problem__icon problem__icon--info" />,
};

const LABELS: Record<LintSeverity, string> = { error: 'Errors', warning: 'Warnings', info: 'Notes' };

export function ProblemsPanel() {
  const diagram = useStore((s) => s.diagram);
  const mutate = useStore((s) => s.mutate);
  const toast = useStore((s) => s.toast);
  const selectTable = useStore((s) => s.selectTable);
  const focusTable = useStore((s) => s.focusTable);
  const setSelection = useStore((s) => s.setSelection);
  const addRelationship = useStore((s) => s.addRelationship);

  const [severity, setSeverity] = useState<LintSeverity | 'all'>('all');
  const [filter, setFilter] = useState('');

  const findings = useMemo(() => lintDiagram(diagram), [diagram]);
  const suggestions = useMemo(() => suggestForeignKeys(diagram), [diagram]);
  const counts = useMemo(() => summarizeFindings(findings), [findings]);
  const tableName = (id: string | undefined) => diagram.tables.find((t) => t.id === id)?.name;
  const columnName = (tableId: string | undefined, columnId: string | undefined) => diagram.tables.find((t) => t.id === tableId)?.columns.find((c) => c.id === columnId)?.name;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return findings.filter((f) => (severity === 'all' || f.severity === severity) && (!q || f.message.toLowerCase().includes(q) || (tableName(f.tableId) ?? '').toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findings, severity, filter, diagram.tables]);

  const applyFix = (f: LintFinding) => {
    if (!f.fix) return;
    const fix = f.fix;
    mutate((d) => fix.apply(d));
    toast('success', `${fix.label}.`);
  };

  const fixAllSafe = () => {
    const safe = findings.filter((f) => f.fix?.safe);
    if (!safe.length) return;
    mutate((d) => {
      for (const f of safe) f.fix!.apply(d);
    });
    toast('success', `Applied ${safe.length} fix${safe.length === 1 ? '' : 'es'}.`);
  };

  const goTo = (f: LintFinding) => {
    if (f.relationshipId && !f.tableId) {
      setSelection({ ...emptySelection(), relationshipId: f.relationshipId });
      return;
    }
    if (f.tableId) {
      selectTable(f.tableId);
      focusTable(f.tableId);
    }
  };

  const addSuggestion = (s: FkSuggestion) => {
    addRelationship({ kind: 'fk', sourceTableId: s.sourceTableId, sourceColumnIds: [s.sourceColumnId], targetTableId: s.targetTableId, targetColumnIds: [s.targetColumnId] });
  };
  const addAllHigh = () => {
    const high = suggestions.filter((s) => s.confidence === 'high');
    for (const s of high) addSuggestion(s);
    toast('success', `Added ${high.length} foreign key${high.length === 1 ? '' : 's'}.`);
  };

  const safeCount = findings.filter((f) => f.fix?.safe).length;
  const grouped: LintSeverity[] = ['error', 'warning', 'info'];

  return (
    <div className="problems">
      <div className="drawer__toolbar">
        <span className={`badge${counts.errors ? ' badge--danger' : ''}`}>{counts.errors} errors</span>
        <span className={`badge${counts.warnings ? ' badge--warn' : ''}`}>{counts.warnings} warnings</span>
        <span className="badge">{counts.infos} notes</span>
        <select className="select select--sm" value={severity} onChange={(e) => setSeverity(e.target.value as LintSeverity | 'all')} title="Severity">
          <option value="all">All severities</option>
          <option value="error">Errors only</option>
          <option value="warning">Warnings only</option>
          <option value="info">Notes only</option>
        </select>
        <input className="input input--sm" style={{ width: 180 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="grow" />
        <button className="btn btn--sm" onClick={fixAllSafe} disabled={safeCount === 0} title="Apply every fix that only adds indexes, keys or types (no renames, no removals)">
          <Wand2 /> Fix all safe ({safeCount})
        </button>
      </div>
      <div className="drawer__split">
        <div className="drawer__col problems__list">
          <h3>Problems</h3>
          {visible.length === 0 && (
            <div className="problems__empty">
              <CheckCircle2 />
              <span>{findings.length === 0 ? 'No problems found. The schema is ready to run.' : 'Nothing matches the filter.'}</span>
            </div>
          )}
          {grouped.map((sev) => {
            const rows = visible.filter((f) => f.severity === sev);
            if (!rows.length) return null;
            return (
              <div key={sev} className="problems__group">
                <div className="problems__group-title">{LABELS[sev]}</div>
                {rows.map((f) => (
                  <div key={f.id} className="problem">
                    {ICONS[f.severity]}
                    <div className="problem__body">
                      <div className="problem__message">{f.message}</div>
                      <div className="row row--wrap" style={{ gap: 6, marginTop: 4 }}>
                        {(f.tableId || f.relationshipId) && (
                          <button className="chip" onClick={() => goTo(f)} title="Show on the canvas">
                            {f.tableId ? `${tableName(f.tableId) ?? '?'}${columnName(f.tableId, f.columnId) ? `.${columnName(f.tableId, f.columnId)}` : ''}` : 'connection'}
                          </button>
                        )}
                        {f.fix && (
                          <button className="btn btn--sm" onClick={() => applyFix(f)}>
                            <Wand2 /> {f.fix.label}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="drawer__col problems__list">
          <div className="row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Suggested foreign keys</h3>
            <span className="grow" />
            <button className="btn btn--sm" onClick={addAllHigh} disabled={!suggestions.some((s) => s.confidence === 'high')}>
              <Plus /> Add all likely
            </button>
          </div>
          {suggestions.length === 0 && (
            <div className="problems__empty">
              <CheckCircle2 />
              <span>No column names look like missing references.</span>
            </div>
          )}
          {suggestions.map((s) => (
            <div key={s.id} className="problem">
              <Link2 className="problem__icon problem__icon--suggest" />
              <div className="problem__body">
                <div className="problem__message">
                  <code>
                    {tableName(s.sourceTableId)}.{columnName(s.sourceTableId, s.sourceColumnId)}
                  </code>{' '}
                  →{' '}
                  <code>
                    {tableName(s.targetTableId)}.{columnName(s.targetTableId, s.targetColumnId)}
                  </code>
                </div>
                <div className="small muted">{s.reason}</div>
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  <span className={`badge${s.confidence === 'high' ? ' badge--success' : ''}`}>{s.confidence === 'high' ? 'likely' : 'possible'}</span>
                  <button className="btn btn--sm" onClick={() => addSuggestion(s)}>
                    <Plus /> Add foreign key
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div className="small faint" style={{ marginTop: 10 }}>
            Suggestions come from column names such as customer_id, ownerId or id_category matching a table with a single-column primary key.
          </div>
        </div>
      </div>
    </div>
  );
}
