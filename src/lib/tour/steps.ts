/**
 * Turns a walkthrough's markdown into the cards the tour shows.
 *
 * Nothing here is a second copy of a walkthrough: the tour *is* the file in
 * docs/walkthroughs/, cut along the seams the format already has. `## Steps`
 * becomes the numbered coach marks, `## What you'll build` and
 * `## The mental model` become the card you get before step 1, and
 * `## Check your work`, `## Gotchas` and `## Where to go next` become the one
 * you get after the last. The prose is the same prose; only the delivery
 * changes, so editing the document still edits the tour.
 *
 * What the document gained for this is one HTML comment per step:
 *
 *     <!-- step
 *     target: ui:add-table
 *     goals:
 *       - table | authors
 *     -->
 *
 * `target` is what the coach mark points at (see anchors.ts) and `goals` is
 * what the step is for (see goals.ts). Both are invisible wherever the markdown
 * is read as a document.
 */
import { parseGoal, type Goal } from './goals';

export interface TourStep {
  /** 1-based, matching the "### N." heading it came from. */
  n: number;
  title: string;
  /** The imperative prose, markdown, without the metadata block or the expectation line. */
  body: string;
  /** The **You should see:** line, without its label. */
  expect: string;
  /** Raw target token, e.g. "ui:add-table" or "table:authors". */
  target: string | null;
  goals: Goal[];
  /** An aside the coach mark shows in smaller type. */
  hint?: string;
  /** The step's first fenced code block: what a `viewsql` or `query` goal writes. */
  code?: string;
  /**
   * True when a later step in the same walkthrough undoes this one — building an
   * index in the wrong order on purpose, ticking a box to look at it and
   * unticking it again. Tests skip these when replaying goals against the
   * finished diagram, because the finished diagram is not meant to show them.
   */
  transient: boolean;
}

/** What a tour is built from: a walkthrough's front matter plus its body. */
export interface TourSource {
  slug: string;
  title: string;
  body: string;
  level?: string;
  minutes?: number;
  dialect?: string;
  /** The .dbviz.json this walkthrough starts from, so the intro card can set the canvas up. */
  startJson?: string;
  startsEmpty?: boolean;
}

export interface TourPlan {
  slug: string;
  title: string;
  level: string;
  minutes: number;
  dialect: string;
  startJson?: string;
  startsEmpty: boolean;
  /** `## What you'll build`, without its mermaid sketch. */
  intro: string;
  /** `## The mental model`. */
  model: string;
  steps: TourStep[];
  /** `## Check your work`. */
  verify: string;
  /** `## Gotchas`. */
  gotchas: string;
  /** `## Other ways to do it`. */
  alternatives: string;
  /** `## Where to go next`. */
  next: string;
}

const STEP_META = /<!--\s*step\b([\s\S]*?)-->/;

/** The slice of a body under one `## ` heading, up to the next one. Mirrors scripts/walkthrough-lib.mjs. */
export function sectionBody(body: string, name: string): string {
  const lines = body.split('\n');
  let start = -1;
  let inFence = false;
  for (let n = 0; n < lines.length; n++) {
    if (lines[n].startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    if (start === -1 && lines[n].startsWith('## ') && lines[n].slice(3).trim() === name) start = n + 1;
    else if (start !== -1 && lines[n].startsWith('## ')) return lines.slice(start, n).join('\n').trim();
  }
  return start === -1 ? '' : lines.slice(start).join('\n').trim();
}

/** Drops the ```mermaid sketch, which the app has no renderer for. */
function withoutMermaid(md: string): string {
  return md.replace(/^```mermaid[\s\S]*?^```\s*$/gm, '').trim();
}

/** Removes every `<!-- step ... -->` block, for anywhere the markdown is shown as prose. */
export function stripStepMeta(md: string): string {
  return md.replace(/<!--\s*step\b[\s\S]*?-->\n?/g, '');
}

/** The tiny YAML the front matter uses, reused inside a step block. */
function parseStepMeta(text: string): { target: string | null; goals: Goal[]; hint?: string; transient: boolean } {
  const out: { target: string | null; goals: Goal[]; hint?: string; transient: boolean } = { target: null, goals: [], transient: false };
  let inGoals = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const item = /^\s*- (.*)$/.exec(line);
    if (item) {
      if (inGoals) out.goals.push(parseGoal(item[1].trim()));
      continue;
    }
    const pair = /^\s*([a-z][a-zA-Z]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    inGoals = key === 'goals';
    if (key === 'target') out.target = value.trim() || null;
    else if (key === 'hint') out.hint = value.trim();
    else if (key === 'transient') out.transient = value.trim() === 'true';
  }
  return out;
}

/** The first fenced block in a step, whatever its language tag. */
function firstFence(md: string): string | undefined {
  const m = /^```[a-z]*\n([\s\S]*?)^```/m.exec(md);
  return m ? m[1].trimEnd() : undefined;
}

/**
 * Splits the **You should see:** line off the rest of a step. It usually runs
 * to the end of its paragraph, but when it introduces a fenced block — the
 * exact query Trace prints, the lineage Simulate explains — the block is part
 * of what the reader should see, so it comes along.
 */
function takeExpectation(md: string): { expect: string; rest: string } {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.includes('**You should see:**'));
  if (at === -1) return { expect: '', rest: md };

  let end = at + 1;
  while (end < lines.length && lines[end].trim() !== '') end++;
  let scan = end;
  while (scan < lines.length && lines[scan].trim() === '') scan++;
  if (scan < lines.length && lines[scan].startsWith('```')) {
    end = scan + 1;
    while (end < lines.length && !lines[end].startsWith('```')) end++;
    end = Math.min(end + 1, lines.length);
  }

  const block = lines.slice(at, end);
  const rest = [...lines.slice(0, at), ...lines.slice(end)].join('\n');
  const fenced = block.some((l) => l.startsWith('```'));
  const text = block.join(fenced ? '\n' : ' ').replace('**You should see:**', '');
  return { expect: (fenced ? text.replace(/^\s+/, '') : text.replace(/\s+/g, ' ')).trim(), rest };
}

function parseSteps(stepsSection: string): TourStep[] {
  const blocks = stepsSection.split(/^### /m).slice(1);
  // A step's code is its own first fenced block, or — when it has none — the
  // one the step before it printed, so "now click Import" can act on the script
  // the previous step told you to paste.
  let carried: string | undefined;
  return blocks.map((block, i) => {
    const nl = block.indexOf('\n');
    const heading = (nl === -1 ? block : block.slice(0, nl)).trim();
    let rest = nl === -1 ? '' : block.slice(nl + 1);
    const numbered = /^(\d+)\.\s+(.*)$/.exec(heading);

    const metaMatch = STEP_META.exec(rest);
    const meta = metaMatch ? parseStepMeta(metaMatch[1]) : { target: null, goals: [] as Goal[], hint: undefined, transient: false };
    rest = stripStepMeta(rest);

    // The "You should see:" line is the step's own acceptance test in prose; the
    // coach mark shows it apart from the instruction, under a different heading.
    const found = takeExpectation(rest);
    rest = found.rest;
    carried = firstFence(rest) ?? carried;

    return {
      n: numbered ? Number(numbered[1]) : i + 1,
      title: numbered ? numbered[2].trim() : heading,
      body: rest.trim(),
      expect: found.expect,
      target: meta.target,
      goals: meta.goals,
      hint: meta.hint,
      code: carried,
      transient: meta.transient,
    };
  });
}

/** Cuts one walkthrough into the cards the tour walks through. */
export function buildTourPlan(w: TourSource): TourPlan {
  const body = w.body;
  return {
    slug: w.slug,
    title: w.title,
    level: w.level ?? 'beginner',
    minutes: w.minutes ?? 0,
    dialect: w.dialect ?? 'postgresql',
    startJson: w.startJson,
    startsEmpty: w.startsEmpty ?? false,
    intro: withoutMermaid(stripStepMeta(sectionBody(body, "What you'll build"))),
    model: stripStepMeta(sectionBody(body, 'The mental model')),
    steps: parseSteps(sectionBody(body, 'Steps')),
    verify: stripStepMeta(sectionBody(body, 'Check your work')),
    gotchas: stripStepMeta(sectionBody(body, 'Gotchas')),
    alternatives: stripStepMeta(sectionBody(body, 'Other ways to do it')),
    next: stripStepMeta(sectionBody(body, 'Where to go next')),
  };
}
