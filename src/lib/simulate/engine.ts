/**
 * Data-flow simulation: what rows would move if every data flow in the diagram
 * ran once.
 *
 * Starting from the table you want to see fed, the simulator collects every
 * flow upstream of it, seeds the raw input tables with sample rows, and runs
 * the flows in dependency order: filter the source rows, put them in order for
 * any sequence (window) operation, group and aggregate, and write the result
 * into the target. Every produced row remembers which source rows fed it and
 * how each column was computed, so the UI can show the lineage of a value and
 * animate it moving across the canvas.
 *
 * Column references in expressions may reach other tables through foreign keys
 * (orders.status from an order_items row): the diagram's own connections say
 * how the tables combine, so nothing has to be repeated in the derivation.
 */
import type { Column, Derivation, Diagram, Relationship, Table } from '@shared/types';
import { windowMeta } from '@shared/types';
import { derivationGroupBy, derivationRowValue, derivationSummary, derivationValue, flowDerivations, groupDerivations, isDerivationComplete, parseOrderKey } from '../derivation';
import { foreignKeyPath, type FkPathStep } from '../schemaInfo';
import { seedRows, type RawValue } from '../seed';
import {
  ExpressionError,
  collectComparedLiterals,
  collectReferences,
  compareValues,
  evaluate,
  formatValue,
  isStar,
  orderValues,
  parseExpression,
  subtractValues,
  toNumber,
  type ColumnRef,
  type EvalContext,
  type Expr,
  type Value,
} from './expression';

/** One row: column id -> value. */
export type SimRow = Record<string, Value>;

export interface SimulationOptions {
  /** Rows per raw input table (default 10). */
  rows?: number;
  /** Seed for the sample data (default 1). */
  seed?: number;
  /** Replace the seeded rows of an input table wholesale (tests, pasted data). Values keyed by column id. */
  inputRows?: Record<string, SimRow[]>;
  /** Edit single cells of seeded rows: table id -> row index -> column id -> value. */
  overrides?: Record<string, Record<number, Record<string, Value>>>;
}

/**
 * input   -> a raw table: its rows are sample data, nothing feeds it
 * derived -> its rows are produced by one or more flows
 * lookup  -> not on the flow path, but read through a foreign key (orders.status)
 */
export type TableRole = 'input' | 'derived' | 'lookup';

export interface RowOrigin {
  /** Index of the stage that produced the row. */
  stage: number;
  /** Indices of the stage's source rows that fed this row (neighbours of a sequence operation included). */
  sourceRows: number[];
  /** How each column was computed, one line per column. */
  explain: string[];
}

export interface ColumnLocation {
  tableId: string;
  columnId: string;
}

export interface StageGroup {
  /** The derivations that ran together, summarised. */
  summaries: string[];
  filter: string | null;
  groupBy: string[];
  /** Source rows that passed the filter. */
  matched: number[];
  produced: number;
  /** True when rows were grouped and aggregated, false for one output row per input row. */
  aggregated: boolean;
}

export interface SimulationStage {
  index: number;
  relationshipId: string;
  sourceTableId: string;
  targetTableId: string;
  /** "order_items → daily_sales" plus the flow's label when it has one. */
  label: string;
  /** Source row indices that fed at least one output row. */
  matchedRows: number[];
  /** Rows of the target this stage produced: [start, end) into rows[target]. */
  producedRange: [number, number];
  /** Columns read, on the source and on lookup tables. */
  reads: ColumnLocation[];
  /** Target column ids written (derived, carried keys, generated ids). */
  writes: string[];
  /** Tables reached through foreign keys while evaluating this stage. */
  lookupTableIds: string[];
  /** Foreign keys walked for those lookups. */
  lookupRelationshipIds: string[];
  groups: StageGroup[];
  warnings: string[];
}

export interface SimulationResult {
  targetId: string;
  /** Every table in play: inputs and lookups first, then derived tables in the order they are filled. */
  tableIds: string[];
  roles: Record<string, TableRole>;
  stages: SimulationStage[];
  /** Final rows of every table in play. */
  rows: Record<string, SimRow[]>;
  /** Per row of every table: where it came from, or null for seeded rows. */
  origins: Record<string, (RowOrigin | null)[]>;
  /** Flow relationships that ran, in stage order. */
  flowIds: string[];
  warnings: string[];
  options: { rows: number; seed: number };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function rawToValue(v: RawValue): Value {
  if (v === null || typeof v !== 'object') return v;
  if ('hex' in v) return `x'${v.hex}'`;
  return null;
}

function lower(s: string): string {
  return s.toLowerCase();
}

/** Tables that at least one data flow feeds: the candidates for "simulate into". */
export function simulationTargets(d: Diagram): Table[] {
  const fed = new Set(d.relationships.filter((r) => r.kind === 'flow' && r.sourceTableId !== r.targetTableId).map((r) => r.targetTableId));
  return d.tables.filter((t) => fed.has(t.id));
}

/** Flows into a table, in diagram order. */
export function flowsInto(d: Diagram, tableId: string): Relationship[] {
  return d.relationships.filter((r) => r.kind === 'flow' && r.targetTableId === tableId && r.sourceTableId !== tableId);
}

function tableLabel(t: Table): string {
  return t.name || 'untitled';
}

/** Rows of a table visible once stage `stage` has run (-1: nothing has run yet). */
export function rowsAtStage(result: SimulationResult, tableId: string, stage: number): number {
  const rows = result.rows[tableId] ?? [];
  if (result.roles[tableId] !== 'derived') return rows.length;
  let n = 0;
  for (const s of result.stages) {
    if (s.index > stage) break;
    if (s.targetTableId === tableId) n = Math.max(n, s.producedRange[1]);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Foreign-key lookups                                                 */
/* ------------------------------------------------------------------ */

type FkStep = FkPathStep;

class Schema {
  readonly byId = new Map<string, Table>();
  private readonly byName = new Map<string, Table[]>();
  private readonly colsByName = new Map<string, Map<string, Column>>();
  private readonly pathCache = new Map<string, FkStep[] | null>();

  constructor(readonly d: Diagram) {
    for (const t of d.tables) {
      this.byId.set(t.id, t);
      const key = lower(t.name);
      if (!this.byName.has(key)) this.byName.set(key, []);
      this.byName.get(key)!.push(t);
      if (t.schema) {
        const q = `${lower(t.schema)}.${key}`;
        if (!this.byName.has(q)) this.byName.set(q, []);
        this.byName.get(q)!.push(t);
      }
      this.colsByName.set(t.id, new Map(t.columns.map((c) => [lower(c.name), c])));
    }
  }

  column(tableId: string, name: string): Column | undefined {
    return this.colsByName.get(tableId)?.get(lower(name));
  }

  tablesNamed(name: string): Table[] {
    return this.byName.get(lower(name)) ?? [];
  }

  /** foreignKeyPath, cached per (start table, name): it runs once per row otherwise. */
  fkPath(fromId: string, name: string): FkStep[] | null {
    const key = `${fromId}->${lower(name)}`;
    if (!this.pathCache.has(key)) this.pathCache.set(key, foreignKeyPath(this.d, fromId, name));
    return this.pathCache.get(key)!;
  }
}

/** Finds the parent row a child row points at, with an index per (table, key columns). */
class RowIndex {
  private readonly indexes = new Map<string, Map<string, number>>();
  constructor(private readonly rows: Record<string, SimRow[]>) {}

  private keyOf(values: Value[]): string {
    return JSON.stringify(values.map((v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)));
  }

  find(parentId: string, parentColumnIds: string[], values: Value[]): number | null {
    if (values.some((v) => v === null)) return null;
    const key = `${parentId}|${parentColumnIds.join(',')}`;
    let index = this.indexes.get(key);
    if (!index) {
      index = new Map();
      (this.rows[parentId] ?? []).forEach((row, i) => {
        const k = this.keyOf(parentColumnIds.map((c) => row[c] ?? null));
        if (!index!.has(k)) index!.set(k, i);
      });
      this.indexes.set(key, index);
    }
    return index.get(this.keyOf(values)) ?? null;
  }

  /** Rows of a derived table change as stages run; forget what we knew about it. */
  invalidate(tableId: string): void {
    for (const key of [...this.indexes.keys()]) if (key.startsWith(`${tableId}|`)) this.indexes.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Aggregates and windows                                              */
/* ------------------------------------------------------------------ */

function aggregate(fn: NonNullable<Derivation['aggregate']>, values: Value[], countAll: boolean): Value {
  const present = values.filter((v) => v !== null);
  switch (fn) {
    case 'COUNT':
      return countAll ? values.length : present.length;
    case 'SUM':
      return present.length ? present.reduce<number>((s, v) => s + toNumber(v), 0) : null;
    case 'AVG':
      return present.length ? present.reduce<number>((s, v) => s + toNumber(v), 0) / present.length : null;
    case 'MIN':
      return present.length ? present.reduce((m, v) => (compareValues(v, m)! < 0 ? v : m)) : null;
    case 'MAX':
      return present.length ? present.reduce((m, v) => (compareValues(v, m)! > 0 ? v : m)) : null;
    default:
      throw new ExpressionError(`Unknown aggregate ${String(fn)}`);
  }
}

interface WindowResult {
  /** Value per source row index. */
  values: Map<number, Value>;
  /** Neighbouring source rows each value was computed from. */
  neighbours: Map<number, number[]>;
  /** Text explaining the value, per row. */
  explain: Map<number, string>;
}

/* ------------------------------------------------------------------ */
/* The simulation                                                      */
/* ------------------------------------------------------------------ */

interface Plan {
  /** Tables in dependency order. */
  order: string[];
  flows: Relationship[];
  roles: Record<string, TableRole>;
  lookups: Map<string, { tableIds: Set<string>; relationshipIds: Set<string> }>;
  warnings: string[];
}

/** Column references a flow's derivations make, parsed once (bad text is reported by the stage). */
function flowReferences(r: Relationship): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const texts: string[] = [];
  for (const dv of flowDerivations(r)) {
    texts.push(dv.expression, dv.filter ?? '', ...dv.groupBy);
    if (dv.window) texts.push(...dv.window.orderBy.map((k) => parseOrderKey(k).expression), ...dv.window.partitionBy);
  }
  for (const t of texts) {
    if (!t.trim() || t.trim() === '*') continue;
    try {
      collectReferences(parseExpression(t), refs);
    } catch {
      /* reported when the stage runs */
    }
  }
  return refs;
}

/** Which flows feed the target, transitively, and in what order they can run. */
function plan(schema: Schema, targetId: string): Plan {
  const d = schema.d;
  const warnings: string[] = [];
  const flows = new Map<string, Relationship>();
  const tables = new Set<string>([targetId]);
  const lookups = new Map<string, { tableIds: Set<string>; relationshipIds: Set<string> }>();
  const queue = [targetId];
  while (queue.length) {
    const t = queue.shift()!;
    for (const r of flowsInto(d, t)) {
      if (flows.has(r.id)) continue;
      flows.set(r.id, r);
      if (!tables.has(r.sourceTableId)) {
        tables.add(r.sourceTableId);
        queue.push(r.sourceTableId);
      }
      // Tables read through foreign keys must have their rows before this flow runs.
      const src = schema.byId.get(r.sourceTableId);
      const info = { tableIds: new Set<string>(), relationshipIds: new Set<string>() };
      for (const ref of flowReferences(r)) {
        if (!ref.table || !src || lower(ref.table) === lower(src.name)) continue;
        const path = schema.fkPath(src.id, ref.table);
        if (!path) continue;
        for (const step of path) {
          info.tableIds.add(step.parentId);
          info.relationshipIds.add(step.relationship.id);
          if (!tables.has(step.parentId)) {
            tables.add(step.parentId);
            queue.push(step.parentId);
          }
        }
      }
      lookups.set(r.id, info);
    }
  }

  // Kahn over the tables: a flow's target waits for its source and its lookups.
  const indeg = new Map<string, number>([...tables].map((id) => [id, 0]));
  const out = new Map<string, Set<string>>([...tables].map((id) => [id, new Set()]));
  const dep = (from: string, to: string) => {
    if (from === to || out.get(from)!.has(to)) return;
    out.get(from)!.add(to);
    indeg.set(to, indeg.get(to)! + 1);
  };
  for (const r of flows.values()) {
    dep(r.sourceTableId, r.targetTableId);
    for (const l of lookups.get(r.id)?.tableIds ?? []) dep(l, r.targetTableId);
  }
  const byName = (id: string) => schema.byId.get(id)?.name ?? '';
  const ready = [...tables].filter((id) => indeg.get(id) === 0).sort((a, b) => byName(a).localeCompare(byName(b)));
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of out.get(id)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) {
        ready.push(next);
        ready.sort((a, b) => byName(a).localeCompare(byName(b)));
      }
    }
  }
  const placed = new Set(order);
  const cyclic = [...tables].filter((id) => !placed.has(id));
  if (cyclic.length) {
    const names = cyclic.map(byName).join(', ');
    warnings.push(`The flows between ${names} form a cycle, so those tables were treated as raw inputs and the flows into them were skipped.`);
    for (const r of [...flows.values()]) if (cyclic.includes(r.targetTableId)) flows.delete(r.id);
    order.push(...cyclic.sort((a, b) => byName(a).localeCompare(byName(b))));
  }

  const roles: Record<string, TableRole> = {};
  const fed = new Set([...flows.values()].map((r) => r.targetTableId));
  const onPath = new Set<string>([targetId]);
  for (const r of flows.values()) onPath.add(r.sourceTableId);
  for (const id of order) roles[id] = fed.has(id) ? 'derived' : onPath.has(id) ? 'input' : 'lookup';
  return { order, flows: [...flows.values()], roles, lookups, warnings };
}

/**
 * Literals the flows compare columns with, so the seed can plant them:
 * status = 'paid' is pointless on rows that are never 'paid'.
 */
function seedHints(schema: Schema, flows: Relationship[]): Record<string, RawValue[]> {
  const hints: Record<string, RawValue[]> = {};
  for (const r of flows) {
    const src = schema.byId.get(r.sourceTableId);
    if (!src) continue;
    const texts = flowDerivations(r).flatMap((dv) => [dv.filter ?? '', dv.expression]);
    for (const text of texts) {
      if (!text.trim() || text.trim() === '*') continue;
      let expr: Expr;
      try {
        expr = parseExpression(text);
      } catch {
        continue;
      }
      for (const { ref, value } of collectComparedLiterals(expr)) {
        const loc = resolveRef(schema, src, ref);
        if (!loc || value === null) continue;
        (hints[loc.columnId] ??= []).push(value);
      }
    }
  }
  return hints;
}

/** Where a reference points, statically: the source column, or a column at the end of a foreign-key chain. */
function resolveRef(schema: Schema, src: Table, ref: ColumnRef): ColumnLocation | null {
  if (!ref.table || lower(ref.table) === lower(src.name)) {
    const c = schema.column(src.id, ref.name);
    return c ? { tableId: src.id, columnId: c.id } : null;
  }
  const path = schema.fkPath(src.id, ref.table);
  if (!path) return null;
  const far = path[path.length - 1].parentId;
  const c = schema.column(far, ref.name);
  return c ? { tableId: far, columnId: c.id } : null;
}

/** Run every data flow upstream of `targetId` once and return the rows, their lineage and the stages. */
export function simulateFlows(d: Diagram, targetId: string, opts: SimulationOptions = {}): SimulationResult {
  const schema = new Schema(d);
  const rowsPerTable = Math.max(0, Math.min(500, Math.floor(opts.rows ?? 10)));
  const seed = opts.seed ?? 1;
  const target = schema.byId.get(targetId);
  const empty: SimulationResult = { targetId, tableIds: [], roles: {}, stages: [], rows: {}, origins: {}, flowIds: [], warnings: [], options: { rows: rowsPerTable, seed } };
  if (!target) return { ...empty, warnings: ['The table to simulate into no longer exists.'] };

  const p = plan(schema, targetId);
  const warnings = [...p.warnings];
  if (!p.flows.length) return { ...empty, tableIds: [targetId], roles: { [targetId]: 'input' }, warnings: [...warnings, `No data flow feeds ${tableLabel(target)} yet. Draw one from the orange handle of a source table and add derived columns to it.`] };

  /* ---------- raw rows ---------- */
  const seeded = seedRows(d, { rows: rowsPerTable, seed, valueHints: seedHints(schema, p.flows), includeExternal: true, nullRate: 0.05 });
  const rows: Record<string, SimRow[]> = {};
  const origins: Record<string, (RowOrigin | null)[]> = {};
  for (const id of p.order) {
    rows[id] = [];
    origins[id] = [];
    if (p.roles[id] === 'derived') continue;
    const given = opts.inputRows?.[id];
    if (given) {
      rows[id] = given.map((r) => ({ ...r }));
    } else {
      const s = seeded.tables.find((x) => x.table.id === id);
      if (s) {
        for (let i = 0; i < s.n; i++) {
          const row: SimRow = {};
          for (const c of s.columns) row[c.id] = rawToValue(s.store.get(c.id)![i]);
          rows[id].push(row);
        }
      }
    }
    const over = opts.overrides?.[id];
    if (over) {
      for (const [index, patch] of Object.entries(over)) {
        const row = rows[id][Number(index)];
        if (row) Object.assign(row, patch);
      }
    }
    origins[id] = rows[id].map(() => null);
    if (!rows[id].length && p.roles[id] !== 'lookup') warnings.push(`${tableLabel(schema.byId.get(id)!)} has no rows to feed the flow (it has no columns, or rows per table is 0).`);
  }
  const index = new RowIndex(rows);

  /* ---------- stages ---------- */
  const stages: SimulationStage[] = [];
  const flowsByTarget = new Map<string, Relationship[]>();
  for (const r of p.flows) {
    if (!flowsByTarget.has(r.targetTableId)) flowsByTarget.set(r.targetTableId, []);
    flowsByTarget.get(r.targetTableId)!.push(r);
  }
  for (const tableId of p.order) {
    for (const r of flowsByTarget.get(tableId) ?? []) {
      const stage = runStage(schema, r, stages.length, rows, origins, index, p.lookups.get(r.id));
      stages.push(stage);
      index.invalidate(tableId);
    }
  }

  const tableIds = [...p.order.filter((id) => p.roles[id] !== 'derived'), ...p.order.filter((id) => p.roles[id] === 'derived')];
  return { targetId, tableIds, roles: p.roles, stages, rows, origins, flowIds: stages.map((s) => s.relationshipId), warnings, options: { rows: rowsPerTable, seed } };
}

/* ------------------------------------------------------------------ */
/* One flow                                                            */
/* ------------------------------------------------------------------ */

function runStage(
  schema: Schema,
  r: Relationship,
  stageIndex: number,
  rows: Record<string, SimRow[]>,
  origins: Record<string, (RowOrigin | null)[]>,
  index: RowIndex,
  lookups: { tableIds: Set<string>; relationshipIds: Set<string> } | undefined,
): SimulationStage {
  const src = schema.byId.get(r.sourceTableId)!;
  const tgt = schema.byId.get(r.targetTableId)!;
  const srcRows = rows[src.id] ?? [];
  const tgtRows = rows[tgt.id];
  const tgtOrigins = origins[tgt.id];
  const start = tgtRows.length;
  const warnings: string[] = [];
  const reads = new Map<string, ColumnLocation>();
  const writes = new Set<string>();
  const matchedAll = new Set<number>();
  const groupsOut: StageGroup[] = [];
  const label = `${tableLabel(src)} → ${tableLabel(tgt)}${r.name ? ` (${r.name})` : ''}`;
  const rowNo = (i: number) => `#${i + 1}`;

  const usable: Derivation[] = [];
  for (const dv of flowDerivations(r)) {
    if (isDerivationComplete(dv) && tgt.columns.some((c) => c.id === dv.targetColumnId)) usable.push(dv);
    else warnings.push(`A derived column is incomplete (no target column, expression or ordering) and was skipped.`);
  }
  if (!usable.length) {
    warnings.push(`${label} has no derived columns yet, so nothing moves. Select the connection and add one entry per column of ${tableLabel(tgt)}.`);
  }

  // Check every reference up front, so all the problems of a flow show at once
  // rather than the first one hiding the rest.
  for (const dv of usable) {
    const texts = [dv.expression, dv.filter ?? '', ...dv.groupBy, ...(dv.window ? [...dv.window.orderBy.map((k) => parseOrderKey(k).expression), ...dv.window.partitionBy] : [])];
    for (const text of texts) {
      if (!text.trim() || text.trim() === '*') continue;
      let refs: ColumnRef[];
      try {
        refs = collectReferences(parseExpression(text));
      } catch (e) {
        warnings.push(`"${text}": ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const ref of refs) {
        if (!ref.table || lower(ref.table) === lower(src.name)) {
          if (!schema.column(src.id, ref.name)) warnings.push(`"${text}": ${tableLabel(src)} has no column "${ref.name}"`);
          continue;
        }
        const path = schema.fkPath(src.id, ref.table);
        if (!path) {
          warnings.push(
            schema.tablesNamed(ref.table).length
              ? `"${text}": "${ref.table}" is not reachable from ${tableLabel(src)} through foreign keys, so ${ref.table}.${ref.name} cannot be looked up`
              : `"${text}": there is no table called "${ref.table}"`,
          );
        } else if (!schema.column(path[path.length - 1].parentId, ref.name)) {
          warnings.push(`"${text}": ${tableLabel(schema.byId.get(path[path.length - 1].parentId)!)} has no column "${ref.name}"`);
        }
      }
    }
  }

  /** Column access for one source row, following foreign keys for table.column. */
  const contextFor = (i: number): EvalContext => ({
    column: (table, name) => {
      const row = srcRows[i];
      if (!table || lower(table) === lower(src.name)) {
        const c = schema.column(src.id, name);
        if (!c) throw new ExpressionError(`${tableLabel(src)} has no column "${name}"`);
        reads.set(c.id, { tableId: src.id, columnId: c.id });
        return row[c.id] ?? null;
      }
      const path = schema.fkPath(src.id, table);
      if (!path) {
        const exists = schema.tablesNamed(table).length > 0;
        throw new ExpressionError(
          exists
            ? `"${table}" is not reachable from ${tableLabel(src)} through foreign keys, so ${table}.${name} cannot be looked up`
            : `There is no table called "${table}" (wanted ${table}.${name})`,
        );
      }
      let cur: SimRow | null = row;
      for (const step of path) {
        const fk = step.relationship;
        const values = fk.sourceColumnIds.map((c) => (cur ? (cur[c] ?? null) : null));
        for (const c of fk.sourceColumnIds) {
          const owner = fk.sourceTableId;
          reads.set(c, { tableId: owner, columnId: c });
        }
        const at = index.find(step.parentId, fk.targetColumnIds, values);
        cur = at === null ? null : (rows[step.parentId]?.[at] ?? null);
        if (!cur) break;
      }
      const far = path[path.length - 1].parentId;
      const c = schema.column(far, name);
      if (!c) throw new ExpressionError(`${tableLabel(schema.byId.get(far)!)} has no column "${name}"`);
      reads.set(c.id, { tableId: far, columnId: c.id });
      return cur ? (cur[c.id] ?? null) : null;
    },
  });

  const evalAt = (expr: Expr, i: number): Value => evaluate(expr, contextFor(i));
  const parseOr = (text: string, what: string): Expr | null => {
    try {
      return parseExpression(text);
    } catch (e) {
      warnings.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  /** Window values for one derivation over the matched rows. */
  const computeWindow = (dv: Derivation, matched: number[]): WindowResult | null => {
    const w = dv.window!;
    const meta = windowMeta(w.fn);
    const expr = meta.needsExpression ? parseOr(dv.expression, `Expression "${dv.expression}"`) : null;
    if (meta.needsExpression && !expr) return null;
    const orderKeys = w.orderBy.map((k) => ({ ...parseOrderKey(k), expr: parseOr(parseOrderKey(k).expression, `Order key "${k}"`) }));
    const partitionKeys = w.partitionBy.filter((k) => k.trim()).map((k) => parseOr(k, `Partition key "${k}"`));
    if (orderKeys.some((k) => !k.expr) || partitionKeys.some((k) => !k)) return null;
    const result: WindowResult = { values: new Map(), neighbours: new Map(), explain: new Map() };
    try {
      const partitions = new Map<string, number[]>();
      for (const i of matched) {
        const key = JSON.stringify(partitionKeys.map((k) => formatValue(evalAt(k!, i))));
        if (!partitions.has(key)) partitions.set(key, []);
        partitions.get(key)!.push(i);
      }
      for (const members of partitions.values()) {
        const keyed = members.map((i) => ({ i, keys: orderKeys.map((k) => evalAt(k.expr!, i)) }));
        keyed.sort((a, b) => {
          for (let k = 0; k < orderKeys.length; k++) {
            const c = orderValues(a.keys[k], b.keys[k]);
            if (c !== 0) return orderKeys[k].desc ? -c : c;
          }
          return a.i - b.i;
        });
        const values = keyed.map(({ i }) => (expr ? evalAt(expr, i) : null));
        let running = 0;
        let count = 0;
        let rank = 0;
        for (let k = 0; k < keyed.length; k++) {
          const i = keyed[k].i;
          const prev = k > 0 ? keyed[k - 1].i : null;
          const next = k + 1 < keyed.length ? keyed[k + 1].i : null;
          let v: Value = null;
          let neighbours: number[] = [];
          let text = '';
          switch (w.fn) {
            case 'LAG':
              v = k > 0 ? values[k - 1] : null;
              neighbours = prev !== null ? [prev] : [];
              text = k > 0 ? `value of row ${rowNo(prev!)} = ${formatValue(v)}` : 'first row in its sequence, so NULL';
              break;
            case 'LEAD':
              v = k + 1 < values.length ? values[k + 1] : null;
              neighbours = next !== null ? [next] : [];
              text = next !== null ? `value of row ${rowNo(next)} = ${formatValue(v)}` : 'last row in its sequence, so NULL';
              break;
            case 'DIFF':
              if (k > 0) {
                v = values[k] === null || values[k - 1] === null ? null : subtractValues(values[k], values[k - 1]);
                neighbours = [prev!];
                text = `${formatValue(values[k])} − ${formatValue(values[k - 1])} (row ${rowNo(prev!)}) = ${formatValue(v)}`;
              } else text = 'first row in its sequence, so NULL';
              break;
            case 'RUNNING_SUM':
            case 'RUNNING_AVG':
              if (values[k] !== null) {
                running += toNumber(values[k]);
                count++;
              }
              v = count ? (w.fn === 'RUNNING_SUM' ? running : running / count) : null;
              neighbours = keyed.slice(0, k).map((x) => x.i);
              text = `${w.fn === 'RUNNING_SUM' ? 'sum' : 'average'} of rows ${keyed.slice(0, k + 1).map((x) => rowNo(x.i)).join(', ')} = ${formatValue(v)}`;
              break;
            case 'ROW_NUMBER':
              v = k + 1;
              text = `position ${k + 1} in the order = ${k + 1}`;
              break;
            case 'RANK': {
              const tie = k > 0 && orderKeys.every((_key, n) => compareValues(keyed[k].keys[n], keyed[k - 1].keys[n]) === 0);
              if (!tie) rank = k + 1;
              v = rank;
              text = tie ? `ties with row ${rowNo(prev!)} = ${rank}` : `rank = ${rank}`;
              break;
            }
            default:
              break;
          }
          result.values.set(i, v);
          result.neighbours.set(i, neighbours);
          result.explain.set(i, text);
        }
      }
    } catch (e) {
      warnings.push(`Sequence ${derivationRowValue(dv)}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    return result;
  };

  const targetName = (dv: Derivation) => tgt.columns.find((c) => c.id === dv.targetColumnId)?.name ?? '?';

  for (const group of groupDerivations(usable)) {
    const filterText = group.filter || null;
    const filter = filterText ? parseOr(filterText, `Filter "${filterText}"`) : null;
    if (filterText && !filter) continue;
    // 1. WHERE
    const matched: number[] = [];
    try {
      for (let i = 0; i < srcRows.length; i++) {
        if (!filter || evalAt(filter, i) === true) matched.push(i);
      }
    } catch (e) {
      warnings.push(`Filter "${filterText}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // 2. sequence operations
    const windows = new Map<string, WindowResult>();
    let broken = false;
    for (const dv of group.entries) {
      if (!dv.window) continue;
      const w = computeWindow(dv, matched);
      if (!w) {
        broken = true;
        break;
      }
      windows.set(dv.id, w);
    }
    if (broken) continue;
    const exprs = new Map<string, Expr | null>();
    for (const dv of group.entries) {
      if (dv.window) continue;
      const text = dv.expression.trim();
      if (!text || text === '*') {
        exprs.set(dv.id, null);
        continue;
      }
      let e: Expr;
      try {
        e = parseExpression(text);
      } catch {
        broken = true; // already reported by the check above
        continue;
      }
      exprs.set(dv.id, e);
    }
    if (broken) continue;

    /** Per-row value before aggregation, and the rows it drew on. */
    const rowValue = (dv: Derivation, i: number): { value: Value; from: number[]; text: string } => {
      const w = windows.get(dv.id);
      if (w) return { value: w.values.get(i) ?? null, from: [i, ...(w.neighbours.get(i) ?? [])], text: w.explain.get(i) ?? '' };
      const e = exprs.get(dv.id);
      if (!e || isStar(e)) return { value: null, from: [i], text: '' };
      const value = evalAt(e, i);
      return { value, from: [i], text: formatValue(value) };
    };

    const aggregated = group.groupBy.length > 0 || group.entries.some((dv) => dv.aggregate);
    let produced = 0;
    try {
      if (aggregated) {
        const keyExprs = group.groupBy.map((k) => parseOr(k, `Group key "${k}"`));
        if (keyExprs.some((k) => !k)) continue;
        // Group keys that name a target column are carried over unless a derivation fills that column.
        const explicit = new Set(group.entries.map((dv) => dv.targetColumnId));
        const carried = group.groupBy
          .map((k, n) => {
            const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k.trim()) ? k.trim() : null;
            const col = bare ? schema.column(tgt.id, bare) : undefined;
            return col && !explicit.has(col.id) ? { n, column: col } : null;
          })
          .filter((x): x is { n: number; column: Column } => Boolean(x));
        const buckets = new Map<string, { keys: Value[]; rows: number[] }>();
        for (const i of matched) {
          const keys = keyExprs.map((k) => evalAt(k!, i));
          const bucketKey = JSON.stringify(keys.map(formatValue));
          if (!buckets.has(bucketKey)) buckets.set(bucketKey, { keys, rows: [] });
          buckets.get(bucketKey)!.rows.push(i);
        }
        if (!group.groupBy.length && !buckets.size) buckets.set('[]', { keys: [], rows: [] });
        for (const bucket of buckets.values()) {
          const out: SimRow = {};
          const explain: string[] = [];
          const from = new Set<number>(bucket.rows);
          if (group.groupBy.length) {
            explain.push(`Group: ${group.groupBy.map((k, n) => `${k} = ${formatValue(bucket.keys[n])}`).join(', ')} (${bucket.rows.length} of ${srcRows.length} ${tableLabel(src)} rows${filterText ? `, WHERE ${filterText}` : ''})`);
          } else explain.push(`All ${bucket.rows.length} ${tableLabel(src)} rows${filterText ? ` WHERE ${filterText}` : ''} in one group`);
          for (const { n, column } of carried) {
            out[column.id] = bucket.keys[n];
            writes.add(column.id);
            explain.push(`${column.name} = ${group.groupBy[n]} (group key) = ${formatValue(bucket.keys[n])}`);
          }
          for (const dv of group.entries) {
            const name = targetName(dv);
            const e = exprs.get(dv.id);
            const countAll = dv.aggregate === 'COUNT' && !dv.window && (!e || isStar(e));
            if (dv.aggregate) {
              const parts = bucket.rows.map((i) => rowValue(dv, i));
              for (const part of parts) for (const f of part.from) from.add(f);
              const v = countAll ? bucket.rows.length : aggregate(dv.aggregate, parts.map((x) => x.value), false);
              out[dv.targetColumnId] = v;
              const shown = parts.slice(0, 8).map((x, k) => (dv.window ? `${formatValue(x.value)}` : `${rowNo(bucket.rows[k])}: ${x.text || formatValue(x.value)}`));
              explain.push(
                `${name} = ${derivationValue(dv)} over ${bucket.rows.length} row${bucket.rows.length === 1 ? '' : 's'}${countAll ? '' : ` [${shown.join(', ')}${parts.length > 8 ? ', …' : ''}]`} = ${formatValue(v)}`,
              );
            } else {
              const first = bucket.rows[0];
              const part = first === undefined ? { value: null, from: [], text: '' } : rowValue(dv, first);
              out[dv.targetColumnId] = part.value;
              explain.push(`${name} = ${derivationRowValue(dv)} on the group's first row ${first === undefined ? '' : rowNo(first)} = ${formatValue(part.value)}`);
            }
            writes.add(dv.targetColumnId);
          }
          tgtRows.push(out);
          tgtOrigins.push({ stage: stageIndex, sourceRows: [...from].sort((a, b) => a - b), explain });
          produced++;
          for (const i of bucket.rows) matchedAll.add(i);
        }
      } else {
        for (const i of matched) {
          const out: SimRow = {};
          const explain: string[] = [];
          const from = new Set<number>([i]);
          explain.push(`From ${tableLabel(src)} row ${rowNo(i)}${filterText ? ` (passes WHERE ${filterText})` : ''}`);
          for (const dv of group.entries) {
            const part = rowValue(dv, i);
            for (const f of part.from) from.add(f);
            out[dv.targetColumnId] = part.value;
            writes.add(dv.targetColumnId);
            explain.push(`${targetName(dv)} = ${derivationRowValue(dv)}${dv.window ? `: ${part.text}` : ` = ${formatValue(part.value)}`}`);
          }
          tgtRows.push(out);
          tgtOrigins.push({ stage: stageIndex, sourceRows: [...from].sort((a, b) => a - b), explain });
          produced++;
          matchedAll.add(i);
        }
      }
    } catch (e) {
      warnings.push(`${group.entries.map((dv) => derivationSummary(dv, targetName(dv))).join('; ')}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    groupsOut.push({
      summaries: group.entries.map((dv) => derivationSummary(dv, targetName(dv))),
      filter: filterText,
      groupBy: derivationGroupBy(group.entries[0]),
      matched,
      produced,
      aggregated,
    });
  }

  // Columns nothing wrote: ids are handed out like the database would, the rest stay NULL.
  const pk = tgt.columns.filter((c) => c.primaryKey);
  for (const c of tgt.columns) {
    if (writes.has(c.id)) continue;
    const isSerial = c.autoIncrement || (pk.length === 1 && pk[0].id === c.id && /INT|SERIAL/i.test(c.type));
    if (!isSerial) continue;
    for (let i = start; i < tgtRows.length; i++) {
      if (tgtRows[i][c.id] === undefined) {
        tgtRows[i][c.id] = i + 1;
        tgtOrigins[i]?.explain.push(`${c.name} = ${i + 1} (generated id)`);
      }
    }
    if (tgtRows.length > start) writes.add(c.id);
  }
  for (let i = start; i < tgtRows.length; i++) for (const c of tgt.columns) if (tgtRows[i][c.id] === undefined) tgtRows[i][c.id] = null;

  return {
    index: stageIndex,
    relationshipId: r.id,
    sourceTableId: src.id,
    targetTableId: tgt.id,
    label,
    matchedRows: [...matchedAll].sort((a, b) => a - b),
    producedRange: [start, tgtRows.length],
    reads: [...reads.values()],
    writes: [...writes],
    lookupTableIds: [...(lookups?.tableIds ?? [])],
    lookupRelationshipIds: [...(lookups?.relationshipIds ?? [])],
    groups: groupsOut,
    warnings: [...new Set(warnings)],
  };
}
