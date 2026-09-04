import { useMemo, useState } from 'react';
import { Boxes, Database, PanelLeftClose, Plus, Search, StickyNote } from 'lucide-react';
import type { Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { paletteHue } from '@/lib/palette';

export function Sidebar() {
  const tables = useStore((s) => s.diagram.tables);
  const notes = useStore((s) => s.diagram.notes);
  const groups = useStore((s) => s.diagram.groups);
  const selection = useStore((s) => s.selection);
  const trace = useStore((s) => s.trace);
  const selectTable = useStore((s) => s.selectTable);
  const focusTable = useStore((s) => s.focusTable);
  const setSelection = useStore((s) => s.setSelection);
  const selectGroup = useStore((s) => s.selectGroup);
  const addTable = useStore((s) => s.addTable);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q))) : tables;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [tables, query]);

  /** Tables split by group, in the order the groups were created; ungrouped last. */
  const sections = useMemo(() => {
    const byGroup = new Map<string, Table[]>(groups.map((g) => [g.id, []]));
    const ungrouped: Table[] = [];
    for (const t of filtered) {
      const bucket = t.groupId ? byGroup.get(t.groupId) : undefined;
      if (bucket) bucket.push(t);
      else ungrouped.push(t);
    }
    return { byGroup, ungrouped };
  }, [filtered, groups]);

  const renderTable = (t: Table) => {
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
  };

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

        {groups.map((g) => {
          const members = sections.byGroup.get(g.id) ?? [];
          if (members.length === 0 && query.trim()) return null;
          return (
            <div key={g.id} className="sidebar__group">
              <button
                className={`sidebar__group-head${selection.groupId === g.id ? ' sidebar__group-head--active' : ''}`}
                style={{ '--hue': paletteHue(g.color) } as React.CSSProperties}
                onClick={() => selectGroup(g.id)}
                title={g.note || (g.external ? 'Tables in another database' : 'Table group')}
              >
                {g.external ? <Database /> : <Boxes />}
                <span className="sidebar__name">{g.name}</span>
                {g.external && <span className="sidebar__ext">ext</span>}
                <span className="sidebar__count">{members.length}</span>
              </button>
              {members.map(renderTable)}
              {members.length === 0 && <div className="sidebar__empty small">No tables in this group yet.</div>}
            </div>
          );
        })}

        {groups.length > 0 && sections.ungrouped.length > 0 && <div className="sidebar__section">Ungrouped</div>}
        {sections.ungrouped.map(renderTable)}

        {notes.length > 0 && (
          <>
            <div className="sidebar__section">Notes</div>
            {notes.map((n) => (
              <button
                key={n.id}
                className={`sidebar__item${selection.noteId === n.id ? ' sidebar__item--active' : ''}`}
                onClick={() => setSelection({ noteId: n.id, tableIds: [], relationshipId: null, groupId: null })}
              >
                <StickyNote size={13} style={{ color: paletteHue(n.color) }} />
                <span className="sidebar__name muted">{n.text.split('\n')[0] || 'Empty note'}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
