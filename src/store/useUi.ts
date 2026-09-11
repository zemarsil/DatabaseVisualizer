import { create } from 'zustand';

/**
 * UI-only state that is not part of the diagram: the command palette, the
 * diagram library dialog, focus mode, the derived-column lens, canvas
 * preferences, and hand-offs to the Query tab. Kept out of useStore so it never
 * lands in undo history or autosave. (Right-click menus have their own store in
 * ui/ContextMenu.tsx.)
 */

/** Neighborhood focus: dim everything further than `hops` from the table. */
export interface FocusState {
  tableId: string;
  hops: number;
}

/**
 * The derived lens: a way of reading the canvas where what matters is whether a
 * column is computed or stored, not how the tables connect. `column` narrows it
 * further to one column's own lineage — the chain of flows that fills it and the
 * chain that reads it — and is what the Derived tab sets when you pick a column.
 */
export interface DerivedLens {
  /** Column whose lineage is highlighted, or null for the whole diagram at once. */
  columnId: string | null;
  /** Follow what the column feeds as well as what feeds it. */
  downstream: boolean;
}

export interface PendingQuery {
  sql: string;
  /** Run immediately once the Query tab picks it up. */
  run: boolean;
  nonce: number;
}

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  libraryOpen: boolean;
  setLibraryOpen: (open: boolean) => void;

  focus: FocusState | null;
  setFocus: (focus: FocusState | null) => void;

  /** Null when the lens is off. */
  derived: DerivedLens | null;
  setDerived: (lens: DerivedLens | null) => void;
  toggleDerived: () => void;
  /** Turn the lens on (if it is off) and point it at one column; null widens it back to the diagram. */
  showLineage: (columnId: string | null) => void;

  /** Table whose header is being renamed in place on the canvas. */
  renamingTableId: string | null;
  setRenamingTableId: (id: string | null) => void;

  /**
   * Program step the canvas last pointed at. Clicking a step on a program node
   * sets it, and the inspector opens on that step, so the two halves of the
   * screen stay looking at the same thing.
   */
  activeProgramStepId: string | null;
  setActiveProgramStepId: (id: string | null) => void;

  /** Persisted canvas preferences. */
  snapToGrid: boolean;
  setSnapToGrid: (on: boolean) => void;
  showCardinality: boolean;
  setShowCardinality: (on: boolean) => void;
  warnOnClose: boolean;
  setWarnOnClose: (on: boolean) => void;

  /** True while the canvas is zoomed out far enough that tables render as headers only. */
  lodCollapsed: boolean;
  setLodCollapsed: (on: boolean) => void;

  /** SQL handed to the Query tab by a "Run" button elsewhere. */
  pendingQuery: PendingQuery | null;
  setPendingQuery: (sql: string, run: boolean) => void;
  clearPendingQuery: () => void;
}

const PREFS_KEY = 'dbviz:ui';

interface Prefs {
  snapToGrid: boolean;
  showCardinality: boolean;
  warnOnClose: boolean;
}

function loadPrefs(): Prefs {
  const defaults: Prefs = { snapToGrid: false, showCardinality: true, warnOnClose: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return defaults;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

let queryNonce = 0;

export const useUi = create<UiState>()((set, get) => {
  const prefs = loadPrefs();
  const persist = () => {
    const s = get();
    savePrefs({ snapToGrid: s.snapToGrid, showCardinality: s.showCardinality, warnOnClose: s.warnOnClose });
  };
  return {
    paletteOpen: false,
    setPaletteOpen: (open) => set({ paletteOpen: open }),

    libraryOpen: false,
    setLibraryOpen: (open) => set({ libraryOpen: open }),

    focus: null,
    setFocus: (focus) => set({ focus }),

    derived: null,
    setDerived: (derived) => set({ derived }),
    toggleDerived: () => set({ derived: get().derived ? null : { columnId: null, downstream: true } }),
    showLineage: (columnId) => set({ derived: { ...(get().derived ?? { downstream: true }), columnId } }),

    renamingTableId: null,
    setRenamingTableId: (id) => set({ renamingTableId: id }),

    activeProgramStepId: null,
    setActiveProgramStepId: (id) => set({ activeProgramStepId: id }),

    snapToGrid: prefs.snapToGrid,
    setSnapToGrid: (on) => {
      set({ snapToGrid: on });
      persist();
    },
    showCardinality: prefs.showCardinality,
    setShowCardinality: (on) => {
      set({ showCardinality: on });
      persist();
    },
    warnOnClose: prefs.warnOnClose,
    setWarnOnClose: (on) => {
      set({ warnOnClose: on });
      persist();
    },

    lodCollapsed: false,
    setLodCollapsed: (on) => {
      if (get().lodCollapsed !== on) set({ lodCollapsed: on });
    },

    pendingQuery: null,
    setPendingQuery: (sql, run) => set({ pendingQuery: { sql, run, nonce: ++queryNonce } }),
    clearPendingQuery: () => set({ pendingQuery: null }),
  };
});
