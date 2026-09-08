/**
 * The two buttons that move the canvas for a walkthrough: **Set up the canvas**,
 * which puts the diagram it begins from in front of you, and **Open the
 * finished diagram**, which jumps to the state it ends in.
 *
 * Both live here rather than in either caller because the tour's opening card
 * and the "read the whole thing" view offer the same buttons, and a reader who
 * pressed one in either place must get exactly the same thing — including the
 * promise in the confirmation that nothing is lost, since the diagram being
 * replaced is kept in the diagram library.
 */
import type { Dialect } from '@shared/types';
import { parseDiagramFile } from '@/lib/io';
import { startFreshDiagramEntry } from '@/lib/library';
import { useStore } from '@/store/useStore';
import { confirmDialog } from '@/components/ui/Modal';

interface Replacement {
  /** Raw .dbviz.json, or null to start from a blank canvas. */
  json: string | null;
  title: string;
  message: string;
  confirmLabel: string;
  /** Told to the reader once it has happened. */
  done: (name: string) => string;
  dialect: Dialect;
}

const KEPT = 'The current diagram stays in the diagram library (File → Open recent…); ';

async function replaceCanvas(r: Replacement): Promise<boolean> {
  const s = useStore.getState();
  try {
    const d = r.json ? parseDiagramFile(r.json) : null;
    if (s.diagram.tables.length && !(await confirmDialog({ title: r.title, message: r.message, confirmLabel: r.confirmLabel }))) return false;
    await startFreshDiagramEntry();
    if (d) s.setDiagram(d);
    else s.newDiagram(r.dialect);
    s.toast('success', r.done(d?.name ?? 'a blank canvas'));
    return true;
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : 'Could not load that diagram.');
    return false;
  }
}

export interface WalkthroughCanvas {
  title: string;
  dialect: string;
  startJson?: string;
  startsEmpty?: boolean;
  diagramJson?: string;
}

/** Puts the canvas into the state this walkthrough's step 1 assumes. */
export function setUpCanvas(w: WalkthroughCanvas): Promise<boolean> {
  return replaceCanvas({
    json: w.startJson ?? null,
    title: `Set up the canvas for "${w.title}"?`,
    message: `${KEPT}what this walkthrough starts from takes its place on the canvas.`,
    confirmLabel: 'Set it up',
    done: () => `Canvas set up for "${w.title}". Start at step 1.`,
    dialect: w.dialect as Dialect,
  });
}

/** Jumps to the diagram this walkthrough ends with, for reading rather than building. */
export function openFinishedDiagram(w: WalkthroughCanvas): Promise<boolean> {
  return replaceCanvas({
    json: w.diagramJson ?? null,
    title: 'Open the finished diagram?',
    message: `${KEPT}this walkthrough’s finished diagram takes its place on the canvas.`,
    confirmLabel: 'Open diagram',
    done: (name) => `Loaded "${name}" from "${w.title}".`,
    dialect: w.dialect as Dialect,
  });
}
