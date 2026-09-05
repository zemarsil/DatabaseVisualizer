import { Minus, Plus, Target, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';

export const MAX_FOCUS_HOPS = 6;

/** Shown while neighborhood focus is active: which table, how many hops, and the controls. */
export function FocusBanner() {
  const focus = useUi((s) => s.focus);
  const setFocus = useUi((s) => s.setFocus);
  const name = useStore((s) => (focus ? s.diagram.tables.find((t) => t.id === focus.tableId)?.name : undefined));
  if (!focus) return null;
  const set = (hops: number) => setFocus({ tableId: focus.tableId, hops: Math.max(1, Math.min(MAX_FOCUS_HOPS, hops)) });
  return (
    <div className="canvas__picking-banner canvas__focus-banner">
      <Target size={16} />
      <span>
        Focus: <strong>{name ?? '?'}</strong> · {focus.hops} hop{focus.hops === 1 ? '' : 's'}
      </span>
      <button className="btn btn--sm btn--icon btn--ghost" title="Fewer hops ([)" onClick={() => set(focus.hops - 1)} disabled={focus.hops <= 1}>
        <Minus />
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title="More hops (])" onClick={() => set(focus.hops + 1)} disabled={focus.hops >= MAX_FOCUS_HOPS}>
        <Plus />
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title="Clear focus (Esc)" onClick={() => setFocus(null)}>
        <X />
      </button>
    </div>
  );
}
