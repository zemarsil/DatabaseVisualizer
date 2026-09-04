import { Trash2 } from 'lucide-react';
import type { Note } from '@shared/types';
import { useStore } from '@/store/useStore';
import { PALETTE } from '@/lib/palette';

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
        <div className="swatches">
          {PALETTE.map((p) => (
            <button key={p.key} className={`swatch${note.color === p.key ? ' swatch--active' : ''}`} style={{ background: p.hue }} title={p.label} onClick={() => updateNote(note.id, { color: p.key })} />
          ))}
        </div>
      </div>
      <div className="faint small">Drag the corners of the note on the canvas to resize it.</div>
      <div className="divider" />
      <button className="btn btn--danger" onClick={() => deleteNote(note.id)}>
        <Trash2 /> Delete note
      </button>
    </div>
  );
}
