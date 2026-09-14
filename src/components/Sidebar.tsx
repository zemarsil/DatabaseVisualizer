import { useMemo, useState } from 'react';
import { Box, Boxes, Cpu, Database, Eye, FileCode, PanelLeftClose, Plus, Search, SquareFunction, StickyNote, type LucideIcon } from 'lucide-react';
import { codeKindOf, type CodeKind, type Program, type Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { codeChildren } from '@/lib/codemap';
import { paletteHue } from '@/lib/palette';
import { openContextMenu } from '@/components/ui/ContextMenu';
import { ResizeHandle } from '@/components/ui/ResizeHandle';

const KIND_ICON: Record<CodeKind, LucideIcon> = { program: Cpu, module: FileCode, class: Box, function: SquareFunction };

export function Sidebar() {
  const tables = useStore((s) => s.diagram.tables);
  const notes = useStore((s) => s.diagram.notes);
  const programs = useStore((s) => s.diagram.programs);
  const groups = useStore((s) => s.diagram.groups);
  const diagram = useStore((s) => s.diagram);
  const selection = useStore((s) => s.selection);
  const trace = useStore((s) => s.trace);
  const selectTable = useStore((s) => s.selectTable);
  const focusTable = useStore((s) => s.focusTable);
  const setSelection = useStore((s) => s.setSelection);
  const selectGroup = useStore((s) => s.selectGroup);
  const addTable = useStore((s) => s.addTable);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const resizePanel = useStore((s) => s.resizePanel);
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

  // The code side is a tree: a program holds modules, a module classes and
  // functions. A filter keeps a node when it or anything inside it matches, so
  // the path to a match stays readable.
  const codeTree = useMemo(() => {
    const children = codeChildren(diagram);
    const q = query.trim().toLowerCase();
    const matches = (p: Program): boolean => !q || p.name.toLowerCase().includes(q) || (children.get(p.id) ?? []).some(matches);
    const rows: { p: Program; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const p of children.get(parent) ?? []) {
        if (!matches(p)) continue;
        rows.push({ p, depth });
        walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [diagram, query]);

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
        onContextMenu={(e) => {
          if (!selection.tableIds.includes(t.id)) setSelection({ tableIds: [t.id], relationshipId: null, noteIds: [] });
          openContextMenu(e, { type: 'table', tableId: t.id });
        }}
        title={t.comment || t.name}
      >
        {t.kind === 'view' ? <Eye size={12} style={{ color: paletteHue(t.color), flex: 'none' }} /> : <span className="sidebar__dot" style={{ background: paletteHue(t.color) }} />}
        <span className="sidebar__name">{t.name}</span>
        <span className="sidebar__count">{t.columns.length}</span>
      </button>
    );
  };

  return (
    <aside className="sidebar" data-tour="sidebar">
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
        <input className="input input--sm grow" placeholder="Filter tables, columns or code" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sidebar__list">
        {filtered.length === 0 && programs.length === 0 && <div className="sidebar__empty">{tables.length === 0 ? 'No tables yet. Add one or import SQL.' : 'No table matches the filter.'}</div>}

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

        {codeTree.length > 0 && (
          <>
            <div className="sidebar__section">Code</div>
            {codeTree.map(({ p, depth }) => {
              const Icon = KIND_ICON[codeKindOf(p)];
              const traced = p.id === trace.fromId || p.id === trace.toId;
              return (
                <button
                  key={p.id}
                  className={`sidebar__item${selection.programIds.includes(p.id) ? ' sidebar__item--active' : ''}${traced ? ' sidebar__item--trace' : ''}`}
                  style={{ paddingLeft: 10 + depth * 14 }}
                  onClick={() => {
                    setSelection({ programIds: [p.id], tableIds: [], noteIds: [], relationshipId: null, groupId: null });
                    focusTable(p.id);
                  }}
                  onContextMenu={(e) => {
                    if (!selection.programIds.includes(p.id)) setSelection({ programIds: [p.id], tableIds: [], noteIds: [], relationshipId: null });
                    openContextMenu(e, { type: 'program', programId: p.id });
                  }}
                  title={p.comment || p.entrypoint || p.name}
                >
                  <Icon size={13} style={{ color: paletteHue(p.color), flex: 'none' }} />
                  <span className={`sidebar__name${p.collapsed ? ' muted' : ''}`}>{p.name}</span>
                  <span className="sidebar__count">{p.steps.length}</span>
                </button>
              );
            })}
          </>
        )}

        {notes.length > 0 && (
          <>
            <div className="sidebar__section">Notes</div>
            {notes.map((n) => (
              <button
                key={n.id}
                className={`sidebar__item${selection.noteIds.includes(n.id) ? ' sidebar__item--active' : ''}`}
                onClick={() => setSelection({ noteIds: [n.id], tableIds: [], relationshipId: null, groupId: null })}
                onContextMenu={(e) => {
                  if (!selection.noteIds.includes(n.id)) setSelection({ noteIds: [n.id], tableIds: [], relationshipId: null });
                  openContextMenu(e, { type: 'note', noteId: n.id });
                }}
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
