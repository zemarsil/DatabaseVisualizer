import { create } from 'zustand';
import type { Diagram } from '@shared/types';
import { simulateFlows, type SimulationResult } from '@/lib/simulate/engine';
import type { Value } from '@/lib/simulate/expression';
import { useStore } from './useStore';

/**
 * The data-flow simulation: which table is being fed, the sample data
 * options, the computed result, and the playback position. Kept out of
 * useStore so it never lands in undo history or autosave; the result is
 * recomputed whenever the diagram's structure changes while a simulation is
 * on, so editing a derivation updates the rows live.
 */

export type CellOverrides = Record<string, Record<number, Record<string, Value>>>;

export interface PickedRow {
  tableId: string;
  row: number;
}

export const SIMULATION_SPEEDS: { ms: number; label: string }[] = [
  { ms: 3600, label: 'Slow' },
  { ms: 2200, label: 'Normal' },
  { ms: 1200, label: 'Fast' },
];

interface SimulationState {
  /** Table being fed, or null while the mode is off. */
  targetId: string | null;
  rows: number;
  seed: number;
  overrides: CellOverrides;
  result: SimulationResult | null;
  /** -1 before the first stage runs; stages.length - 1 once every flow has run. */
  stage: number;
  playing: boolean;
  /** Milliseconds per stage while playing. */
  speedMs: number;
  /** Bumps whenever the stage changes, so the canvas restarts its packets. */
  nonce: number;
  /** Row picked in the panel to show where it came from. */
  picked: PickedRow | null;

  /** Turn the mode on for a table and, by default, start playing. */
  start: (targetId: string, opts?: { play?: boolean }) => void;
  stop: () => void;
  setRows: (rows: number) => void;
  setSeed: (seed: number) => void;
  reshuffle: () => void;
  setOverride: (tableId: string, row: number, columnId: string, value: Value) => void;
  clearOverrides: () => void;
  play: () => void;
  pause: () => void;
  step: (delta: number) => void;
  goTo: (stage: number) => void;
  restart: () => void;
  setSpeed: (ms: number) => void;
  pick: (picked: PickedRow | null) => void;
  /** Recompute the result against the current diagram. */
  recompute: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const useSimulation = create<SimulationState>()((set, get) => {
  const compute = (targetId: string): SimulationResult => {
    const { rows, seed, overrides } = get();
    return simulateFlows(useStore.getState().diagram, targetId, { rows, seed, overrides });
  };

  const schedule = () => {
    clearTimer();
    const { playing, speedMs } = get();
    if (!playing) return;
    timer = setTimeout(() => {
      timer = null;
      const s = get();
      if (!s.playing || !s.result) return;
      const last = s.result.stages.length - 1;
      if (s.stage >= last) {
        set({ playing: false });
        return;
      }
      set({ stage: s.stage + 1, nonce: s.nonce + 1, picked: null });
      schedule();
    }, speedMs);
  };

  return {
    targetId: null,
    rows: 10,
    seed: 1,
    overrides: {},
    result: null,
    stage: -1,
    playing: false,
    speedMs: SIMULATION_SPEEDS[1].ms,
    nonce: 0,
    picked: null,

    start: (targetId, opts) => {
      clearTimer();
      const result = compute(targetId);
      const play = opts?.play ?? true;
      set((s) => ({ targetId, result, stage: -1, playing: play && result.stages.length > 0, nonce: s.nonce + 1, picked: null }));
      useStore.getState().openDrawer('simulate');
      schedule();
    },
    stop: () => {
      clearTimer();
      set({ targetId: null, result: null, stage: -1, playing: false, picked: null });
    },
    setRows: (rows) => {
      set({ rows: Math.max(0, Math.min(500, Math.floor(rows) || 0)) });
      get().recompute();
    },
    setSeed: (seed) => {
      set({ seed: Math.max(0, Math.floor(seed) || 0) });
      get().recompute();
    },
    reshuffle: () => get().setSeed(Math.floor(Math.random() * 1_000_000)),
    setOverride: (tableId, row, columnId, value) => {
      set((s) => ({ overrides: { ...s.overrides, [tableId]: { ...s.overrides[tableId], [row]: { ...s.overrides[tableId]?.[row], [columnId]: value } } } }));
      get().recompute();
    },
    clearOverrides: () => {
      set({ overrides: {} });
      get().recompute();
    },
    play: () => {
      const s = get();
      if (!s.result || !s.result.stages.length) return;
      const last = s.result.stages.length - 1;
      // Play from the end starts over, which is what a second click on Play means.
      set({ playing: true, ...(s.stage >= last ? { stage: -1, nonce: s.nonce + 1, picked: null } : {}) });
      schedule();
    },
    pause: () => {
      clearTimer();
      set({ playing: false });
    },
    step: (delta) => {
      const s = get();
      if (!s.result) return;
      clearTimer();
      const next = Math.max(-1, Math.min(s.result.stages.length - 1, s.stage + delta));
      if (next === s.stage) return;
      set({ stage: next, playing: false, nonce: s.nonce + 1, picked: null });
    },
    goTo: (stage) => {
      const s = get();
      if (!s.result) return;
      clearTimer();
      const next = Math.max(-1, Math.min(s.result.stages.length - 1, stage));
      set({ stage: next, playing: false, nonce: s.nonce + 1, picked: null });
    },
    restart: () => {
      const s = get();
      clearTimer();
      set({ stage: -1, playing: Boolean(s.result?.stages.length), nonce: s.nonce + 1, picked: null });
      schedule();
    },
    setSpeed: (ms) => {
      set({ speedMs: ms });
      if (get().playing) schedule();
    },
    pick: (picked) => set({ picked }),
    recompute: () => {
      const s = get();
      if (!s.targetId) return;
      const diagram = useStore.getState().diagram;
      if (!diagram.tables.some((t) => t.id === s.targetId)) {
        get().stop();
        return;
      }
      const result = compute(s.targetId);
      const last = result.stages.length - 1;
      set({ result, stage: Math.min(s.stage, last), picked: null });
    },
  };
});

/* ---------------- keep the result fresh ---------------- */

/** What the simulation depends on: everything but positions, colours and collapse state. */
function structuralSignature(d: Diagram): string {
  return JSON.stringify({
    dialect: d.dialect,
    tables: d.tables.map(({ position: _p, color: _c, collapsed: _k, ...rest }) => rest),
    relationships: d.relationships,
    customTypes: d.customTypes,
    groups: d.groups.map((g) => [g.id, g.external]),
  });
}

let lastSignature: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

useStore.subscribe((state, prev) => {
  if (state.diagram === prev.diagram) return;
  const sim = useSimulation.getState();
  if (!sim.targetId) {
    lastSignature = null;
    return;
  }
  if (refreshTimer) clearTimeout(refreshTimer);
  // Dragging a table changes the diagram many times a second; only a change to
  // its structure is worth a recompute, and a short delay batches a burst of edits.
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const sig = structuralSignature(useStore.getState().diagram);
    if (sig === lastSignature) return;
    lastSignature = sig;
    useSimulation.getState().recompute();
  }, 150);
});

/** Convenience for components: is a simulation on, and what stage is it at. */
export function selectSimulationActive(s: SimulationState): boolean {
  return s.targetId !== null && s.result !== null;
}
