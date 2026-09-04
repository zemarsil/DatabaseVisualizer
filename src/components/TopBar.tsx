import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  Boxes,
  ChevronDown,
  Database,
  Download,
  FileImage,
  FilePlus2,
  FileText,
  FolderOpen,
  HelpCircle,
  Maximize,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Route,
  Save,
  Shuffle,
  Sparkles,
  StickyNote,
  Sun,
  Undo2,
} from 'lucide-react';
import { DIALECTS, type Dialect } from '@shared/types';
import { useStore } from '@/store/useStore';
import { downloadDataUrl, downloadText, fileSlug, parseDiagramFile, serializeDiagram, FILE_EXTENSION } from '@/lib/io';
import { exportDiagramImage } from '@/lib/exportImage';
import { generateSchema } from '@/lib/sql/generator';
import { generateMarkdown } from '@/lib/markdownExport';
import { confirmDialog, useDialogStore } from './ui/Modal';

function Menu({ label, icon, children, align = 'right' }: { label?: string; icon: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`btn${label ? '' : ' btn--icon'}${open ? ' btn--active' : ''}`} onClick={() => setOpen((o) => !o)} title={label}>
        {icon}
        {label && <span>{label}</span>}
        {label && <ChevronDown size={14} />}
      </button>
      {open && <div className={`menu__popover${align === 'left' ? ' menu__popover--left' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function TopBar() {
  const diagram = useStore((s) => s.diagram);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const drawerOpen = useStore((s) => s.drawer.open);
  const layoutDirection = useStore((s) => s.layoutDirection);
  const selection = useStore((s) => s.selection);
  const tracePicking = useStore((s) => s.trace.picking);

  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setDiagramName = useStore((s) => s.setDiagramName);
  const setDialect = useStore((s) => s.setDialect);
  const addTable = useStore((s) => s.addTable);
  const addNote = useStore((s) => s.addNote);
  const addGroup = useStore((s) => s.addGroup);
  const applyLayout = useStore((s) => s.applyLayout);
  const setTheme = useStore((s) => s.setTheme);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const toggleDrawer = useStore((s) => s.toggleDrawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const setDiagram = useStore((s) => s.setDiagram);
  const newDiagram = useStore((s) => s.newDiagram);
  const loadSample = useStore((s) => s.loadSample);
  const markSaved = useStore((s) => s.markSaved);
  const toast = useStore((s) => s.toast);
  const requestFitView = useStore((s) => s.requestFitView);
  const setTraceEndpoints = useStore((s) => s.setTraceEndpoints);
  const runTrace = useStore((s) => s.runTrace);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const setHelp = useDialogStore((s) => s.setHelp);

  const { getNodes, getNodesBounds } = useReactFlow();
  const fileInput = useRef<HTMLInputElement>(null);

  const onDialectChange = (dialect: Dialect) => {
    if (dialect === diagram.dialect) return;
    setDialect(dialect, true);
    const label = DIALECTS.find((d) => d.id === dialect)?.label ?? dialect;
    toast('info', `Dialect set to ${label}. Known column types were translated (undo to revert).`);
  };

  const saveFile = () => {
    downloadText(`${fileSlug(diagram.name)}${FILE_EXTENSION}`, serializeDiagram(diagram));
    markSaved();
    toast('success', 'Diagram saved.');
  };

  const openFile = () => fileInput.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const d = parseDiagramFile(await file.text());
      setDiagram(d);
      toast('success', `Loaded "${d.name}" (${d.tables.length} tables).`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not load the file.');
    }
  };

  const exportImage = async (format: 'png' | 'svg') => {
    try {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#0c0e14';
      const nodes = getNodes();
      if (nodes.length === 0) throw new Error('There is nothing to export yet.');
      const url = await exportDiagramImage(getNodesBounds(nodes), format, { background: bg });
      downloadDataUrl(`${fileSlug(diagram.name)}.${format}`, url);
      toast('success', `Exported ${format.toUpperCase()}.`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Export failed.');
    }
  };

  const exportSql = () => {
    const out = generateSchema(diagram);
    downloadText(`${fileSlug(diagram.name)}.sql`, out.script, 'text/sql');
  };

  const exportMarkdown = () => {
    if (diagram.tables.length === 0) {
      toast('error', 'There is nothing to export yet.');
      return;
    }
    downloadText(`${fileSlug(diagram.name)}.md`, generateMarkdown(diagram), 'text/markdown');
    toast('success', 'Exported Markdown.');
  };

  const onNew = async () => {
    if (diagram.tables.length && !(await confirmDialog({ title: 'Start a new diagram?', message: 'The current diagram will be replaced. Save it first if you want to keep it.', confirmLabel: 'New diagram', danger: true }))) return;
    newDiagram(diagram.dialect);
  };

  const onTrace = () => {
    if (tracePicking) {
      setTracePicking(false);
      return;
    }
    if (selection.tableIds.length >= 2) {
      setTraceEndpoints(selection.tableIds[0], selection.tableIds[1]);
      runTrace();
      return;
    }
    openDrawer('trace');
    setTracePicking(true);
  };

  useEffect(() => {
    // expose actions to the keyboard handler in App without prop drilling
    (window as unknown as { __dbviz: Record<string, () => void> }).__dbviz = { saveFile, openFile };
  });

  return (
    <header className="topbar">
      <div className="topbar__brand" title="Database Visualizer">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--bg-hover)" />
          <rect x="5" y="6" width="10" height="7" rx="1.5" fill="#7aa2f7" />
          <rect x="17" y="19" width="10" height="7" rx="1.5" fill="#4fd1c5" />
          <path d="M15 9.5h4v13h-2" fill="none" stroke="#e0af68" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>DB Visualizer</span>
      </div>
      <input className="topbar__name" value={diagram.name} onChange={(e) => setDiagramName(e.target.value)} placeholder="Diagram name" spellCheck={false} />
      <select className="dialect-select select" value={diagram.dialect} onChange={(e) => onDialectChange(e.target.value as Dialect)} title="SQL dialect">
        {DIALECTS.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>

      <span className="topbar__sep" />
      <div className="topbar__group">
        <button className="btn btn--icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 />
        </button>
        <button className="btn btn--icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <Redo2 />
        </button>
      </div>
      <span className="topbar__sep" />
      <div className="topbar__group">
        <button className="btn" onClick={() => addTable()} title="Add table (T)">
          <Plus /> Table
        </button>
        <button
          className="btn btn--icon"
          onClick={() => addGroup({ tableIds: selection.tableIds })}
          title={selection.tableIds.length > 1 ? `Group the ${selection.tableIds.length} selected tables (G)` : 'Add a group region (G)'}
        >
          <Boxes />
        </button>
        <button className="btn btn--icon" onClick={() => addNote()} title="Add note (N)">
          <StickyNote />
        </button>
      </div>
      <span className="topbar__sep" />
      <div className="topbar__group">
        <button className="btn" onClick={() => applyLayout()} title="Auto-layout: untangle connections (L)">
          <Shuffle /> Detangle
        </button>
        <Menu icon={<ChevronDown />}>
          {(close) => (
            <>
              <div className="menu__label">Layout direction</div>
              <button
                className="menu__item"
                onClick={() => {
                  applyLayout('LR');
                  close();
                }}
              >
                {layoutDirection === 'LR' ? '●' : '○'} Left to right
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  applyLayout('TB');
                  close();
                }}
              >
                {layoutDirection === 'TB' ? '●' : '○'} Top to bottom
              </button>
            </>
          )}
        </Menu>
        <button className={`btn${tracePicking ? ' btn--active' : ''}`} onClick={onTrace} title="Trace a connection between two tables">
          <Route /> Trace
        </button>
        <button className="btn btn--icon" onClick={requestFitView} title="Fit to window (F)">
          <Maximize />
        </button>
      </div>

      <span className="topbar__spacer" />

      <div className="topbar__group">
        <button className={`btn${drawerOpen ? ' btn--active' : ''}`} onClick={() => toggleDrawer('database')} title="Docker & database">
          <Database /> Database
        </button>
        <Menu label="File" icon={<Save />}>
          {(close) => (
            <>
              <button className="menu__item" onClick={() => void (close(), onNew())}>
                <FilePlus2 /> New diagram
              </button>
              <button className="menu__item" onClick={() => void (close(), openFile())}>
                <FolderOpen /> Open… <span className="kbd">Ctrl+O</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), saveFile())}>
                <Save /> Save as .dbviz.json <span className="kbd">Ctrl+S</span>
              </button>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), exportImage('png'))}>
                <FileImage /> Export PNG
              </button>
              <button className="menu__item" onClick={() => void (close(), exportImage('svg'))}>
                <FileImage /> Export SVG
              </button>
              <button className="menu__item" onClick={() => void (close(), exportSql())}>
                <Download /> Export SQL script
              </button>
              <button className="menu__item" onClick={() => void (close(), exportMarkdown())}>
                <FileText /> Export Markdown
              </button>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), loadSample())}>
                <Sparkles /> Load example diagram
              </button>
            </>
          )}
        </Menu>
      </div>
      <span className="topbar__sep" />
      <div className="topbar__group">
        <button className={`btn btn--icon btn--ghost${sidebarOpen ? ' btn--active' : ''}`} onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle table list">
          <PanelLeft />
        </button>
        <button className={`btn btn--icon btn--ghost${drawerOpen ? ' btn--active' : ''}`} onClick={() => toggleDrawer()} title="Toggle SQL / database drawer">
          <PanelBottom />
        </button>
        <button className={`btn btn--icon btn--ghost${inspectorOpen ? ' btn--active' : ''}`} onClick={() => setInspectorOpen(!inspectorOpen)} title="Toggle inspector">
          <PanelRight />
        </button>
        <button className="btn btn--icon btn--ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
        <button className="btn btn--icon btn--ghost" onClick={() => setHelp(true)} title="Help (?)">
          <HelpCircle />
        </button>
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={onFileChosen} />
    </header>
  );
}
