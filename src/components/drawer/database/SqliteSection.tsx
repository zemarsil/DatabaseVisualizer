import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, RotateCcw } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { getSqliteEngine, type SqliteEngine } from '@/lib/sqlite/engine';
import { downloadBlob } from '@/lib/io';
import { confirmDialog } from '../../ui/Modal';
import '@/styles/sqlite.css';

interface Status {
  version: string;
  tables: number;
}

/** The in-browser SQLite database: status, new / open / download. Shown when the connection engine is SQLite. */
export function SqliteSection() {
  const toast = useStore((s) => s.toast);
  const [engine, setEngine] = useState<SqliteEngine | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    getSqliteEngine()
      .then(async (e) => {
        if (!alive) return;
        setEngine(e);
        const refresh = async () => setStatus({ version: await e.version(), tables: await e.tableCount() });
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
    await engine.reset();
    toast('success', 'Started an empty SQLite database.');
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !engine) return;
    try {
      await engine.load(new Uint8Array(await f.arrayBuffer()));
      toast('success', `Opened ${f.name}. Use "Read schema" below to pull its tables into the diagram.`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That file is not a SQLite database.');
    }
  };

  const download = async () => {
    if (!engine) return;
    const bytes = await engine.exportBytes();
    downloadBlob('database.sqlite', new Blob([bytes as BlobPart], { type: 'application/vnd.sqlite3' }));
  };

  return (
    <div className="sqlite-card">
      <div className="sqlite-card__status">
        {error ? (
          <span className="danger small">{error}</span>
        ) : status ? (
          <>
            <span className="badge badge--success">SQLite {status.version}</span>
            <span className="small muted">
              {status.tables} table{status.tables === 1 ? '' : 's'} · runs inside this browser tab and is kept between reloads
            </span>
          </>
        ) : (
          <span className="small muted">Loading the SQLite engine…</span>
        )}
      </div>
      <div className="row row--wrap" style={{ gap: 6 }}>
        <button className="btn btn--sm" onClick={reset} disabled={!engine} title="Drop everything and start empty">
          <RotateCcw /> New database
        </button>
        <button className="btn btn--sm" onClick={() => fileInput.current?.click()} disabled={!engine} title="Load a .sqlite / .db file into the browser">
          <FolderOpen /> Open .sqlite file…
        </button>
        <button className="btn btn--sm" onClick={download} disabled={!engine} title="Save the database as a file">
          <Download /> Download .sqlite
        </button>
        <input ref={fileInput} type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3,application/x-sqlite3" hidden onChange={onFile} />
      </div>
      <div className="field__hint">No Docker or server needed: create the schema, seed rows and run queries right here. Switch the diagram dialect to SQLite to generate matching DDL.</div>
    </div>
  );
}
