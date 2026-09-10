/**
 * What a SQL editor may name, read off the diagram: every table and view for
 * a statement, or one source table plus the tables it reaches through foreign
 * keys for a derivation expression. The editors use it to colour known names,
 * to complete them, and to warn about the ones they cannot resolve.
 */
import type { Diagram, Relationship, Table } from '@shared/types';
import type { CompletionItem } from './sql/complete';
import type { SqlScope, SqlScopeTable } from './sql/highlight';

function scopeTable(t: Table, hint?: string): SqlScopeTable {
  return { name: t.name, schema: t.schema, columns: t.columns.map((c) => ({ name: c.name, type: c.type })), hint: hint ?? (t.kind === 'view' ? 'view' : undefined) };
}

/** Every table and view of the diagram: the scope of the Query tab, a view's SELECT, a tagged query. */
export function diagramScope(d: Pick<Diagram, 'tables'>): SqlScope {
  return { tables: d.tables.map((t) => scopeTable(t)) };
}

/** One table on its own, for its CHECK constraints and column defaults. */
export function tableScope(t: Table): SqlScope {
  return { tables: [scopeTable(t)], primary: t.name };
}

export interface ReachableTable {
  table: Table;
  /** The foreign-key path from the source, e.g. "order_items.order_id → orders.customer_id". */
  via: string;
}

/**
 * Tables an expression on `src` may name as table.column: those it reaches
 * through foreign keys (child → parent, a few hops), each with the path.
 */
export function reachableTables(tables: Table[], relationships: Relationship[], src: Table): ReachableTable[] {
  const out: ReachableTable[] = [];
  const seen = new Set<string>([src.id]);
  let frontier: { id: string; via: string }[] = [{ id: src.id, via: '' }];
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const next: { id: string; via: string }[] = [];
    for (const { id, via } of frontier) {
      const from = tables.find((t) => t.id === id);
      for (const fk of relationships) {
        if (fk.kind !== 'fk' || fk.sourceTableId !== id || seen.has(fk.targetTableId)) continue;
        const parent = tables.find((t) => t.id === fk.targetTableId);
        if (!parent) continue;
        seen.add(parent.id);
        const col = from?.columns.find((c) => c.id === fk.sourceColumnIds[0])?.name ?? '?';
        const path = via ? `${via} → ${from?.name ?? '?'}.${col}` : `${from?.name ?? '?'}.${col}`;
        out.push({ table: parent, via: path });
        next.push({ id: parent.id, via: path });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The scope of a derivation on `src`: its own columns bare, and the reachable
 * tables' columns as table.column. The extras are those qualified names as
 * completion items, so typing "sta" offers orders.status as well.
 */
export function flowScope(src: Table, reachable: ReachableTable[]): { scope: SqlScope; extras: CompletionItem[] } {
  const scope: SqlScope = {
    primary: src.name,
    tables: [scopeTable(src), ...reachable.map(({ table, via }) => scopeTable(table, `through ${via}`))],
  };
  const extras: CompletionItem[] = reachable.flatMap(({ table, via }) =>
    table.columns.map((c) => ({ label: `${table.name}.${c.name}`, insert: `${table.name}.${c.name}`, kind: 'column' as const, detail: `${c.type} · through ${via}` })),
  );
  return { scope, extras };
}
