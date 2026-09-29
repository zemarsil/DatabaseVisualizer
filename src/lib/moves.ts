/**
 * Telling a move apart from an edit.
 *
 * Every frame of a drag writes new positions into the diagram, and so hands
 * every subscriber a new diagram object. Most of the app outside the canvas —
 * the linter, the SQL editors' completion scope, the inspector's forms — reads
 * what the diagram says and never where anything sits, yet each of them used
 * to redo its work on every one of those frames. On a diagram with a long
 * procedure that was a good part of why dragging stuttered.
 *
 * `onlyMoved` answers the one question those readers need: is the new diagram
 * the old one with things in different places? Where things sit means a
 * table's, a code node's, a note's and a group's position, a note's size, and
 * the saved viewport. Everything else is compared by identity, which the
 * store's immutable updates make exact: an edit anywhere else replaces the
 * object it touched.
 */
import type { Diagram } from '@shared/types';

/** Top-level fields of a diagram that only say where things are drawn. */
const LAYOUT_FIELDS = new Set<string>(['viewport']);
/** Per-item fields that only say where the item is drawn, for each list that has them. */
const ITEM_LAYOUT_FIELDS: Record<string, ReadonlySet<string>> = {
  tables: new Set(['position']),
  programs: new Set(['position']),
  groups: new Set(['position']),
  notes: new Set(['position', 'width', 'height']),
};

function sameExcept(a: object, b: object, skip: ReadonlySet<string>): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const k of keys) {
    if (skip.has(k)) {
      if (!Object.prototype.hasOwnProperty.call(rb, k)) return false;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(rb, k) || ra[k] !== rb[k]) return false;
  }
  return true;
}

function sameItemsExcept(a: readonly object[], b: readonly object[], skip: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !sameExcept(a[i], b[i], skip)) return false;
  return true;
}

/** True when `next` is `prev` with nothing changed but where things sit on the canvas. */
export function onlyMoved(prev: Diagram, next: Diagram): boolean {
  if (prev === next) return true;
  const rp = prev as unknown as Record<string, unknown>;
  const rn = next as unknown as Record<string, unknown>;
  // Both sides' keys: a field present on one only is a change, unless it is
  // layout (a viewport saved for the first time adds a key and moves nothing).
  for (const k of new Set([...Object.keys(rp), ...Object.keys(rn)])) {
    if (LAYOUT_FIELDS.has(k)) continue;
    const skip = ITEM_LAYOUT_FIELDS[k];
    if (skip) {
      if (!Array.isArray(rp[k]) || !Array.isArray(rn[k]) || !sameItemsExcept(rp[k] as object[], rn[k] as object[], skip)) return false;
    } else if (rp[k] !== rn[k]) return false;
  }
  return true;
}
