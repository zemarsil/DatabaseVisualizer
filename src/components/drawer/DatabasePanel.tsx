import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, CheckCircle2, CloudDownload, Play, Plug, Plus, RefreshCw, Square, Trash2, Upload, XCircle } from 'lucide-react';
import { DIALECTS, SERVER_DIALECTS, dialectLabel, isServerDialect, type ContainerInfo, type ServerDialect, type StatementResult } from '@shared/types';
import { api, type DockerStatus } from '@/lib/api';
import { useStore } from '@/store/useStore';
import { defaultConnection, useConnection } from '@/store/useConnection';
import { backendFor } from '@/lib/backend';
import { generateDropStatements, generateSchema } from '@/lib/sql/generator';
import { readSchemaInto } from '@/lib/readSchema';
import { confirmDialog } from '../ui/Modal';
import { ConnectionFields } from './database/ConnectionFields';
import { ExternalDatabases, offerSchemaImport } from './database/ExternalDatabases';
import { MigrateSection } from './database/MigrateSection';
import { SeedSection } from './database/SeedSection';
import { SqliteSection } from './database/SqliteSection';
import { DuckdbSection } from './database/DuckdbSection';

export function DatabasePanel() {
  const diagram = useStore((s) => s.diagram);
  const toast = useStore((s) => s.toast);
  const setDialect = useStore((s) => s.setDialect);

  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const initialServerDialect: ServerDialect = isServerDialect(diagram.dialect) ? diagram.dialect : 'postgresql';
  const [form, setForm] = useState(() => ({
    dialect: initialServerDialect,
    name: `dbviz-${initialServerDialect}`,
    hostPort: DIALECTS.find((d) => d.id === initialServerDialect)!.defaultPort,
    password: 'secret',
    database: 'app',
    image: DIALECTS.find((d) => d.id === initialServerDialect)!.image,
  }));

  const main = useConnection((s) => s.main);
  const externals = useConnection((s) => s.externals);
  const setMainConfig = useConnection((s) => s.setMainConfig);
  const addExternal = useConnection((s) => s.addExternal);
  const promote = useConnection((s) => s.promote);
  const setResult = useConnection((s) => s.setResult);
  const conn = main.config;
  const backend = useMemo(() => backendFor(conn), [conn]);
  const embedded = !isServerDialect(conn.dialect);
  const [dropFirst, setDropFirst] = useState(false);
  const [stopOnError, setStopOnError] = useState(true);
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('replace');
  // Reading the main database into the diagram it designs normally means
  // starting from what is there, so it needs no group of its own.
  const [importGroup, setImportGroup] = useState(false);
  const [importGroupName, setImportGroupName] = useState('');
  const [importGroupExternal, setImportGroupExternal] = useState(false);

  /** Which connection, if any, already speaks for this container. */
  const connectedAs = useCallback(
    (c: ContainerInfo): 'main' | 'external' | null => {
      if (main.containerId === c.id) return 'main';
      return externals.some((x) => x.containerId === c.id) ? 'external' : null;
    },
    [main.containerId, externals],
  );

  const refresh = useCallback(async () => {
    setLoadingContainers(true);
    try {
      // When the app runs inside Docker, the server tells us how to reach host-published ports.
      const health = await api.health();
      if (health.defaultDbHost) useConnection.getState().setDefaultHost(health.defaultDbHost);
      const status = await api.docker.status();
      setDocker(status);
      if (status.available) setContainers(await api.docker.list());
      else setContainers([]);
    } catch (e) {
      setDocker({ available: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoadingContainers(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generated = useMemo(() => generateSchema(diagram), [diagram]);

  /** Point the main connection at this container: the diagram is designed for it. */
  const useAsMain = (c: ContainerInfo) => {
    if (!c.connection || !c.dialect) return;
    // Already connected on the side: move that connection over rather than
    // leaving two entries pointing at one container.
    const already = externals.find((x) => x.containerId === c.id);
    if (already) promote(already.id);
    else setMainConfig({ ...defaultConnection(c.dialect), ...c.connection, dialect: c.dialect }, { name: c.name, containerId: c.id });
    if (c.dialect !== diagram.dialect) toast('info', `This container runs ${dialectLabel(c.dialect)} but the diagram is ${dialectLabel(diagram.dialect)}. Switch the dialect before creating the schema.`);
  };

  /** Connect this container alongside the main database, and offer to read it in. */
  const useAsExternal = async (c: ContainerInfo) => {
    if (!c.connection || !c.dialect) return;
    const id = addExternal({ name: c.name, config: { ...defaultConnection(c.dialect), ...c.connection, dialect: c.dialect }, containerId: c.id });
    setBusy(c.id + 'external');
    try {
      const result = await backendFor(useConnection.getState().byId(id)!.config).test();
      setResult(id, result);
      if (!result.ok) {
        toast('error', `Connected "${c.name}", but it did not answer: ${result.message}`);
        return;
      }
      await offerSchemaImport(id);
    } finally {
      setBusy(null);
    }
  };

  const waitForDb = async (target: typeof conn, attempts = 30) => {
    for (let i = 0; i < attempts; i++) {
      const r = await api.db.test(target);
      if (r.ok) return r.serverVersion ?? 'ready';
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error('The database did not become ready in time. Try "Test connection" again in a moment.');
  };

  const createContainer = async () => {
    setBusy('create');
    try {
      const { container, connection } = await api.docker.create({
        dialect: form.dialect,
        name: form.name,
        hostPort: Number(form.hostPort),
        password: form.password,
        database: form.database,
        image: form.image,
      });
      setMainConfig(connection, { name: form.name, containerId: container.id });
      toast('info', `Container "${form.name}" started; waiting for ${dialectLabel(form.dialect)} to accept connections…`);
      await refresh();
      const version = await waitForDb(connection);
      setResult(useConnection.getState().main.id, { ok: true, message: version });
      toast('success', `${dialectLabel(form.dialect)} is ready on port ${connection.port}.`);
      await refresh();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const containerAction = async (c: ContainerInfo, action: 'start' | 'stop' | 'remove') => {
    if (action === 'remove') {
      const ok = await confirmDialog({ title: `Remove container "${c.name}"?`, message: 'The container and its data volume will be deleted.', confirmLabel: 'Remove', danger: true });
      if (!ok) return;
    }
    setBusy(c.id + action);
    try {
      await api.docker[action](c.id);
      toast('success', `${action === 'remove' ? 'Removed' : action === 'start' ? 'Started' : 'Stopped'} ${c.name}.`);
      await refresh();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy('test');
    setResult(main.id, null);
    try {
      setResult(main.id, await backend.test());
    } catch (e) {
      setResult(main.id, { ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const applySchema = async () => {
    if (conn.dialect !== diagram.dialect) {
      const ok = await confirmDialog({
        title: 'Dialect mismatch',
        message: `The diagram generates ${dialectLabel(diagram.dialect)} SQL but the main database is ${dialectLabel(conn.dialect)}. Switch the diagram dialect (types will be translated) and continue?`,
        confirmLabel: `Switch to ${dialectLabel(conn.dialect)}`,
      });
      if (!ok) return;
      setDialect(conn.dialect, true);
      toast('info', 'Dialect switched; review the SQL tab, then run again.');
      return;
    }
    const statements = [...(dropFirst ? generateDropStatements(diagram) : []), ...generated.statements];
    if (statements.length === 0) {
      toast('error', 'The diagram has no tables to create.');
      return;
    }
    const ok = await confirmDialog({
      title: `Run ${statements.length} statements on ${backend.label}?`,
      message: (
        <div className="stack">
          <span>
            {generated.statements.length} schema statements{dropFirst ? ` plus ${statements.length - generated.statements.length} DROP statements (existing tables and their data will be destroyed)` : ''}.
          </span>
          {generated.warnings.length > 0 && <span className="warn">{generated.warnings.join(' ')}</span>}
          {stopOnError && conn.dialect !== 'mariadb' && <span className="muted small">Runs inside one transaction: on failure nothing is kept.</span>}
          {conn.dialect === 'mariadb' && <span className="muted small">MariaDB commits DDL immediately, so statements before a failure stay applied.</span>}
        </div>
      ),
      confirmLabel: dropFirst ? 'Drop and create' : 'Create schema',
      danger: dropFirst,
    });
    if (!ok) return;
    setBusy('apply');
    setResults(null);
    try {
      const res = await backend.apply(statements, stopOnError);
      setResults(res.results);
      const failed = res.results.filter((r) => !r.ok).length;
      if (res.ok) toast('success', `Schema created: ${res.results.length} statements ran.`);
      else toast('error', `${failed} statement(s) failed. See the results list.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const importFromDb = async () => {
    setBusy('introspect');
    try {
      const res = await readSchemaInto(main.id, {
        mode: importMode,
        group: importGroup,
        groupName: importGroupName,
        external: importGroup && importGroupExternal,
      });
      if (res.tables === 0) {
        toast('info', 'The database has no tables.');
        return;
      }
      toast('success', `Imported ${res.tables} tables from ${res.serverVersion.split(' ').slice(0, 2).join(' ')}.`);
      if (res.warnings.length) toast('info', res.warnings.slice(0, 3).join(' '));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="drawer__split">
      {/* ---------------- Docker ---------------- */}
      <div className="drawer__col" style={{ overflow: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Docker</h3>
          {docker && (
            <span className={`badge ${docker.available ? 'badge--success' : 'badge--danger'}`} title={docker.error ?? docker.version}>
              {docker.available ? `connected · ${docker.version}` : 'unavailable'}
            </span>
          )}
          <span className="grow" />
          <button className="btn btn--sm" onClick={() => void refresh()} disabled={loadingContainers}>
            <RefreshCw /> Refresh
          </button>
        </div>
        {docker && !docker.available && (
          <div className="small warn" style={{ marginBottom: 8 }}>
            {docker.error ?? 'Docker is not reachable.'} You can still connect to any database by hand on the right, or pick SQLite or DuckDB to work entirely in the browser.
          </div>
        )}
        {docker === null && <div className="small muted">Checking the API server…</div>}

        {containers.map((c) => {
          const role = connectedAs(c);
          return (
            <div key={c.id} className="container-card">
              <span className={`container-card__state${c.state === 'running' ? ' container-card__state--running' : ''}`} title={c.status} />
              <div className="container-card__meta">
                <div className="container-card__name">
                  {c.name} {c.managed && <span className="badge badge--accent">managed</span>}
                  {role && <span className="badge badge--muted">{role === 'main' ? 'main' : 'external'}</span>}
                </div>
                <div className="container-card__sub">
                  {c.image} · {c.status}
                  {c.hostPort ? ` · port ${c.hostPort}` : ''}
                </div>
              </div>
              {c.state === 'running' ? (
                <>
                  <button className="btn btn--sm" onClick={() => useAsMain(c)} disabled={!c.connection || role === 'main'} title="Design for this database: Create schema, Migrate and Seed act on it">
                    <Plug /> Main
                  </button>
                  <button
                    className="btn btn--sm"
                    onClick={() => void useAsExternal(c)}
                    disabled={!c.connection || busy !== null || role !== null}
                    title="Connect it alongside the main database, and offer to read its schema in"
                  >
                    <Plus /> {busy === c.id + 'external' ? 'Connecting…' : 'External'}
                  </button>
                  <button className="btn btn--sm btn--icon" onClick={() => containerAction(c, 'stop')} disabled={busy !== null} title="Stop">
                    <Square />
                  </button>
                </>
              ) : (
                <button className="btn btn--sm btn--icon" onClick={() => containerAction(c, 'start')} disabled={busy !== null} title="Start">
                  <Play />
                </button>
              )}
              <button className="btn btn--sm btn--icon btn--danger" onClick={() => containerAction(c, 'remove')} disabled={busy !== null} title="Remove container">
                <Trash2 />
              </button>
            </div>
          );
        })}
        {docker?.available && containers.length === 0 && !loadingContainers && <div className="small muted" style={{ marginBottom: 8 }}>No database containers yet.</div>}

        {docker?.available && (
          <details open={containers.length === 0}>
            <summary className="section__title" style={{ cursor: 'pointer', marginBottom: 8 }}>
              Create a new database container
            </summary>
            <div className="form-grid">
              <div className="field">
                <span className="field__label">Engine</span>
                <select
                  className="select select--sm"
                  value={form.dialect}
                  onChange={(e) => {
                    const d = e.target.value as ServerDialect;
                    const meta = DIALECTS.find((x) => x.id === d)!;
                    setForm((f) => ({ ...f, dialect: d, hostPort: meta.defaultPort, image: meta.image, name: `dbviz-${d}` }));
                  }}
                >
                  {SERVER_DIALECTS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="field__label">Image</span>
                <input className="input input--sm input--mono" value={form.image} onChange={(e) => setForm((f) => ({ ...f, image: e.target.value }))} spellCheck={false} />
              </div>
              <div className="field">
                <span className="field__label">Container name</span>
                <input className="input input--sm" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} spellCheck={false} />
              </div>
              <div className="field">
                <span className="field__label">Host port</span>
                <input className="input input--sm" type="number" value={form.hostPort} onChange={(e) => setForm((f) => ({ ...f, hostPort: Number(e.target.value) }))} />
              </div>
              <div className="field">
                <span className="field__label">Database</span>
                <input className="input input--sm" value={form.database} onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))} spellCheck={false} />
              </div>
              <div className="field">
                <span className="field__label">{form.dialect === 'postgresql' ? 'postgres password' : 'root password'}</span>
                <input className="input input--sm" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} spellCheck={false} />
              </div>
            </div>
            <button className="btn btn--primary" onClick={createContainer} disabled={busy !== null}>
              <Box /> {busy === 'create' ? 'Creating…' : `Create & start ${dialectLabel(form.dialect)}`}
            </button>
            <div className="field__hint" style={{ marginTop: 6 }}>
              Pulls the image on first use, binds the port to 127.0.0.1 only, and labels the container so it shows up here as managed. It becomes the main database;
              a container you only want to read from is better connected with <em>External</em>.
            </div>
          </details>
        )}
      </div>

      {/* ---------------- Connections & schema ---------------- */}
      <div className="drawer__col" style={{ overflow: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Main database</h3>
          <span className="badge badge--muted" title="The database this diagram designs: Create schema, Migrate and Seed act on it">
            the diagram designs this one
          </span>
        </div>
        <ConnectionFields conn={main} />
        {embedded && (conn.dialect === 'duckdb' ? <DuckdbSection /> : <SqliteSection />)}
        <div className="row row--wrap" style={{ marginBottom: 8, marginTop: embedded ? 8 : 0 }}>
          <button className="btn" onClick={testConnection} disabled={busy !== null}>
            <Plug /> {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {main.result && (
            <span className={`row small ${main.result.ok ? 'success' : 'danger'}`} style={{ gap: 4 }}>
              {main.result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <span style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={main.result.message}>
                {main.result.message}
              </span>
            </span>
          )}
        </div>

        <div className="divider" />
        <ExternalDatabases />

        <div className="divider" />
        <h3>Create the schema</h3>
        <div className="row row--wrap" style={{ marginBottom: 8 }}>
          <label className="checkbox small">
            <input type="checkbox" checked={dropFirst} onChange={(e) => setDropFirst(e.target.checked)} /> Drop existing tables first
          </label>
          <label className="checkbox small">
            <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> Stop on first error
          </label>
          <span className="grow" />
          <button className="btn btn--primary" onClick={applySchema} disabled={busy !== null || diagram.tables.length === 0}>
            <Upload /> {busy === 'apply' ? 'Running…' : `Run ${generated.statements.length} statements`}
          </button>
        </div>
        {results && (
          <div style={{ marginBottom: 8, maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
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

        <div className="divider" />
        <MigrateSection />

        <div className="divider" />
        <SeedSection />

        <div className="divider" />
        <h3>Import from the main database</h3>
        <div className="row row--wrap">
          <label className="checkbox small">
            <input type="radio" name="db-import-mode" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} /> Replace diagram
          </label>
          <label className="checkbox small">
            <input type="radio" name="db-import-mode" checked={importMode === 'merge'} onChange={() => setImportMode('merge')} /> Add to diagram
          </label>
          <span className="grow" />
          <button className="btn" onClick={importFromDb} disabled={busy !== null}>
            <CloudDownload /> {busy === 'introspect' ? 'Reading…' : 'Read schema'}
          </button>
        </div>
        <div className="row row--wrap" style={{ marginTop: 6 }}>
          <label className="checkbox small">
            <input type="checkbox" checked={importGroup} onChange={(e) => setImportGroup(e.target.checked)} /> Put them in a group
          </label>
          {importGroup && (
            <>
              <input
                className="input input--sm"
                style={{ maxWidth: 180 }}
                value={importGroupName}
                onChange={(e) => setImportGroupName(e.target.value)}
                placeholder={conn.database || 'group name'}
              />
              <label className="checkbox small" title="Leave these tables out of the generated script and out of anything applied to a database">
                <input type="checkbox" checked={importGroupExternal} onChange={(e) => setImportGroupExternal(e.target.checked)} /> Another database
              </label>
            </>
          )}
        </div>
        <div className="field__hint" style={{ marginTop: 6 }}>
          Reads tables, columns, keys, indexes and foreign keys from the main database and lays them out. To read a database you only query, connect it under
          <em> Other databases</em> instead: what it reads goes into a group of its own and stays out of the script.
        </div>
      </div>
    </div>
  );
}
