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
}

export const emptySelection = (): Selection => ({ tableIds: [], noteIds: [], relationshipId: null });

export interface SelectionChange {
  id: string;
  selected: boolean;
}

export function selectionSize(sel: Selection): number {
  return sel.tableIds.length + sel.noteIds.length + (sel.relationshipId ? 1 : 0);
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
  // Picking anything up on the canvas takes over from a selected relationship.
  const relationshipId = tableIds.length || noteIds.length ? null : current.relationshipId;
  return { tableIds, noteIds, relationshipId };
}

/**
 * Applies edge select/deselect changes. Only one relationship can be selected at a time,
 * and selecting one clears the node selection.
 *
 * Callers must NOT feed marquee-driven edge changes in here: React Flow marks every edge
 * touching a boxed node as selected, which would wipe the group the box just picked up.
 */
export function applyEdgeSelectionChanges(current: Selection, changes: SelectionChange[]): Selection | null {
  let next: Selection | null = null;
  for (const ch of changes) {
    const base: Selection = next ?? current;
    if (ch.selected) {
      if (base.relationshipId === ch.id && !base.tableIds.length && !base.noteIds.length) continue;
      next = { tableIds: [], noteIds: [], relationshipId: ch.id };
    } else if (base.relationshipId === ch.id) {
      next = { ...base, relationshipId: null };
    }
  }
  return next;
}
