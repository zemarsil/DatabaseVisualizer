import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { importSql } from '../src/lib/sql/import';
import { createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { generateDropStatements, generateSchema, generateTableSql } from '../src/lib/sql/generator';
import { parseSql } from '../src/lib/sql/parser';
import { quoteIdent, quoteQualified, translateType } from '../src/lib/sql/dialect';
import { getSqliteEngine } from '../src/lib/sqlite/engine';
import { viewBody } from '../src/lib/sqlite/sqljs';
import { introspectionToDiagram } from '../src/lib/introspectImport';

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

function sqliteDiagram(): Diagram {
  const d = emptyDiagram('sqlite', 'Shop');
  const r = importSql(PG, 'postgresql');
  d.tables = r.tables;
  d.relationships = r.relationships;
  d.customTypes = r.customTypes;
  for (const t of d.tables) for (const c of t.columns) c.type = translateType(c.type, 'postgresql', 'sqlite');
  return d;
}

describe('SQLite dialect helpers', () => {
  it('quotes identifiers only when needed and drops schemas', () => {
    expect(quoteIdent('Customers', 'sqlite')).toBe('Customers');
    expect(quoteIdent('order', 'sqlite')).toBe('"order"');
    expect(quoteIdent('my table', 'sqlite')).toBe('"my table"');
    expect(quoteQualified('t', 'public', 'sqlite')).toBe('t');
  });

  it('translates types to and from SQLite', () => {
    expect(translateType('BIGSERIAL', 'postgresql', 'sqlite')).toBe('INTEGER');
    expect(translateType('INT UNSIGNED', 'mariadb', 'sqlite')).toBe('INTEGER');
    expect(translateType('DOUBLE PRECISION', 'postgresql', 'sqlite')).toBe('REAL');
    expect(translateType('NUMERIC(10,2)', 'postgresql', 'sqlite')).toBe('NUMERIC(10,2)');
    expect(translateType('TIMESTAMPTZ', 'postgresql', 'sqlite')).toBe('DATETIME');
    expect(translateType('JSONB', 'postgresql', 'sqlite')).toBe('TEXT');
    expect(translateType('TEXT[]', 'postgresql', 'sqlite')).toBe('TEXT');
    expect(translateType('BYTEA', 'postgresql', 'sqlite')).toBe('BLOB');
    expect(translateType('order_status', 'postgresql', 'sqlite')).toBe('order_status');
    expect(translateType('REAL', 'sqlite', 'postgresql')).toBe('DOUBLE PRECISION');
    expect(translateType('BLOB', 'sqlite', 'mariadb')).toBe('LONGBLOB');
    expect(translateType('DATETIME', 'sqlite', 'postgresql')).toBe('TIMESTAMP');
    expect(translateType('INTEGER', 'sqlite', 'mariadb')).toBe('INT');
  });

  it('parses SQLite flavoured DDL', () => {
    const r = parseSql(
      `PRAGMA foreign_keys = ON;
       CREATE TABLE IF NOT EXISTS [users] (id INTEGER PRIMARY KEY AUTOINCREMENT, [Full Name] TEXT NOT NULL, age INT) WITHOUT ROWID;
       CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id)) STRICT;
       CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users([Full Name]);`,
      'sqlite',
    );
    expect(r.errors).toEqual([]);
    const users = r.tables.find((t) => t.name === 'users')!;
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'Full Name', 'age']);
    expect(users.columns[0].autoIncrement).toBe(true);
    expect(users.columns[0].primaryKey).toBe(true);
    expect(users.indexes[0]).toMatchObject({ name: 'idx_users_name', columns: ['Full Name'], unique: true });
    expect(r.tables.find((t) => t.name === 'posts')!.columns[1].references?.refTable).toBe('users');
  });

  it('extracts the SELECT from a stored CREATE VIEW', () => {
    expect(viewBody('CREATE VIEW v AS SELECT 1')).toBe('SELECT 1');
    expect(viewBody('CREATE VIEW "my v"(a, b) AS\n  SELECT 1, 2;')).toBe('SELECT 1, 2');
  });
});

describe('SQLite generation', () => {
  it('writes INTEGER PRIMARY KEY AUTOINCREMENT, inline foreign keys, enum checks and views', () => {
    const d = sqliteDiagram();
    const out = generateSchema(d);
    expect(out.script).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(out.script).toContain('FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE');
    expect(out.script).toContain(`status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid'))`);
    expect(out.script).toContain('CREATE INDEX idx_orders_customer ON orders (customer_id);');
    expect(out.script).toContain('-- customers: People');
    expect(out.statements.some((s) => s.startsWith('CREATE VIEW paid_orders AS'))).toBe(true);
    expect(out.statements.some((s) => s.startsWith('ALTER TABLE'))).toBe(false); // cycles stay inline
    expect(out.statements.some((s) => /^CREATE TYPE/.test(s))).toBe(false);
    const drops = generateDropStatements(d);
    expect(drops[0]).toBe('DROP VIEW IF EXISTS paid_orders;');
    expect(drops.every((s) => !s.includes('FOREIGN_KEY_CHECKS') && !s.includes('DROP TYPE'))).toBe(true);
    const view = d.tables.find((t) => t.kind === 'view')!;
    expect(generateTableSql(d, view.id)).toContain('CREATE VIEW paid_orders AS');
  });

  it('runs the generated schema in sql.js and reads it back', async () => {
    const d = sqliteDiagram();
    const engine = await getSqliteEngine();
    await engine.reset();
    const res = await engine.exec(generateSchema(d).statements, true);
    expect(res.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    expect(await engine.tableCount()).toBe(5);

    const intro = await engine.introspect();
    const names = intro.tables.map((t) => t.name).sort();
    expect(names).toEqual(['a', 'b', 'customers', 'order_items', 'orders', 'paid_orders']);
    const orders = intro.tables.find((t) => t.name === 'orders')!;
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.columns.find((c) => c.name === 'id')!.autoIncrement).toBe(true);
    expect(orders.foreignKeys[0]).toMatchObject({ refTable: 'customers', columns: ['customer_id'], refColumns: ['id'], onDelete: 'CASCADE' });
    expect(orders.indexes.map((i) => i.name)).toContain('idx_orders_customer');
    const customers = intro.tables.find((t) => t.name === 'customers')!;
    expect(customers.uniques.some((u) => u.columns.join() === 'email')).toBe(true);
    const items = intro.tables.find((t) => t.name === 'order_items')!;
    expect(items.primaryKey).toEqual(['order_id', 'line']);
    const view = intro.tables.find((t) => t.name === 'paid_orders')!;
    expect(view.kind).toBe('view');
    expect(view.viewSql).toMatch(/^SELECT o\.id/);

    const back = introspectionToDiagram(intro, 'sqlite', null);
    const backView = back.tables.find((t) => t.kind === 'view')!;
    const sources = back.relationships.filter((r) => r.kind === 'flow' && r.targetTableId === backView.id).map((r) => back.tables.find((t) => t.id === r.sourceTableId)!.name).sort();
    expect(sources).toEqual(['customers', 'orders']);

    await engine.exec([`INSERT INTO customers (email) VALUES ('a@x.io'), ('b@x.io')`, `INSERT INTO orders (customer_id, status, total) VALUES (1, 'paid', 10), (2, 'pending', 5)`], true);
    const q = await engine.query('SELECT * FROM paid_orders', { maxRows: 500 });
    expect(q.columns).toEqual(['id', 'email']);
    expect(q.rows).toEqual([[1, 'a@x.io']]);
    const capped = await engine.query('SELECT id FROM customers', { maxRows: 1 });
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toHaveLength(1);
    const bad = await engine.query(`INSERT INTO orders (customer_id, status) VALUES (1, 'nope')`).catch((e: Error) => e.message);
    expect(String(bad)).toMatch(/CHECK constraint failed/);
    const upd = await engine.query(`UPDATE customers SET email = 'c@x.io' WHERE id = 2`);
    expect(upd.rowCount).toBe(1);
  });

  it('rolls back a failing batch when stopOnError is set', async () => {
    const engine = await getSqliteEngine();
    await engine.reset();
    const res = await engine.exec(['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE u (id INTEGER PRIMARY KEY)'], true);
    expect(res.map((r) => r.ok)).toEqual([true, false]);
    expect(await engine.tableCount()).toBe(0);
    const loose = await engine.exec(['CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'CREATE TABLE u (id INTEGER PRIMARY KEY)'], false);
    expect(loose.map((r) => r.ok)).toEqual([true, false, true]);
    expect(await engine.tableCount()).toBe(2);
    const bytes = await engine.exportBytes();
    await engine.reset();
    expect(await engine.tableCount()).toBe(0);
    await engine.load(bytes);
    expect(await engine.tableCount()).toBe(2);
  });
});

describe('views', () => {
  it('parses PostgreSQL and MariaDB CREATE VIEW statements with their sources', () => {
    const pg = parseSql(
      `CREATE TABLE a (id INT PRIMARY KEY); CREATE TABLE b (id INT PRIMARY KEY, a_id INT);
       CREATE OR REPLACE VIEW v (x, y) AS SELECT a.id, b.id FROM a, b AS bb LEFT JOIN public.c ON c.id = bb.id WHERE a.id IN (SELECT id FROM d);
       CREATE MATERIALIZED VIEW mv AS SELECT count(*) FROM a WITH DATA;`,
      'postgresql',
    );
    expect(pg.views.map((v) => v.name)).toEqual(['v', 'mv']);
    expect(pg.views[0].columns).toEqual(['x', 'y']);
    expect(pg.views[0].sources).toEqual(['a', 'b', 'public.c', 'd']);
    expect(pg.views[0].sql).toMatch(/^SELECT a\.id, b\.id FROM a, b AS bb/);
    expect(pg.views[1].materialized).toBe(true);
    const maria = parseSql(
      "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `active_users` AS select `u`.`id` from `users` `u` where `u`.`active` = 1 WITH CHECK OPTION;",
      'mariadb',
    );
    expect(maria.views).toHaveLength(1);
    expect(maria.views[0].sources).toEqual(['users']);
    expect(maria.views[0].sql.endsWith('= 1')).toBe(true);
  });

  it('imports views as view tables fed by their sources and generates them after tables', () => {
    const d = emptyDiagram('postgresql');
    const r = importSql(PG, 'postgresql');
    d.tables = r.tables;
    d.relationships = r.relationships;
    d.customTypes = r.customTypes;
    const view = d.tables.find((t) => t.name === 'paid_orders')!;
    expect(view.kind).toBe('view');
    const feeds = d.relationships.filter((x) => x.kind === 'flow' && x.targetTableId === view.id).map((x) => d.tables.find((t) => t.id === x.sourceTableId)!.name).sort();
    expect(feeds).toEqual(['customers', 'orders']);
    const out = generateSchema(d);
    const idx = out.statements.findIndex((s) => s.startsWith('CREATE VIEW paid_orders'));
    expect(idx).toBeGreaterThan(out.statements.findIndex((s) => s.startsWith('CREATE TABLE orders')));
    expect(out.script).toContain('views: 1');

    // a view reading from a view comes after it, and FKs on views are refused
    const v2 = createTable({ name: 'summary', kind: 'view', viewSql: 'SELECT count(*) FROM paid_orders' });
    d.tables.push(v2);
    d.relationships.push(createRelationship({ kind: 'flow', sourceTableId: view.id, sourceColumnIds: [], targetTableId: v2.id, targetColumnIds: [] }));
    d.relationships.push(createRelationship({ kind: 'fk', sourceTableId: v2.id, sourceColumnIds: [], targetTableId: view.id, targetColumnIds: [] }));
    const out2 = generateSchema(d);
    const i1 = out2.statements.findIndex((s) => s.startsWith('CREATE VIEW paid_orders'));
    const i2 = out2.statements.findIndex((s) => s.startsWith('CREATE VIEW summary'));
    expect(i2).toBeGreaterThan(i1);
    expect(out2.warnings.some((w) => w.includes('touches a view'))).toBe(true);
    expect(generateDropStatements(d).slice(0, 2)).toEqual(['DROP VIEW IF EXISTS summary;', 'DROP VIEW IF EXISTS paid_orders;']);
  });
});
