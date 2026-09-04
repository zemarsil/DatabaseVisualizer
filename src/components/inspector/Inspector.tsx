import { Boxes, PanelRightClose, Route, Trash2 } from 'lucide-react';
import { selectSelectedGroup, selectSelectedNote, selectSelectedRelationship, selectSelectedTable, useStore } from '@/store/useStore';
import { TableEditor } from './TableEditor';
import { RelationshipEditor } from './RelationshipEditor';
import { NoteEditor } from './NoteEditor';
import { GroupEditor } from './GroupEditor';
import { DiagramPanel } from './DiagramPanel';

export function Inspector() {
  const table = useStore(selectSelectedTable);
  const relationship = useStore(selectSelectedRelationship);
  const note = useStore(selectSelectedNote);
  const group = useStore(selectSelectedGroup);
  const multi = useStore((s) => s.selection.tableIds);
  const tables = useStore((s) => s.diagram.tables);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const deleteTables = useStore((s) => s.deleteTables);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const runTrace = useStore((s) => s.runTrace);
  const addGroup = useStore((s) => s.addGroup);

  let title = 'Diagram';
  let body: React.ReactNode;
  if (table) {
    title = 'Table';
    body = <TableEditor table={table} />;
  } else if (relationship) {
    title = relationship.kind === 'fk' ? 'Foreign key' : 'Data flow';
    body = <RelationshipEditor relationship={relationship} />;
  } else if (note) {
    title = 'Note';
    body = <NoteEditor note={note} />;
  } else if (group) {
    title = group.external ? 'External group' : 'Group';
    body = <GroupEditor group={group} />;
  } else if (multi.length > 1) {
    title = `${multi.length} tables selected`;
    const names = multi.map((id) => tables.find((t) => t.id === id)?.name ?? '?');
    body = (
      <div className="stack">
        <div className="chip-list">
          {names.map((n, i) => (
            <span key={i} className="chip chip--on">
              {n}
            </span>
          ))}
        </div>
        <button className="btn" onClick={() => addGroup({ tableIds: multi })}>
          <Boxes /> Group these {multi.length} tables
        </button>
        <button
          className="btn"
          onClick={() => {
            setTraceEndpoints(multi[0], multi[1]);
            runTrace();
          }}
        >
          <Route /> Trace {names[0]} to {names[1]}
        </button>
        <button className="btn btn--danger" onClick={() => deleteTables(multi)}>
          <Trash2 /> Delete {multi.length} tables
        </button>
      </div>
    );
  } else {
    body = <DiagramPanel />;
  }

  return (
    <aside className="inspector">
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
