import { DIALECTS, isServerDialect, type Dialect } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useConnection, type DbConnection } from '@/store/useConnection';

/**
 * The form for one database's connection details, used for the main database
 * and for every external one. Which connection it edits is the only difference,
 * so the fields live here rather than once per panel.
 */
export function ConnectionFields({ conn, showName = true }: { conn: DbConnection; showName?: boolean }) {
  const toast = useStore((s) => s.toast);
  const setName = useConnection((s) => s.setName);
  const setField = useConnection((s) => s.setField);
  const setDialect = useConnection((s) => s.setDialect);
  const dialectConflict = useConnection((s) => s.dialectConflict);
  const server = isServerDialect(conn.config.dialect);

  const changeDialect = (dialect: Dialect) => {
    const problem = dialectConflict(conn.id, dialect);
    if (problem) {
      toast('error', problem);
      return;
    }
    setDialect(conn.id, dialect);
  };

  return (
    <div className="form-grid">
      {showName && (
        <div className="field">
          <span className="field__label">Name</span>
          <input className="input input--sm" value={conn.name} onChange={(e) => setName(conn.id, e.target.value)} spellCheck={false} placeholder="What to call it" />
        </div>
      )}
      <div className="field">
        <span className="field__label">Engine</span>
        <select className="select select--sm" value={conn.config.dialect} onChange={(e) => changeDialect(e.target.value as Dialect)}>
          {DIALECTS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {server && (
        <>
          <div className="field">
            <span className="field__label">Host</span>
            <input className="input input--sm" value={conn.config.host} onChange={(e) => setField(conn.id, 'host', e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <span className="field__label">Port</span>
            <input className="input input--sm" type="number" value={conn.config.port} onChange={(e) => setField(conn.id, 'port', Number(e.target.value))} />
          </div>
          <div className="field">
            <span className="field__label">Database</span>
            <input className="input input--sm" value={conn.config.database} onChange={(e) => setField(conn.id, 'database', e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <span className="field__label">User</span>
            <input className="input input--sm" value={conn.config.user} onChange={(e) => setField(conn.id, 'user', e.target.value)} spellCheck={false} autoComplete="off" />
          </div>
          <div className="field">
            <span className="field__label">Password</span>
            <input className="input input--sm" type="password" value={conn.config.password} onChange={(e) => setField(conn.id, 'password', e.target.value)} autoComplete="off" />
          </div>
        </>
      )}
    </div>
  );
}
