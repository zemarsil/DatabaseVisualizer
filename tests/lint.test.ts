import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { importSql } from '../src/lib/sql/import';
import { createColumn, createGroup, createIndex, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { canonicalType, lintDiagram, summarizeFindings, typesMatch } from '../src/lib/lint';
import { suggestForeignKeys } from '../src/lib/suggest';

function fromSql(sql: string, dialect: Diagram['dialect'] = 'postgresql'): Diagram {
  const d = emptyDiagram(dialect);
  const res = importSql(sql, dialect);
  d.tables = res.tables;
  d.relationships = res.relationships;
  d.customTypes = res.customTypes;
  return d;
}

function rules(d: Diagram): string[] {
  return lintDiagram(d).map((f) => f.rule);
}

/** Apply a finding's fix on a deep copy and return the rules that remain. */
function afterFix(d: Diagram, rule: string): string[] {
  const f = lintDiagram(d).find((x) => x.rule === rule);
  expect(f?.fix, `${rule} should have a fix`).toBeTruthy();
  const copy = structuredClone(d);
  f!.fix!.apply(copy);
  return rules(copy);
}

describe('lintDiagram', () => {
  it('is quiet on a clean schema', () => {
    const d = fromSql(`
      CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT UNIQUE);
      CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id));
      CREATE INDEX idx_orders_customer ON orders(customer_id);
    `);
    expect(lintDiagram(d).filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('flags a foreign key to a non-unique column and fixes it with a unique index', () => {
    const d = fromSql(`
      CREATE TABLE a (id SERIAL PRIMARY KEY, code TEXT);
      CREATE TABLE b (id SERIAL PRIMARY KEY, a_code TEXT REFERENCES a(code));
    `);
    expect(rules(d)).toContain('fk-target-not-unique');
    expect(afterFix(d, 'fk-target-not-unique')).not.toContain('fk-target-not-unique');
  });

  it('reports missing primary keys and adds one', () => {
    const d = fromSql(`CREATE TABLE logs (message TEXT);`);
    expect(rules(d)).toContain('missing-primary-key');
    const fixed = structuredClone(d);
    lintDiagram(d).find((f) => f.rule === 'missing-primary-key')!.fix!.apply(fixed);
    expect(fixed.tables[0].columns[0].name).toBe('id');
    expect(fixed.tables[0].columns[0].primaryKey).toBe(true);
    expect(rules(fixed)).not.toContain('missing-primary-key');
  });

  it('promotes an existing id column instead of adding another', () => {
    const d = fromSql(`CREATE TABLE logs (id INTEGER, message TEXT);`);
    const fixed = structuredClone(d);
    lintDiagram(d).find((f) => f.rule === 'missing-primary-key')!.fix!.apply(fixed);
    expect(fixed.tables[0].columns).toHaveLength(2);
    expect(fixed.tables[0].columns[0].primaryKey).toBe(true);
  });

  it('spots type mismatches across a foreign key and fixes the referencing side', () => {
    const d = fromSql(`
      CREATE TABLE a (id BIGSERIAL PRIMARY KEY);
      CREATE TABLE b (id SERIAL PRIMARY KEY, a_id INTEGER REFERENCES a(id));
      CREATE INDEX i ON b(a_id);
    `);
    expect(rules(d)).toContain('fk-type-mismatch');
    const fixed = structuredClone(d);
    lintDiagram(d).find((f) => f.rule === 'fk-type-mismatch')!.fix!.apply(fixed);
    expect(fixed.tables.find((t) => t.name === 'b')!.columns.find((c) => c.name === 'a_id')!.type).toBe('BIGINT');
    expect(rules(fixed)).not.toContain('fk-type-mismatch');
  });

  it('treats SERIAL, INTEGER and INT as the same type', () => {
    expect(typesMatch('SERIAL', 'integer')).toBe(true);
    expect(typesMatch('INT', 'INTEGER')).toBe(true);
    expect(typesMatch('character varying(20)', 'VARCHAR(20)')).toBe(true);
    expect(typesMatch('VARCHAR(20)', 'VARCHAR(30)')).toBe(false);
    expect(canonicalType('timestamptz')).toBe('TIMESTAMP WITH TIME ZONE');
  });

  it('wants an index under a foreign key on PostgreSQL but not on MariaDB', () => {
    const sql = `
      CREATE TABLE a (id INT PRIMARY KEY);
      CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a(id));
    `;
    expect(rules(fromSql(sql, 'postgresql'))).toContain('fk-without-index');
    expect(rules(fromSql(sql, 'mariadb'))).not.toContain('fk-without-index');
    expect(afterFix(fromSql(sql, 'postgresql'), 'fk-without-index')).not.toContain('fk-without-index');
  });

  it('rejects SET NULL on a NOT NULL column and fixes nullability', () => {
    const d = fromSql(`
      CREATE TABLE a (id INT PRIMARY KEY);
      CREATE TABLE b (id INT PRIMARY KEY, a_id INT NOT NULL REFERENCES a(id) ON DELETE SET NULL);
    `);
    expect(rules(d)).toContain('fk-set-null-on-not-null');
    expect(afterFix(d, 'fk-set-null-on-not-null')).not.toContain('fk-set-null-on-not-null');
  });

  it('catches duplicate table, column and index definitions', () => {
    const d = emptyDiagram();
    const t1 = createTable({ name: 'users' });
    t1.columns.push(createColumn({ name: 'id', primaryKey: true }), createColumn({ name: 'email' }), createColumn({ name: 'Email' }));
    t1.indexes.push(createIndex({ columnIds: [t1.columns[1].id] }), createIndex({ columnIds: [t1.columns[1].id] }));
    const t2 = createTable({ name: 'Users' });
    t2.columns.push(createColumn({ name: 'id', primaryKey: true }));
    d.tables.push(t1, t2);
    const r = rules(d);
    expect(r).toContain('duplicate-table-name');
    expect(r).toContain('duplicate-column-name');
    expect(r).toContain('duplicate-index');
    expect(afterFix(d, 'duplicate-table-name')).not.toContain('duplicate-table-name');
    expect(afterFix(d, 'duplicate-column-name')).not.toContain('duplicate-column-name');
    expect(afterFix(d, 'duplicate-index')).not.toContain('duplicate-index');
  });

  it('handles empty names, empty tables, reserved words and long identifiers', () => {
    const d = emptyDiagram();
    const t = createTable({ name: 'order' });
    t.columns.push(createColumn({ name: 'id', primaryKey: true }), createColumn({ name: '' }), createColumn({ name: 'x'.repeat(70) }));
    d.tables.push(t, createTable({ name: 'empty' }));
    const r = rules(d);
    expect(r).toContain('empty-column-name');
    expect(r).toContain('table-without-columns');
    expect(r).toContain('reserved-word');
    expect(r).toContain('identifier-too-long');
    expect(afterFix(d, 'empty-column-name')).not.toContain('empty-column-name');
    expect(afterFix(d, 'table-without-columns')).not.toContain('table-without-columns');
  });

  it('describes join tables, self references and external foreign keys', () => {
    const d = fromSql(`
      CREATE TABLE students (id INT PRIMARY KEY);
      CREATE TABLE courses (id INT PRIMARY KEY);
      CREATE TABLE enrollments (student_id INT REFERENCES students(id), course_id INT REFERENCES courses(id), PRIMARY KEY (student_id, course_id));
      CREATE TABLE categories (id INT PRIMARY KEY, parent_id INT NOT NULL REFERENCES categories(id));
      CREATE INDEX i1 ON enrollments(student_id);
      CREATE INDEX i2 ON enrollments(course_id);
      CREATE INDEX i3 ON categories(parent_id);
    `);
    const group = createGroup({ name: 'Other DB', external: true });
    d.groups.push(group);
    d.tables.find((t) => t.name === 'courses')!.groupId = group.id;
    const r = rules(d);
    expect(r).toContain('join-table');
    expect(r).toContain('self-reference-not-null');
    expect(r).toContain('fk-crosses-external');
    expect(summarizeFindings(lintDiagram(d)).errors).toBe(0);
  });

  it('flags incomplete foreign keys, embeds without a column and views without SQL', () => {
    const d = emptyDiagram();
    const a = createTable({ name: 'a' });
    a.columns.push(createColumn({ name: 'id', primaryKey: true }), createColumn({ name: 'payload', type: 'JSONB' }));
    const b = createTable({ name: 'b' });
    b.columns.push(createColumn({ name: 'id', primaryKey: true }));
    const v = createTable({ name: 'v', kind: 'view', viewSql: '' });
    d.tables.push(a, b, v);
    d.relationships.push(
      createRelationship({ kind: 'fk', sourceTableId: a.id, sourceColumnIds: [], targetTableId: b.id, targetColumnIds: [b.columns[0].id] }),
      createRelationship({ kind: 'embed', sourceTableId: a.id, sourceColumnIds: [], targetTableId: b.id, targetColumnIds: [] }),
    );
    const r = rules(d);
    expect(r).toContain('fk-incomplete');
    expect(r).toContain('embed-without-column');
    expect(r).toContain('view-without-sql');
  });
});

describe('suggestForeignKeys', () => {
  it('matches singular and plural table names, camelCase and id_ prefixes', () => {
    const d = fromSql(`
      CREATE TABLE customers (id SERIAL PRIMARY KEY);
      CREATE TABLE category (id SERIAL PRIMARY KEY);
      CREATE TABLE companies (id SERIAL PRIMARY KEY);
      CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INTEGER, "categoryId" INTEGER, id_company INTEGER, note TEXT);
    `);
    const s = suggestForeignKeys(d);
    const pairs = s.map((x) => `${d.tables.find((t) => t.id === x.sourceTableId)!.columns.find((c) => c.id === x.sourceColumnId)!.name}->${d.tables.find((t) => t.id === x.targetTableId)!.name}`);
    expect(pairs).toEqual(expect.arrayContaining(['customer_id->customers', 'categoryId->category', 'id_company->companies']));
    expect(s.every((x) => x.confidence === 'high')).toBe(true);
  });

  it('skips columns that already have a foreign key and tables without a single primary key', () => {
    const d = fromSql(`
      CREATE TABLE customers (id SERIAL PRIMARY KEY);
      CREATE TABLE pairs (a INT, b INT, PRIMARY KEY (a, b));
      CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), pair_id INTEGER);
    `);
    expect(suggestForeignKeys(d)).toEqual([]);
  });

  it('suggests self references and lowers confidence on type clashes', () => {
    const d = fromSql(`
      CREATE TABLE employees (id SERIAL PRIMARY KEY, manager_id INTEGER);
      CREATE TABLE tags (id SERIAL PRIMARY KEY);
      CREATE TABLE posts (id SERIAL PRIMARY KEY, tag_id TEXT);
    `);
    const s = suggestForeignKeys(d);
    const self = s.find((x) => x.sourceTableId === x.targetTableId);
    expect(self?.confidence).toBe('medium');
    const clash = s.find((x) => d.tables.find((t) => t.id === x.targetTableId)!.name === 'tags');
    expect(clash?.confidence).toBe('medium');
  });
});
