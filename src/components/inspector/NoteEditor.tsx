import { Trash2 } from 'lucide-react';
import type { Note } from '@shared/types';
import { useStore } from '@/store/useStore';
import { Swatches } from '../ui/Swatches';

export function NoteEditor({ note }: { note: Note }) {
  const updateNote = useStore((s) => s.updateNote);
  const deleteNote = useStore((s) => s.deleteNote);
  return (
    <div>
      <div className="field">
        <span className="field__label">Text</span>
        <textarea className="textarea" rows={6} value={note.text} onChange={(e) => updateNote(note.id, { text: e.target.value })} autoFocus />
      </div>
      <div className="field">
        <span className="field__label">Color</span>
        <Swatches value={note.color} onPick={(key) => updateNote(note.id, { color: key })} label="Note colour" />
      </div>
      <div className="faint small">Drag the corners of the note on the canvas to resize it.</div>
      <div className="divider" />
      <button className="btn btn--danger" onClick={() => deleteNote(note.id)}>
        <Trash2 /> Delete note
      </button>
    </div>
  );
}
