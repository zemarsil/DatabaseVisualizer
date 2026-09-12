/**
 * The bridge between a step's goals and the live app: reads the state goals are
 * judged against, and — when the reader would rather watch than type — makes
 * them true.
 *
 * Everything that edits the diagram goes through one `mutate` call per step, so
 * **Do it for me** is a single `Ctrl+Z` away from being undone. Goals that are
 * about what is on screen rather than what is in the diagram (open this tab,
 * select that table, run the trace) are applied through the stores instead, and
 * are deliberately not part of that undo entry — nothing changed in the file.
 */
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { applyGoal, applyViewGoal, evaluateGoals, isFixable, isViewGoal, type Goal, type GoalContext, type GoalStatus, type TourView, type TourViewApi } from './goals';
import type { TourStep } from './steps';

/** What the stores currently say, in the shape goals are written against. */
export function currentView(): TourView {
  const s = useStore.getState();
  const ui = useUi.getState();
  const sim = useSimulation.getState();
  return {
    drawerTab: s.drawer.open ? s.drawer.tab : null,
    selectedTableIds: s.selection.tableIds,
    selectedRelationshipId: s.selection.relationshipId,
    showCardinality: ui.showCardinality,
    simulateTargetId: sim.targetId,
    tracePath: s.trace.result?.nodeIds ?? null,
    focusTableId: ui.focus?.nodeId ?? null,
    selectedProgramIds: s.selection.programIds,
  };
}

export function goalContext(step: TourStep): GoalContext {
  return { diagram: useStore.getState().diagram, view: currentView(), code: step.code };
}

export function checkStep(step: TourStep): GoalStatus[] {
  return evaluateGoals(step.goals, goalContext(step));
}

function viewApi(): TourViewApi {
  const s = useStore.getState();
  return {
    openDrawer: (tab) => s.openDrawer(tab as Parameters<typeof s.openDrawer>[0]),
    selectTable: (id) => {
      s.selectTable(id);
      s.focusTable(id);
    },
    selectRelationship: (id) => {
      s.setSelection({ relationshipId: id, tableIds: [], noteIds: [] });
      s.focusRelationship(id);
    },
    setShowCardinality: (on) => useUi.getState().setShowCardinality(on),
    startSimulation: (tableId) => useSimulation.getState().start(tableId),
    runTrace: (fromId, toId) => {
      s.setTraceEndpoints(fromId, toId);
      s.runTrace();
    },
    setFocus: (tableId) => useUi.getState().setFocus(tableId ? { nodeId: tableId, hops: 1 } : null),
    selectCode: (id) => {
      s.setSelection({ programIds: [id], tableIds: [], noteIds: [], relationshipId: null, groupId: null });
      s.setInspectorOpen(true);
      s.focusTable(id);
    },
  };
}

/**
 * Does everything in a step that can be done automatically, in the order the
 * step lists it. Returns the goals it actually moved, for the toast that says
 * what just happened.
 */
export function performStep(step: TourStep): Goal[] {
  const ctx = goalContext(step);
  const pending = step.goals.filter((g) => isFixable(g) && !evaluateGoals([g], ctx)[0].ok);
  if (!pending.length) return [];

  const changed: Goal[] = [];
  if (pending.some((g) => !isViewGoal(g))) {
    useStore.getState().mutate((d) => {
      for (const goal of pending) {
        if (applyGoal(goal, d, { ...ctx, diagram: d })) changed.push(goal);
      }
    });
  }

  // View goals run after the diagram edits, so "select the connection you just
  // drew" has something to select. They are not part of the undo entry above:
  // opening a tab changed nothing in the file.
  const api = viewApi();
  const after: GoalContext = { ...ctx, diagram: useStore.getState().diagram, view: currentView() };
  for (const goal of pending) {
    if (isViewGoal(goal) && applyViewGoal(goal, after, api)) changed.push(goal);
  }
  return changed;
}
