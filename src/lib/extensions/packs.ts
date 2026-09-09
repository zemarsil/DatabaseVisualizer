/**
 * Extension packs: definitions loaded from outside the app.
 *
 * A pack is one JSON file describing what a set of extensions provides. It is
 * how the app learns about anything not in the bundled list — a niche
 * extension, an in-house one, a new release of pgvector — without waiting for a
 * new version of this app. Packs come from a file on disk, from a URL, or from
 * introspecting a live server (src/lib/extensions/fromDatabase.ts builds one).
 *
 * The format is documented in docs/EXTENSION_PACK_FORMAT.md, with an example in
 * docs/examples/. Everything here is defensive on purpose: a pack is untrusted
 * input, so a malformed entry is dropped with a message rather than trusted.
 * A pack only ever teaches the app *names and prose* — it can never introduce
 * SQL the generator will run.
 *
 * Loaded packs live in localStorage, not in the diagram: the diagram records
 * only which extensions it uses, so a file stays portable and small (see the
 * comment on DiagramExtension).
 */
import type { Dialect, ExtensionDef, ExtensionFunction, ExtensionInstall, ExtensionType } from '@shared/types';

export const PACK_FORMAT = 'dbviz-extension-pack';
export const PACK_VERSION = 1;

export interface ExtensionPack {
  /** Stable id, used to replace a pack when it is reloaded and to remove it later. */
  id: string;
  name: string;
  description?: string;
  /** Where it came from: a file name, a URL, or the connection it was read off. */
  origin?: string;
  /** ISO date the pack was loaded. */
  loadedAt?: string;
  extensions: ExtensionDef[];
}

export interface PackParseResult {
  pack: ExtensionPack | null;
  errors: string[];
  warnings: string[];
}

const STORAGE_KEY = 'dbviz.extensionPacks';
/** A pack is prose and names; anything this size is not that, and would crowd out other storage. */
const MAX_PACK_BYTES = 2_000_000;

const DIALECTS = new Set<string>(['postgresql', 'mariadb', 'sqlite']);
const INSTALLS = new Set<string>(['create-extension', 'install-soname', 'client-loaded', 'built-in']);

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function textList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(text).filter((x): x is string => Boolean(x));
  return out.length ? out : undefined;
}

function parseTypes(v: unknown): ExtensionType[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ExtensionType[] = [];
  for (const raw of v) {
    // A bare string is allowed as shorthand for { name }, which is what most
    // hand-written packs and everything read off a server actually have.
    if (typeof raw === 'string') {
      const name = raw.trim();
      if (name) out.push({ name });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = text(o.name);
    if (!name) continue;
    out.push({ name, example: text(o.example), summary: text(o.summary) });
  }
  return out.length ? out : undefined;
}

function parseFunctions(v: unknown): ExtensionFunction[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ExtensionFunction[] = [];
  for (const raw of v) {
    if (typeof raw === 'string') {
      const name = raw.trim();
      if (name) out.push({ name });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = text(o.name);
    if (!name) continue;
    out.push({ name, example: text(o.example), summary: text(o.summary) });
  }
  return out.length ? out : undefined;
}

/** One definition from a pack. Returns null (with a reason) when the entry cannot be used. */
function parseDef(raw: unknown, index: number, fallbackDialect: Dialect | undefined, errors: string[]): ExtensionDef | null {
  if (!raw || typeof raw !== 'object') {
    errors.push(`extensions[${index}] is not an object.`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const name = text(o.name);
  if (!name) {
    errors.push(`extensions[${index}] has no "name".`);
    return null;
  }
  const dialectRaw = text(o.dialect) ?? fallbackDialect;
  if (!dialectRaw || !DIALECTS.has(dialectRaw)) {
    errors.push(`extensions[${index}] (${name}): "dialect" must be postgresql, mariadb or sqlite.`);
    return null;
  }
  const install = text(o.install);
  return {
    name,
    dialect: dialectRaw as Dialect,
    label: text(o.label),
    summary: text(o.summary),
    install: install && INSTALLS.has(install) ? (install as ExtensionInstall) : undefined,
    docsUrl: text(o.docsUrl),
    types: parseTypes(o.types),
    functions: parseFunctions(o.functions),
    indexMethods: textList(o.indexMethods),
    operatorClasses: textList(o.operatorClasses),
    requires: textList(o.requires),
    note: text(o.note),
  };
}

/**
 * Read a pack from JSON text. Never throws: a file that cannot be used comes
 * back with `pack: null` and the reasons, so the UI can show them.
 */
export function parseExtensionPack(json: string, opts: { origin?: string; id?: string } = {}): PackParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (json.length > MAX_PACK_BYTES) {
    return { pack: null, errors: [`The file is ${Math.round(json.length / 1000)} kB; extension packs are capped at ${MAX_PACK_BYTES / 1000} kB.`], warnings };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { pack: null, errors: ['The file is not valid JSON.'], warnings };
  }
  if (!raw || typeof raw !== 'object') return { pack: null, errors: ['The file does not contain an extension pack.'], warnings };
  const o = raw as Record<string, unknown>;

  const format = text(o.format);
  if (format && format !== PACK_FORMAT) {
    return { pack: null, errors: [`"format" is "${format}"; an extension pack must say "${PACK_FORMAT}".`], warnings };
  }
  if (!format) warnings.push(`The file has no "format" field; it was read as an extension pack anyway.`);
  if (typeof o.version === 'number' && o.version > PACK_VERSION) {
    warnings.push(`The pack says version ${o.version} and this app reads version ${PACK_VERSION}; anything newer in it was ignored.`);
  }
  if (!Array.isArray(o.extensions)) return { pack: null, errors: ['The pack has no "extensions" array.'], warnings };

  // A pack for a single engine can say so once at the top instead of on every entry.
  const packDialect = text(o.dialect);
  if (packDialect && !DIALECTS.has(packDialect)) {
    return { pack: null, errors: [`"dialect" is "${packDialect}"; it must be postgresql, mariadb or sqlite.`], warnings };
  }

  const id = opts.id ?? text(o.id) ?? `pack-${Date.now().toString(36)}`;
  const defs: ExtensionDef[] = [];
  const seen = new Set<string>();
  o.extensions.forEach((entry, i) => {
    const def = parseDef(entry, i, packDialect as Dialect | undefined, errors);
    if (!def) return;
    // Same extension for the same engine twice in one file: the first wins, so
    // reloading a pack is predictable rather than order-dependent.
    const key = `${def.dialect}:${def.name.toLowerCase()}`;
    if (seen.has(key)) {
      warnings.push(`${def.name} appears twice for ${def.dialect}; the later entry was ignored.`);
      return;
    }
    seen.add(key);
    defs.push({ ...def, source: 'pack', packId: id });
  });

  if (defs.length === 0) return { pack: null, errors: errors.length ? errors : ['The pack has no usable extension definitions.'], warnings };

  return {
    pack: {
      id,
      name: text(o.name) ?? opts.origin ?? 'Extension pack',
      description: text(o.description),
      origin: opts.origin,
      loadedAt: new Date().toISOString(),
      extensions: defs,
    },
    errors,
    warnings,
  };
}

/** Write a pack back out in the documented format (for exporting what a database taught us). */
export function serializeExtensionPack(pack: ExtensionPack): string {
  return JSON.stringify(
    {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      id: pack.id,
      name: pack.name,
      ...(pack.description ? { description: pack.description } : {}),
      extensions: pack.extensions.map(({ source: _source, packId: _packId, ...def }) => def),
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private-mode browsers throw on access rather than returning null.
    return null;
  }
}

/** Packs the user has loaded, oldest first. Bad or absent storage reads as none. */
export function loadPacks(): ExtensionPack[] {
  const store = storage();
  if (!store) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ExtensionPack[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const id = text(o.id);
    if (!id || !Array.isArray(o.extensions)) continue;
    const errors: string[] = [];
    const defs = o.extensions
      .map((e, i) => parseDef(e, i, undefined, errors))
      .filter((d): d is ExtensionDef => Boolean(d))
      .map((d) => ({ ...d, source: 'pack' as const, packId: id }));
    if (!defs.length) continue;
    out.push({ id, name: text(o.name) ?? id, description: text(o.description), origin: text(o.origin), loadedAt: text(o.loadedAt), extensions: defs });
  }
  return out;
}

function writePacks(packs: ExtensionPack[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(packs));
  } catch {
    // Storage full or blocked: the pack still works for this session, since the
    // registry holds it in memory. Losing it on reload beats losing the app.
  }
}

/** Add a pack, replacing any earlier pack with the same id. Returns the new list. */
export function savePack(pack: ExtensionPack): ExtensionPack[] {
  const packs = loadPacks().filter((p) => p.id !== pack.id);
  packs.push(pack);
  writePacks(packs);
  return packs;
}

export function removePack(id: string): ExtensionPack[] {
  const packs = loadPacks().filter((p) => p.id !== id);
  writePacks(packs);
  return packs;
}
