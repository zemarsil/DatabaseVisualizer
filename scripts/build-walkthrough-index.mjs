#!/usr/bin/env node
/**
 * Rewrites the table of contents in docs/walkthroughs/README.md from the front
 * matter of the walkthroughs themselves, so the index can never drift from the
 * files it lists.
 *
 *   node scripts/build-walkthrough-index.mjs           # write it
 *   node scripts/build-walkthrough-index.mjs --check   # fail if it is stale
 *
 * Only the block between the generated markers is touched; the prose around it
 * is yours to edit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listWalkthroughFiles, parseFrontMatter, WALKTHROUGH_DIR } from './walkthrough-lib.mjs';

const README = join(WALKTHROUGH_DIR, 'README.md');
const START = '<!-- generated: walkthrough index, run `node scripts/build-walkthrough-index.mjs` -->';
const END = '<!-- /generated -->';

const rows = listWalkthroughFiles().map((file) => {
  const { meta } = parseFrontMatter(readFileSync(file, 'utf8'));
  const name = basename(file);
  return {
    number: name.slice(0, 2),
    name,
    title: meta.title ?? name,
    level: meta.level ?? '?',
    minutes: meta.minutes ?? '?',
    summary: meta.summary ?? '',
    diagram: typeof meta.diagram === 'string' ? meta.diagram : null,
  };
});

const table = [
  '| # | Walkthrough | Level | Time | What you end up with |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.number} | [${r.title}](${r.name}) | ${r.level} | ${r.minutes} min | ${r.summary} |`),
].join('\n');

// One diagram per stage of the build, not one per walkthrough: a walkthrough
// that reads the canvas without changing it (Simulate, Export) points at the
// previous one's file, so list each file once, under the walkthrough that
// produced it.
const seen = new Set();
const stages = [];
for (const r of rows) {
  if (!r.diagram || seen.has(r.diagram)) continue;
  seen.add(r.diagram);
  stages.push(`- [\`${r.diagram}\`](${r.diagram}) — the canvas at the end of ${r.number} ${r.title}`);
}
const diagrams = stages.length
  ? [
      '',
      'The series builds one schema, so its diagrams are the stages of that build.',
      'Open any of them with **File → Open** (`Ctrl+O`), or by dropping the file on',
      'the canvas — or press **Set up the canvas** inside a walkthrough, which loads',
      'the stage it starts from for you:',
      '',
      ...stages,
    ].join('\n')
  : '';

const block = `${START}\n\n${table}\n${diagrams}\n\n${END}`;

const current = readFileSync(README, 'utf8');
const startAt = current.indexOf(START);
const endAt = current.indexOf(END);
if (startAt === -1 || endAt === -1) {
  console.error(`${README} is missing the generated markers:\n  ${START}\n  ${END}`);
  process.exit(1);
}
const next = current.slice(0, startAt) + block + current.slice(endAt + END.length);

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error(`${README} is out of date. Run: node scripts/build-walkthrough-index.mjs`);
    process.exit(1);
  }
  console.log(`OK  ${README} lists all ${rows.length} walkthrough(s).`);
} else {
  writeFileSync(README, next);
  console.log(`Wrote ${README} with ${rows.length} walkthrough(s).`);
}
