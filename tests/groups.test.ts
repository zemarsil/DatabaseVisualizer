import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { createGroup, emptyDiagram } from '../src/lib/model';
import { importSql } from '../src/lib/sql/import';
import { generateDropStatements, generateSchema, generateTableSql } from '../src/lib/sql/generator';
import { boundsForTables, externalTableIds, groupAtPoint, groupBounds, rectCenter, tableRect, GROUP_HEADER, GROUP_PADDING } from '../src/lib/groups';
import { layoutDiagram } from '../src/lib/layout';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { buildJoinQuery, findPath } from '../src/lib/trace';
import { sampleDiagram } from '../src/lib/sample';

const OWN = `
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  crm_contact_id INTEGER
);
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id)
);
`;

const OTHER = `
CREATE TABLE crm_accounts (account_id INTEGER PRIMARY KEY, company VARCHAR(200) NOT NULL);
CREATE TABLE crm_contacts (
  contact_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES crm_accounts(account_id)
);
`;

/** Own schema plus a second database in a group, wired together by one FK. */
function twoDatabases(external = true): Diagram {
  const d = emptyDiagram('postgresql', 'two databases');
  const mine = importSql(OWN, 'postgresql');
  d.tables = mine.tables;
  d.relationships = mine.relationships;

  const theirs = importSql(OTHER, 'postgresql', d);
  const group = createGroup({ name: 'CRM', external, note: 'read-only replica' });
  for (const t of theirs.tables) t.groupId = group.id;
  d.groups.push(group);
  d.tables.push(...theirs.tables);
  d.relationships.push(...theirs.relationships);

  const customers = d.tables.find((t) => t.name === 'customers')!;
  const contacts = d.tables.find((t) => t.name === 'crm_contacts')!;
  d.relationships.push({
    id: 'rel_cross',
    kind: 'fk',
    sourceTableId: customers.id,
    sourceColumnIds: [customers.columns.find((c) => c.name === 'crm_contact_id')!.id],
    targetTableId: contacts.id,
    targetColumnIds: [contacts.columns.find((c) => c.name === 'contact_id')!.id],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
  });
  return d;
}

const tableNamed = (d: Diagram, name: string) => d.tables.find((t) => t.name === name)!;

describe('group geometry', () => {
  it('wraps its member tables with padding and room for the title', () => {
    const sizes = { a: { width: 200, height: 100 }, b: { width: 200, height: 100 } };
    const tables = [
      { ...tableStub('a'), position: { x: 0, y: 0 } },
      { ...tableStub('b'), position: { x: 300, y: 200 } },
    ];
    const box = boundsForTables(tables, sizes)!;
    expect(box.x).toBe(-GROUP_PADDING);
    expect(box.y).toBe(-GROUP_PADDING - GROUP_HEADER);
    expect(box.width).toBe(500 + GROUP_PADDING * 2);
    expect(box.height).toBe(300 + GROUP_PADDING * 2 + GROUP_HEADER);
  });

  it('falls back to the stored anchor while a group is empty', () => {
    const d = emptyDiagram();
    d.groups.push(createGroup({ id: 'g1', name: 'empty', position: { x: 500, y: 40 } }));
    const box = groupBounds(d)['g1'];
    expect(box.x).toBe(500);
    expect(box.y).toBe(40);
    expect(box.width).toBeGreaterThan(0);
  });

  it('finds which region a table centre falls in, and none outside them', () => {
    const d = twoDatabases();
    const bounds = groupBounds(d);
    const contacts = tableNamed(d, 'crm_contacts');
    contacts.position = { x: 0, y: 0 };
    tableNamed(d, 'crm_accounts').position = { x: 0, y: 300 };
    const fresh = groupBounds(d);
    expect(groupAtPoint(fresh, rectCenter(tableRect(contacts)))).toBe(d.groups[0].id);
    expect(groupAtPoint(fresh, { x: 5000, y: 5000 })).toBeNull();
    expect(Object.keys(bounds)).toEqual([d.groups[0].id]);
  });
});

describe('detangle with groups', () => {
  it('keeps a group together and leaves ungrouped tables outside its region', () => {
    const d = twoDatabases();
    const positions = layoutDiagram(d, { direction: 'LR' });
    expect(Object.keys(positions)).toHaveLength(d.tables.length);
    for (const t of d.tables) t.position = positions[t.id];

    const box = groupBounds(d)[d.groups[0].id];
    const outsiders = d.tables.filter((t) => !t.groupId);
    for (const t of outsiders) {
      const r = tableRect(t);
      const overlaps = r.x < box.x + box.width && box.x < r.x + r.width && r.y < box.y + box.height && box.y < r.y + r.height;
      expect(overlaps, `${t.name} should not sit inside the group region`).toBe(false);
    }
  });

  it('lays out the grouped sample diagram without losing a table', () => {
    const d = sampleDiagram();
    expect(d.groups.length).toBeGreaterThan(0);
    const positions = layoutDiagram(d, { direction: 'TB' });
    expect(Object.keys(positions)).toHaveLength(d.tables.length);
  });
});

describe('external groups and SQL', () => {
  it('leaves external tables out of the script and out of what gets executed', () => {
    const d = twoDatabases();
    const out = generateSchema(d);
    expect(out.script).toContain('CREATE TABLE customers');
    expect(out.script).toContain('CREATE TABLE orders');
    expect(out.script).not.toContain('CREATE TABLE crm_accounts');
    expect(out.script).not.toContain('CREATE TABLE crm_contacts');
    // nothing executable names either external table (customers.crm_contact_id
    // is our own column, so match the table names rather than the prefix)
    expect(out.statements.some((s) => /\bcrm_contacts\b|\bcrm_accounts\b/.test(s))).toBe(false);
  });

  it('documents the external source and the reference into it, without creating a constraint', () => {
    const d = twoDatabases();
    const out = generateSchema(d);
    expect(out.script).toContain('External sources');
    expect(out.script).toContain('-- CRM (2 tables)');
    expect(out.script).toContain('read-only replica');
    expect(out.script).toContain('--   crm_contacts (contact_id, account_id)');
    // the crossing reference appears only as a comment
    const alter = out.script.split('\n').filter((l) => l.includes('ADD CONSTRAINT') && l.includes('crm_contacts'));
    expect(alter).toHaveLength(1);
    expect(alter[0].trimStart().startsWith('--')).toBe(true);
    expect(out.statements.some((s) => s.includes('crm_contacts'))).toBe(false);
    expect(out.warnings.join(' ')).toContain('cannot cross databases');
  });

  it('creates those same tables when the group is not marked external', () => {
    const d = twoDatabases(false);
    const out = generateSchema(d);
    expect(out.script).toContain('CREATE TABLE crm_accounts');
    expect(out.statements.some((s) => s.includes('REFERENCES crm_contacts'))).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it('never drops an external table', () => {
    const drops = generateDropStatements(twoDatabases());
    expect(drops.some((s) => s.includes('customers'))).toBe(true);
    expect(drops.some((s) => s.includes('crm_'))).toBe(false);
  });

  it('marks the single-table preview of an external table', () => {
    const d = twoDatabases();
    const sql = generateTableSql(d, tableNamed(d, 'crm_accounts').id);
    expect(sql).toContain('does not create it');
    expect(sql).toContain('CREATE TABLE crm_accounts');
    // and the reference out of an owned table into the other database is dropped
    const own = generateTableSql(d, tableNamed(d, 'customers').id);
    expect(own).not.toContain('REFERENCES crm_contacts');
  });

  it('warns on a traced path that leaves the database', () => {
    const d = twoDatabases();
    const path = findPath(d, tableNamed(d, 'orders').id, tableNamed(d, 'crm_accounts').id)!;
    expect(path).not.toBeNull();
    const q = buildJoinQuery(d, path);
    expect(q).toContain('crosses into another database');
    // a path that stays put says nothing
    const local = findPath(d, tableNamed(d, 'orders').id, tableNamed(d, 'customers').id)!;
    expect(buildJoinQuery(d, local)).not.toContain('crosses into');
  });

  it('reports which tables are external', () => {
    const d = twoDatabases();
    expect(externalTableIds(d).size).toBe(2);
    d.groups[0].external = false;
    expect(externalTableIds(d).size).toBe(0);
  });
});

describe('saving and loading groups', () => {
  it('round-trips groups and membership through the file format', () => {
    const d = twoDatabases();
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.groups).toHaveLength(1);
    expect(back.groups[0]).toMatchObject({ name: 'CRM', external: true, note: 'read-only replica' });
    const members = back.tables.filter((t) => t.groupId === back.groups[0].id).map((t) => t.name).sort();
    expect(members).toEqual(['crm_accounts', 'crm_contacts']);
    expect(generateSchema(back).script).not.toContain('CREATE TABLE crm_accounts');
  });

  it('loads a file written before groups existed', () => {
    const d = twoDatabases();
    const raw = JSON.parse(serializeDiagram(d));
    delete raw.groups;
    const back = parseDiagramFile(JSON.stringify(raw));
    expect(back.groups).toEqual([]);
    // dangling group ids on the tables are dropped rather than kept
    expect(back.tables.every((t) => t.groupId === undefined)).toBe(true);
    expect(generateSchema(back).script).toContain('CREATE TABLE crm_accounts');
  });
});

function tableStub(id: string) {
  return { id, name: id, columns: [], indexes: [], checks: [], position: { x: 0, y: 0 }, color: 'blue' };
}
