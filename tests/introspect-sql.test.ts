/**
 * Runs the server's PostgreSQL catalog queries against a real PostgreSQL.
 *
 * These queries are the only part of the app that cannot be exercised by
 * calling a function: they are strings handed to a database, so nothing but a
 * database can say whether they are valid. That is not theoretical — the first
 * versions of two of them referenced a column that does not exist and put a
 * LIMIT somewhere that needed LATERAL, and both looked completely fine.
 *
 * PGlite is PostgreSQL compiled to WebAssembly, so this is the real planner and
 * the real system catalogs, with several contrib extensions available to install
 * and then read back — which is exactly what the queries are for.
 *
 * The queries are imported from the driver rather than copied, so a change there
 * is a change to what this test runs. (An earlier version of this file scraped
 * them out of the source text instead, which quietly tested a *different* string
 * — source text has not been through TypeScript's escape processing, so the
 * backslash in a LIKE pattern arrived doubled.)
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { EXTENSION_QUERIES } from '../server/db/postgres';

/** Contrib extensions PGlite ships, chosen to cover every column the queries read. */
const CONTRIB = ['citext', 'hstore', 'ltree', 'cube', 'earthdistance', 'pg_trgm', 'btree_gist'] as const;

let db: PGlite;

beforeAll(async () => {
  const extensions: Record<string, unknown> = {};
  for (const name of CONTRIB) {
    const mod = (await import(`@electric-sql/pglite/contrib/${name}`)) as Record<string, unknown>;
    extensions[name] = mod[name] ?? Object.values(mod)[0];
  }
  db = new PGlite({ extensions: extensions as never });
  for (const name of CONTRIB) await db.query(`CREATE EXTENSION IF NOT EXISTS ${name}`);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('the PostgreSQL extension queries', () => {
  it('lists what the server has available, installed or not', async () => {
    const rows = (await db.query(EXTENSION_QUERIES.available)).rows as { name: string; default_version: string | null; installed_version: string | null }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('citext');
    expect(names).toContain('plpgsql');
    expect(rows.find((r) => r.name === 'citext')?.installed_version).toBeTruthy();
  });

  it('reads what each extension depends on', async () => {
    const rows = (await db.query(EXTENSION_QUERIES.requires)).rows as { name: string; requires: string[] | null }[];
    // The dependency lives on the version rows and has to be joined back to the
    // default version, which is the bug this test exists for.
    expect(rows.find((r) => r.name === 'earthdistance')?.requires).toEqual(['cube']);
  });

  it('reads back the objects an installed extension created', async () => {
    const rows = (await db.query(EXTENSION_QUERIES.installed)).rows as {
      name: string;
      version: string;
      schema: string;
      types: string[] | null;
      functions: string[] | null;
      function_count: number | string;
      index_methods: string[] | null;
      operator_classes: string[] | null;
    }[];
    const by = new Map(rows.map((r) => [r.name, r]));

    const citext = by.get('citext');
    expect(citext?.types).toContain('citext');
    expect(citext?.schema).toBeTruthy();
    expect(Number(citext?.function_count)).toBeGreaterThan(0);

    // ltree brings three types someone would actually type into a column.
    expect(by.get('ltree')?.types).toEqual(expect.arrayContaining(['ltree', 'lquery', 'ltxtquery']));

    // pg_trgm adds operator classes but no access method of its own: gin and
    // gist are PostgreSQL's. This is what indexMethods is supposed to mean.
    expect(by.get('pg_trgm')?.operator_classes).toEqual(expect.arrayContaining(['gin_trgm_ops', 'gist_trgm_ops']));
    expect(by.get('pg_trgm')?.index_methods).toBeNull();

    // Array types (leading underscore) are noise and must not be reported.
    for (const row of rows) expect((row.types ?? []).filter((t) => t.startsWith('_'))).toEqual([]);

    // The function list is capped; the count is not.
    for (const row of rows) expect((row.functions ?? []).length).toBeLessThanOrEqual(40);
    expect(Number(by.get('btree_gist')?.function_count)).toBeGreaterThan(40);
  });

  it('lists the extensions a schema import should carry with it', async () => {
    const rows = (await db.query(EXTENSION_QUERIES.forImport)).rows as { name: string; schema: string; version: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('citext');
    // Every database has plpgsql, so listing it would only add noise.
    expect(names).not.toContain('plpgsql');
  });
});
