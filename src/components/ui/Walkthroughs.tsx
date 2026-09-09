/**
 * The walkthrough browser, opened from the "?" help button, and the two ways a
 * walkthrough is shown once it is picked.
 *
 * Picking one **runs** it: the coach mark in src/components/tour/TourHost.tsx
 * takes over, anchoring itself to whatever the current step points at while the
 * canvas stays free to work in. What lives here is everything around that — the
 * list you pick from, the outline in the drawer's **Walkthrough** tab that says
 * how far in you are and lets you jump between steps, and the full text for a
 * reader who would rather read the document than be walked through it.
 *
 * The series builds one schema across every walkthrough in it, so both views carry
 * the same two buttons: **Set up the canvas**, which puts the previous
 * walkthrough's finished diagram in front of you (that is what lets a reader
 * start anywhere), and **Check my work**, which runs this walkthrough's own
 * `checks:` against whatever is on the canvas now.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Check, CheckCircle2, Clock, FolderOpen, ListChecks, MousePointerClick, Play, Wand2, XCircle } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useTour } from '@/store/useTour';
import { renderMarkdown } from '@/lib/markdown';
import { startTour } from '@/lib/tour/start';
import { buildTourPlan, stripStepMeta } from '@/lib/tour/steps';
import { runWalkthroughChecks, type CheckResult } from '@/lib/walkthroughChecks';
import { openFinishedDiagram, setUpCanvas } from '@/components/tour/setup';
import { useDialogStore } from './Modal';

type Walkthrough = import('@/lib/walkthroughs').Walkthrough;

const LEVEL_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

/** The list of bundled walkthroughs; `onGuide` is called when the reader asks for the quick guide instead. */
export function WalkthroughBrowser({ onGuide }: { onGuide: () => void }) {
  const [data, setData] = useState<typeof import('@/lib/walkthroughs') | null>(null);
  const openWalkthrough = useStore((s) => s.openWalkthrough);
  const setHelp = useDialogStore((s) => s.setHelp);
  const progress = useTour((s) => s.progress);

  useEffect(() => {
    let live = true;
    void import('@/lib/walkthroughs').then((m) => live && setData(m));
    return () => {
      live = false;
    };
  }, []);

  if (!data) return <div className="wt-loading">Loading walkthroughs…</div>;
  return (
    <div>
      <button className="btn btn--sm wt-detail__back" onClick={onGuide}>
        <ArrowLeft size={14} /> Quick guide
      </button>
      <p className="wt-run__note">
        Each one runs as a clickthrough: a card follows you around the app, points at what to use next, ticks itself off as you do it, and can do any step for you.
      </p>
      <div className="wt-list">
        {data.WALKTHROUGHS.map((w, i) => {
          const done = (progress[w.slug] ?? []).length;
          return (
            <div key={w.slug} className="wt-card">
              <div className="wt-card__num">{String(i).padStart(2, '0')}</div>
              <div className="wt-card__body">
                <div className="wt-card__title">{w.title}</div>
                <div className="wt-card__summary">{w.summary}</div>
                <div className="wt-card__meta">
                  <span className="badge">{LEVEL_LABEL[w.level] ?? w.level}</span>
                  <span className="wt-card__minutes">
                    <Clock size={12} /> {w.minutes} min
                  </span>
                  {done > 0 && (
                    <span className="wt-card__minutes">
                      <Check size={12} /> {done} steps done
                    </span>
                  )}
                </div>
              </div>
              <div className="wt-card__actions">
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => {
                    startTour(w);
                    setHelp(false);
                  }}
                >
                  <Play size={13} /> {done > 0 ? 'Resume' : 'Start'}
                </button>
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    openWalkthrough(w.slug);
                    setHelp(false);
                  }}
                >
                  <BookOpen size={13} /> Read
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The drawer's view of a walkthrough while it is being run: how far in you are,
 * every step with a tick beside the ones that check out, and the whole-diagram
 * **Check my work**. Clicking a step moves the coach mark to it.
 */
export function WalkthroughOutline({ walkthrough: w, onOpen }: { walkthrough: Walkthrough; onOpen: (slug: string) => void }) {
  const plan = useTour((s) => s.plan);
  const index = useTour((s) => s.index);
  const goTo = useTour((s) => s.goTo);
  // Select the whole map, not `progress[slug] ?? []`: a selector that builds a
  // fresh array when there is no entry yet hands zustand a new snapshot on
  // every render, which is an infinite re-render.
  const progress = useTour((s) => s.progress);
  const doneSteps = progress[w.slug] ?? [];
  const running = plan?.slug === w.slug;
  const [reading, setReading] = useState(false);

  if (reading) {
    return (
      <div className="wt-detail">
        <button className="btn btn--sm wt-detail__back" onClick={() => setReading(false)}>
          <ArrowLeft size={14} /> Back to the steps
        </button>
        <WalkthroughDocument walkthrough={w} onOpen={onOpen} />
      </div>
    );
  }

  return (
    <div className="wt-detail">
      <h2 className="wt-detail__title">{w.title}</h2>
      <div className="wt-card__meta wt-detail__meta">
        <span className="badge">{LEVEL_LABEL[w.level] ?? w.level}</span>
        <span className="wt-card__minutes">
          <Clock size={12} /> {w.minutes} min
        </span>
        <span className="wt-card__minutes">{w.dialect}</span>
      </div>
      <div className="wt-run">
        <button className="btn btn--primary" onClick={() => (running ? goTo(index) : startTour(w, running ? index : -1))}>
          <Play size={14} /> {running ? 'Show the step card' : doneSteps.length ? 'Resume the walkthrough' : 'Run the walkthrough'}
        </button>
        {(w.startJson || w.startsEmpty) && (
          <button className="btn" onClick={() => void setUpCanvas(w)}>
            <Wand2 size={14} /> Set up the canvas
          </button>
        )}
        <button className="btn" onClick={() => setReading(true)}>
          <BookOpen size={14} /> Read the whole thing
        </button>
      </div>
      <StepOutline walkthrough={w} onJump={(i) => (running ? goTo(i) : startTour(w, i))} current={running ? index : null} done={doneSteps} />
      {w.checks.length > 0 && <WalkthroughCheck checks={w.checks} />}
      {w.diagramJson && (
        <button className="btn wt-detail__open" onClick={() => void openFinishedDiagram(w)}>
          <FolderOpen size={14} /> Open the finished diagram
        </button>
      )}
      <NextLinks walkthrough={w} onOpen={onOpen} />
    </div>
  );
}

function StepOutline({ walkthrough: w, onJump, current, done }: { walkthrough: Walkthrough; onJump: (index: number) => void; current: number | null; done: number[] }) {
  const steps = useMemo(() => buildTourPlan(w).steps.map((s) => ({ n: s.n, title: s.title })), [w]);
  if (!steps.length) return null;
  return (
    <div className="wt-outline">
      {steps.map((s, i) => {
        const classes = ['wt-outline__step'];
        if (current === i) classes.push('wt-outline__step--on');
        if (done.includes(s.n)) classes.push('wt-outline__step--done');
        return (
          <button key={s.n} className={classes.join(' ')} onClick={() => onJump(i)}>
            <span className="wt-outline__num">{done.includes(s.n) ? <Check size={11} /> : s.n}</span>
            <span>{s.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The walkthrough as the document it is on disk, for reading rather than doing. */
export function WalkthroughDocument({ walkthrough: w, onOpen }: { walkthrough: Walkthrough; onOpen: (slug: string) => void }) {
  // Intercept the walkthrough's own links: to another walkthrough, navigate
  // within the browser; to its companion diagram, open it on the canvas.
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
    else if (href.endsWith('.dbviz.json')) void openFinishedDiagram(w);
  };
  return (
    <div className="wt-doc" onClick={onClick}>
      {renderMarkdown(stripStepMeta(w.body))}
    </div>
  );
}

/** The "did I build the right thing?" panel: this walkthrough's own checks against the live canvas. */
function WalkthroughCheck({ checks }: { checks: string[] }) {
  const diagram = useStore((s) => s.diagram);
  const [results, setResults] = useState<CheckResult[] | null>(null);

  // Results go stale the moment the canvas changes, so drop them rather than
  // leave a pass from before the edit on screen.
  useEffect(() => setResults(null), [checks, diagram]);

  // Unordered: a reader who added the same tables in a different order has
  // still done the walkthrough. CI holds the companion diagram to the order.
  const passed = results?.filter((r) => r.ok).length ?? 0;
  const all = results?.length ?? 0;
  return (
    <div className="wt-check">
      <button className="btn btn--primary" onClick={() => setResults(runWalkthroughChecks(checks, diagram, { ordered: false }))}>
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

function NextLinks({ walkthrough: w, onOpen }: { walkthrough: Walkthrough; onOpen: (slug: string) => void }) {
  if (!w.next.length || w.next[0] === 'none') return null;
  return (
    <div className="wt-detail__next">
      <MousePointerClick size={14} />
      <span>Next:</span>
      {w.next.map((slug) => (
        <button key={slug} className="btn btn--sm" onClick={() => onOpen(slug)}>
          {slug.replace(/^\d{2}-/, '').replace(/-/g, ' ')}
        </button>
      ))}
    </div>
  );
}
