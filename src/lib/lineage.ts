/**
 * Where every column's value comes from.
 *
 * A column in this model is one of three things, and the difference is what the
 * derived lens on the canvas draws:
 *
 *  - **stored**  — rows carry the value; nothing in the diagram computes it.
 *  - **derived** — a data flow fills it, either through a derivation entry
 *                  ("revenue_cents = SUM(quantity * unit_price_cents)") or by
 *                  carrying a group key of the same name straight over.
 *  - **view**    — it belongs to a view, so the view's own SELECT computes it.
 *                  There is no per-column formula to read, only the tables the
 *                  view is fed by.
 *
 * The derivations themselves already say what they compute (src/lib/derivation.ts);
 * this module says which *columns* that lands on, and which columns it reads to
 * get there — the same resolution the simulator and the generator do, minus the
 * rows and the SQL. Expressions are parsed with the simulator's parser and their
 * references resolved through the diagram's own foreign keys, so `orders.status`
 * in a derivation on `order_items` points at the real column of `orders`.
 *
 * Everything here is pure and derived from the diagram: nothing is stored in the
 * file, so an old diagram gains the lens for free and a hand-edited one cannot
 * disagree with itself.
 */
import type { Column, Derivation, Diagram, Relationship, Table } from '@shared/types';
import { derivationGroupBy, derivationSummary, flowDerivations, groupDerivations, isDerivationComplete, parseOrderKey } from './derivation';
import { collectReferences, parseExpression, type ColumnRef } from './simulate/expression';
import { foreignKeyPath } from './schemaInfo';

/** How a column gets its value. */
export type ColumnOrigin = 'stored' | 'derived' | 'view';

/** A column of the diagram, named by both ids so a hit can be drawn without another lookup. */
export interface ColumnSite {
  tableId: string;
  columnId: string;
  /** The column sits on a table the flow's source reaches through foreign keys, not on the source itself. */
  viaForeignKey: boolean;
}

/**
 * One way a column gets filled. A flow may fill the same column twice (two
 * entries, or an entry and a carried key on different groups), so these come as
 * a list per column.
 */
export interface FilledBy {
  relationshipId: string;
  sourceTableId: string;
  targetTableId: string;
  targetColumnId: string;
  /** The entry that computes it, or null when a group key of the same name is carried over. */
  derivation: Derivation | null;
  /** The group-by key carried into the column, set only when `derivation` is null. */
  groupKey?: string;
  /** One line of the form "revenue_cents = SUM(quantity)  GROUP BY product_id". */
  summary: string;
  /** Columns this entry reads, resolved. Empty when nothing in it names a column. */
  inputs: ColumnSite[];
}

/** The same fact read from the other end: a derivation that reads this column. */
export interface FeedsInto extends FilledBy {
  /** The read that put this column in the entry's inputs. */
  via: ColumnSite;
}

export interface Lineage {
  /** Data flows that fill a column, by column id. Only columns a flow fills appear. */
  filledBy: Map<string, FilledBy[]>;
  /** Entries that read a column, by column id. Only columns something reads appear. */
  feeds: Map<string, FeedsInto[]>;
  /** Derived column ids of a table, in the table's own column order. */
  derivedByTable: Map<string, string[]>;
  /** Column ids of a table that some derivation reads, in the table's own column order. */
  sourceByTable: Map<string, string[]>;
  /** The table a column belongs to. */
  tableOfColumn: Map<string, string>;
  columnById: Map<string, Column>;
  tableById: Map<string, Table>;
}

/* ------------------------------------------------------------------ */
/* Building it                                                         */
/* ------------------------------------------------------------------ */

/** Every piece of text in a derivation that may name a column. */
function derivationTexts(dv: Derivation): string[] {
  const texts = [dv.expression, dv.filter ?? '', ...derivationGroupBy(dv)];
  if (dv.window) texts.push(...dv.window.orderBy.map((k) => parseOrderKey(k).expression), ...dv.window.partitionBy);
  return texts;
}

/**
 * Where a reference points: a column of the source table, or the column at the
 * end of a foreign-key chain when it is written `table.column`. Unresolvable
 * references (a typo, a table nothing reaches) are dropped — reporting them is
 * the linter's and the simulator's job, not the lens's.
 */
function resolveRef(d: Diagram, src: Table, ref: ColumnRef): ColumnSite | null {
  const find = (t: Table | undefined) => t?.columns.find((c) => c.name.toLowerCase() === ref.name.toLowerCase());
  if (!ref.table || ref.table.toLowerCase() === src.name.toLowerCase()) {
    const c = find(src);
    return c ? { tableId: src.id, columnId: c.id, viaForeignKey: false } : null;
  }
  const path = foreignKeyPath(d, src.id, ref.table);
  if (!path?.length) return null;
  const far = path[path.length - 1].parentId;
  const c = find(d.tables.find((t) => t.id === far));
  return c ? { tableId: far, columnId: c.id, viaForeignKey: true } : null;
}

/** Columns a derivation reads, deduplicated, in order of first appearance. */
function derivationInputs(d: Diagram, src: Table, dv: Derivation): ColumnSite[] {
  const out: ColumnSite[] = [];
  const seen = new Set<string>();
  for (const text of derivationTexts(dv)) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === '*') continue;
    let refs: ColumnRef[];
    try {
      refs = collectReferences(parseExpression(trimmed));
    } catch {
      continue; // Unparseable text says nothing about lineage; Problems reports it.
    }
    for (const ref of refs) {
      const site = resolveRef(d, src, ref);
      if (!site || seen.has(site.columnId)) continue;
      seen.add(site.columnId);
      out.push(site);
    }
  }
  return out;
}

/**
 * Target columns a flow fills that no entry names: a group-by key spelled like a
 * column of the target is written straight into it, which is how a rollup keyed
 * on `product_id` fills the target's own `product_id`. Both the generator and
 * the simulator do this, so the lens has to as well or those columns read as
 * stored when they are not.
 */
function carriedKeys(tgt: Table, entries: Derivation[]): { column: Column; key: string }[] {
  const out: { column: Column; key: string }[] = [];
  for (const group of groupDerivations(entries)) {
    const explicit = new Set(group.entries.map((dv) => dv.targetColumnId));
    for (const key of group.groupBy) {
      const column = tgt.columns.find((c) => c.name.toLowerCase() === key.trim().toLowerCase());
      if (column && !explicit.has(column.id) && !out.some((x) => x.column.id === column.id)) out.push({ column, key });
    }
  }
  return out;
}

/** Complete entries of a flow whose target column still exists; the same set the generator emits. */
function usableDerivations(r: Relationship, tgt: Table): Derivation[] {
  return flowDerivations(r).filter((dv) => isDerivationComplete(dv) && tgt.columns.some((c) => c.id === dv.targetColumnId));
}

/** Read every data flow in the diagram and index what it fills and what it reads. */
export function buildLineage(d: Diagram): Lineage {
  const tableById = new Map(d.tables.map((t) => [t.id, t]));
  const columnById = new Map<string, Column>();
  const tableOfColumn = new Map<string, string>();
  for (const t of d.tables) {
    for (const c of t.columns) {
      columnById.set(c.id, c);
      tableOfColumn.set(c.id, t.id);
    }
  }

  const filledBy = new Map<string, FilledBy[]>();
  const feeds = new Map<string, FeedsInto[]>();
  const push = <T>(m: Map<string, T[]>, key: string, value: T) => {
    const list = m.get(key);
    if (list) list.push(value);
    else m.set(key, [value]);
  };

  for (const r of d.relationships) {
    if (r.kind !== 'flow') continue;
    const src = tableById.get(r.sourceTableId);
    const tgt = tableById.get(r.targetTableId);
    if (!src || !tgt) continue;
    const entries = usableDerivations(r, tgt);

    for (const dv of entries) {
      const targetName = tgt.columns.find((c) => c.id === dv.targetColumnId)?.name;
      const record: FilledBy = {
        relationshipId: r.id,
        sourceTableId: src.id,
        targetTableId: tgt.id,
        targetColumnId: dv.targetColumnId,
        derivation: dv,
        summary: derivationSummary(dv, targetName),
        inputs: derivationInputs(d, src, dv),
      };
      push(filledBy, dv.targetColumnId, record);
      for (const via of record.inputs) push(feeds, via.columnId, { ...record, via });
    }

    for (const { column, key } of carriedKeys(tgt, entries)) {
      const record: FilledBy = {
        relationshipId: r.id,
        sourceTableId: src.id,
        targetTableId: tgt.id,
        targetColumnId: column.id,
        derivation: null,
        groupKey: key,
        summary: `${column.name} = ${key} (group key)`,
        inputs: derivationInputs(d, src, { id: '', targetColumnId: column.id, expression: key, groupBy: [] }),
      };
      push(filledBy, column.id, record);
      for (const via of record.inputs) push(feeds, via.columnId, { ...record, via });
    }
  }

  const byTable = (ids: Iterable<string>) => {
    const wanted = new Set(ids);
    const m = new Map<string, string[]>();
    for (const t of d.tables) {
      const hit = t.columns.filter((c) => wanted.has(c.id)).map((c) => c.id);
      if (hit.length) m.set(t.id, hit);
    }
    return m;
  };

  return { filledBy, feeds, derivedByTable: byTable(filledBy.keys()), sourceByTable: byTable(feeds.keys()), tableOfColumn, columnById, tableById };
}

/* ------------------------------------------------------------------ */
/* Asking it things                                                    */
/* ------------------------------------------------------------------ */

/**
 * How a column gets its value. A view's columns come out as 'view' even when a
 * flow into the view also names them: the SELECT is what really produces them,
 * and the flow only records which tables it reads.
 */
export function columnOrigin(l: Lineage, columnId: string): ColumnOrigin {
  const table = l.tableById.get(l.tableOfColumn.get(columnId) ?? '');
  if (table?.kind === 'view') return 'view';
  return l.filledBy.has(columnId) ? 'derived' : 'stored';
}

/** True when a data flow fills this column, so the canvas marks it computed. */
export function isDerivedColumn(l: Lineage, columnId: string): boolean {
  return columnOrigin(l, columnId) !== 'stored';
}

/** Columns of a table the lens marks as computed, view columns included, in the table's own order. */
export function derivedColumnIds(l: Lineage, table: Table): string[] {
  if (table.kind === 'view') return table.columns.map((c) => c.id);
  return l.derivedByTable.get(table.id) ?? [];
}

/** What a derived column is worth saying in one line: its formulas, or what a view column is. */
export function describeColumnOrigin(l: Lineage, columnId: string): string | null {
  const origin = columnOrigin(l, columnId);
  if (origin === 'stored') return null;
  const entries = l.filledBy.get(columnId) ?? [];
  const summaries = entries.map((e) => {
    const from = l.tableById.get(e.sourceTableId)?.name ?? '?';
    return `${e.summary} — from ${from}`;
  });
  if (origin === 'view') {
    const head = 'Computed by the view’s SELECT';
    return summaries.length ? `${head}\n${summaries.join('\n')}` : head;
  }
  return summaries.join('\n');
}

/** Tables a view reads, as its data-flow links record them. */
export function viewInputTables(d: Diagram, viewId: string): Table[] {
  const ids = new Set(d.relationships.filter((r) => r.kind === 'flow' && r.targetTableId === viewId && r.sourceTableId !== viewId).map((r) => r.sourceTableId));
  return d.tables.filter((t) => ids.has(t.id));
}

/* ------------------------------------------------------------------ */
/* Walking it                                                          */
/* ------------------------------------------------------------------ */

/**
 * One column in a lineage tree. `edge` is the derivation that connects it to its
 * parent — reading upstream it is the entry the parent is filled by, reading
 * downstream it is the entry this column is filled by. Either way the edge sits
 * on the child.
 */
export interface LineageNode {
  tableId: string;
  columnId: string;
  depth: number;
  edge: FilledBy | null;
  children: LineageNode[];
  /**
   * The column already appeared on the way here, so it is shown but not expanded
   * again. A schema where two flows feed each other is a cycle, and a tree has
   * to stop somewhere.
   */
  repeated: boolean;
  /** Expansion stopped at `maxDepth`, not because there was nothing more. */
  truncated: boolean;
}

export interface WalkOptions {
  /** How many flows to follow. Default 6, which is more chained rollups than a diagram usually has. */
  maxDepth?: number;
}

function node(l: Lineage, columnId: string, depth: number, edge: FilledBy | null, repeated: boolean, truncated: boolean): LineageNode {
  return { tableId: l.tableOfColumn.get(columnId) ?? '', columnId, depth, edge, children: [], repeated, truncated };
}

/**
 * What a column is computed from, following the chain back through every flow
 * that feeds it: the root is the column asked about and each child is a column
 * read to produce its parent. A stored column has no children, which is the
 * answer "this is where the value enters the schema".
 */
export function upstream(l: Lineage, columnId: string, opts: WalkOptions = {}): LineageNode {
  const maxDepth = opts.maxDepth ?? 6;
  const walk = (id: string, depth: number, edge: FilledBy | null, seen: Set<string>): LineageNode => {
    if (seen.has(id)) return node(l, id, depth, edge, true, false);
    const entries = l.filledBy.get(id) ?? [];
    if (!entries.length) return node(l, id, depth, edge, false, false);
    if (depth >= maxDepth) return node(l, id, depth, edge, false, true);
    const here = node(l, id, depth, edge, false, false);
    const next = new Set(seen).add(id);
    for (const entry of entries) for (const input of entry.inputs) here.children.push(walk(input.columnId, depth + 1, entry, next));
    return here;
  };
  return walk(columnId, 0, null, new Set());
}

/**
 * What is computed from a column, following the chain forward: each child is a
 * column some derivation fills using its parent. A leaf is the end of the line —
 * nothing downstream reads it.
 */
export function downstream(l: Lineage, columnId: string, opts: WalkOptions = {}): LineageNode {
  const maxDepth = opts.maxDepth ?? 6;
  const walk = (id: string, depth: number, edge: FilledBy | null, seen: Set<string>): LineageNode => {
    if (seen.has(id)) return node(l, id, depth, edge, true, false);
    const readers = l.feeds.get(id) ?? [];
    if (!readers.length) return node(l, id, depth, edge, false, false);
    if (depth >= maxDepth) return node(l, id, depth, edge, false, true);
    const here = node(l, id, depth, edge, false, false);
    const next = new Set(seen).add(id);
    const added = new Set<string>();
    for (const reader of readers) {
      // Two entries of one flow can fill the same column; it is one child either way.
      const key = `${reader.relationshipId}:${reader.targetColumnId}`;
      if (added.has(key)) continue;
      added.add(key);
      here.children.push(walk(reader.targetColumnId, depth + 1, reader, next));
    }
    return here;
  };
  return walk(columnId, 0, null, new Set());
}

/** Every node of a tree except the root, depth-first, in display order. */
export function flattenLineage(root: LineageNode): LineageNode[] {
  const out: LineageNode[] = [];
  const visit = (n: LineageNode) => {
    for (const c of n.children) {
      out.push(c);
      visit(c);
    }
  };
  visit(root);
  return out;
}

/** Tables and flows a tree touches, for highlighting it on the canvas. */
export function lineageReach(root: LineageNode): { tableIds: Set<string>; columnIds: Set<string>; relationshipIds: Set<string> } {
  const tableIds = new Set<string>();
  const columnIds = new Set<string>();
  const relationshipIds = new Set<string>();
  const visit = (n: LineageNode) => {
    if (n.tableId) tableIds.add(n.tableId);
    columnIds.add(n.columnId);
    if (n.edge) relationshipIds.add(n.edge.relationshipId);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return { tableIds, columnIds, relationshipIds };
}

/** Counts for the tab badge and the panel's summary line. */
export function lineageTotals(l: Lineage, d: Diagram): { derived: number; tables: number; stored: number } {
  let derived = 0;
  let stored = 0;
  let tables = 0;
  for (const t of d.tables) {
    const n = derivedColumnIds(l, t).length;
    if (n) tables += 1;
    derived += n;
    stored += t.columns.length - n;
  }
  return { derived, tables, stored };
}
