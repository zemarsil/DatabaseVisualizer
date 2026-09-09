/**
 * Turning what a live server reports into definitions the app can use.
 *
 * This is the answer to "where do extension definitions come from?" that needs
 * no hard-coded list and no download: a server that has an extension installed
 * already knows exactly which types, functions, index methods and operator
 * classes it brought with it, and will say so if you read its catalogs
 * (server/db/postgres.ts does the reading). Anything the app has guessed about
 * that extension loses to this, because this is the ground truth for the server
 * the schema is actually going to run on.
 *
 * The definitions are kept for the session by the registry. Exporting them as a
 * pack is how they survive a reload, or reach a machine with no such server.
 */
import type { DatabaseExtension, Dialect, ExtensionDef, ExtensionsResponse } from '@shared/types';
import type { ExtensionPack } from './packs';

/**
 * A summary line for an extension the server described but did not name well.
 * PostgreSQL's own `comment` column is usually a decent one-liner already.
 */
function summaryFor(e: DatabaseExtension): string | undefined {
  if (e.comment) return e.comment;
  const bits: string[] = [];
  if (e.types?.length) bits.push(`${e.types.length} type${e.types.length === 1 ? '' : 's'}`);
  if (e.functionCount) bits.push(`${e.functionCount} function${e.functionCount === 1 ? '' : 's'}`);
  if (e.indexMethods?.length) bits.push(`index methods: ${e.indexMethods.join(', ')}`);
  return bits.length ? `Provides ${bits.join(', ')}.` : undefined;
}

/** One reported extension as a definition. Only installed ones can describe what they provide. */
export function toExtensionDef(e: DatabaseExtension, dialect: Dialect): ExtensionDef {
  return {
    name: e.name,
    dialect,
    summary: summaryFor(e),
    types: e.types?.length ? e.types.map((name) => ({ name })) : undefined,
    functions: e.functions?.length ? e.functions.map((name) => ({ name, example: `${name}()` })) : undefined,
    indexMethods: e.indexMethods?.length ? e.indexMethods : undefined,
    operatorClasses: e.operatorClasses?.length ? e.operatorClasses : undefined,
    requires: e.requires?.length ? e.requires : undefined,
    note:
      e.functionCount && e.functions && e.functionCount > e.functions.length
        ? `Read from a live server. ${e.functions.length} of its ${e.functionCount} functions are listed.`
        : 'Read from a live server.',
    source: 'database',
  };
}

/**
 * Definitions worth keeping from one server's answer.
 *
 * Only installed extensions are turned into definitions: an available-but-not-
 * installed one has nothing to say about its types, and a definition with no
 * content would only shadow a better bundled one. The available list is still
 * useful to the UI as a list of names to offer.
 */
export function definitionsFromDatabase(res: ExtensionsResponse, dialect: Dialect): ExtensionDef[] {
  return res.extensions.filter((e) => e.installed).map((e) => toExtensionDef(e, dialect));
}

/** Everything the server could install, installed or not — the names the picker offers. */
export function availableNames(res: ExtensionsResponse): string[] {
  return res.extensions.map((e) => e.name);
}

/** Package a server's installed extensions as a pack, so they outlive the session. */
export function packFromDatabase(res: ExtensionsResponse, dialect: Dialect, label: string): ExtensionPack {
  const defs = definitionsFromDatabase(res, dialect);
  const id = `db:${dialect}:${label}`;
  return {
    id,
    name: `Extensions on ${label}`,
    description: `Read from ${res.serverVersion}. ${defs.length} installed extension${defs.length === 1 ? '' : 's'}.`,
    origin: label,
    loadedAt: new Date().toISOString(),
    extensions: defs.map((d) => ({ ...d, source: 'pack' as const, packId: id })),
  };
}
