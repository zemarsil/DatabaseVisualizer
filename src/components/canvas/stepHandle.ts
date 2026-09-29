/** The part of a measured React Flow handle an arrow needs to anchor on it. */
interface HandleBox {
  id?: string | null;
  y: number;
  height: number;
}

const indexes = new WeakMap<readonly HandleBox[], Map<string, HandleBox>>();

/**
 * The measured handle of one step row, found by the step's id.
 *
 * Every arrow leaving a node used to scan all of that node's handles for its
 * own, building two id strings per handle as it went; a hundred-step
 * procedure's hundred arrows each scanning its two hundred handles was forty
 * thousand strings a frame while it was dragged. The handles are indexed once
 * instead. React Flow replaces the list whenever it re-measures the node, so
 * the list itself keys the index and a stale one is never read.
 */
export function stepHandle(handles: readonly HandleBox[] | undefined, stepId: string | null): HandleBox | undefined {
  if (!handles || !stepId) return undefined;
  let index = indexes.get(handles);
  if (!index) {
    index = new Map();
    for (const h of handles) {
      // Step rows carry `${stepId}|l` and `${stepId}|r`; the first one listed wins, as it did.
      if (!h.id || !(h.id.endsWith('|l') || h.id.endsWith('|r'))) continue;
      const id = h.id.slice(0, -2);
      if (!index.has(id)) index.set(id, h);
    }
    indexes.set(handles, index);
  }
  return index.get(stepId);
}
