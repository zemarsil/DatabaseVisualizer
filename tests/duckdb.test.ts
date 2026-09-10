import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { importSql } from '../src/lib/sql/import';
import { createColumn, createExtension, createIndex, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { extensionInstallPlan, generateDropStatements, generateSchema, generateTableSql } from '../src/lib/sql/generator';
import { parseSql } from '../src/lib/sql/parser';
import { isIntegerType, quoteIdent, quoteQualified, translateType } from '../src/lib/sql/dialect';
import { lintDiagram } from '../src/lib/lint';
import { introspectionToDiagram } from '../src/lib/introspectImport';
import { diffDiagramAgainst } from '../src/lib/migrate/diff';
import { generateMigration } from '../src/lib/migrate/alter';
import { generateSeed } from '../src/lib/seed';
import { sampleDiagram } from '../src/lib/sample';
import { enumLabels, indexColumns } from '../src/lib/duckdb/catalog';
import { formatTimestamp, scaledDecimal } from '../src/lib/duckdb/values';
import { firstKeyword, isWriteSql } from '../src/lib/duckdb/core';
import { getNodeDuckdb } from './helpers/duckdbNode';

const PG = `
CREATE TYPE order_status AS ENUM ('pending', 'paid');
CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, created_at TIMESTAMPTZ DEFAULT now());
COMMENT ON TABLE customers IS 'People';
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status order_status NOT NULL DEFAULT 'pending',
  total NUMERIC(10,2) CHECK (total >= 0)
);
CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE TABLE order_items (order_id BIGINT REFERENCES orders(id), line INT, sku TEXT, PRIMARY KEY (order_id, line));
CREATE TABLE a (id SERIAL PRIMARY KEY, b_id INTEGER);
CREATE TABLE b (id SERIAL PRIMARY KEY, a_id INTEGER REFERENCES a(id));
ALTER TABLE a ADD CONSTRAINT fk_a_b FOREIGN KEY (b_id) REFERENCES b(id);
CREATE VIEW paid_orders AS SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid';
`;

function duckdbDiagram(): Diagram {
  const d = emptyDiagram('duckdb', 'Shop');
  const r = importSql(PG, 'postgresql');
  d.tables = r.tables;
  d.relationships = r.relationships;
  d.customTypes = r.customTypes;
  for (const t of d.tables) for (const c of t.columns) c.type = translateType(c.type, 'postgresql', 'duckdb');
  return d;
}

/** The shop sample as a DuckDB diagram; JSON would make the engine fetch its json extension, which needs the network. */
function duckdbSample(): Diagram {
  const d = { ...structuredClone(sampleDiagram()), dialect: 'duckdb' as const };
  for (const t of d.tables) for (const c of t.columns) c.type = c.type === 'JSONB' ? 'VARCHAR' : translateType(c.type, 'postgresql', 'duckdb');
  return d;
}

describe('DuckDB dialect helpers', () => {
  it('quotes identifiers only when needed, including words only DuckDB reserves', () => {
    expect(quoteIdent('Customers', 'duckdb')).toBe('Customers');
    expect(quoteIdent('order', 'duckdb')).toBe('"order"');
    expect(quoteIdent('at', 'duckdb')).toBe('"at"');
    expect(quoteIdent('map', 'duckdb')).toBe('"map"');
    expect(quoteIdent('summarize', 'duckdb')).toBe('"summarize"');
    expect(quoteIdent('at', 'postgresql')).toBe('at');
    expect(quoteQualified('t', 'app', 'duckdb')).toBe('app.t');
    expect(isIntegerType('UINTEGER')).toBe(true);
    expect(isIntegerType('HUGEINT')).toBe(true);
  });

  it('translates types to DuckDB', () => {
    expect(translateType('BIGSERIAL', 'postgresql', 'duckdb')).toBe('BIGINT');
    expect(translateType('INT UNSIGNED', 'mariadb', 'duckdb')).toBe('UINTEGER');
    expect(translateType('BIGINT UNSIGNED', 'mariadb', 'duckdb')).toBe('UBIGINT');
    expect(translateType('TINYINT(1)', 'mariadb', 'duckdb')).toBe('BOOLEAN');
    expect(translateType('DOUBLE PRECISION', 'postgresql', 'duckdb')).toBe('DOUBLE');
    expect(translateType('NUMERIC(10,2)', 'postgresql', 'duckdb')).toBe('DECIMAL(10,2)');
    expect(translateType('TIMESTAMPTZ', 'postgresql', 'duckdb')).toBe('TIMESTAMPTZ');
    expect(translateType('TIMESTAMP', 'mariadb', 'duckdb')).toBe('TIMESTAMPTZ');
    expect(translateType('DATETIME', 'mariadb', 'duckdb')).toBe('TIMESTAMP');
    expect(translateType('JSONB', 'postgresql', 'duckdb')).toBe('JSON');
    expect(translateType('TEXT[]', 'postgresql', 'duckdb')).toBe('VARCHAR[]');
    expect(translateType('BYTEA', 'postgresql', 'duckdb')).toBe('BLOB');
    expect(translateType('TEXT', 'postgresql', 'duckdb')).toBe('VARCHAR');
    expect(translateType('REAL', 'sqlite', 'duckdb')).toBe('DOUBLE');
    expect(translateType("ENUM('a','b')", 'mariadb', 'duckdb')).toBe("ENUM('a','b')");
    expect(translateType('INET', 'postgresql', 'duckdb')).toBe('INET');
    expect(translateType('MONEY', 'postgresql', 'duckdb')).toBe('DECIMAL(19,4)');
    expect(translateType('order_status', 'postgresql', 'duckdb')).toBe('order_status');
  });

  it('translates types from DuckDB', () => {
    expect(translateType('HUGEINT', 'duckdb', 'postgresql')).toBe('NUMERIC(39,0)');
    expect(translateType('UINTEGER', 'duckdb', 'postgresql')).toBe('BIGINT');
    expect(translateType('UINTEGER', 'duckdb', 'mariadb')).toBe('INT UNSIGNED');
    expect(translateType('UINTEGER', 'duckdb', 'sqlite')).toBe('INTEGER');
    expect(translateType('STRUCT(x INTEGER, y INTEGER)', 'duckdb', 'postgresql')).toBe('JSONB');
    expect(translateType('MAP(VARCHAR, INTEGER)', 'duckdb', 'mariadb')).toBe('JSON');
    expect(translateType('STRUCT(x INTEGER, y INTEGER)', 'duckdb', 'sqlite')).toBe('TEXT');
    expect(translateType('INTEGER[3]', 'duckdb', 'postgresql')).toBe('INTEGER[]');
    expect(translateType('VARCHAR[]', 'duckdb', 'mariadb')).toBe('JSON');
    expect(translateType('BLOB', 'duckdb', 'postgresql')).toBe('BYTEA');
    expect(translateType('TIMESTAMP_NS', 'duckdb', 'postgresql')).toBe('TIMESTAMP');
    expect(translateType('DOUBLE', 'duckdb', 'postgresql')).toBe('DOUBLE PRECISION');
    expect(translateType('DOUBLE', 'duckdb', 'sqlite')).toBe('REAL');
    expect(translateType('FLOAT', 'duckdb', 'postgresql')).toBe('REAL');
    expect(translateType('DECIMAL(10,2)', 'duckdb', 'postgresql')).toBe('NUMERIC(10,2)');
    expect(translateType('DECIMAL(10,2)', 'duckdb', 'mariadb')).toBe('DECIMAL(10,2)');
    expect(translateType('JSON', 'duckdb', 'postgresql')).toBe('JSONB');
    expect(translateType('BIT', 'duckdb', 'postgresql')).toBe('VARBIT');
    expect(translateType('BIT', 'duckdb', 'sqlite')).toBe('BLOB');
  });
});

describe('DuckDB parsing', () => {
  it('reads DuckDB DDL: nested types, sequences, struct types and extensions', () => {
    const r = parseSql(
      `INSTALL spatial;
       LOAD spatial;
       CREATE SCHEMA IF NOT EXISTS app;
       CREATE SEQUENCE customers_id_seq START 1;
       CREATE TYPE mood AS ENUM ('sad', 'happy');
       CREATE TYPE pt AS STRUCT(x INTEGER, y DOUBLE);
       CREATE OR REPLACE TABLE customers (
         id INTEGER PRIMARY KEY DEFAULT nextval('customers_id_seq'),
         p pt,
         tags VARCHAR[],
         grid DOUBLE[3],
         attrs MAP(VARCHAR, INTEGER),
         m mood NOT NULL DEFAULT 'happy',
         s STRUCT(a INTEGER, "b c" VARCHAR),
         big HUGEINT
       );
       COMMENT ON TABLE customers IS 'People';`,
      'duckdb',
    );
    expect(r.errors).toEqual([]);
    const seq = r.warnings.filter((w) => /SEQUENCE/.test(w.message));
    expect(seq).toHaveLength(1);
    expect(seq[0].message).toContain('not imported on its own');
    expect(r.extensions.map((e) => e.name)).toEqual(['spatial']);
    expect(r.enums).toEqual([{ name: 'mood', values: ['sad', 'happy'] }]);
    expect(r.compositeTypes).toEqual([{ name: 'pt', fields: [{ name: 'x', type: 'INTEGER' }, { name: 'y', type: 'DOUBLE' }] }]);
    const t = r.tables[0];
    expect(t.comment).toBe('People');
    // Type words are upper-cased the way every dialect's are; custom types match case-insensitively.
    expect(t.columns.map((c) => c.type)).toEqual(['INTEGER', 'PT', 'VARCHAR[]', 'DOUBLE[3]', 'MAP(VARCHAR, INTEGER)', 'MOOD', 'STRUCT(a INTEGER, "b c" VARCHAR)', 'HUGEINT']);
    expect(t.columns[0].defaultValue).toBe("nextval('customers_id_seq')");
    expect(t.columns[5].defaultValue).toBe("'happy'");

    const imported = importSql(`CREATE SEQUENCE s; CREATE TABLE t (id INTEGER PRIMARY KEY DEFAULT nextval('s'), n INTEGER);`, 'duckdb');
    const id = imported.tables[0].columns[0];
    expect(id.autoIncrement).toBe(true);
    expect(id.defaultValue).toBeUndefined();
  });

  it('keeps MariaDB LOAD DATA out of the extension list', () => {
    const r = parseSql("LOAD DATA INFILE 'x.csv' INTO TABLE t; CREATE TABLE t (id INT PRIMARY KEY);", 'mariadb');
    expect(r.extensions).toEqual([]);
    expect(r.tables).toHaveLength(1);
  });
});

describe('DuckDB generation', () => {
  it('writes sequences, named types, comments and inline foreign keys, and documents a cycle', () => {
    const d = duckdbDiagram();
    const out = generateSchema(d);
    expect(out.script).toContain('CREATE SEQUENCE IF NOT EXISTS customers_id_seq;');
    expect(out.script).toContain("id INTEGER PRIMARY KEY DEFAULT nextval('customers_id_seq')");
    expect(out.script).toContain("id BIGINT PRIMARY KEY DEFAULT nextval('orders_id_seq')");
    expect(out.statements.indexOf('CREATE SEQUENCE IF NOT EXISTS customers_id_seq;')).toBeLessThan(out.statements.findIndex((s) => s.startsWith('CREATE TABLE customers')));
    expect(out.script).toContain("CREATE TYPE order_status AS ENUM ('pending', 'paid');");
    expect(out.script).toContain("status order_status NOT NULL DEFAULT 'pending'");
    expect(out.script).toContain("COMMENT ON TABLE customers IS 'People';");
    expect(out.script).toContain('CREATE INDEX idx_orders_customer ON orders (customer_id);');
    // DuckDB's parser refuses referential actions, so the cascade is dropped and said so.
    expect(out.script).toContain('CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES customers (id)\n');
    expect(out.script).not.toContain('ON DELETE CASCADE');
    expect(out.warnings.some((w) => w.includes('ON DELETE CASCADE was left out'))).toBe(true);
    // The a <-> b cycle cannot be closed after the fact.
    expect(out.statements.some((s) => s.startsWith('ALTER TABLE'))).toBe(false);
    expect(out.script).toContain('-- ALTER TABLE a ADD CONSTRAINT fk_a_b FOREIGN KEY (b_id) REFERENCES b (id);');
    expect(out.warnings.some((w) => w.includes('closes a reference cycle'))).toBe(true);
    expect(out.statements.some((s) => s.startsWith('CREATE VIEW paid_orders AS'))).toBe(true);
    expect(generateTableSql(d, d.tables.find((t) => t.name === 'customers')!.id)).toContain('CREATE SEQUENCE IF NOT EXISTS customers_id_seq;');

    const drops = generateDropStatements(d);
    expect(drops[0]).toBe('DROP VIEW IF EXISTS paid_orders;');
    expect(drops).toContain('DROP SEQUENCE IF EXISTS customers_id_seq;');
    expect(drops[drops.length - 1]).toBe('DROP TYPE IF EXISTS order_status;');
    expect(drops.every((s) => !/CASCADE/.test(s))).toBe(true);
    // children before parents
    expect(drops.indexOf('DROP TABLE IF EXISTS orders;')).toBeLessThan(drops.indexOf('DROP TABLE IF EXISTS customers;'));
  });

  it('spells a composite type AS STRUCT and creates schemas first', () => {
    const d = emptyDiagram('duckdb');
    d.customTypes.push({ id: 'ct1', name: 'point', kind: 'composite', fields: [{ id: 'f1', name: 'x', type: 'INTEGER' }, { id: 'f2', name: 'y', type: 'INTEGER' }] });
    const t = createTable({ name: 'places', schema: 'geo', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'at', type: 'point' })] });
    d.tables.push(t);
    const out = generateSchema(d);
    expect(out.statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS geo;');
    expect(out.statements[1]).toBe('CREATE TYPE point AS STRUCT(x INTEGER, y INTEGER);');
    expect(out.script).toContain('CREATE TABLE geo.places (');
    expect(out.script).toContain('"at" point');
    expect(out.warnings).toEqual([]);
  });

  it('falls a materialized view back to a plain view with a warning', () => {
    const d = duckdbDiagram();
    d.tables.find((t) => t.kind === 'view')!.materialized = true;
    const out = generateSchema(d);
    expect(out.statements.some((s) => s.includes('MATERIALIZED'))).toBe(false);
    expect(out.warnings.some((w) => w.includes('DuckDB has no materialized views'))).toBe(true);
  });

  it('installs and loads extensions from the script, and says so for built-in ones', () => {
    const d = emptyDiagram('duckdb');
    d.extensions.push(createExtension({ name: 'spatial' }), createExtension({ name: 'core_functions' }));
    const out = generateSchema(d);
    expect(out.statements.slice(0, 2)).toEqual(['INSTALL spatial;', 'LOAD spatial;']);
    expect(out.script).toContain('-- core_functions is built into the engine');
    expect(extensionInstallPlan('duckdb', createExtension({ name: 'vss' })).statements).toEqual(['INSTALL vss;', 'LOAD vss;']);
  });

  it('lints referential actions DuckDB cannot take, with a fix', () => {
    const d = duckdbDiagram();
    const findings = lintDiagram(d).filter((f) => f.rule === 'fk-action-unsupported');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    const copy = structuredClone(d);
    findings[0].fix!.apply(copy);
    expect(lintDiagram(copy).some((f) => f.rule === 'fk-action-unsupported')).toBe(false);
    expect(lintDiagram({ ...d, dialect: 'postgresql' }).some((f) => f.rule === 'fk-action-unsupported')).toBe(false);
  });
});

describe('DuckDB result and catalog helpers', () => {
  it('scales decimals, formats timestamps and reads index expressions', () => {
    expect(scaledDecimal('1234', 2)).toBe('12.34');
    expect(scaledDecimal('-1250', 3)).toBe('-1.250');
    expect(scaledDecimal('5', 2)).toBe('0.05');
    expect(scaledDecimal('7', 0)).toBe('7');
    expect(formatTimestamp(Date.UTC(2024, 0, 2, 10, 11, 12), false)).toBe('2024-01-02T10:11:12');
    expect(formatTimestamp(Date.UTC(2024, 0, 2, 10, 11, 12) + 123.456, true)).toBe('2024-01-02T10:11:12.123456Z');
    expect(indexColumns('[customer_id, status]')).toEqual(['customer_id', 'status']);
    expect(indexColumns("['(lower(email))']")).toBeNull();
    expect(enumLabels("ENUM('sad', 'ok', 'it''s')")).toEqual(['sad', 'ok', "it's"]);
    expect(enumLabels('VARCHAR')).toBeNull();
    expect(firstKeyword('  -- note\n  SELECT 1')).toBe('SELECT');
    expect(isWriteSql('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isWriteSql('FROM t')).toBe(false);
  });
});

describe('DuckDB engine', () => {
  it('runs the generated schema and reads it back', async () => {
    const d = duckdbDiagram();
    const engine = await getNodeDuckdb();
    await engine.reset();
    expect(await engine.version()).toMatch(/^\d+\.\d+/);
    const res = await engine.exec(generateSchema(d).statements, true);
    expect(res.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    expect(await engine.tableCount()).toBe(5);

    const intro = await engine.introspect();
    expect(intro.serverVersion).toMatch(/^DuckDB /);
    expect(intro.tables.map((t) => t.name).sort()).toEqual(['a', 'b', 'customers', 'order_items', 'orders', 'paid_orders']);
    expect(intro.enums).toEqual([{ schema: 'main', name: 'order_status', values: ['pending', 'paid'] }]);
    const orders = intro.tables.find((t) => t.name === 'orders')!;
    expect(orders.primaryKey).toEqual(['id']);
    const id = orders.columns.find((c) => c.name === 'id')!;
    expect(id.autoIncrement).toBe(true);
    expect(id.type).toBe('BIGINT');
    // the enum column comes back as the type it was declared with, not its label list
    expect(orders.columns.find((c) => c.name === 'status')).toMatchObject({ type: 'order_status', nullable: false, defaultValue: "'pending'" });
    expect(orders.columns.find((c) => c.name === 'total')!.type).toBe('DECIMAL(10,2)');
    expect(orders.foreignKeys).toHaveLength(1);
    expect(orders.foreignKeys[0]).toMatchObject({ refTable: 'customers', columns: ['customer_id'], refColumns: ['id'], onDelete: 'NO ACTION' });
    expect(orders.indexes.map((i) => i.name)).toEqual(['idx_orders_customer']);
    const customers = intro.tables.find((t) => t.name === 'customers')!;
    expect(customers.comment).toBe('People');
    expect(customers.uniques.some((u) => u.columns.join() === 'email')).toBe(true);
    expect(customers.columns.find((c) => c.name === 'created_at')!.type).toBe('TIMESTAMP WITH TIME ZONE');
    expect(intro.tables.find((t) => t.name === 'order_items')!.primaryKey).toEqual(['order_id', 'line']);
    const view = intro.tables.find((t) => t.name === 'paid_orders')!;
    expect(view.kind).toBe('view');
    expect(view.viewSql).toMatch(/^SELECT o\.id/);

    const back = introspectionToDiagram(intro, 'duckdb', null);
    expect(back.customTypes.map((c) => c.name)).toEqual(['order_status']);
    expect(back.tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'status')!.type).toBe('order_status');
    expect(back.tables.find((t) => t.name === 'customers')!.columns.find((c) => c.name === 'created_at')!.type).toBe('TIMESTAMPTZ');
    const backView = back.tables.find((t) => t.kind === 'view')!;
    const sources = back.relationships.filter((r) => r.kind === 'flow' && r.targetTableId === backView.id).map((r) => back.tables.find((t) => t.id === r.sourceTableId)!.name).sort();
    expect(sources).toEqual(['customers', 'orders']);

    // rows: the sequence default fills the ids, the view reads them back
    await engine.exec([`INSERT INTO customers (email) VALUES ('a@x.io'), ('b@x.io')`, `INSERT INTO orders (customer_id, status, total) VALUES (1, 'paid', 10), (2, 'pending', 5)`], true);
    const q = await engine.query('SELECT * FROM paid_orders', { maxRows: 500 });
    expect(q.columns).toEqual(['id', 'email']);
    expect(q.rows).toEqual([[1, 'a@x.io']]);
    const capped = await engine.query('SELECT id FROM customers ORDER BY id', { maxRows: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toEqual([[1]]);
    const bad = await engine.query(`INSERT INTO orders (customer_id, status, total) VALUES (1, 'paid', -1)`).catch((e: Error) => e.message);
    expect(String(bad)).toMatch(/CHECK constraint failed/);
    // (a customer with orders cannot be updated at all: DuckDB refuses to touch a referenced row, so the child is updated instead)
    const upd = await engine.query(`UPDATE orders SET total = 11 WHERE id = 1`);
    expect(upd).toMatchObject({ columns: [], rows: [], rowCount: 1, command: 'UPDATE' });
    const ddl = await engine.query('CREATE TABLE scratch (id INTEGER)');
    expect(ddl).toMatchObject({ columns: [], rows: [], rowCount: 0 });
    const multi = await engine.query('INSERT INTO scratch VALUES (7); SELECT id AS n FROM scratch');
    expect(multi.rows).toEqual([[7]]);

    const ext = await engine.extensions();
    expect(ext.extensions.some((e) => e.name === 'core_functions' && e.installed)).toBe(true);
    expect(ext.extensions.some((e) => e.name === 'json')).toBe(true);
  }, 60000);

  it('renders typed values as readable, JSON-safe cells', async () => {
    const engine = await getNodeDuckdb();
    const q = await engine.query(
      `SELECT 12.34::DECIMAL(10,2) AS dec, -1.25::DECIMAL(18,3) AS neg, 1::BIGINT AS big, 9007199254740993::BIGINT AS unsafe, 170141183460469231731687303715884105727::HUGEINT AS huge,
              DATE '2024-01-02' AS d, TIMESTAMP '2024-01-02 10:11:12.5' AS ts, TIMESTAMPTZ '2024-01-02 10:11:12+00' AS tstz, TIME '10:11:12' AS t,
              'ab'::BLOB AS b, [1, 2] AS li, {'x': 1, 'y': 'z'} AS st, MAP {'k': 2} AS mp, TRUE AS bo, NULL::INTEGER AS nul, 1.5::FLOAT AS f, 'x'::VARCHAR AS s,
              [1.5::DECIMAL(4,1)] AS decs, 300::UINTEGER AS ui, uuid() AS u`,
    );
    const row = Object.fromEntries(q.columns.map((c, i) => [c, q.rows[0][i]]));
    expect(row).toMatchObject({
      dec: '12.34',
      neg: '-1.250',
      big: 1,
      unsafe: '9007199254740993',
      huge: '170141183460469231731687303715884105727',
      d: '2024-01-02',
      ts: '2024-01-02T10:11:12.5',
      tstz: '2024-01-02T10:11:12Z',
      t: '10:11:12',
      b: '\\x6162',
      li: '[1,2]',
      st: '{"x":1,"y":"z"}',
      mp: '{"k":2}',
      bo: true,
      nul: null,
      f: 1.5,
      s: 'x',
      decs: '["1.5"]',
      ui: 300,
    });
    expect(String(row.u)).toMatch(/^[0-9a-f-]{36}$/);
  }, 60000);

  it('rolls back a failing batch when stopOnError is set', async () => {
    const engine = await getNodeDuckdb();
    await engine.reset();
    const res = await engine.exec(['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE u (id INTEGER PRIMARY KEY)'], true);
    expect(res.map((r) => r.ok)).toEqual([true, false]);
    expect(await engine.tableCount()).toBe(0);
    const loose = await engine.exec(['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE u (id INTEGER PRIMARY KEY)'], false);
    expect(loose.map((r) => r.ok)).toEqual([true, false, true]);
    expect(await engine.tableCount()).toBe(2);
  }, 60000);

  it('seeds the sample schema with every foreign key satisfied and the sequences moved past the ids', async () => {
    const engine = await getNodeDuckdb();
    await engine.reset();
    const d = duckdbSample();
    const created = await engine.exec(generateSchema(d).statements, true);
    expect(created.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    const seed = generateSeed(d, { rows: 12, seed: 9 });
    expect(seed.script).toContain("SELECT max(nextval('customers_id_seq')) FROM range(");
    const results = await engine.exec(seed.statements, true);
    expect(results.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    expect((await engine.query('SELECT COUNT(*) FROM order_items')).rows[0][0]).toBe(12);
    const next = await engine.query(`INSERT INTO customers (email, full_name) VALUES ('late@x.io', 'Late') RETURNING id`);
    expect(Number(next.rows[0][0])).toBeGreaterThan(12);
    // and a clean drop leaves nothing behind
    const dropped = await engine.exec(generateDropStatements(d), true);
    expect(dropped.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    expect(await engine.tableCount()).toBe(0);
    expect(await engine.run('SELECT count(*) FROM duckdb_sequences()')).toEqual([[0]]);
  }, 60000);

  it('migrates a live DuckDB database until the diff is empty', async () => {
    const engine = await getNodeDuckdb();
    await engine.reset();
    const d = duckdbSample();
    const created = await engine.exec(generateSchema(d).statements, true);
    expect(created.filter((r) => !r.ok)).toEqual([]);
    expect(diffDiagramAgainst(d, await engine.introspect()).changes).toEqual([]);

    const d2 = structuredClone(d);
    // order_gaps: a child table nothing references, so DuckDB lets its columns change
    const gaps = d2.tables.find((t) => t.name === 'order_gaps')!;
    gaps.columns.find((c) => c.name === 'gap_seconds')!.type = 'BIGINT';
    gaps.columns.push(createColumn({ name: 'note', type: 'VARCHAR', nullable: true }));
    gaps.columns.push(createColumn({ name: 'score', type: 'INTEGER', nullable: false }));
    // order_items: drop a plain column, add an index
    const items = d2.tables.find((t) => t.name === 'order_items')!;
    items.columns = items.columns.filter((c) => c.name !== 'unit_price_cents');
    items.indexes.push(createIndex({ name: 'idx_items_product', columnIds: [items.columns.find((c) => c.name === 'product_id')!.id] }));
    // daily_sales goes away entirely
    d2.tables = d2.tables.filter((t) => t.name !== 'daily_sales');
    d2.relationships = d2.relationships.filter((r) => d2.tables.some((t) => t.id === r.sourceTableId) && d2.tables.some((t) => t.id === r.targetTableId));

    const { changes, current } = diffDiagramAgainst(d2, await engine.introspect());
    const kinds = (cs: typeof changes) => cs.map((c) => c.op.kind).sort();
    expect(kinds(changes)).toEqual(['add-column', 'add-column', 'add-index', 'alter-column', 'drop-column', 'drop-table']);
    const m = generateMigration(d2, changes, current);
    expect(m.statements).toContain('ALTER TABLE order_gaps ALTER COLUMN gap_seconds TYPE BIGINT;');
    expect(m.statements).toContain('ALTER TABLE order_gaps ADD COLUMN score INTEGER DEFAULT 0;');
    expect(m.statements).toContain('ALTER TABLE order_gaps ALTER COLUMN score SET NOT NULL;');
    expect(m.statements).toContain('ALTER TABLE order_gaps ALTER COLUMN score DROP DEFAULT;');
    expect(m.statements).toContain('ALTER TABLE order_items DROP COLUMN unit_price_cents;');
    expect(m.statements).toContain('DROP TABLE IF EXISTS main.daily_sales;');
    const results = await engine.exec(m.statements, true);
    expect(results.filter((r) => !r.ok).map((r) => `${r.sql}: ${r.error}`)).toEqual([]);
    expect(diffDiagramAgainst(d2, await engine.introspect()).changes).toEqual([]);
  }, 60000);

  it('drops and recreates the indexes of a table whose column changes, since DuckDB refuses to alter an indexed table', async () => {
    const engine = await getNodeDuckdb();
    await engine.reset();
    const d = emptyDiagram('duckdb', 'Idx');
    const t = createTable({
      name: 'readings',
      columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'sensor', type: 'VARCHAR', nullable: false }), createColumn({ name: 'value', type: 'INTEGER' })],
    });
    t.indexes.push(createIndex({ name: 'idx_readings_sensor', columnIds: [t.columns[1].id] }));
    d.tables.push(t);
    expect((await engine.exec(generateSchema(d).statements, true)).filter((r) => !r.ok)).toEqual([]);
    await engine.exec([`INSERT INTO readings VALUES (1, 'a', 3)`], true);
    const d2 = structuredClone(d);
    d2.tables[0].columns[2].type = 'DOUBLE';
    const { changes, current } = diffDiagramAgainst(d2, await engine.introspect());
    expect(changes.map((c) => c.op.kind)).toEqual(['alter-column']);
    const m = generateMigration(d2, changes, current);
    const drop = m.statements.indexOf('DROP INDEX IF EXISTS idx_readings_sensor;');
    const alter = m.statements.findIndex((s) => s.includes('ALTER COLUMN value TYPE DOUBLE'));
    const create = m.statements.indexOf('CREATE INDEX idx_readings_sensor ON readings (sensor);');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(alter);
    expect(alter).toBeLessThan(create);
    const results = await engine.exec(m.statements, true);
    expect(results.filter((r) => !r.ok).map((r) => `${r.sql}: ${r.error}`)).toEqual([]);
    expect(diffDiagramAgainst(d2, await engine.introspect()).changes).toEqual([]);
    expect((await engine.query('SELECT value FROM readings')).rows).toEqual([[3]]);
  }, 60000);

  it('writes what DuckDB cannot alter as notes rather than statements it would reject', async () => {
    const engine = await getNodeDuckdb();
    await engine.reset();
    const d = emptyDiagram('duckdb', 'Keys');
    const parent = createTable({ name: 'parent', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false })] });
    const child = createTable({ name: 'child', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'parent_id', type: 'INTEGER' })] });
    d.tables.push(parent, child);
    expect((await engine.exec(generateSchema(d).statements, true)).filter((r) => !r.ok)).toEqual([]);
    const d2 = structuredClone(d);
    d2.relationships.push(createRelationship({ kind: 'fk', sourceTableId: child.id, sourceColumnIds: [child.columns[1].id], targetTableId: parent.id, targetColumnIds: [parent.columns[0].id] }));
    const { changes, current } = diffDiagramAgainst(d2, await engine.introspect());
    expect(changes.map((c) => c.op.kind)).toEqual(['add-foreign-key']);
    const m = generateMigration(d2, changes, current);
    expect(m.statements).toEqual([]);
    expect(m.script).toContain('DuckDB cannot add a foreign key to an existing table');
    expect(m.warnings.join(' ')).toMatch(/cannot add the foreign key/);
  }, 60000);
});
