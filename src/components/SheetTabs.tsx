import { useEffect, useRef, useState } from 'react';
import { Plus, Table2, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { addSheet, closeSheetWithConfirm } from '@/lib/sheets';
import { openContextMenu } from './ui/ContextMenu';
import '@/styles/sheets.css';
import { countLabel } from '@/lib/library';

/**
 * The tabs above the canvas: one per diagram in the workspace, the way a
 * spreadsheet puts its worksheets along the bottom. Switching tabs swaps the
 * whole canvas — including its own undo history and selection — and every tab
 * is saved in the one .dbviz.json file.
 */
export function SheetTabs() {
  const sheetIds = useStore((s) => s.sheetIds);
  const activeSheetId = useStore((s) => s.activeSheetId);
  const parked = useStore((s) => s.parked);
  const activeName = useStore((s) => s.diagram.name);
  const activeTables = useStore((s) => s.diagram.tables.length);
  const activeCode = useStore((s) => s.diagram.programs.length);
  const switchSheet = useStore((s) => s.switchSheet);
  const renameSheet = useStore((s) => s.renameSheet);
  const moveSheet = useStore((s) => s.moveSheet);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const tabs = sheetIds.map((id) => {
    const diagram = id === activeSheetId ? null : parked[id]?.diagram;
    return {
      id,
      name: id === activeSheetId ? activeName : (diagram?.name ?? 'Untitled diagram'),
      // The badge is "how much is on this tab", so a tab holding a code map
      // must not read 0. Both halves count, and the tooltip says which is which.
      tables: id === activeSheetId ? activeTables : (diagram?.tables.length ?? 0),
      code: id === activeSheetId ? activeCode : (diagram?.programs.length ?? 0),
    };
  });

  const startRename = (id: string, name: string) => {
    setDraft(name);
    setRenaming(id);
  };

  const commitRename = () => {
    if (renaming) renameSheet(renaming, draft);
    setRenaming(null);
  };

  return (
    <div className="sheets" role="tablist" aria-label="Diagrams in this workspace">
      {tabs.map((t, i) => {
        const active = t.id === activeSheetId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={`${t.name} — ${countLabel(t.tables, t.code)}. Double-click to rename, right-click for more.`}
            className={`sheets__tab${active ? ' sheets__tab--active' : ''}${dropIndex === i && dragId !== t.id ? ' sheets__tab--drop' : ''}`}
            draggable={renaming !== t.id}
            onClick={() => switchSheet(t.id)}
            onDoubleClick={() => startRename(t.id, t.name)}
            onContextMenu={(e) => {
              switchSheet(t.id);
              openContextMenu(e, { type: 'sheet', sheetId: t.id });
            }}
            onAuxClick={(e) => {
              // Middle-click closes, as in a browser.
              if (e.button === 1) {
                e.preventDefault();
                void closeSheetWithConfirm(t.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'F2') startRename(t.id, t.name);
            }}
            onDragStart={(e) => {
              setDragId(t.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', t.name);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropIndex(i);
            }}
            onDrop={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.stopPropagation();
              moveSheet(dragId, i);
              setDragId(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropIndex(null);
            }}
          >
            {renaming === t.id ? (
              <input
                ref={inputRef}
                className="sheets__rename"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <>
                <Table2 className="sheets__icon" />
                <span className="sheets__name">{t.name}</span>
                <span className="sheets__count">{t.tables + t.code}</span>
                <button
                  className="sheets__close"
                  title={tabs.length === 1 ? 'Empty this diagram' : `Close "${t.name}"`}
                  aria-label={`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeSheetWithConfirm(t.id);
                  }}
                >
                  <X />
                </button>
              </>
            )}
          </div>
        );
      })}
      <button className="sheets__add" onClick={addSheet} title="Add another diagram to this workspace" aria-label="Add a diagram">
        <Plus />
      </button>
      <span className="sheets__spacer" />
      {tabs.length > 1 && (
        <span className="sheets__hint">
          {tabs.length} diagrams, one file · <span className="kbd">Ctrl+PgUp/PgDn</span>
        </span>
      )}
    </div>
  );
}
