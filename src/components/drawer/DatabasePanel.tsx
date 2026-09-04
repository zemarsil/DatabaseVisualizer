import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, CheckCircle2, CloudDownload, Play, Plug, RefreshCw, Square, Trash2, Upload, XCircle } from 'lucide-react';
import { DIALECTS, type ConnectionConfig, type ContainerInfo, type Dialect, type StatementResult } from '@shared/types';
import { api, type DockerStatus } from '@/lib/api';
import { useStore } from '@/store/useStore';
import { generateDropStatements, generateSchema } from '@/lib/sql/generator';
import { introspectionToDiagram } from '@/lib/introspectImport';
import { confirmDialog } from '../ui/Modal';

const CONN_KEY = 'dbviz:connection';

function defaultConnection(dialect: Dialect): ConnectionConfig {
  const d = DIALECTS.find((x) => x.id === dialect)!;
  return { dialect, host: '127.0.0.1', port: d.defaultPort, user: d.defaultUser, password: '', database: 'app' };
}

function loadConnection(dialect: Dialect): ConnectionConfig {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (raw) {
      const c = JSON.parse(raw) as ConnectionConfig;
      if (c && c.dialect === dialect) return c;
    }
  } catch {
    /* ignore */
  }
  return defaultConnection(dialect);
}

export function DatabasePanel() {
  const diagram = useStore((s) => s.diagram);
  const toast = useStore((s) => s.toast);
  const importTables = useStore((s) => s.importTables);
  const setDialect = useStore((s) => s.setDialect);

  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [form, setForm] = useState(() => ({
    dialect: diagram.dialect,
    name: `dbviz-${diagram.dialect}`,
    hostPort: DIALECTS.find((d) => d.id === diagram.dialect)!.defaultPort,
    password: 'secret',
    database: 'app',
    image: DIALECTS.find((d) => d.id === diagram.dialect)!.image,
  }));

  const [conn, setConn] = useState<ConnectionConfig>(() => loadConnection(diagram.dialect));
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [dropFirst, setDropFirst] = useState(false);
  const [stopOnError, setStopOnError] = useState(true);
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('replace');
  // Reading a second database is the usual reason to want a group: keep those
  // tables together and, by default, out of the schema being designed.
  const [importGroup, setImportGroup] = useState(true);
  const [importGroupName, setImportGroupName] = useState('');
  const [importGroupExternal, setImportGroupExternal] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(CONN_KEY, JSON.stringify(conn));
    } catch {
      /* ignore */
    }
  }, [conn]);

  const refresh = useCallback(async () => {
    setLoadingContainers(true);
    try {
      // When the app runs inside Docker, the server tells us how to reach host-published ports.
      const health = await api.health();
      if (health.defaultDbHost && health.defaultDbHost !== '127.0.0.1') {
        setConn((c) => (c.host === '127.0.0.1' ? { ...c, host: health.defaultDbHost! } : c));
      }
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
  const dialectLabel = (d: Dialect) => DIALECTS.find((x) => x.id === d)?.label ?? d;

  const useContainer = (c: ContainerInfo) => {
    if (!c.connection || !c.dialect) return;
    const next: ConnectionConfig = { ...defaultConnection(c.dialect), ...c.connection, dialect: c.dialect } as ConnectionConfig;
    setConn(next);
    setTestResult(null);
    if (c.dialect !== diagram.dialect) toast('info', `This container runs ${dialectLabel(c.dialect)} but the diagram is ${dialectLabel(diagram.dialect)}. Switch the dialect before creating the schema.`);
  };

  const waitForDb = async (target: ConnectionConfig, attempts = 30) => {
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
      const { connection } = await api.docker.create({
        dialect: form.dialect,
        name: form.name,
        hostPort: Number(form.hostPort),
        password: form.password,
        database: form.database,
        image: form.image,
      });
      setConn(connection);
      toast('info', `Container "${form.name}" started; waiting for ${dialectLabel(form.dialect)} to accept connections…`);
      await refresh();
      const version = await waitForDb(connection);
      setTestResult({ ok: true, message: version });
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
    setTestResult(null);
    try {
      const r = await api.db.test(conn);
      setTestResult(r.ok ? { ok: true, message: r.serverVersion ?? 'Connected' } : { ok: false, message: r.error ?? 'Failed' });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const applySchema = async () => {
    if (conn.dialect !== diagram.dialect) {
      const ok = await confirmDialog({
        title: 'Dialect mismatch',
        message: `The diagram generates ${dialectLabel(diagram.dialect)} SQL but the connection is ${dialectLabel(conn.dialect)}. Switch the diagram dialect (types will be translated) and continue?`,
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
      title: `Run ${statements.length} statements on ${conn.database || conn.user}@${conn.host}:${conn.port}?`,
      message: (
        <div className="stack">
          <span>
            {generated.statements.length} schema statements{dropFirst ? ` plus ${statements.length - generated.statements.length} DROP statements (existing tables and their data will be destroyed)` : ''}.
          </span>
          {generated.warnings.length > 0 && <span className="warn">{generated.warnings.join(' ')}</span>}
          {stopOnError && conn.dialect === 'postgresql' && <span className="muted small">Runs inside one transaction: on failure nothing is kept.</span>}
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
      const res = await api.db.apply({ connection: conn, statements, stopOnError });
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
      const res = await api.db.introspect(conn);
      if (conn.dialect !== diagram.dialect) setDialect(conn.dialect, false);
      const converted = introspectionToDiagram(res, conn.dialect, importMode === 'merge' ? diagram : null);
      if (converted.tables.length === 0) {
        toast('info', 'The database has no tables.');
        return;
      }
      importTables(converted.tables, converted.relationships, importMode, {
        customTypes: converted.customTypes,
        group: importGroup
          ? {
              name: importGroupName.trim() || conn.database || 'Imported database',
              external: importGroupExternal,
              note: `${conn.dialect === 'mariadb' ? 'MariaDB' : 'PostgreSQL'} ${conn.database} on ${conn.host}:${conn.port}`,
            }
          : undefined,
      });
        toast('success', `Imported ${converted.tables.length} tables from ${res.serverVersion.split(' ').slice(0, 2).join(' ')}.`);
      if (converted.warnings.length) toast('info', converted.warnings.slice(0, 3).join(' '));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const setConnField = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => {
    setConn((c) => ({ ...c, [k]: v }));
    setTestResult(null);
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
            {docker.error ?? 'Docker is not reachable.'} You can still connect to any database by hand on the right.
          </div>
        )}
        {docker === null && <div className="small muted">Checking the API server…</div>}

        {containers.map((c) => (
          <div key={c.id} className="container-card">
            <span className={`container-card__state${c.state === 'running' ? ' container-card__state--running' : ''}`} title={c.status} />
            <div className="container-card__meta">
              <div className="container-card__name">
                {c.name} {c.managed && <span className="badge badge--accent">managed</span>}
              </div>
              <div className="container-card__sub">
                {c.image} · {c.status}
                {c.hostPort ? ` · port ${c.hostPort}` : ''}
              </div>
            </div>
            {c.state === 'running' ? (
              <>
                <button className="btn btn--sm" onClick={() => useContainer(c)} disabled={!c.connection} title="Fill the connection form from this container">
                  <Plug /> Use
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
        ))}
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
                    const d = e.target.value as Dialect;
                    const meta = DIALECTS.find((x) => x.id === d)!;
                    setForm((f) => ({ ...f, dialect: d, hostPort: meta.defaultPort, image: meta.image, name: `dbviz-${d}` }));
                  }}
                >
                  {DIALECTS.map((d) => (
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
              Pulls the image on first use, binds the port to 127.0.0.1 only, and labels the container so it shows up here as managed.
            </div>
          </details>
        )}
      </div>

      {/* ---------------- Connection & schema ---------------- */}
      <div className="drawer__col" style={{ overflow: 'auto' }}>
        <h3>Connection</h3>
        <div className="form-grid">
          <div className="field">
            <span className="field__label">Engine</span>
            <select className="select select--sm" value={conn.dialect} onChange={(e) => setConn({ ...defaultConnection(e.target.value as Dialect), password: conn.password })}>
              {DIALECTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field__label">Host</span>
            <input className="input input--sm" value={conn.host} onChange={(e) => setConnField('host', e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <span className="field__label">Port</span>
            <input className="input input--sm" type="number" value={conn.port} onChange={(e) => setConnField('port', Number(e.target.value))} />
          </div>
          <div className="field">
            <span className="field__label">Database</span>
            <input className="input input--sm" value={conn.database} onChange={(e) => setConnField('database', e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <span className="field__label">User</span>
            <input className="input input--sm" value={conn.user} onChange={(e) => setConnField('user', e.target.value)} spellCheck={false} autoComplete="off" />
          </div>
          <div className="field">
            <span className="field__label">Password</span>
            <input className="input input--sm" type="password" value={conn.password} onChange={(e) => setConnField('password', e.target.value)} autoComplete="off" />
          </div>
        </div>
        <div className="row row--wrap" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={testConnection} disabled={busy !== null}>
            <Plug /> {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <span className={`row small ${testResult.ok ? 'success' : 'danger'}`} style={{ gap: 4 }}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <span style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={testResult.message}>
                {testResult.message}
              </span>
            </span>
          )}
        </div>

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
        <h3>Import from the database</h3>
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
          Reads tables, columns, keys, indexes and foreign keys from the connected database and lays them out. Grouping them keeps a database you only read
          from visually separate; marking it as another database also keeps it out of the CREATE TABLE script.
        </div>
      </div>
    </div>
  );
}
