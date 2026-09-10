import { useMemo, useState } from 'react';
import { ClipboardCopy, Dices, Download, Play } from 'lucide-react';
import { dialectLabel, type StatementResult } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { backendFor } from '@/lib/backend';
import { downloadText, fileSlug } from '@/lib/io';
import { generateSeed } from '@/lib/seed';
import { confirmDialog } from '../../ui/Modal';
import { SqlCode } from '../../ui/SqlEditor';
import '@/styles/migrate.css';

/** Deterministic sample rows for every table, respecting keys, uniqueness and enums. */
export function SeedSection() {
  const diagram = useStore((s) => s.diagram);
  const toast = useStore((s) => s.toast);
  const conn = useConnection((s) => s.conn);
  const backend = useMemo(() => backendFor(conn), [conn]);
  const [rows, setRows] = useState(10);
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [showScript, setShowScript] = useState(false);

  const result = useMemo(() => generateSeed(diagram, { rows, seed }), [diagram, rows, seed]);
  const tableCount = Object.keys(result.rowCounts).length;
  const mismatch = conn.dialect !== diagram.dialect;

  const copy = () => {
    void navigator.clipboard.writeText(result.script);
    toast('success', 'Seed script copied.');
  };
  const download = () => downloadText(`${fileSlug(diagram.name)}-seed.sql`, result.script, 'text/sql');

  const run = async () => {
    const ok = await confirmDialog({
      title: `Insert ${result.totalRows} rows into ${backend.label}?`,
      message: (
        <div className="stack">
          <span>
            {result.statements.length} INSERT statement{result.statements.length === 1 ? '' : 's'} across {tableCount} table{tableCount === 1 ? '' : 's'}. The script assumes the tables exist and are empty: ids start at 1.
          </span>
          {result.warnings.length > 0 && <span className="warn">{result.warnings.join(' ')}</span>}
          {conn.dialect !== 'mariadb' && <span className="muted small">Runs inside one transaction: on failure nothing is kept.</span>}
        </div>
      ),
      confirmLabel: 'Insert rows',
    });
    if (!ok) return;
    setBusy(true);
    setResults(null);
    try {
      const res = await backend.apply(result.statements, true);
      setResults(res.results);
      if (res.ok) toast('success', `Inserted ${result.totalRows} rows.`);
      else toast('error', `${res.results.filter((r) => !r.ok).length} statement(s) failed. See the results list.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Seed data</h3>
      <div className="row row--wrap" style={{ marginBottom: 8 }}>
        <label className="row small" style={{ gap: 6 }}>
          Rows per table
          <input className="input input--sm" type="number" min={0} max={5000} value={rows} onChange={(e) => setRows(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))} style={{ width: 70 }} />
        </label>
        <label className="row small" style={{ gap: 6 }}>
          Seed
          <input className="input input--sm" type="number" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Number(e.target.value) || 0))} style={{ width: 90 }} />
        </label>
        <button className="btn btn--sm" onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))} title="Pick another seed for different rows">
          <Dices /> Reshuffle
        </button>
        <span className="grow" />
        <span className="small muted">
          {result.totalRows} row{result.totalRows === 1 ? '' : 's'} across {tableCount} table{tableCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="field__hint" style={{ marginBottom: 6 }}>
        Foreign keys point at generated parent rows, unique columns never repeat, enums and CHECK lists are honoured, and column names steer the content (email, price, created_at…). The same seed always produces the same rows.
      </div>
      {result.warnings.length > 0 && (
        <ul className="warn-list">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {showScript && <SqlCode sql={result.script} className="script-preview" />}
      <div className="row row--wrap" style={{ marginBottom: 8 }}>
        <button className="btn btn--sm btn--ghost" onClick={() => setShowScript((v) => !v)} disabled={result.totalRows === 0}>
          {showScript ? 'Hide script' : 'Show script'}
        </button>
        <span className="grow" />
        <button className="btn btn--sm" onClick={copy} disabled={result.totalRows === 0}>
          <ClipboardCopy /> Copy
        </button>
        <button className="btn btn--sm" onClick={download} disabled={result.totalRows === 0}>
          <Download /> .sql
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={busy || result.totalRows === 0 || mismatch}
          title={mismatch ? `The script is written for ${dialectLabel(diagram.dialect)}; switch the diagram dialect to ${dialectLabel(conn.dialect)} first.` : undefined}
        >
          <Play /> {busy ? 'Inserting…' : 'Insert rows'}
        </button>
      </div>
      {mismatch && <div className="warn small" style={{ marginBottom: 8 }}>The script is written for {dialectLabel(diagram.dialect)} but the connection is {dialectLabel(conn.dialect)}. Switch the diagram dialect in the top bar to run it.</div>}
      {results && (
        <div className="result-box">
          {results.map((r) => (
            <div key={r.index} className="result-row">
              <span className={r.ok ? 'success' : 'danger'}>{r.ok ? '✓' : '✖'}</span>
              <span className="result-row__sql">{r.sql.split('\n')[0]}</span>
              <span className="faint">{r.durationMs} ms</span>
              {r.error && <span className="result-row__err">{r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
