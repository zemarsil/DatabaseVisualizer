/**
 * Turning a canvas selection into text.
 *
 * Everything here works off a *slice*: a throwaway diagram holding the selected
 * tables and only the connections whose two ends are both in the selection, so
 * a copied fragment never names a table that did not come with it. What was
 * left out is reported alongside rather than silently dropped.
 *
 * The three renderings are what the clipboard offers a paste target:
 * SQL for a plain-text editor, Markdown for a note-taking app, and the HTML
 * mirror of that Markdown for anything that converts rich text on paste.
 */
import { describeRelationship, type Diagram, type Relationship } from '@shared/types';
import { generateMarkdown } from './markdownExport';
import { markdownToHtml } from './markdownToHtml';
import { customTypesUsedBy } from './model';
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
      version: 1,
      name: d.name,
      dialect: d.dialect,
      tables,
      relationships: d.relationships.filter(inside),
      notes: [],
      groups: d.groups.filter((g) => groupIds.has(g.id)),
      customTypes: customTypesUsedBy(d, tables),
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

function omittedLines(d: Diagram, slice: SelectionSlice): string[] {
  const kept = new Set(slice.diagram.tables.map((t) => t.id));
  const lines = slice.omitted.slice(0, MAX_OMITTED_LINES).map((r) => describeOmitted(d, r, kept));
  const rest = slice.omitted.length - lines.length;
  if (rest > 0) lines.push(`…and ${rest} more`);
  return lines;
}

function omittedHeadline(n: number): string {
  return `${n} connection${n === 1 ? '' : 's'} to ${n === 1 ? 'a table' : 'tables'} outside this copy ${n === 1 ? 'was' : 'were'} left out`;
}

export interface SelectionSql {
  text: string;
  warnings: string[];
}

/** The CREATE statements for the selected tables, with a blank line between them. */
export function selectionSql(d: Diagram, tableIds: string[]): SelectionSql {
  const slice = sliceSelection(d, tableIds);
  if (slice.diagram.tables.length === 0) return { text: '', warnings: [] };
  const out = generateSchema(slice.diagram);
  const parts = [out.script.trimEnd()];
  const dropped = omittedLines(d, slice);
  if (dropped.length) {
    parts.push(
      [
        '-- ----------------------------------------------------------------',
        `-- ${omittedHeadline(slice.omitted.length)}:`,
        ...dropped.map((line) => `--   ${line}`),
      ].join('\n'),
    );
  }
  return { text: parts.join('\n\n') + '\n', warnings: out.warnings };
}

export interface SelectionMarkdownOptions {
  /** Append the DDL for the selection in a ```sql fence. */
  includeSql?: boolean;
}

/** The selected tables as a Markdown fragment: one section per table, then the connections. */
export function selectionMarkdown(d: Diagram, tableIds: string[], opts: SelectionMarkdownOptions = {}): string {
  const slice = sliceSelection(d, tableIds);
  if (slice.diagram.tables.length === 0) return '';
  const parts = [generateMarkdown(slice.diagram, { fragment: true, includeMermaid: false }).trimEnd()];

  const dropped = omittedLines(d, slice);
  if (dropped.length) {
    parts.push(`_${omittedHeadline(slice.omitted.length)}:_\n\n${dropped.map((line) => `- ${line}`).join('\n')}`);
  }

  if (opts.includeSql) {
    const sql = generateSchema(slice.diagram).script.trim();
    if (sql) parts.push(`## SQL\n\n\`\`\`sql\n${sql}\n\`\`\``);
  }
  return parts.join('\n\n') + '\n';
}

/** The Markdown rendering as HTML, for paste targets that read `text/html`. */
export function selectionHtml(d: Diagram, tableIds: string[], opts: SelectionMarkdownOptions = {}): string {
  const md = selectionMarkdown(d, tableIds, opts);
  return md ? markdownToHtml(md) : '';
}
