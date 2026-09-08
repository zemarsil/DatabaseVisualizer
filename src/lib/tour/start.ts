/**
 * Starting a walkthrough: build its plan from the markdown and put the coach
 * mark on screen.
 *
 * The drawer is deliberately left where the reader had it. While a tour runs
 * the card *is* their place in the walkthrough; the Walkthrough tab is where
 * they go to see the outline or read the whole text, not something the app
 * should shove in front of them.
 */
import { useStore } from '@/store/useStore';
import { useTour } from '@/store/useTour';
import { buildTourPlan, type TourSource } from './steps';

export function startTour(w: TourSource, index = -1): void {
  useTour.getState().start(buildTourPlan(w), index);
  useStore.getState().setActiveWalkthrough(w.slug);
}
