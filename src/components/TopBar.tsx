import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  BookmarkPlus,
  Boxes,
  Check,
  ChevronDown,
  Database,
  Download,
  Eye,
  FileImage,
  FilePlus2,
  FileText,
  FolderOpen,
  HelpCircle,
  Library,
  Link,
  Maximize,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Redo2,
  Route,
  Rows3,
  Save,
  Search,
  Shapes,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Sun,
  Undo2,
} from 'lucide-react';
import { DIALECTS, type Dialect } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { simulationTargets } from '@/lib/simulate/engine';
import { downloadDataUrl, downloadText, fileSlug, parseDiagramFile, serializeDiagram, FILE_EXTENSION } from '@/lib/io';
import { exportDiagramImage } from '@/lib/exportImage';
import { EXPORT_FORMATS, exportDiagram, type ExportFormat } from '@/lib/export';
import { copyShareLink } from '@/lib/share';
import { defaultCheckpointName, installLibraryAutosave, saveCheckpoint, startFreshDiagramEntry } from '@/lib/library';
import { useBeforeUnload } from '@/hooks/useBeforeUnload';
import { confirmDialog, promptDialog, useDialogStore } from './ui/Modal';
import { CommandPalette, type PaletteBridge } from './CommandPalette';
import { LibraryDialog } from './LibraryDialog';
import { CHECKPOINTS_EVENT } from './inspector/Checkpoints';
import '@/styles/workbench.css';

function Menu({ label, icon, children, align = 'right', title, 'data-tour': tour }: { label?: string; icon: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; title?: string; 'data-tour'?: string }) {
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
      <button data-tour={tour} className={`btn${label ? '' : ' btn--icon'}${open ? ' btn--active' : ''}`} onClick={() => setOpen((o) => !o)} title={title ?? label}>
        {icon}
        {label && <span>{label}</span>}
        {label && <ChevronDown size={14} />}
      </button>
      {open && <div className={`menu__popover${align === 'left' ? ' menu__popover--left' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** A menu row with a tick that shows whether the option is on. Stays open so several can be flipped in a row. */
function CheckItem({ on, label, onToggle, hint }: { on: boolean; label: string; onToggle: () => void; hint?: string }) {
  return (
    <button className="menu__item" role="menuitemcheckbox" aria-checked={on} onClick={onToggle}>
      <Check className={`menu__check${on ? '' : ' menu__check--off'}`} /> {label}
      {hint && <span className="kbd">{hint}</span>}
    </button>
  );
}

export function TopBar() {
  const diagram = useStore((s) => s.diagram);
  const dirty = useStore((s) => s.dirty);
  const fileBacked = useStore((s) => s.fileBacked);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const drawerOpen = useStore((s) => s.drawer.open);
  const layoutDirection = useStore((s) => s.layoutDirection);
  const selection = useStore((s) => s.selection);
  const tracePicking = useStore((s) => s.trace.picking);
  const simulating = useSimulation((s) => s.targetId !== null);

  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setDiagramName = useStore((s) => s.setDiagramName);
  const setDialect = useStore((s) => s.setDialect);
  const addTable = useStore((s) => s.addTable);
  const addNote = useStore((s) => s.addNote);
  const addGroup = useStore((s) => s.addGroup);
  const addCustomType = useStore((s) => s.addCustomType);
  const applyLayout = useStore((s) => s.applyLayout);
  const setTableDisplay = useStore((s) => s.setTableDisplay);
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

  const snapToGrid = useUi((s) => s.snapToGrid);
  const setSnapToGrid = useUi((s) => s.setSnapToGrid);
  const showCardinality = useUi((s) => s.showCardinality);
  const setShowCardinality = useUi((s) => s.setShowCardinality);
  const warnOnClose = useUi((s) => s.warnOnClose);
  const setWarnOnClose = useUi((s) => s.setWarnOnClose);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const setLibraryOpen = useUi((s) => s.setLibraryOpen);

  const { getNodes, getNodesBounds } = useReactFlow();
  const fileInput = useRef<HTMLInputElement>(null);

  useBeforeUnload();
  useEffect(() => {
    installLibraryAutosave();
  }, []);

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
      await startFreshDiagramEntry();
      setDiagram(d, { fileBacked: true });
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

  const exportAs = (format: ExportFormat) => {
    if (diagram.tables.length === 0) {
      toast('error', 'There is nothing to export yet.');
      return;
    }
    const out = exportDiagram(diagram, format);
    downloadText(out.filename, out.text, out.mime);
    toast('success', `Exported ${EXPORT_FORMATS.find((f) => f.id === format)?.label ?? format}.`);
  };

  const shareLink = async () => {
    if (diagram.tables.length === 0) {
      toast('error', 'There is nothing to share yet.');
      return;
    }
    try {
      const { warning } = await copyShareLink(diagram);
      toast('success', 'Share link copied. Anyone who opens it gets a copy of this diagram.');
      if (warning) toast('info', warning);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not copy the link.');
    }
  };

  const onNew = async () => {
    if (diagram.tables.length && !(await confirmDialog({ title: 'Start a new diagram?', message: 'The current diagram stays in the diagram library (File → Open recent…); a new, empty one takes its place on the canvas.', confirmLabel: 'New diagram' }))) return;
    await startFreshDiagramEntry();
    newDiagram(diagram.dialect);
  };

  const onLoadSample = async () => {
    if (diagram.tables.length && !(await confirmDialog({ title: 'Load the example diagram?', message: 'The current diagram stays in the diagram library (File → Open recent…); the example takes its place on the canvas.', confirmLabel: 'Load example' }))) return;
    await startFreshDiagramEntry();
    loadSample();
  };

  const onSaveCheckpoint = async () => {
    const name = await promptDialog({ title: 'Save checkpoint', label: 'Name', value: defaultCheckpointName(), confirmLabel: 'Save', placeholder: 'e.g. before splitting orders' });
    if (name === null) return;
    try {
      const rec = await saveCheckpoint(name);
      toast('success', `Saved checkpoint "${rec.name}". Restore it from the Diagram panel in the inspector.`);
      window.dispatchEvent(new Event(CHECKPOINTS_EVENT));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'The checkpoint could not be saved.');
    }
  };

  /**
   * Simulate into the selected table when a flow feeds it; otherwise open the
   * Simulate tab, which offers every table that can be fed. A second press
   * leaves the mode.
   */
  const onSimulate = () => {
    const sim = useSimulation.getState();
    if (sim.targetId) {
      sim.stop();
      return;
    }
    const fed = simulationTargets(diagram);
    const picked = selection.tableIds.find((id) => fed.some((t) => t.id === id));
    if (picked) sim.start(picked);
    else openDrawer('simulate');
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
    // expose actions to the keyboard handler in App and the command palette without prop drilling
    const bridge: PaletteBridge = {
      saveFile,
      openFile,
      newDiagram: () => void onNew(),
      loadSample: () => void onLoadSample(),
      exportImage: (format) => void exportImage(format),
      exportAs,
      shareLink: () => void shareLink(),
      openLibrary: () => setLibraryOpen(true),
      saveCheckpoint: () => void onSaveCheckpoint(),
      switchDialect: onDialectChange,
    };
    (window as unknown as { __dbviz: PaletteBridge }).__dbviz = bridge;
  });

  const allTableIds = diagram.tables.map((t) => t.id);

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
      {dirty && fileBacked && <span className="topbar__unsaved" title="Changed since the last save (Ctrl+S)" />}
      <input data-tour="diagram-name" className="topbar__name" value={diagram.name} onChange={(e) => setDiagramName(e.target.value)} placeholder="Diagram name" spellCheck={false} />
      <select data-tour="dialect" className="dialect-select select" value={diagram.dialect} onChange={(e) => onDialectChange(e.target.value as Dialect)} title="SQL dialect">
        {DIALECTS.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>

      <span className="topbar__sep" />
      <div className="topbar__group">
        <button data-tour="undo" className="btn btn--icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 />
        </button>
        <button data-tour="redo" className="btn btn--icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <Redo2 />
        </button>
      </div>
      <span className="topbar__sep" />
      <div className="topbar__group">
        <button data-tour="add-table" className="btn" onClick={() => addTable()} title="Add table (T)">
          <Plus /> Table
        </button>
        <Menu icon={<ChevronDown />} align="left" title="More things to add" data-tour="add-menu">
          {(close) => (
            <>
              <button className="menu__item" onClick={() => void (close(), addTable())}>
                <Plus /> Table <span className="kbd">T</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), addTable(undefined, { kind: 'view' }))}>
                <Eye /> View
              </button>
              <button className="menu__item" onClick={() => void (close(), addNote())}>
                <StickyNote /> Note <span className="kbd">N</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), addGroup({ tableIds: selection.tableIds }))}>
                <Boxes /> {selection.tableIds.length > 1 ? `Group the ${selection.tableIds.length} selected tables` : 'Group region'} <span className="kbd">G</span>
              </button>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), addCustomType('enum'), openDrawer('types'))}>
                <Shapes /> Enum type
              </button>
              <button className="menu__item" onClick={() => void (close(), addCustomType('composite'), openDrawer('types'))}>
                <Shapes /> Composite type
              </button>
            </>
          )}
        </Menu>
        <button
          className="btn btn--icon"
          data-tour="add-group"
          onClick={() => addGroup({ tableIds: selection.tableIds })}
          title={selection.tableIds.length > 1 ? `Group the ${selection.tableIds.length} selected tables (G)` : 'Add a group region (G)'}
        >
          <Boxes />
        </button>
        <button data-tour="add-note" className="btn btn--icon" onClick={() => addNote()} title="Add note (N)">
          <StickyNote />
        </button>
      </div>
      <span className="topbar__sep" />
      <div className="topbar__group">
        <button data-tour="detangle" className="btn" onClick={() => applyLayout()} title="Auto-layout: untangle connections (L)">
          <Shuffle /> Detangle
        </button>
        <Menu icon={<ChevronDown />} align="left" title="Layout direction" data-tour="layout-menu">
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
        <button data-tour="trace" className={`btn${tracePicking ? ' btn--active' : ''}`} onClick={onTrace} title="Trace a connection between two tables">
          <Route /> Trace
        </button>
        <button data-tour="simulate" className={`btn${simulating ? ' btn--active' : ''}`} onClick={onSimulate} title={simulating ? 'Leave simulation mode (Esc)' : 'Simulate data flowing into the selected table (S)'}>
          <Play /> Simulate
        </button>
        <button data-tour="fit" className="btn btn--icon" onClick={requestFitView} title="Fit to window (F)">
          <Maximize />
        </button>
      </div>
      <span className="topbar__sep" />
      <button data-tour="palette" className="btn" onClick={() => setPaletteOpen(true)} title="Command palette: jump to a table or run any action (Ctrl+K)">
        <Search /> <span className="kbd">Ctrl K</span>
      </button>

      <span className="topbar__spacer" />

      <div className="topbar__group">
        <button data-tour="database" className={`btn${drawerOpen ? ' btn--active' : ''}`} onClick={() => toggleDrawer('database')} title="Docker & database">
          <Database /> Database
        </button>
        <Menu label="File" icon={<Save />} data-tour="file-menu">
          {(close) => (
            <>
              <button className="menu__item" onClick={() => void (close(), onNew())}>
                <FilePlus2 /> New diagram
              </button>
              <button className="menu__item" onClick={() => void (close(), openFile())}>
                <FolderOpen /> Open… <span className="kbd">Ctrl+O</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), setLibraryOpen(true))}>
                <Library /> Open recent…
              </button>
              <button className="menu__item" onClick={() => void (close(), saveFile())}>
                <Save /> Save as .dbviz.json <span className="kbd">Ctrl+S</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), onSaveCheckpoint())}>
                <BookmarkPlus /> Save checkpoint…
              </button>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), exportImage('png'))}>
                <FileImage /> Export PNG
              </button>
              <button className="menu__item" onClick={() => void (close(), exportImage('svg'))}>
                <FileImage /> Export SVG
              </button>
              <button className="menu__item" onClick={() => void (close(), exportAs('sql'))}>
                <Download /> Export SQL script
              </button>
              <button className="menu__item" onClick={() => void (close(), exportAs('markdown'))}>
                <FileText /> Export Markdown
              </button>
              <button className="menu__item" onClick={() => void (close(), exportAs('mermaid'))}>
                <FileText /> Export Mermaid ER diagram
              </button>
              <button className="menu__item" onClick={() => void (close(), exportAs('dbml'))}>
                <FileText /> Export DBML
              </button>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), shareLink())}>
                <Link /> Copy share link
              </button>
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), onLoadSample())}>
                <Sparkles /> Load example diagram
              </button>
            </>
          )}
        </Menu>
        <Menu label="View" icon={<SlidersHorizontal />} data-tour="view-menu">
          {(close) => (
            <>
              <CheckItem on={sidebarOpen} label="Table list" onToggle={() => setSidebarOpen(!sidebarOpen)} />
              <CheckItem on={inspectorOpen} label="Inspector" onToggle={() => setInspectorOpen(!inspectorOpen)} />
              <CheckItem on={drawerOpen} label="Bottom drawer" onToggle={() => toggleDrawer()} />
              <CheckItem on={theme === 'dark'} label="Dark theme" onToggle={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
              <div className="menu__sep" />
              <CheckItem on={showCardinality} label="Cardinality labels" onToggle={() => setShowCardinality(!showCardinality)} />
              <CheckItem on={snapToGrid} label="Snap to grid" onToggle={() => setSnapToGrid(!snapToGrid)} />
              <CheckItem on={warnOnClose} label="Warn before closing unsaved" onToggle={() => setWarnOnClose(!warnOnClose)} />
              <div className="menu__sep" />
              <div className="menu__label">All tables</div>
              <button className="menu__item" onClick={() => void (close(), setTableDisplay(allTableIds, undefined))}>
                <Rows3 /> Show every column
              </button>
              <button className="menu__item" onClick={() => void (close(), setTableDisplay(allTableIds, 'keys'))}>
                <Rows3 /> Keys only
              </button>
              <button className="menu__item" onClick={() => void (close(), setTableDisplay(allTableIds, 'header'))}>
                <Rows3 /> Headers only
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
        <button data-tour="help" className="btn btn--icon btn--ghost" onClick={() => setHelp(true)} title="Help (?)">
          <HelpCircle />
        </button>
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={onFileChosen} />
      <CommandPalette />
      <LibraryDialog />
    </header>
  );
}
