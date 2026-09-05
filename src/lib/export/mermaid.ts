/**
 * Mermaid `erDiagram` export. GitHub, GitLab, Notion and mermaid.live render
 * it, so this is the quickest way to put a schema into a README.
 */
import { describeRelationship, type Diagram, type Table } from '@shared/types';
import { externalTableIds } from '../groups';
import { foreignKeyColumnIds } from '../model';
import { pkColumnIds, relationshipCardinality } from '../schemaInfo';

export interface MermaidOptions {
  /** Column comments as quoted trailing text (default true). */
  includeComments?: boolean;
  /** Data flows, serialized copies and dependencies as dotted links (default true). */
  includeDocumentation?: boolean;
}

/** Mermaid entity names allow letters, digits and underscores only. */
export function mermaidName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'unnamed';
}

/** Attribute types allow letters, digits, underscore, parentheses and brackets. */
export function mermaidType(raw: string): string {
  const t = raw.trim().replace(/\s+/g, '_').replace(/,/g, '_').replace(/[^A-Za-z0-9_()[\]]/g, '');
  return t || 'text';
}

function quoted(text: string): string {
  return `"${text.replace(/"/g, "'").replace(/\r?\n/g, ' ')}"`;
}

/** Stable, collision-free entity names for every table. */
export function entityNames(d: Diagram): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const t of [...d.tables].sort((a, b) => a.name.localeCompare(b.name))) {
    const base = mermaidName(t.schema ? `${t.schema}__${t.name}` : t.name);
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}_${i++}`;
    used.add(name);
    out.set(t.id, name);
  }
  return out;
}

function entityBlock(d: Diagram, t: Table, name: string, external: Set<string>, opts: Required<MermaidOptions>): string[] {
  const fks = foreignKeyColumnIds(d, t.id);
  const lines: string[] = [];
  if (t.kind === 'view') lines.push(`    %% view: ${t.name}`);
  if (external.has(t.id)) {
    const group = d.groups.find((g) => g.id === t.groupId);
    lines.push(`    %% external: ${group?.name ?? 'another database'}`);
  }
  lines.push(`    ${name} {`);
  for (const c of t.columns) {
    const keys: string[] = [];
    if (c.primaryKey) keys.push('PK');
    if (fks.has(c.id)) keys.push('FK');
    if (c.unique && !c.primaryKey) keys.push('UK');
    const parts = [`        ${mermaidType(c.type)} ${mermaidName(c.name)}`];
    if (keys.length) parts.push(keys.join(', '));
    if (opts.includeComments && c.comment?.trim()) parts.push(quoted(c.comment.trim()));
    lines.push(parts.join(' '));
  }
  lines.push('    }');
  return lines;
}

export function exportMermaid(d: Diagram, options: MermaidOptions = {}): string {
  const opts: Required<MermaidOptions> = { includeComments: options.includeComments ?? true, includeDocumentation: options.includeDocumentation ?? true };
  const names = entityNames(d);
  const external = externalTableIds(d);
  const byId = new Map(d.tables.map((t) => [t.id, t]));
  const lines: string[] = ['erDiagram'];

  for (const t of [...d.tables].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(...entityBlock(d, t, names.get(t.id)!, external, opts));
  }

  const rels = [...d.relationships].sort((a, b) => {
    const an = `${byId.get(a.sourceTableId)?.name ?? ''}${byId.get(a.targetTableId)?.name ?? ''}`;
    const bn = `${byId.get(b.sourceTableId)?.name ?? ''}${byId.get(b.targetTableId)?.name ?? ''}`;
    return an.localeCompare(bn) || a.id.localeCompare(b.id);
  });
  for (const r of rels) {
    const src = byId.get(r.sourceTableId);
    const tgt = byId.get(r.targetTableId);
    if (!src || !tgt) continue;
    const child = names.get(src.id)!;
    const parent = names.get(tgt.id)!;
    if (r.kind === 'fk') {
      const card = relationshipCardinality(d, r);
      if (!card) continue;
      const parentEnd = card.sourceOptional ? '|o' : '||';
      const childEnd = card.source === 'N' ? 'o{' : card.sourceOptional ? 'o|' : '||';
      const pk = new Set(pkColumnIds(src));
      const identifying = r.sourceColumnIds.length > 0 && r.sourceColumnIds.every((id) => pk.has(id));
      const link = identifying ? '--' : '..';
      const label = r.name?.trim() || r.sourceColumnIds.map((id) => src.columns.find((c) => c.id === id)?.name ?? '?').join(', ') || 'references';
      lines.push(`    ${parent} ${parentEnd}${link}${childEnd} ${child} : ${quoted(label)}`);
    } else if (opts.includeDocumentation) {
      const verb = describeRelationship(r, src.name, tgt.name).slice(src.name.length + 1, -(tgt.name.length + 1));
      lines.push(`    ${child} }o..o{ ${parent} : ${quoted(r.name?.trim() || verb || r.kind)}`);
    }
  }
  return lines.join('\n') + '\n';
}
