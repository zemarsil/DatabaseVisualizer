/**
 * Turning a canvas selection into text.
 *
 * Everything here works off a *slice*: a throwaway diagram holding the selected
 * tables and only the connections whose two ends are both in the selection, so
 * a copied fragment never names a table that did not come with it. What was
 * left out is reported alongside rather than silently dropped, and so are the
 * warnings the SQL generator raises about the slice.
 *
 * The renderings are what the clipboard offers a paste target: SQL for a
 * plain-text editor, Markdown for a note-taking app, the HTML mirror of that
 * Markdown for anything that converts rich text on paste, and the diagram
 * fragment itself for another canvas.
 */
import { describeRelationship, type Diagram, type Relationship } from '@shared/types';
import { encodeClipboard } from './clipboard';
import { generateMarkdown } from './markdownExport';
import { markdownToHtml } from './markdownToHtml';
import { customTypesUsedBy, emptyDiagram } from './model';
import { extensionsUsedBy } from './extensions/registry';
import { generateSchema } from './sql/generator';

export interface SelectionSlice {
  /** The selected tables and the connections that stayed entirely inside them. */
  diagram: Diagram;
  /** Connections with exactly one end in the selection. Reported, never emitted. */
  omitted: Relationship[];
}

/** Cut `tableIds` out of `d` as a diagram of its own, in the diagram's own table order. */
export function sliceSelection(d: Diagram, tableIds: string[]): SelectionSlice {
  const wanted = new Set(tableIds);
  const tables = d.tables.filter((t) => wanted.has(t.id));
  const kept = new Set(tables.map((t) => t.id));
  const inside = (r: Relationship) => kept.has(r.sourceTableId) && kept.has(r.targetTableId);
  const straddles = (r: Relationship) => kept.has(r.sourceTableId) !== kept.has(r.targetTableId);
  const groupIds = new Set(tables.map((t) => t.groupId).filter((id): id is string => Boolean(id)));
  return {
    diagram: {
      ...emptyDiagram(d.dialect, d.name),
      tables,
      relationships: d.relationships.filter(inside),
      groups: d.groups.filter((g) => groupIds.has(g.id)),
      customTypes: customTypesUsedBy(d, tables),
      extensions: extensionsUsedBy(d, tables),
    },
    omitted: d.relationships.filter(straddles),
  };
}

/** "orders references customers (customers is not part of this copy)" */
function describeOmitted(d: Diagram, r: Relationship, kept: Set<string>): string {
  const source = d.tables.find((t) => t.id === r.sourceTableId);
  const target = d.tables.find((t) => t.id === r.targetTableId);
  const outside = kept.has(r.sourceTableId) ? target : source;
  const sentence = describeRelationship(r, source?.name ?? '?', target?.name ?? '?');
  return `${sentence} (${outside?.name ?? 'the other table'} is not part of this copy)`;
}

/** A well-connected table can straddle a dozen edges; the note is a hint, not an inventory. */
const MAX_OMITTED_LINES = 8;

function omittedHeadline(n: number): string {
  return `${n} connection${n === 1 ? '' : 's'} to ${n === 1 ? 'a table' : 'tables'} outside this copy ${n === 1 ? 'was' : 'were'} left out`;
}

/**
 * One slice, rendered once. Copying builds every format at the same moment, so
 * the schema is generated a single time and shared rather than regenerated per
 * format inside the synchronous clipboard handler.
 */
interface Rendered {
  slice: SelectionSlice;
  /** The DDL for the slice, without the trailing notes. */
  script: string;
  /** Connections that did not come along, capped and already worded. */
  omitted: string[];
  /** Everything else worth saying: what the generator had to change or skip. */
  warnings: string[];
}

function render(d: Diagram, tableIds: string[]): Rendered | null {
  const slice = sliceSelection(d, tableIds);
  if (slice.diagram.tables.length === 0) return null;
  const out = generateSchema(slice.diagram);
  const kept = new Set(slice.diagram.tables.map((t) => t.id));
  const omitted = slice.omitted.slice(0, MAX_OMITTED_LINES).map((r) => describeOmitted(d, r, kept));
  const rest = slice.omitted.length - omitted.length;
  if (rest > 0) omitted.push(`…and ${rest} more`);
  return { slice, script: out.script.trimEnd(), omitted, warnings: out.warnings };
}

/** The trailing `--` block: what was left out, and what the generator had to change. */
function sqlNotes(r: Rendered): string | null {
  const lines: string[] = [];
  if (r.omitted.length) {
    lines.push(`-- ${omittedHeadline(r.slice.omitted.length)}:`, ...r.omitted.map((line) => `--   ${line}`));
  }
  if (r.warnings.length) {
    lines.push('-- Worth knowing:', ...r.warnings.map((w) => `--   ${w}`));
  }
  if (!lines.length) return null;
  return ['-- ----------------------------------------------------------------', ...lines].join('\n');
}

/** The same two notes as Markdown, for the fragment and the HTML mirror. */
function markdownNotes(r: Rendered): string[] {
  const parts: string[] = [];
  if (r.omitted.length) parts.push(`_${omittedHeadline(r.slice.omitted.length)}:_\n\n${r.omitted.map((line) => `- ${line}`).join('\n')}`);
  if (r.warnings.length) parts.push(`_Worth knowing:_\n\n${r.warnings.map((w) => `- ${w}`).join('\n')}`);
  return parts;
}

export interface SelectionSql {
  text: string;
  warnings: string[];
}

/** The CREATE statements for the selected tables, with a blank line between them. */
export function selectionSql(d: Diagram, tableIds: string[]): SelectionSql {
  const rendered = render(d, tableIds);
  if (!rendered) return { text: '', warnings: [] };
  const notes = sqlNotes(rendered);
  return { text: [rendered.script, ...(notes ? [notes] : [])].join('\n\n') + '\n', warnings: rendered.warnings };
}

export interface SelectionMarkdownOptions {
  /** Append the DDL for the selection in a ```sql fence. */
  includeSql?: boolean;
}

function renderMarkdown(rendered: Rendered, opts: SelectionMarkdownOptions): string {
  const parts = [generateMarkdown(rendered.slice.diagram, { fragment: true, includeMermaid: false }).trimEnd(), ...markdownNotes(rendered)];
  if (opts.includeSql && rendered.script) parts.push(`## SQL\n\n\`\`\`sql\n${rendered.script}\n\`\`\``);
  return parts.join('\n\n') + '\n';
}

/** The selected tables as a Markdown fragment: one section per table, then the connections. */
export function selectionMarkdown(d: Diagram, tableIds: string[], opts: SelectionMarkdownOptions = {}): string {
  const rendered = render(d, tableIds);
  return rendered ? renderMarkdown(rendered, opts) : '';
}

/** The Markdown rendering as HTML, for paste targets that read `text/html`. */
export function selectionHtml(d: Diagram, tableIds: string[], opts: SelectionMarkdownOptions = {}): string {
  const rendered = render(d, tableIds);
  return rendered ? markdownToHtml(renderMarkdown(rendered, opts)) : '';
}

export interface ClipboardFlavors {
  /** The diagram fragment: full fidelity when pasted back onto a canvas. */
  json: string;
  /** What a plain-text target gets: the DDL for the copied tables. */
  text: string;
  /** What a rich-text target gets: the Markdown data dictionary, as HTML. */
  html: string;
  /** How many tables actually came along, for the toast. */
  tableCount: number;
}

/**
 * Every rendering of `tableIds` at once, or null when none of them is a table
 * in this diagram. One slice, one generated script, shared by all three — this
 * runs inside the synchronous `copy` handler.
 */
export function selectionFlavors(d: Diagram, tableIds: string[]): ClipboardFlavors | null {
  if (!tableIds.length) return null;
  const rendered = render(d, tableIds);
  if (!rendered) return null;
  const notes = sqlNotes(rendered);
  const markdown = renderMarkdown(rendered, { includeSql: true });
  return {
    json: encodeClipboard(d, tableIds),
    text: [rendered.script, ...(notes ? [notes] : [])].join('\n\n') + '\n',
    html: markdownToHtml(markdown),
    tableCount: rendered.slice.diagram.tables.length,
  };
}
