/**
 * Mermaid `erDiagram` export. GitHub, GitLab, Notion and mermaid.live render
 * it, so this is the quickest way to put a schema into a README.
 */
import { codeKindMeta, codeKindOf, describeRelationship, isCodeStepOp, programLanguageMeta, type Diagram, type Program, type Table } from '@shared/types';
import { codeLinks, codePath } from '../codemap';
import { externalTableIds } from '../groups';
import { foreignKeyColumnIds } from '../model';
import { programLinks } from '../programs';
import { pkColumnIds, relationshipCardinality } from '../schemaInfo';

export interface MermaidOptions {
  /** Column comments as quoted trailing text (default true). */
  includeComments?: boolean;
  /** Data flows, serialized copies and dependencies as dotted links (default true). */
  includeDocumentation?: boolean;
  /**
   * Programs as entities of their own, with one link per step (default true,
   * and ignored when includeDocumentation is off). Mermaid has no node type for
   * "not a table", so they are entities carrying a `%% program:` marker, the
   * same way a view and an external table are already marked.
   */
  includePrograms?: boolean;
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

/**
 * Program entity names live in the same namespace as the tables', because
 * Mermaid has one namespace; a program called "orders" therefore gets a suffix
 * rather than silently merging with the table.
 */
function programNames(d: Diagram, taken: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of d.programs) {
    const base = mermaidName(p.name);
    let name = base;
    let i = 2;
    while (taken.has(name)) name = `${base}_${i++}`;
    taken.add(name);
    out.set(p.id, name);
  }
  return out;
}

function programBlock(d: Diagram, p: Program, name: string): string[] {
  const byId = new Map(d.tables.map((t) => [t.id, t]));
  const codeById = new Map(d.programs.map((x) => [x.id, x]));
  const kind = codeKindOf(p);
  // Marked the way a view and an external table are: with a comment naming
  // what it is and where it sits, since an erDiagram entity has no kind.
  const where = p.parentId && codeById.get(p.parentId) ? ` in ${codePath(d, codeById.get(p.parentId)!, codeById)}` : '';
  const lines = [`    %% ${kind}: ${p.name} (${programLanguageMeta(p.language).label})${where}`, `    ${name} {`];
  for (const s of p.steps) {
    const what =
      s.op === 'compute'
        ? mermaidName(s.note || 'outside_the_database')
        : isCodeStepOp(s.op)
          ? mermaidName(codeById.get(s.codeId ?? '')?.name ?? 'missing_code')
          : mermaidName(byId.get(s.tableId ?? '')?.name ?? 'missing_table');
    lines.push(`        ${s.op} ${what}`);
  }
  // An attribute is one type and one name, so a two-word kind ("data file")
  // has to arrive as one word or the entity does not parse.
  if (p.steps.length === 0) lines.push(`        ${mermaidName(codeKindMeta(kind).label.toLowerCase())} ${kind === 'data' ? 'values' : 'empty'}`);
  lines.push('    }');
  return lines;
}

export function exportMermaid(d: Diagram, options: MermaidOptions = {}): string {
  const opts: Required<MermaidOptions> = {
    includeComments: options.includeComments ?? true,
    includeDocumentation: options.includeDocumentation ?? true,
    includePrograms: options.includePrograms ?? true,
  };
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
  if (opts.includeDocumentation && opts.includePrograms && d.programs.length) {
    const taken = new Set(names.values());
    const pNames = programNames(d, taken);
    for (const p of d.programs) lines.push(...programBlock(d, p, pNames.get(p.id)!));
    for (const link of programLinks(d)) {
      const from = pNames.get(link.programId);
      const to = names.get(link.tableId);
      if (!from || !to) continue;
      // Drawn as the program touching many rows of the table, which is the only
      // cardinality Mermaid has that is not a lie about a program.
      lines.push(`    ${from} ||..o{ ${to} : ${quoted(`${link.step} ${link.op}`)}`);
    }
    // Containment is a comment on the member, above; a call, an import or an
    // extends is a link, one to one, since neither end is a table of rows.
    for (const link of codeLinks(d)) {
      const from = pNames.get(link.fromId);
      const to = pNames.get(link.toId);
      if (!from || !to) continue;
      lines.push(`    ${from} ||..|| ${to} : ${quoted(`${link.step} ${link.op}`)}`);
    }
  }
  return lines.join('\n') + '\n';
}
