import { Crosshair, Database, Trash2, Ungroup } from 'lucide-react';
import type { Group } from '@shared/types';
import { useStore } from '@/store/useStore';
import { PALETTE } from '@/lib/palette';
import { confirmDialog } from '../ui/Modal';

export function GroupEditor({ group }: { group: Group }) {
  const tables = useStore((s) => s.diagram.tables);
  const relationships = useStore((s) => s.diagram.relationships);
  const updateGroup = useStore((s) => s.updateGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const setTableGroup = useStore((s) => s.setTableGroup);
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const toast = useStore((s) => s.toast);

  const members = tables.filter((t) => t.groupId === group.id);
  const memberIds = new Set(members.map((t) => t.id));
  const crossing = relationships.filter(
    (r) => memberIds.has(r.sourceTableId) !== memberIds.has(r.targetTableId),
  );
  const crossingFks = crossing.filter((r) => r.kind === 'fk').length;

  const onUngroup = () => {
    deleteGroup(group.id, false);
    toast('info', `Removed the "${group.name}" region. Its ${members.length} table(s) are still in the diagram.`);
  };

  const onDeleteWithTables = async () => {
    const ok = await confirmDialog({
      title: `Delete "${group.name}" and its ${members.length} table(s)?`,
      message: crossing.length
        ? `${crossing.length} connection(s) to the rest of the diagram will go with them. This can be undone with Ctrl+Z.`
        : 'This can be undone with Ctrl+Z.',
      confirmLabel: 'Delete tables',
      danger: true,
    });
    if (ok) deleteGroup(group.id, true);
  };

  return (
    <div>
      <div className="field">
        <span className="field__label">Name</span>
        <input className="input" value={group.name} onChange={(e) => updateGroup(group.id, { name: e.target.value })} placeholder="e.g. Analytics warehouse" autoFocus />
      </div>

      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={group.external} onChange={(e) => updateGroup(group.id, { external: e.target.checked })} />
          <span>
            <Database size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            These tables live in another database
          </span>
        </label>
        <div className="field__hint">
          {group.external
            ? 'Left out of the generated CREATE TABLE script and out of anything run against a database. References into them are written as comments, because a foreign key cannot cross databases.'
            : 'Part of the schema you are designing: created by the script like every other table.'}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Note</span>
        <textarea
          className="textarea"
          rows={3}
          value={group.note ?? ''}
          onChange={(e) => updateGroup(group.id, { note: e.target.value || undefined })}
          placeholder="Where this database is, how you reach it, who owns it…"
        />
        <div className="field__hint">Shown on the region and copied into the generated script for external groups.</div>
      </div>

      <div className="field">
        <span className="field__label">Colour</span>
        <div className="swatches">
          {PALETTE.map((p) => (
            <button
              key={p.key}
              className={`swatch${group.color === p.key ? ' swatch--active' : ''}`}
              style={{ background: p.hue }}
              title={p.label}
              onClick={() => updateGroup(group.id, { color: p.key })}
            />
          ))}
        </div>
      </div>

      <div className="stat-grid" style={{ margin: '4px 0 14px' }}>
        <div className="stat">
          <div className="stat__value">{members.length}</div>
          <div className="stat__label">tables in the group</div>
        </div>
        <div className="stat">
          <div className="stat__value">{crossing.length}</div>
          <div className="stat__label">connections to the rest{crossingFks ? ` · ${crossingFks} FK` : ''}</div>
        </div>
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">Tables ({members.length})</span>
          {members.length > 0 && (
            <button className="btn btn--sm" onClick={() => setSelection({ tableIds: members.map((t) => t.id), relationshipId: null, noteId: null, groupId: null })}>
              Select all
            </button>
          )}
        </div>
        {members.length === 0 && <div className="faint small">Empty. Drag tables into the region on the canvas, or pick this group in a table&apos;s inspector.</div>}
        {members.map((t) => (
          <div key={t.id} className="rel-item" style={{ cursor: 'default' }}>
            <button
              className="grow row"
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textAlign: 'left' }}
              onClick={() => {
                setSelection({ tableIds: [t.id], relationshipId: null, noteId: null, groupId: null });
                focusTable(t.id);
              }}
            >
              <Crosshair size={13} className="faint" />
              <span style={{ fontWeight: 600 }}>{t.name}</span>
              <span className="faint small">{t.columns.length} cols</span>
            </button>
            <button className="icon-btn" title="Remove from the group" onClick={() => setTableGroup([t.id], null)}>
              <Ungroup />
            </button>
          </div>
        ))}
      </div>

      <div className="divider" />
      <div className="stack">
        <button className="btn" onClick={onUngroup}>
          <Ungroup /> Remove the region, keep the tables
        </button>
        <button className="btn btn--danger" onClick={onDeleteWithTables} disabled={members.length === 0}>
          <Trash2 /> Delete the region and its {members.length} table(s)
        </button>
      </div>
    </div>
  );
}
