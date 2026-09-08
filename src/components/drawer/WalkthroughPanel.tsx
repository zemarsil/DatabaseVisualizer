/**
 * The drawer tab that follows the active walkthrough: opened by picking one
 * from the Help modal's browser (which then closes), it keeps showing that
 * walkthrough's text here so the canvas stays visible while it's followed.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useDialogStore } from '@/components/ui/Modal';
import { WalkthroughDetail } from '@/components/ui/Walkthroughs';

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
        <p>Open a walkthrough to follow it here while you work on the canvas.</p>
        <button className="btn btn--sm btn--primary" onClick={() => setHelp(true, 'list')}>
          Browse walkthroughs
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <WalkthroughDetail walkthrough={w} onBack={() => setHelp(true, 'list')} onOpen={openWalkthrough} />
    </div>
  );
}
