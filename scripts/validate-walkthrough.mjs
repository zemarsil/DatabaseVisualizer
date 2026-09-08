#!/usr/bin/env node
/**
 * Checks a walkthrough against the house format (docs/walkthroughs/WALKTHROUGH_FORMAT.md).
 *
 *   node scripts/validate-walkthrough.mjs                       # every walkthrough
 *   node scripts/validate-walkthrough.mjs docs/walkthroughs/01-set-up-a-table.md
 *   node scripts/validate-walkthrough.mjs --json <file>          # machine readable
 *
 * It reads the front matter, the section skeleton, the step numbering, the
 * shortcuts the prose names, the links, and hands the companion .dbviz.json to
 * scripts/validate-dbviz.mjs. Run over the whole series (no file arguments) it
 * also checks the chain: every walkthrough starts from the previous one's
 * finished diagram, and no table the reader has built ever disappears.
 *
 * What it cannot do from plain Node is run the front matter's `checks:` — those
 * need the app's TypeScript, so tests/walkthroughs.test.ts runs them (npm test).
 *
 * Exits 1 if any walkthrough has errors. Warnings alone do not fail.
 */
import { execFileSync } from 'node:child_process';
import { listWalkthroughFiles, slugsInSeries, validateSeries, validateWalkthrough, WALKTHROUGH_DIR } from './walkthrough-lib.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));
const targets = files.length ? files : listWalkthroughFiles();

if (!targets.length) {
  console.error(`No walkthroughs found in ${WALKTHROUGH_DIR}/.`);
  process.exit(1);
}

const slugs = slugsInSeries();
const reports = [];

for (const file of targets) {
  let report;
  try {
    report = validateWalkthrough(file, { slugs });
  } catch (err) {
    reports.push({ file, meta: {}, errors: [`could not read: ${err.message}`], warnings: [] });
    continue;
  }
  // The companion diagram gets the full structural check the advisor format uses.
  if (report.diagramPath) {
    try {
      const out = execFileSync('node', ['scripts/validate-dbviz.mjs', report.diagramPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const line of out.split('\n')) {
        if (/^\s*warning:/i.test(line) || line.includes('warning')) report.warnings.push(`diagram: ${line.trim()}`);
      }
    } catch (err) {
      const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
      report.errors.push(`the companion diagram fails validate-dbviz.mjs:\n${text.replace(/^/gm, '    ')}`);
    }
  }
  reports.push({ file, meta: report.meta, errors: report.errors, warnings: report.warnings });
}

// The chain between walkthroughs can only be judged with all of them in hand.
const seriesErrors = files.length ? [] : validateSeries();

if (json) {
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  process.exit(reports.some((r) => r.errors.length) ? 1 : 0);
}

let failed = 0;
for (const r of reports) {
  const label = r.file;
  if (!r.errors.length && !r.warnings.length) {
    console.log(`OK       ${label}`);
    continue;
  }
  if (r.errors.length) failed++;
  console.log(`${r.errors.length ? 'FAIL    ' : 'OK       '} ${label}`);
  for (const e of r.errors) console.log(`  error:   ${e}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
}

if (seriesErrors.length) {
  console.log('\nFAIL     the series does not chain together:');
  for (const e of seriesErrors) console.log(`  error:   ${e}`);
}

if (failed || seriesErrors.length) {
  const parts = [];
  if (failed) parts.push(`${failed} walkthrough(s) with errors`);
  if (seriesErrors.length) parts.push(`${seriesErrors.length} break(s) in the chain`);
  console.log(`\n${parts.join(', ')}.`);
  process.exit(1);
}
console.log(`\n${reports.length} walkthrough(s) OK, chained end to end.`);
