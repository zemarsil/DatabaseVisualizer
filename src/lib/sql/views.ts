/**
 * Helpers for views: which tables a SELECT reads from, and the order views
 * must be created in when one reads from another.
 */
import type { Diagram, Table } from '@shared/types';

const CLAUSE_END = /\b(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW|FETCH|FOR\s+UPDATE|ON|USING|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|NATURAL)\b/i;

/**
 * The SELECT body of a stored CREATE VIEW statement, as SQLite's sqlite_master
 * and DuckDB's duckdb_views() hand it back (schema-qualified names included).
 */
export function viewBody(createSql: string): string {
  const m =
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s(.]+)\s*\.\s*)*(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)\s*(?:\([^)]*\))?\s*AS\s+/i.exec(createSql);
  return (m ? createSql.slice(m[0].length) : createSql).trim().replace(/;+$/, '');
}

function stripIdent(raw: string): string {
  return raw.trim().replace(/^["`[]|["`\]]$/g, '');
}

/**
 * Table names a SELECT references after FROM and JOIN (including comma
 * lists and subqueries), matched against `candidateNames` case-insensitively.
 * Candidates may be plain or `schema.table`; a reference matches when its full
 * name or its bare table part equals the candidate.
 */
export function viewSourcesFromSql(sql: string, candidateNames: string[]): string[] {
  const refs: string[] = [];
  const identRe = /(["`[]?[A-Za-z_][\w$]*["`\]]?)(?:\s*\.\s*(["`[]?[A-Za-z_][\w$]*["`\]]?))?/y;
  const re = /\b(FROM|JOIN)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let pos = m.index + m[0].length;
    // FROM ONLY t / FROM LATERAL (...)
    const skip = /^(ONLY|LATERAL)\s+/i.exec(sql.slice(pos));
    if (skip) pos += skip[0].length;
    for (;;) {
      if (sql[pos] === '(') break; // subquery: its own FROM is found by the outer loop
      identRe.lastIndex = pos;
      const id = identRe.exec(sql);
      if (!id) break;
      const after = sql.slice(id.index + id[0].length);
      if (/^\s*\(/.test(after)) break; // function call such as unnest(...)
      const full = id[2] ? `${stripIdent(id[1])}.${stripIdent(id[2])}` : stripIdent(id[1]);
      refs.push(full);
      if (m[1].toUpperCase() === 'JOIN') break;
      // comma list: skip an optional alias, then continue after ","
      const rest = sql.slice(id.index + id[0].length);
      const clauseEnd = rest.search(CLAUSE_END);
      const segment = clauseEnd === -1 ? rest : rest.slice(0, clauseEnd);
      const comma = segment.indexOf(',');
      if (comma === -1) break;
      pos = id.index + id[0].length + comma + 1;
      while (/\s/.test(sql[pos] ?? '')) pos++;
    }
  }
  const out: string[] = [];
  for (const ref of refs) {
    const lower = ref.toLowerCase();
    const bare = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
    const hit = candidateNames.find((c) => {
      const cl = c.toLowerCase();
      const cb = cl.includes('.') ? cl.slice(cl.lastIndexOf('.') + 1) : cl;
      return cl === lower || cb === lower || cl === bare || cb === bare;
    });
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Views ordered so that a view reading from another view comes after it (stable by name). */
export function orderViews(d: Diagram): Table[] {
  const views = d.tables.filter((t) => t.kind === 'view').sort((a, b) => a.name.localeCompare(b.name));
  const ids = new Set(views.map((v) => v.id));
  const deps = new Map<string, Set<string>>(views.map((v) => [v.id, new Set<string>()]));
  for (const r of d.relationships) {
    if (r.kind !== 'flow' || r.sourceTableId === r.targetTableId) continue;
    if (ids.has(r.sourceTableId) && ids.has(r.targetTableId)) deps.get(r.targetTableId)!.add(r.sourceTableId);
  }
  const out: Table[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (v: Table) => {
    if (done.has(v.id) || visiting.has(v.id)) return;
    visiting.add(v.id);
    for (const dep of deps.get(v.id) ?? []) {
      const dv = views.find((x) => x.id === dep);
      if (dv) visit(dv);
    }
    visiting.delete(v.id);
    done.add(v.id);
    out.push(v);
  };
  for (const v of views) visit(v);
  return out;
}
