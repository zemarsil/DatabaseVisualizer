/**
 * The fifteen walkthroughs in docs/walkthroughs/, bundled for the in-app
 * browser (Help -> Walkthroughs). Front matter uses the same deliberately
 * tiny subset of YAML as scripts/walkthrough-lib.mjs; this is a second,
 * browser-side implementation because that script runs under Node, not Vite.
 */
import type { Dialect } from '@shared/types';

export interface WalkthroughMeta {
  slug: string;
  title: string;
  summary: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  minutes: number;
  dialect: Dialect;
  covers: string[];
  prerequisites: string[];
  next: string[];
}

export interface Walkthrough extends WalkthroughMeta {
  /** Markdown body, front matter stripped. */
  body: string;
  /** The companion diagram's raw .dbviz.json text, if this walkthrough ships one. */
  diagramJson?: string;
}

const mdFiles = import.meta.glob('/docs/walkthroughs/[0-9][0-9]-*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const diagramFiles = import.meta.glob('/docs/walkthroughs/diagrams/*.dbviz.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const lines = text.split('\n');
  const meta: Record<string, string | string[]> = {};
  let i = 1;
  let currentList: string[] | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    if (line.trim() === '') continue;
    const item = /^ {2}- (.*)$/.exec(line);
    if (item) {
      currentList?.push(item[1].trim());
      continue;
    }
    const pair = /^([a-z][a-zA-Z]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (rawValue === undefined || rawValue.trim() === '') {
      currentList = [];
      meta[key] = currentList;
    } else {
      currentList = null;
      meta[key] = rawValue.trim();
    }
  }
  return { meta, body: lines.slice(i + 1).join('\n') };
}

function asStringList(v: string | string[] | undefined): string[] {
  return Array.isArray(v) ? v : [];
}

function build(): Walkthrough[] {
  return Object.keys(mdFiles)
    .sort()
    .map((path) => {
      const { meta, body } = parseFrontMatter(mdFiles[path]);
      const slug = typeof meta.slug === 'string' ? meta.slug : path.split('/').pop()!.replace(/\.md$/, '');
      const diagramRel = typeof meta.diagram === 'string' ? meta.diagram : undefined;
      return {
        slug,
        title: typeof meta.title === 'string' ? meta.title : slug,
        summary: typeof meta.summary === 'string' ? meta.summary : '',
        level: (typeof meta.level === 'string' ? meta.level : 'beginner') as WalkthroughMeta['level'],
        minutes: Number(meta.minutes) || 0,
        dialect: (typeof meta.dialect === 'string' ? meta.dialect : 'postgresql') as Dialect,
        covers: asStringList(meta.covers),
        prerequisites: asStringList(meta.prerequisites),
        next: asStringList(meta.next),
        body,
        diagramJson: diagramRel ? diagramFiles[`/docs/walkthroughs/${diagramRel}`] : undefined,
      };
    });
}

export const WALKTHROUGHS: Walkthrough[] = build();

export function getWalkthrough(slug: string): Walkthrough | undefined {
  return WALKTHROUGHS.find((w) => w.slug === slug);
}
