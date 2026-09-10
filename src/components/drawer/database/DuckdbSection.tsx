import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, RotateCcw } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { getDuckdbEngine, type DuckdbEngine } from '@/lib/duckdb/engine';
import { downloadBlob } from '@/lib/io';
import { confirmDialog } from '../../ui/Modal';
import '@/styles/sqlite.css';

interface Status {
  version: string;
  tables: number;
  storage: 'opfs' | 'memory';
  note?: string;
}

/** The in-browser DuckDB database: status, new / open / download. Shown when the connection engine is DuckDB. */
export function DuckdbSection() {
  const toast = useStore((s) => s.toast);
  const [engine, setEngine] = useState<DuckdbEngine | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    getDuckdbEngine()
      .then(async (e) => {
        if (!alive) return;
        setEngine(e);
        const refresh = async () => setStatus({ version: await e.version(), tables: await e.tableCount(), storage: e.storage, note: e.storageNote });
        await refresh();
        unsubscribe = e.subscribe(() => void refresh());
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const reset = async () => {
    if (!engine) return;
    const ok = await confirmDialog({ title: 'Start an empty database?', message: 'Every table and row in the in-browser database will be dropped. The diagram is not affected.', confirmLabel: 'New database', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await engine.reset();
      toast('success', 'Started an empty DuckDB database.');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !engine) return;
    setBusy(true);
    try {
      await engine.load(new Uint8Array(await f.arrayBuffer()));
      toast('success', `Opened ${f.name}. Use "Read schema" below to pull its tables into the diagram.`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That file is not a DuckDB database.');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!engine) return;
    try {
      const bytes = await engine.exportBytes();
      downloadBlob('database.duckdb', new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    }
  };

  const persistent = status?.storage === 'opfs';

  return (
    <div className="sqlite-card">
      <div className="sqlite-card__status">
        {error ? (
          <span className="danger small">{error}</span>
        ) : status ? (
          <>
            <span className="badge badge--success">DuckDB {status.version}</span>
            <span className="small muted">
              {status.tables} table{status.tables === 1 ? '' : 's'} · {persistent ? 'runs inside this browser tab and is kept between reloads' : 'runs inside this browser tab, in memory only'}
            </span>
          </>
        ) : (
          <span className="small muted">Loading the DuckDB engine (a large download the first time)…</span>
        )}
      </div>
      {status?.note && <div className="small warn">{status.note}</div>}
      <div className="row row--wrap" style={{ gap: 6 }}>
        <button className="btn btn--sm" onClick={reset} disabled={!engine || busy} title="Drop everything and start empty">
          <RotateCcw /> New database
        </button>
        <button className="btn btn--sm" onClick={() => fileInput.current?.click()} disabled={!engine || busy} title="Load a .duckdb file into the browser">
          <FolderOpen /> Open .duckdb file…
        </button>
        <button
          className="btn btn--sm"
          onClick={download}
          disabled={!engine || busy || !persistent}
          title={persistent ? 'Save the database as a .duckdb file' : 'The in-memory database cannot be saved as a file in this browser'}
        >
          <Download /> Download .duckdb
        </button>
        <input ref={fileInput} type="file" accept=".duckdb,.db,application/octet-stream" hidden onChange={onFile} />
      </div>
      <div className="field__hint">
        No Docker or server needed: create the schema, seed rows and run queries right here. Extensions a script loads (json, spatial…) are fetched from
        extensions.duckdb.org on first use. Switch the diagram dialect to DuckDB to generate matching DDL.
      </div>
    </div>
  );
}
