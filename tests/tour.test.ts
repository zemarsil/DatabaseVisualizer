import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Diagram } from '@shared/types';
import { parseDiagramFile } from '@/lib/io';
import { emptyDiagram } from '@/lib/model';
import { buildTourPlan, type TourStep } from '@/lib/tour/steps';
import { applyGoal, evaluateGoal, EMPTY_VIEW, GOALS, isFixable, isViewGoal, type Goal } from '@/lib/tour/goals';

/**
 * Guards the clickthrough half of docs/walkthroughs/.
 *
 * Each step declares its outcome once, as goals (see src/lib/tour/goals.ts),
 * and the app reads that declaration two ways — to tick the step off as the
 * reader does it, and to do the step for them. Both readings are checked here,
 * because a goal that is wrong is worse than no goal at all: it either tells a
 * reader they have failed when they have not, or builds them something the
 * walkthrough never described.
 *
 *   1. every step points somewhere and every goal uses a verb that exists;
 *   2. every goal is true of the diagram the walkthrough ends with;
 *   3. replaying the whole walkthrough through **Do it for me**, from the
 *      canvas it starts on, satisfies those same goals — so the button and the
 *      prose cannot drift apart.
 *
 * A goal marked `transient` is exempt from 2 and 3: a step that builds an index
 * in the wrong order on purpose is not meant to survive to the end.
 */

const DIR = 'docs/walkthroughs';
const FILE_PATTERN = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

interface Loaded {
  slug: string;
  title: string;
  body: string;
  steps: TourStep[];
  diagram: Diagram | null;
  start: Diagram | null;
  dialect: string;
}

function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const lines = text.split('\n');
  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([a-z][a-zA-Z]*):[ \t]+(.*)$/.exec(lines[i]);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: lines.slice(i + 1).join('\n') };
}

function load(file: string): Loaded {
  const { meta, body } = frontMatter(readFileSync(join(DIR, file), 'utf8'));
  const slug = file.replace(/\.md$/, '');
  const read = (rel?: string) => (rel && rel !== 'empty' ? parseDiagramFile(readFileSync(resolve(DIR, rel), 'utf8')) : null);
  const plan = buildTourPlan({ slug, title: meta.title ?? slug, body });
  return { slug, title: meta.title ?? slug, body, steps: plan.steps, diagram: read(meta.diagram), start: read(meta.start), dialect: meta.dialect ?? 'postgresql' };
}

/** Goals a diagram can be judged by: everything except what is only true on screen. */
function diagramGoals(step: TourStep): Goal[] {
  return step.transient ? [] : step.goals.filter((g) => !isViewGoal(g));
}

const files = readdirSync(DIR).filter((f) => FILE_PATTERN.test(f)).sort();

describe('walkthrough tours', () => {
  it('has walkthroughs to run', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('keeps the validator\u2019s goal vocabulary in step with the app\u2019s', async () => {
    // The CLI validator runs under Node and cannot import the app's TypeScript,
    // so it carries its own copy of the verb list. This is what stops the copy
    // from rotting.
    // @ts-expect-error - plain-JS tooling module, deliberately untyped
    const { GOAL_VERBS } = await import('../scripts/walkthrough-lib.mjs');
    expect(Object.keys(GOAL_VERBS as Record<string, unknown>).sort()).toEqual(Object.keys(GOALS).sort());
  });

  for (const file of files) {
    const w = load(file);

    describe(file, () => {
      it('cuts into steps that each point somewhere', () => {
        expect(w.steps.length).toBeGreaterThanOrEqual(3);
        for (const s of w.steps) {
          expect(s.title, `step ${s.n} has no title`).not.toBe('');
          expect(s.target, `step ${s.n} has no target: for the coach mark to point at`).toBeTruthy();
          expect(s.body.trim(), `step ${s.n} has no instruction`).not.toBe('');
          expect(s.expect, `step ${s.n} lost its "You should see" line`).not.toBe('');
        }
      });

      it('uses goal verbs that exist', () => {
        for (const s of w.steps) {
          for (const g of s.goals) {
            expect(Object.keys(GOALS), `step ${s.n}: "${g.raw}"`).toContain(g.verb);
            if (GOALS[g.verb]?.arg === null) expect(g.arg, `"${g.raw}" takes no argument`).toBe('');
            else expect(g.arg, `"${g.raw}" needs an argument after "|"`).not.toBe('');
          }
        }
      });

      it('names a step block only inside a step', () => {
        // The parser strips `<!-- step -->` blocks wherever they appear; one
        // outside ## Steps would silently do nothing.
        const inSteps = w.steps.reduce((n, s) => n + (s.goals.length || s.target ? 1 : 0), 0);
        expect((w.body.match(/<!--\s*step\b/g) ?? []).length).toBe(inSteps);
      });

      if (w.diagram) {
        it('every goal is true of the diagram it ends with', () => {
          for (const s of w.steps) {
            for (const g of diagramGoals(s)) {
              const r = evaluateGoal(g, { diagram: w.diagram!, view: EMPTY_VIEW, code: s.code });
              expect(r.ok, `step ${s.n} "${g.raw}": ${r.detail}`).toBe(true);
            }
          }
        });
      }

      it('builds itself when every step is done for you', () => {
        // What **Do it for me** would do, start to finish, on the canvas this
        // walkthrough begins from.
        const d: Diagram = w.start ? structuredClone(w.start) : emptyDiagram(w.dialect as Diagram['dialect']);
        for (const s of w.steps) {
          for (const g of s.goals) {
            if (isFixable(g) && !isViewGoal(g)) applyGoal(g, d, { diagram: d, view: EMPTY_VIEW, code: s.code });
          }
        }
        for (const s of w.steps) {
          for (const g of diagramGoals(s)) {
            if (!isFixable(g)) continue;
            const r = evaluateGoal(g, { diagram: d, view: EMPTY_VIEW, code: s.code });
            expect(r.ok, `step ${s.n} "${g.raw}" after replaying the walkthrough: ${r.detail}`).toBe(true);
          }
        }
      });
    });
  }
});
