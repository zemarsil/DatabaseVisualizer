import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, IntrospectResponse } from '../src/shared/types';

/**
 * Several databases connected at once: one main database the diagram is designed
 * for, and any number of external ones that are read but never written to.
 */

const { introspect } = vi.hoisted(() => ({ introspect: vi.fn<() => Promise<IntrospectResponse>>() }));

vi.mock('../src/lib/backend', () => ({
  backendFor: (config: ConnectionConfig) => ({
    kind: 'server',
    connection: config,
    label: `${config.dialect} ${config.database}@${config.host}:${config.port}`,
    test: async () => ({ ok: true, message: 'ok' }),
    apply: async () => ({ ok: true, results: [] }),
    query: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0 }),
    introspect,
    extensions: async () => ({ serverVersion: 'test', extensions: [] }),
  }),
}));

const { useConnection, defaultConnection } = await import('../src/store/useConnection');
const { useStore } = await import('../src/store/useStore');
const { readSchemaInto } = await import('../src/lib/readSchema');
const { emptyDiagram, createColumn, createTable } = await import('../src/lib/model');
const { generateSchema } = await import('../src/lib/sql/generator');

function serverConfig(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { ...defaultConnection('postgresql'), password: 'secret', ...over };
}

/** A database with `names` tables, the second one pointing at the first. */
function introspection(names: string[], serverVersion = 'PostgreSQL 16.2 on x86_64'): IntrospectResponse {
  return {
    serverVersion,
    tables: names.map((name, i) => ({
      schema: 'public',
      name,
      comment: null,
      columns: [
        { name: 'id', type: 'integer', nullable: false, defaultValue: null, autoIncrement: true, comment: null },
        ...(i > 0 ? [{ name: `${names[0]}_id`, type: 'integer', nullable: true, defaultValue: null, autoIncrement: false, comment: null }] : []),
      ],
      primaryKey: ['id'],
      uniques: [],
      indexes: [],
      foreignKeys:
        i > 0
          ? [{ name: `${name}_fk`, columns: [`${names[0]}_id`], refSchema: 'public', refTable: names[0], refColumns: ['id'], onDelete: 'NO ACTION' as const, onUpdate: 'NO ACTION' as const }]
          : [],
    })),
  };
}

/** One table of our own, so an external read has something to stay out of. */
function ownDiagram() {
  const d = emptyDiagram('postgresql', 'shop');
  d.tables = [createTable({ name: 'orders', position: { x: 0, y: 0 }, columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true })] })];
  return d;
}

beforeEach(() => {
  introspect.mockReset();
  useStore.setState({ diagram: ownDiagram(), past: [], future: [] });
  useConnection.setState({
    main: { id: 'conn_main', name: 'shop', config: serverConfig({ database: 'shop' }) },
    externals: [],
    queryTargetId: 'conn_main',
    defaultHost: '127.0.0.1',
  });
});

describe('the connections the app holds', () => {
  it('keeps the main database and the external ones apart, main first', () => {
    const id = useConnection.getState().addExternal({ name: 'CRM', config: serverConfig({ database: 'crm', port: 5433 }) });
    const s = useConnection.getState();
    expect(s.main.name).toBe('shop');
    expect(s.externals.map((c) => c.name)).toEqual(['CRM']);
    expect(s.all().map((c) => c.id)).toEqual(['conn_main', id]);
    expect(s.byId(id)?.config.port).toBe(5433);
  });

  it('names a connection after its database when it is given no name', () => {
    const id = useConnection.getState().addExternal({ config: serverConfig({ database: 'warehouse' }) });
    expect(useConnection.getState().byId(id)?.name).toBe('warehouse');
  });

  it('swaps the two ends when an external database becomes the main one', () => {
    const id = useConnection.getState().addExternal({ name: 'CRM', config: serverConfig({ database: 'crm' }) });
    useConnection.getState().promote(id);
    const s = useConnection.getState();
    expect(s.main.id).toBe(id);
    expect(s.main.name).toBe('CRM');
    // The database the diagram used to be for is still connected: it is now one more database read from outside.
    expect(s.externals.map((c) => c.name)).toEqual(['shop']);
  });

  it('refuses to point two connections at the same in-browser engine', () => {
    const id = useConnection.getState().addExternal({ config: serverConfig({ database: 'crm' }) });
    useConnection.getState().setDialect('conn_main', 'duckdb');
    expect(useConnection.getState().dialectConflict(id, 'duckdb')).toMatch(/already using it/);
    // Two server databases on the same engine are ordinary.
    expect(useConnection.getState().dialectConflict(id, 'postgresql')).toBeNull();
    // ...and SQLite is a different engine from DuckDB.
    expect(useConnection.getState().dialectConflict(id, 'sqlite')).toBeNull();
  });

  it('moves connections off the loopback default when the app itself runs in a container', () => {
    const moved = useConnection.getState().addExternal({ config: serverConfig({ database: 'crm' }) });
    const typed = useConnection.getState().addExternal({ config: serverConfig({ database: 'replica', host: 'db.internal' }) });
    useConnection.getState().setDefaultHost('host.docker.internal');
    expect(useConnection.getState().main.config.host).toBe('host.docker.internal');
    expect(useConnection.getState().byId(moved)?.config.host).toBe('host.docker.internal');
    // A host somebody typed is not the default, so it stays.
    expect(useConnection.getState().byId(typed)?.config.host).toBe('db.internal');
    // And one added afterwards starts where the others ended up.
    const later = useConnection.getState().addExternal();
    expect(useConnection.getState().byId(later)?.config.host).toBe('host.docker.internal');
  });

  it('forgets a test result as soon as the connection is pointed somewhere else', () => {
    useConnection.getState().setResult('conn_main', { ok: true, message: 'PostgreSQL 16.2' });
    useConnection.getState().setField('conn_main', 'port', 5544);
    expect(useConnection.getState().main.result).toBeUndefined();
  });
});

describe('reading an external database', () => {
  it('brings its tables in as a group the script never creates', async () => {
    const id = useConnection.getState().addExternal({ name: 'CRM', config: serverConfig({ database: 'crm' }) });
    introspect.mockResolvedValue(introspection(['accounts', 'contacts']));

    const res = await readSchemaInto(id);
    expect(res.tables).toBe(2);
    expect(res.refreshed).toBe(false);

    const d = useStore.getState().diagram;
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]).toMatchObject({ name: 'CRM', external: true });
    expect(d.tables.filter((t) => t.groupId === d.groups[0].id).map((t) => t.name).sort()).toEqual(['accounts', 'contacts']);
    // The foreign key inside that database came with it.
    expect(d.relationships.filter((r) => r.kind === 'fk')).toHaveLength(1);
    // Our own table is untouched, and only it is created.
    const script = generateSchema(d).script;
    expect(script).toContain('CREATE TABLE orders');
    expect(script).not.toContain('CREATE TABLE accounts');
    // The connection remembers where its tables went.
    expect(useConnection.getState().byId(id)?.groupId).toBe(d.groups[0].id);
  });

  it('leaves the diagram dialect alone: the schema being designed is still the main database\'s', async () => {
    const id = useConnection.getState().addExternal({ name: 'Legacy', config: { ...defaultConnection('mariadb'), database: 'legacy' } });
    introspect.mockResolvedValue(introspection(['customers'], 'MariaDB 11.4.2'));
    await readSchemaInto(id);
    expect(useStore.getState().diagram.dialect).toBe('postgresql');
  });

  it('refreshes the group it filled before instead of importing the same tables twice', async () => {
    const id = useConnection.getState().addExternal({ name: 'CRM', config: serverConfig({ database: 'crm' }) });
    introspect.mockResolvedValue(introspection(['accounts', 'contacts']));
    await readSchemaInto(id);
    const first = useStore.getState().diagram.groups[0];

    introspect.mockResolvedValue(introspection(['accounts', 'contacts', 'tickets']));
    const res = await readSchemaInto(id);
    expect(res.refreshed).toBe(true);

    const d = useStore.getState().diagram;
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].id).toBe(first.id);
    expect(d.groups[0].color).toBe(first.color);
    expect(d.tables.map((t) => t.name).sort()).toEqual(['accounts', 'contacts', 'orders', 'tickets']);
    // One undo puts the earlier reading back.
    useStore.getState().undo();
    expect(useStore.getState().diagram.tables.map((t) => t.name).sort()).toEqual(['accounts', 'contacts', 'orders']);
  });

  it('keeps filling the group it filled before, once an external database has become the main one', async () => {
    const id = useConnection.getState().addExternal({ name: 'CRM', config: serverConfig({ database: 'crm' }) });
    introspect.mockResolvedValue(introspection(['accounts', 'contacts']));
    await readSchemaInto(id);
    useConnection.getState().promote(id);

    // The Database panel reads the main database without a group of its own.
    await readSchemaInto(id, { mode: 'merge', group: false });
    const d = useStore.getState().diagram;
    expect(d.tables.map((t) => t.name).sort()).toEqual(['accounts', 'contacts', 'orders']);
    // It is the schema being designed now, so the script creates it.
    expect(d.groups[0].external).toBe(false);
    expect(generateSchema(d).script).toContain('CREATE TABLE accounts');
  });

  it('reads the main database into the diagram it designs, without a group', async () => {
    introspect.mockResolvedValue(introspection(['orders', 'order_items']));
    const res = await readSchemaInto('conn_main', { mode: 'replace', group: false });
    expect(res.groupId).toBeNull();
    const d = useStore.getState().diagram;
    expect(d.groups).toHaveLength(0);
    expect(generateSchema(d).script).toContain('CREATE TABLE order_items');
  });

  it('switches the diagram to the main database\'s engine, and only the main one\'s', async () => {
    useConnection.getState().setDialect('conn_main', 'mariadb');
    introspect.mockResolvedValue(introspection(['orders'], 'MariaDB 11.4.2'));
    await readSchemaInto('conn_main', { mode: 'replace', group: false });
    expect(useStore.getState().diagram.dialect).toBe('mariadb');
  });
});

describe('what is kept between sessions', () => {
  /** A localStorage that only exists for one test, so the store can be booted against it. */
  function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
    const store = new Map(Object.entries(seed));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    return store;
  }

  it('carries the single connection older versions saved over as the main database', async () => {
    stubStorage({ 'dbviz:connection': JSON.stringify({ dialect: 'mariadb', host: 'db.example', port: 3307, user: 'root', password: 'x', database: 'shop' }) });
    vi.resetModules();
    const fresh = (await import('../src/store/useConnection')).useConnection;
    expect(fresh.getState().main.config).toMatchObject({ dialect: 'mariadb', host: 'db.example', database: 'shop' });
    expect(fresh.getState().externals).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('brings every database back, including which group each external one filled', async () => {
    const storage = stubStorage();
    vi.resetModules();
    const first = (await import('../src/store/useConnection')).useConnection;
    first.getState().setMainConfig({ ...defaultConnection('postgresql'), database: 'shop' }, { name: 'shop' });
    const id = first.getState().addExternal({ name: 'CRM', config: { ...defaultConnection('postgresql'), database: 'crm', port: 5433 } });
    first.getState().setGroupId(id, 'grp_crm');
    first.getState().setResult(id, { ok: true, message: 'PostgreSQL 16.2' });

    vi.resetModules();
    const again = (await import('../src/store/useConnection')).useConnection;
    expect(again.getState().main.name).toBe('shop');
    expect(again.getState().externals).toHaveLength(1);
    expect(again.getState().externals[0]).toMatchObject({ id, name: 'CRM', groupId: 'grp_crm' });
    expect(again.getState().externals[0].config.port).toBe(5433);
    // A test result describes a moment, not a setting.
    expect(again.getState().externals[0].result).toBeUndefined();
    expect(storage.has('dbviz:connections')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('drops a saved external that would be the same in-browser database as another connection', async () => {
    stubStorage({
      'dbviz:connections': JSON.stringify({
        version: 2,
        main: { id: 'conn_a', name: 'local', config: { ...defaultConnection('duckdb') } },
        externals: [{ id: 'conn_b', name: 'also local', config: { ...defaultConnection('duckdb') } }, { id: 'conn_c', name: 'crm', config: { ...defaultConnection('postgresql'), database: 'crm' } }],
      }),
    });
    vi.resetModules();
    const fresh = (await import('../src/store/useConnection')).useConnection;
    expect(fresh.getState().externals.map((c) => c.id)).toEqual(['conn_c']);
    vi.unstubAllGlobals();
  });
});
