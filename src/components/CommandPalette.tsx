import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  BookmarkPlus,
  Code2,
  Database,
  Download,
  Eye,
  FileDown,
  FileImage,
  FilePlus2,
  FolderOpen,
  Focus,
  HelpCircle,
  Library,
  Link,
  Maximize,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Route,
  Rows3,
  Save,
  Shapes,
  ShieldAlert,
  Shuffle,
  Sparkles,
  StickyNote,
  Sun,
  Table2,
  Terminal,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { DIALECTS, type Dialect } from '@shared/types';
import { useStore, type DrawerTab } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { fuzzyFilter } from '@/lib/fuzzy';
import { isContextMenuOpen } from './ui/ContextMenu';
import { useDialogStore } from './ui/Modal';

/** Actions the top bar owns (file dialogs, exports); exposed on window so the palette needs no prop drilling. */
export interface PaletteBridge {
  saveFile: () => void;
  openFile: () => void;
  newDiagram: () => void;
  loadSample: () => void;
  exportImage: (format: 'png' | 'svg') => void;
  exportAs: (format: 'sql' | 'mermaid' | 'dbml' | 'markdown') => void;
  shareLink: () => void;
  openLibrary: () => void;
  saveCheckpoint: () => void;
  switchDialect: (dialect: Dialect) => void;
}

export function getBridge(): Partial<PaletteBridge> {
  return ((window as unknown as { __dbviz?: Partial<PaletteBridge> }).__dbviz ?? {}) as Partial<PaletteBridge>;
}

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  hint?: string;
  icon?: LucideIcon;
  keywords?: string[];
  run: () => void;
}

const RECENT_KEY = 'dbviz:paletteRecent';

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const TABS: { id: DrawerTab; label: string; icon: LucideIcon }[] = [
  { id: 'sql', label: 'SQL', icon: Code2 },
  { id: 'types', label: 'Types', icon: Shapes },
  { id: 'import', label: 'Import SQL', icon: FileDown },
  { id: 'trace', label: 'Trace', icon: Route },
  { id: 'problems', label: 'Problems', icon: ShieldAlert },
  { id: 'query', label: 'Query', icon: Terminal },
  { id: 'database', label: 'Database', icon: Database },
];

function buildItems(): PaletteItem[] {
  const s = useStore.getState();
  const ui = useUi.getState();
  const bridge = getBridge();
  const d = s.diagram;
  const items: PaletteItem[] = [];
  const act = (id: string, group: string, label: string, run: () => void, extra: Partial<PaletteItem> = {}) => items.push({ id, group, label, run, ...extra });

  for (const t of d.tables) {
    act(
      `table:${t.id}`,
      'Go to',
      t.name,
      () => {
        s.selectTable(t.id);
        s.focusTable(t.id);
      },
      { icon: t.kind === 'view' ? Eye : Table2, detail: t.columns.map((c) => c.name).join(', ').slice(0, 80), keywords: t.columns.map((c) => c.name) },
    );
  }
  for (const g of d.groups) act(`group:${g.id}`, 'Go to', `Group: ${g.name}`, () => s.selectGroup(g.id), { icon: Boxes });

  const selected = s.selection.tableIds;
  act('new', 'File', 'New diagram', () => bridge.newDiagram?.(), { icon: FilePlus2 });
  act('open', 'File', 'Open file…', () => bridge.openFile?.(), { icon: FolderOpen, hint: 'Ctrl+O' });
  act('library', 'File', 'Open diagram library…', () => bridge.openLibrary?.(), { icon: Library, keywords: ['recent'] });
  act('save', 'File', 'Save as .dbviz.json', () => bridge.saveFile?.(), { icon: Save, hint: 'Ctrl+S' });
  act('checkpoint', 'File', 'Save checkpoint…', () => bridge.saveCheckpoint?.(), { icon: BookmarkPlus, keywords: ['snapshot', 'version'] });
  act('sample', 'File', 'Load example diagram', () => bridge.loadSample?.(), { icon: Sparkles });
  act('export-png', 'Export', 'Export PNG', () => bridge.exportImage?.('png'), { icon: FileImage });
  act('export-svg', 'Export', 'Export SVG', () => bridge.exportImage?.('svg'), { icon: FileImage });
  act('export-sql', 'Export', 'Export SQL script', () => bridge.exportAs?.('sql'), { icon: Download });
  act('export-md', 'Export', 'Export Markdown data dictionary', () => bridge.exportAs?.('markdown'), { icon: Download });
  act('export-mermaid', 'Export', 'Export Mermaid ER diagram', () => bridge.exportAs?.('mermaid'), { icon: Download });
  act('export-dbml', 'Export', 'Export DBML', () => bridge.exportAs?.('dbml'), { icon: Download });
  act('share', 'Export', 'Copy share link', () => bridge.shareLink?.(), { icon: Link });

  act('add-table', 'Edit', 'Add table', () => s.addTable(), { icon: Plus, hint: 'T' });
  act('add-view', 'Edit', 'Add view', () => s.addTable(undefined, { kind: 'view' }), { icon: Eye });
  act('add-note', 'Edit', 'Add note', () => s.addNote(), { icon: StickyNote, hint: 'N' });
  act('add-group', 'Edit', selected.length > 1 ? `Group the ${selected.length} selected tables` : 'Add a group region', () => s.addGroup({ tableIds: selected }), { icon: Boxes, hint: 'G' });
  act('add-enum', 'Edit', 'Add enum type', () => {
    s.addCustomType('enum');
    s.openDrawer('types');
  }, { icon: Shapes });
  act('add-composite', 'Edit', 'Add composite type', () => {
    s.addCustomType('composite');
    s.openDrawer('types');
  }, { icon: Shapes });
  act('undo', 'Edit', 'Undo', () => s.undo(), { icon: Undo2, hint: 'Ctrl+Z' });
  act('redo', 'Edit', 'Redo', () => s.redo(), { icon: Redo2, hint: 'Ctrl+Shift+Z' });
  if (selected.length === 1) act('duplicate', 'Edit', 'Duplicate selected table', () => s.duplicateTable(selected[0]), { icon: Plus });
  if (selected.length || s.selection.noteIds.length || s.selection.relationshipId || s.selection.groupId) {
    act('delete', 'Edit', 'Delete selection', () => s.deleteSelection(), { icon: Trash2, hint: 'Del' });
  }

  act('detangle-lr', 'Layout', 'Detangle left to right', () => s.applyLayout('LR'), { icon: Shuffle, hint: 'L' });
  act('detangle-tb', 'Layout', 'Detangle top to bottom', () => s.applyLayout('TB'), { icon: Shuffle });
  act('fit', 'Layout', 'Fit to window', () => s.requestFitView(), { icon: Maximize, hint: 'F' });
  act('collapse-all', 'Layout', 'Collapse all tables (keys only)', () => s.setTableDisplay(d.tables.map((t) => t.id), 'keys'), { icon: Rows3 });
  act('headers-all', 'Layout', 'Collapse all tables (header only)', () => s.setTableDisplay(d.tables.map((t) => t.id), 'header'), { icon: Rows3 });
  act('expand-all', 'Layout', 'Show all columns', () => s.setTableDisplay(d.tables.map((t) => t.id), undefined), { icon: Rows3 });
  if (selected.length === 1) act('focus', 'Layout', 'Focus on the selected table', () => ui.setFocus({ tableId: selected[0], hops: 1 }), { icon: Focus, hint: '.' });
  if (ui.focus) act('unfocus', 'Layout', 'Clear focus', () => ui.setFocus(null), { icon: Focus, hint: 'Esc' });
  act('snap', 'Layout', `${ui.snapToGrid ? 'Disable' : 'Enable'} snap to grid`, () => ui.setSnapToGrid(!ui.snapToGrid), { icon: Maximize });
  act('cardinality', 'Layout', `${ui.showCardinality ? 'Hide' : 'Show'} cardinality labels`, () => ui.setShowCardinality(!ui.showCardinality), { icon: Route });
  act('trace', 'Layout', 'Trace a path between two tables…', () => {
    s.openDrawer('trace');
    s.setTracePicking(true);
  }, { icon: Route });

  for (const t of TABS) act(`tab:${t.id}`, 'Panels', `Open ${t.label} tab`, () => s.openDrawer(t.id), { icon: t.icon });
  act('sidebar', 'Panels', `${s.sidebarOpen ? 'Hide' : 'Show'} table list`, () => s.setSidebarOpen(!s.sidebarOpen), { icon: PanelLeft });
  act('inspector', 'Panels', `${s.inspectorOpen ? 'Hide' : 'Show'} inspector`, () => s.setInspectorOpen(!s.inspectorOpen), { icon: PanelRight });
  act('drawer', 'Panels', `${s.drawer.open ? 'Hide' : 'Show'} bottom drawer`, () => s.toggleDrawer(), { icon: PanelBottom });
  act('theme', 'Panels', `Switch to ${s.theme === 'dark' ? 'light' : 'dark'} theme`, () => s.setTheme(s.theme === 'dark' ? 'light' : 'dark'), { icon: s.theme === 'dark' ? Sun : Moon });
  for (const dl of DIALECTS) {
    if (dl.id === d.dialect) continue;
    act(`dialect:${dl.id}`, 'Dialect', `Switch dialect to ${dl.label}`, () => bridge.switchDialect?.(dl.id), { icon: Database });
  }
  act('help', 'Help', 'Keyboard shortcuts and help', () => useDialogStore.getState().setHelp(true), { icon: HelpCircle, hint: '?' });
  return items;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<PaletteItem[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isContextMenuOpen()) return;
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const built = buildItems();
    const recent = loadRecent();
    // recently used actions float to the top when nothing is typed yet
    built.sort((a, b) => {
      const ra = recent.indexOf(a.id);
      const rb = recent.indexOf(b.id);
      if (ra === -1 && rb === -1) return 0;
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    });
    setItems(built);
  }, [open]);

  const visible = useMemo(() => {
    const filtered = fuzzyFilter(items, query, (i) => [i.label, ...(i.keywords ?? []), i.group]);
    return filtered.slice(0, 60);
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (item: PaletteItem) => {
    setOpen(false);
    pushRecent(item.id);
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(visible.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = visible[active];
      if (item) run(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          className="palette__input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a table name or a command…"
          spellCheck={false}
        />
        <div className="palette__list" ref={listRef}>
          {visible.length === 0 && <div className="palette__empty">Nothing matches “{query}”.</div>}
          {visible.map((item, i) => {
            const showGroup = !query && item.group !== lastGroup;
            lastGroup = item.group;
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {showGroup && <div className="palette__group">{item.group}</div>}
                <button
                  type="button"
                  data-index={i}
                  className={`palette__item${i === active ? ' palette__item--active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(item)}
                >
                  {Icon ? <Icon /> : <span style={{ width: 15 }} />}
                  <span className="palette__label">{item.label}</span>
                  {item.detail && <span className="palette__detail">{item.detail}</span>}
                  {item.hint && <span className="kbd">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette__foot">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span>Ctrl K toggles</span>
        </div>
      </div>
    </div>
  );
}

export { isEditable as isEditableTarget };
