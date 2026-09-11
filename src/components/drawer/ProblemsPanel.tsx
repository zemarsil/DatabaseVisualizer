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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function ProblemsPanel() {
  const diagram = useStore((s) => s.diagram);
  const mutate = useStore((s) => s.mutate);
  const toast = useStore((s) => s.toast);
  const selectTable = useStore((s) => s.selectTable);
  const focusTable = useStore((s) => s.focusTable);
  const openDrawer = useStore((s) => s.openDrawer);
  const focusRelationship = useStore((s) => s.focusRelationship);
  const setSelection = useStore((s) => s.setSelection);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const addRelationship = useStore((s) => s.addRelationship);

  const [severity, setSeverity] = useState<LintSeverity | 'all'>('all');
  const [filter, setFilter] = useState('');

  const findings = useMemo(() => lintDiagram(diagram), [diagram]);
  const suggestions = useMemo(() => suggestForeignKeys(diagram), [diagram]);
  const counts = useMemo(() => summarizeFindings(findings), [findings]);
  const tableName = (id: string | undefined) => diagram.tables.find((t) => t.id === id)?.name;
  const columnName = (tableId: string | undefined, columnId: string | undefined) => diagram.tables.find((t) => t.id === tableId)?.columns.find((c) => c.id === columnId)?.name;
  const programName = (programId: string | undefined) => diagram.programs.find((p) => p.id === programId)?.name;
  const extensionName = (id: string) => diagram.extensions.find((e) => e.id === id)?.name;

  // Recognize any table name mentioned inside a finding's message text so it can be turned into a "go to table" link.
  const tableNameLookup = useMemo(() => {
    const named = diagram.tables.filter((t) => t.name.trim());
    const byName = new Map(named.map((t) => [t.name, t.id]));
    const pattern = [...byName.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    return { byName, regex: pattern ? new RegExp(`\\b(${pattern})\\b`, 'g') : null };
  }, [diagram.tables]);

  const goToTable = (id: string) => {
    selectTable(id);
    focusTable(id);
  };

  const renderMessage = (message: string) => {
    const { regex, byName } = tableNameLookup;
    if (!regex) return message;
    regex.lastIndex = 0;
    const parts: React.ReactNode[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = regex.exec(message))) {
      const name = match[1];
      const id = byName.get(name)!;
      if (match.index > last) parts.push(message.slice(last, match.index));
      parts.push(
        <button key={key++} type="button" className="table-link" onClick={() => goToTable(id)} title={`Go to ${name}`}>
          {name}
        </button>,
      );
      last = match.index + name.length;
    }
    if (last < message.length) parts.push(message.slice(last));
    return parts;
  };

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
      focusRelationship(f.relationshipId);
      return;
    }
    if (f.tableId) goToTable(f.tableId);
  };

  /** A program finding is fixed in the inspector, so the chip selects the node. */
  const goToProgram = (programId: string) => {
    setSelection({ ...emptySelection(), programIds: [programId] });
    setInspectorOpen(true);
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
                      <div className="problem__message">{renderMessage(f.message)}</div>
                      <div className="row row--wrap" style={{ gap: 6, marginTop: 4 }}>
                        {(f.tableId || f.relationshipId) && (
                          <button className="chip" onClick={() => goTo(f)} title="Show on the canvas">
                            {f.tableId ? `${tableName(f.tableId) ?? '?'}${columnName(f.tableId, f.columnId) ? `.${columnName(f.tableId, f.columnId)}` : ''}` : 'connection'}
                          </button>
                        )}
                        {f.programId && (
                          <button className="chip" onClick={() => goToProgram(f.programId!)} title="Open the program in the inspector">
                            {programName(f.programId) ?? 'program'}
                          </button>
                        )}
                        {/* An extension is not on the canvas, so its chip opens where it is edited. */}
                        {f.extensionId && !f.tableId && (
                          <button className="chip" onClick={() => openDrawer('types')} title="Open the extensions list">
                            {extensionName(f.extensionId) ?? 'extension'}
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
