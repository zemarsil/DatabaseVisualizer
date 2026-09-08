/**
 * The walkthrough as a clickthrough: one card that follows you around the app.
 *
 * The card is anchored to whatever the current step points at — a button, a
 * drawer tab, a field in the inspector, a table on the canvas — with a ring
 * drawn round it. Nothing is blocked while it is up: the overlay never takes
 * the pointer, so the reader works in the real app and the card just watches.
 *
 * Watching is the point. Every step declares what it is for (src/lib/tour/goals.ts)
 * and those goals are re-evaluated on every change to the diagram, so the card
 * ticks itself off as the work gets done, and **Do it for me** can perform the
 * same step for a reader who would rather see it happen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleDashed, ListChecks, Minus, PartyPopper, Sparkles, Wand2, X } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { useTour } from '@/store/useTour';
import { renderMarkdown } from '@/lib/markdown';
import { evaluateGoals, subjectOfStep, type GoalStatus, type TourView } from '@/lib/tour/goals';
import { exactAnchorElement, findAnchorElement, resolveAnchor } from '@/lib/tour/anchors';
import { performStep } from '@/lib/tour/perform';
import { setUpCanvas } from './setup';
import type { TourPlan, TourStep } from '@/lib/tour/steps';
import '@/styles/tour.css';

const GAP = 14; // px between the ring and the card
const EDGE = 10; // px the card keeps away from the window edge

/** The live app state goals are judged against, as React sees it. */
function useLiveView(): TourView {
  const drawer = useStore((s) => s.drawer);
  const selectedTableIds = useStore((s) => s.selection.tableIds);
  const selectedRelationshipId = useStore((s) => s.selection.relationshipId);
  const tracePath = useStore((s) => s.trace.result?.tableIds ?? null);
  const showCardinality = useUi((s) => s.showCardinality);
  const focusTableId = useUi((s) => s.focus?.tableId ?? null);
  const simulateTargetId = useSimulation((s) => s.targetId);
  return useMemo(
    () => ({
      drawerTab: drawer.open ? drawer.tab : null,
      selectedTableIds,
      selectedRelationshipId,
      showCardinality,
      simulateTargetId,
      tracePath,
      focusTableId,
    }),
    [drawer.open, drawer.tab, selectedTableIds, selectedRelationshipId, showCardinality, simulateTargetId, tracePath, focusTableId],
  );
}

export function TourHost() {
  const plan = useTour((s) => s.plan);
  const index = useTour((s) => s.index);
  const minimized = useTour((s) => s.minimized);
  const tour = useTour;
  const diagram = useStore((s) => s.diagram);
  const view = useLiveView();

  const step: TourStep | null = plan && index >= 0 && index < plan.steps.length ? plan.steps[index] : null;
  const statuses: GoalStatus[] = useMemo(() => (step ? evaluateGoals(step.goals, { diagram, view, code: step.code }) : []), [step, diagram, view]);
  const complete = statuses.length > 0 && statuses.every((s) => s.ok);

  const cardRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<number | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  /* ---- open whatever the step points inside ---- */
  useEffect(() => {
    if (!step) return;
    const s = useStore.getState();
    const anchor = resolveAnchor(step.target, s.diagram);
    const { reveal } = anchor;
    if (reveal.drawerTab) s.openDrawer(reveal.drawerTab as Parameters<typeof s.openDrawer>[0]);
    if (reveal.inspector) s.setInspectorOpen(true);
    if (reveal.sidebar) s.setSidebarOpen(true);
    if (reveal.centerTable) {
      const t = s.diagram.tables.find((x) => x.name.toLowerCase() === reveal.centerTable!.toLowerCase());
      // Only pan when the table is not already somewhere the reader can see it:
      // a tour that yanks the canvas on every step is worse than one that waits.
      if (t && !isOnScreen(`.react-flow__node[data-id="${t.id}"]`)) s.focusTable(t.id);
    }
    // The inspector only shows what is selected, so a step pointing at one of
    // its fields has to put the thing it is about in front of the reader first
    // — but only when that field is not already on screen, so this never
    // fights someone who has selected something else on purpose.
    if (anchor.text && !exactAnchorElement(anchor)) {
      const subject = subjectOfStep(step.goals, s.diagram);
      if (subject?.kind === 'table' && !(s.selection.tableIds.length === 1 && s.selection.tableIds[0] === subject.id)) s.selectTable(subject.id);
      else if (subject?.kind === 'relationship' && s.selection.relationshipId !== subject.id) s.setSelection({ relationshipId: subject.id, tableIds: [], noteIds: [] });
    }

    // Panels scroll, and half the inspector is below the fold: bring the target
    // into view once per step, never again, so this cannot fight a reader who
    // has scrolled somewhere on purpose.
    if (scrolledFor.current === step.n) return;
    const t = setTimeout(() => {
      const el = exactAnchorElement(resolveAnchor(step.target, useStore.getState().diagram));
      if (!el) return;
      scrolledFor.current = step.n;
      const r = el.getBoundingClientRect();
      if (r.top < 8 || r.bottom > window.innerHeight - 8) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 140);
    return () => clearTimeout(t);
  }, [step, plan?.slug, diagram, view.selectedTableIds, view.selectedRelationshipId]);

  useEffect(() => {
    scrolledFor.current = null;
  }, [step?.n, plan?.slug]);

  /* ---- keep the ring and the card on the target ---- */
  useEffect(() => {
    if (!plan || minimized) return;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const card = cardRef.current;
      const ring = ringRef.current;
      if (!card) return;
      const el = step ? findAnchorElement(resolveAnchor(step.target, useStore.getState().diagram)) : null;
      const rect = el?.getBoundingClientRect();
      const anchored = !!rect && rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.top < window.innerHeight;
      if (ring) {
        ring.style.opacity = anchored ? '1' : '0';
        if (anchored && rect) {
          ring.style.transform = `translate(${Math.round(rect.left - 4)}px, ${Math.round(rect.top - 4)}px)`;
          ring.style.width = `${Math.round(rect.width + 8)}px`;
          ring.style.height = `${Math.round(rect.height + 8)}px`;
        }
      }
      const box = card.getBoundingClientRect();
      const place = anchored && rect ? placeCard(rect, box.width, box.height) : floatCard(box.width, box.height);
      card.style.transform = `translate(${place.left}px, ${place.top}px)`;
      card.dataset.placement = place.placement;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [plan, step, minimized]);

  /* ---- a step that has been satisfied is a step you have done ---- */
  useEffect(() => {
    if (step && complete) tour.getState().markDone(step.n);
  }, [step, complete, tour]);

  /** Continue also ticks off a step that had nothing to check: reading it is doing it. */
  const advance = useCallback(() => {
    const t = tour.getState();
    if (step && step.goals.length === 0) t.markDone(step.n);
    t.next();
  }, [step, tour]);

  const doItForMe = useCallback(() => {
    if (!step) return;
    const changed = performStep(step);
    const toast = useStore.getState().toast;
    if (changed.length) toast('success', `Did step ${step.n} for you — ${changed.length === 1 ? 'one change' : `${changed.length} changes`}. Ctrl+Z puts it back.`);
    else toast('info', 'Nothing left to do automatically on this step.');
  }, [step]);

  if (!plan) return null;

  if (minimized) {
    return (
      <button className="tour-pill" onClick={() => tour.getState().setMinimized(false)}>
        <Sparkles size={14} />
        <span>{plan.title}</span>
        <span className="tour-pill__count">{index < 0 ? 'start' : index >= plan.steps.length ? 'done' : `${index + 1}/${plan.steps.length}`}</span>
      </button>
    );
  }

  return (
    <>
      <div className="tour-ring" ref={ringRef} aria-hidden />
      <div className="tour-card" ref={cardRef} role="dialog" aria-label={`${plan.title} walkthrough`}>
        <TourHead plan={plan} index={index} />
        {index < 0 ? <IntroCard /> : step ? <StepCard step={step} statuses={statuses} complete={complete} onDoIt={doItForMe} onContinue={advance} /> : <OutroCard />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Header and footer                                                   */
/* ------------------------------------------------------------------ */

function TourHead({ plan, index }: { plan: TourPlan; index: number }) {
  const setMinimized = useTour((s) => s.setMinimized);
  const stop = useTour((s) => s.stop);
  const total = plan.steps.length;
  const pct = index < 0 ? 0 : Math.min(100, Math.round(((index + 1) / (total + 1)) * 100));
  return (
    <div className="tour-card__head">
      <div className="tour-card__where">
        <span className="tour-card__title">{plan.title}</span>
        <span className="tour-card__step">{index < 0 ? 'Before you start' : index >= total ? 'Finished' : `Step ${index + 1} of ${total}`}</span>
      </div>
      <button className="btn btn--sm btn--icon btn--ghost" title="Tuck it away" onClick={() => setMinimized(true)}>
        <Minus />
      </button>
      <button className="btn btn--sm btn--icon btn--ghost" title="Leave the walkthrough" onClick={stop}>
        <X />
      </button>
      <div className="tour-card__progress" style={{ width: `${index >= total ? 100 : pct}%` }} />
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="tour-card__foot">{children}</div>;
}

function BackButton() {
  const index = useTour((s) => s.index);
  const back = useTour((s) => s.back);
  return (
    <button className="btn btn--sm" onClick={back} disabled={index < 0}>
      <ArrowLeft size={14} /> Back
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The three kinds of card                                             */
/* ------------------------------------------------------------------ */

function IntroCard() {
  const plan = useTour((s) => s.plan)!;
  const next = useTour((s) => s.next);
  const [showModel, setShowModel] = useState(false);
  const canSetUp = !!plan.startJson || plan.startsEmpty;
  return (
    <>
      <div className="tour-card__body">
        <div className="tour-meta">
          <span className="badge">{plan.level}</span>
          <span>{plan.minutes} min</span>
          <span>{plan.dialect}</span>
          <span>{plan.steps.length} steps</span>
        </div>
        <div className="tour-doc">{renderMarkdown(plan.intro)}</div>
        {canSetUp && (
          <p className="tour-hint">
            {plan.startsEmpty
              ? 'This one starts from a blank canvas. Set up the canvas clears it for you — nothing is lost, the current diagram stays in the library.'
              : 'Set up the canvas puts the tables this walkthrough starts from in front of you, so you can begin here without doing the earlier ones first.'}
          </p>
        )}
        {plan.model && (
          <div className="tour-more">
            <button className="tour-more__toggle" onClick={() => setShowModel((v) => !v)} aria-expanded={showModel}>
              <ChevronDown size={13} className={showModel ? 'tour-more__chev tour-more__chev--open' : 'tour-more__chev'} /> Why it works this way
            </button>
            {showModel && <div className="tour-doc tour-doc--muted">{renderMarkdown(plan.model)}</div>}
          </div>
        )}
      </div>
      <Footer>
        {canSetUp && (
          <button className="btn btn--sm" onClick={() => void setUpCanvas(plan)}>
            <Wand2 size={14} /> Set up the canvas
          </button>
        )}
        <span className="grow" />
        <button className="btn btn--sm btn--primary" onClick={next}>
          Start <ArrowRight size={14} />
        </button>
      </Footer>
    </>
  );
}

function StepCard({ step, statuses, complete, onDoIt, onContinue }: { step: TourStep; statuses: GoalStatus[]; complete: boolean; onDoIt: () => void; onContinue: () => void }) {
  const fixable = statuses.some((s) => s.fixable && !s.ok);
  const passed = statuses.filter((s) => s.ok).length;
  return (
    <>
      <div className="tour-card__body">
        <h3 className="tour-card__heading">{step.title}</h3>
        <div className="tour-doc">{renderMarkdown(step.body)}</div>
        {step.hint && <div className="tour-hint">{renderMarkdown(step.hint)}</div>}
        {step.expect && (
          <div className="tour-expect">
            <span className="tour-expect__label">You should see</span>
            {renderMarkdown(step.expect)}
          </div>
        )}
        {statuses.length > 0 && (
          <div className={`tour-goals${complete ? ' tour-goals--done' : ''}`}>
            <div className="tour-goals__head">
              <ListChecks size={13} />
              {complete ? 'Done — this step checks out.' : `${passed} of ${statuses.length} done`}
            </div>
            <ul>
              {statuses.map((s) => (
                <li key={s.goal.raw} className={s.ok ? 'tour-goals__item tour-goals__item--ok' : 'tour-goals__item'}>
                  {s.ok ? <Check size={13} /> : <CircleDashed size={13} />}
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <Footer>
        <BackButton />
        <span className="grow" />
        {fixable && (
          <button className="btn btn--sm" onClick={onDoIt} title="Make this step's change for me">
            <Wand2 size={14} /> Do it for me
          </button>
        )}
        <button className={`btn btn--sm${complete || statuses.length === 0 ? ' btn--primary' : ''}`} onClick={onContinue}>
          {complete ? (
            <>
              <Check size={14} /> Continue
            </>
          ) : (
            <>
              Continue <ArrowRight size={14} />
            </>
          )}
        </button>
      </Footer>
    </>
  );
}

function OutroCard() {
  const plan = useTour((s) => s.plan)!;
  const stop = useTour((s) => s.stop);
  const [tab, setTab] = useState<'verify' | 'other' | 'gotchas' | 'next'>('verify');
  const tabs = [
    { id: 'verify', label: 'Check', body: plan.verify },
    { id: 'other', label: 'Other ways', body: plan.alternatives },
    { id: 'gotchas', label: 'Gotchas', body: plan.gotchas },
    { id: 'next', label: 'What next', body: plan.next },
  ] as const;
  return (
    <>
      <div className="tour-card__body">
        <h3 className="tour-card__heading">
          <PartyPopper size={15} /> That is the whole walkthrough
        </h3>
        <div className="tour-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'tour-tabs__tab tour-tabs__tab--on' : 'tour-tabs__tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="tour-doc">{renderMarkdown(tabs.find((t) => t.id === tab)?.body ?? '')}</div>
      </div>
      <Footer>
        <BackButton />
        <span className="grow" />
        <button className="btn btn--sm btn--primary" onClick={stop}>
          <Check size={14} /> Finish
        </button>
      </Footer>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

function isOnScreen(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Below the target, else above, else beside it — whichever fits without covering it. */
function placeCard(rect: DOMRect, w: number, h: number): { left: number; top: number; placement: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const centreX = () => clamp(rect.left + rect.width / 2 - w / 2, EDGE, vw - w - EDGE);
  const centreY = () => clamp(rect.top + rect.height / 2 - h / 2, EDGE, vh - h - EDGE);
  if (rect.bottom + GAP + h <= vh - EDGE) return { left: centreX(), top: rect.bottom + GAP, placement: 'below' };
  if (rect.top - GAP - h >= EDGE) return { left: centreX(), top: rect.top - GAP - h, placement: 'above' };
  if (rect.right + GAP + w <= vw - EDGE) return { left: rect.right + GAP, top: centreY(), placement: 'right' };
  if (rect.left - GAP - w >= EDGE) return { left: rect.left - GAP - w, top: centreY(), placement: 'left' };
  // Nothing fits beside it: sit in the corner furthest from the target.
  const left = rect.left > vw / 2 ? EDGE : vw - w - EDGE;
  return { left, top: clamp(vh - h - EDGE, EDGE, vh - h - EDGE), placement: 'corner' };
}

/** No target on screen: park the card where it covers least. */
function floatCard(w: number, h: number): { left: number; top: number; placement: string } {
  return { left: Math.max(EDGE, window.innerWidth - w - EDGE * 2), top: clamp(window.innerHeight / 2 - h / 2, EDGE, window.innerHeight - h - EDGE), placement: 'float' };
}
