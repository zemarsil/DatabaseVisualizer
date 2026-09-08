/**
 * The in-app walkthrough browser, opened from the "?" help button: a list of
 * the walkthroughs bundled from docs/walkthroughs/. Picking one opens its
 * text in the drawer's Walkthrough tab (see WalkthroughPanel) instead of
 * inside this modal, so the canvas stays visible while it's followed.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Clock, FolderOpen, MousePointerClick } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { parseDiagramFile } from '@/lib/io';
import { startFreshDiagramEntry } from '@/lib/library';
import { renderMarkdown } from '@/lib/markdown';
import { confirmDialog, useDialogStore } from './Modal';

const LEVEL_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

/** The list of bundled walkthroughs; `onGuide` is called when the reader asks for the quick guide instead. */
export function WalkthroughBrowser({ onGuide }: { onGuide: () => void }) {
  const [data, setData] = useState<typeof import('@/lib/walkthroughs') | null>(null);
  const openWalkthrough = useStore((s) => s.openWalkthrough);
  const setHelp = useDialogStore((s) => s.setHelp);

  useEffect(() => {
    let live = true;
    void import('@/lib/walkthroughs').then((m) => live && setData(m));
    return () => {
      live = false;
    };
  }, []);

  if (!data) return <div className="wt-loading">Loading walkthroughs…</div>;
  return (
    <WalkthroughList
      walkthroughs={data.WALKTHROUGHS}
      onOpen={(slug) => {
        openWalkthrough(slug);
        setHelp(false);
      }}
      onGuide={onGuide}
    />
  );
}

function WalkthroughList({ walkthroughs, onOpen, onGuide }: { walkthroughs: import('@/lib/walkthroughs').Walkthrough[]; onOpen: (slug: string) => void; onGuide: () => void }) {
  return (
    <div>
      <button className="btn btn--sm wt-detail__back" onClick={onGuide}>
        <ArrowLeft size={14} /> Quick guide
      </button>
      <div className="wt-list">
        {walkthroughs.map((w, i) => (
          <button key={w.slug} className="wt-card" onClick={() => onOpen(w.slug)}>
            <div className="wt-card__num">{String(i).padStart(2, '0')}</div>
            <div className="wt-card__body">
              <div className="wt-card__title">{w.title}</div>
              <div className="wt-card__summary">{w.summary}</div>
              <div className="wt-card__meta">
                <span className="badge">{LEVEL_LABEL[w.level] ?? w.level}</span>
                <span className="wt-card__minutes">
                  <Clock size={12} /> {w.minutes} min
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Renders one walkthrough's markdown; used by the drawer's Walkthrough panel. */
export function WalkthroughDetail({ walkthrough: w, onBack, onOpen }: { walkthrough: import('@/lib/walkthroughs').Walkthrough; onBack: () => void; onOpen: (slug: string) => void }) {
  const diagram = useStore((s) => s.diagram);
  const setDiagram = useStore((s) => s.setDiagram);
  const toast = useStore((s) => s.toast);
  const setHelp = useDialogStore((s) => s.setHelp);

  const openDiagram = async () => {
    if (!w.diagramJson) return;
    try {
      const d = parseDiagramFile(w.diagramJson);
      if (diagram.tables.length && !(await confirmDialog({ title: `Open "${d.name}"?`, message: 'The current diagram stays in the diagram library (File → Open recent…); this walkthrough’s finished diagram takes its place on the canvas.', confirmLabel: 'Open diagram' }))) {
        return;
      }
      await startFreshDiagramEntry();
      setDiagram(d);
      setHelp(false);
      toast('success', `Loaded "${d.name}" from "${w.title}".`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : "Could not load this walkthrough's diagram.");
    }
  };

  // Intercept the walkthrough's own links: to another walkthrough, navigate
  // within this browser; to its companion diagram, open it on the canvas.
  // Everything else (an anchor, a source-file link) has nowhere to go inside
  // the app, so it is swallowed rather than left to 404.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (/^https?:/.test(href)) return;
    e.preventDefault();
    const toSlug = /^(\d{2}-[a-z0-9-]+)\.md/.exec(href);
    if (toSlug) onOpen(toSlug[1]);
    else if (href.endsWith('.dbviz.json')) void openDiagram();
  };

  return (
    <div className="wt-detail">
      <button className="btn btn--sm wt-detail__back" onClick={onBack}>
        <ArrowLeft size={14} /> All walkthroughs
      </button>
      <h2 className="wt-detail__title">{w.title}</h2>
      <div className="wt-card__meta wt-detail__meta">
        <span className="badge">{LEVEL_LABEL[w.level] ?? w.level}</span>
        <span className="wt-card__minutes">
          <Clock size={12} /> {w.minutes} min
        </span>
        <span className="wt-card__minutes">{w.dialect}</span>
      </div>
      {w.diagramJson && (
        <button className="btn btn--primary wt-detail__open" onClick={() => void openDiagram()}>
          <FolderOpen size={14} /> Open the finished diagram
        </button>
      )}
      <div className="wt-doc" onClick={onClick}>
        {renderMarkdown(w.body)}
      </div>
      {w.next.length > 0 && w.next[0] !== 'none' && (
        <div className="wt-detail__next">
          <MousePointerClick size={14} />
          <span>Next:</span>
          {w.next.map((slug) => (
            <button key={slug} className="btn btn--sm" onClick={() => onOpen(slug)}>
              {slug.replace(/^\d{2}-/, '').replace(/-/g, ' ')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
