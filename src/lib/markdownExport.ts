import { describeRelationship, dialectLabel, type Diagram, type Relationship, type Table } from '@shared/types';
import { derivationSummaries } from './derivation';
import { exportMermaid } from './export/mermaid';

function esc(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)];
  return lines.join('\n');
}

function anchor(t: Table): string {
  return (t.schema ? `${t.schema}${t.name}` : t.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function tableSection(d: Diagram, t: Table, rels: Relationship[]): string {
  const parts: string[] = [];
  const heading = t.schema ? `${t.schema}.${t.name}` : t.name;
  parts.push(`### ${heading}${t.kind === 'view' ? ' _(view)_' : ''}`);
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
  ].filter(Boolean);
  const parts = [facts.join(' · ')];
  if (includeMermaid) parts.push(`\`\`\`mermaid\n${exportMermaid(d, { includeComments: false }).trimEnd()}\n\`\`\``);
  const toc = d.tables.map((t) => `- [${esc(t.schema ? `${t.schema}.${t.name}` : t.name)}](#${anchor(t)})${t.kind === 'view' ? ' (view)' : ''}`);
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

/** Render a diagram's tables (and the connections between them) as GitHub-flavored Markdown. */
export function generateMarkdown(d: Diagram, opts: { includeMermaid?: boolean } = {}): string {
  const parts: string[] = [`# ${d.name}`];

  if (d.tables.length) {
    parts.push(summarySection(d, opts.includeMermaid ?? true));
    parts.push('## Tables');
    for (const t of d.tables) parts.push(tableSection(d, t, d.relationships));
  }

  const types = customTypesSection(d);
  if (types) parts.push(types);
  const groups = groupsSection(d);
  if (groups) parts.push(groups);

  const rels = relationshipsSection(d);
  if (rels) parts.push(rels);

  return parts.join('\n\n') + '\n';
}
