import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Diagram, Table } from '../src/shared/types';
import { createColumn, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { generateDropStatements, generateSchema, generateTableSql } from '../src/lib/sql/generator';
import { parseSql } from '../src/lib/sql/parser';
import { importSql } from '../src/lib/sql/import';
import { lintDiagram } from '../src/lib/lint';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { diffDiagramAgainst } from '../src/lib/migrate/diff';
import { generateMigration } from '../src/lib/migrate/alter';
import { introspectionToDiagram } from '../src/lib/introspectImport';
import { INTROSPECT_QUERIES } from '../server/db/postgres';
import { getSqliteEngine } from '../src/lib/sqlite/engine';
import { getNodeDuckdb } from './helpers/duckdbNode';

function idTable(name: string, extra: Partial<Table> = {}): Table {
  return createTable({ name, columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false })], ...extra });
}

function diagramWith(dialect: Diagram['dialect'], ...tables: Table[]): Diagram {
  const d = emptyDiagram(dialect);
  d.tables.push(...tables);
  return d;
}

describe('temporary and unlogged tables: generator', () => {
  it('writes CREATE TEMPORARY TABLE and CREATE UNLOGGED TABLE on PostgreSQL', () => {
    const d = diagramWith('postgresql', idTable('scratch', { storage: 'temporary' }), idTable('cache', { storage: 'unlogged' }), idTable('plain'));
    const { script, warnings } = generateSchema(d);
    expect(script).toContain('CREATE TEMPORARY TABLE scratch (');
    expect(script).toContain('CREATE UNLOGGED TABLE cache (');
    expect(script).toContain('CREATE TABLE plain (');
    expect(warnings).toEqual([]);
  });

  it('adds ON COMMIT only for the two settings that change something', () => {
    const sqlFor = (onCommit?: Table['onCommit']) => {
      const t = idTable('t', { storage: 'temporary', onCommit });
      return generateTableSql(diagramWith('postgresql', t), t.id);
    };
    expect(sqlFor()).not.toContain('ON COMMIT');
    expect(sqlFor('preserve')).not.toContain('ON COMMIT');
    expect(sqlFor('delete')).toMatch(/\)\s+ON COMMIT DELETE ROWS;/);
    expect(sqlFor('drop')).toMatch(/\)\s+ON COMMIT DROP;/);
  });

  it('leaves the schema off a temporary table, everywhere the table is named', () => {
    const t = idTable('scratch', { storage: 'temporary', schema: 'app', indexes: [] });
    t.columns.push(createColumn({ name: 'note', type: 'TEXT', comment: 'why' }));
    t.indexes.push({ id: 'ix', name: 'ix_note', unique: false, columnIds: [t.columns[1].id] });
    t.comment = 'work area';
    const d = diagramWith('postgresql', t);
    const { script, warnings } = generateSchema(d);
    expect(script).not.toContain('app');
    expect(script).toContain('ON scratch');
    expect(script).toContain('COMMENT ON TABLE scratch');
    expect(warnings.join('\n')).toMatch(/schema "app" was left out/);
  });

  it('uses TEMPORARY on every dialect, and warns where ON COMMIT does not exist', () => {
    for (const dialect of ['mariadb', 'sqlite', 'duckdb'] as const) {
      const d = diagramWith(dialect, idTable('scratch', { storage: 'temporary', onCommit: 'drop' }));
      const { script, warnings } = generateSchema(d);
      expect(script, dialect).toMatch(/CREATE TEMPORARY TABLE scratch \(/);
      expect(script, dialect).not.toContain('ON COMMIT');
      expect(warnings.join('\n'), dialect).toMatch(/no ON COMMIT clause/);
    }
  });

  it('writes an unlogged table as an ordinary one, with a warning, outside PostgreSQL', () => {
    for (const dialect of ['mariadb', 'sqlite', 'duckdb'] as const) {
      const d = diagramWith(dialect, idTable('cache', { storage: 'unlogged' }));
      const { script, warnings } = generateSchema(d);
      expect(script, dialect).not.toMatch(/UNLOGGED TABLE/);
      expect(script, dialect).toMatch(/CREATE TABLE cache \(/);
      expect(warnings.join('\n'), dialect).toMatch(/no unlogged tables/);
      expect(lintDiagram(d).map((f) => f.rule), dialect).toContain('unlogged-unsupported');
    }
  });

  it('ignores storage on a view', () => {
    const v = createTable({ name: 'v', kind: 'view', viewSql: 'SELECT 1 AS n', storage: 'temporary' });
    expect(generateSchema(diagramWith('postgresql', v)).script).toContain('CREATE VIEW v AS');
  });

  it('drops a temporary table by its session name so a permanent namesake survives', () => {
    const pg = generateDropStatements(diagramWith('postgresql', idTable('scratch', { storage: 'temporary' }), idTable('plain')));
    expect(pg).toContain('DROP TABLE IF EXISTS pg_temp.scratch CASCADE;');
    expect(pg).toContain('DROP TABLE IF EXISTS plain CASCADE;');
    const maria = generateDropStatements(diagramWith('mariadb', idTable('scratch', { storage: 'temporary' })));
    expect(maria).toContain('DROP TEMPORARY TABLE IF EXISTS scratch;');
  });
});

describe('temporary and unlogged tables: lint', () => {
  const fk = (d: Diagram, from: Table, to: Table) =>
    d.relationships.push(
      createRelationship({ kind: 'fk', sourceTableId: from.id, sourceColumnIds: [from.columns[1].id], targetTableId: to.id, targetColumnIds: [to.columns[0].id] }),
    );
  const child = (storage?: Table['storage']) => idTable('child', { storage, columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'parent_id', type: 'INTEGER' })] });

  it.each([
    ['permanent', 'temporary', true],
    ['permanent', 'unlogged', true],
    ['unlogged', 'temporary', true],
    ['temporary', 'permanent', true],
    ['temporary', 'unlogged', true],
    ['unlogged', 'permanent', false],
    ['unlogged', 'unlogged', false],
    ['temporary', 'temporary', false],
  ] as const)('PostgreSQL: %s table referencing %s -> error is %s', (from, to, error) => {
    const p = idTable('parent', { storage: to === 'permanent' ? undefined : to });
    const c = child(from === 'permanent' ? undefined : from);
    const d = diagramWith('postgresql', p, c);
    fk(d, c, p);
    expect(lintDiagram(d).some((f) => f.rule === 'fk-storage-mismatch' && f.severity === 'error')).toBe(error);
  });

  it('PostgreSQL: a permanent table referencing another permanent one is fine', () => {
    const p = idTable('parent');
    const c = child();
    const d = diagramWith('postgresql', p, c);
    fk(d, c, p);
    expect(lintDiagram(d).map((f) => f.rule)).not.toContain('fk-storage-mismatch');
  });

  it('MariaDB: a foreign key on a temporary table is a warning', () => {
    const p = idTable('parent');
    const c = child('temporary');
    const d = diagramWith('mariadb', p, c);
    fk(d, c, p);
    expect(lintDiagram(d).find((f) => f.rule === 'fk-storage-mismatch')?.severity).toBe('warning');
  });
});

describe('temporary and unlogged tables: import and files', () => {
  it('reads CREATE TEMP / TEMPORARY / UNLOGGED TABLE and ON COMMIT', () => {
    const res = parseSql(`
      CREATE TEMP TABLE a (id int PRIMARY KEY);
      CREATE TEMPORARY TABLE b (id int) ON COMMIT DELETE ROWS;
      CREATE UNLOGGED TABLE c (id int);
      CREATE GLOBAL TEMPORARY TABLE d (id int) ON COMMIT PRESERVE ROWS;
      CREATE TABLE e (id int);
      CREATE TEMP TABLE f ON COMMIT DROP AS SELECT 1::int AS n;
    `, 'postgresql');
    expect(res.errors).toEqual([]);
    const by = Object.fromEntries(res.tables.map((t) => [t.name, t]));
    expect(by.a.storage).toBe('temporary');
    expect(by.b).toMatchObject({ storage: 'temporary', onCommit: 'delete' });
    expect(by.c.storage).toBe('unlogged');
    expect(by.d).toMatchObject({ storage: 'temporary', onCommit: 'preserve' });
    expect(by.e.storage).toBeUndefined();
    expect(by.f).toMatchObject({ storage: 'temporary', onCommit: 'drop' });
  });

  it('carries the setting into the diagram, dropping the default ON COMMIT and the temp schema', () => {
    const res = importSql(
      'CREATE TEMP TABLE pg_temp.a (id int); CREATE TEMP TABLE b (id int) ON COMMIT PRESERVE ROWS; CREATE TEMP TABLE c (id int) ON COMMIT DROP; CREATE UNLOGGED TABLE d (id int);',
      'postgresql',
    );
    const by = Object.fromEntries(res.tables.map((t) => [t.name, t]));
    expect(by.a).toMatchObject({ storage: 'temporary', schema: undefined });
    expect(by.b.onCommit).toBeUndefined();
    expect(by.c.onCommit).toBe('drop');
    expect(by.d.storage).toBe('unlogged');
  });

  it('round-trips through generate and import', () => {
    const d = diagramWith('postgresql', idTable('scratch', { storage: 'temporary', onCommit: 'delete' }), idTable('cache', { storage: 'unlogged' }), idTable('plain'));
    const again = importSql(generateSchema(d).script, 'postgresql');
    const by = Object.fromEntries(again.tables.map((t) => [t.name, t]));
    expect(by.scratch).toMatchObject({ storage: 'temporary', onCommit: 'delete' });
    expect(by.cache.storage).toBe('unlogged');
    expect(by.plain.storage).toBeUndefined();
  });

  it('is saved with the diagram and dropped when it is nonsense', () => {
    const d = diagramWith('postgresql', idTable('scratch', { storage: 'temporary', onCommit: 'drop' }), idTable('cache', { storage: 'unlogged', onCommit: 'drop' }));
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.tables[0]).toMatchObject({ storage: 'temporary', onCommit: 'drop' });
    // ON COMMIT means nothing to an unlogged table
    expect(back.tables[1]).toMatchObject({ storage: 'unlogged', onCommit: undefined });

    const raw = JSON.parse(serializeDiagram(d));
    raw.tables[0].storage = 'ephemeral';
    raw.tables[1].storage = 'temporary';
    raw.tables[1].onCommit = 'sometimes';
    const odd = parseDiagramFile(JSON.stringify(raw));
    expect(odd.tables[0].storage).toBeUndefined();
    expect(odd.tables[1]).toMatchObject({ storage: 'temporary', onCommit: undefined });
  });
});

describe('temporary and unlogged tables: migration', () => {
  it('leaves a temporary table out of the comparison with a live database', () => {
    const d = diagramWith('postgresql', idTable('scratch', { storage: 'temporary' }), idTable('plain'));
    const diff = diffDiagramAgainst(d, { serverVersion: '', tables: [], enums: [], extensions: [], routines: [] } as never);
    expect(diff.changes.map((c) => c.label)).toEqual(['Create table plain']);
  });

  it('proposes SET UNLOGGED / SET LOGGED when only the storage differs', () => {
    const current = (unlogged: boolean) =>
      ({ serverVersion: '', tables: [{ schema: 'public', name: 'cache', unlogged, comment: null, columns: [{ name: 'id', type: 'integer', nullable: false, defaultValue: null, autoIncrement: false, comment: null }], primaryKey: ['id'], uniques: [], indexes: [], foreignKeys: [] }], enums: [], extensions: [], routines: [] }) as never;
    const want = (storage?: Table['storage']) => diagramWith('postgresql', idTable('cache', { storage }));

    const toUnlogged = diffDiagramAgainst(want('unlogged'), current(false));
    expect(toUnlogged.changes.map((c) => c.label)).toEqual(['Make cache unlogged']);
    expect(generateMigration(want('unlogged'), toUnlogged.changes, toUnlogged.current).statements).toEqual(['ALTER TABLE cache SET UNLOGGED;']);

    const toLogged = diffDiagramAgainst(want(), current(true));
    expect(generateMigration(want(), toLogged.changes, toLogged.current).statements).toEqual(['ALTER TABLE cache SET LOGGED;']);

    expect(diffDiagramAgainst(want('unlogged'), current(true)).changes).toEqual([]);
    // no such thing off PostgreSQL, so nothing to compare
    const duck = diagramWith('duckdb', idTable('cache', { storage: 'unlogged' }));
    expect(diffDiagramAgainst(duck, current(false)).changes.map((c) => c.label)).not.toContain('Make cache unlogged');
  });
});

/* ---- against real engines: the point is that the SQL runs ---- */

describe('temporary and unlogged tables: PostgreSQL (PGlite)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('runs the script, and the catalog reports what was asked for', async () => {
    const parent = idTable('parent');
    const cache = idTable('cache', { storage: 'unlogged', columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'parent_id', type: 'INTEGER' })] });
    const scratch = idTable('scratch', { storage: 'temporary', onCommit: 'delete', schema: 'app' });
    const d = diagramWith('postgresql', parent, cache, scratch);
    d.relationships.push(createRelationship({ kind: 'fk', sourceTableId: cache.id, sourceColumnIds: [cache.columns[1].id], targetTableId: parent.id, targetColumnIds: [parent.columns[0].id] }));
    expect(lintDiagram(d).filter((f) => f.severity === 'error')).toEqual([]);

    for (const stmt of generateSchema(d).statements) await db.query(stmt);
    const persistence = await db.query<{ relname: string; relpersistence: string }>(`SELECT relname, relpersistence FROM pg_class WHERE relname IN ('parent','cache','scratch') ORDER BY relname`);
    expect(Object.fromEntries(persistence.rows.map((r) => [r.relname, r.relpersistence]))).toEqual({ parent: 'p', cache: 'u', scratch: 't' });

    // ON COMMIT DELETE ROWS: the row is gone after its transaction
    await db.query('INSERT INTO scratch (id) VALUES (1)');
    expect((await db.query('SELECT count(*)::int AS n FROM scratch')).rows).toEqual([{ n: 0 }]);

    // introspection sees the unlogged table and not the temporary one
    const tables = (await db.query<{ name: string; unlogged: boolean }>(INTROSPECT_QUERIES.tables)).rows;
    expect(tables.find((t) => t.name === 'cache')?.unlogged).toBe(true);
    expect(tables.find((t) => t.name === 'parent')?.unlogged).toBe(false);
    expect(tables.find((t) => t.name === 'scratch')).toBeUndefined();

    const back = introspectionToDiagram(
      { serverVersion: '', tables: tables.filter((t) => t.name !== 'scratch').map((t) => ({ schema: 'public', name: t.name, unlogged: t.unlogged, comment: null, columns: [{ name: 'id', type: 'integer', nullable: false, defaultValue: null, autoIncrement: false, comment: null }], primaryKey: ['id'], uniques: [], indexes: [], foreignKeys: [] })), enums: [], extensions: [], routines: [] } as never,
      'postgresql',
      null,
    );
    expect(back.tables.find((t) => t.name === 'cache')?.storage).toBe('unlogged');
    expect(back.tables.find((t) => t.name === 'parent')?.storage).toBeUndefined();

    // the drop script clears all three, and does not touch a permanent table
    for (const stmt of generateDropStatements(d)) await db.query(stmt);
    expect((await db.query(`SELECT relname FROM pg_class WHERE relname IN ('parent','cache','scratch')`)).rows).toEqual([]);
  });

  it('ON COMMIT DROP removes the table when its transaction ends', async () => {
    const t = idTable('gone', { storage: 'temporary', onCommit: 'drop' });
    const [create] = generateSchema(diagramWith('postgresql', t)).statements;
    await db.query(create);
    expect((await db.query(`SELECT relname FROM pg_class WHERE relname = 'gone'`)).rows).toEqual([]);
  });

  it('confirms the constraint rules the lint states', async () => {
    const attempt = async (parentKind: string, childKind: string) => {
      await db.query(`CREATE ${parentKind} TABLE lp (id int PRIMARY KEY)`);
      try {
        await db.query(`CREATE ${childKind} TABLE lc (id int PRIMARY KEY, p int REFERENCES lp(id))`);
        return true;
      } catch {
        return false;
      } finally {
        await db.query('DROP TABLE IF EXISTS lc');
        await db.query('DROP TABLE IF EXISTS lp');
      }
    };
    expect(await attempt('', '')).toBe(true);
    expect(await attempt('UNLOGGED', '')).toBe(false);
    expect(await attempt('TEMP', '')).toBe(false);
    expect(await attempt('TEMP', 'UNLOGGED')).toBe(false);
    expect(await attempt('', 'UNLOGGED')).toBe(true);
    expect(await attempt('UNLOGGED', 'UNLOGGED')).toBe(true);
    expect(await attempt('TEMP', 'TEMP')).toBe(true);
    expect(await attempt('', 'TEMP')).toBe(false);
  });
});

describe('temporary tables: SQLite and DuckDB engines', () => {
  it('sql.js runs CREATE TEMPORARY TABLE', async () => {
    const d = diagramWith('sqlite', idTable('scratch', { storage: 'temporary', schema: 'ignored' }), idTable('plain'));
    const engine = await getSqliteEngine();
    await engine.reset();
    const res = await engine.exec(generateSchema(d).statements, true);
    expect(res.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    await engine.exec(['INSERT INTO scratch (id) VALUES (1)'], true);
    const dropped = await engine.exec(generateDropStatements(d), true);
    expect(dropped.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
  });

  it('DuckDB runs CREATE TEMPORARY TABLE, even when the table names a schema', async () => {
    const d = diagramWith('duckdb', idTable('scratch', { storage: 'temporary', schema: 'main' }), idTable('plain'));
    const engine = await getNodeDuckdb();
    await engine.reset();
    const res = await engine.exec(generateSchema(d).statements, true);
    expect(res.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    expect(await engine.run(`SELECT table_name FROM duckdb_tables() WHERE temporary AND table_name = 'scratch'`)).toEqual([['scratch']]);
    // a temporary table is not part of the database being designed
    expect(await engine.tableCount()).toBe(1);
    const dropped = await engine.exec(generateDropStatements(d), true);
    expect(dropped.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
  }, 60000);
});
