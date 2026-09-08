import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Diagram } from '@shared/types';
import { parseDiagramFile } from '@/lib/io';
import { generateSchema } from '@/lib/sql/generator';
import { lintDiagram } from '@/lib/lint';
import { findPath } from '@/lib/trace';
import { simulateFlows } from '@/lib/simulate/engine';

/**
 * Guards docs/walkthroughs/. The CLI validator (scripts/validate-walkthrough.mjs)
 * checks the markdown and the companion diagram's structure; what needs the app's
 * own code — "does this diagram really generate that SQL, lint clean, simulate,
 * trace?" — is the `checks:` list in each walkthrough's front matter, run here.
 *
 * Each walkthrough gets its own describe block named after its file, so a single
 * one can be run while it is being written:
 *
 *   npx vitest run tests/walkthroughs.test.ts -t 01-set-up-a-table
 */

const DIR = 'docs/walkthroughs';
const FILE_PATTERN = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

interface Report {
  file: string;
  meta: Record<string, string | string[]>;
  errors: string[];
  warnings: string[];
}

function validatorReport(file: string): Report {
  try {
    const out = execFileSync('node', ['scripts/validate-walkthrough.mjs', '--json', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out) as Report;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const stdout = e.stdout ?? '';
    try {
      return JSON.parse(stdout) as Report;
    } catch {
      return { file, meta: {}, errors: [`the validator itself failed: ${e.stderr ?? stdout}`], warnings: [] };
    }
  }
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function tableNamed(d: Diagram, name: string): string {
  const t = d.tables.find((x) => x.name === name);
  expect(t, `the diagram has no table named "${name}" (it has: ${d.tables.map((x) => x.name).join(', ')})`).toBeTruthy();
  return t!.id;
}

/** Runs one `checks:` entry from the front matter against the companion diagram. */
function runCheck(raw: string, d: Diagram): void {
  const cut = raw.indexOf('|');
  const verb = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  const arg = cut === -1 ? '' : raw.slice(cut + 1).trim();
  const script = () => generateSchema(d).script;

  switch (verb) {
    case 'contains':
      expect(script(), `generated script should contain ${JSON.stringify(arg)}`).toContain(arg);
      break;
    case 'omits':
      expect(script(), `generated script should not contain ${JSON.stringify(arg)}`).not.toContain(arg);
      break;
    case 'tables':
      expect(d.tables.map((t) => t.name)).toEqual(list(arg));
      break;
    case 'views':
      expect(d.tables.filter((t) => t.kind === 'view').map((t) => t.name)).toEqual(list(arg));
      break;
    case 'groups':
      expect(d.groups.map((g) => g.name)).toEqual(list(arg));
      break;
    case 'types':
      expect(d.customTypes.map((t) => t.name)).toEqual(list(arg));
      break;
    case 'kinds': {
      const want: Record<string, number> = { fk: 0, flow: 0, embed: 0, dependency: 0 };
      for (const part of list(arg)) {
        const [kind, n] = part.split(':');
        want[kind] = Number(n);
      }
      const got: Record<string, number> = { fk: 0, flow: 0, embed: 0, dependency: 0 };
      for (const r of d.relationships) got[r.kind]++;
      expect(got).toEqual(want);
      break;
    }
    case 'indexes':
      expect(d.tables.reduce((n, t) => n + t.indexes.length, 0)).toBe(Number(arg));
      break;
    case 'derivations':
      expect(d.relationships.reduce((n, r) => n + (r.derivations?.length ?? 0), 0)).toBe(Number(arg));
      break;
    case 'lint clean': {
      const errors = lintDiagram(d).filter((f) => f.severity === 'error');
      expect(errors.map((f) => f.message)).toEqual([]);
      break;
    }
    case 'simulate': {
      const targetId = tableNamed(d, arg);
      const result = simulateFlows(d, targetId, { rows: 8, seed: 1 });
      expect(result.warnings, 'the simulation reported warnings').toEqual([]);
      expect(result.stages.flatMap((s) => s.warnings), 'a simulation stage reported warnings').toEqual([]);
      expect(result.stages.length, 'nothing flows into that table').toBeGreaterThan(0);
      expect((result.rows[targetId] ?? []).length, `no rows reached ${arg}`).toBeGreaterThan(0);
      break;
    }
    case 'trace': {
      const [from, to] = arg.split('->').map((s) => s.trim());
      const path = findPath(d, tableNamed(d, from), tableNamed(d, to));
      expect(path, `no path from ${from} to ${to}`).toBeTruthy();
      expect(path!.hops.length).toBeGreaterThan(0);
      break;
    }
    default:
      throw new Error(`unknown check verb "${verb}" in ${JSON.stringify(raw)}`);
  }
}

const files = readdirSync(DIR).filter((f) => FILE_PATTERN.test(f)).sort();

describe('docs/walkthroughs', () => {
  it('has walkthroughs to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('README.md lists every walkthrough', () => {
    const out = execFileSync('node', ['scripts/build-walkthrough-index.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toContain('OK');
  });

  it('numbers the series without gaps or repeats', () => {
    expect(files.map((f) => Number(f.slice(0, 2)))).toEqual(files.map((_, i) => i));
  });

  it('leaves no orphan diagrams in diagrams/', () => {
    const referenced = new Set(
      files.flatMap((f) => {
        const m = /^diagram: (.+)$/m.exec(readFileSync(join(DIR, f), 'utf8'));
        return m ? [basename(m[1])] : [];
      }),
    );
    const onDisk = readdirSync(join(DIR, 'diagrams')).filter((f) => f.endsWith('.dbviz.json'));
    expect(onDisk.filter((f) => !referenced.has(f))).toEqual([]);
  });

  for (const file of files) {
    describe(file, () => {
      const path = join(DIR, file);
      const report = validatorReport(path);

      it('follows the walkthrough format', () => {
        expect(report.errors.join('\n')).toBe('');
      });

      const diagram = typeof report.meta.diagram === 'string' ? report.meta.diagram : null;
      const checks = Array.isArray(report.meta.checks) ? report.meta.checks : [];

      if (diagram) {
        const loaded = () => parseDiagramFile(readFileSync(resolve(DIR, diagram), 'utf8'));

        it('ships a diagram that loads', () => {
          const d = loaded();
          expect(d.tables.length).toBeGreaterThan(0);
          expect(d.dialect).toBe(report.meta.dialect);
        });

        for (const check of checks) {
          it(`check: ${check}`, () => {
            runCheck(check, loaded());
          });
        }
      }
    });
  }
});
