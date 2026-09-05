/**
 * Foreign keys implied by naming conventions: a column called `customer_id`
 * next to a table called `customers` with a primary key `id` almost always
 * wants to reference it. Dumps written without constraints (MyISAM exports,
 * ORM-less student schemas) get their relationships back this way.
 */
import type { Column, Diagram, Table } from '@shared/types';
import { foreignKeyColumnIds } from './model';
import { isIntegerType } from './sql/dialect';

export interface FkSuggestion {
  id: string;
  sourceTableId: string;
  sourceColumnId: string;
  targetTableId: string;
  targetColumnId: string;
  confidence: 'high' | 'medium';
  reason: string;
}

const SUFFIXES = ['_id', '_uuid', '_key', '_code', '_pk'];

/** Candidate table-name bases for a column name, most specific first. */
export function baseNames(columnName: string): { base: string; suffix: string }[] {
  const name = columnName.trim();
  const lower = name.toLowerCase();
  const out: { base: string; suffix: string }[] = [];
  for (const suffix of SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) out.push({ base: lower.slice(0, -suffix.length), suffix: suffix.slice(1) });
  }
  const camel = /^(.+?)(Id|Uuid|Key|Code)$/.exec(name);
  if (camel && camel[1]) {
    out.push({ base: camel[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), suffix: camel[2].toLowerCase() });
  }
  if (lower.startsWith('id_') && lower.length > 3) out.push({ base: lower.slice(3), suffix: 'id' });
  return out;
}

/** Plural and singular spellings a table might use for a base word. */
export function nameVariants(base: string): string[] {
  const v = new Set<string>([base]);
  if (base.endsWith('y') && !/[aeiou]y$/.test(base)) v.add(`${base.slice(0, -1)}ies`);
  if (/(s|x|z|ch|sh)$/.test(base)) v.add(`${base}es`);
  v.add(`${base}s`);
  // the column may already be plural-ish ("categories_id" is rare, but "people_id" happens)
  if (base.endsWith('ies')) v.add(`${base.slice(0, -3)}y`);
  if (base.endsWith('es')) v.add(base.slice(0, -2));
  if (base.endsWith('s')) v.add(base.slice(0, -1));
  return [...v];
}

function tableKey(t: Table): string {
  return t.name.trim().toLowerCase();
}

function singlePk(t: Table): Column | undefined {
  const pk = t.columns.filter((c) => c.primaryKey);
  return pk.length === 1 ? pk[0] : undefined;
}

function typeFamily(c: Column): 'int' | 'text' | 'other' {
  if (isIntegerType(c.type)) return 'int';
  if (/^(varchar|char|text|uuid|character)/i.test(c.type.trim())) return 'text';
  return 'other';
}

export function suggestForeignKeys(d: Diagram): FkSuggestion[] {
  const byName = new Map<string, Table>();
  for (const t of d.tables) {
    byName.set(tableKey(t), t);
    const bare = t.name.includes('.') ? t.name.slice(t.name.lastIndexOf('.') + 1).toLowerCase() : null;
    if (bare && !byName.has(bare)) byName.set(bare, t);
  }
  const out: FkSuggestion[] = [];

  for (const src of d.tables) {
    if (src.kind === 'view') continue;
    const covered = foreignKeyColumnIds(d, src.id);
    const ownPk = singlePk(src);
    for (const col of src.columns) {
      if (covered.has(col.id)) continue;
      if (ownPk && ownPk.id === col.id) continue;
      const candidates = baseNames(col.name);
      if (!candidates.length) continue;

      let picked: FkSuggestion | null = null;
      for (const { base, suffix } of candidates) {
        for (const variant of nameVariants(base)) {
          const tgt = byName.get(variant);
          if (!tgt || tgt.kind === 'view') continue;
          const pk = singlePk(tgt);
          let target: Column | undefined = pk;
          let confidence: FkSuggestion['confidence'] = 'high';
          let reason = `${col.name} follows the ${base}_${suffix} convention and ${tgt.name} has a single primary key`;
          if (!target) {
            target = tgt.columns.find((c) => c.unique && c.name.trim().toLowerCase() === suffix);
            confidence = 'medium';
            reason = `${col.name} looks like a reference and ${tgt.name}.${suffix} is unique`;
          }
          if (!target) continue;
          const sf = typeFamily(col);
          const tf = typeFamily(target);
          if (sf !== 'other' && tf !== 'other' && sf !== tf) {
            confidence = 'medium';
            reason += `, although the types differ (${col.type} vs ${target.type})`;
          }
          if (tgt.id === src.id && confidence === 'high') {
            confidence = 'medium';
            reason = `${col.name} looks like a self-reference to ${src.name}.${target.name}`;
          }
          picked = { id: `${src.id}:${col.id}`, sourceTableId: src.id, sourceColumnId: col.id, targetTableId: tgt.id, targetColumnId: target.id, confidence, reason };
          break;
        }
        if (picked) break;
      }

      // parent_id / manager_id inside a table that has an id primary key
      if (!picked && ownPk && /^(parent|manager|supervisor|owner|reply_to|replied_to)(_id)?$/i.test(col.name.trim()) && col.id !== ownPk.id) {
        picked = {
          id: `${src.id}:${col.id}`,
          sourceTableId: src.id,
          sourceColumnId: col.id,
          targetTableId: src.id,
          targetColumnId: ownPk.id,
          confidence: 'medium',
          reason: `${col.name} usually points back at another row of ${src.name}`,
        };
      }
      if (picked) out.push(picked);
    }
  }

  const rank = { high: 0, medium: 1 };
  const tableName = (id: string) => d.tables.find((t) => t.id === id)?.name ?? '';
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || tableName(a.sourceTableId).localeCompare(tableName(b.sourceTableId)));
}
