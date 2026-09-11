/**
 * Programs: the reasoning about work that happens outside the database.
 *
 * A program's connections to tables are never stored. They are derived from its
 * ordered steps, exactly as a group's rectangle is derived from its member
 * tables, and for the same reason: the two can then never drift apart. Reorder
 * a step and its arrow moves with it; delete a step and the arrow goes; there
 * is no way to end up with an edge that means nothing.
 *
 * This file is also where "does this program actually go back and forth with
 * that table" is answered, since the answer is a fact about the step list and
 * several parts of the app want it phrased the same way.
 */
import {
  programLanguageMeta,
  programRoleMeta,
  type Diagram,
  type Program,
  type ProgramStep,
  type ProgramStepOp,
  type Table,
} from '@shared/types';
import { estimateNodeSize } from './geometry';

/** Width the program node is laid out and routed at before React Flow measures it. */
export const PROGRAM_WIDTH = 260;
export const PROGRAM_HEADER_HEIGHT = 44;
export const PROGRAM_STEP_HEIGHT = 26;
export const PROGRAM_FOOTER_HEIGHT = 10;
/** Height of the "no steps yet" line, so an empty node is still a target you can hit. */
export const PROGRAM_EMPTY_HEIGHT = 30;

export function estimateProgramSize(p: Program): { width: number; height: number } {
  const rows = p.steps.length ? p.steps.length * PROGRAM_STEP_HEIGHT : PROGRAM_EMPTY_HEIGHT;
  return { width: PROGRAM_WIDTH, height: PROGRAM_HEADER_HEIGHT + rows + PROGRAM_FOOTER_HEIGHT };
}

/** Vertical centre of a step row, relative to the node's top. */
export function stepCenterY(index: number): number {
  return PROGRAM_HEADER_HEIGHT + index * PROGRAM_STEP_HEIGHT + PROGRAM_STEP_HEIGHT / 2;
}

/**
 * One arrow between a program and a table, derived from one step.
 *
 * `step` is the 1-based position in the program, which is what the edge shows:
 * the numbers are how a round trip reads off the canvas without anyone having
 * to open the inspector.
 */
export interface ProgramLink {
  /** Stable across renders and unique per step, so React Flow can key on it. */
  id: string;
  programId: string;
  stepId: string;
  tableId: string;
  /** Never 'compute': a compute step touches no table and so draws no arrow. */
  op: Exclude<ProgramStepOp, 'compute'>;
  /** 1-based index of the step within the program. */
  step: number;
  columnIds: string[];
}

export function programLinkId(programId: string, stepId: string): string {
  return `${programId}|${stepId}`;
}

/**
 * Every arrow a program draws. Steps naming a table that is not in the diagram
 * are skipped rather than drawn to nowhere; the linter reports those, so they
 * are neither lost nor silently rendered as a dangling edge.
 */
export function programLinks(d: Diagram, tableIds?: ReadonlySet<string>): ProgramLink[] {
  const known = tableIds ?? new Set(d.tables.map((t) => t.id));
  const out: ProgramLink[] = [];
  for (const p of d.programs) {
    p.steps.forEach((s, i) => {
      if (s.op === 'compute' || !s.tableId || !known.has(s.tableId)) return;
      out.push({
        id: programLinkId(p.id, s.id),
        programId: p.id,
        stepId: s.id,
        tableId: s.tableId,
        op: s.op,
        step: i + 1,
        columnIds: s.columnIds,
      });
    });
  }
  return out;
}

/** Ids of tables a program reads or writes, in the order its steps first reach them. */
export function programTableIds(p: Program): string[] {
  const out: string[] = [];
  for (const s of p.steps) {
    if (s.op === 'compute' || !s.tableId) continue;
    if (!out.includes(s.tableId)) out.push(s.tableId);
  }
  return out;
}

/**
 * Tables this program both reads and writes: the actual back and forth, as
 * opposed to a one-way feed. "Reads and writes jobs" is the sentence a reader
 * wants, and counting arrows by hand is not.
 */
export function programRoundTrips(p: Program): string[] {
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const s of p.steps) {
    if (!s.tableId || s.op === 'compute') continue;
    (s.op === 'read' ? reads : writes).add(s.tableId);
  }
  return [...reads].filter((id) => writes.has(id));
}

/** The programs that touch a given table, in diagram order. */
export function programsForTable(d: Diagram, tableId: string): Program[] {
  return d.programs.filter((p) => p.steps.some((s) => s.op !== 'compute' && s.tableId === tableId));
}

/** Table ids that any program touches, for dimming everything else when one is selected. */
export function programReach(p: Program): Set<string> {
  return new Set(programTableIds(p));
}

/**
 * One line describing a step, the way the node and the exports both want it:
 * "read orders (id, status)", "compute", "write daily_totals".
 */
export function describeStep(s: ProgramStep, table: Table | undefined): string {
  if (s.op === 'compute') return s.note?.trim() ? `compute — ${s.note.trim()}` : 'compute';
  const name = table?.name ?? '(missing table)';
  const cols = s.columnIds.map((id) => table?.columns.find((c) => c.id === id)?.name).filter(Boolean);
  return `${s.op} ${name}${cols.length ? ` (${cols.join(', ')})` : ''}`;
}

/**
 * One sentence for the whole program: what it is, and what it does to which
 * tables. Used by the node's tooltip, the Markdown export and the linter's
 * messages, so all three phrase it identically.
 */
export function describeProgram(d: Diagram, p: Program): string {
  const byId = new Map(d.tables.map((t) => [t.id, t]));
  const name = (id: string) => byId.get(id)?.name ?? '?';
  const roundTrips = programRoundTrips(p).map(name);
  const reads: string[] = [];
  const writes: string[] = [];
  for (const id of programTableIds(p)) {
    if (roundTrips.includes(name(id))) continue;
    const ops = p.steps.filter((s) => s.tableId === id).map((s) => s.op);
    if (ops.includes('read')) reads.push(name(id));
    else if (ops.includes('write')) writes.push(name(id));
  }
  const kind = p.role ? programRoleMeta(p.role).label.toLowerCase() : programLanguageMeta(p.language).label;
  const clauses: string[] = [];
  if (roundTrips.length) clauses.push(`reads and writes ${roundTrips.join(', ')}`);
  if (reads.length) clauses.push(`reads ${reads.join(', ')}`);
  if (writes.length) clauses.push(`writes ${writes.join(', ')}`);
  const computes = p.steps.filter((s) => s.op === 'compute').length;
  if (computes) clauses.push(`${computes} step${computes === 1 ? '' : 's'} of work outside the database`);
  return clauses.length ? `${p.name}, a ${kind}, ${clauses.join('; ')}.` : `${p.name}, a ${kind}, does not touch the schema yet.`;
}

/** A free spot for a new program, below everything already placed. */
export function nextProgramPosition(d: Diagram): { x: number; y: number } {
  let minX = Infinity;
  let maxY = -Infinity;
  for (const t of d.tables) {
    const size = estimateNodeSize(t.columns);
    minX = Math.min(minX, t.position.x);
    maxY = Math.max(maxY, t.position.y + size.height);
  }
  for (const p of d.programs) {
    minX = Math.min(minX, p.position.x);
    maxY = Math.max(maxY, p.position.y + estimateProgramSize(p).height);
  }
  if (!Number.isFinite(maxY)) return { x: 80, y: 80 };
  return { x: Math.round(Number.isFinite(minX) ? minX : 80), y: Math.round(maxY + 90) };
}
