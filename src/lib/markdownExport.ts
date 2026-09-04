import type { Diagram, Relationship, Table } from '@shared/types';

function esc(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)];
  return lines.join('\n');
}

function tableSection(t: Table, rels: Relationship[]): string {
  const parts: string[] = [];
  const heading = t.schema ? `${t.schema}.${t.name}` : t.name;
  parts.push(`### ${heading}`);
  if (t.comment) parts.push(`\n${t.comment}`);

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
      r.kind === 'fk' ? 'FK' : 'flow',
      r.name ?? '',
      r.kind === 'fk' ? (r.onDelete ?? '') : '',
      r.kind === 'fk' ? (r.onUpdate ?? '') : '',
      r.note ?? '',
    ];
  });

  const parts = [`## Relationships`, `\n${mdTable(['From table', 'From columns', 'To table', 'To columns', 'Kind', 'Name', 'On delete', 'On update', 'Note'], rows)}`];

  const withQuery = d.relationships.filter((r) => r.query);
  if (withQuery.length) {
    parts.push('\n### Relationship queries');
    for (const r of withQuery) {
      const source = byId.get(r.sourceTableId);
      const target = byId.get(r.targetTableId);
      const label = r.name || `${source?.name ?? r.sourceTableId} → ${target?.name ?? r.targetTableId}`;
      parts.push(`\n**${esc(label)}**\n\n\`\`\`sql\n${r.query}\n\`\`\``);
    }
  }

  return parts.join('\n');
}

/** Render a diagram's tables (and the connections between them) as GitHub-flavored Markdown. */
export function generateMarkdown(d: Diagram): string {
  const parts: string[] = [`# ${d.name}`];

  if (d.tables.length) {
    parts.push('## Tables');
    for (const t of d.tables) parts.push(tableSection(t, d.relationships));
  }

  const rels = relationshipsSection(d);
  if (rels) parts.push(rels);

  return parts.join('\n\n') + '\n';
}
