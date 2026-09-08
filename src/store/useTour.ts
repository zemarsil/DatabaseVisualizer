import { create } from 'zustand';
import type { TourPlan } from '@/lib/tour/steps';

/**
 * The running walkthrough: which one, how far in, and how much of it the reader
 * has already got past. Kept out of useStore so it never lands in undo history
 * or autosave — a tour is something you are doing, not part of the diagram.
 *
 * `index` walks a strip one longer at each end than the step list: -1 is the
 * card you get before step 1 (what you'll build, the mental model, and the
 * button that sets the canvas up), 0…n-1 are the steps, and n is the wrap-up.
 */

/** Step numbers a reader has got a green tick on, per walkthrough. */
type Progress = Record<string, number[]>;

interface TourState {
  slug: string | null;
  plan: TourPlan | null;
  index: number;
  /** Collapsed to a pill in the corner, so the card is out of the way without losing your place. */
  minimized: boolean;
  progress: Progress;

  start: (plan: TourPlan, index?: number) => void;
  stop: () => void;
  goTo: (index: number) => void;
  next: () => void;
  back: () => void;
  setMinimized: (on: boolean) => void;
  /** Ticks a step off. Called when its goals pass, or when the reader continues past one with nothing to check. */
  markDone: (stepNumber: number) => void;
}

const KEY = 'dbviz:tour';

function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { progress?: Progress };
    return parsed.progress ?? {};
  } catch {
    return {};
  }
}

function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ progress }));
  } catch {
    /* a reader with no storage still gets the tour, just not the ticks */
  }
}

export const useTour = create<TourState>()((set, get) => ({
  slug: null,
  plan: null,
  index: -1,
  minimized: false,
  progress: loadProgress(),

  start: (plan, index = -1) => set({ slug: plan.slug, plan, index, minimized: false }),
  stop: () => set({ slug: null, plan: null, index: -1 }),
  goTo: (index) => {
    const plan = get().plan;
    if (!plan) return;
    set({ index: Math.max(-1, Math.min(plan.steps.length, index)), minimized: false });
  },
  next: () => get().goTo(get().index + 1),
  back: () => get().goTo(get().index - 1),
  setMinimized: (on) => set({ minimized: on }),

  markDone: (stepNumber) => {
    const { slug, progress } = get();
    if (!slug) return;
    const had = progress[slug] ?? [];
    if (had.includes(stepNumber)) return;
    const next = { ...progress, [slug]: [...had, stepNumber].sort((a, b) => a - b) };
    saveProgress(next);
    set({ progress: next });
  },
}));
