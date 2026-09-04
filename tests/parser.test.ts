import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/lib/sql/parser';
import { importSql } from '../src/lib/sql/import';

describe('parseSql (PostgreSQL)', () => {
  it('parses columns, constraints and inline references', () => {
    const res = parseSql(
      `CREATE TABLE "Users" (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        balance NUMERIC(10, 2) DEFAULT 0 CHECK (balance >= 0),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        tags TEXT[] ,
        manager_id INTEGER REFERENCES "Users"(id) ON DELETE SET NULL
      );`,
      'postgresql',
    );
    expect(res.errors).toEqual([]);
    expect(res.tables).toHaveLength(1);
    const t = res.tables[0];
    expect(t.name).toBe('Users');
    expect(t.primaryKey).toEqual(['id']);
    const [id, email, balance, created, tags, manager] = t.columns;
    expect(id.autoIncrement).toBe(true);
    expect(id.type).toBe('INTEGER');
    expect(id.primaryKey).toBe(true);
    expect(email.unique).toBe(true);
    expect(email.nullable).toBe(false);
    expect(balance.type).toBe('NUMERIC(10,2)');
    expect(balance.defaultValue).toBe('0');
    expect(balance.check).toBe('balance >= 0');
    expect(created.type).toBe('TIMESTAMP WITH TIME ZONE');
    expect(created.defaultValue).toBe('now()');
    expect(tags.type).toBe('TEXT[]');
    expect(manager.references?.refTable).toBe('Users');
    expect(manager.references?.onDelete).toBe('SET NULL');
  });

  it('folds unquoted identifiers to lower case', () => {
    const res = parseSql('CREATE TABLE Orders (ID INT, Total INT);', 'postgresql');
    expect(res.tables[0].name).toBe('orders');
    expect(res.tables[0].columns.map((c) => c.name)).toEqual(['id', 'total']);
  });

  it('handles pg_dump style ALTER TABLE ADD CONSTRAINT and nextval defaults', () => {
    const sql = `
      CREATE TABLE public.orders (id integer NOT NULL, customer_id integer);
      CREATE TABLE public.customers (id integer NOT NULL);
      ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);
      ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY public.orders
        ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE NOT DEFERRABLE;
      CREATE INDEX idx_orders_customer ON public.orders USING btree (customer_id);
      COMMENT ON TABLE public.orders IS 'All orders';
      COMMENT ON COLUMN public.orders.customer_id IS 'Who bought it';
    `;
    const res = parseSql(sql, 'postgresql');
    expect(res.errors).toEqual([]);
    const orders = res.tables.find((t) => t.name === 'orders')!;
    const customers = res.tables.find((t) => t.name === 'customers')!;
    expect(orders.schema).toBe('public');
    expect(orders.columns[0].defaultValue).toMatch(/^nextval/);
    expect(customers.primaryKey).toEqual(['id']);
    expect(orders.foreignKeys).toHaveLength(1);
    expect(orders.foreignKeys[0].name).toBe('orders_customer_fk');
    expect(orders.foreignKeys[0].onDelete).toBe('CASCADE');
    expect(orders.indexes[0]).toEqual({ name: 'idx_orders_customer', columns: ['customer_id'], unique: false });
    expect(orders.comment).toBe('All orders');
    expect(orders.columns[1].comment).toBe('Who bought it');

    const imported = importSql(sql, 'postgresql');
    const col = imported.tables.find((t) => t.name === 'orders')!.columns[0];
    expect(col.autoIncrement).toBe(true);
    expect(col.defaultValue).toBeUndefined();
  });

  it('parses identity columns, composite keys, expression indexes and enums', () => {
    const res = parseSql(
      `CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
       CREATE TABLE t (
         a INT GENERATED ALWAYS AS IDENTITY,
         b INT NOT NULL,
         m mood DEFAULT 'ok',
         CONSTRAINT t_pk PRIMARY KEY (a, b),
         UNIQUE (b, m)
       );
       CREATE UNIQUE INDEX t_lower ON t (lower(m), b DESC);`,
      'postgresql',
    );
    expect(res.errors).toEqual([]);
    expect(res.enums[0]).toEqual({ name: 'mood', values: ['sad', 'ok', 'happy'] });
    const t = res.tables[0];
    expect(t.columns[0].autoIncrement).toBe(true);
    expect(t.primaryKey).toEqual(['a', 'b']);
    expect(t.uniques[0].columns).toEqual(['b', 'm']);
    expect(t.indexes[0]).toEqual({ name: 't_lower', columns: ['lower(m)', 'b'], unique: true });
    expect(t.columns[2].type).toBe('MOOD');
  });

  it('recovers from a bad statement and keeps going', () => {
    const res = parseSql(
      `CREATE TABLE ok1 (id INT);
       CREATE TABLE broken (id INT,, name TEXT);
       CREATE TABLE ok2 (id INT);`,
      'postgresql',
    );
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].line).toBe(2);
    expect(res.tables.map((t) => t.name)).toEqual(['ok1', 'ok2']);
  });

  it('warns about unsupported statements instead of failing', () => {
    const res = parseSql(`INSERT INTO x VALUES (1); CREATE SEQUENCE s; CREATE TABLE y (id INT);`, 'postgresql');
    expect(res.errors).toEqual([]);
    expect(res.warnings.length).toBeGreaterThanOrEqual(2);
    expect(res.tables).toHaveLength(1);
  });
});

describe('parseSql (MariaDB)', () => {
  it('parses MariaDB style definitions', () => {
    const res = parseSql(
      `CREATE TABLE IF NOT EXISTS \`orders\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`customer_id\` INT UNSIGNED NOT NULL,
        \`status\` ENUM('new', 'paid') NOT NULL DEFAULT 'new' COMMENT 'lifecycle',
        \`total\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        \`notes\` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_customer\` (\`customer_id\`),
        UNIQUE KEY \`uq_status_total\` (\`status\`, \`total\`),
        CONSTRAINT \`fk_orders_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Customer orders';`,
      'mariadb',
    );
    expect(res.errors).toEqual([]);
    const t = res.tables[0];
    expect(t.name).toBe('orders');
    expect(t.comment).toBe('Customer orders');
    expect(t.columns[0].type).toBe('INT UNSIGNED');
    expect(t.columns[0].autoIncrement).toBe(true);
    expect(t.columns[0].primaryKey).toBe(true);
    expect(t.columns[2].type).toBe("ENUM('new','paid')");
    expect(t.columns[2].defaultValue).toBe("'new'");
    expect(t.columns[2].comment).toBe('lifecycle');
    expect(t.columns[3].defaultValue).toBe('0.00');
    expect(t.columns[5].defaultValue).toBe('CURRENT_TIMESTAMP');
    expect(t.indexes[0]).toEqual({ name: 'idx_customer', columns: ['customer_id'], unique: false });
    expect(t.uniques[0]).toEqual({ name: 'uq_status_total', columns: ['status', 'total'] });
    expect(t.foreignKeys[0].name).toBe('fk_orders_customer');
    expect(t.foreignKeys[0].onUpdate).toBe('CASCADE');
  });

  it('keeps identifier case and treats a column named key as a column', () => {
    const res = parseSql('CREATE TABLE Settings (`key` VARCHAR(50) PRIMARY KEY, Value TEXT);', 'mariadb');
    expect(res.errors).toEqual([]);
    expect(res.tables[0].name).toBe('Settings');
    expect(res.tables[0].columns.map((c) => c.name)).toEqual(['key', 'Value']);
  });
});

describe('importSql', () => {
  it('creates placeholder tables for unresolved references and resolves FK columns', () => {
    const r = importSql('CREATE TABLE a (id INT PRIMARY KEY, b_id INT REFERENCES b);', 'postgresql');
    expect(r.tables.map((t) => t.name).sort()).toEqual(['a', 'b']);
    expect(r.relationships).toHaveLength(1);
    const b = r.tables.find((t) => t.name === 'b')!;
    expect(r.relationships[0].targetColumnIds).toEqual([b.columns[0].id]);
    expect(r.warnings.some((w) => w.includes('placeholder'))).toBe(true);
  });

  it('resolves reference columns to the target primary key when omitted', () => {
    const r = importSql(
      `CREATE TABLE p (code VARCHAR(10) PRIMARY KEY);
       CREATE TABLE c (id INT PRIMARY KEY, p_code VARCHAR(10) REFERENCES p);`,
      'postgresql',
    );
    const p = r.tables.find((t) => t.name === 'p')!;
    expect(r.relationships[0].targetColumnIds).toEqual([p.columns[0].id]);
  });
});
