import { Boxes, PanelRightClose, Route, Trash2 } from 'lucide-react';
import { kindMeta } from '@shared/types';
import { selectSelectedGroup, selectSelectedNote, selectSelectedRelationship, selectSelectedTable, useStore } from '@/store/useStore';
import { TableEditor } from './TableEditor';
import { RelationshipEditor } from './RelationshipEditor';
import { NoteEditor } from './NoteEditor';
import { GroupEditor } from './GroupEditor';
import { DiagramPanel } from './DiagramPanel';
import { ResizeHandle } from '@/components/ui/ResizeHandle';

export function Inspector() {
  const table = useStore(selectSelectedTable);
  const relationship = useStore(selectSelectedRelationship);
  const note = useStore(selectSelectedNote);
  const group = useStore(selectSelectedGroup);
  const selectedTableIds = useStore((s) => s.selection.tableIds);
  const selectedNoteIds = useStore((s) => s.selection.noteIds);
  const tables = useStore((s) => s.diagram.tables);
  const notes = useStore((s) => s.diagram.notes);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const resizePanel = useStore((s) => s.resizePanel);
  const removeElements = useStore((s) => s.removeElements);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const runTrace = useStore((s) => s.runTrace);
  const addGroup = useStore((s) => s.addGroup);
  const count = selectedTableIds.length + selectedNoteIds.length;

  let title = 'Diagram';
  let body: React.ReactNode;
  if (table) {
    title = 'Table';
    body = <TableEditor table={table} />;
  } else if (relationship) {
    title = kindMeta(relationship.kind).label;
    body = <RelationshipEditor relationship={relationship} />;
  } else if (note) {
    title = 'Note';
    body = <NoteEditor note={note} />;
  } else if (group) {
    title = group.external ? 'External group' : 'Group';
    body = <GroupEditor group={group} />;
  } else if (count > 1) {
    const tableNames = selectedTableIds.map((id) => tables.find((t) => t.id === id)?.name ?? '?');
    const noteNames = selectedNoteIds.map((id) => notes.find((n) => n.id === id)?.text.split('\n')[0] || 'Empty note');
    const parts: string[] = [];
    if (selectedTableIds.length) parts.push(`${selectedTableIds.length} table${selectedTableIds.length > 1 ? 's' : ''}`);
    if (selectedNoteIds.length) parts.push(`${selectedNoteIds.length} note${selectedNoteIds.length > 1 ? 's' : ''}`);
    title = `${parts.join(' + ')} selected`;
    body = (
      <div className="stack">
        <div className="chip-list">
          {[...tableNames, ...noteNames].map((n, i) => (
            <span key={i} className="chip chip--on">
              {n}
            </span>
          ))}
        </div>
        {selectedTableIds.length > 1 && (
          <button className="btn" onClick={() => addGroup({ tableIds: selectedTableIds })}>
            <Boxes /> Group these {selectedTableIds.length} tables
          </button>
        )}
        {selectedTableIds.length > 1 && (
          <button
            className="btn"
            onClick={() => {
              setTraceEndpoints(selectedTableIds[0], selectedTableIds[1]);
              runTrace();
            }}
          >
            <Route /> Trace {tableNames[0]} to {tableNames[1]}
          </button>
        )}
        <button className="btn btn--danger" onClick={() => removeElements({ tableIds: selectedTableIds, noteIds: selectedNoteIds })}>
          <Trash2 /> Delete {parts.join(' and ')}
        </button>
      </div>
    );
  } else {
    body = <DiagramPanel />;
  }

  return (
    <aside className="inspector">
      <ResizeHandle orientation="vertical" className="resize-handle--start" onResize={(delta) => resizePanel('inspectorW', -delta)} />
      <div className="inspector__head">
        <span className="inspector__title">{title}</span>
        <span className="grow" />
        <button className="btn btn--sm btn--icon btn--ghost" title="Hide inspector" onClick={() => setInspectorOpen(false)}>
          <PanelRightClose />
        </button>
      </div>
      <div className="inspector__body">{body}</div>
    </aside>
  );
}
