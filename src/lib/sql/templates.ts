/**
 * Starting points for a connection's tagged query, written from what the
 * diagram already knows about the two tables: the column pairs of a foreign
 * key, the columns of a flow's target and the source columns that share
 * their names, the column an embed is stored in, and the dialect's own
 * spelling of an upsert. Nothing here is executed; it is text for the editor
 * to insert, to be finished by hand.
 */
import type { Column, Diagram, Relationship, Table } from '@shared/types';
import { columnNameKey } from '../derivation';
import { quoteIdent, quoteQualified } from './dialect';
import { generateFlowSql } from './generator';

export interface QueryTemplate {
  id: string;
  label: string;
  /** One line on what the query does, for the menu. */
  hint: string;
  sql: string;
}

/** Two short, distinct aliases for the two tables, from their initials. */
function aliasesFor(a: string, b: string): [string, string] {
  const initial = (name: string) => name.replace(/[^a-z]/gi, '').charAt(0).toLowerCase() || 't';
  const x = initial(a);
  let y = initial(b);
  if (y === x) y = `${y}2`;
  return [x, y];
}

function columnPairs(r: Relationship, src: Table, tgt: Table): { source: Column; target: Column }[] {
  const out: { source: Column; target: Column }[] = [];
  const n = Math.max(r.sourceColumnIds.length, r.targetColumnIds.length);
  for (let i = 0; i < n; i++) {
    const source = src.columns.find((c) => c.id === r.sourceColumnIds[i]);
    const target = tgt.columns.find((c) => c.id === r.targetColumnIds[i]);
    if (source && target) out.push({ source, target });
  }
  return out;
}

/** The templates that make sense for this connection, most useful first. */
export function relationshipQueryTemplates(d: Diagram, r: Relationship): QueryTemplate[] {
  const src = d.tables.find((t) => t.id === r.sourceTableId);
  const tgt = d.tables.find((t) => t.id === r.targetTableId);
  if (!src || !tgt) return [];
  const dialect = d.dialect;
  const q = (name: string) => quoteIdent(name, dialect);
  const tn = (t: Table) => quoteQualified(t.name, t.schema, dialect);
  const [s, t] = aliasesFor(src.name, tgt.name);
  const pairs = columnPairs(r, src, tgt);
  const joinOn = pairs.map((p) => `${s}.${q(p.source.name)} = ${t}.${q(p.target.name)}`).join(' AND ');
  const out: QueryTemplate[] = [];

  if (r.kind === 'fk' || r.kind === 'dependency') {
    const on = joinOn || `${s}.${q(src.columns[0]?.name ?? 'id')} = ${t}.${q(tgt.columns.find((c) => c.primaryKey)?.name ?? 'id')}`;
    out.push({
      id: 'join',
      label: `Join ${src.name} to ${tgt.name}`,
      hint: 'Every row of the referencing table with the row it points at',
      sql: `SELECT ${s}.*, ${t}.*\nFROM ${tn(src)} ${s}\nJOIN ${tn(tgt)} ${t} ON ${on};`,
    });
    if (r.kind === 'fk' && pairs.length) {
      const nullCheck = pairs.map((p) => `${t}.${q(p.target.name)} IS NULL`).join(' AND ');
      const notNull = pairs.map((p) => `${s}.${q(p.source.name)} IS NOT NULL`).join(' AND ');
      out.push({
        id: 'orphans',
        label: `Orphans in ${src.name}`,
        hint: `Rows of ${src.name} whose ${tgt.name} is missing — what the constraint would reject`,
        sql: `SELECT ${s}.*\nFROM ${tn(src)} ${s}\nLEFT JOIN ${tn(tgt)} ${t} ON ${on}\nWHERE ${notNull}\n  AND ${nullCheck};`,
      });
      const keys = pairs.map((p) => `${t}.${q(p.target.name)}`).join(', ');
      out.push({
        id: 'count',
        label: `Count ${src.name} per ${tgt.name}`,
        hint: `How many rows of ${src.name} each row of ${tgt.name} has`,
        sql: `SELECT ${keys}, COUNT(${s}.${q(pairs[0].source.name)}) AS ${q(`${src.name}_count`)}\nFROM ${tn(tgt)} ${t}\nLEFT JOIN ${tn(src)} ${s} ON ${on}\nGROUP BY ${keys}\nORDER BY ${q(`${src.name}_count`)} DESC;`,
      });
    }
  }

  if (r.kind === 'flow') {
    const generated = generateFlowSql(d, r.id);
    if (generated) {
      out.push({ id: 'derived', label: 'The statement built from the derived columns', hint: 'What the derivations above already say, as a starting point to add joins or conditions to', sql: generated });
    }
    // INSERT ... SELECT with columns paired by name; the rest left as NULL to fill in.
    const targets = tgt.columns.filter((c) => !c.autoIncrement);
    if (targets.length) {
      const byKey = new Map<string, Column>();
      for (const c of src.columns) {
        const k = columnNameKey(c.name);
        if (k && !byKey.has(k)) byKey.set(k, c);
      }
      const selectItems = targets.map((c) => {
        const match = byKey.get(columnNameKey(c.name));
        return match ? `${s}.${q(match.name)}` : `NULL AS ${q(c.name)}`;
      });
      const insertCols = targets.map((c) => q(c.name)).join(', ');
      const select = `SELECT ${selectItems.join(', ')}\nFROM ${tn(src)} ${s}`;
      out.push({
        id: 'insert-select',
        label: `INSERT INTO ${tgt.name} … SELECT FROM ${src.name}`,
        hint: 'Columns paired by name; the ones with no match are NULL until you fill them in',
        sql: `INSERT INTO ${tn(tgt)} (${insertCols})\n${select};`,
      });
      const keyCols = tgt.columns.filter((c) => c.primaryKey);
      const conflictCols = keyCols.length ? keyCols : tgt.columns.filter((c) => c.unique);
      const updatable = targets.filter((c) => !conflictCols.includes(c));
      if (conflictCols.length && updatable.length) {
        const conflict = conflictCols.map((c) => q(c.name)).join(', ');
        let tail: string;
        if (dialect === 'mariadb') tail = `ON DUPLICATE KEY UPDATE\n  ${updatable.map((c) => `${q(c.name)} = VALUES(${q(c.name)})`).join(',\n  ')}`;
        else tail = `ON CONFLICT (${conflict}) DO UPDATE SET\n  ${updatable.map((c) => `${q(c.name)} = EXCLUDED.${q(c.name)}`).join(',\n  ')}`;
        out.push({
          id: 'upsert',
          label: `Upsert into ${tgt.name}`,
          hint: dialect === 'mariadb' ? 'INSERT … ON DUPLICATE KEY UPDATE, so re-running it refreshes rows instead of duplicating them' : 'INSERT … ON CONFLICT DO UPDATE, so re-running it refreshes rows instead of duplicating them',
          sql: `INSERT INTO ${tn(tgt)} (${insertCols})\n${select}\n${tail};`,
        });
      }
      out.push({
        id: 'rebuild',
        label: `Rebuild ${tgt.name} from ${src.name}`,
        hint: 'Empty the target, then fill it again — for a table that is derived and nothing else writes to',
        sql: `DELETE FROM ${tn(tgt)};\n\nINSERT INTO ${tn(tgt)} (${insertCols})\n${select};`,
      });
    }
  }

  if (r.kind === 'embed') {
    const stored = src.columns.find((c) => c.id === r.sourceColumnIds[0]);
    const col = q(stored?.name ?? 'payload');
    const pk = src.columns.find((c) => c.primaryKey)?.name;
    const key = pk ? `${s}.${q(pk)}, ` : '';
    if (dialect === 'postgresql') {
      const fn = /json\b/i.test(stored?.type ?? '') && !/jsonb/i.test(stored?.type ?? '') ? 'json_array_elements' : 'jsonb_array_elements';
      out.push({
        id: 'unpack',
        label: `Unpack ${tgt.name} out of ${src.name}`,
        hint: `One row per ${tgt.name} element stored in ${stored?.name ?? 'the column'}`,
        sql: `SELECT ${key}${t}.*\nFROM ${tn(src)} ${s}\nCROSS JOIN LATERAL ${fn}(${s}.${col}) AS ${t};`,
      });
      out.push({
        id: 'field',
        label: 'Read one field of the embedded value',
        hint: 'The ->> operator pulls a field out as text',
        sql: `SELECT ${key}${s}.${col} ->> 'field' AS ${q('field')}\nFROM ${tn(src)} ${s};`,
      });
    } else if (dialect === 'mariadb') {
      out.push({
        id: 'unpack',
        label: `Unpack ${tgt.name} out of ${src.name}`,
        hint: `One row per ${tgt.name} element stored in ${stored?.name ?? 'the column'}`,
        sql: `SELECT ${key}${t}.*\nFROM ${tn(src)} ${s},\n  JSON_TABLE(${s}.${col}, '$[*]' COLUMNS (\n    ${tgt.columns.map((c) => `${q(c.name)} ${c.type || 'TEXT'} PATH '$.${c.name}'`).join(',\n    ')}\n  )) AS ${t};`,
      });
      out.push({
        id: 'field',
        label: 'Read one field of the embedded value',
        hint: 'JSON_VALUE pulls a field out as text',
        sql: `SELECT ${key}JSON_VALUE(${s}.${col}, '$.field') AS ${q('field')}\nFROM ${tn(src)} ${s};`,
      });
    } else {
      out.push({
        id: 'unpack',
        label: `Unpack ${tgt.name} out of ${src.name}`,
        hint: `One row per ${tgt.name} element stored in ${stored?.name ?? 'the column'}`,
        sql: `SELECT ${key}${tgt.columns.map((c) => `json_extract(${t}.value, '$.${c.name}') AS ${q(c.name)}`).join(', ') || `${t}.value`}\nFROM ${tn(src)} ${s}, json_each(${s}.${col}) AS ${t};`,
      });
      out.push({
        id: 'field',
        label: 'Read one field of the embedded value',
        hint: 'json_extract pulls a field out',
        sql: `SELECT ${key}json_extract(${s}.${col}, '$.field') AS ${q('field')}\nFROM ${tn(src)} ${s};`,
      });
    }
  }

  return out;
}
