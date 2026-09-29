/**
 * Keeping what the canvas hands React Flow the same object when it has not changed.
 *
 * The canvas derives its nodes and edges from the diagram, and every edit —
 * including every frame of a drag — produces a new diagram, so every node and
 * every edge used to come out as a new object even when nothing about it had
 * moved. React Flow keys its work on identity: a new node object is re-adopted
 * and re-rendered, and every edge touching it re-renders with it. On a diagram
 * with a hundred-step procedure that was the whole canvas redrawn per frame to
 * move one box.
 *
 * So the freshly derived list is compared against the last one, item by item,
 * and anything structurally equal is swapped back for the object React Flow
 * already has. Only what actually changed arrives as new.
 */

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality over plain data: primitives, arrays and plain objects,
 * short-circuiting on identity so unchanged diagram objects cost nothing.
 * Anything else (a Map, a Set, a class instance, a function) is equal only to
 * itself, which errs on the side of treating it as changed.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(rb, k) || !sameData(ra[k], rb[k])) return false;
  return true;
}

/**
 * `next`, with every item structurally equal to the item of the same id in
 * `prev` replaced by that earlier object. When every item came back and in the
 * same order, `prev` itself is returned, so a caller comparing lists by
 * identity sees no change at all.
 */
export function reuseUnchanged<T extends { id: string }>(prev: readonly T[] | null | undefined, next: T[]): T[] {
  if (!prev) return next;
  // Empty is a common steady state (a diagram with no arrows of one kind), and
  // a fresh [] every render would still read as a change.
  if (prev.length === 0) return next.length === 0 ? (prev as T[]) : next;
  const byId = new Map<string, T>();
  for (const item of prev) byId.set(item.id, item);
  let unchanged = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = byId.get(item.id);
    if (old !== undefined && sameData(old, item)) {
      if (prev[i] !== old) unchanged = false;
      return old;
    }
    unchanged = false;
    return item;
  });
  return unchanged ? (prev as T[]) : out;
}
