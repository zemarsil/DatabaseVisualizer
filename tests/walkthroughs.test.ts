import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseDiagramFile } from '@/lib/io';
import { runWalkthroughCheck } from '@/lib/walkthroughChecks';

/**
 * Guards docs/walkthroughs/. The CLI validator (scripts/validate-walkthrough.mjs)
 * checks the markdown, the companion diagram's structure and the chain between
 * walkthroughs; what needs the app's own code — "does this diagram really
 * generate that SQL, lint clean, simulate, trace?" — is the `checks:` list in
 * each walkthrough's front matter, run here through src/lib/walkthroughChecks.ts,
 * the same module behind the panel's **Check my work** button.
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

  it('chains each walkthrough onto the one before it', async () => {
    // The chain rule: walkthrough N starts from N-1's finished diagram, the
    // prerequisites/next links say so, and no table the reader built is ever
    // dropped. Lives in the tooling module so the CLI validator shares it.
    // @ts-expect-error - plain-JS tooling module, deliberately untyped
    const { validateSeries } = await import('../scripts/walkthrough-lib.mjs');
    expect(validateSeries()).toEqual([]);
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
            // Ordered: a companion diagram is written in the order the
            // walkthrough builds things, and should stay that way.
            const result = runWalkthroughCheck(check, loaded(), { ordered: true });
            expect(result.ok, result.detail).toBe(true);
          });
        }
      }
    });
  }
});
