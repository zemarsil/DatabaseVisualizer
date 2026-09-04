import { useMemo, useState } from 'react';
import { PanelLeftClose, Plus, Search, StickyNote } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { paletteHue } from '@/lib/palette';
import { ResizeHandle } from '@/components/ui/ResizeHandle';

export function Sidebar() {
  const tables = useStore((s) => s.diagram.tables);
  const notes = useStore((s) => s.diagram.notes);
  const selection = useStore((s) => s.selection);
  const trace = useStore((s) => s.trace);
  const selectTable = useStore((s) => s.selectTable);
  const focusTable = useStore((s) => s.focusTable);
  const setSelection = useStore((s) => s.setSelection);
  const addTable = useStore((s) => s.addTable);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const resizePanel = useStore((s) => s.resizePanel);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q))) : tables;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [tables, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__section" style={{ padding: 0 }}>
          Tables <span className="sidebar__count">({tables.length})</span>
        </span>
        <span className="grow" />
        <button className="btn btn--sm btn--icon" title="Add table (T)" onClick={() => addTable()}>
          <Plus />
        </button>
        <button className="btn btn--sm btn--icon btn--ghost" title="Hide sidebar" onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose />
        </button>
      </div>
      <div className="sidebar__search row">
        <Search size={14} className="faint" />
        <input className="input input--sm grow" placeholder="Filter tables or columns" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sidebar__list">
        {filtered.length === 0 && <div className="sidebar__empty">{tables.length === 0 ? 'No tables yet. Add one or import SQL.' : 'No table matches the filter.'}</div>}
        {filtered.map((t) => {
          const active = selection.tableIds.includes(t.id);
          const traced = t.id === trace.fromId || t.id === trace.toId;
          return (
            <button
              key={t.id}
              className={`sidebar__item${active ? ' sidebar__item--active' : ''}${traced ? ' sidebar__item--trace' : ''}`}
              onClick={(e) => {
                selectTable(t.id, e.shiftKey);
                if (!e.shiftKey) focusTable(t.id);
              }}
              title={t.comment || t.name}
            >
              <span className="sidebar__dot" style={{ background: paletteHue(t.color) }} />
              <span className="sidebar__name">{t.name}</span>
              <span className="sidebar__count">{t.columns.length}</span>
            </button>
          );
        })}
        {notes.length > 0 && (
          <>
            <div className="sidebar__section">Notes</div>
            {notes.map((n) => (
              <button
                key={n.id}
                className={`sidebar__item${selection.noteId === n.id ? ' sidebar__item--active' : ''}`}
                onClick={() => setSelection({ noteId: n.id, tableIds: [], relationshipId: null })}
              >
                <StickyNote size={13} style={{ color: paletteHue(n.color) }} />
                <span className="sidebar__name muted">{n.text.split('\n')[0] || 'Empty note'}</span>
              </button>
            ))}
          </>
        )}
      </div>
      <ResizeHandle orientation="vertical" onResize={(delta) => resizePanel('sidebarW', delta)} />
    </aside>
  );
}
