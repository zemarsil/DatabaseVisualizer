/**
 * The drawer tab that follows the walkthrough you are on: its outline, how far
 * in you are, and the whole-diagram **Check my work**.
 *
 * The walkthrough itself is run by the coach mark (src/components/tour/TourHost.tsx),
 * which floats over the canvas and moves from one part of the app to the next.
 * This tab is the map beside it: every step in one list, ticks against the ones
 * that check out, a click to jump anywhere, and the full text underneath for
 * anyone who would rather read than be led.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useDialogStore } from '@/components/ui/Modal';
import { WalkthroughOutline } from '@/components/ui/Walkthroughs';

// This panel unmounts whenever the drawer's tab switches away from
// 'walkthrough', which would otherwise reset scroll to the top on return.
// A module-level map (outside React state) survives that unmount and lets
// each walkthrough reopen at the spot the reader left it.
const scrollPositions = new Map<string, number>();

export function WalkthroughPanel() {
  const slug = useStore((s) => s.activeWalkthroughSlug);
  const openWalkthrough = useStore((s) => s.openWalkthrough);
  const setHelp = useDialogStore((s) => s.setHelp);
  const [data, setData] = useState<typeof import('@/lib/walkthroughs') | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void import('@/lib/walkthroughs').then((m) => live && setData(m));
    return () => {
      live = false;
    };
  }, []);

  const w = slug && data ? data.getWalkthrough(slug) : undefined;

  useLayoutEffect(() => {
    if (!w) return;
    const scroller = rootRef.current?.closest<HTMLElement>('.drawer__body');
    if (!scroller) return;
    scroller.scrollTop = scrollPositions.get(w.slug) ?? 0;
    const onScroll = () => scrollPositions.set(w.slug, scroller.scrollTop);
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [w]);

  if (!data) return <div className="wt-loading">Loading walkthroughs…</div>;

  if (!w) {
    return (
      <div className="wt-panel-empty">
        <BookOpen size={22} />
        <p>Pick a walkthrough and it runs as a clickthrough: a card follows you around the app, one step at a time, checking your work as you go.</p>
        <button className="btn btn--sm btn--primary" onClick={() => setHelp(true, 'list')}>
          Browse walkthroughs
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <WalkthroughOutline walkthrough={w} onOpen={openWalkthrough} />
    </div>
  );
}
