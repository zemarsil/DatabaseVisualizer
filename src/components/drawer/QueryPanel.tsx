import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ClipboardCopy, Play, Settings2 } from 'lucide-react';
import type { QueryResult } from '@shared/types';
import { dialectLabel, isServerDialect } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useConnection } from '@/store/useConnection';
import { backendFor } from '@/lib/backend';
import { buildJoinQuery } from '@/lib/trace';
import { generateFlowSql } from '@/lib/sql/generator';
import { loadHistory, pushHistory, type HistoryEntry } from '@/lib/queryHistory';
import '@/styles/query.css';

const DRAFT_KEY = 'dbviz:queryDraft';

function loadDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function QueryPanel() {
  const diagram = useStore((s) => s.diagram);
  const traceResult = useStore((s) => s.trace.result);
  const openDrawer = useStore((s) => s.openDrawer);
  const toast = useStore((s) => s.toast);
  const conn = useConnection((s) => s.conn);
  const pending = useUi((s) => s.pendingQuery);
  const clearPending = useUi((s) => s.clearPendingQuery);

  const [sql, setSql] = useState(loadDraft);
  const [allowWrites, setAllowWrites] = useState(false);
  const [maxRows, setMaxRows] = useState(500);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const editor = useRef<HTMLTextAreaElement>(null);

  const backend = useMemo(() => backendFor(conn), [conn]);
  const isSqlite = !isServerDialect(conn.dialect);
  const mismatch = conn.dialect !== diagram.dialect;

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, sql);
    } catch {
      /* ignore */
    }
  }, [sql]);

  const run = useCallback(
    async (text?: string) => {
      const el = editor.current;
      const selected = el && el.selectionStart !== el.selectionEnd ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
      const toRun = (text ?? (selected || sql)).trim();
      if (!toRun) return;
      setRunning(true);
      setError(null);
      try {
        const res = await backend.query(toRun, { maxRows, allowWrites });
        setResult(res);
        setHistory(pushHistory(toRun));
      } catch (e) {
        setResult(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
      }
    },
    [backend, sql, maxRows, allowWrites],
  );

  // "Run" buttons elsewhere hand their SQL over through useUi.pendingQuery.
  useEffect(() => {
    if (!pending) return;
    setSql(pending.sql);
    const shouldRun = pending.run;
    const text = pending.sql;
    clearPending();
    if (shouldRun) void run(text);
  }, [pending, clearPending, run]);

  const snippets = useMemo(() => {
    const name = (id: string) => diagram.tables.find((t) => t.id === id)?.name ?? '?';
    const out: { label: string; sql: string }[] = [];
    if (traceResult) out.push({ label: `Trace: ${traceResult.from.name} → ${traceResult.to.name}`, sql: buildJoinQuery(diagram, traceResult) });
    for (const r of diagram.relationships) {
      if (r.query?.trim()) out.push({ label: `${name(r.sourceTableId)} → ${name(r.targetTableId)}${r.name ? ` (${r.name})` : ''}`, sql: r.query.trim() });
      if (r.kind === 'flow') {
        const generated = generateFlowSql(diagram, r.id);
        if (generated) out.push({ label: `Derived: ${name(r.sourceTableId)} → ${name(r.targetTableId)}`, sql: generated });
      }
    }
    for (const t of diagram.tables) out.push({ label: `SELECT * FROM ${t.name}`, sql: `SELECT * FROM ${t.name} LIMIT 100;` });
    return out;
  }, [diagram, traceResult]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart, selectionEnd, value } = el;
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      setSql(next);
      requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2));
    }
  };

  const copyCsv = () => {
    if (!result) return;
    const lines = [result.columns.map(csvCell).join(','), ...result.rows.map((r) => r.map(csvCell).join(','))];
    void navigator.clipboard.writeText(lines.join('\n'));
    toast('success', 'Copied as CSV.');
  };
  const copyJson = () => {
    if (!result) return;
    const objects = result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])));
    void navigator.clipboard.writeText(JSON.stringify(objects, null, 2));
    toast('success', 'Copied as JSON.');
  };

  const isWrite = result && result.columns.length === 0;

  return (
    <div className="drawer__split query">
      <div className="drawer__col query__editor">
        <div className="drawer__toolbar" style={{ flexWrap: 'wrap' }}>
          <span className="badge" title="Queries run against this connection">
            {backend.label}
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => openDrawer('database')} title="Change the connection in the Database tab">
            <Settings2 /> change
          </button>
          {mismatch && (
            <span className="badge badge--warn" title="The diagram's dialect differs from the connection">
              <AlertTriangle size={12} /> diagram is {dialectLabel(diagram.dialect)}
            </span>
          )}
          <span className="grow" />
          {isSqlite ? (
            <span className="small muted">Writes commit immediately</span>
          ) : (
            <label className="checkbox small" title="Without this, only SELECT-style statements run, inside a transaction that is rolled back">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} /> Allow writes
            </label>
          )}
          <label className="checkbox small">
            Max rows
            <input className="input input--sm" style={{ width: 70, marginLeft: 4 }} type="number" min={1} max={5000} value={maxRows} onChange={(e) => setMaxRows(Math.max(1, Number(e.target.value) || 500))} />
          </label>
          <button className="btn btn--sm btn--primary" onClick={() => void run()} disabled={running || !sql.trim()} title="Ctrl+Enter">
            <Play /> {running ? 'Running…' : 'Run'} <span className="kbd">Ctrl ↵</span>
          </button>
        </div>
        <div className="row" style={{ marginBottom: 6, gap: 6 }}>
          <select
            className="select select--sm grow"
            value=""
            onChange={(e) => {
              const s = snippets[Number(e.target.value)];
              if (s) setSql(s.sql);
            }}
          >
            <option value="">Insert a tagged query or snippet…</option>
            {snippets.map((s, i) => (
              <option key={i} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            className="select select--sm grow"
            value=""
            onChange={(e) => {
              const h = history[Number(e.target.value)];
              if (h) setSql(h.sql);
            }}
            disabled={history.length === 0}
          >
            <option value="">{history.length ? 'History…' : 'No history yet'}</option>
            {history.map((h, i) => (
              <option key={h.at} value={i}>
                {h.sql.replace(/\s+/g, ' ').slice(0, 80)}
              </option>
            ))}
          </select>
        </div>
        <textarea
          ref={editor}
          className="textarea textarea--mono grow query__textarea"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`SELECT * FROM ${diagram.tables[0]?.name ?? 'table'} LIMIT 100;\n\nSelect part of the text to run only that part. Ctrl+Enter runs.`}
          spellCheck={false}
        />
      </div>
      <div className="drawer__col query__results">
        {running && <div className="small muted">Running…</div>}
        {error && (
          <div className="query__error">
            <AlertTriangle size={14} /> {error}
          </div>
        )}
        {result && !running && (
          <>
            <div className="row row--wrap query__stats">
              {isWrite ? (
                <span className="small">
                  {result.rowCount} row{result.rowCount === 1 ? '' : 's'} affected
                </span>
              ) : (
                <span className="small">
                  {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                </span>
              )}
              <span className="small muted">· {result.durationMs} ms</span>
              {result.command && <span className="small muted">· {result.command}</span>}
              {result.truncated && (
                <span className="badge badge--warn">
                  <AlertTriangle size={12} /> truncated to {maxRows} rows
                </span>
              )}
              <span className="grow" />
              {!isWrite && (
                <>
                  <button className="btn btn--sm btn--ghost" onClick={copyCsv}>
                    <ClipboardCopy /> CSV
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={copyJson}>
                    <ClipboardCopy /> JSON
                  </button>
                </>
              )}
            </div>
            {!isWrite && (
              <div className="query__grid">
                <table>
                  <thead>
                    <tr>
                      <th className="query__rownum">#</th>
                      {result.columns.map((c, i) => (
                        <th key={i}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, ri) => (
                      <tr key={ri}>
                        <td className="query__rownum">{ri + 1}</td>
                        {row.map((v, ci) => {
                          const text = v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);
                          return (
                            <td key={ci} title={text ?? 'NULL'}>
                              {text === null ? <span className="query__null">NULL</span> : text.length > 120 ? `${text.slice(0, 120)}…` : text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {result.rows.length === 0 && (
                      <tr>
                        <td colSpan={result.columns.length + 1} className="muted small" style={{ textAlign: 'center' }}>
                          No rows.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {!result && !error && !running && (
          <div className="small muted">
            Results appear here. Queries run read-only inside a transaction unless you allow writes; the in-browser SQLite database commits directly.
          </div>
        )}
      </div>
    </div>
  );
}
