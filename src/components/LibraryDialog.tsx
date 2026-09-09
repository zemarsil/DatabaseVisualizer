import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, FilePlus2, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { dialectLabel } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { downloadText, FILE_EXTENSION, fileSlug } from '@/lib/io';
import {
  deleteWorkspace,
  flushCurrentWorkspace,
  getCurrentWorkspaceId,
  listWorkspaces,
  newWorkspaceId,
  putWorkspace,
  recordToWorkspace,
  relativeTime,
  setCurrentWorkspaceId,
  workspaceRecord,
  type WorkspaceRecord,
} from '@/lib/library';
import { confirmDialog, Modal, promptDialog } from './ui/Modal';

/** "Open recent": every workspace this browser has worked on, with thumbnails. */
export function LibraryDialog() {
  const open = useUi((s) => s.libraryOpen);
  const setOpen = useUi((s) => s.setLibraryOpen);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const newWorkspace = useStore((s) => s.newWorkspace);
  const setWorkspaceName = useStore((s) => s.setWorkspaceName);
  const toast = useStore((s) => s.toast);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [currentId, setCurrentId] = useState(getCurrentWorkspaceId());

  const refresh = useCallback(async () => {
    await flushCurrentWorkspace();
    setRecords(await listWorkspaces());
    setCurrentId(getCurrentWorkspaceId());
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const openRecord = (r: WorkspaceRecord) => {
    try {
      const ws = recordToWorkspace(r);
      setCurrentWorkspaceId(r.id);
      setWorkspace(ws);
      setOpen(false);
      toast('success', `Opened "${ws.name}".`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'This entry could not be read.');
    }
  };

  const rename = async (r: WorkspaceRecord) => {
    const name = await promptDialog({ title: 'Rename workspace', label: 'Name', value: r.name, confirmLabel: 'Rename' });
    if (!name?.trim()) return;
    const ws = recordToWorkspace(r);
    ws.name = name.trim();
    // A workspace of one diagram is that diagram, in the entry as on the canvas.
    if (ws.sheets.length === 1) ws.sheets[0].diagram.name = ws.name;
    await putWorkspace({ ...workspaceRecord(ws, r.id, r.updatedAt), updatedAt: Date.now() });
    if (r.id === currentId) setWorkspaceName(ws.name);
    await refresh();
  };

  const duplicate = async (r: WorkspaceRecord) => {
    const ws = recordToWorkspace(r);
    ws.name = `${ws.name} copy`;
    if (ws.sheets.length === 1) ws.sheets[0].diagram.name = ws.name;
    await putWorkspace(workspaceRecord(ws, newWorkspaceId()));
    await refresh();
  };

  const download = (r: WorkspaceRecord) => downloadText(`${fileSlug(r.name)}${FILE_EXTENSION}`, r.data);

  const remove = async (r: WorkspaceRecord) => {
    const ok = await confirmDialog({
      title: `Delete "${r.name}"?`,
      message: `${r.sheetCount === 1 ? 'The diagram' : `All ${r.sheetCount} diagrams`} and their checkpoints are removed from this browser. A downloaded .dbviz.json file is unaffected.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteWorkspace(r);
    if (r.id === currentId) {
      setCurrentWorkspaceId(newWorkspaceId());
      newWorkspace(useStore.getState().diagram.dialect);
    }
    await refresh();
  };

  const startNew = async () => {
    await flushCurrentWorkspace();
    setCurrentWorkspaceId(newWorkspaceId());
    newWorkspace(useStore.getState().diagram.dialect);
    setOpen(false);
  };

  return (
    <Modal
      title="Workspace library"
      onClose={() => setOpen(false)}
      wide
      footer={
        <>
          <span className="small muted grow">Everything you work on is kept in this browser. Download a .dbviz.json to take a workspace elsewhere.</span>
          <button className="btn btn--primary" onClick={() => void startNew()}>
            <FilePlus2 /> New workspace
          </button>
        </>
      }
    >
      {records.length === 0 && <div className="library__empty">No workspaces yet. The one you are editing shows up here as soon as it changes.</div>}
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
                {dialectLabel(r.dialect).replace(' (in browser)', '')}
                {r.sheetCount > 1 && ` · ${r.sheetCount} diagrams`} · {r.tableCount} table{r.tableCount === 1 ? '' : 's'} · {relativeTime(r.updatedAt)}
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
