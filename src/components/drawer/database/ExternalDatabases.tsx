import { useMemo, useState } from 'react';
import { Boxes, ChevronDown, ChevronRight, CloudDownload, Plug, Plus, Star, Terminal, Trash2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useConnection, type DbConnection } from '@/store/useConnection';
import { backendFor } from '@/lib/backend';
import { readSchemaInto } from '@/lib/readSchema';
import { confirmDialog } from '../../ui/Modal';
import { ConnectionFields } from './ConnectionFields';

/**
 * The databases connected alongside the main one: the ones you read from but do
 * not own.
 *
 * Each of them is a live connection like any other — it can be tested and
 * queried — and the button that matters is **Read schema**, which brings its
 * tables, keys and foreign keys in as a group marked "another database". That is
 * the whole point of connecting one: the diagram stops guessing at what the
 * other database holds, and the generated script still only creates your own.
 */

/** Ask whether to read a database that has just been connected, and do it. */
export async function offerSchemaImport(id: string, opts: { group: boolean; external: boolean } = { group: true, external: true }): Promise<void> {
  const conn = useConnection.getState().byId(id);
  if (!conn) return;
  const ok = await confirmDialog({
    title: `Read the schema from "${conn.name}"?`,
    message: (
      <div className="stack">
        <span>Its tables, columns, keys, indexes, foreign keys, views and enums are added to this diagram.</span>
        <span className="muted small">
          {opts.external
            ? 'They arrive in a group of their own, marked as another database: nothing generated will try to create them, and you can still draw data flows across the boundary.'
            : 'They are added to the schema being designed, as if you had drawn them.'}
        </span>
      </div>
    ),
    confirmLabel: 'Read schema',
    cancelLabel: 'Not now',
  });
  if (!ok) return;
  await runRead(id, opts);
}

/** Read one database in, reporting what happened the same way everywhere. */
async function runRead(id: string, opts: { group: boolean; external: boolean }): Promise<void> {
  const toast = useStore.getState().toast;
  const conn = useConnection.getState().byId(id);
  if (!conn) return;
  try {
    const res = await readSchemaInto(id, { mode: 'merge', group: opts.group, external: opts.external });
    if (res.tables === 0) {
      toast('info', `"${conn.name}" has no tables to read.`);
      return;
    }
    toast('success', `${res.refreshed ? 'Refreshed' : 'Read'} ${res.tables} tables from "${conn.name}".`);
    for (const w of res.warnings.slice(0, 2)) toast('info', w);
  } catch (e) {
    toast('error', e instanceof Error ? e.message : String(e));
  }
}

export function ExternalDatabases() {
  const externals = useConnection((s) => s.externals);
  const addExternal = useConnection((s) => s.addExternal);
  const removeExternal = useConnection((s) => s.removeExternal);
  const promote = useConnection((s) => s.promote);
  const setResult = useConnection((s) => s.setResult);
  const setQueryTarget = useConnection((s) => s.setQueryTarget);
  const diagram = useStore((s) => s.diagram);
  const selectGroup = useStore((s) => s.selectGroup);
  const openDrawer = useStore((s) => s.openDrawer);
  const toast = useStore((s) => s.toast);

  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // How the next read files what it finds. Ticked is the usual case: a database
  // you do not own is documented, not designed.
  const [group, setGroup] = useState(true);
  const [external, setExternal] = useState(true);

  const tablesPerGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of diagram.tables) if (t.groupId) counts.set(t.groupId, (counts.get(t.groupId) ?? 0) + 1);
    return counts;
  }, [diagram.tables]);

  const test = async (c: DbConnection) => {
    setBusy(c.id + 'test');
    setResult(c.id, null);
    try {
      setResult(c.id, await backendFor(c.config).test());
    } catch (e) {
      setResult(c.id, { ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const read = async (c: DbConnection) => {
    setBusy(c.id + 'read');
    await runRead(c.id, { group, external });
    setBusy(null);
  };

  const makeMain = async (c: DbConnection) => {
    const ok = await confirmDialog({
      title: `Design for "${c.name}"?`,
      message: (
        <div className="stack">
          <span>Create schema, Migrate and Seed will act on this database instead.</span>
          <span className="muted small">The database they act on now becomes one more database read from the outside; nothing on the canvas moves.</span>
        </div>
      ),
      confirmLabel: 'Make it the main database',
    });
    if (!ok) return;
    promote(c.id);
    toast('success', `"${c.name}" is now the main database.`);
  };

  const forget = async (c: DbConnection) => {
    const linked = c.groupId ? tablesPerGroup.get(c.groupId) : undefined;
    const ok = await confirmDialog({
      title: `Disconnect "${c.name}"?`,
      message: linked
        ? `The ${linked} tables already read from it stay on the canvas; only the connection goes.`
        : 'Only the connection goes; nothing on the canvas changes.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    removeExternal(c.id);
  };

  const add = () => {
    const id = addExternal();
    setExpanded(id);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Other databases</h3>
        <span className="badge badge--muted">{externals.length}</span>
        <span className="grow" />
        <button className="btn btn--sm" onClick={add}>
          <Plus /> Connect another
        </button>
      </div>
      {externals.length === 0 && (
        <div className="field__hint" style={{ marginBottom: 6 }}>
          A database you read from but do not own — another container, a replica, somebody else's service. Connect it here (or press <em>external</em> on a container
          on the left) and its schema can be read into a group of its own, leaving the schema you are designing alone.
        </div>
      )}
      {externals.map((c) => {
        const backend = backendFor(c.config);
        const count = c.groupId ? tablesPerGroup.get(c.groupId) : undefined;
        const groupName = c.groupId ? diagram.groups.find((g) => g.id === c.groupId)?.name : undefined;
        const open = expanded === c.id;
        return (
          <div key={c.id} className="conn-card">
            <div className="conn-card__row">
              <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setExpanded(open ? null : c.id)} title={open ? 'Hide the connection details' : 'Show the connection details'}>
                {open ? <ChevronDown /> : <ChevronRight />}
              </button>
              <span className={`conn-card__state${c.result ? (c.result.ok ? ' conn-card__state--ok' : ' conn-card__state--bad') : ''}`} title={c.result?.message ?? 'Not tested yet'} />
              <div className="conn-card__meta">
                <div className="conn-card__name">{c.name}</div>
                <div className="conn-card__sub" title={c.result?.message ?? backend.label}>
                  {backend.label}
                  {groupName ? ` · ${count ?? 0} tables in “${groupName}”` : ''}
                </div>
              </div>
              {groupName && (
                <button className="btn btn--sm btn--icon" onClick={() => selectGroup(c.groupId!)} title={`Select the group “${groupName}”`}>
                  <Boxes />
                </button>
              )}
              <button className="btn btn--sm" onClick={() => void test(c)} disabled={busy !== null} title="Check that it answers">
                <Plug /> {busy === c.id + 'test' ? 'Testing…' : 'Test'}
              </button>
              <button className="btn btn--sm" onClick={() => void read(c)} disabled={busy !== null} title={count ? 'Read it again, replacing what was read before' : 'Read its tables, keys and foreign keys into the diagram'}>
                <CloudDownload /> {busy === c.id + 'read' ? 'Reading…' : count ? 'Re-read' : 'Read schema'}
              </button>
              <button
                className="btn btn--sm btn--icon"
                onClick={() => {
                  setQueryTarget(c.id);
                  openDrawer('query');
                }}
                title="Query this database"
              >
                <Terminal />
              </button>
              <button className="btn btn--sm btn--icon" onClick={() => void makeMain(c)} disabled={busy !== null} title="Design for this database instead">
                <Star />
              </button>
              <button className="btn btn--sm btn--icon btn--danger" onClick={() => void forget(c)} disabled={busy !== null} title="Disconnect">
                <Trash2 />
              </button>
            </div>
            {c.result && (
              <div className={`conn-card__result small ${c.result.ok ? 'success' : 'danger'}`} title={c.result.message}>
                {c.result.message}
              </div>
            )}
            {open && (
              <div className="conn-card__fields">
                <ConnectionFields conn={c} />
              </div>
            )}
          </div>
        );
      })}
      {externals.length > 0 && (
        <div className="row row--wrap" style={{ marginTop: 6 }}>
          <label className="checkbox small" title="Keep the tables read from one database together in a region of their own">
            <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group what is read
          </label>
          <label className="checkbox small" title="Leave those tables out of the generated script and out of anything run against the main database">
            <input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} disabled={!group} /> Mark as another database
          </label>
        </div>
      )}
    </div>
  );
}
