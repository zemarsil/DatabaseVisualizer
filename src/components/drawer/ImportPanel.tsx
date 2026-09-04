import { useRef, useState } from 'react';
import { FileUp, Play, Search } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { importSql, type ImportResult } from '@/lib/sql/import';
import { DIALECTS } from '@shared/types';

const PLACEHOLDER = `-- Paste CREATE TABLE statements (pg_dump / mysqldump output works too)
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL
);

CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  title TEXT NOT NULL
);`;

export function ImportPanel() {
  const diagram = useStore((s) => s.diagram);
  const importTables = useStore((s) => s.importTables);
  const toast = useStore((s) => s.toast);
  const [sql, setSql] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>(diagram.tables.length ? 'merge' : 'replace');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;

  const run = (apply: boolean) => {
    const res = importSql(sql, diagram.dialect, mode === 'merge' ? diagram : null);
    setPreview(res);
    if (!apply) return;
    if (res.tables.length === 0) {
      toast('error', res.errors.length ? 'Nothing imported: fix the errors below.' : 'No CREATE TABLE statements found.');
      return;
    }
    importTables(res.tables, res.relationships, mode);
    toast('success', `Imported ${res.tables.length} table(s) and ${res.relationships.length} foreign key(s).`);
    setSql('');
    setPreview(null);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) setSql(await f.text());
  };

  return (
    <div className="drawer__split">
      <div className="drawer__col">
        <div className="drawer__toolbar">
          <span className="badge">{dialect} syntax</span>
          <span className="grow" />
          <button className="btn btn--sm" onClick={() => fileInput.current?.click()}>
            <FileUp /> Load .sql file
          </button>
          <input ref={fileInput} type="file" accept=".sql,.txt,text/plain" hidden onChange={onFile} />
        </div>
        <textarea className="textarea textarea--mono grow" style={{ resize: 'none', minHeight: 0 }} value={sql} onChange={(e) => setSql(e.target.value)} placeholder={PLACEHOLDER} spellCheck={false} />
      </div>
      <div className="drawer__col">
        <h3>Import</h3>
        <div className="field">
          <label className="checkbox">
            <input type="radio" name="import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Add to the current diagram
          </label>
          <label className="checkbox">
            <input type="radio" name="import-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace the current diagram
          </label>
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn--primary" onClick={() => run(true)} disabled={!sql.trim()}>
            <Play /> Import
          </button>
          <button className="btn" onClick={() => run(false)} disabled={!sql.trim()}>
            <Search /> Preview only
          </button>
        </div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Understands CREATE TABLE with column and table constraints, ALTER TABLE … ADD CONSTRAINT, CREATE INDEX, COMMENT ON and CREATE TYPE … AS ENUM. Other
          statements are skipped with a warning. Tables referenced but not defined get a placeholder.
        </div>
        {preview && (
          <div style={{ overflow: 'auto', minHeight: 0 }}>
            <div className="row row--wrap" style={{ marginBottom: 4 }}>
              <span className="badge badge--success">{preview.tables.length} tables</span>
              <span className="badge badge--accent">{preview.relationships.length} foreign keys</span>
              {preview.errors.length > 0 && <span className="badge badge--danger">{preview.errors.length} errors</span>}
              {preview.warnings.length > 0 && <span className="badge">{preview.warnings.length} warnings</span>}
            </div>
            {preview.tables.length > 0 && (
              <div className="chip-list" style={{ marginBottom: 6 }}>
                {preview.tables.map((t) => (
                  <span key={t.id} className="chip">
                    {t.name} <span className="faint">({t.columns.length})</span>
                  </span>
                ))}
              </div>
            )}
            <ul className="msg-list">
              {preview.errors.map((e, i) => (
                <li key={`e${i}`} className="danger">
                  ✖ {e}
                </li>
              ))}
              {preview.warnings.map((w, i) => (
                <li key={`w${i}`} className="warn">
                  ⚠ {w}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
