import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Column, CustomType, Diagram, Dialect, Group, Index, Note, Relationship, Table } from '@shared/types';
import { layoutDiagram, type LayoutDirection } from '@/lib/layout';
import {
  createColumn,
  createCustomType,
  createGroup,
  createIndex,
  createNote,
  createRelationship,
  createTable,
  emptyDiagram,
  pruneRelationships,
  uniqueColumnName,
  uniqueCustomTypeName,
  uniqueGroupName,
  uniqueTableName,
} from '@/lib/model';
import { nextGroupPosition } from '@/lib/groups';
import { PALETTE } from '@/lib/palette';
import { translateType } from '@/lib/sql/dialect';
import { findPath, type TraceResult } from '@/lib/trace';
import { parseDiagramFile, serializeDiagram } from '@/lib/io';
import { applyEdgeSelectionChanges, applyNodeSelectionChanges, emptySelection, type Selection, type SelectionChange } from '@/lib/selection';
import { sampleDiagram } from '@/lib/sample';
import { newId } from '@/lib/ids';

export type Theme = 'dark' | 'light';
export type DrawerTab = 'sql' | 'import' | 'database' | 'trace' | 'types';

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

const AUTOSAVE_KEY = 'dbviz:autosave';
const THEME_KEY = 'dbviz:theme';
const PANEL_SIZES_KEY = 'dbviz:panelSizes';
const HISTORY_LIMIT = 100;

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
  diagram: Diagram;
  past: Diagram[];
  future: Diagram[];
  nodeSizes: Record<string, NodeSize>;
  selection: Selection;
  trace: TraceState;
  theme: Theme;
  drawer: { open: boolean; tab: DrawerTab };
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  panelSizes: PanelSizes;
  toasts: Toast[];
  dirty: boolean;
  layoutDirection: LayoutDirection;
  /** Bumps whenever the canvas should call fitView (after layout / load). */
  fitViewNonce: number;
  /** Table id the canvas should scroll to. */
  focusTableId: string | null;
}

interface Actions {
  // history
  undo: () => void;
  redo: () => void;
  mutate: (fn: (d: Diagram) => void, opts?: { history?: boolean }) => void;
  setDiagram: (d: Diagram) => void;
  newDiagram: (dialect?: Dialect) => void;
  loadSample: () => void;

  // diagram metadata
  setDiagramName: (name: string) => void;
  setDialect: (dialect: Dialect, translateTypes: boolean) => void;

  // tables
  addTable: (position?: { x: number; y: number }) => string;
  updateTable: (id: string, patch: Partial<Omit<Table, 'id' | 'columns' | 'indexes'>>) => void;
  deleteTables: (ids: string[]) => void;
  duplicateTable: (id: string) => void;
  addColumn: (tableId: string, partial?: Partial<Column>) => string;
  updateColumn: (tableId: string, columnId: string, patch: Partial<Omit<Column, 'id'>>) => void;
  deleteColumn: (tableId: string, columnId: string) => void;
  moveColumn: (tableId: string, columnId: string, delta: -1 | 1) => void;
  addIndex: (tableId: string, columnIds?: string[]) => void;
  updateIndex: (tableId: string, indexId: string, patch: Partial<Omit<Index, 'id'>>) => void;
  deleteIndex: (tableId: string, indexId: string) => void;
  setChecks: (tableId: string, checks: string[]) => void;

  // custom types
  addCustomType: (kind: CustomType['kind']) => string;
  updateCustomType: (id: string, patch: Partial<Omit<CustomType, 'id' | 'kind'>>) => void;
  deleteCustomType: (id: string) => void;
  customTypeUsage: (id: string) => { table: Table; column: Column }[];

  // relationships
  addRelationship: (rel: Omit<Relationship, 'id'>) => string;
  updateRelationship: (id: string, patch: Partial<Omit<Relationship, 'id'>>) => void;
  deleteRelationship: (id: string) => void;
  swapRelationship: (id: string) => void;

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
  deleteNote: (id: string) => void;

  // canvas
  /** Deletes tables, notes and relationships together, as a single undo step. */
  removeElements: (ids: { tableIds?: string[]; noteIds?: string[]; relationshipIds?: string[] }) => void;
  moveItems: (moves: { id: string; position: { x: number; y: number } }[]) => void;
  beginDrag: () => void;
  endDrag: () => void;
  setNodeSize: (id: string, size: NodeSize) => void;
  applyLayout: (direction?: LayoutDirection) => void;
  setLayoutDirection: (direction: LayoutDirection) => void;
  requestFitView: () => void;
  focusTable: (id: string | null) => void;
  importTables: (
    tables: Table[],
    relationships: Relationship[],
    mode: 'merge' | 'replace',
    opts?: {
      customTypes?: CustomType[];
      /** Wrap everything imported in a new group, e.g. the database it came from. */
      group?: { name: string; external: boolean; note?: string };
    },
  ) => void;

  // selection
  setSelection: (sel: Partial<Selection>) => void;
  selectTable: (id: string, additive?: boolean) => void;
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
  setSidebarOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  resizePanel: (key: keyof PanelSizes, delta: number) => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  markSaved: () => void;
}

export type Store = State & Actions;

function loadInitialDiagram(): Diagram {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return parseDiagramFile(raw);
  } catch {
    /* fall through to sample */
  }
  return sampleDiagram();
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
      set((s) => {
        if (opts?.history !== false) pushHistory(s, snapshot);
        else s.dirty = true;
        fn(s.diagram);
      });
    };

    const invalidateTrace = (s: State) => {
      if (s.trace.result) s.trace.result = null;
      s.trace.searched = false;
    };

    const removeElements: Actions['removeElements'] = ({ tableIds = [], noteIds = [], relationshipIds = [] }) => {
      const tables = new Set(tableIds);
      const notes = new Set(noteIds);
      const rels = new Set(relationshipIds);
      if (!tables.size && !notes.size && !rels.size) return;
      mutate((d) => {
        if (tables.size) d.tables = d.tables.filter((t) => !tables.has(t.id));
        if (notes.size) d.notes = d.notes.filter((n) => !notes.has(n.id));
        if (rels.size) d.relationships = d.relationships.filter((r) => !rels.has(r.id));
        if (tables.size) {
          // Drop the relationships and index entries left dangling by the removed tables.
          const pruned = pruneRelationships(d);
          d.relationships = pruned.relationships;
          d.tables = pruned.tables;
        }
      });
      set((s) => {
        if (tables.size) s.selection.tableIds = s.selection.tableIds.filter((x) => !tables.has(x));
        if (notes.size) s.selection.noteIds = s.selection.noteIds.filter((x) => !notes.has(x));
        if (s.selection.relationshipId && rels.has(s.selection.relationshipId)) s.selection.relationshipId = null;
        if (s.trace.fromId && tables.has(s.trace.fromId)) s.trace.fromId = null;
        if (s.trace.toId && tables.has(s.trace.toId)) s.trace.toId = null;
        if (tables.size || rels.size) invalidateTrace(s);
      });
    };

    return {
      diagram: loadInitialDiagram(),
      past: [],
      future: [],
      nodeSizes: {},
      selection: emptySelection(),
      trace: { fromId: null, toId: null, result: null, searched: false, picking: false },
      theme: loadTheme(),
      drawer: { open: false, tab: 'sql' },
      sidebarOpen: true,
      inspectorOpen: true,
      panelSizes: loadPanelSizes(),
      toasts: [],
      dirty: false,
      layoutDirection: 'LR',
      fitViewNonce: 0,
      focusTableId: null,

      /* ---------------- history ---------------- */
      undo: () => {
        const cur = get().diagram;
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
        set((s) => {
          s.diagram = d;
          s.past = [];
          s.future = [];
          s.selection = emptySelection();
          s.trace = { fromId: null, toId: null, result: null, searched: false, picking: false };
          s.nodeSizes = {};
          s.dirty = false;
          s.fitViewNonce++;
        });
      },
      newDiagram: (dialect = 'postgresql') => get().setDiagram(emptyDiagram(dialect)),
      loadSample: () => get().setDiagram(sampleDiagram()),

      /* ---------------- metadata ---------------- */
      setDiagramName: (name) => mutate((d) => void (d.name = name), { history: false }),
      setDialect: (dialect, translateTypes) =>
        mutate((d) => {
          const from = d.dialect;
          d.dialect = dialect;
          if (translateTypes && from !== dialect) {
            for (const t of d.tables) for (const c of t.columns) c.type = translateType(c.type, from, dialect);
          }
        }),

      /* ---------------- tables ---------------- */
      addTable: (position) => {
        const d = get().diagram;
        const t = createTable({ name: uniqueTableName(d), position: position ?? { x: 80, y: 80 } });
        t.columns.push(createColumn({ name: 'id', type: d.dialect === 'mariadb' ? 'INT' : 'INTEGER', primaryKey: true, nullable: false, autoIncrement: true }));
        mutate((dd) => {
          dd.tables.push(t);
        });
        set((s) => {
          s.selection = { ...emptySelection(), tableIds: [t.id] };
          s.inspectorOpen = true;
        });
        return t.id;
      },
      updateTable: (id, patch) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === id);
          if (t) Object.assign(t, patch);
        }),
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
      addColumn: (tableId, partial) => {
        const d = get().diagram;
        const t = d.tables.find((x) => x.id === tableId);
        if (!t) return '';
        const col = createColumn({ name: uniqueColumnName(t, partial?.name ?? 'column'), type: partial?.type ?? 'VARCHAR(255)', ...partial });
        mutate((dd) => {
          dd.tables.find((x) => x.id === tableId)?.columns.push(col);
        });
        return col.id;
      },
      updateColumn: (tableId, columnId, patch) =>
        mutate((d) => {
          const c = d.tables.find((x) => x.id === tableId)?.columns.find((x) => x.id === columnId);
          if (!c) return;
          Object.assign(c, patch);
          if (patch.primaryKey) c.nullable = false;
        }),
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
      addIndex: (tableId, columnIds) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (!t) return;
          const ids = columnIds?.length ? columnIds : t.columns.slice(0, 1).map((c) => c.id);
          t.indexes.push(createIndex({ columnIds: ids }));
        }),
      updateIndex: (tableId, indexId, patch) =>
        mutate((d) => {
          const ix = d.tables.find((x) => x.id === tableId)?.indexes.find((x) => x.id === indexId);
          if (ix) Object.assign(ix, patch);
        }),
      deleteIndex: (tableId, indexId) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (t) t.indexes = t.indexes.filter((x) => x.id !== indexId);
        }),
      setChecks: (tableId, checks) =>
        mutate((d) => {
          const t = d.tables.find((x) => x.id === tableId);
          if (t) t.checks = checks;
        }),

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
        mutate((d) => {
          const r = d.relationships.find((x) => x.id === id);
          if (r) Object.assign(r, patch);
        }),
      deleteRelationship: (id) => removeElements({ relationshipIds: [id] }),
      swapRelationship: (id) =>
        mutate((d) => {
          const r = d.relationships.find((x) => x.id === id);
          if (!r) return;
          [r.sourceTableId, r.targetTableId] = [r.targetTableId, r.sourceTableId];
          [r.sourceColumnIds, r.targetColumnIds] = [r.targetColumnIds, r.sourceColumnIds];
        }),

      /* ---------------- groups ---------------- */
      addGroup: (opts = {}) => {
        const d = get().diagram;
        const g = createGroup({
          name: uniqueGroupName(d, opts.name?.trim() || 'New group'),
          external: opts.external ?? false,
          color: opts.color ?? PALETTE_KEYS[d.groups.length % PALETTE_KEYS.length],
          note: opts.note,
          position: nextGroupPosition(d, get().nodeSizes),
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
        mutate((d) => {
          const g = d.groups.find((x) => x.id === id);
          if (g) Object.assign(g, patch);
        }),
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
        mutate((d) => {
          const n = d.notes.find((x) => x.id === id);
          if (n) Object.assign(n, patch);
        }),
      deleteNote: (id) => removeElements({ noteIds: [id] }),

      /* ---------------- canvas ---------------- */
      removeElements,
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
              if (n) n.position = m.position;
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
      applyLayout: (direction) => {
        const dir = direction ?? get().layoutDirection;
        const positions = layoutDiagram(get().diagram, { direction: dir, sizes: get().nodeSizes });
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
      importTables: (tables, relationships, mode, opts) => {
        const { layoutDirection, nodeSizes, diagram } = get();
        const group = opts?.group;
        // Types belonging to a database we do not own would otherwise be created
        // by the script even though its tables are not. The columns keep their
        // type text either way, which is all an external table needs.
        const customTypes = group?.external ? undefined : opts?.customTypes;
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
          } else {
            d.tables.push(...tables);
            d.relationships.push(...relationships);
            if (newGroup) d.groups.push(newGroup);
            if (customTypes?.length) d.customTypes.push(...customTypes);
          }
          // Lay everything out in the same history step so one undo removes the import.
          const positions = layoutDiagram(d as Diagram, { direction: layoutDirection, sizes: nodeSizes });
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
      markSaved: () => set((s) => void (s.dirty = false)),
    };
  }),
);

/* ---------------- autosave ---------------- */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (state.diagram === prev.diagram) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, serializeDiagram(useStore.getState().diagram));
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
