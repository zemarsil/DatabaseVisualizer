/**
 * DBML export (dbdiagram.io / dbdocs). Tables, custom types, groups, refs and
 * documentation-only connections as notes.
 */
import { codeKindMeta, codeKindOf, describeRelationship, dialectLabel, programLanguageMeta, type Diagram, type Table } from '@shared/types';
import { codePath } from '../codemap';
import { fileSlug } from '../io';
import { describeProgram, describeStep } from '../programs';

function ident(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `"${name.replace(/"/g, '')}"`;
}

function str(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function note(text: string): string {
  return text.includes('\n') ? `'''\n${text.replace(/'''/g, "''")}\n'''` : str(text);
}

function tableRef(t: Table): string {
  return t.schema ? `${ident(t.schema)}.${ident(t.name)}` : ident(t.name);
}

function defaultLiteral(v: string): string {
  const s = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(true|false|null)$/i.test(s)) return s.toLowerCase();
  const m = /^'(.*)'$/.exec(s);
  if (m) return str(m[1].replace(/''/g, "'"));
  return `\`${s.replace(/`/g, "'")}\``;
}

function tableBlock(t: Table): string {
  const lines: string[] = [];
  const isView = t.kind === 'view';
  const noteParts: string[] = [];
  if (t.comment?.trim()) noteParts.push(t.comment.trim());
  if (isView) noteParts.push(`VIEW\n${t.viewSql?.trim() ?? ''}`);
  if (t.checks.length) noteParts.push(`CHECK: ${t.checks.join('; ')}`);
  const header = `Table ${tableRef(t)}${noteParts.length ? ` [note: ${note(noteParts.join('\n\n'))}]` : ''} {`;
  if (isView) lines.push(`// view`);
  lines.push(header);
  for (const c of t.columns) {
    const settings: string[] = [];
    if (c.primaryKey && t.columns.filter((x) => x.primaryKey).length === 1) settings.push('pk');
    if (c.autoIncrement) settings.push('increment');
    if (!c.nullable && !c.primaryKey) settings.push('not null');
    if (c.unique && !c.primaryKey) settings.push('unique');
    if (c.defaultValue?.trim()) settings.push(`default: ${defaultLiteral(c.defaultValue)}`);
    const colNote = [c.comment?.trim(), c.check?.trim() ? `CHECK (${c.check.trim()})` : ''].filter(Boolean).join(' · ');
    if (colNote) settings.push(`note: ${str(colNote)}`);
    lines.push(`  ${ident(c.name)} ${c.type.trim() || 'text'}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
  }
  const pk = t.columns.filter((c) => c.primaryKey);
  const indexLines: string[] = [];
  if (pk.length > 1) indexLines.push(`    (${pk.map((c) => ident(c.name)).join(', ')}) [pk]`);
  for (const ix of t.indexes) {
    const cols = ix.columnIds.map((id) => t.columns.find((c) => c.id === id)?.name).filter((x): x is string => Boolean(x));
    if (!cols.length) continue;
    const settings = [ix.unique ? 'unique' : '', ix.name.trim() ? `name: ${str(ix.name.trim())}` : ''].filter(Boolean);
    indexLines.push(`    (${cols.map(ident).join(', ')})${settings.length ? ` [${settings.join(', ')}]` : ''}`);
  }
  if (indexLines.length) lines.push('', '  indexes {', ...indexLines, '  }');
  lines.push('}');
  return lines.join('\n');
}

export function exportDbml(d: Diagram): string {
  const parts: string[] = [];
  const projectNote = [`Exported from Database Visualizer (${dialectLabel(d.dialect)}).`, d.tables.some((t) => t.kind === 'view') ? 'Views appear as tables whose note carries the SELECT.' : '']
    .filter(Boolean)
    .join(' ');
  parts.push(`Project ${ident(fileSlug(d.name).replace(/-/g, '_'))} {\n  database_type: ${str(dialectLabel(d.dialect).replace(' (in browser)', ''))}\n  Note: ${str(projectNote)}\n}`);

  for (const ct of d.customTypes) {
    if (ct.kind === 'enum') {
      const values = (ct.values ?? []).filter((v) => v.trim()).map((v) => `  ${ident(v)}`);
      parts.push(`Enum ${ident(ct.name)} {\n${values.join('\n')}\n}`);
    } else {
      const fields = (ct.fields ?? []).map((f) => `${f.name} ${f.type}`).join(', ');
      parts.push(`Note ${ident(`type_${ct.name}`)} {\n  ${str(`Composite type ${ct.name} (${fields})`)}\n}`);
    }
  }

  for (const t of d.tables) parts.push(tableBlock(t));

  for (const g of d.groups) {
    const members = d.tables.filter((t) => t.groupId === g.id);
    if (!members.length) continue;
    const lines = [`TableGroup ${ident(g.name)} {`, ...members.map((t) => `  ${tableRef(t)}`)];
    if (g.external || g.note) lines.push(`  Note: ${str([g.external ? 'Lives in another database; not created by the schema script.' : '', g.note ?? ''].filter(Boolean).join(' '))}`);
    lines.push('}');
    parts.push(lines.join('\n'));
  }

  const byId = new Map(d.tables.map((t) => [t.id, t]));
  let n = 0;
  for (const r of d.relationships) {
    const src = byId.get(r.sourceTableId);
    const tgt = byId.get(r.targetTableId);
    if (!src || !tgt) continue;
    if (r.kind === 'fk') {
      const sc = r.sourceColumnIds.map((id) => src.columns.find((c) => c.id === id)?.name).filter((x): x is string => Boolean(x));
      const tc = r.targetColumnIds.map((id) => tgt.columns.find((c) => c.id === id)?.name).filter((x): x is string => Boolean(x));
      if (!sc.length || sc.length !== tc.length) continue;
      const left = sc.length === 1 ? `${tableRef(src)}.${ident(sc[0])}` : `${tableRef(src)}.(${sc.map(ident).join(', ')})`;
      const right = tc.length === 1 ? `${tableRef(tgt)}.${ident(tc[0])}` : `${tableRef(tgt)}.(${tc.map(ident).join(', ')})`;
      const settings: string[] = [];
      if (r.onDelete && r.onDelete !== 'NO ACTION') settings.push(`delete: ${r.onDelete.toLowerCase()}`);
      if (r.onUpdate && r.onUpdate !== 'NO ACTION') settings.push(`update: ${r.onUpdate.toLowerCase()}`);
      parts.push(`Ref${r.name?.trim() ? ` ${ident(r.name.trim())}` : ''}: ${left} > ${right}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    } else {
      n++;
      const body = [describeRelationship(r, src.name, tgt.name), r.note?.trim() ?? '', r.query?.trim() ?? ''].filter(Boolean).join('\n\n');
      parts.push(`Note ${ident(`link_${n}_${r.kind}`)} {\n  ${note(body)}\n}`);
    }
  }
  // DBML has tables and nothing else, so a program becomes a Note rather than
  // being dropped: dbdiagram will not draw it, but the steps and the reasoning
  // survive the trip instead of vanishing on export.
  const tableById = new Map(d.tables.map((t) => [t.id, t]));
  const codeById = new Map(d.programs.map((p) => [p.id, p]));
  for (const prg of d.programs) {
    const kind = codeKindOf(prg);
    const body = [
      describeProgram(d, prg),
      `${codeKindMeta(kind).label} written in ${programLanguageMeta(prg.language).label}${prg.parentId && codeById.get(prg.parentId) ? `, inside ${codePath(d, codeById.get(prg.parentId)!, codeById)}` : ''}${prg.entrypoint?.trim() ? `, in ${prg.entrypoint.trim()}` : ''}.`,
      prg.comment?.trim() ?? '',
      prg.steps.map((s, i) => `${i + 1}. ${describeStep(s, s.tableId ? tableById.get(s.tableId) : undefined, s.codeId ? codeById.get(s.codeId) : undefined)}`).join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');
    parts.push(`Note ${ident(`${kind}_${fileSlug(codePath(d, prg, codeById)).replace(/-/g, '_')}`)} {\n  ${note(body)}\n}`);
  }

  return parts.join('\n\n') + '\n';
}
