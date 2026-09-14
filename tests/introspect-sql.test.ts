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
import { EXTENSION_QUERIES, INTROSPECT_QUERIES, textArray } from '../server/db/postgres';

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

/**
 * Array columns PostgreSQL hands back as `name[]` (OID 1003) rather than
 * `text[]` (1009). node-postgres has no parser registered for 1003, so such a
 * column arrives as the raw literal `{id,customer_id}` where the response type
 * promises `string[]`, and the browser calls .map on a string three layers
 * later. PGlite parses `name[]` anyway, so no assertion about the *values* can
 * see this: only the column's type can.
 */
const NAME_ARRAY = 1003;
const TEXT_ARRAY = 1009;

describe('the PostgreSQL introspection queries', () => {
  beforeAll(async () => {
    await db.query(`CREATE TYPE mood AS ENUM ('ok', 'great')`);
    await db.query(`CREATE TABLE customers (id serial PRIMARY KEY, email text UNIQUE, feeling mood)`);
    await db.query(`CREATE TABLE orders (
       id serial PRIMARY KEY,
       customer_id int REFERENCES customers (id),
       placed_at timestamptz,
       UNIQUE (customer_id, placed_at))`);
    await db.query(`CREATE INDEX idx_orders_customer ON orders (customer_id, placed_at)`);
    await db.query(`CREATE VIEW recent_orders AS SELECT id, customer_id FROM orders`);
  }, 30_000);

  it('runs, and every one of them answers', async () => {
    for (const [name, sql] of Object.entries(INTROSPECT_QUERIES)) {
      const res = await db.query(sql);
      expect(res.fields.length, `${name} returned no columns`).toBeGreaterThan(0);
    }
  });

  it('never returns an array the driver cannot parse', async () => {
    // Both the import queries and the extension ones: a name[] anywhere is a
    // crash in the browser against a real server, and silence under this test.
    for (const [name, sql] of Object.entries({ ...INTROSPECT_QUERIES, ...EXTENSION_QUERIES })) {
      for (const f of (await db.query(sql)).fields) {
        expect(f.dataTypeID, `${name}.${f.name} comes back as name[]; cast it to text`).not.toBe(NAME_ARRAY);
      }
    }
  });

  it("reads a table's keys, its uniques and its foreign keys as arrays of column names", async () => {
    const res = await db.query(INTROSPECT_QUERIES.constraints);
    const rows = res.rows as { table: string; type: string; columns: string[]; ref_table: string | null; ref_columns: string[] | null }[];
    for (const f of res.fields) if (f.name === 'columns' || f.name === 'ref_columns') expect(f.dataTypeID).toBe(TEXT_ARRAY);

    const pk = rows.find((r) => r.table === 'orders' && r.type === 'p');
    expect(pk?.columns).toEqual(['id']);
    const uq = rows.find((r) => r.table === 'orders' && r.type === 'u');
    expect(uq?.columns).toEqual(['customer_id', 'placed_at']);
    const fk = rows.find((r) => r.table === 'orders' && r.type === 'f');
    expect(fk?.columns).toEqual(['customer_id']);
    expect(fk?.ref_table).toBe('customers');
    expect(fk?.ref_columns).toEqual(['id']);
  });

  it("reads an index's columns in order, skipping the ones a constraint already owns", async () => {
    const res = await db.query(INTROSPECT_QUERIES.indexes);
    const rows = res.rows as { table: string; name: string; unique: boolean; columns: string[] }[];
    for (const f of res.fields) if (f.name === 'columns') expect(f.dataTypeID).toBe(TEXT_ARRAY);

    const ix = rows.find((r) => r.name === 'idx_orders_customer');
    expect(ix?.columns).toEqual(['customer_id', 'placed_at']);
    expect(ix?.unique).toBe(false);
    // The UNIQUE constraint has an index behind it, but it is reported as a
    // constraint, so it must not be reported twice.
    expect(rows.some((r) => r.table === 'orders' && r.columns.join() === 'customer_id,placed_at' && r.unique)).toBe(false);
  });

  it("reads an enum's values in their declared order", async () => {
    const res = await db.query(INTROSPECT_QUERIES.enums);
    for (const f of res.fields) if (f.name === 'values') expect(f.dataTypeID).toBe(TEXT_ARRAY);
    const rows = res.rows as { name: string; values: string[] }[];
    expect(rows.find((r) => r.name === 'mood')?.values).toEqual(['ok', 'great']);
  });

  it('marks a view as one and brings its SELECT with it', async () => {
    const rows = (await db.query(INTROSPECT_QUERIES.tables)).rows as { name: string; relkind: string; view_sql: string | null }[];
    expect(rows.find((r) => r.name === 'orders')?.relkind).toBe('r');
    const view = rows.find((r) => r.name === 'recent_orders');
    expect(view?.relkind).toBe('v');
    expect(view?.view_sql).toMatch(/SELECT/i);
  });
});

describe('an array column that arrived unparsed', () => {
  // The queries ask for text[] so this never happens; this is the promise the
  // module keeps anyway, because a string where a string[] was declared does
  // not fail here — it fails in the browser, later, saying nothing useful.
  it('reads the literal PostgreSQL sends when the driver leaves one alone', () => {
    expect(textArray('{customer_id,placed_at}')).toEqual(['customer_id', 'placed_at']);
    expect(textArray('{"odd name","with,comma"}')).toEqual(['odd name', 'with,comma']);
    expect(textArray('{}')).toEqual([]);
    expect(textArray(['already', 'an array'])).toEqual(['already', 'an array']);
    expect(textArray(null)).toEqual([]);
  });
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
