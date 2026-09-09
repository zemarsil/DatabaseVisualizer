/**
 * Runs a walkthrough's `checks:` against a diagram.
 *
 * The same list is used twice: tests/walkthroughs.test.ts runs it against the
 * companion diagram so a walkthrough cannot claim something the app stopped
 * doing, and the Walkthrough panel's **Check my work** button runs it against
 * whatever is on the reader's canvas so they can find out whether they built
 * the thing the walkthrough describes. One implementation, so the button can
 * never disagree with CI.
 *
 * The verbs, and what each one asserts, are documented in
 * docs/walkthroughs/WALKTHROUGH_FORMAT.md.
 */
import type { Diagram } from '@shared/types';
import { generateSchema } from './sql/generator';
import { lintDiagram } from './lint';
import { simulateFlows } from './simulate/engine';
import { findPath } from './trace';

export interface CheckResult {
  /** The raw `checks:` entry, e.g. "kinds | fk:3, flow:1". */
  check: string;
  verb: string;
  arg: string;
  ok: boolean;
  /** One line a human can act on, whether it passed or failed. */
  detail: string;
}

export interface CheckOptions {
  /**
   * Whether list checks (`tables`, `views`, `groups`, `types`) must match in
   * order. The companion diagrams are written in the order the walkthrough
   * builds things, so CI holds them to it; a reader who typed the same tables
   * in a different order has still done the walkthrough, so the in-app button
   * does not.
   */
  ordered?: boolean;
}

function splitList(arg: string): string[] {
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "a, b" vs "b, a": same members, and the same order when `ordered`. */
function compareLists(what: string, got: string[], want: string[], ordered: boolean): { ok: boolean; detail: string } {
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected ${extra.join(', ')}`);
    return { ok: false, detail: `${what}: ${parts.join('; ')}.` };
  }
  if (ordered && got.join(',') !== want.join(',')) {
    return { ok: false, detail: `${what} are right but in the order ${got.join(', ')}.` };
  }
  return { ok: true, detail: `${what}: ${got.join(', ') || 'none'}.` };
}

function count(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

/** Splits "verb | argument" the same way scripts/walkthrough-lib.mjs does. */
export function parseCheck(raw: string): { verb: string; arg: string } {
  const cut = raw.indexOf('|');
  return cut === -1 ? { verb: raw.trim(), arg: '' } : { verb: raw.slice(0, cut).trim(), arg: raw.slice(cut + 1).trim() };
}

export function runWalkthroughCheck(raw: string, d: Diagram, opts: CheckOptions = {}): CheckResult {
  const { verb, arg } = parseCheck(raw);
  const ordered = opts.ordered ?? false;
  const done = (ok: boolean, detail: string): CheckResult => ({ check: raw, verb, arg, ok, detail });
  const list = (what: string, got: string[]) => {
    const r = compareLists(what, got, splitList(arg), ordered);
    return done(r.ok, r.detail);
  };

  switch (verb) {
    case 'contains': {
      const has = generateSchema(d).script.includes(arg);
      return done(has, has ? `the script contains "${arg}".` : `the generated script never says "${arg}".`);
    }
    case 'omits': {
      const has = generateSchema(d).script.includes(arg);
      return done(!has, has ? `the generated script still says "${arg}".` : `the script leaves out "${arg}".`);
    }
    case 'tables':
      return list('tables', d.tables.map((t) => t.name));
    case 'views':
      return list('views', d.tables.filter((t) => t.kind === 'view').map((t) => t.name));
    case 'groups':
      return list('regions', d.groups.map((g) => g.name));
    case 'types':
      return list('custom types', d.customTypes.map((t) => t.name));
    case 'extensions':
      return list('extensions', d.extensions.map((e) => e.name));
    case 'kinds': {
      const want: Record<string, number> = { fk: 0, flow: 0, embed: 0, dependency: 0 };
      for (const part of splitList(arg)) {
        const [kind, n] = part.split(':');
        want[kind.trim()] = Number(n);
      }
      const got: Record<string, number> = { fk: 0, flow: 0, embed: 0, dependency: 0 };
      for (const r of d.relationships) got[r.kind]++;
      const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
      const say = (m: Record<string, number>) =>
        Object.entries(m)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}:${n}`)
          .join(', ') || 'none';
      return done(wrong.length === 0, wrong.length ? `connections are ${say(got)}, not ${say(want)}.` : `connections: ${say(got)}.`);
    }
    case 'indexes': {
      const n = d.tables.reduce((sum, t) => sum + t.indexes.length, 0);
      const indexes = n === 1 ? '1 index' : `${n} indexes`;
      return done(n === Number(arg), n === Number(arg) ? `${indexes} across the diagram.` : `${indexes} across the diagram, not ${arg}.`);
    }
    case 'derivations': {
      const n = d.relationships.reduce((sum, r) => sum + (r.derivations?.length ?? 0), 0);
      return done(n === Number(arg), n === Number(arg) ? `${count(n, 'derived column')}.` : `${n} derived column(s), not ${arg}.`);
    }
    case 'lint clean': {
      const errors = lintDiagram(d).filter((f) => f.severity === 'error');
      return done(errors.length === 0, errors.length ? `Problems reports ${count(errors.length, 'error')}: ${errors[0].message}` : 'Problems reports no errors.');
    }
    case 'lint errors': {
      const errors = lintDiagram(d).filter((f) => f.severity === 'error');
      const want = Number(arg);
      return done(errors.length === want, errors.length === want ? `Problems reports ${count(errors.length, 'error')}, as it should here.` : `Problems reports ${count(errors.length, 'error')}, not ${want}.`);
    }
    case 'simulate': {
      const target = d.tables.find((t) => t.name === arg);
      if (!target) return done(false, `there is no table called ${arg} to simulate into.`);
      const result = simulateFlows(d, target.id, { rows: 8, seed: 1 });
      const warnings = [...result.warnings, ...result.stages.flatMap((s) => s.warnings)];
      if (warnings.length) return done(false, `simulating ${arg} warns: ${warnings[0]}`);
      if (!result.stages.length) return done(false, `nothing flows into ${arg}, so there is nothing to simulate.`);
      const rows = (result.rows[target.id] ?? []).length;
      return done(rows > 0, rows > 0 ? `${arg} simulates to ${count(rows, 'row')} with no warnings.` : `the flow into ${arg} produced no rows.`);
    }
    case 'trace': {
      const [fromName, toName] = arg.split('->').map((s) => s.trim());
      const from = d.tables.find((t) => t.name === fromName);
      const to = d.tables.find((t) => t.name === toName);
      if (!from || !to) return done(false, `no table called ${!from ? fromName : toName}.`);
      const path = findPath(d, from.id, to.id);
      return done(!!path && path.hops.length > 0, path && path.hops.length ? `Trace finds ${fromName} → ${toName} in ${count(path.hops.length, 'hop')}.` : `Trace finds no path from ${fromName} to ${toName}.`);
    }
    default:
      return done(false, `unknown check verb "${verb}".`);
  }
}

export function runWalkthroughChecks(checks: string[], d: Diagram, opts: CheckOptions = {}): CheckResult[] {
  return checks.map((c) => runWalkthroughCheck(c, d, opts));
}
