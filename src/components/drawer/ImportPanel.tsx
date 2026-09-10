import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Play } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { importSql, type ImportResult } from '@/lib/sql/import';
import { suggestForeignKeys } from '@/lib/suggest';
import { diagramScope } from '@/lib/sqlScope';
import { SqlEditor, type SqlEditorHandle } from '@/components/ui/SqlEditor';
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
  const [group, setGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupExternal, setGroupExternal] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<SqlEditorHandle>(null);
  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;
  const scope = useMemo(() => diagramScope(diagram), [diagram]);

  // The preview follows the text: a moment after the last keystroke it says what the import would do.
  useEffect(() => {
    if (!sql.trim()) {
      setPreview(null);
      return;
    }
    const id = setTimeout(() => setPreview(importSql(sql, diagram.dialect, mode === 'merge' ? diagram : null)), 400);
    return () => clearTimeout(id);
  }, [sql, mode, diagram]);

  /** A message's "line N:M:" prefix, so clicking it puts the caret there. */
  const jumpTo = (message: string) => {
    const m = /^line (\d+)(?::(\d+))?/.exec(message);
    if (m) editor.current?.goTo(Number(m[1]), m[2] ? Number(m[2]) : 1);
  };

  const run = () => {
    const res = importSql(sql, diagram.dialect, mode === 'merge' ? diagram : null);
    setPreview(res);
    if (res.tables.length === 0) {
      toast('error', res.errors.length ? 'Nothing imported: fix the errors below.' : 'No CREATE TABLE statements found.');
      return;
    }
    importTables(res.tables, res.relationships, mode, {
      customTypes: res.customTypes,
      extensions: res.extensions,
      group: group ? { name: groupName.trim() || 'Imported', external: groupExternal } : undefined,
    });
    const extras = [
      res.customTypes.length ? `${res.customTypes.length} type(s)` : '',
      res.extensions.length ? `${res.extensions.length} extension(s)` : '',
    ].filter(Boolean);
    const extraNote = extras.length ? ` and ${extras.join(' and ')}` : '';
    toast('success', `Imported ${res.tables.length} table(s), ${res.relationships.length} connection(s)${extraNote}.`);
    const implied = suggestForeignKeys(useStore.getState().diagram).filter((x) => x.confidence === 'high').length;
    if (implied) toast('info', `${implied} foreign key${implied === 1 ? ' looks' : 's look'} implied by column names. Open Problems to add them.`);
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
        <SqlEditor ref={editor} value={sql} onChange={setSql} mode="ddl" scope={scope} fill status="always" onSubmit={run} submitLabel="imports" ariaLabel="SQL to import" placeholder={PLACEHOLDER} />
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
        <div className="field">
          <label className="checkbox">
            <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Put these tables in a group
          </label>
          {group && (
            <div className="row row--wrap" style={{ marginTop: 4 }}>
              <input className="input input--sm grow" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Group name" />
              <label className="checkbox small" title="Leave these tables out of the generated script and out of anything applied to a database">
                <input type="checkbox" checked={groupExternal} onChange={(e) => setGroupExternal(e.target.checked)} /> Another database
              </label>
            </div>
          )}
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn--primary" onClick={run} disabled={!sql.trim() || (preview !== null && preview.tables.length === 0)} title="Ctrl+Enter in the editor">
            <Play /> Import
          </button>
          {preview && (
            <span className="small muted">
              {preview.tables.length === 0 ? 'Nothing to import yet' : `Ready: ${preview.tables.length} table${preview.tables.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Understands CREATE TABLE with column and table constraints, ALTER TABLE … ADD CONSTRAINT, CREATE INDEX, COMMENT ON, CREATE TYPE … AS ENUM and CREATE TYPE
          … AS (composite). Other statements are skipped with a warning. Tables referenced but not defined get a placeholder. A script this app exported also
          carries its data flows, serialized copies, dependencies and tagged queries in its trailing comments, and they come back with it.
        </div>
        {preview && (
          <div style={{ overflow: 'auto', minHeight: 0 }}>
            <div className="row row--wrap" style={{ marginBottom: 4 }}>
              <span className="badge badge--success">{preview.tables.length} tables</span>
              <span className="badge badge--accent">{preview.relationships.length} connections</span>
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
                <li key={`e${i}`} className="danger msg-list__jump" onClick={() => jumpTo(e)} title="Click to go to the line">
                  ✖ {e}
                </li>
              ))}
              {preview.warnings.map((w, i) => (
                <li key={`w${i}`} className={`warn${/^line \d+/.test(w) ? ' msg-list__jump' : ''}`} onClick={() => jumpTo(w)} title={/^line \d+/.test(w) ? 'Click to go to the line' : undefined}>
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
