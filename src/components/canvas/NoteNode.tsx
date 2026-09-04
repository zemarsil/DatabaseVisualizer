import { memo } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Note } from '@shared/types';
import { paletteHue } from '@/lib/palette';
import { useStore } from '@/store/useStore';

export interface NoteNodeData extends Record<string, unknown> {
  note: Note;
  dimmed: boolean;
}

export type NoteNodeType = Node<NoteNodeData, 'note'>;

function NoteNodeInner({ data, selected }: NodeProps<NoteNodeType>) {
  const updateNote = useStore((s) => s.updateNote);
  const { note, dimmed } = data;
  const classes = ['note-node'];
  if (selected) classes.push('note-node--selected');
  if (dimmed) classes.push('note-node--dim');
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        lineStyle={{ borderColor: 'var(--accent)' }}
        handleStyle={{ background: 'var(--accent)', border: 'none', width: 8, height: 8, borderRadius: 2 }}
        onResizeEnd={(_e, p) => updateNote(note.id, { width: p.width, height: p.height, position: { x: p.x, y: p.y } })}
      />
      <div className={classes.join(' ')} style={{ '--hue': paletteHue(note.color) } as React.CSSProperties}>
        {note.text || 'Empty note'}
        <Handle type="source" position={Position.Right} id={`${note.id}|hdr`} className="note-node__handle" />
      </div>
    </>
  );
}

export const NoteNode = memo(NoteNodeInner);
