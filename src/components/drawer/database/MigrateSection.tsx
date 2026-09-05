import { useEffect, useMemo, useState } from 'react';
import { ClipboardCopy, Download, GitCompareArrows, Play, RefreshCw } from 'lucide-react';
import { dialectLabel, type StatementResult } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { backendFor } from '@/lib/backend';
import { downloadText, fileSlug } from '@/lib/io';
import { diffDiagramAgainst, summarizeChanges, type Change, type SchemaSnapshot } from '@/lib/migrate/diff';
import { generateMigration } from '@/lib/migrate/alter';
import { confirmDialog } from '../../ui/Modal';
import '@/styles/migrate.css';

interface Comparison {
  changes: Change[];
  current: SchemaSnapshot;
  label: string;
  /** The diagram object the comparison was made against; a different one means it is stale. */
  diagramRef: unknown;
}

const RISK_BADGE: Record<Change['risk'], { className: string; text: string }> = {
  safe: { className: 'badge--muted', text: 'safe' },
  risky: { className: 'badge--warn', text: 'check' },
  destructive: { className: 'badge--danger', text: 'data loss' },
};

/** Diagram vs. database diff and the ALTER script that closes the gap. */
export function MigrateSection() {
  const diagram = useStore((s) => s.diagram);
  const setDialect = useStore((s) => s.setDialect);
  const toast = useStore((s) => s.toast);
  const conn = useConnection((s) => s.conn);
  const backend = useMemo(() => backendFor(conn), [conn]);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'compare' | 'run' | null>(null);
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [stopOnError, setStopOnError] = useState(true);
  const [showScript, setShowScript] = useState(false);

  const stale = cmp !== null && cmp.diagramRef !== diagram;
  useEffect(() => {
    if (cmp && cmp.label !== backend.label) setCmp(null);
  }, [backend.label, cmp]);

  const compare = async () => {
    if (conn.dialect !== diagram.dialect) {
      const ok = await confirmDialog({
        title: 'Dialect mismatch',
        message: `The diagram is ${dialectLabel(diagram.dialect)} but the connection is ${dialectLabel(conn.dialect)}. Switch the diagram dialect (types will be translated) and compare?`,
        confirmLabel: `Switch to ${dialectLabel(conn.dialect)}`,
      });
      if (!ok) return;
      setDialect(conn.dialect, true);
      toast('info', 'Dialect switched; compare again.');
      return;
    }
    setBusy('compare');
    setResults(null);
    try {
      const res = await backend.introspect();
      const { changes, current } = diffDiagramAgainst(diagram, res);
      setCmp({ changes, current, label: backend.label, diagramRef: diagram });
      setSelected(new Set(changes.filter((c) => c.defaultOn).map((c) => c.id)));
      if (changes.length === 0) toast('success', 'The database already matches the diagram.');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const migration = useMemo(() => (cmp ? generateMigration(diagram, cmp.changes.filter((c) => selected.has(c.id)), cmp.current) : null), [cmp, selected, diagram]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectRisk = (risks: Change['risk'][]) => cmp && setSelected(new Set(cmp.changes.filter((c) => risks.includes(c.risk) && !c.uncertain).map((c) => c.id)));

  const copy = () => {
    if (!migration) return;
    void navigator.clipboard.writeText(migration.script);
    toast('success', 'Migration script copied.');
  };
  const download = () => migration && downloadText(`${fileSlug(diagram.name)}-migration.sql`, migration.script, 'text/sql');

  const run = async () => {
    if (!migration || !cmp) return;
    const destructive = cmp.changes.filter((c) => selected.has(c.id) && c.risk === 'destructive').length;
    const ok = await confirmDialog({
      title: `Run ${migration.statements.length} statements on ${backend.label}?`,
      message: (
        <div className="stack">
          <span>
            {selected.size} change{selected.size === 1 ? '' : 's'}
            {destructive ? `, ${destructive} of them destructive (rows or columns are dropped)` : ''}.
          </span>
          {migration.warnings.length > 0 && <span className="warn">{migration.warnings.join(' ')}</span>}
          {stopOnError && conn.dialect !== 'mariadb' && <span className="muted small">Runs inside one transaction: on failure nothing is kept.</span>}
          {conn.dialect === 'mariadb' && <span className="muted small">MariaDB commits DDL immediately, so statements before a failure stay applied.</span>}
        </div>
      ),
      confirmLabel: destructive ? 'Run, dropping data' : 'Run migration',
      danger: destructive > 0,
    });
    if (!ok) return;
    setBusy('run');
    try {
      const res = await backend.apply(migration.statements, stopOnError);
      setResults(res.results);
      const failed = res.results.filter((r) => !r.ok).length;
      if (res.ok) toast('success', `Migration applied: ${res.results.length} statements ran.`);
      else toast('error', `${failed} statement(s) failed. See the results list.`);
      // Re-compare so the list reflects what is left.
      const after = await backend.introspect();
      const { changes, current } = diffDiagramAgainst(diagram, after);
      setCmp({ changes, current, label: backend.label, diagramRef: diagram });
      setSelected(new Set(changes.filter((c) => c.defaultOn).map((c) => c.id)));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => {
    if (!cmp) return [];
    const map = new Map<string, Change[]>();
    for (const c of cmp.changes) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group)!.push(c);
    }
    return [...map.entries()];
  }, [cmp]);
  const summary = cmp ? summarizeChanges(cmp.changes) : null;

  return (
    <>
      <h3>Migrate</h3>
      <div className="row row--wrap" style={{ marginBottom: 8 }}>
        <span className="small muted grow">Compare the diagram with the connected database and write the ALTER statements that bring it up to date.</span>
        <button className="btn" onClick={() => void compare()} disabled={busy !== null || diagram.tables.length === 0}>
          {cmp ? <RefreshCw /> : <GitCompareArrows />} {busy === 'compare' ? 'Comparing…' : cmp ? 'Compare again' : 'Compare with database'}
        </button>
      </div>
      {cmp && summary && (
        <>
          {stale && <div className="warn small" style={{ marginBottom: 6 }}>The diagram changed since this comparison; compare again before running.</div>}
          {cmp.changes.length === 0 ? (
            <div className="small success" style={{ marginBottom: 8 }}>Up to date: {cmp.label} matches the diagram.</div>
          ) : (
            <>
              <div className="row row--wrap small" style={{ marginBottom: 6 }}>
                <span className="muted">
                  {cmp.changes.length} change{cmp.changes.length === 1 ? '' : 's'}: {summary.safe} safe, {summary.risky} to check, {summary.destructive} destructive
                </span>
                <span className="grow" />
                <span className="muted">Select:</span>
                <button className="btn btn--sm btn--ghost" onClick={() => selectRisk(['safe'])} title="Only changes that cannot lose data">
                  safe
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => selectRisk(['safe', 'risky'])} title="Everything except drops">
                  non-destructive
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => selectRisk(['safe', 'risky', 'destructive'])} title="Every change, including drops">
                  all
                </button>
              </div>
              <div className="migrate-list">
                {groups.map(([group, changes]) => (
                  <div key={group}>
                    <div className="migrate-group">{group.startsWith('type:') ? `type ${group.slice(5)}` : group}</div>
                    {changes.map((c) => {
                      const badge = RISK_BADGE[c.risk];
                      return (
                        <label key={c.id} className="migrate-row" title={c.detail}>
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                          <span className="migrate-row__label">{c.label}</span>
                          {c.detail && <span className="migrate-row__detail">{c.detail}</span>}
                          <span className={`badge ${c.uncertain ? 'badge--warn' : badge.className}`}>{c.uncertain ? 'unsure' : badge.text}</span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
              {migration && migration.warnings.length > 0 && (
                <ul className="warn-list">
                  {migration.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {migration && showScript && <pre className="code-block script-preview">{migration.script}</pre>}
              <div className="row row--wrap" style={{ marginBottom: 8 }}>
                <label className="checkbox small">
                  <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> Stop on first error
                </label>
                <button className="btn btn--sm btn--ghost" onClick={() => setShowScript((v) => !v)}>
                  {showScript ? 'Hide script' : 'Show script'}
                </button>
                <span className="grow" />
                <button className="btn btn--sm" onClick={copy} disabled={!migration || migration.statements.length === 0}>
                  <ClipboardCopy /> Copy
                </button>
                <button className="btn btn--sm" onClick={download} disabled={!migration || migration.statements.length === 0}>
                  <Download /> .sql
                </button>
                <button className="btn btn--primary" onClick={() => void run()} disabled={busy !== null || stale || !migration || migration.statements.length === 0}>
                  <Play /> {busy === 'run' ? 'Running…' : `Run ${migration?.statements.length ?? 0} statements`}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {results && (
        <div className="result-box">
          {results.map((r) => (
            <div key={r.index} className="result-row">
              <span className={r.ok ? 'success' : 'danger'}>{r.ok ? '✓' : '✖'}</span>
              <span className="result-row__sql">{r.sql}</span>
              <span className="faint">{r.durationMs} ms</span>
              {r.error && <span className="result-row__err">{r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
