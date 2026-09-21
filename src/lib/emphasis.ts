/**
 * What a diagram is about.
 *
 * This app draws two things that happen to fit on one canvas: a schema (tables,
 * keys, the SQL that makes them) and a code map (programs, modules, classes,
 * functions, and the steps that run in them). Either one is a whole answer on
 * its own, and the app should not insist you want the other. A code map that
 * never touches a database has no use for a SQL dialect, a Docker container or
 * an Import SQL tab, and putting them on screen anyway tells the reader they
 * have started the wrong app.
 *
 * So a diagram has an emphasis, and the rule is that **what is on the canvas
 * wins**. The stored field only decides the cases the content cannot: an empty
 * canvas, or a canvas holding one side while the author has said they mean both.
 * Nothing is ever removed by an emphasis — the database path stays one click
 * from a code map, and the moment a table lands on the canvas it comes back by
 * itself. That is the whole point: a preference, not a mode you can get stuck
 * in.
 */
import type { Diagram } from '@shared/types';

/**
 * Deliberately an emphasis rather than a mode: it changes what the app leads
 * with, never what it can do. There is no state here you can get stuck in.
 *
 * 'code' — a code map; the database tooling is out of the way.
 * 'data' — a schema; the code map is still offered, because code that talks to
 *          a schema is part of designing one.
 * 'both' — say nothing, show everything.
 */
export type Emphasis = 'code' | 'data' | 'both';

export const EMPHASES: Emphasis[] = ['code', 'data', 'both'];

export function isEmphasis(v: unknown): v is Emphasis {
  return v === 'code' || v === 'data' || v === 'both';
}

/** Nothing has been drawn yet: no tables, no code, no notes, no groups, no types. */
export function isBlankDiagram(d: Diagram): boolean {
  return d.tables.length === 0 && d.programs.length === 0 && d.notes.length === 0 && d.groups.length === 0 && d.customTypes.length === 0 && d.extensions.length === 0;
}

/** Anything at all that an export, a share link or an image could carry. */
export function hasContent(d: Diagram): boolean {
  return !isBlankDiagram(d);
}

/**
 * The emphasis in force, from what is on the canvas and what the author chose.
 *
 * Content wins over the stored choice, in the one direction that can only add:
 * a table on a diagram marked 'code' makes it 'both' rather than hiding the
 * tools that table needs. The stored value is consulted last, so a choice made
 * on an empty canvas survives until the canvas disagrees with it.
 */
export function diagramEmphasis(d: Diagram): Emphasis {
  // 'both' is a decision, not a default, so it outranks the content: someone who
  // asked to mix freely and then drew only code still wanted both sets of tools.
  if (d.emphasis === 'both') return 'both';
  const tables = d.tables.length > 0 || d.customTypes.length > 0 || d.extensions.length > 0;
  const code = d.programs.length > 0;
  if (tables && code) return 'both';
  if (tables) return d.emphasis === 'code' ? 'both' : 'data';
  if (code) return d.emphasis === 'data' ? 'both' : 'code';
  return d.emphasis ?? 'both';
}

/**
 * Whether the schema half of the app is on screen: the dialect picker, the
 * Database, SQL, Import SQL, Types, Query, Derived and Simulate tabs, and
 * everything that generates or runs DDL. False only for a code map.
 */
export function showsDatabaseTools(d: Diagram): boolean {
  return diagramEmphasis(d) !== 'code';
}

/**
 * Whether to offer the opening choice. Only on a canvas with nothing on it and
 * nothing chosen — picking "Blank canvas" writes 'both', which is how the
 * screen is dismissed without being nagged about again.
 */
export function showsStartScreen(d: Diagram): boolean {
  return d.emphasis === undefined && isBlankDiagram(d);
}

/**
 * What is on this diagram, in words: "3 tables and 2 code nodes". For the
 * confirmations that have to say what is about to be lost, which used to count
 * tables alone and so waved a whole code map away without asking.
 *
 * Returns an empty string for a blank diagram; callers guard on `hasContent`
 * first, because "close this, losing nothing" is not a question worth asking.
 */
export function describeContents(d: Diagram): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (d.tables.length) parts.push(plural(d.tables.length, 'table'));
  if (d.programs.length) parts.push(plural(d.programs.length, 'code node'));
  if (d.notes.length) parts.push(plural(d.notes.length, 'note'));
  if (d.customTypes.length) parts.push(plural(d.customTypes.length, 'custom type'));
  // Groups are only worth mentioning when they are all there is; otherwise they
  // are a way of arranging the tables already counted.
  if (!parts.length && d.groups.length) parts.push(plural(d.groups.length, 'group'));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
