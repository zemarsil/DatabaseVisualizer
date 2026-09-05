import { useCallback, useEffect, useState } from 'react';
import { BookmarkPlus, History, Trash2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { defaultCheckpointName, deleteCheckpoint, getCurrentDiagramId, listCheckpoints, recordToDiagram, relativeTime, saveCheckpoint, type CheckpointRecord } from '@/lib/library';
import { confirmDialog } from '../ui/Modal';

export const CHECKPOINTS_EVENT = 'dbviz:checkpoints';

/** Named snapshots of the current diagram, restorable at any time. */
export function Checkpoints() {
  const setDiagram = useStore((s) => s.setDiagram);
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<CheckpointRecord[]>([]);
  const [name, setName] = useState('');

  const refresh = useCallback(async () => {
    setList(await listCheckpoints(getCurrentDiagramId()).catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(CHECKPOINTS_EVENT, onChange);
    return () => window.removeEventListener(CHECKPOINTS_EVENT, onChange);
  }, [refresh]);

  const save = async () => {
    const rec = await saveCheckpoint(name);
    setName('');
    toast('success', `Saved checkpoint "${rec.name}".`);
    window.dispatchEvent(new Event(CHECKPOINTS_EVENT));
  };

  const restore = async (c: CheckpointRecord) => {
    const ok = await confirmDialog({ title: `Restore "${c.name}"?`, message: 'The current state is replaced by the checkpoint. Ctrl+Z will not bring it back, but the autosave keeps the diagram in the library.', confirmLabel: 'Restore' });
    if (!ok) return;
    setDiagram(recordToDiagram(c));
    toast('success', `Restored "${c.name}".`);
  };

  const remove = async (c: CheckpointRecord) => {
    await deleteCheckpoint(c.id);
    await refresh();
  };

  return (
    <div className="section">
      <div className="section__head">
        <span className="section__title">Checkpoints ({list.length})</span>
      </div>
      <div className="row" style={{ marginBottom: 6 }}>
        <input
          className="input input--sm grow"
          placeholder={defaultCheckpointName()}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        <button className="btn btn--sm" onClick={() => void save()} title="Snapshot the diagram as it is now">
          <BookmarkPlus /> Save
        </button>
      </div>
      {list.length === 0 && <div className="faint small">No checkpoints yet. Save one before a big change; restoring is one click.</div>}
      {list.map((c) => (
        <div key={c.id} className="checkpoint">
          <History size={13} className="faint" />
          <span className="checkpoint__name" title={c.name}>
            {c.name}
          </span>
          <span className="faint small">
            {c.tableCount} t · {relativeTime(c.createdAt)}
          </span>
          <button className="btn btn--sm" onClick={() => void restore(c)}>
            Restore
          </button>
          <button className="icon-btn icon-btn--danger" title="Delete checkpoint" onClick={() => void remove(c)}>
            <Trash2 />
          </button>
        </div>
      ))}
    </div>
  );
}
