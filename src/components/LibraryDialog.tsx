import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, FilePlus2, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { dialectLabel } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { downloadText, FILE_EXTENSION, fileSlug } from '@/lib/io';
import {
  deleteDiagram,
  diagramRecord,
  flushCurrentDiagram,
  getCurrentDiagramId,
  listDiagrams,
  newDiagramId,
  putDiagram,
  recordToDiagram,
  relativeTime,
  setCurrentDiagramId,
  type DiagramRecord,
} from '@/lib/library';
import { confirmDialog, Modal, promptDialog } from './ui/Modal';

/** "Open recent": every diagram this browser has worked on, with thumbnails. */
export function LibraryDialog() {
  const open = useUi((s) => s.libraryOpen);
  const setOpen = useUi((s) => s.setLibraryOpen);
  const setDiagram = useStore((s) => s.setDiagram);
  const newDiagram = useStore((s) => s.newDiagram);
  const setDiagramName = useStore((s) => s.setDiagramName);
  const toast = useStore((s) => s.toast);
  const [records, setRecords] = useState<DiagramRecord[]>([]);
  const [currentId, setCurrentId] = useState(getCurrentDiagramId());

  const refresh = useCallback(async () => {
    await flushCurrentDiagram();
    setRecords(await listDiagrams());
    setCurrentId(getCurrentDiagramId());
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const openRecord = (r: DiagramRecord) => {
    try {
      const d = recordToDiagram(r);
      setCurrentDiagramId(r.id);
      setDiagram(d);
      setOpen(false);
      toast('success', `Opened "${d.name}".`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'This entry could not be read.');
    }
  };

  const rename = async (r: DiagramRecord) => {
    const name = await promptDialog({ title: 'Rename diagram', label: 'Name', value: r.name, confirmLabel: 'Rename' });
    if (!name?.trim()) return;
    const d = recordToDiagram(r);
    d.name = name.trim();
    await putDiagram({ ...diagramRecord(d, r.id, r.updatedAt), updatedAt: Date.now() });
    if (r.id === currentId) setDiagramName(d.name);
    await refresh();
  };

  const duplicate = async (r: DiagramRecord) => {
    const d = recordToDiagram(r);
    d.name = `${d.name} copy`;
    await putDiagram(diagramRecord(d, newDiagramId()));
    await refresh();
  };

  const download = (r: DiagramRecord) => downloadText(`${fileSlug(r.name)}${FILE_EXTENSION}`, r.data);

  const remove = async (r: DiagramRecord) => {
    const ok = await confirmDialog({ title: `Delete "${r.name}"?`, message: 'The diagram and its checkpoints are removed from this browser. A downloaded .dbviz.json file is unaffected.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await deleteDiagram(r.id);
    if (r.id === currentId) {
      setCurrentDiagramId(newDiagramId());
      newDiagram(useStore.getState().diagram.dialect);
    }
    await refresh();
  };

  const startNew = async () => {
    await flushCurrentDiagram();
    setCurrentDiagramId(newDiagramId());
    newDiagram(useStore.getState().diagram.dialect);
    setOpen(false);
  };

  return (
    <Modal
      title="Diagram library"
      onClose={() => setOpen(false)}
      wide
      footer={
        <>
          <span className="small muted grow">Everything you work on is kept in this browser. Download a .dbviz.json to take it elsewhere.</span>
          <button className="btn btn--primary" onClick={() => void startNew()}>
            <FilePlus2 /> New diagram
          </button>
        </>
      }
    >
      {records.length === 0 && <div className="library__empty">No diagrams yet. The one you are editing shows up here as soon as it changes.</div>}
      <div className="library">
        {records.map((r) => (
          <div key={r.id} className={`library__card${r.id === currentId ? ' library__card--current' : ''}`}>
            <img className="library__thumb" src={r.thumbnail} alt={`${r.name} thumbnail`} onClick={() => openRecord(r)} />
            <div className="library__body">
              <div className="library__name" title={r.name}>
                {r.name}
                {r.id === currentId && <span className="badge badge--accent" style={{ marginLeft: 6 }}>open</span>}
              </div>
              <div className="library__meta">
                {dialectLabel(r.dialect).replace(' (in browser)', '')} · {r.tableCount} table{r.tableCount === 1 ? '' : 's'} · {relativeTime(r.updatedAt)}
              </div>
              <div className="library__actions">
                <button className="btn btn--sm" onClick={() => openRecord(r)} disabled={r.id === currentId}>
                  <FolderOpen /> Open
                </button>
                <button className="btn btn--sm btn--icon" title="Rename" onClick={() => void rename(r)}>
                  <Pencil />
                </button>
                <button className="btn btn--sm btn--icon" title="Duplicate" onClick={() => void duplicate(r)}>
                  <Copy />
                </button>
                <button className="btn btn--sm btn--icon" title="Download .dbviz.json" onClick={() => download(r)}>
                  <Download />
                </button>
                <button className="btn btn--sm btn--icon btn--danger" title="Delete" onClick={() => void remove(r)}>
                  <Trash2 />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
