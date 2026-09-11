import { describeRelationship, dialectLabel, programLanguageMeta, programRoleMeta, type Diagram, type Relationship, type Table } from '@shared/types';
import { derivationSummaries } from './derivation';
import { buildLineage, type Lineage } from './lineage';
import { exportMermaid } from './export/mermaid';
import { describeProgram, programsForTable } from './programs';

/**
 * Cell text is data, not markup. A CHECK expression like `qty * 2 * 3` or a
 * comment holding a backtick has to survive a Markdown renderer and the HTML
 * mirror alike, so the characters that would turn into emphasis or a code span
 * are escaped. Underscores are left alone: neither GFM nor markdownToHtml reads
 * one inside a word as emphasis, and escaping them would litter every column name.
 */
function esc(v: string): string {
  return v
    .replace(/([\\*`])/g, '\\$1')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)];
  return lines.join('\n');
}

function anchor(t: Table): string {
  return (t.schema ? `${t.schema}${t.name}` : t.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function tableSection(d: Diagram, t: Table, rels: Relationship[], level: number, lineage: Lineage): string {
  const parts: string[] = [];
  const heading = t.schema ? `${t.schema}.${t.name}` : t.name;
  parts.push(`${'#'.repeat(level)} ${heading}${t.kind === 'view' ? (t.materialized ? ' _(materialized view)_' : ' _(view)_') : ''}`);
  const group = d.groups.find((g) => g.id === t.groupId);
  if (group?.external) parts.push(`\n_Lives in another database (${esc(group.name)}); documented here, not created by the script._`);
  if (t.comment) parts.push(`\n${t.comment}`);
  if (t.kind === 'view' && t.viewSql?.trim()) parts.push(`\n\`\`\`sql\n${t.viewSql.trim()}\n\`\`\``);

  const outgoingFks = new Map<string, Relationship>();
  for (const r of rels) {
    if (r.kind !== 'fk' || r.sourceTableId !== t.id) continue;
    for (const cid of r.sourceColumnIds) outgoingFks.set(cid, r);
  }

  const colRows = t.columns.map((c) => {
    const keys: string[] = [];
    if (c.primaryKey) keys.push('PK');
    if (c.unique) keys.push('UNIQUE');
    if (c.autoIncrement) keys.push('AUTO');
    if (outgoingFks.has(c.id)) keys.push('FK');
    // A reader of the dictionary needs to know a value is computed before they
    // plan to insert it; the formula itself follows under the table.
    if (lineage.filledBy.has(c.id)) keys.push('DERIVED');
    return [c.name, c.type, c.nullable ? 'yes' : 'no', c.defaultValue ?? '', keys.join(', '), c.check ? `CHECK (${c.check})` : '', c.comment ?? ''];
  });
  const colTable = mdTable(['Column', 'Type', 'Nullable', 'Default', 'Key', 'Check', 'Comment'], colRows);
  if (colTable) parts.push(`\n${colTable}`);

  if (t.indexes.length) {
    const idxRows = t.indexes.map((i) => {
      const colNames = i.columnIds.map((cid) => t.columns.find((c) => c.id === cid)?.name ?? cid).join(', ');
      return [i.name || '(unnamed)', colNames, i.unique ? 'yes' : 'no'];
    });
    parts.push(`\n**Indexes**\n\n${mdTable(['Name', 'Columns', 'Unique'], idxRows)}`);
  }

  if (t.checks.length) {
    parts.push(`\n**Table checks**\n\n${t.checks.map((c) => `- \`${c}\``).join('\n')}`);
  }

  const derivedRows = t.columns.flatMap((c) =>
    (lineage.filledBy.get(c.id) ?? []).map((e) => [c.name, e.summary, d.tables.find((x) => x.id === e.sourceTableId)?.name ?? '?']),
  );
  if (derivedRows.length) {
    parts.push(`\n**Derived columns**\n\n${mdTable(['Column', 'Computed as', 'From'], derivedRows)}`);
  }

  const touchedBy = programsForTable(d, t.id);
  if (touchedBy.length) {
    const rows = touchedBy.map((p) => {
      const ops = [...new Set(p.steps.filter((s) => s.tableId === t.id).map((s) => s.op))];
      return [p.name, programLanguageMeta(p.language).label, ops.join(' and ')];
    });
    parts.push(`\n**Touched from outside the database**\n\n${mdTable(['Program', 'Language', 'Does'], rows)}`);
  }

  const referencedBy = rels.filter((r) => r.kind === 'fk' && r.targetTableId === t.id && r.sourceTableId !== t.id);
  if (referencedBy.length) {
    const names = [...new Set(referencedBy.map((r) => d.tables.find((x) => x.id === r.sourceTableId)?.name ?? r.sourceTableId))];
    parts.push(`\n**Referenced by** ${names.map((n) => `[${esc(n)}](#${anchor(d.tables.find((x) => x.name === n) ?? t)})`).join(', ')}`);
  }

  return parts.join('\n');
}

function summarySection(d: Diagram, includeMermaid: boolean): string {
  const tables = d.tables.filter((t) => t.kind !== 'view');
  const views = d.tables.filter((t) => t.kind === 'view');
  const columns = d.tables.reduce((n, t) => n + t.columns.length, 0);
  const fks = d.relationships.filter((r) => r.kind === 'fk').length;
  const facts = [
    `${dialectLabel(d.dialect)}`,
    `${tables.length} table${tables.length === 1 ? '' : 's'}`,
    views.length ? `${views.length} view${views.length === 1 ? '' : 's'}` : '',
    `${columns} column${columns === 1 ? '' : 's'}`,
    `${fks} foreign key${fks === 1 ? '' : 's'}`,
    d.customTypes.length ? `${d.customTypes.length} custom type${d.customTypes.length === 1 ? '' : 's'}` : '',
    d.groups.length ? `${d.groups.length} group${d.groups.length === 1 ? '' : 's'}` : '',
    d.programs.length ? `${d.programs.length} program${d.programs.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const parts = [facts.join(' · ')];
  if (includeMermaid) parts.push(`\`\`\`mermaid\n${exportMermaid(d, { includeComments: false }).trimEnd()}\n\`\`\``);
  const toc = d.tables.map(
    (t) => `- [${esc(t.schema ? `${t.schema}.${t.name}` : t.name)}](#${anchor(t)})${t.kind === 'view' ? (t.materialized ? ' (materialized view)' : ' (view)') : ''}`,
  );
  if (toc.length) parts.push(toc.join('\n'));
  return parts.join('\n\n');
}

function customTypesSection(d: Diagram): string {
  if (d.customTypes.length === 0) return '';
  const rows = d.customTypes.map((ct) => [ct.name, ct.kind, ct.kind === 'enum' ? (ct.values ?? []).join(', ') : (ct.fields ?? []).map((f) => `${f.name} ${f.type}`).join(', '), ct.comment ?? '']);
  return `## Custom types\n\n${mdTable(['Name', 'Kind', 'Values / fields', 'Comment'], rows)}`;
}

function groupsSection(d: Diagram): string {
  if (d.groups.length === 0) return '';
  const rows = d.groups.map((g) => [g.name, d.tables.filter((t) => t.groupId === g.id).map((t) => t.name).join(', '), g.external ? 'another database' : 'this schema', g.note ?? '']);
  return `## Groups\n\n${mdTable(['Group', 'Tables', 'Where', 'Note'], rows)}`;
}

/**
 * The programs, one subsection each: what it is, the ordered steps, and the
 * code the steps carry. The generated starter is deliberately left out — it is
 * derived, sometimes long, and a data dictionary should hold what somebody
 * wrote rather than what the app can write again on demand.
 */
function programsSection(d: Diagram): string {
  if (d.programs.length === 0) return '';
  const byId = new Map(d.tables.map((t) => [t.id, t]));
  const parts: string[] = ['## Programs', '', 'Work that happens outside the database, and what it reads and writes.'];

  for (const p of d.programs) {
    const lang = programLanguageMeta(p.language);
    const facts = [lang.label, p.role ? programRoleMeta(p.role).label : '', p.entrypoint ? `\`${esc(p.entrypoint)}\`` : ''].filter(Boolean);
    parts.push(`\n### ${esc(p.name)}\n`);
    parts.push(facts.join(' · '));
    if (p.comment?.trim()) parts.push(`\n${esc(p.comment.trim())}`);
    parts.push(`\n${esc(describeProgram(d, p))}`);

    const rows = p.steps.map((s, i) => {
      const table = s.tableId ? byId.get(s.tableId) : undefined;
      const cols = s.columnIds.map((id) => table?.columns.find((c) => c.name && c.id === id)?.name ?? '').filter(Boolean);
      return [
        String(i + 1),
        s.op,
        s.op === 'compute' ? '' : (table?.name ?? '(missing)'),
        cols.join(', '),
        s.note ?? '',
      ];
    });
    if (rows.length) parts.push(`\n${mdTable(['#', 'Does', 'Table', 'Columns', 'Note'], rows)}`);

    for (const [i, s] of p.steps.entries()) {
      if (s.sql?.trim()) parts.push(`\n**Step ${i + 1} statement**\n\n\`\`\`sql\n${s.sql.trim()}\n\`\`\``);
      if (s.code?.trim()) parts.push(`\n**Step ${i + 1} code**\n\n\`\`\`${lang.extension}\n${s.code.trim()}\n\`\`\``);
    }
  }
  return parts.join('\n');
}

function relationshipsSection(d: Diagram): string {
  if (d.relationships.length === 0) return '';
  const byId = new Map(d.tables.map((t) => [t.id, t]));
  const colNames = (table: Table | undefined, ids: string[]) => ids.map((id) => table?.columns.find((c) => c.id === id)?.name ?? id).join(', ');

  const rows = d.relationships.map((r) => {
    const source = byId.get(r.sourceTableId);
    const target = byId.get(r.targetTableId);
    return [
      source?.name ?? r.sourceTableId,
      colNames(source, r.sourceColumnIds),
      target?.name ?? r.targetTableId,
      colNames(target, r.targetColumnIds),
      r.kind === 'fk' ? 'FK' : r.kind,
      r.name ?? '',
      r.kind === 'fk' ? (r.onDelete ?? '') : '',
      r.kind === 'fk' ? (r.onUpdate ?? '') : '',
      r.note ?? '',
    ];
  });

  const parts = [`## Relationships`, `\n${mdTable(['From table', 'From columns', 'To table', 'To columns', 'Kind', 'Name', 'On delete', 'On update', 'Note'], rows)}`];

  const documented = d.relationships.filter((r) => r.kind !== 'fk');
  if (documented.length) {
    parts.push('\n### How the connections read');
    parts.push(documented.map((r) => `- ${esc(describeRelationship(r, byId.get(r.sourceTableId)?.name ?? '?', byId.get(r.targetTableId)?.name ?? '?'))}${r.name ? ` (${esc(r.name)})` : ''}`).join('\n'));
  }

  const withQuery = d.relationships.filter((r) => r.query || derivationSummaries(r, byId.get(r.targetTableId)).length);
  if (withQuery.length) {
    parts.push('\n### Relationship queries');
    for (const r of withQuery) {
      const source = byId.get(r.sourceTableId);
      const target = byId.get(r.targetTableId);
      const label = r.name || `${source?.name ?? r.sourceTableId} → ${target?.name ?? r.targetTableId}`;
      const summaries = derivationSummaries(r, target);
      if (summaries.length) parts.push(`\n**${esc(label)}** derives:\n\n${summaries.map((s) => `- \`${s}\``).join('\n')}`);
      if (r.query) parts.push(`\n**${esc(label)}**\n\n\`\`\`sql\n${r.query}\n\`\`\``);
    }
  }

  return parts.join('\n');
}

export interface MarkdownOptions {
  /** Include the ```mermaid ER diagram in the summary. Default true; ignored in fragment mode. */
  includeMermaid?: boolean;
  /**
   * Fragment mode: no `# title`, no summary or table of contents, no `## Tables`
   * heading, and one heading level less throughout. For pasting a few tables
   * into a document that already has its own structure.
   */
  fragment?: boolean;
}

/** Render a diagram's tables (and the connections between them) as GitHub-flavored Markdown. */
export function generateMarkdown(d: Diagram, opts: MarkdownOptions = {}): string {
  const fragment = opts.fragment ?? false;
  const parts: string[] = fragment ? [] : [`# ${d.name}`];

  if (d.tables.length) {
    if (!fragment) {
      parts.push(summarySection(d, opts.includeMermaid ?? true));
      parts.push('## Tables');
    }
    // One scan of the data flows for the whole document rather than one per table.
    const lineage = buildLineage(d);
    for (const t of d.tables) parts.push(tableSection(d, t, d.relationships, fragment ? 2 : 3, lineage));
  }

  const types = customTypesSection(d);
  if (types) parts.push(types);
  const groups = groupsSection(d);
  if (groups) parts.push(groups);

  const rels = relationshipsSection(d);
  if (rels) parts.push(rels);

  const progs = programsSection(d);
  if (progs) parts.push(progs);

  return parts.join('\n\n') + '\n';
}
