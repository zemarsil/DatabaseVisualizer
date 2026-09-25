import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  DatabaseZap,
  BookmarkPlus,
  Box,
  Boxes,
  Braces,
  Check,
  Cpu,
  FileCode,
  SquareFunction,
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
  Table2,
  Undo2,
} from 'lucide-react';
import { DIALECTS, codeKindMeta, codeKindOf, type CodeKind, type Dialect } from '@shared/types';
import { currentWorkspace, selectEmphasis, selectShowsDatabaseTools, useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { simulationTargets } from '@/lib/simulate/engine';
import { downloadDataUrl, downloadText, fileSlug, parseWorkspaceFile, serializeWorkspace, FILE_EXTENSION } from '@/lib/io';
import { exportDiagramImage } from '@/lib/exportImage';
import { EXPORT_FORMATS, exportDiagram, type ExportFormat } from '@/lib/export';
import { copyShareLink } from '@/lib/share';
import { hasContent } from '@/lib/emphasis';
import { addSheet as addSheetToWorkspace } from '@/lib/sheets';
import { defaultCheckpointName, installLibraryAutosave, saveCheckpoint, startFreshWorkspaceEntry } from '@/lib/library';
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

/** The one-line explanation of a code kind, straight from the model. */
const kindHint = (kind: CodeKind): string => codeKindMeta(kind).hint;

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
  const workspaceName = useStore((s) => s.workspaceName);
  const sheetCount = useStore((s) => s.sheetIds.length);
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
  // What this diagram leans towards, and whether the schema half of the app is
  // worth putting on screen. Never a lock: adding one table flips `dbTools` to
  // true on its own, so nothing here has to be undone to go the database route.
  const emphasis = useStore(selectEmphasis);
  const dbTools = useStore(selectShowsDatabaseTools);

  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setDialect = useStore((s) => s.setDialect);
  const addTable = useStore((s) => s.addTable);
  const addNote = useStore((s) => s.addNote);
  const addProgram = useStore((s) => s.addProgram);
  const addGroup = useStore((s) => s.addGroup);
  const addCustomType = useStore((s) => s.addCustomType);
  const setEmphasis = useStore((s) => s.setEmphasis);
  const applyLayout = useStore((s) => s.applyLayout);
  const setTableDisplay = useStore((s) => s.setTableDisplay);
  const setTheme = useStore((s) => s.setTheme);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const toggleDrawer = useStore((s) => s.toggleDrawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const setWorkspaceName = useStore((s) => s.setWorkspaceName);
  const newWorkspace = useStore((s) => s.newWorkspace);
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
  const derivedLens = useUi((s) => s.derived !== null);
  const toggleDerived = useUi((s) => s.toggleDerived);
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
    const ws = currentWorkspace(useStore.getState());
    downloadText(`${fileSlug(ws.name)}${FILE_EXTENSION}`, serializeWorkspace(ws));
    markSaved();
    toast('success', ws.sheets.length === 1 ? 'Diagram saved.' : `Workspace saved — all ${ws.sheets.length} diagrams in one file.`);
  };

  const openFile = () => fileInput.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const ws = parseWorkspaceFile(await file.text());
      await startFreshWorkspaceEntry();
      setWorkspace(ws, { fileBacked: true });
      const tables = ws.sheets.reduce((n, sh) => n + sh.diagram.tables.length, 0);
      toast('success', ws.sheets.length === 1 ? `Loaded "${ws.name}" (${tables} tables).` : `Loaded "${ws.name}" — ${ws.sheets.length} diagrams, ${tables} tables.`);
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
    if (!hasContent(diagram)) {
      toast('error', 'There is nothing to export yet.');
      return;
    }
    // SQL, Mermaid and DBML describe tables and nothing else, so on a diagram
    // with none they would write a valid, empty, useless file. Say so instead.
    if (format !== 'markdown' && diagram.tables.length === 0) {
      toast('error', `${EXPORT_FORMATS.find((f) => f.id === format)?.label ?? format} describes tables, and this diagram has none. Export Markdown to write up the code map.`);
      return;
    }
    const out = exportDiagram(diagram, format);
    downloadText(out.filename, out.text, out.mime);
    toast('success', `Exported ${EXPORT_FORMATS.find((f) => f.id === format)?.label ?? format}.`);
  };

  const shareLink = async () => {
    if (!hasContent(diagram)) {
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
    const hasWork = hasContent(diagram) || sheetCount > 1;
    if (hasWork && !(await confirmDialog({ title: 'Start a new workspace?', message: 'This one stays in the workspace library (File → Open recent…); a new, empty workspace takes its place.', confirmLabel: 'New workspace' }))) return;
    await startFreshWorkspaceEntry();
    newWorkspace(diagram.dialect);
  };

  /** Another diagram alongside this one, in the same workspace and the same file. */
  const onNewSheet = () => addSheetToWorkspace();

  const onLoadSample = async () => {
    if (hasContent(diagram) && !(await confirmDialog({ title: 'Load the example diagram?', message: 'The current diagram stays in the workspace library (File → Open recent…); the example takes its place on this tab.', confirmLabel: 'Load example' }))) return;
    await startFreshWorkspaceEntry();
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

  /**
   * A code node, from wherever the selection says it belongs: inside the
   * selected container if one can hold it, otherwise a program at the top
   * level. This is the code half's answer to `addTable`, which is why the
   * toolbar can lead with either without the two behaving differently.
   */
  const addCode = () => {
    const parent = selection.programIds.length === 1 ? diagram.programs.find((p) => p.id === selection.programIds[0]) : undefined;
    const inside = parent && codeKindMeta(codeKindOf(parent)).container;
    addProgram(inside ? { kind: 'module', parentId: parent.id } : {});
    setInspectorOpen(true);
  };

  /**
   * The two halves of the Add menu, as peers. They are rendered in either
   * order — a code map lists code first — which is the whole reason they are
   * pulled out rather than written inline twice. Plain functions rather than
   * components, so they are not a fresh component type on every render.
   */
  const codeFirst = emphasis === 'code';
  const addKind = (kind: CodeKind, close: () => void) => {
    close();
    addProgram({ kind, parentId: kind === 'program' || kind === 'procedure' ? undefined : selection.programIds[0] });
    setInspectorOpen(true);
  };
  // Written out rather than mapped over CODE_KINDS so each data-tour is a
  // literal: scripts/walkthrough-lib.mjs greps the source for them, and a
  // target a walkthrough names has to be findable without running the app.
  const codeItems = (close: () => void) => (
    <>
      <div className="menu__label">Code</div>
      <button className="menu__item" data-tour="add-program" title={kindHint('program')} onClick={() => addKind('program', close)}>
        <Cpu /> Program <span className="kbd">C</span>
      </button>
      <button className="menu__item" data-tour="add-module" title={kindHint('module')} onClick={() => addKind('module', close)}>
        <FileCode /> Module
      </button>
      <button className="menu__item" data-tour="add-class" title={kindHint('class')} onClick={() => addKind('class', close)}>
        <Box /> Class
      </button>
      <button className="menu__item" data-tour="add-function" title={kindHint('function')} onClick={() => addKind('function', close)}>
        <SquareFunction /> Function
      </button>
      <button className="menu__item" data-tour="add-data" title={kindHint('data')} onClick={() => addKind('data', close)}>
        <Braces /> Data file
      </button>
    </>
  );
  const dataItems = (close: () => void) => (
    <>
      <div className="menu__label">Data</div>
      <button className="menu__item" data-tour="add-table" onClick={() => void (close(), addTable())}>
        <Table2 /> Table <span className="kbd">T</span>
      </button>
      <button className="menu__item" onClick={() => void (close(), addTable(undefined, { kind: 'view' }))}>
        <Eye /> View
      </button>
      <button className="menu__item" data-tour="add-procedure" title={kindHint('procedure')} onClick={() => addKind('procedure', close)}>
        <DatabaseZap /> Procedure
      </button>
      <button className="menu__item" onClick={() => void (close(), addCustomType('enum'), openDrawer('types'))}>
        <Shapes /> Enum type
      </button>
      <button className="menu__item" onClick={() => void (close(), addCustomType('composite'), openDrawer('types'))}>
        <Shapes /> Composite type
      </button>
    </>
  );

  const onTrace = () => {
    if (tracePicking) {
      setTracePicking(false);
      return;
    }
    const picked = [...selection.tableIds, ...selection.programIds];
    if (picked.length >= 2) {
      setTraceEndpoints(picked[0], picked[1]);
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
      newWorkspace: () => void onNew(),
      newSheet: onNewSheet,
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
      {/* Code brackets around a stack of layers: the two halves of what this
          app draws, drawn the same size as each other on purpose. */}
      <div className="topbar__brand" title="Coditect">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--bg-hover)" />
          <path d="M12.5 9.5 8 16l4.5 6.5" fill="none" stroke="#7aa2f7" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M19.5 9.5 24 16l-4.5 6.5" fill="none" stroke="#4fd1c5" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="13.9" y="12.4" width="4.2" height="2.3" rx="1.15" fill="#e0af68" />
          <rect x="13.9" y="17.3" width="4.2" height="2.3" rx="1.15" fill="#e0af68" />
        </svg>
        <span>Coditect</span>
      </div>
      {dirty && fileBacked && <span className="topbar__unsaved" title="Changed since the last save (Ctrl+S)" />}
      <input
        data-tour="diagram-name"
        className="topbar__name"
        value={workspaceName}
        onChange={(e) => setWorkspaceName(e.target.value)}
        placeholder={sheetCount > 1 ? 'Workspace name' : 'Diagram name'}
        title={sheetCount > 1 ? `The name of this workspace and the file it saves as; its ${sheetCount} diagrams are named on their own tabs` : 'The name of this diagram and the file it saves as'}
        spellCheck={false}
      />
      {dbTools && (
        <select data-tour="dialect" className="dialect-select select" value={diagram.dialect} onChange={(e) => onDialectChange(e.target.value as Dialect)} title="SQL dialect">
          {DIALECTS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      )}

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
        {/* The one-click button is whichever half this diagram is about. On a
            diagram that is about both, there is no obvious default, so the
            button is the menu and neither side gets to be the assumption. */}
        {emphasis === 'code' && (
          <button data-tour="add-code" className="btn" onClick={addCode} title="Add a code node (C)">
            <Plus /> Code
          </button>
        )}
        {emphasis === 'data' && (
          <button data-tour="add-table" className="btn" onClick={() => addTable()} title="Add table (T)">
            <Plus /> Table
          </button>
        )}
        <Menu
          label={emphasis === 'both' ? 'Add' : undefined}
          icon={emphasis === 'both' ? <Plus /> : <ChevronDown />}
          align="left"
          title={emphasis === 'both' ? 'Add something to the diagram' : 'More things to add'}
          data-tour="add-menu"
        >
          {(close) => (
            <>
              {codeFirst && codeItems(close)}
              {dbTools && dataItems(close)}
              {!codeFirst && codeItems(close)}
              <div className="menu__sep" />
              <button className="menu__item" onClick={() => void (close(), addNote())}>
                <StickyNote /> Note <span className="kbd">N</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), addGroup({ tableIds: selection.tableIds }))}>
                <Boxes /> {selection.tableIds.length > 1 ? `Group the ${selection.tableIds.length} selected tables` : 'Group region'} <span className="kbd">G</span>
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
        <button data-tour="trace" className={`btn${tracePicking ? ' btn--active' : ''}`} onClick={onTrace} title="Trace a connection between two tables or code nodes">
          <Route /> Trace
        </button>
        {dbTools && (
          <button data-tour="simulate" className={`btn${simulating ? ' btn--active' : ''}`} onClick={onSimulate} title={simulating ? 'Leave simulation mode (Esc)' : 'Simulate data flowing into the selected table (S)'}>
            <Play /> Simulate
          </button>
        )}
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
        {dbTools && (
          <button data-tour="database" className={`btn${drawerOpen ? ' btn--active' : ''}`} onClick={() => toggleDrawer('database')} title="Docker & database">
            <Database /> Database
          </button>
        )}
        <Menu label="File" icon={<Save />} data-tour="file-menu">
          {(close) => (
            <>
              <button className="menu__item" onClick={() => void (close(), onNewSheet())}>
                <Plus /> New diagram in this workspace
              </button>
              <button className="menu__item" onClick={() => void (close(), onNew())}>
                <FilePlus2 /> New workspace
              </button>
              <button className="menu__item" onClick={() => void (close(), openFile())}>
                <FolderOpen /> Open… <span className="kbd">Ctrl+O</span>
              </button>
              <button className="menu__item" onClick={() => void (close(), setLibraryOpen(true))}>
                <Library /> Open recent workspace…
              </button>
              <button className="menu__item" onClick={() => void (close(), saveFile())}>
                <Save /> Save {sheetCount > 1 ? 'workspace' : ''} as .dbviz.json <span className="kbd">Ctrl+S</span>
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
              {/* Markdown is the one that writes up a code map too, so it is the
                  one export a diagram with no tables in it still offers. */}
              <button className="menu__item" onClick={() => void (close(), exportAs('markdown'))}>
                <FileText /> Export Markdown
              </button>
              {dbTools && (
                <>
                  <button className="menu__item" onClick={() => void (close(), exportAs('sql'))}>
                    <Download /> Export SQL script
                  </button>
                  <button className="menu__item" onClick={() => void (close(), exportAs('mermaid'))}>
                    <FileText /> Export Mermaid ER diagram
                  </button>
                  <button className="menu__item" onClick={() => void (close(), exportAs('dbml'))}>
                    <FileText /> Export DBML
                  </button>
                </>
              )}
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
              <CheckItem on={sidebarOpen} label="Outline" onToggle={() => setSidebarOpen(!sidebarOpen)} />
              <CheckItem on={inspectorOpen} label="Inspector" onToggle={() => setInspectorOpen(!inspectorOpen)} />
              <CheckItem on={drawerOpen} label="Bottom drawer" onToggle={() => toggleDrawer()} />
              <CheckItem on={theme === 'dark'} label="Dark theme" onToggle={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
              <div className="menu__sep" />
              {dbTools && <CheckItem on={derivedLens} label="Derived-column lens (D)" onToggle={() => toggleDerived()} />}
              {dbTools && <CheckItem on={showCardinality} label="Cardinality labels" onToggle={() => setShowCardinality(!showCardinality)} />}
              <CheckItem on={snapToGrid} label="Snap to grid" onToggle={() => setSnapToGrid(!snapToGrid)} />
              <CheckItem on={warnOnClose} label="Warn before closing unsaved" onToggle={() => setWarnOnClose(!warnOnClose)} />
              {/* What this diagram leans towards. Changing it here is how someone
                  who answered the opening question one way gets the other half
                  back — or tidies it away again once they are done with it. */}
              <div className="menu__sep" />
              <div className="menu__label">This diagram is about</div>
              <button className="menu__item" onClick={() => void (close(), setEmphasis('code'))}>
                {emphasis === 'code' ? '●' : '○'} Code
              </button>
              <button className="menu__item" onClick={() => void (close(), setEmphasis('data'))}>
                {emphasis === 'data' ? '●' : '○'} Data
              </button>
              <button className="menu__item" onClick={() => void (close(), setEmphasis('both'))}>
                {emphasis === 'both' ? '●' : '○'} Both
              </button>
              {allTableIds.length > 0 && (
                <>
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
            </>
          )}
        </Menu>
      </div>
      <span className="topbar__sep" />
      <div className="topbar__group">
        <button className={`btn btn--icon btn--ghost${sidebarOpen ? ' btn--active' : ''}`} onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle the outline">
          <PanelLeft />
        </button>
        <button className={`btn btn--icon btn--ghost${drawerOpen ? ' btn--active' : ''}`} onClick={() => toggleDrawer()} title="Toggle the bottom drawer">
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
