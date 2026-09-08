/**
 * Shared rules for the walkthroughs in docs/walkthroughs/.
 *
 * A walkthrough is a markdown file with front matter plus, usually, a companion
 * .dbviz.json the reader can open in the app. Both halves are checked: the
 * markdown against the house format (docs/walkthroughs/WALKTHROUGH_FORMAT.md),
 * the diagram against scripts/validate-dbviz.mjs, and the front matter's
 * `checks:` against what the app's own code actually produces from that diagram
 * (tests/walkthroughs.test.ts runs those, because they need the TypeScript
 * libraries).
 *
 * This module is the single parser for all of it: the CLI validator, the index
 * builder and the test suite all read walkthroughs through here.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const WALKTHROUGH_DIR = 'docs/walkthroughs';

/** `NN-slug.md`, where NN orders the series. */
export const FILE_PATTERN = /^(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export const LEVELS = ['beginner', 'intermediate', 'advanced'];
export const DIALECTS = ['postgresql', 'mariadb', 'sqlite'];

/**
 * Every keystroke the app actually binds, in the spelling walkthroughs must use.
 * Sources: src/App.tsx (global), src/components/canvas/Canvas.tsx (canvas),
 * src/components/CommandPalette.tsx, src/components/inspector/TableEditor.tsx
 * (column grid) and src/components/drawer/QueryPanel.tsx (Ctrl+Enter).
 *
 * A walkthrough that names anything else is naming a shortcut that does not
 * exist, which is the single easiest way to write documentation that lies.
 */
export const KNOWN_SHORTCUTS = [
  'Ctrl+K',
  'Ctrl+Z',
  'Ctrl+Shift+Z',
  'Ctrl+Y',
  'Ctrl+S',
  'Ctrl+O',
  'Ctrl+C',
  'Ctrl+X',
  'Ctrl+V',
  'Ctrl+Enter',
  'Ctrl+Backspace',
  'Shift+Enter',
  'Shift+click',
  'Shift+drag',
  'T',
  'N',
  'G',
  'L',
  'F',
  'S',
  'F2',
  '.',
  '[',
  ']',
  '?',
  'Esc',
  'Enter',
  'Delete',
  'Backspace',
  'Tab',
  'Arrow keys',
  'Shift+Arrow keys',
];

/** The H2 headings every walkthrough carries, in this order. */
export const REQUIRED_SECTIONS = [
  "What you'll build",
  'Before you start',
  'The mental model',
  'Steps',
  'Other ways to do it',
  'Check your work',
  'Gotchas',
  'Where to go next',
];

/** Extra H2s a walkthrough may add, between Steps and Where to go next. */
export const OPTIONAL_SECTIONS = ['Try it yourself', 'Reference'];

/** Front-matter keys, and whether they are a list. */
export const FIELDS = {
  title: { list: false, required: true },
  slug: { list: false, required: true },
  summary: { list: false, required: true },
  level: { list: false, required: true },
  minutes: { list: false, required: true },
  dialect: { list: false, required: true },
  covers: { list: true, required: true },
  shortcuts: { list: true, required: false },
  diagram: { list: false, required: false },
  checks: { list: true, required: false },
  prerequisites: { list: true, required: true },
  next: { list: true, required: true },
};

/** Check verbs the test suite knows how to run. `null` means the verb takes no argument. */
export const CHECK_VERBS = {
  contains: 'text the generated script must contain',
  omits: 'text the generated script must not contain',
  tables: 'every table name in the diagram, in file order, comma separated',
  views: 'every view name in the diagram, in file order, comma separated',
  groups: 'every group name in the diagram, in file order, comma separated',
  types: 'every custom type name in the diagram, in file order, comma separated',
  kinds: 'exact relationship counts per kind, e.g. "fk:3, flow:1"; kinds left out must be absent',
  indexes: 'total number of indexes across every table',
  derivations: 'total number of derivations across every flow',
  'lint clean': null,
  simulate: 'a table name that must simulate with rows and no warnings',
  trace: 'two table names as "a -> b" that must have a path between them',
};

/* ------------------------------------------------------------------ */
/* Front matter                                                        */
/* ------------------------------------------------------------------ */

/**
 * The deliberately tiny subset of YAML the format allows: `key: value` scalars
 * and `key:` followed by `  - item` lists. Nothing nests, nothing is quoted,
 * every value is a trimmed string. Keeping it this small means the format has
 * one implementation and no dependency.
 */
export function parseFrontMatter(text) {
  const errors = [];
  const meta = {};
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    return { meta, body: text, bodyLine: 1, errors: ['file does not start with a "---" front-matter fence'] };
  }
  let i = 1;
  let currentList = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    if (line.trim() === '') continue;
    const item = /^ {2}- (.*)$/.exec(line);
    if (item) {
      if (!currentList) errors.push(`line ${i + 1}: list item with no key above it`);
      else currentList.push(item[1].trim());
      continue;
    }
    const pair = /^([a-z][a-zA-Z]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!pair) {
      errors.push(`line ${i + 1}: not "key: value" or "  - item": ${JSON.stringify(line)}`);
      continue;
    }
    const [, key, rawValue] = pair;
    if (key in meta) errors.push(`line ${i + 1}: duplicate key "${key}"`);
    if (rawValue === undefined || rawValue.trim() === '') {
      currentList = [];
      meta[key] = currentList;
    } else {
      currentList = null;
      meta[key] = rawValue.trim();
    }
  }
  if (i >= lines.length) errors.push('front matter is never closed with "---"');
  return { meta, body: lines.slice(i + 1).join('\n'), bodyLine: i + 2, errors };
}

/** "contains | CREATE TABLE x" -> { verb: 'contains', arg: 'CREATE TABLE x' }. */
export function parseCheck(raw) {
  const idx = raw.indexOf('|');
  if (idx === -1) return { verb: raw.trim(), arg: null, raw };
  return { verb: raw.slice(0, idx).trim(), arg: raw.slice(idx + 1).trim(), raw };
}

export function splitList(arg) {
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Body structure                                                      */
/* ------------------------------------------------------------------ */

/** Strips fenced code blocks so prose checks never trip over example code. */
function withoutFences(body) {
  return body.replace(/^```[\s\S]*?^```/gm, '');
}

function headings(body, level) {
  const prefix = '#'.repeat(level) + ' ';
  const out = [];
  let inFence = false;
  body.split('\n').forEach((line, n) => {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence && line.startsWith(prefix)) out.push({ text: line.slice(prefix.length).trim(), line: n + 1 });
  });
  return out;
}

/** The slice of the body under a given H2, up to the next H2. */
export function sectionBody(body, name) {
  const lines = body.split('\n');
  let start = -1;
  let inFence = false;
  for (let n = 0; n < lines.length; n++) {
    if (lines[n].startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    if (start === -1 && lines[n].startsWith('## ') && lines[n].slice(3).trim() === name) start = n + 1;
    else if (start !== -1 && lines[n].startsWith('## ')) return lines.slice(start, n).join('\n');
  }
  return start === -1 ? null : lines.slice(start).join('\n');
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export function listWalkthroughFiles(dir = WALKTHROUGH_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort()
    .map((f) => join(dir, f));
}

export function slugsInSeries(dir = WALKTHROUGH_DIR) {
  return listWalkthroughFiles(dir).map((f) => basename(f, '.md'));
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everything that can be checked without loading the app's TypeScript: the
 * front matter, the section skeleton, the step numbering, the shortcuts named
 * in prose, and that the companion diagram and every internal link exist.
 * Returns { errors, warnings, meta, body }.
 */
export function validateWalkthrough(file, opts = {}) {
  const errors = [];
  const warnings = [];
  const known = opts.slugs ?? slugsInSeries(dirname(file));
  const name = basename(file);

  const m = FILE_PATTERN.exec(name);
  if (!m) errors.push(`filename must be NN-lower-kebab-slug.md, got "${name}"`);

  const text = readFileSync(file, 'utf8');
  const { meta, body, errors: fmErrors } = parseFrontMatter(text);
  errors.push(...fmErrors);

  /* ---- front matter ---- */
  for (const [key, spec] of Object.entries(FIELDS)) {
    const v = meta[key];
    if (v === undefined) {
      if (spec.required) errors.push(`front matter is missing "${key}"`);
      continue;
    }
    if (spec.list && !Array.isArray(v)) errors.push(`"${key}" must be a list of "  - item" lines`);
    if (!spec.list && Array.isArray(v)) errors.push(`"${key}" must be a single value on one line`);
  }
  for (const key of Object.keys(meta)) {
    if (!(key in FIELDS)) errors.push(`unknown front-matter key "${key}"`);
  }

  const expectedSlug = basename(name, '.md');
  if (meta.slug && meta.slug !== expectedSlug) errors.push(`"slug" is "${meta.slug}" but the filename says "${expectedSlug}"`);
  if (meta.level && !LEVELS.includes(meta.level)) errors.push(`"level" must be one of ${LEVELS.join(', ')}`);
  if (meta.dialect && !DIALECTS.includes(meta.dialect)) errors.push(`"dialect" must be one of ${DIALECTS.join(', ')}`);
  if (meta.minutes !== undefined) {
    const n = Number(meta.minutes);
    if (!Number.isInteger(n) || n < 3 || n > 60) errors.push('"minutes" must be a whole number between 3 and 60');
  }
  if (typeof meta.title === 'string') {
    if (meta.title.endsWith('.')) errors.push('"title" must not end with a full stop');
    if (meta.title.length > 60) errors.push('"title" must be 60 characters or fewer');
  }
  if (typeof meta.summary === 'string') {
    if (!meta.summary.endsWith('.')) errors.push('"summary" must be one sentence ending in a full stop');
    if (meta.summary.length > 180) errors.push('"summary" must be 180 characters or fewer');
    if (meta.summary === 'TODO') errors.push('"summary" is still the placeholder');
  }
  if (Array.isArray(meta.covers) && meta.covers.length < 3) errors.push('"covers" needs at least 3 entries');
  if (Array.isArray(meta.shortcuts)) {
    for (const s of meta.shortcuts) {
      if (!KNOWN_SHORTCUTS.includes(s)) errors.push(`"shortcuts" names "${s}", which the app does not bind (see KNOWN_SHORTCUTS)`);
    }
  }
  for (const key of ['prerequisites', 'next']) {
    if (!Array.isArray(meta[key])) continue;
    if (meta[key].length === 0) errors.push(`"${key}" must list slugs, or a single "none"`);
    for (const slug of meta[key]) {
      if (slug === 'none') continue;
      if (slug === expectedSlug) errors.push(`"${key}" points at this walkthrough itself`);
      else if (!known.includes(slug)) errors.push(`"${key}" names "${slug}", which is not a walkthrough in this directory`);
    }
    if (meta[key].includes('none') && meta[key].length > 1) errors.push(`"${key}" mixes "none" with real slugs`);
  }

  /* ---- companion diagram ---- */
  let diagramPath = null;
  if (typeof meta.diagram === 'string') {
    if (!meta.diagram.startsWith('diagrams/') || !meta.diagram.endsWith('.dbviz.json')) {
      errors.push('"diagram" must be a path like diagrams/NN-slug.dbviz.json');
    }
    diagramPath = resolve(dirname(file), meta.diagram);
    if (!existsSync(diagramPath)) {
      errors.push(`"diagram" points at ${meta.diagram}, which does not exist`);
      diagramPath = null;
    } else if (basename(diagramPath) !== `${expectedSlug}.dbviz.json`) {
      warnings.push(`the companion diagram is usually named ${expectedSlug}.dbviz.json`);
    }
    if (!Array.isArray(meta.checks) || meta.checks.length < 2) {
      errors.push('a walkthrough with a companion diagram needs at least 2 "checks" that pin down what the diagram produces');
    }
  } else if (Array.isArray(meta.checks) && meta.checks.length) {
    errors.push('"checks" only mean something with a "diagram" to run them against');
  }

  if (Array.isArray(meta.checks)) {
    for (const raw of meta.checks) {
      const { verb, arg } = parseCheck(raw);
      if (!(verb in CHECK_VERBS)) {
        errors.push(`check "${raw}" starts with an unknown verb; use one of: ${Object.keys(CHECK_VERBS).join(', ')}`);
        continue;
      }
      const takesArg = CHECK_VERBS[verb] !== null;
      if (takesArg && !arg) errors.push(`check "${raw}" needs an argument after "|" (${CHECK_VERBS[verb]})`);
      if (!takesArg && arg) errors.push(`check "${raw}" takes no argument`);
      if (verb === 'trace' && arg && !arg.includes('->')) errors.push(`check "${raw}" must read "table_a -> table_b"`);
      if ((verb === 'indexes' || verb === 'derivations') && arg && !/^\d+$/.test(arg)) errors.push(`check "${raw}" must give a whole number`);
      if (verb === 'kinds' && arg) {
        for (const part of splitList(arg)) {
          if (!/^(fk|flow|embed|dependency):\d+$/.test(part)) errors.push(`check "${raw}" has a bad entry "${part}"; use kind:count`);
        }
      }
    }
  }

  /* ---- body skeleton ---- */
  const h1 = headings(body, 1);
  if (h1.length !== 1) errors.push(`the body needs exactly one "# " heading, found ${h1.length}`);
  else if (meta.title && h1[0].text !== meta.title) errors.push(`the "# " heading is "${h1[0].text}" but the title is "${meta.title}"`);

  const h2 = headings(body, 2).map((h) => h.text);
  const missing = REQUIRED_SECTIONS.filter((s) => !h2.includes(s));
  if (missing.length) errors.push(`missing required section(s): ${missing.map((s) => `## ${s}`).join(', ')}`);
  const unknownSections = h2.filter((s) => !REQUIRED_SECTIONS.includes(s) && !OPTIONAL_SECTIONS.includes(s));
  if (unknownSections.length) {
    errors.push(`unexpected section(s) ${unknownSections.map((s) => `"## ${s}"`).join(', ')}; the format allows ${[...REQUIRED_SECTIONS, ...OPTIONAL_SECTIONS].map((s) => `"${s}"`).join(', ')}`);
  }
  const order = h2.filter((s) => REQUIRED_SECTIONS.includes(s));
  const sorted = [...order].sort((a, b) => REQUIRED_SECTIONS.indexOf(a) - REQUIRED_SECTIONS.indexOf(b));
  if (order.join('|') !== sorted.join('|')) errors.push(`the required sections are out of order; they must read: ${REQUIRED_SECTIONS.join(' → ')}`);

  /* ---- steps ---- */
  const steps = sectionBody(body, 'Steps');
  if (steps !== null) {
    const stepHeads = headings(steps, 3);
    if (stepHeads.length < 3) errors.push(`"## Steps" needs at least 3 "### N. …" steps, found ${stepHeads.length}`);
    stepHeads.forEach((h, idx) => {
      const numbered = /^(\d+)\.\s+\S/.exec(h.text);
      if (!numbered) errors.push(`step heading "### ${h.text}" must read "### N. Do the thing"`);
      else if (Number(numbered[1]) !== idx + 1) errors.push(`step "### ${h.text}" is out of sequence; expected ${idx + 1}`);
    });
    const blocks = steps.split(/^### /m).slice(1);
    blocks.forEach((block, idx) => {
      if (!block.includes('**You should see:**')) errors.push(`step ${idx + 1} has no "**You should see:**" line saying what changes on screen`);
    });
  }

  /* ---- fenced blocks the format requires ---- */
  const build = sectionBody(body, "What you'll build");
  if (build !== null && !/^```mermaid$/m.test(build)) errors.push('"## What you\'ll build" needs a ```mermaid sketch of the end state');
  const check = sectionBody(body, 'Check your work');
  if (check !== null && !/^```sql$/m.test(check)) errors.push('"## Check your work" needs a ```sql block showing what the app generates');

  /* ---- prose accuracy ---- */
  const prose = withoutFences(body);
  const codeSpans = [...prose.matchAll(/`([^`\n]+)`/g)].map((mm) => mm[1]);
  const looksLikeShortcut = /^(Ctrl|Cmd|Command|Alt|Option|Meta|Shift)[+-]|^(Esc|Escape|Enter|Return|Delete|Backspace|Tab|F\d{1,2})$/;
  for (const span of new Set(codeSpans)) {
    if (!looksLikeShortcut.test(span)) continue;
    if (!KNOWN_SHORTCUTS.includes(span)) errors.push(`the prose names the shortcut \`${span}\`, which the app does not bind (canonical spellings live in KNOWN_SHORTCUTS)`);
  }
  for (const marker of ['TODO', 'TBD', 'FIXME', 'Lorem ipsum', 'XXX']) {
    if (prose.includes(marker)) errors.push(`the body still contains "${marker}"`);
  }
  if (prose.trim().length < 3500) errors.push(`the body is ${prose.trim().length} characters of prose; a walkthrough should be at least 3500`);

  /* ---- links ---- */
  for (const mm of body.matchAll(/\]\((?!https?:|#)([^)\s]+)/g)) {
    const target = mm[1].split('#')[0];
    if (!target) continue;
    if (!existsSync(resolve(dirname(file), target))) errors.push(`link target "${target}" does not exist`);
  }

  return { file, meta, body, diagramPath, errors, warnings };
}
