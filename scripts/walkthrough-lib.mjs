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
  start: { list: false, required: true },
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
  'lint errors': 'the exact number of error-severity findings Problems reports; for a walkthrough that ships a deliberately broken diagram',
  simulate: 'a table name that must simulate with rows and no warnings',
  trace: 'two table names as "a -> b" that must have a path between them',
};

/* ------------------------------------------------------------------ */
/* Steps as a clickthrough                                             */
/* ------------------------------------------------------------------ */

/**
 * Every step carries an HTML comment saying where the coach mark points and
 * what the step is for:
 *
 *     <!-- step
 *     target: ui:add-table
 *     goals:
 *       - table | authors
 *     -->
 *
 * These are the keys it may use. `goals` is a list, everything else a scalar.
 */
export const STEP_KEYS = {
  target: { list: false, required: true },
  goals: { list: true, required: false },
  hint: { list: false, required: false },
  transient: { list: false, required: false },
};

/** The drawer tabs a `tab:` or `panel:` target may name. Source: src/components/drawer/Drawer.tsx. */
export const DRAWER_TABS = ['walkthrough', 'sql', 'types', 'import', 'trace', 'simulate', 'problems', 'query', 'database'];

/**
 * What a `target:` may start with, and what the rest of it means. Anything
 * pointing at chrome (`ui:`) is checked against the `data-tour` attributes the
 * components really carry, so a renamed button cannot leave a step pointing at
 * nothing.
 */
export const TARGET_KINDS = {
  ui: 'a data-tour attribute in src/components',
  tab: 'a drawer tab id',
  panel: 'a drawer tab id; rings the panel rather than the tab',
  field: 'the visible label of an inspector field, e.g. "Reads as"',
  section: 'the visible title of an inspector section, e.g. "Indexes"',
  sidebar: 'the table list (takes no argument)',
  table: 'a table on the canvas, by name',
  column: 'a column row on the canvas, as table.column',
  rel: 'a connection on the canvas, as "source -> target"',
  none: 'nothing: the card floats free (takes no argument)',
};

/**
 * Goal verbs, mirroring src/lib/tour/goals.ts. `null` means the verb takes no
 * argument. Two implementations again, for the same reason the check verbs
 * have two: this file runs under Node, the app's under Vite —
 * tests/tour.test.ts asserts the two lists agree.
 */
export const GOAL_VERBS = {
  contains: 'text the generated script must contain',
  omits: 'text the generated script must not contain',
  tables: 'every table name in the diagram, comma separated',
  views: 'every view name in the diagram, comma separated',
  groups: 'every group name in the diagram, comma separated',
  types: 'every custom type name in the diagram, comma separated',
  kinds: 'relationship counts per kind, e.g. "fk:3, flow:1"',
  indexes: 'total number of indexes across every table',
  derivations: 'total number of derivations across every flow',
  'lint clean': null,
  'lint errors': 'the exact number of errors Problems reports',
  simulate: 'a table that must simulate with rows and no warnings',
  trace: 'two table names as "a -> b" with a path between them',
  table: 'a table name that must exist',
  view: 'a view name that must exist',
  'no table': 'a table name that must be gone',
  column: 'table.column, optionally " : TYPE"',
  'no column': 'table.column that must be gone',
  flags: 'table.column : pk nn uq ai, each optionally negated with "-"',
  default: 'table.column : the default expression',
  check: 'table.column : expression, or table : expression for a table check',
  schema: 'table : schema name',
  collapsed: 'table : full, keys or header',
  materialized: 'view : on or off',
  viewsql: "a view name; the step's fenced block is what gets written",
  import: "the tables the step's fenced block brings in, comma separated",
  fk: 'child.column -> parent.column',
  flow: 'source_table -> target_table',
  embed: 'container.column -> embedded_table',
  dependency: 'source_table -> target_table',
  reads: 'a sentence like "books belongs to authors"',
  label: 'source -> target : the label or constraint name',
  'reverse label': 'source -> target : how the far end reads',
  ondelete: 'child -> parent : NO ACTION, RESTRICT, CASCADE, SET NULL or SET DEFAULT',
  query: "source -> target; the step's fenced block gets tagged onto the connection",
  derivation: 'target.column : an expression like SUM(quantity), optionally "group by …"',
  index: 'table (col, col)',
  'unique index': 'table (col, col)',
  group: 'Name, optionally " : member, member"',
  'external group': 'Name, optionally " : member, member"',
  enum: 'name : value, value, value',
  composite: 'name : field TYPE, field TYPE',
  dialect: 'postgresql, mariadb or sqlite',
  open: 'a drawer tab id, e.g. sql or problems',
  'select table': 'a table name that must be selected',
  'select connection': 'source -> target of the connection that must be selected',
  cardinality: 'on or off',
  simulating: 'the table a simulation must be feeding',
  traced: 'from -> to, the two ends of a trace that must have run',
  focus: 'the table whose neighbourhood must be focused, or "none"',
};

/** `data-tour="…"` attributes the components actually carry, so `ui:` targets can be checked. */
export function tourAnchors(dir = 'src/components') {
  const found = new Set();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/data-tour="([^"]+)"/g)) found.add(m[1]);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/** Reads one step's `<!-- step … -->` block with the same tiny YAML as the front matter. */
export function parseStepMeta(text) {
  const meta = {};
  const errors = [];
  let currentList = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const item = /^\s*- (.*)$/.exec(line);
    if (item) {
      if (!currentList) errors.push(`list item with no key above it: ${JSON.stringify(line)}`);
      else currentList.push(item[1].trim());
      continue;
    }
    const pair = /^\s*([a-z][a-zA-Z]*):\s*(.*)$/.exec(line);
    if (!pair) {
      errors.push(`not "key: value" or "  - item": ${JSON.stringify(line)}`);
      continue;
    }
    const [, key, value] = pair;
    if (key in meta) errors.push(`duplicate key "${key}"`);
    if (value.trim() === '') {
      currentList = [];
      meta[key] = currentList;
    } else {
      currentList = null;
      meta[key] = value.trim();
    }
  }
  return { meta, errors };
}

/** Everything that can go wrong in one step's metadata block. */
export function validateStepMeta(meta, { anchors }) {
  const errors = [];
  for (const [key, spec] of Object.entries(STEP_KEYS)) {
    const v = meta[key];
    if (v === undefined) {
      if (spec.required) errors.push(`has no "${key}:"`);
      continue;
    }
    if (spec.list && !Array.isArray(v)) errors.push(`"${key}" must be a list of "  - item" lines`);
    if (!spec.list && Array.isArray(v)) errors.push(`"${key}" must be a single value on one line`);
  }
  for (const key of Object.keys(meta)) {
    if (!(key in STEP_KEYS)) errors.push(`unknown key "${key}"; the block takes ${Object.keys(STEP_KEYS).join(', ')}`);
  }
  if (meta.transient !== undefined && meta.transient !== 'true') errors.push('"transient" is only ever "true"; leave it out otherwise');

  if (typeof meta.target === 'string') {
    const cut = meta.target.indexOf(':');
    const kind = cut === -1 ? meta.target : meta.target.slice(0, cut);
    const arg = cut === -1 ? '' : meta.target.slice(cut + 1).trim();
    if (!(kind in TARGET_KINDS)) {
      errors.push(`target "${meta.target}" starts with an unknown kind; use one of: ${Object.keys(TARGET_KINDS).join(', ')}`);
    } else if (kind !== 'none' && kind !== 'sidebar' && !arg) {
      errors.push(`target "${meta.target}" needs an argument after ":" (${TARGET_KINDS[kind]})`);
    } else if (kind === 'ui' && anchors.size && !anchors.has(arg)) {
      errors.push(`target "${meta.target}" names no data-tour attribute in src/components; the ones that exist are ${[...anchors].sort().join(', ')}`);
    } else if ((kind === 'tab' || kind === 'panel') && !DRAWER_TABS.includes(arg)) {
      errors.push(`target "${meta.target}" names no drawer tab; the tabs are ${DRAWER_TABS.join(', ')}`);
    } else if (kind === 'column' && !arg.includes('.')) {
      errors.push(`target "${meta.target}" must read "table.column"`);
    } else if (kind === 'rel' && !arg.includes('->')) {
      errors.push(`target "${meta.target}" must read "source -> target"`);
    }
  }

  for (const raw of Array.isArray(meta.goals) ? meta.goals : []) {
    const { verb, arg } = parseCheck(raw);
    if (!(verb in GOAL_VERBS)) {
      errors.push(`goal "${raw}" starts with an unknown verb; see GOAL_VERBS in scripts/walkthrough-lib.mjs`);
      continue;
    }
    const takesArg = GOAL_VERBS[verb] !== null;
    if (takesArg && !arg) errors.push(`goal "${raw}" needs an argument after "|" (${GOAL_VERBS[verb]})`);
    if (!takesArg && arg) errors.push(`goal "${raw}" takes no argument`);
    if (['fk', 'flow', 'embed', 'dependency', 'traced', 'trace'].includes(verb) && arg && !arg.includes('->')) {
      errors.push(`goal "${raw}" must name both ends as "a -> b"`);
    }
    if (['ondelete', 'label', 'reverse label', 'query', 'select connection'].includes(verb) && arg && !arg.includes('->')) {
      errors.push(`goal "${raw}" must name the connection as "source -> target"`);
    }
    if (['indexes', 'derivations', 'lint errors'].includes(verb) && arg && !/^\d+$/.test(arg)) {
      errors.push(`goal "${raw}" must give a whole number`);
    }
    if (['flags', 'default', 'schema', 'collapsed', 'materialized', 'enum', 'composite', 'derivation'].includes(verb) && arg && !arg.includes(':')) {
      errors.push(`goal "${raw}" must read "subject : what it should be"`);
    }
  }
  return errors;
}

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

  /* ---- where it starts ---- */
  // The series is one continuous build, so a walkthrough's "start" is the state
  // the reader needs on the canvas before step 1 — which is the previous
  // walkthrough's finished diagram, or "empty" for the one that opens the series.
  // validateSeries() below checks that the chain really links up.
  if (typeof meta.start === 'string' && meta.start !== 'empty') {
    if (!meta.start.startsWith('diagrams/') || !meta.start.endsWith('.dbviz.json')) {
      errors.push('"start" must be "empty" or a path like diagrams/NN-slug.dbviz.json');
    } else if (!existsSync(resolve(dirname(file), meta.start))) {
      errors.push(`"start" points at ${meta.start}, which does not exist`);
    }
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
    } else if (basename(diagramPath) !== `${expectedSlug}.dbviz.json` && meta.diagram !== meta.start) {
      // Reusing the start diagram is how a walkthrough says "this one reads the
      // canvas rather than changing it"; any other borrowed file is a mistake.
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
      if ((verb === 'indexes' || verb === 'derivations' || verb === 'lint errors') && arg && !/^\d+$/.test(arg)) errors.push(`check "${raw}" must give a whole number`);
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
    const anchors = opts.anchors ?? tourAnchors();
    blocks.forEach((block, idx) => {
      if (!block.includes('**You should see:**')) errors.push(`step ${idx + 1} has no "**You should see:**" line saying what changes on screen`);
      // Every step is a card in the clickthrough, so every step has to say
      // where the card points and, where there is something to check, what
      // doing it looks like.
      const found = [...block.matchAll(/<!--\s*step\b([\s\S]*?)-->/g)];
      if (found.length === 0) {
        errors.push(`step ${idx + 1} has no "<!-- step ... -->" block saying where the coach mark points`);
      } else if (found.length > 1) {
        errors.push(`step ${idx + 1} has ${found.length} "<!-- step ... -->" blocks; it may have one`);
      } else {
        const { meta, errors: parseErrors } = parseStepMeta(found[0][1]);
        for (const e of parseErrors) errors.push(`step ${idx + 1}: ${e}`);
        for (const e of validateStepMeta(meta, { anchors })) errors.push(`step ${idx + 1}: ${e}`);
      }
    });
    // A block outside "## Steps" is invisible to the tour, so it is a mistake
    // wherever it looks harmless.
    const strayBlocks = [...body.matchAll(/<!--\s*step\b/g)].length - [...steps.matchAll(/<!--\s*step\b/g)].length;
    if (strayBlocks > 0) errors.push(`${strayBlocks} "<!-- step ... -->" block(s) sit outside "## Steps", where nothing reads them`);
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

/* ------------------------------------------------------------------ */
/* The series                                                          */
/* ------------------------------------------------------------------ */

/**
 * The walkthroughs are one continuous build of one database, not fifteen
 * separate exercises: walkthrough N picks the canvas up exactly where N-1 put
 * it down. That promise is only worth making if it is checked, so this asserts
 * the three things that make the chain real:
 *
 *   - the first walkthrough starts from an empty canvas, and every later one
 *     starts from its predecessor's finished diagram — the *same file*, so the
 *     two can never drift apart;
 *   - `prerequisites` and `next` are that same chain, one step each way;
 *   - the cast only grows. A table that exists at the end of N is still there
 *     at the end of N+1, because the reader still has it on their canvas.
 *
 * Returns a list of error strings; empty means the chain links up.
 */
export function validateSeries(dir = WALKTHROUGH_DIR) {
  const errors = [];
  const files = listWalkthroughFiles(dir);
  const entries = files.map((file) => {
    const { meta } = parseFrontMatter(readFileSync(file, 'utf8'));
    return { slug: basename(file, '.md'), file, meta };
  });

  const tableNames = (relPath) => {
    if (typeof relPath !== 'string' || relPath === 'empty') return [];
    const path = join(dir, relPath);
    if (!existsSync(path)) return [];
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      return (Array.isArray(doc.tables) ? doc.tables : []).map((t) => t?.name).filter((n) => typeof n === 'string');
    } catch {
      return [];
    }
  };

  entries.forEach((entry, i) => {
    const prev = entries[i - 1];
    const next = entries[i + 1];
    const { slug, meta } = entry;

    const wantStart = prev ? prev.meta.diagram : 'empty';
    if (meta.start !== wantStart) {
      errors.push(
        prev
          ? `${slug}: "start" is ${JSON.stringify(meta.start)}, but the series continues from ${prev.slug}, whose diagram is ${JSON.stringify(wantStart)}`
          : `${slug}: the first walkthrough must have "start: empty"`,
      );
    }

    const wantPrereq = prev ? [prev.slug] : ['none'];
    if ((meta.prerequisites ?? []).join(',') !== wantPrereq.join(',')) {
      errors.push(`${slug}: "prerequisites" must be exactly "${wantPrereq.join(', ')}" — the series is a single chain`);
    }
    const wantNext = next ? [next.slug] : ['none'];
    if ((meta.next ?? []).join(',') !== wantNext.join(',')) {
      errors.push(`${slug}: "next" must be exactly "${wantNext.join(', ')}" — the series is a single chain`);
    }

    if (prev) {
      const before = tableNames(prev.meta.diagram);
      const after = new Set(tableNames(meta.diagram));
      const dropped = before.filter((n) => !after.has(n));
      if (dropped.length) {
        errors.push(`${slug}: its diagram drops ${dropped.join(', ')}, which the reader still has on the canvas from ${prev.slug}`);
      }
    }
  });

  return errors;
}
