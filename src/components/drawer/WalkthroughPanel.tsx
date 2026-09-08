/**
 * The drawer tab that follows the active walkthrough: opened by picking one
 * from the Help modal's browser (which then closes), it keeps showing that
 * walkthrough's text here so the canvas stays visible while it's followed.
 */
import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useDialogStore } from '@/components/ui/Modal';
import { WalkthroughDetail } from '@/components/ui/Walkthroughs';

export function WalkthroughPanel() {
  const slug = useStore((s) => s.activeWalkthroughSlug);
  const openWalkthrough = useStore((s) => s.openWalkthrough);
  const setHelp = useDialogStore((s) => s.setHelp);
  const [data, setData] = useState<typeof import('@/lib/walkthroughs') | null>(null);

  useEffect(() => {
    let live = true;
    void import('@/lib/walkthroughs').then((m) => live && setData(m));
    return () => {
      live = false;
    };
  }, []);

  if (!data) return <div className="wt-loading">Loading walkthroughs…</div>;

  const w = slug ? data.getWalkthrough(slug) : undefined;
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

  return <WalkthroughDetail walkthrough={w} onBack={() => setHelp(true, 'list')} onOpen={openWalkthrough} />;
}
