import { ArrowLeftRight, Sigma, X } from 'lucide-react';
import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { buildLineage, lineageTotals } from '@/lib/lineage';

/**
 * Shown while the derived lens is on: what the colours mean, how much of the
 * schema is computed rather than stored, and — once a column is picked — whose
 * lineage is on screen.
 */
export function DerivedBanner() {
  const lens = useUi((s) => s.derived);
  const setDerived = useUi((s) => s.setDerived);
  const showLineage = useUi((s) => s.showLineage);
  const diagram = useStore((s) => s.diagram);
  const openDrawer = useStore((s) => s.openDrawer);

  const lineage = useMemo(() => buildLineage(diagram), [diagram]);
  const totals = useMemo(() => lineageTotals(lineage, diagram), [lineage, diagram]);
  const focused = useMemo(() => {
    if (!lens?.columnId) return null;
    const tableId = lineage.tableOfColumn.get(lens.columnId);
    const table = tableId ? lineage.tableById.get(tableId) : undefined;
    const column = lineage.columnById.get(lens.columnId);
    return table && column ? `${table.name}.${column.name}` : null;
  }, [lens?.columnId, lineage]);

  if (!lens) return null;
  return (
    <div className="canvas__picking-banner canvas__derived-banner">
      <Sigma size={16} />
      {focused ? (
        <span>
          Lineage of <strong>{focused}</strong>
        </span>
      ) : (
        <span>
          Derived columns · <strong>{totals.derived}</strong> computed in {totals.tables} table{totals.tables === 1 ? '' : 's'}, {totals.stored} stored
        </span>
      )}
      <span className="derived-legend">
        <span className="derived-legend__key derived-legend__key--derived">computed</span>
        <span className="derived-legend__key derived-legend__key--feeds">feeds one</span>
      </span>
      {lens.columnId && (
        <button
          className={`btn btn--sm btn--icon btn--ghost${lens.downstream ? ' btn--active' : ''}`}
          title={lens.downstream ? 'Following what it feeds as well; click for what feeds it only' : 'Following what feeds it only; click to follow what it feeds too'}
          onClick={() => setDerived({ ...lens, downstream: !lens.downstream })}
        >
          <ArrowLeftRight />
        </button>
      )}
      {lens.columnId && (
        <button className="btn btn--sm btn--ghost" title="Back to every derived column (Esc)" onClick={() => showLineage(null)}>
          All columns
        </button>
      )}
      <button className="btn btn--sm btn--ghost" title="Open the Derived tab" onClick={() => openDrawer('derived')}>
        Details
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title="Turn the lens off (D, or Esc)" onClick={() => setDerived(null)}>
        <X />
      </button>
    </div>
  );
}
