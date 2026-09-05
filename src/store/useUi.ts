import { create } from 'zustand';

/**
 * UI-only state that is not part of the diagram: the command palette, the
 * diagram library dialog, focus mode, canvas preferences, and hand-offs to the
 * Query tab. Kept out of useStore so it never lands in undo history or
 * autosave. (Right-click menus have their own store in ui/ContextMenu.tsx.)
 */

/** Neighborhood focus: dim everything further than `hops` from the table. */
export interface FocusState {
  tableId: string;
  hops: number;
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

  /** Table whose header is being renamed in place on the canvas. */
  renamingTableId: string | null;
  setRenamingTableId: (id: string | null) => void;

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

    renamingTableId: null,
    setRenamingTableId: (id) => set({ renamingTableId: id }),

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
