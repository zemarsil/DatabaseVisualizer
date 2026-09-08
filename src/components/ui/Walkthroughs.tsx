/**
 * The in-app walkthrough browser, opened from the "?" help button: a list of
 * the walkthroughs bundled from docs/walkthroughs/. Picking one opens its
 * text in the drawer's Walkthrough tab (see WalkthroughPanel) instead of
 * inside this modal, so the canvas stays visible while it's followed.
 *
 * The series builds one schema across fifteen walkthroughs, so each one has
 * two buttons around its text: **Set up the canvas**, which puts the tables and
 * connections it expects in front of you (they are the previous walkthrough's
 * finished diagram, which is what lets a reader start anywhere), and **Check my
 * work**, which runs that walkthrough's own `checks:` against whatever is on the
 * canvas now.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock, FolderOpen, ListChecks, MousePointerClick, Wand2, XCircle } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { parseDiagramFile } from '@/lib/io';
import { startFreshDiagramEntry } from '@/lib/library';
import { renderMarkdown } from '@/lib/markdown';
import { runWalkthroughChecks, type CheckResult } from '@/lib/walkthroughChecks';
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
  const newDiagram = useStore((s) => s.newDiagram);
  const toast = useStore((s) => s.toast);
  const setHelp = useDialogStore((s) => s.setHelp);
  const [results, setResults] = useState<CheckResult[] | null>(null);

  // Results go stale the moment the canvas changes, so drop them rather than
  // leave a pass from before the edit on screen.
  useEffect(() => setResults(null), [w.slug, diagram]);

  /** Replaces the canvas, keeping whatever was there in the diagram library. */
  const replaceCanvas = async (json: string | null, confirm: { title: string; message: string; confirmLabel: string }, done: (name: string) => string) => {
    try {
      const d = json ? parseDiagramFile(json) : null;
      if (diagram.tables.length && !(await confirmDialog(confirm))) return;
      await startFreshDiagramEntry();
      if (d) setDiagram(d);
      else newDiagram(w.dialect);
      setHelp(false);
      toast('success', done(d?.name ?? 'a blank canvas'));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not load that diagram.');
    }
  };

  const setUp = () =>
    replaceCanvas(
      w.startJson ?? null,
      {
        title: `Set up the canvas for "${w.title}"?`,
        message: 'The current diagram stays in the diagram library (File → Open recent…); what this walkthrough starts from takes its place on the canvas.',
        confirmLabel: 'Set it up',
      },
      () => `Canvas set up for "${w.title}". Start at step 1.`,
    );

  const openDiagram = () =>
    replaceCanvas(
      w.diagramJson ?? null,
      {
        title: 'Open the finished diagram?',
        message: 'The current diagram stays in the diagram library (File → Open recent…); this walkthrough’s finished diagram takes its place on the canvas.',
        confirmLabel: 'Open diagram',
      },
      (name) => `Loaded "${name}" from "${w.title}".`,
    );

  // Unordered: a reader who added the same tables in a different order has
  // still done the walkthrough. CI holds the companion diagram to the order.
  const check = () => setResults(runWalkthroughChecks(w.checks, diagram, { ordered: false }));

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
      {(w.startJson || w.startsEmpty) && (
        <div className="wt-detail__setup">
          <button className="btn btn--primary" onClick={() => void setUp()}>
            <Wand2 size={14} /> Set up the canvas
          </button>
          <p>
            {w.startsEmpty
              ? 'Clears the canvas, which is where this one starts. Nothing is lost: the current diagram stays in the library.'
              : 'Puts the tables, connections and types this walkthrough starts from on the canvas — the state the one before it leaves behind — so you can begin here without doing the whole series first.'}
          </p>
        </div>
      )}
      <div className="wt-doc" onClick={onClick}>
        {renderMarkdown(w.body)}
      </div>
      {w.checks.length > 0 && <WalkthroughCheck results={results} onCheck={check} />}
      {w.diagramJson && (
        <button className="btn wt-detail__open" onClick={() => void openDiagram()}>
          <FolderOpen size={14} /> Open the finished diagram
        </button>
      )}
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

/** The "did I do it right?" panel at the foot of a walkthrough. */
function WalkthroughCheck({ results, onCheck }: { results: CheckResult[] | null; onCheck: () => void }) {
  const passed = results?.filter((r) => r.ok).length ?? 0;
  const all = results?.length ?? 0;
  return (
    <div className="wt-check">
      <button className="btn btn--primary" onClick={onCheck}>
        <ListChecks size={14} /> Check my work
      </button>
      {results && (
        <>
          <p className={`wt-check__headline ${passed === all ? 'wt-check__headline--ok' : ''}`}>
            {passed === all ? `All ${all} checks pass — the canvas matches the end of this walkthrough.` : `${passed} of ${all} checks pass. What is left:`}
          </p>
          <ul className="wt-check__list">
            {results.map((r) => (
              <li key={r.check} className={r.ok ? 'wt-check__item wt-check__item--ok' : 'wt-check__item wt-check__item--bad'}>
                {r.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span>{r.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
