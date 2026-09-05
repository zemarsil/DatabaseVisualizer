import { describe, expect, it } from 'vitest';
import type { Diagram, IntrospectResponse } from '../src/shared/types';
import { createColumn, createIndex, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { sampleDiagram } from '../src/lib/sample';
import { generateSchema } from '../src/lib/sql/generator';
import { getSqliteEngine } from '../src/lib/sqlite/engine';
import { comparableDefault, comparableType, diffDiagramAgainst, diffSchemas, snapshotFromDiagram, snapshotFromIntrospection, type Change } from '../src/lib/migrate/diff';
import { generateMigration, placeholderFor } from '../src/lib/migrate/alter';

/** A two-table diagram: customers (id, email, name) <- orders (id, customer_id, total). */
function base(dialect: Diagram['dialect']): Diagram {
  const d = emptyDiagram(dialect, 'Mig');
  const customers = createTable({
    name: 'customers',
    columns: [
      createColumn({ name: 'id', type: dialect === 'mariadb' ? 'INT' : 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false }),
      createColumn({ name: 'email', type: 'VARCHAR(255)', nullable: false, unique: true }),
      createColumn({ name: 'name', type: 'VARCHAR(100)', nullable: true }),
    ],
  });
  const orders = createTable({
    name: 'orders',
    columns: [
      createColumn({ name: 'id', type: dialect === 'mariadb' ? 'INT' : 'INTEGER', primaryKey: true, autoIncrement: true, nullable: false }),
      createColumn({ name: 'customer_id', type: dialect === 'mariadb' ? 'INT' : 'INTEGER', nullable: false }),
      createColumn({ name: 'total', type: 'NUMERIC(10,2)', nullable: false, defaultValue: '0' }),
    ],
  });
  orders.indexes.push(createIndex({ name: 'idx_orders_customer', columnIds: [orders.columns[1].id] }));
  d.tables.push(customers, orders);
  d.relationships.push(createRelationship({ kind: 'fk', sourceTableId: orders.id, sourceColumnIds: [orders.columns[1].id], targetTableId: customers.id, targetColumnIds: [customers.columns[0].id], name: 'fk_orders_customers' }));
  return d;
}

/** What a live database that already matches `base` would report. */
function introspected(dialect: Diagram['dialect']): IntrospectResponse {
  const schema = dialect === 'postgresql' ? 'public' : dialect === 'mariadb' ? 'app' : 'main';
  const int = dialect === 'postgresql' ? 'integer' : dialect === 'mariadb' ? 'int(11)' : 'INTEGER';
  return {
    serverVersion: 'test',
    tables: [
      {
        schema,
        name: 'customers',
        comment: null,
        columns: [
          { name: 'id', type: int, nullable: false, defaultValue: null, autoIncrement: true, comment: null },
          { name: 'email', type: dialect === 'postgresql' ? 'character varying(255)' : 'varchar(255)', nullable: false, defaultValue: null, autoIncrement: false, comment: null },
          { name: 'name', type: dialect === 'postgresql' ? 'character varying(100)' : 'varchar(100)', nullable: true, defaultValue: null, autoIncrement: false, comment: null },
        ],
        primaryKey: ['id'],
        uniques: [{ name: 'customers_email_key', columns: ['email'] }],
        indexes: dialect === 'postgresql' ? [{ name: 'customers_email_key', columns: ['email'], unique: true }] : [],
        foreignKeys: [],
      },
      {
        schema,
        name: 'orders',
        comment: null,
        columns: [
          { name: 'id', type: int, nullable: false, defaultValue: null, autoIncrement: true, comment: null },
          { name: 'customer_id', type: int, nullable: false, defaultValue: null, autoIncrement: false, comment: null },
          { name: 'total', type: 'numeric(10,2)', nullable: false, defaultValue: dialect === 'postgresql' ? '0' : '0', autoIncrement: false, comment: null },
        ],
        primaryKey: ['id'],
        uniques: [],
        indexes: [{ name: 'idx_orders_customer', columns: ['customer_id'], unique: false }],
        foreignKeys: [{ name: 'fk_orders_customers', columns: ['customer_id'], refSchema: schema, refTable: 'customers', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }],
      },
    ],
    enums: [],
  };
}

const kinds = (changes: Change[]) => changes.map((c) => c.op.kind).sort();

describe('type and default comparison', () => {
  it('treats spelling variants as the same type', () => {
    expect(comparableType('character varying(20)', 'postgresql')).toBe('VARCHAR(20)');
    expect(comparableType('SERIAL', 'postgresql')).toBe('INTEGER');
    expect(comparableType('timestamp with time zone', 'postgresql')).toBe('TIMESTAMPTZ');
    expect(comparableType('timestamp(3) without time zone', 'postgresql')).toBe('TIMESTAMP(3)');
    expect(comparableType('int(11)', 'mariadb')).toBe('INTEGER');
    expect(comparableType('bigint(20) unsigned', 'mariadb')).toBe('BIGINT UNSIGNED');
    expect(comparableType('tinyint(1)', 'mariadb')).toBe('BOOLEAN');
    expect(comparableType('BOOL', 'mariadb')).toBe('BOOLEAN');
    expect(comparableType("enum('a','b')", 'mariadb')).toBe("ENUM('a','b')");
    expect(comparableType('text[]', 'postgresql')).toBe('TEXT[]');
    expect(comparableType('public.order_status', 'postgresql')).toBe('ORDER_STATUS');
  });

  it('normalises default expressions', () => {
    expect(comparableDefault("'pending'::character varying", 'postgresql')).toBe("'pending'");
    expect(comparableDefault('now()', 'postgresql')).toBe('current_timestamp');
    expect(comparableDefault('CURRENT_TIMESTAMP', 'postgresql')).toBe('current_timestamp');
    expect(comparableDefault('current_timestamp()', 'mariadb')).toBe('current_timestamp');
    expect(comparableDefault('NULL', 'postgresql')).toBeNull();
    expect(comparableDefault('', 'postgresql')).toBeNull();
    expect(comparableDefault('pending', 'mariadb')).toBe("'pending'");
    expect(comparableDefault('TRUE', 'mariadb')).toBe('1');
    expect(comparableDefault('(0)', 'sqlite')).toBe('0');
  });
});

describe('diff', () => {
  for (const dialect of ['postgresql', 'mariadb', 'sqlite'] as const) {
    it(`finds nothing to do when the ${dialect} database matches`, () => {
      const { changes } = diffDiagramAgainst(base(dialect), introspected(dialect));
      expect(changes).toEqual([]);
    });
  }

  it('detects every kind of table change', () => {
    const d = base('postgresql');
    const customers = d.tables[0];
    const orders = d.tables[1];
    customers.columns.push(createColumn({ name: 'phone', type: 'VARCHAR(20)', nullable: true }));
    customers.columns[2].type = 'TEXT'; // name: varchar(100) -> text
    customers.columns[2].nullable = false;
    orders.columns = orders.columns.filter((c) => c.name !== 'total'); // drop column
    orders.indexes = []; // drop index
    d.relationships = []; // drop fk
    d.tables.push(createTable({ name: 'products', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false })] }));
    const { changes } = diffDiagramAgainst(d, introspected('postgresql'));
    expect(kinds(changes)).toEqual(['add-column', 'alter-column', 'create-table', 'drop-column', 'drop-foreign-key', 'drop-index']);
    const alter = changes.find((c) => c.op.kind === 'alter-column')!;
    expect(alter.op.kind === 'alter-column' && alter.op.changes).toEqual(['type', 'nullable']);
    expect(alter.risk).toBe('risky');
    expect(changes.find((c) => c.op.kind === 'drop-column')!.risk).toBe('destructive');
    expect(changes.find((c) => c.op.kind === 'drop-column')!.defaultOn).toBe(false);
    expect(changes.find((c) => c.op.kind === 'add-column')!.defaultOn).toBe(true);
  });

  it('reports dropped tables, new foreign keys and changed referential actions', () => {
    const d = base('postgresql');
    d.relationships[0].onDelete = 'CASCADE';
    const res = introspected('postgresql');
    res.tables.push({ schema: 'public', name: 'legacy', comment: null, columns: [{ name: 'id', type: 'integer', nullable: false, defaultValue: null, autoIncrement: false, comment: null }], primaryKey: ['id'], uniques: [], indexes: [], foreignKeys: [] });
    const { changes } = diffDiagramAgainst(d, res);
    expect(kinds(changes)).toEqual(['add-foreign-key', 'drop-foreign-key', 'drop-table']);
  });

  it('ignores external groups and views without SQL, and diffs enums on PostgreSQL', () => {
    const d = base('postgresql');
    d.customTypes.push({ id: 'ct1', name: 'order_status', kind: 'enum', values: ['new', 'paid', 'shipped'] });
    d.tables[1].columns.push(createColumn({ name: 'status', type: 'order_status', nullable: false, defaultValue: "'new'" }));
    d.groups.push({ id: 'g1', name: 'CRM', color: 'purple', external: true, position: { x: 0, y: 0 } });
    d.tables.push(createTable({ name: 'crm_accounts', groupId: 'g1', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false })] }));
    d.tables.push(createTable({ name: 'report', kind: 'view', columns: [] }));
    const res = introspected('postgresql');
    res.enums = [{ schema: 'public', name: 'order_status', values: ['new', 'paid'] }];
    const { changes } = diffDiagramAgainst(d, res);
    expect(kinds(changes)).toEqual(['add-column', 'add-enum-values']);
    const ev = changes.find((c) => c.op.kind === 'add-enum-values')!;
    expect(ev.op.kind === 'add-enum-values' && ev.op.values).toEqual(['shipped']);
  });

  it('matches tables across schema spellings', () => {
    const d = base('postgresql');
    d.tables[0].schema = 'public';
    d.tables[1].schema = 'sales';
    const res = introspected('postgresql');
    res.tables[1].schema = 'sales';
    res.tables[1].foreignKeys[0].refSchema = 'public';
    const { changes } = diffDiagramAgainst(d, res);
    expect(changes).toEqual([]);
  });

  it('snapshots the diagram with the emitted types and unique constraints', () => {
    const snap = snapshotFromDiagram(base('sqlite'), 'main');
    const customers = snap.tables.find((t) => t.name === 'customers')!;
    expect(customers.columns[0].type).toBe('INTEGER');
    expect(customers.indexes).toEqual([{ name: 'uq_customers_email', columns: ['email'], unique: true, constraint: true }]);
    const db = snapshotFromIntrospection(introspected('postgresql'), 'postgresql');
    expect(db.tables[0].indexes).toHaveLength(1); // the unique constraint and its backing index are one thing
    expect(diffSchemas(snapshotFromDiagram(base('postgresql'), 'public'), db)).toEqual([]);
  });
});

describe('alter script', () => {
  it('writes PostgreSQL ALTER statements in a safe order', () => {
    const d = base('postgresql');
    const customers = d.tables[0];
    const orders = d.tables[1];
    customers.columns.push(createColumn({ name: 'phone', type: 'VARCHAR(20)', nullable: false }));
    customers.columns[2].type = 'TEXT';
    orders.columns = orders.columns.filter((c) => c.name !== 'total');
    d.relationships[0].onDelete = 'CASCADE';
    d.customTypes.push({ id: 'ct1', name: 'mood', kind: 'enum', values: ['ok', 'bad'] });
    const { changes, current } = diffDiagramAgainst(d, introspected('postgresql'));
    const m = generateMigration(d, changes, current);
    const s = m.statements;
    expect(s).toContain("CREATE TYPE mood AS ENUM ('ok', 'bad');");
    expect(s).toContain('ALTER TABLE orders DROP CONSTRAINT fk_orders_customers;');
    expect(s).toContain('ALTER TABLE orders DROP COLUMN total;');
    expect(s).toContain("ALTER TABLE customers ADD COLUMN phone VARCHAR(20) NOT NULL DEFAULT '';");
    expect(s).toContain('ALTER TABLE customers ALTER COLUMN phone DROP DEFAULT;');
    expect(s).toContain('ALTER TABLE customers ALTER COLUMN name TYPE TEXT USING name::TEXT;');
    expect(s).toContain('ALTER TABLE orders ADD CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE;');
    // drops before adds, the new FK last
    expect(s.indexOf('ALTER TABLE orders DROP CONSTRAINT fk_orders_customers;')).toBeLessThan(s.findIndex((x) => x.startsWith('ALTER TABLE orders ADD CONSTRAINT')));
    expect(m.script).toContain('-- Migration for Mig (PostgreSQL)');
  });

  it('uses MODIFY COLUMN and FOREIGN_KEY_CHECKS on MariaDB', () => {
    const d = base('mariadb');
    d.tables[0].columns[2].nullable = false;
    d.tables[0].columns[2].defaultValue = "'anon'";
    const res = introspected('mariadb');
    res.tables.push({ schema: 'app', name: 'legacy', comment: null, columns: [], primaryKey: [], uniques: [], indexes: [], foreignKeys: [] });
    const { changes, current } = diffDiagramAgainst(d, res);
    const m = generateMigration(d, changes, current);
    expect(m.statements).toEqual(['SET FOREIGN_KEY_CHECKS = 0;', 'DROP TABLE IF EXISTS app.legacy;', 'SET FOREIGN_KEY_CHECKS = 1;', "ALTER TABLE customers MODIFY COLUMN name VARCHAR(100) NOT NULL DEFAULT 'anon';"]);
  });

  it('rebuilds a SQLite table that needs a column change, and adds simple columns in place', () => {
    const d = base('sqlite');
    d.tables[0].columns[2].type = 'TEXT';
    d.tables[1].columns.push(createColumn({ name: 'note', type: 'TEXT', nullable: true }));
    const { changes, current } = diffDiagramAgainst(d, introspected('sqlite'));
    const m = generateMigration(d, changes, current);
    expect(m.rebuilt).toEqual(['customers']);
    expect(m.statements[0]).toBe('PRAGMA foreign_keys = OFF;');
    expect(m.statements.at(-1)).toBe('PRAGMA foreign_keys = ON;');
    expect(m.statements).toContain('ALTER TABLE orders ADD COLUMN note TEXT;');
    const create = m.statements.find((s) => s.startsWith('CREATE TABLE __new_customers'))!;
    expect(create).toContain('name TEXT');
    expect(m.statements).toContain('INSERT INTO __new_customers (id, email, name)\nSELECT id, email, name FROM customers;');
    expect(m.statements).toContain('DROP TABLE customers;');
    expect(m.statements).toContain('ALTER TABLE __new_customers RENAME TO customers;');
  });

  it('only includes the selected changes', () => {
    const d = base('postgresql');
    d.tables[0].columns.push(createColumn({ name: 'phone', type: 'VARCHAR(20)', nullable: true }));
    d.tables[1].columns = d.tables[1].columns.filter((c) => c.name !== 'total');
    const { changes, current } = diffDiagramAgainst(d, introspected('postgresql'));
    const safe = changes.filter((c) => c.defaultOn);
    const m = generateMigration(d, safe, current);
    expect(m.statements).toEqual(['ALTER TABLE customers ADD COLUMN phone VARCHAR(20);']);
    expect(generateMigration(d, [], current).script).toContain('Nothing to do');
  });

  it('picks placeholders that let NOT NULL columns be added to full tables', () => {
    expect(placeholderFor('INTEGER', 'postgresql')).toBe('0');
    expect(placeholderFor('BOOLEAN', 'mariadb')).toBe('0');
    expect(placeholderFor('TIMESTAMPTZ', 'postgresql')).toBe('CURRENT_TIMESTAMP');
    expect(placeholderFor('VARCHAR(10)', 'sqlite')).toBe("''");
    expect(placeholderFor('UUID', 'postgresql')).toBeNull();
  });

  it('migrates a real SQLite database until the diff is empty', async () => {
    const engine = await getSqliteEngine();
    await engine.reset();
    const d = { ...sampleDiagram(), dialect: 'sqlite' as const };
    const created = await engine.exec(generateSchema(d).statements, true);
    expect(created.every((r) => r.ok)).toBe(true);
    // a database that matches the diagram needs nothing
    expect(diffDiagramAgainst(d, await engine.introspect()).changes).toEqual([]);

    const d2 = structuredClone(d);
    const customers = d2.tables.find((t) => t.name === 'customers')!;
    customers.columns.push(createColumn({ name: 'phone', type: 'VARCHAR(20)', nullable: true }));
    customers.columns.push(createColumn({ name: 'score', type: 'INTEGER', nullable: false }));
    customers.columns.find((c) => c.name === 'full_name')!.type = 'VARCHAR(300)';
    const orders = d2.tables.find((t) => t.name === 'orders')!;
    orders.columns = orders.columns.filter((c) => c.name !== 'status');
    const products = d2.tables.find((t) => t.name === 'products')!;
    products.indexes.push(createIndex({ name: 'idx_products_name', columnIds: [products.columns.find((c) => c.name === 'name')!.id] }));
    d2.tables = d2.tables.filter((t) => t.name !== 'daily_sales');
    d2.relationships = d2.relationships.filter((r) => d2.tables.some((t) => t.id === r.sourceTableId) && d2.tables.some((t) => t.id === r.targetTableId));

    const { changes, current } = diffDiagramAgainst(d2, await engine.introspect());
    expect(kinds(changes)).toEqual(['add-column', 'add-column', 'add-index', 'alter-column', 'drop-column', 'drop-table']);
    const m = generateMigration(d2, changes, current);
    expect(m.rebuilt).toEqual(['customers']); // orders only loses a plain column, which SQLite can drop in place
    expect(m.statements).toContain('ALTER TABLE orders DROP COLUMN status;');
    const results = await engine.exec(m.statements, true);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(diffDiagramAgainst(d2, await engine.introspect()).changes).toEqual([]);
    // the rebuilt tables kept their foreign keys and indexes
    const fks = await engine.query("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('orders')");
    expect(fks.rows[0][0]).toBe(2);
    const idx = await engine.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orders' AND name NOT LIKE 'sqlite_%'");
    expect(idx.rows.map((r) => r[0])).toEqual(['idx_orders_customer']);
  });
});
