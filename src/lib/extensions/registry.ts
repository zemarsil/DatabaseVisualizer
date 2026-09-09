/**
 * The one place the rest of the app asks "what is this extension, and what does
 * it give me?".
 *
 * Three sources are merged, and later ones win over earlier ones for the same
 * (dialect, name):
 *
 *   1. bundled   — shipped with the app, always available, never authoritative
 *   2. pack      — a JSON file the user loaded from disk or a URL
 *   3. database  — read back off a live server, which *is* authoritative for
 *                  that server and so overrides both
 *
 * That order is the whole design: guesses lose to what someone chose, and both
 * lose to what a real server reports.
 *
 * The registry is a module-level cache rather than store state because it is
 * read from pure functions (the generator, the linter) that have no store, and
 * because it changes only when the user loads or drops a pack.
 */
import type { Diagram, DiagramExtension, Dialect, ExtensionDef, Table } from '@shared/types';
import { TYPE_SUGGESTIONS } from '../sql/dialect';
import { BUNDLED_EXTENSIONS } from './bundled';
import { loadPacks, removePack, savePack, type ExtensionPack } from './packs';

const key = (dialect: Dialect, name: string) => `${dialect}:${name.trim().toLowerCase()}`;

let packs: ExtensionPack[] | null = null;
/** Definitions learned from a live database this session; not persisted. */
let learned: ExtensionDef[] = [];
let merged: Map<string, ExtensionDef> | null = null;
const listeners = new Set<() => void>();

function currentPacks(): ExtensionPack[] {
  if (!packs) packs = loadPacks();
  return packs;
}

function rebuild(): Map<string, ExtensionDef> {
  const out = new Map<string, ExtensionDef>();
  for (const def of BUNDLED_EXTENSIONS) out.set(key(def.dialect, def.name), def);
  for (const pack of currentPacks()) for (const def of pack.extensions) out.set(key(def.dialect, def.name), def);
  for (const def of learned) out.set(key(def.dialect, def.name), def);
  return out;
}

function index(): Map<string, ExtensionDef> {
  if (!merged) merged = rebuild();
  return merged;
}

function invalidate(): void {
  merged = null;
  for (const l of listeners) l();
}

/** Notified whenever the merged catalog changes (a pack loaded, dropped, or learned from a server). */
export function subscribeToExtensionCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every definition known for one engine, sorted by display name. */
export function extensionDefs(dialect: Dialect): ExtensionDef[] {
  return [...index().values()]
    .filter((d) => d.dialect === dialect)
    .sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name));
}

/** The definition for one extension, or undefined when nothing has taught the app about it yet. */
export function findExtensionDef(name: string, dialect: Dialect): ExtensionDef | undefined {
  return index().get(key(dialect, name));
}

export function extensionLabel(def: ExtensionDef): string {
  return def.label ?? def.name;
}

/** How the generator should enable it: the definition's own answer, or the engine's default. */
export function installMethod(def: ExtensionDef | undefined, dialect: Dialect): ExtensionDef['install'] {
  if (def?.install) return def.install;
  if (dialect === 'postgresql') return 'create-extension';
  if (dialect === 'mariadb') return 'install-soname';
  return 'client-loaded';
}

/* ------------------------------------------------------------------ */
/* Packs                                                               */
/* ------------------------------------------------------------------ */

export function extensionPacks(): ExtensionPack[] {
  return currentPacks();
}

export function addExtensionPack(pack: ExtensionPack): void {
  packs = savePack(pack);
  invalidate();
}

export function dropExtensionPack(id: string): void {
  packs = removePack(id);
  invalidate();
}

/**
 * Definitions read off a live server. They outrank packs and bundled entries for
 * the rest of the session but are not persisted: they describe *that* server,
 * and the next one may have a different set. Export them as a pack to keep them.
 */
export function setLearnedExtensions(defs: ExtensionDef[]): void {
  learned = defs.map((d) => ({ ...d, source: 'database' as const }));
  invalidate();
}

export function learnedExtensions(): ExtensionDef[] {
  return learned;
}

export function clearLearnedExtensions(): void {
  if (!learned.length) return;
  learned = [];
  invalidate();
}

/** Reset every source. Tests use this so one test's packs cannot leak into the next. */
export function resetExtensionRegistry(): void {
  packs = null;
  learned = [];
  invalidate();
}

/* ------------------------------------------------------------------ */
/* Questions the app asks about a diagram                              */
/* ------------------------------------------------------------------ */

/** Definitions for the extensions a diagram actually enables, in the diagram's order. */
export function enabledDefs(d: Diagram): { name: string; def: ExtensionDef | undefined }[] {
  return d.extensions.map((e) => ({ name: e.name, def: findExtensionDef(e.name, d.dialect) }));
}

/** Strip the arguments and array markers off a column type: "vector(1536)[]" -> "vector". */
export function baseTypeName(type: string): string {
  return type
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\(.*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Every extension known to provide a type of this name, whether or not the
 * diagram enables it. This is what lets the linter say "vector(1536) needs the
 * pgvector extension" instead of shrugging at an unknown type.
 */
export function extensionsProvidingType(typeName: string, dialect: Dialect): ExtensionDef[] {
  const base = baseTypeName(typeName);
  if (!base) return [];
  return extensionDefs(dialect).filter((def) => (def.types ?? []).some((t) => t.name.toLowerCase() === base));
}

/** Type names contributed by the extensions this diagram enables, ready for a datalist. */
export function extensionTypeSuggestions(d: Diagram): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { def } of enabledDefs(d)) {
    for (const t of def?.types ?? []) {
      // The example is what people actually type ("vector(1536)"), so offer it
      // first and the bare name after, unless they are the same string.
      for (const candidate of [t.example, t.name]) {
        if (!candidate) continue;
        const k = candidate.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(candidate);
      }
    }
  }
  return out;
}

/**
 * Every type worth offering for a column in this diagram: the dialect's own
 * types first, then whatever the enabled extensions add. Callers that also want
 * the diagram's custom types append those themselves, since only the UI knows
 * how to label them.
 */
export function typeSuggestions(d: Diagram): string[] {
  return [...TYPE_SUGGESTIONS[d.dialect], ...extensionTypeSuggestions(d)];
}

/** Function call examples contributed by the enabled extensions, for DEFAULT autocomplete. */
export function extensionFunctionSuggestions(d: Diagram): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { def } of enabledDefs(d)) {
    for (const f of def?.functions ?? []) {
      const candidate = f.example ?? `${f.name}()`;
      const k = candidate.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Text from just these tables, in the same spirit as diagramText: what a copy of
 * them would need to keep working on its own.
 */
function tablesText(tables: Table[]): string {
  const parts: string[] = [];
  for (const t of tables) {
    if (t.viewSql) parts.push(t.viewSql);
    parts.push(...t.checks);
    for (const c of t.columns) {
      parts.push(c.type);
      if (c.defaultValue) parts.push(c.defaultValue);
      if (c.check) parts.push(c.check);
    }
  }
  return parts.join('\n').toLowerCase();
}

/**
 * The diagram's extensions that these tables actually depend on — what has to
 * travel with them when they are copied out or exported on their own. The same
 * rule as customTypesUsedBy, one level up.
 */
export function extensionsUsedBy(d: Diagram, tables: Table[]): DiagramExtension[] {
  const text = tablesText(tables);
  return d.extensions.filter((e) => {
    const def = findExtensionDef(e.name, d.dialect);
    // Nothing known about it: it was declared on purpose, so keep it rather than
    // silently dropping a dependency the copy might need.
    if (!def) return true;
    return extensionIsUsed(d, def, text);
  });
}

/**
 * All the text in a diagram where an extension's name could plausibly be used:
 * column types and defaults, checks, view bodies, tagged queries and notes.
 * Used to answer "is this extension pulling its weight?".
 */
export function diagramText(d: Diagram): string {
  const parts: string[] = [];
  for (const t of d.tables) {
    if (t.viewSql) parts.push(t.viewSql);
    parts.push(...t.checks);
    for (const c of t.columns) {
      parts.push(c.type);
      if (c.defaultValue) parts.push(c.defaultValue);
      if (c.check) parts.push(c.check);
    }
  }
  for (const r of d.relationships) {
    if (r.query) parts.push(r.query);
    if (r.note) parts.push(r.note);
    for (const dv of r.derivations ?? []) {
      parts.push(dv.expression, ...dv.groupBy);
      if (dv.filter) parts.push(dv.filter);
    }
  }
  for (const ct of d.customTypes) for (const f of ct.fields ?? []) parts.push(f.type);
  for (const n of d.notes) parts.push(n.text);
  return parts.join('\n').toLowerCase();
}

/**
 * Whether anything in the diagram appears to use what this extension provides.
 * Deliberately generous — a mention anywhere counts — because the point is to
 * catch an extension nobody uses at all, not to audit every reference.
 */
export function extensionIsUsed(d: Diagram, def: ExtensionDef, text = diagramText(d)): boolean {
  const names = [
    ...(def.types ?? []).map((t) => t.name),
    ...(def.functions ?? []).map((f) => f.name),
    ...(def.operatorClasses ?? []),
    ...(def.indexMethods ?? []),
  ];
  // An extension that provides nothing nameable (pg_stat_statements, a storage
  // engine) can never be shown to be unused, so it never counts as unused.
  if (names.length === 0) return true;
  return names.some((n) => new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}
