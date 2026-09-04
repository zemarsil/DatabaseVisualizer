/**
 * Canvas selection state and the pure reducers that keep it in sync with React Flow.
 *
 * React Flow reports selection as a delta ("node x became selected") rather than as a
 * complete set, so the reducers here replay those deltas onto the current selection.
 * Keeping them free of React/store code makes the box-selection rules unit-testable.
 */

export interface Selection {
  tableIds: string[];
  noteIds: string[];
  relationshipId: string | null;
  /**
   * Selected table group. Regions are not React Flow nodes, so no delta ever
   * arrives for one; the reducers only need to drop it when something else on
   * the canvas is picked up.
   */
  groupId: string | null;
}

export const emptySelection = (): Selection => ({ tableIds: [], noteIds: [], relationshipId: null, groupId: null });

export interface SelectionChange {
  id: string;
  selected: boolean;
}

export function selectionSize(sel: Selection): number {
  return sel.tableIds.length + sel.noteIds.length + (sel.relationshipId ? 1 : 0) + (sel.groupId ? 1 : 0);
}

function toggle(list: string[], id: string, selected: boolean): string[] {
  if (selected) return list.includes(id) ? list : [...list, id];
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

/**
 * Applies node select/deselect changes. Tables and notes are both multi-selectable so a
 * marquee can pick up a mixed group and drag it as one.
 *
 * Returns `null` when nothing actually changed so callers can skip the store write.
 */
export function applyNodeSelectionChanges(current: Selection, changes: SelectionChange[], isNote: (id: string) => boolean): Selection | null {
  let { tableIds, noteIds } = current;
  for (const ch of changes) {
    if (isNote(ch.id)) noteIds = toggle(noteIds, ch.id, ch.selected);
    else tableIds = toggle(tableIds, ch.id, ch.selected);
  }
  if (tableIds === current.tableIds && noteIds === current.noteIds) return null;
  // Picking anything up on the canvas takes over from a selected relationship or
  // region; a box that ends up empty leaves both alone.
  const picked = tableIds.length > 0 || noteIds.length > 0;
  return {
    tableIds,
    noteIds,
    relationshipId: picked ? null : current.relationshipId,
    groupId: picked ? null : current.groupId,
  };
}

/**
 * Applies edge select/deselect changes. Only one relationship can be selected at a time,
 * and selecting one clears the node and group selection.
 *
 * Callers must NOT feed marquee-driven edge changes in here: React Flow marks every edge
 * touching a boxed node as selected, which would wipe the group the box just picked up.
 */
export function applyEdgeSelectionChanges(current: Selection, changes: SelectionChange[]): Selection | null {
  let next: Selection | null = null;
  for (const ch of changes) {
    const base: Selection = next ?? current;
    if (ch.selected) {
      if (base.relationshipId === ch.id && !base.tableIds.length && !base.noteIds.length && !base.groupId) continue;
      next = { tableIds: [], noteIds: [], relationshipId: ch.id, groupId: null };
    } else if (base.relationshipId === ch.id) {
      next = { ...base, relationshipId: null };
    }
  }
  return next;
}
