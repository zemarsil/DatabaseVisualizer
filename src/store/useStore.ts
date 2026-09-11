import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  normalizeVerb,
  type Column,
  type CustomType,
  type DiagramExtension,
  type Diagram,
  type Dialect,
  type Group,
  type Index,
  type Note,
  type Program,
  type ProgramStep,
  type Relationship,
  type Sheet,
  type Table,
  type TableDisplay,
  type Workspace,
} from '@shared/types';
import { layoutDiagram, type LayoutDirection } from '@/lib/layout';
import {
  cloneTables,
  createColumn,
  createCustomType,
  createExtension,
  createGroup,
  createIndex,
  createNote,
  createProgram,
  createProgramStep,
  createRelationship,
  createTable,
  derivationsMatchedByName,
  emptyDiagram,
  emptyWorkspace,
  flowCopyForTable,
  newSheetId,
  pruneRelationships,
  singleSheetWorkspace,
  uniqueColumnName,
  extensionByName,
  uniqueCustomTypeName,
  uniqueGroupName,
  uniqueProgramName,
  uniqueSheetName,
  uniqueTableName,
} from '@/lib/model';
import { nextGroupPosition } from '@/lib/groups';
import { nextProgramPosition } from '@/lib/programs';
import { placementSizes, type SizeMap } from '@/lib/geometry';
import { PALETTE } from '@/lib/palette';
import { translateType } from '@/lib/sql/dialect';
import { findPath, type TraceResult } from '@/lib/trace';
import { parseWorkspaceFile, serializeWorkspace } from '@/lib/io';
import { getCurrentWorkspaceId } from '@/lib/currentId';
import { applyEdgeSelectionChanges, applyNodeSelectionChanges, emptySelection, type Selection, type SelectionChange } from '@/lib/selection';
import { sampleDiagram } from '@/lib/sample';
import { newId } from '@/lib/ids';
import { useUi } from '@/store/useUi';

export type Theme = 'dark' | 'light';
export type DrawerTab = 'sql' | 'import' | 'database' | 'trace' | 'simulate' | 'derived' | 'types' | 'problems' | 'query' | 'walkthrough';
/** A place in the table inspector another part of the app can hand the cursor to. */
export type InspectorField = 'name' | 'schema' | 'columns';

export type { Selection };

export interface TraceState {
  fromId: string | null;
  toId: string | null;
  result: TraceResult | null;
  /** True after the user pressed Trace; distinguishes "no path" from "not searched". */
  searched: boolean;
  /** Pick mode: clicking tables on the canvas fills the endpoints. */
  picking: boolean;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface NodeSize {
  width: number;
  height: number;
}

/**
 * Everything that makes one diagram tab what it is while you are away from it:
 * the diagram plus the working state you expect to find unchanged when you come
 * back — its own undo history, what was selected, the trace you had run, the
 * measured node sizes.
 */
export interface SheetSnapshot {
  id: string;
  diagram: Diagram;
  past: Diagram[];
  future: Diagram[];
  selection: Selection;
  trace: TraceState;
  nodeSizes: Record<string, NodeSize>;
}

const AUTOSAVE_KEY = 'dbviz:autosave';
const THEME_KEY = 'dbviz:theme';
const PANEL_SIZES_KEY = 'dbviz:panelSizes';
const HISTORY_LIMIT = 100;
/** Consecutive edits to the same field within this window share one undo step. */
const COALESCE_MS = 1200;

export interface MutateOptions {
  /** Push an undo step (default true). */
  history?: boolean;
  /**
   * Group with the previous mutation when it carried the same key and happened
   * within COALESCE_MS, so typing a name is one undo step instead of one per key.
   */
  coalesce?: string;
  /** Mark the diagram as changed (default true). Viewport moves pass false. */
  dirty?: boolean;
}

/** Coalesce key for a patch that only edits text, e.g. typing into a name field; undefined for toggles. */
function textPatchKey(prefix: string, patch: Record<string, unknown>): string | undefined {
  const keys = Object.keys(patch);
  if (keys.length === 0) return undefined;
  for (const k of keys) {
    const v = patch[k];
    if (typeof v !== 'string' && v !== undefined) return undefined;
  }
  return `${prefix}:${keys.join(',')}`;
}

export interface PanelSizes {
  sidebarW: number;
  inspectorW: number;
  drawerH: number;
}

const PANEL_SIZE_LIMITS: Record<keyof PanelSizes, [number, number]> = {
  sidebarW: [180, 480],
  inspectorW: [260, 560],
  drawerH: [140, 640],
};

const DEFAULT_PANEL_SIZES: PanelSizes = { sidebarW: 240, inspectorW: 360, drawerH: 320 };

interface State {
  /**
   * The diagram of the sheet you are on. Sheets are the tabs above the canvas:
   * several diagrams in one workspace, the way a spreadsheet holds several
   * worksheets. The active one is live here — `diagram`, `past`, `future`,
   * `selection`, `trace` and `nodeSizes` are its state — and the others wait in
   * `parked`, so nothing that reads the diagram has to know about sheets at all.
   */
  diagram: Diagram;
  past: Diagram[];
  future: Diagram[];
  /** Sizes measured by the canvas, as the nodes are drawn right now — zoom-collapsed tables included. */
  nodeSizes: Record<string, NodeSize>;
  selection: Selection;
  trace: TraceState;
  theme: Theme;
  drawer: { open: boolean; tab: DrawerTab };
  /** Slug of the walkthrough shown in the drawer's Walkthrough tab, so it keeps following the reader across tab switches. */
  activeWalkthroughSlug: string | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  panelSizes: PanelSizes;
  toasts: Toast[];
  dirty: boolean;
  /**
   * True once the diagram was opened from or saved to a .dbviz.json file in this
   * session. Only then does closing the tab with unsaved changes warn; the
   * autosaved workspace never needs a warning.
   */
  fileBacked: boolean;
  layoutDirection: LayoutDirection;
  /** Bumps whenever the canvas should call fitView (after layout / load). */
  fitViewNonce: number;
  /** Bumps when a diagram with a saved viewport was loaded; the canvas restores it instead of fitting. */
  viewportNonce: number;
  /** Table id the canvas should scroll to. */
  focusTableId: string | null;
  /** Relationship id the canvas should scroll to. */
  focusRelationshipId: string | null;
  /** Column id the inspector should focus (set by addColumn so Enter-to-add keeps typing flowing). */
  focusColumnId: string | null;
  /** Field of the table inspector that should take focus next: the hand-off from a new table or the canvas rename box into the form. */
  focusFieldTarget: InspectorField | null;

  /* ---- sheets: several diagrams in one workspace ---- */
  /** Name of the workspace as a whole: what it saves as, whatever its sheets are called. */
  workspaceName: string;
  /** Sheet ids in tab order. Never empty, and always holds `activeSheetId`. */
  sheetIds: string[];
  activeSheetId: string;
  /** Every sheet except the active one, whose state is live at the top of this object. */
  parked: Record<string, SheetSnapshot>;
}

interface Actions {
  // history
  undo: () => void;
  redo: () => void;
  mutate: (fn: (d: Diagram) => void, opts?: MutateOptions) => void;
  /** Replace the diagram of the sheet you are on, history and all. Other sheets are untouched. */
  setDiagram: (d: Diagram) => void;
  loadSample: () => void;

  // workspace and sheets
  /** Replace the whole workspace: every sheet, the name, which one is open. */
  setWorkspace: (ws: Workspace, opts?: { fileBacked?: boolean }) => void;
  newWorkspace: (dialect?: Dialect) => void;
  setWorkspaceName: (name: string) => void;
  /** Add a diagram as a new sheet and, unless told otherwise, switch to it. Returns the sheet id. */
  addSheet: (opts?: { diagram?: Diagram; name?: string; dialect?: Dialect; after?: string; activate?: boolean }) => string;
  switchSheet: (id: string) => void;
  renameSheet: (id: string, name: string) => void;
  duplicateSheet: (id: string) => string;
  /** Close a sheet. Closing the last one leaves an empty diagram rather than nothing. */
  closeSheet: (id: string) => void;
  moveSheet: (id: string, toIndex: number) => void;

  // diagram metadata
  setDiagramName: (name: string) => void;
  setDialect: (dialect: Dialect, translateTypes: boolean) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  setFileBacked: (fileBacked: boolean) => void;

  // tables
  /** partial.kind === 'view' creates a view (no default id column). */
  addTable: (position?: { x: number; y: number }, partial?: Partial<Omit<Table, 'id' | 'position'>>) => string;
  updateTable: (id: string, patch: Partial<Omit<Table, 'id' | 'columns' | 'indexes'>>) => void;
  /** Paste copies of tables (from the clipboard or another diagram): fresh ids, unique names, offset positions. Returns the new table ids. */
  pasteTables: (tables: Table[], relationships: Relationship[], customTypes?: CustomType[], offset?: { x: number; y: number }, extensions?: DiagramExtension[]) => string[];
  setTableDisplay: (ids: string[], collapsed: TableDisplay | undefined) => void;
  /** Recolour a group of tables and/or notes in one history step. */
  colorElements: (ids: { tableIds?: string[]; noteIds?: string[]; programIds?: string[] }, color: string) => void;
  deleteTables: (ids: string[]) => void;
  duplicateTable: (id: string) => void;
  /** The new column id is also exposed as focusColumnId so the editor can focus it. */
  addColumn: (tableId: string, partial?: Partial<Column>, opts?: { after?: string }) => string;
  updateColumn: (tableId: string, columnId: string, patch: Partial<Omit<Column, 'id'>>) => void;
  deleteColumn: (tableId: string, columnId: string) => void;
  moveColumn: (tableId: string, columnId: string, delta: -1 | 1) => void;
  reorderColumn: (tableId: string, columnId: string, toIndex: number) => void;
  addIndex: (tableId: string, columnIds?: string[]) => void;
  updateIndex: (tableId: string, indexId: string, patch: Partial<Omit<Index, 'id'>>) => void;
  deleteIndex: (tableId: string, indexId: string) => void;
  setChecks: (tableId: string, checks: string[]) => void;

  // custom types
  addCustomType: (kind: CustomType['kind']) => string;
  updateCustomType: (id: string, patch: Partial<Omit<CustomType, 'id' | 'kind'>>) => void;
  deleteCustomType: (id: string) => void;
  customTypeUsage: (id: string) => { table: Table; column: Column }[];

  // extensions
  /** Declare an extension. Re-declaring one the diagram already has is a no-op; returns its id either way. */
  addExtension: (name: string, partial?: Partial<Omit<DiagramExtension, 'id' | 'name'>>) => string;
  updateExtension: (id: string, patch: Partial<Omit<DiagramExtension, 'id'>>) => void;
  deleteExtension: (id: string) => void;

  // relationships
  addRelationship: (rel: Omit<Relationship, 'id'>) => string;
  updateRelationship: (id: string, patch: Partial<Omit<Relationship, 'id'>>) => void;
  deleteRelationship: (id: string) => void;
  swapRelationship: (id: string) => void;
  /**
   * Fill a data flow's still-unmapped target columns from source columns of the
   * same name. Returns how many derivations were added; nothing already there
   * is touched.
   */
  fillFlowByName: (id: string) => number;
  /**
   * Draw the same data flow into more target tables, re-pointing its
   * derivations at the columns those tables spell the same way. Tables the
   * source already feeds are skipped. Returns the new relationship ids.
   */
  copyFlowToTables: (id: string, targetTableIds: string[]) => string[];

  // groups
  addGroup: (opts?: { name?: string; tableIds?: string[]; external?: boolean; color?: string; note?: string }) => string;
  updateGroup: (id: string, patch: Partial<Omit<Group, 'id'>>) => void;
  /** Removes the region. The tables stay unless withTables is true. */
  deleteGroup: (id: string, withTables?: boolean) => void;
  setTableGroup: (tableIds: string[], groupId: string | null) => void;
  /** Drag a region: its member tables move with it, in one history step. */
  moveGroup: (id: string, moves: { id: string; position: { x: number; y: number } }[], anchor: { x: number; y: number }) => void;

  // notes
  addNote: (position?: { x: number; y: number }) => string;
  updateNote: (id: string, patch: Partial<Omit<Note, 'id'>>) => void;
  duplicateNote: (id: string) => void;
  deleteNote: (id: string) => void;

  // programs
  addProgram: (opts?: { name?: string; position?: { x: number; y: number }; language?: Program['language'] }) => string;
  updateProgram: (id: string, patch: Partial<Omit<Program, 'id' | 'steps'>>) => void;
  duplicateProgram: (id: string) => void;
  deleteProgram: (id: string) => void;
  /** Appends a step. `at` inserts before that index instead, so a step can be added mid-sequence. */
  addProgramStep: (programId: string, partial?: Partial<ProgramStep>, at?: number) => string;
  updateProgramStep: (programId: string, stepId: string, patch: Partial<Omit<ProgramStep, 'id'>>) => void;
  removeProgramStep: (programId: string, stepId: string) => void;
  /** Reorder: delta is -1 for earlier, +1 for later. Out-of-range moves do nothing. */
  moveProgramStep: (programId: string, stepId: string, delta: number) => void;

  // canvas
  /** Deletes tables, notes, programs and relationships together, as a single undo step. */
  removeElements: (ids: { tableIds?: string[]; noteIds?: string[]; programIds?: string[]; relationshipIds?: string[] }) => void;
  /** Delete whatever is selected (tables, notes, a relationship, or a group region). */
  deleteSelection: () => void;
  moveItems: (moves: { id: string; position: { x: number; y: number } }[]) => void;
  /** Move the selected tables and notes by a delta; consecutive nudges share one undo step. */
  nudgeSelection: (dx: number, dy: number) => void;
  beginDrag: () => void;
  endDrag: () => void;
  setNodeSize: (id: string, size: NodeSize) => void;
  /** The sizes to place tables by, which the zoom level of detail can make quite different from `nodeSizes`. */
  placementSizes: () => SizeMap;
  applyLayout: (direction?: LayoutDirection) => void;
  setLayoutDirection: (direction: LayoutDirection) => void;
  requestFitView: () => void;
  focusTable: (id: string | null) => void;
  focusRelationship: (id: string | null) => void;
  focusColumn: (id: string | null) => void;
  /** Point the table inspector at one of its fields; it clears the request once the cursor is there. */
  focusInspectorField: (field: InspectorField | null) => void;
  importTables: (
    tables: Table[],
    relationships: Relationship[],
    mode: 'merge' | 'replace',
    opts?: {
      customTypes?: CustomType[];
      extensions?: DiagramExtension[];
      /** Wrap everything imported in a new group, e.g. the database it came from. */
      group?: { name: string; external: boolean; note?: string };
    },
  ) => void;

  // selection
  setSelection: (sel: Partial<Selection>) => void;
  selectTable: (id: string, additive?: boolean) => void;
  selectTables: (ids: string[]) => void;
  selectGroup: (id: string | null) => void;
  clearSelection: () => void;
  /** Replays React Flow node select/deselect deltas onto the live selection. */
  applyNodeSelection: (changes: SelectionChange[], isNote: (id: string) => boolean) => void;
  /** Replays React Flow edge select/deselect deltas onto the live selection. */
  applyEdgeSelection: (changes: SelectionChange[]) => void;

  // trace
  setTraceEndpoints: (fromId: string | null, toId: string | null) => void;
  runTrace: () => void;
  clearTrace: () => void;
  setTracePicking: (picking: boolean) => void;

  // ui
  setTheme: (theme: Theme) => void;
  openDrawer: (tab?: DrawerTab) => void;
  closeDrawer: () => void;
  toggleDrawer: (tab?: DrawerTab) => void;
  /** Opens (or switches) the walkthrough panel to this slug, so its text follows the reader while they work on the canvas. */
  openWalkthrough: (slug: string) => void;
  /** Marks the walkthrough in play without moving the drawer: while a tour runs, the coach mark is the reader's place, not this tab. */
  setActiveWalkthrough: (slug: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  resizePanel: (key: keyof PanelSizes, delta: number) => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  markSaved: () => void;
}

export type Store = State & Actions;

function loadInitialWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    // An autosave written before workspaces existed is a bare diagram. It
    // becomes a workspace of one whose sheet keeps the id the library already
    // knows it by, so the checkpoints saved against it are still its own.
    if (raw) return parseWorkspaceFile(raw, { sheetId: getCurrentWorkspaceId() });
  } catch {
    /* fall through to sample */
  }
  return singleSheetWorkspace(sampleDiagram());
}

const emptyTrace = (): TraceState => ({ fromId: null, toId: null, result: null, searched: false, picking: false });

/** A sheet nobody has edited yet: the diagram, and working state that starts clean. */
function freshSheet(id: string, diagram: Diagram): SheetSnapshot {
  return { id, diagram, past: [], future: [], selection: emptySelection(), trace: emptyTrace(), nodeSizes: {} };
}

/** The diagram on a given sheet, live or parked. */
export function sheetDiagram(s: State, id: string): Diagram | undefined {
  return id === s.activeSheetId ? s.diagram : s.parked[id]?.diagram;
}

/** The workspace as it stands right now — what gets saved, autosaved and put in the library. */
export function currentWorkspace(s: State): Workspace {
  const sheets: Sheet[] = [];
  for (const id of s.sheetIds) {
    const diagram = sheetDiagram(s, id);
    if (diagram) sheets.push({ id, diagram });
  }
  return { version: 1, name: s.workspaceName, activeSheetId: s.activeSheetId, sheets };
}

/** Every sheet name in tab order — what a new or renamed sheet has to stay clear of. */
function sheetNames(s: State): string[] {
  return s.sheetIds.map((id) => sheetDiagram(s, id)?.name ?? '');
}

function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return 'dark';
}

const PALETTE_KEYS = PALETTE.map((p) => p.key);

function loadPanelSizes(): PanelSizes {
  try {
    const raw = localStorage.getItem(PANEL_SIZES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelSizes>;
      return { ...DEFAULT_PANEL_SIZES, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PANEL_SIZES };
}

const dragSnapshot: { diagram: Diagram | null } = { diagram: null };
const lastCoalesce: { key: string | null; at: number } = { key: null, at: 0 };

export const useStore = create<Store>()(
  immer((set, get) => {
    const pushHistory = (s: State, snapshot: Diagram) => {
      s.past.push(snapshot as Diagram);
      if (s.past.length > HISTORY_LIMIT) s.past.shift();
      s.future = [];
      s.dirty = true;
    };

    const mutate: Actions['mutate'] = (fn, opts) => {
      const snapshot = get().diagram;
      const now = Date.now();
      const key = opts?.coalesce ?? null;
      const joins = key !== null && lastCoalesce.key === key && now - lastCoalesce.at < COALESCE_MS && get().past.length > 0;
      lastCoalesce.key = key;
      lastCoalesce.at = now;
      set((s) => {
        if (opts?.history !== false && !joins) pushHistory(s, snapshot);
        if (opts?.dirty !== false) s.dirty = true;
        fn(s.diagram);
      });
    };

    const invalidateTrace = (s: State) => {
      if (s.trace.result) s.trace.result = null;
      s.trace.searched = false;
    };

    /* ---------------- sheets ---------------- */

    /** The live sheet, packed up so it can be set aside while another one is edited. */
    const liveSheet = (s: State): SheetSnapshot => ({
      id: s.activeSheetId,
      diagram: s.diagram,
      past: s.past,
      future: s.future,
      selection: s.selection,
      trace: s.trace,
      nodeSizes: s.nodeSizes,
    });

    /** Make `entering` the live sheet. Parking whatever was live is the caller's job. */
    const hydrate = (s: State, entering: SheetSnapshot) => {
      delete s.parked[entering.id];
      s.activeSheetId = entering.id;
      s.diagram = entering.diagram;
      s.past = entering.past;
      s.future = entering.future;
      s.selection = entering.selection;
      s.trace = entering.trace;
      s.nodeSizes = entering.nodeSizes;
      if (entering.diagram.viewport) s.viewportNonce++;
      else s.fitViewNonce++;
    };

    /** Whatever followed the diagram on screen belongs to the sheet you just left. */
    const leaveSheetUi = () => {
      const ui = useUi.getState();
      ui.setFocus(null);
      ui.setRenamingTableId(null);
    };

    /**
     * Park the live sheet, bring `entering` in, and optionally rearrange the
     * tabs (adding the new sheet's id, dropping a closed one) in the same step.
     */
    const showSheet = (entering: SheetSnapshot, place?: (ids: string[]) => string[]) => {
      const leaving = liveSheet(get());
      lastCoalesce.key = null;
      set((s) => {
        if (leaving.id !== entering.id) s.parked[leaving.id] = leaving;
        hydrate(s, entering);
        if (place) s.sheetIds = place(s.sheetIds);
      });
      leaveSheetUi();
    };

    const removeElements: Actions['removeElements'] = ({ tableIds = [], noteIds = [], programIds = [], relationshipIds = [] }) => {
      const tables = new Set(tableIds);
      const notes = new Set(noteIds);
      const programs = new Set(programIds);
      const rels = new Set(relationshipIds);
      if (!tables.size && !notes.size && !programs.size && !rels.size) return;
      mutate((d) => {
        if (tables.size) d.tables = d.tables.filter((t) => !tables.has(t.id));
        if (notes.size) d.notes = d.notes.filter((n) => !notes.has(n.id));
        if (programs.size) d.programs = d.programs.filter((p) => !programs.has(p.id));
        if (rels.size) d.relationships = d.relationships.filter((r) => !rels.has(r.id));
        if (tables.size) {
          // Drop the relationships, index entries and program column references
          // left dangling by the removed tables.
          const pruned = pruneRelationships(d);
          d.relationships = pruned.relationships;
          d.tables = pruned.tables;
          d.programs = pruned.programs;
        }
      });
      set((s) => {
        if (tables.size) s.selection.tableIds = s.selection.tableIds.filter((x) => !tables.has(x));
        if (notes.size) s.selection.noteIds = s.selection.noteIds.filter((x) => !notes.has(x));
        if (programs.size) s.selection.programIds = s.selection.programIds.filter((x) => !programs.has(x));
        if (s.selection.relationshipId && rels.has(s.selection.relationshipId)) s.selection.relationshipId = null;
        if (s.trace.fromId && tables.has(s.trace.fromId)) s.trace.fromId = null;
        if (s.trace.toId && tables.has(s.trace.toId)) s.trace.toId = null;
        if (tables.size || rels.size) invalidateTrace(s);
      });
    };

    const boot = loadInitialWorkspace();
    const bootActive = boot.sheets.find((sh) => sh.id === boot.activeSheetId) ?? boot.sheets[0];

    return {
      diagram: bootActive.diagram,
      past: [],
      future: [],
      nodeSizes: {},
      selection: emptySelection(),
      trace: emptyTrace(),
      workspaceName: boot.name,
      sheetIds: boot.sheets.map((sh) => sh.id),
      activeSheetId: bootActive.id,
      parked: Object.fromEntries(boot.sheets.filter((sh) => sh.id !== bootActive.id).map((sh) => [sh.id, freshSheet(sh.id, sh.diagram)])),
      theme: loadTheme(),
      drawer: { open: false, tab: 'sql' },
      activeWalkthroughSlug: null,
      sidebarOpen: true,
      inspectorOpen: true,
      panelSizes: loadPanelSizes(),
      toasts: [],
      dirty: false,
      fileBacked: false,
      layoutDirection: 'LR',
      fitViewNonce: 0,
      viewportNonce: 0,
      focusTableId: null,
      focusRelationshipId: null,
      focusColumnId: null,
      focusFieldTarget: null,

      /* ---------------- history ---------------- */
      undo: () => {
        const cur = get().diagram;
        lastCoalesce.key = null;
        set((s) => {
          const prev = s.past.pop();
          if (!prev) return;
          s.future.push(cur as Diagram);
          s.diagram = prev;
          s.dirty = true;
          invalidateTrace(s);
        });
      },
      redo: () => {
        const cur = get().diagram;
        lastCoalesce.key = null;
        set((s) => {
          const next = s.future.pop();
          if (!next) return;
          s.past.push(cur as Diagram);
          s.diagram = next;
          s.dirty = true;
          invalidateTrace(s);
        });
      },
      mutate,
      setDiagram: (d) => {
        const s = get();
        // Replacing one sheet of several still leaves the workspace changed;
        // replacing the only one is a fresh document with nothing to save yet.
        const others = s.sheetIds.filter((id) => id !== s.activeSheetId);
        const diagram = others.length ? { ...d, name: uniqueSheetName(others.map((id) => sheetDiagram(s, id)?.name ?? ''), d.name) } : d;
        lastCoalesce.key = null;
        set((st) => {
          hydrate(st, freshSheet(st.activeSheetId, diagram));
          st.dirty = others.length > 0;
          if (!others.length) {
            st.fileBacked = false;
            st.workspaceName = diagram.name;
          }
        });
        leaveSheetUi();
      },
      loadSample: () => get().setDiagram(sampleDiagram()),

      /* ---------------- workspace and sheets ---------------- */
      setWorkspace: (ws, opts) => {
        if (ws.sheets.length === 0) return;
        const active = ws.sheets.find((sh) => sh.id === ws.activeSheetId) ?? ws.sheets[0];
        lastCoalesce.key = null;
        set((s) => {
          s.workspaceName = ws.name;
          s.sheetIds = ws.sheets.map((sh) => sh.id);
          s.parked = Object.fromEntries(ws.sheets.filter((sh) => sh.id !== active.id).map((sh) => [sh.id, freshSheet(sh.id, sh.diagram)]));
          hydrate(s, freshSheet(active.id, active.diagram));
          s.dirty = false;
          s.fileBacked = opts?.fileBacked ?? false;
        });
        leaveSheetUi();
      },
      newWorkspace: (dialect) => get().setWorkspace(emptyWorkspace(dialect ?? get().diagram.dialect)),
      setWorkspaceName: (name) =>
        set((s) => {
          s.workspaceName = name;
          // A workspace of one diagram is that diagram: naming either names both.
          if (s.sheetIds.length === 1) s.diagram.name = name;
          s.dirty = true;
        }),

      addSheet: ({ diagram, name, dialect, after, activate = true } = {}) => {
        const s = get();
        const id = newSheetId();
        const d = { ...(diagram ?? emptyDiagram(dialect ?? s.diagram.dialect)) };
        d.name = uniqueSheetName(sheetNames(s), name ?? d.name);
        const entering = freshSheet(id, d);
        const at = s.sheetIds.indexOf(after ?? s.activeSheetId);
        const place = (ids: string[]) => {
          const next = [...ids];
          next.splice(at < 0 ? next.length : at + 1, 0, id);
          return next;
        };
        if (activate) showSheet(entering, place);
        else
          set((st) => {
            st.parked[id] = entering;
            st.sheetIds = place(st.sheetIds);
          });
        set((st) => void (st.dirty = true));
        return id;
      },

      switchSheet: (id) => {
        const s = get();
        if (id === s.activeSheetId) return;
        const entering = s.parked[id];
        if (!entering) return;
        showSheet(entering);
      },

      renameSheet: (id, name) => {
        const next = name.trim();
        if (!next) return;
        set((s) => {
          if (id === s.activeSheetId) s.diagram.name = next;
          else if (s.parked[id]) s.parked[id].diagram.name = next;
          else return;
          if (s.sheetIds.length === 1) s.workspaceName = next;
          s.dirty = true;
        });
      },

      duplicateSheet: (id) => {
        const source = sheetDiagram(get(), id);
        if (!source) return id;
        return get().addSheet({ diagram: structuredClone(source), name: `${source.name} copy`, after: id });
      },

      closeSheet: (id) => {
        const s = get();
        const at = s.sheetIds.indexOf(id);
        if (at < 0) return;
        if (s.sheetIds.length === 1) {
          // The last sheet cannot go: it empties instead, so there is always a
          // canvas — and the workspace keeps the name it was saved under.
          get().setDiagram(emptyDiagram(s.diagram.dialect, s.workspaceName));
          set((st) => void (st.dirty = true));
          return;
        }
        const entering = id === s.activeSheetId ? s.parked[s.sheetIds[at + 1] ?? s.sheetIds[at - 1]] : null;
        lastCoalesce.key = null;
        set((st) => {
          st.sheetIds = st.sheetIds.filter((x) => x !== id);
          delete st.parked[id];
          if (entering) hydrate(st, entering);
          st.dirty = true;
        });
        if (entering) leaveSheetUi();
      },

      moveSheet: (id, toIndex) =>
        set((s) => {
          const from = s.sheetIds.indexOf(id);
          if (from < 0) return;
          const to = Math.max(0, Math.min(s.sheetIds.length - 1, toIndex));
          if (to === from) return;
          s.sheetIds.splice(from, 1);
          s.sheetIds.splice(to, 0, id);
          s.dirty = true;
        }),

      /* ---------------- metadata ---------------- */
      setDiagramName: (name) => {
        mutate((d) => void (d.name = name), { history: false });
        // A workspace of one diagram is that diagram: naming either names both.
        if (get().sheetIds.length === 1) set((s) => void (s.workspaceName = name));
      },
      setDialect: (dialect, translateTypes) =>
        mutate((d) => {
          const from = d.dialect;
          d.dialect = dialect;
          if (translateTypes && from !== dialect) {
            // Named custom types keep their name across dialects; translateType leaves unknown names alone.
            for (const t of d.tables) for (const c of t.columns) c.type = translateType(c.type, from, dialect);
          }
        }),
      setViewport: (viewport) => mutate((d) => void (d.viewport = viewport), { history: false, dirty: false }),
      setFileBacked: (fileBacked) => set((s) => void (s.fileBacked = fileBacked)),

      /* ---------------- tables ---------------- */
      addTable: (position, partial) => {
        const d = get().diagram;
        const isView = partial?.kind === 'view';
        const t = createTable({
          ...partial,
          name: uniqueTableName(d, partial?.name ?? (isView ? 'new_view' : 'new_table')),
          position: position ?? { x: 80, y: 80 },
          columns: partial?.columns ? partial.columns.map((c) => ({ ...c })) : [],
        });
        if (!isView && !partial?.columns) {
          t.columns.push(createColumn({ name: 'id', type: d.dialect === 'mariadb' ? 'INT' : 'INTEGER', primaryKey: true, nullable: false, autoIncrement: true }));
        }
        mutate((dd) => {
          dd.tables.push(t);
        });
        set((s) => {
          s.selection = { ...emptySelection(), tableIds: [t.id] };
          s.inspectorOpen = true;
          // Straight into the name box, so a new table is one T away from being typed.
          s.focusFieldTarget = 'name';
        });
        return t.id;
      },
      updateTable: (id, patch) =>
        mutate(
          (d) => {
            const t = d.tables.find((x) => x.id === id);
            if (t) Object.assign(t, patch);
          },
          { coalesce: textPatchKey(`table:${id}`, patch) },
        ),
      pasteTables: (tables, relationships, customTypes, offset, extensions) => {
        const d = get().diagram;
        const { tables: copies, relationships: rels } = cloneTables(tables, relationships, d, offset);
        if (copies.length === 0) return [];
        const existingTypes = new Set(d.customTypes.map((t) => t.name.toLowerCase()));
        const newTypes = (customTypes ?? [])
          .filter((ct) => !existingTypes.has(ct.name.toLowerCase()))
          .map((ct) => createCustomType({ ...ct, id: undefined, fields: ct.fields?.map((f) => ({ ...f, id: newId('ctf') })) }));
        // Pasted columns can be typed with something only an extension provides,
        // so the dependency travels with them or the paste generates broken DDL.
        const existingExtensions = new Set(d.extensions.map((e) => e.name.toLowerCase()));
        const newExtensions = (extensions ?? [])
          .filter((e) => e.name.trim() && !existingExtensions.has(e.name.trim().toLowerCase()))
          .map((e) => createExtension({ ...e, id: undefined }));
        mutate((dd) => {
          dd.tables.push(...copies);
          dd.relationships.push(...rels);
          if (newTypes.length) dd.customTypes.push(...newTypes);
          if (newExtensions.length) dd.extensions.push(...newExtensions);
        });
        set((s) => {
          s.selection = { ...emptySelection(), tableIds: copies.map((t) => t.id) };
          invalidateTrace(s);
        });
        return copies.map((t) => t.id);
      },
      setTableDisplay: (ids, collapsed) => {
        const idSet = new Set(ids);
        mutate((d) => {
          for (const t of d.tables) if (idSet.has(t.id)) t.collapsed = collapsed;
        });
      },
      colorElements: ({ tableIds = [], noteIds = [], programIds = [] }, color) => {
        if (!tableIds.length && !noteIds.length && !programIds.length) return;
        const tables = new Set(tableIds);
        const notes = new Set(noteIds);
        const programs = new Set(programIds);
        mutate((d) => {
          for (const t of d.tables) if (tables.has(t.id)) t.color = color;
          for (const n of d.notes) if (notes.has(n.id)) n.color = color;
          for (const pr of d.programs) if (programs.has(pr.id)) pr.color = color;
        });
      },
      deleteTables: (ids) => removeElements({ tableIds: ids }),
      duplicateTable: (id) => {
        const d = get().diagram;
        const src = d.tables.find((t) => t.id === id);
        if (!src) return;
        const copy = createTable({
          ...src,
          id: undefined,
          name: uniqueTableName(d, `${src.name}_copy`),
          position: { x: src.position.x + 40, y: src.position.y + 40 },
          columns: src.columns.map((c) => ({ ...c, id: newId('col') })),
          indexes: [],
        });
        // remap index column ids
        const idMap = new Map(src.columns.map((c, i) => [c.id, copy.columns[i].id]));
        copy.indexes = src.indexes.map((ix) => ({ ...ix, id: newId('idx'), columnIds: ix.columnIds.map((c) => idMap.get(c) ?? c) }));
        mutate((dd) => {
          dd.tables.push(copy);
        });
        set((s) => {
          s.selection = { ...emptySelection(), tableIds: [copy.id] };
        });
      },
      addColumn: (tableId, partial, opts) => {
        const d = get().diagram;
        const t = d.tables.find((x) => x.id === tableId);
        if (!t) return '';
        const col = createColumn({ name: uniqueColumnName(t, partial?.name ?? 'column'), type: partial?.type ?? 'VARCHAR(255)', ...partial });
        mutate((dd) => {
          const table = dd.tables.find((x) => x.id === tableId);
          if (!table) return;
          const after = opts?.after ? table.columns.findIndex((c) => c.id === opts.after) : -1;
          if (after >= 0) table.columns.splice(after + 1, 0, col);
          else table.columns.push(col);
        });
        set((s) => void (s.focusColumnId = col.id));
        return col.id;
      },
      updateColumn: (tableId, columnId, patch) =>
        mutate(
          (d) => {
            const c = d.tables.find((x) => x.id === tableId)?.columns.find((x) => x.id === columnId);
            if (!c) return;
            Object.assign(c, patch);
            if (patch.primaryKey) c.nullable = false;
          },
          { coalesce: textPatchKey(`column:${columnId}`, patch) },
        ),
      deleteColumn: (tableId, columnId) => {
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (!t) return;
          t.columns = t.columns.filter((c) => c.id !== columnId);
          const pruned = pruneRelationships(d);
          d.relationships = pruned.relationships;
          d.tables = pruned.tables;
        });
        set((s) => invalidateTrace(s));
      },
      moveColumn: (tableId, columnId, delta) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (!t) return;
          const i = t.columns.findIndex((c) => c.id === columnId);
          const j = i + delta;
          if (i < 0 || j < 0 || j >= t.columns.length) return;
          const [c] = t.columns.splice(i, 1);
          t.columns.splice(j, 0, c);
        }),
      reorderColumn: (tableId, columnId, toIndex) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (!t) return;
          const i = t.columns.findIndex((c) => c.id === columnId);
          if (i < 0) return;
          const j = Math.max(0, Math.min(t.columns.length - 1, toIndex));
          if (i === j) return;
          const [c] = t.columns.splice(i, 1);
          t.columns.splice(j, 0, c);
        }),
      addIndex: (tableId, columnIds) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (!t) return;
          const ids = columnIds?.length ? columnIds : t.columns.slice(0, 1).map((c) => c.id);
          t.indexes.push(createIndex({ columnIds: ids }));
        }),
      updateIndex: (tableId, indexId, patch) =>
        mutate(
          (d) => {
            const ix = d.tables.find((x) => x.id === tableId)?.indexes.find((x) => x.id === indexId);
            if (ix) Object.assign(ix, patch);
          },
          { coalesce: textPatchKey(`index:${indexId}`, patch) },
        ),
      deleteIndex: (tableId, indexId) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (t) t.indexes = t.indexes.filter((x) => x.id !== indexId);
        }),
      setChecks: (tableId, checks) =>
        mutate(
          (d) => {
            const t = d.tables.find((x) => x.id === tableId);
            if (t) t.checks = checks;
          },
          { coalesce: `checks:${tableId}:${checks.length}` },
        ),

      /* ---------------- custom types ---------------- */
      addCustomType: (kind) => {
        const d = get().diagram;
        const ct = createCustomType({ name: uniqueCustomTypeName(d, kind === 'enum' ? 'my_enum' : 'my_type'), kind });
        mutate((dd) => {
          dd.customTypes.push(ct);
        });
        return ct.id;
      },
      updateCustomType: (id, patch) =>
        mutate((d) => {
          // Not coalesced: renames cascade into column types, so each keystroke is its own step on purpose.
          const ct = d.customTypes.find((x) => x.id === id);
          if (!ct) return;
          const renaming = typeof patch.name === 'string' && patch.name.trim() && patch.name !== ct.name;
          const oldName = ct.name;
          Object.assign(ct, patch);
          if (renaming) {
            const newName = ct.name;
            const matches = (t: string) => t.trim().toLowerCase() === oldName.toLowerCase();
            for (const t of d.tables) for (const c of t.columns) if (matches(c.type)) c.type = newName;
            for (const other of d.customTypes) {
              if (other.id === id) continue;
              for (const f of other.fields ?? []) if (matches(f.type)) f.type = newName;
            }
          }
        }),
      deleteCustomType: (id) =>
        mutate((d) => {
          d.customTypes = d.customTypes.filter((t) => t.id !== id);
        }),
      customTypeUsage: (id) => {
        const d = get().diagram;
        const ct = d.customTypes.find((t) => t.id === id);
        if (!ct) return [];
        const out: { table: Table; column: Column }[] = [];
        for (const t of d.tables) {
          for (const c of t.columns) {
            if (c.type.trim().toLowerCase() === ct.name.toLowerCase()) out.push({ table: t, column: c });
          }
        }
        return out;
      },

      /* ---------------- extensions ---------------- */
      addExtension: (name, partial) => {
        const trimmed = name.trim();
        if (!trimmed) return '';
        // The engine keys extensions by name, so declaring one twice is one
        // extension, not two. Return the existing id so callers can still focus it.
        const existing = extensionByName(get().diagram, trimmed);
        if (existing) return existing.id;
        const e = createExtension({ ...partial, name: trimmed });
        mutate((d) => {
          d.extensions.push(e);
        });
        return e.id;
      },
      updateExtension: (id, patch) =>
        mutate(
          (d) => {
            const e = d.extensions.find((x) => x.id === id);
            if (e) Object.assign(e, patch);
          },
          // Typing into the comment or version box should not fill the undo stack.
          { coalesce: `extension:${id}:${Object.keys(patch).join(',')}` },
        ),
      deleteExtension: (id) =>
        mutate((d) => {
          d.extensions = d.extensions.filter((e) => e.id !== id);
        }),

      /* ---------------- relationships ---------------- */
      addRelationship: (rel) => {
        const r = createRelationship(rel);
        mutate((d) => {
          d.relationships.push(r);
        });
        set((s) => {
          s.selection = { ...emptySelection(), relationshipId: r.id };
          s.inspectorOpen = true;
          invalidateTrace(s);
        });
        return r.id;
      },
      updateRelationship: (id, patch) =>
        mutate(
          (d) => {
            const r = d.relationships.find((x) => x.id === id);
            if (!r) return;
            Object.assign(r, patch);
            // Changing the kind can strand a verb that no longer applies (a "feeds"
            // on a foreign key); drop it back to the new kind's default.
            r.verb = normalizeVerb(r.kind, r.verb);
          },
          { coalesce: textPatchKey(`rel:${id}`, patch) },
        ),
      fillFlowByName: (id) => {
        const d = get().diagram;
        const r = d.relationships.find((x) => x.id === id);
        if (!r || r.kind !== 'flow') return 0;
        const src = d.tables.find((t) => t.id === r.sourceTableId);
        const tgt = d.tables.find((t) => t.id === r.targetTableId);
        if (!src || !tgt) return 0;
        const made = derivationsMatchedByName(src, tgt, r.derivations ?? []);
        if (made.length === 0) return 0;
        mutate((draft) => {
          const rel = draft.relationships.find((x) => x.id === id);
          if (rel) rel.derivations = [...(rel.derivations ?? []), ...made];
        });
        return made.length;
      },
      copyFlowToTables: (id, targetTableIds) => {
        const d = get().diagram;
        const r = d.relationships.find((x) => x.id === id);
        if (!r || r.kind !== 'flow') return [];
        const from = d.tables.find((t) => t.id === r.targetTableId);
        if (!from) return [];
        const made: Relationship[] = [];
        for (const tableId of new Set(targetTableIds)) {
          const to = d.tables.find((t) => t.id === tableId);
          if (!to || to.id === r.sourceTableId || to.id === from.id) continue;
          // A second flow between the same pair would draw on top of the first
          // and say the same thing twice.
          if (d.relationships.some((x) => x.kind === 'flow' && x.sourceTableId === r.sourceTableId && x.targetTableId === to.id)) continue;
          made.push(createRelationship(flowCopyForTable(r, from, to)));
        }
        if (made.length === 0) return [];
        mutate((draft) => {
          draft.relationships.push(...made);
        });
        set((s) => {
          invalidateTrace(s);
        });
        return made.map((x) => x.id);
      },
      deleteRelationship: (id) => removeElements({ relationshipIds: [id] }),
      swapRelationship: (id) =>
        mutate((d) => {
          const r = d.relationships.find((x) => x.id === id);
          if (!r) return;
          [r.sourceTableId, r.targetTableId] = [r.targetTableId, r.sourceTableId];
          [r.sourceColumnIds, r.targetColumnIds] = [r.targetColumnIds, r.sourceColumnIds];
          // The two labels read from opposite ends, so they follow the ends. An
          // FK's name is its constraint name rather than a reading, so it stays.
          if (r.kind !== 'fk') [r.name, r.inverseName] = [r.inverseName, r.name];
          // An embed's column belongs to the container. After a swap the container
          // is the other table, so the old choice no longer means anything.
          if (r.kind === 'embed') {
            r.sourceColumnIds = [];
            r.targetColumnIds = [];
          }
        }),

      /* ---------------- groups ---------------- */
      addGroup: (opts = {}) => {
        const d = get().diagram;
        const g = createGroup({
          name: uniqueGroupName(d, opts.name?.trim() || 'New group'),
          external: opts.external ?? false,
          color: opts.color ?? PALETTE_KEYS[d.groups.length % PALETTE_KEYS.length],
          note: opts.note,
          position: nextGroupPosition(d, get().placementSizes()),
        });
        const ids = new Set(opts.tableIds ?? []);
        mutate((dd) => {
          dd.groups.push(g);
          for (const t of dd.tables) if (ids.has(t.id)) t.groupId = g.id;
        });
        set((s) => {
          s.selection = { ...emptySelection(), groupId: g.id };
          s.inspectorOpen = true;
        });
        return g.id;
      },
      updateGroup: (id, patch) =>
        mutate(
          (d) => {
            const g = d.groups.find((x) => x.id === id);
            if (g) Object.assign(g, patch);
          },
          { coalesce: textPatchKey(`group:${id}`, patch) },
        ),
      deleteGroup: (id, withTables) => {
        const doomed = withTables ? get().diagram.tables.filter((t) => t.groupId === id).map((t) => t.id) : [];
        mutate((d) => {
          d.groups = d.groups.filter((g) => g.id !== id);
          if (withTables) {
            const idSet = new Set(doomed);
            d.tables = d.tables.filter((t) => !idSet.has(t.id));
            const pruned = pruneRelationships(d);
            d.relationships = pruned.relationships;
            d.tables = pruned.tables;
          } else {
            for (const t of d.tables) if (t.groupId === id) t.groupId = undefined;
          }
        });
        set((s) => {
          if (s.selection.groupId === id) s.selection.groupId = null;
          if (doomed.length) {
            const idSet = new Set(doomed);
            s.selection.tableIds = s.selection.tableIds.filter((x) => !idSet.has(x));
            if (s.trace.fromId && idSet.has(s.trace.fromId)) s.trace.fromId = null;
            if (s.trace.toId && idSet.has(s.trace.toId)) s.trace.toId = null;
            invalidateTrace(s);
          }
        });
      },
      setTableGroup: (tableIds, groupId) => {
        if (!tableIds.length) return;
        const ids = new Set(tableIds);
        mutate((d) => {
          for (const t of d.tables) if (ids.has(t.id)) t.groupId = groupId ?? undefined;
        });
      },
      moveGroup: (id, moves, anchor) =>
        mutate(
          (d) => {
            const byId = new Map(moves.map((m) => [m.id, m.position]));
            for (const t of d.tables) {
              const p = byId.get(t.id);
              if (p) t.position = p;
            }
            const g = d.groups.find((x) => x.id === id);
            if (g) g.position = anchor;
          },
          { history: false },
        ),

      /* ---------------- notes ---------------- */
      addNote: (position) => {
        const n = createNote({ position: position ?? { x: 120, y: 120 } });
        mutate((d) => {
          d.notes.push(n);
        });
        set((s) => {
          s.selection = { ...emptySelection(), noteIds: [n.id] };
        });
        return n.id;
      },
      updateNote: (id, patch) =>
        mutate(
          (d) => {
            const n = d.notes.find((x) => x.id === id);
            if (n) Object.assign(n, patch);
          },
          { coalesce: textPatchKey(`note:${id}`, patch) },
        ),
      duplicateNote: (id) => {
        const src = get().diagram.notes.find((n) => n.id === id);
        if (!src) return;
        const copy = createNote({ ...src, id: undefined, position: { x: src.position.x + 28, y: src.position.y + 28 } });
        mutate((d) => {
          d.notes.push(copy);
        });
        set((s) => {
          s.selection = { ...emptySelection(), noteIds: [copy.id] };
        });
      },
      deleteNote: (id) => removeElements({ noteIds: [id] }),

      /* ---------------- programs ---------------- */
      addProgram: (opts = {}) => {
        const name = uniqueProgramName(get().diagram, opts.name ?? 'new_program');
        const prg = createProgram({
          name,
          position: opts.position ?? nextProgramPosition(get().diagram),
          ...(opts.language ? { language: opts.language } : {}),
        });
        mutate((d) => {
          d.programs.push(prg);
        });
        set((s) => {
          s.selection = { ...emptySelection(), programIds: [prg.id] };
        });
        return prg.id;
      },
      updateProgram: (id, patch) =>
        mutate(
          (d) => {
            const p = d.programs.find((x) => x.id === id);
            if (p) Object.assign(p, patch);
          },
          { coalesce: textPatchKey(`program:${id}`, patch) },
        ),
      duplicateProgram: (id) => {
        const src = get().diagram.programs.find((p) => p.id === id);
        if (!src) return;
        const copy = createProgram({
          ...src,
          id: undefined,
          name: uniqueProgramName(get().diagram, src.name),
          position: { x: src.position.x + 28, y: src.position.y + 28 },
          // Steps are copied with fresh ids: they are the program's own, and two
          // programs sharing a step id would confuse every edge keyed on it.
          steps: src.steps.map((s) => createProgramStep({ ...s, id: undefined, columnIds: [...s.columnIds] })),
        });
        mutate((d) => {
          d.programs.push(copy);
        });
        set((s) => {
          s.selection = { ...emptySelection(), programIds: [copy.id] };
        });
      },
      deleteProgram: (id) => removeElements({ programIds: [id] }),
      addProgramStep: (programId, partial = {}, at) => {
        const step = createProgramStep(partial);
        mutate((d) => {
          const p = d.programs.find((x) => x.id === programId);
          if (!p) return;
          if (at === undefined || at < 0 || at > p.steps.length) p.steps.push(step);
          else p.steps.splice(at, 0, step);
        });
        return step.id;
      },
      updateProgramStep: (programId, stepId, patch) =>
        mutate(
          (d) => {
            const s = d.programs.find((x) => x.id === programId)?.steps.find((x) => x.id === stepId);
            if (!s) return;
            Object.assign(s, patch);
            // Switching to compute drops what a compute step cannot have, so the
            // model never holds a contradiction; switching back starts clean.
            if (s.op === 'compute') {
              delete s.tableId;
              delete s.sql;
              s.columnIds = [];
            }
          },
          { coalesce: textPatchKey(`step:${stepId}`, patch) },
        ),
      removeProgramStep: (programId, stepId) =>
        mutate((d) => {
          const p = d.programs.find((x) => x.id === programId);
          if (p) p.steps = p.steps.filter((s) => s.id !== stepId);
        }),
      moveProgramStep: (programId, stepId, delta) =>
        mutate((d) => {
          const p = d.programs.find((x) => x.id === programId);
          if (!p) return;
          const from = p.steps.findIndex((s) => s.id === stepId);
          const to = from + delta;
          if (from === -1 || to < 0 || to >= p.steps.length) return;
          const [moved] = p.steps.splice(from, 1);
          p.steps.splice(to, 0, moved);
        }),

      /* ---------------- canvas ---------------- */
      removeElements,
      deleteSelection: () => {
        const { selection } = get();
        if (selection.tableIds.length || selection.noteIds.length || selection.programIds.length || selection.relationshipId) {
          removeElements({
            tableIds: selection.tableIds,
            noteIds: selection.noteIds,
            programIds: selection.programIds,
            relationshipIds: selection.relationshipId ? [selection.relationshipId] : [],
          });
        } else if (selection.groupId) {
          get().deleteGroup(selection.groupId, false);
        }
      },
      nudgeSelection: (dx, dy) => {
        const { selection } = get();
        const tableIds = new Set(selection.tableIds);
        const noteIds = new Set(selection.noteIds);
        const programIds = new Set(selection.programIds);
        if (tableIds.size === 0 && noteIds.size === 0 && programIds.size === 0) return;
        mutate(
          (d) => {
            for (const t of d.tables) if (tableIds.has(t.id)) t.position = { x: t.position.x + dx, y: t.position.y + dy };
            for (const n of d.notes) if (noteIds.has(n.id)) n.position = { x: n.position.x + dx, y: n.position.y + dy };
            for (const pr of d.programs) if (programIds.has(pr.id)) pr.position = { x: pr.position.x + dx, y: pr.position.y + dy };
          },
          { coalesce: 'nudge' },
        );
      },
      moveItems: (moves) =>
        mutate(
          (d) => {
            for (const m of moves) {
              const t = d.tables.find((x) => x.id === m.id);
              if (t) {
                t.position = m.position;
                continue;
              }
              const n = d.notes.find((x) => x.id === m.id);
              if (n) {
                n.position = m.position;
                continue;
              }
              const pr = d.programs.find((x) => x.id === m.id);
              if (pr) pr.position = m.position;
            }
          },
          { history: false },
        ),
      beginDrag: () => {
        dragSnapshot.diagram = get().diagram;
      },
      endDrag: () => {
        const snap = dragSnapshot.diagram;
        dragSnapshot.diagram = null;
        if (!snap || snap === get().diagram) return;
        set((s) => pushHistory(s, snap));
      },
      setNodeSize: (id, size) =>
        set((s) => {
          const cur = s.nodeSizes[id];
          if (cur && cur.width === size.width && cur.height === size.height) return;
          s.nodeSizes[id] = size;
        }),
      placementSizes: () => placementSizes(get().diagram, get().nodeSizes, useUi.getState().lodCollapsed),
      applyLayout: (direction) => {
        const dir = direction ?? get().layoutDirection;
        const positions = layoutDiagram(get().diagram, { direction: dir, sizes: get().placementSizes() });
        mutate((d) => {
          for (const t of d.tables) {
            const p = positions[t.id];
            if (p) t.position = p;
          }
        });
        set((s) => {
          s.layoutDirection = dir;
          s.fitViewNonce++;
        });
      },
      setLayoutDirection: (direction) => set((s) => void (s.layoutDirection = direction)),
      requestFitView: () => set((s) => void s.fitViewNonce++),
      focusTable: (id) => set((s) => void (s.focusTableId = id)),
      focusRelationship: (id) => set((s) => void (s.focusRelationshipId = id)),
      focusColumn: (id) => set((s) => void (s.focusColumnId = id)),
      focusInspectorField: (field) => set((s) => void (s.focusFieldTarget = field)),
      importTables: (tables, relationships, mode, opts) => {
        const { layoutDirection, diagram } = get();
        const group = opts?.group;
        // Types belonging to a database we do not own would otherwise be created
        // by the script even though its tables are not. The columns keep their
        // type text either way, which is all an external table needs.
        const customTypes = group?.external ? undefined : opts?.customTypes;
        // Extensions are a property of the server, not of the tables, so they
        // still apply when the import is filed away as another database.
        const extensions = opts?.extensions ?? [];
        const newGroup = group
          ? createGroup({
              name: uniqueGroupName(mode === 'replace' ? { ...diagram, groups: [] } : diagram, group.name.trim() || 'Imported'),
              external: group.external,
              note: group.note,
              color: PALETTE_KEYS[(mode === 'replace' ? 0 : diagram.groups.length) % PALETTE_KEYS.length],
            })
          : null;
        if (newGroup) for (const t of tables) t.groupId = newGroup.id;
        mutate((d) => {
          if (mode === 'replace') {
            d.tables = tables;
            d.relationships = relationships;
            d.notes = [];
            d.groups = newGroup ? [newGroup] : [];
            d.customTypes = customTypes ?? [];
            d.extensions = extensions;
          } else {
            d.tables.push(...tables);
            d.relationships.push(...relationships);
            if (newGroup) d.groups.push(newGroup);
            if (customTypes?.length) d.customTypes.push(...customTypes);
            const already = new Set(d.extensions.map((e) => e.name.trim().toLowerCase()));
            for (const e of extensions) {
              if (already.has(e.name.trim().toLowerCase())) continue;
              already.add(e.name.trim().toLowerCase());
              d.extensions.push(e);
            }
          }
          // Lay everything out in the same history step so one undo removes the import.
          // Nothing imported has been drawn yet, so most of these are estimates; the
          // tables already on the canvas keep their measured sizes unless the zoom
          // has them collapsed to headers.
          const sizes = placementSizes(d as Diagram, get().nodeSizes, useUi.getState().lodCollapsed);
          const positions = layoutDiagram(d as Diagram, { direction: layoutDirection, sizes });
          for (const t of d.tables) {
            const p = positions[t.id];
            if (p) t.position = p;
          }
        });
        set((s) => {
          s.selection = emptySelection();
          invalidateTrace(s);
          s.fitViewNonce++;
        });
      },

      /* ---------------- selection ---------------- */
      setSelection: (sel) =>
        set((s) => {
          Object.assign(s.selection, sel);
          // Same rule the React Flow reducers apply: picking anything else up
          // takes over from a selected region, unless the caller says otherwise.
          if (sel.groupId === undefined && (s.selection.tableIds.length || s.selection.noteIds.length || s.selection.relationshipId)) {
            s.selection.groupId = null;
          }
        }),
      selectTable: (id, additive) =>
        set((s) => {
          if (additive) {
            if (s.selection.tableIds.includes(id)) s.selection.tableIds = s.selection.tableIds.filter((x) => x !== id);
            else s.selection.tableIds.push(id);
          } else {
            s.selection.tableIds = [id];
          }
          s.selection.relationshipId = null;
          s.selection.noteIds = [];
          s.selection.groupId = null;
          s.inspectorOpen = true;
        }),
      selectTables: (ids) =>
        set((s) => {
          s.selection = { ...emptySelection(), tableIds: [...ids] };
          if (ids.length) s.inspectorOpen = true;
        }),
      selectGroup: (id) =>
        set((s) => {
          s.selection = { ...emptySelection(), groupId: id };
          if (id) s.inspectorOpen = true;
        }),
      clearSelection: () =>
        set((s) => {
          s.selection = emptySelection();
        }),
      /*
       * These read get().selection rather than a value captured at render time: React Flow can
       * fire several selection updates (pointer move plus auto-pan) before React re-renders, and
       * replaying a delta onto a stale selection silently drops nodes the box already picked up.
       */
      applyNodeSelection: (changes, isNote) => {
        const next = applyNodeSelectionChanges(get().selection, changes, isNote);
        if (next) set((s) => void (s.selection = next));
      },
      applyEdgeSelection: (changes) => {
        const next = applyEdgeSelectionChanges(get().selection, changes);
        if (next) set((s) => void (s.selection = next));
      },

      /* ---------------- trace ---------------- */
      setTraceEndpoints: (fromId, toId) =>
        set((s) => {
          s.trace.fromId = fromId;
          s.trace.toId = toId;
          s.trace.result = null;
          s.trace.searched = false;
        }),
      runTrace: () => {
        const { trace, diagram } = get();
        if (!trace.fromId || !trace.toId) return;
        const result = findPath(diagram, trace.fromId, trace.toId);
        set((s) => {
          s.trace.result = result;
          s.trace.searched = true;
          s.trace.picking = false;
          s.drawer = { open: true, tab: 'trace' };
        });
      },
      clearTrace: () =>
        set((s) => {
          s.trace = { fromId: null, toId: null, result: null, searched: false, picking: false };
        }),
      setTracePicking: (picking) =>
        set((s) => {
          s.trace.picking = picking;
          if (picking) {
            s.trace.fromId = null;
            s.trace.toId = null;
            s.trace.result = null;
            s.trace.searched = false;
          }
        }),

      /* ---------------- ui ---------------- */
      setTheme: (theme) => {
        try {
          localStorage.setItem(THEME_KEY, theme);
        } catch {
          /* ignore */
        }
        set((s) => void (s.theme = theme));
      },
      openDrawer: (tab) =>
        set((s) => {
          s.drawer.open = true;
          if (tab) s.drawer.tab = tab;
        }),
      closeDrawer: () => set((s) => void (s.drawer.open = false)),
      openWalkthrough: (slug) =>
        set((s) => {
          s.activeWalkthroughSlug = slug;
          s.drawer.open = true;
          s.drawer.tab = 'walkthrough';
        }),
      setActiveWalkthrough: (slug) => set((s) => void (s.activeWalkthroughSlug = slug)),
      toggleDrawer: (tab) =>
        set((s) => {
          if (tab && s.drawer.tab !== tab) {
            s.drawer.tab = tab;
            s.drawer.open = true;
          } else {
            s.drawer.open = !s.drawer.open;
          }
        }),
      setSidebarOpen: (open) => set((s) => void (s.sidebarOpen = open)),
      setInspectorOpen: (open) => set((s) => void (s.inspectorOpen = open)),
      resizePanel: (key, delta) => {
        const [min, max] = PANEL_SIZE_LIMITS[key];
        set((s) => {
          const next = s.panelSizes[key] + delta;
          s.panelSizes[key] = Math.min(max, Math.max(min, next));
        });
        try {
          localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(get().panelSizes));
        } catch {
          /* ignore */
        }
      },
      toast: (kind, message) => {
        const id = newId('toast');
        set((s) => {
          s.toasts.push({ id, kind, message });
        });
        setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
      },
      dismissToast: (id) =>
        set((s) => {
          s.toasts = s.toasts.filter((t) => t.id !== id);
        }),
      markSaved: () =>
        set((s) => {
          s.dirty = false;
          s.fileBacked = true;
        }),
    };
  }),
);

/* ---------------- autosave ---------------- */

/** True when the saved shape of the workspace changed: any sheet, the tabs, the name. */
export function workspaceChanged(state: State, prev: State): boolean {
  return (
    state.diagram !== prev.diagram ||
    state.parked !== prev.parked ||
    state.sheetIds !== prev.sheetIds ||
    state.activeSheetId !== prev.activeSheetId ||
    state.workspaceName !== prev.workspaceName
  );
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (!workspaceChanged(state, prev)) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, serializeWorkspace(currentWorkspace(useStore.getState())));
    } catch {
      /* storage full or unavailable */
    }
  }, 400);
});

/* ---------------- selectors ---------------- */
export const selectSelectedTable = (s: Store): Table | undefined =>
  s.selection.tableIds.length === 1 && s.selection.noteIds.length === 0 ? s.diagram.tables.find((t) => t.id === s.selection.tableIds[0]) : undefined;
export const selectSelectedRelationship = (s: Store): Relationship | undefined =>
  s.selection.relationshipId ? s.diagram.relationships.find((r) => r.id === s.selection.relationshipId) : undefined;
export const selectSelectedNote = (s: Store): Note | undefined =>
  s.selection.noteIds.length === 1 && s.selection.tableIds.length === 0 ? s.diagram.notes.find((n) => n.id === s.selection.noteIds[0]) : undefined;
export const selectSelectedGroup = (s: Store): Group | undefined =>
  s.selection.groupId ? s.diagram.groups.find((g) => g.id === s.selection.groupId) : undefined;
export const selectSelectedProgram = (s: Store): Program | undefined =>
  s.selection.programIds.length === 1 && s.selection.tableIds.length === 0 && s.selection.noteIds.length === 0
    ? s.diagram.programs.find((p) => p.id === s.selection.programIds[0])
    : undefined;
