import { create } from 'zustand';
import { DIALECTS, engineName, isEmbeddedDialect, type ConnectionConfig, type Dialect } from '@shared/types';
import { newId } from '@/lib/ids';

/**
 * Every database the app is connected to at once.
 *
 * One of them is the **main** database: the one the diagram is designed for and
 * the only one Create schema, Migrate and Seed act on. The others are
 * **external**: databases you read from but do not own — the live half of a
 * group marked "these tables live in another database". Reading an external
 * database files its tables into that group, so the diagram keeps saying where
 * each table really lives while the script still only creates your own.
 *
 * Every panel turns one of these into a Backend with `backendFor(c.config)`, so
 * a query can be sent to any of them while schema work stays on the main one.
 *
 * `dialect === 'sqlite'` or `'duckdb'` means an in-browser engine: host, port
 * and user are unused, and since each of those engines is one instance inside
 * the page, no two connections may claim the same one.
 */

const KEY = 'dbviz:connections';
/** Where a single connection was kept before there could be several. Read once, to carry it over. */
const LEGACY_KEY = 'dbviz:connection';

export interface TestResult {
  ok: boolean;
  message: string;
}

/** One database the app can talk to, main or external. */
export interface DbConnection {
  id: string;
  /** What the lists call it: a container name, or the database's own name. */
  name: string;
  config: ConnectionConfig;
  /** The Docker container it was taken from, when it came from one. */
  containerId?: string;
  /**
   * The group in the diagram holding the tables read from this database. Set by
   * "Read schema", and how a second read knows to refresh that group rather than
   * import the same tables again. Groups belong to a diagram and connections do
   * not, so anything using this has to cope with the group having gone.
   */
  groupId?: string;
  /** Last "Test connection" answer. Never persisted: it describes a moment, not a setting. */
  result?: TestResult;
}

export function defaultConnection(dialect: Dialect): ConnectionConfig {
  const d = DIALECTS.find((x) => x.id === dialect)!;
  return {
    dialect,
    host: '127.0.0.1',
    port: d.defaultPort,
    user: d.defaultUser,
    password: '',
    database: dialect === 'sqlite' ? 'local.sqlite' : dialect === 'duckdb' ? 'local.duckdb' : 'app',
  };
}

/** The name a connection gets when nothing better is known. */
export function suggestedName(config: ConnectionConfig): string {
  if (isEmbeddedDialect(config.dialect)) return engineName(config.dialect);
  return config.database || `${engineName(config.dialect)} ${config.host}:${config.port}`;
}

function makeConnection(init: Partial<DbConnection> & { config: ConnectionConfig }): DbConnection {
  const { id, name, ...rest } = init;
  return { ...rest, id: id || newId('conn'), name: name?.trim() || suggestedName(init.config) };
}

interface ConnectionState {
  /** The database the diagram is for. Create schema, Migrate and Seed act on this one alone. */
  main: DbConnection;
  /** Databases read alongside it, in the order they were added. */
  externals: DbConnection[];
  /** Which database the Query panel is pointed at. Falls back to the main one when it names nothing. */
  queryTargetId: string;
  /**
   * The host a database port published on this machine is reached at. '127.0.0.1'
   * unless the app is itself running in a container, where the server answers
   * 'host.docker.internal' instead. The Database panel sets it from /api/health;
   * a connection added by hand starts there.
   */
  defaultHost: string;
  setDefaultHost: (host: string) => void;

  /* ---- the main database ---- */
  setMainConfig: (config: ConnectionConfig, meta?: { name?: string; containerId?: string }) => void;
  setMainField: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
  /** Switch the main engine, keeping the password. */
  setMainDialect: (dialect: Dialect) => void;

  /* ---- external databases ---- */
  /** Add one and return its id; the name defaults to the database's own. */
  addExternal: (init?: { name?: string; config?: ConnectionConfig; containerId?: string }) => string;
  removeExternal: (id: string) => void;
  /** Make this external the main database; the database it replaces becomes external. */
  promote: (id: string) => void;

  /* ---- any database ---- */
  setName: (id: string, name: string) => void;
  setField: <K extends keyof ConnectionConfig>(id: string, key: K, value: ConnectionConfig[K]) => void;
  setDialect: (id: string, dialect: Dialect) => void;
  setGroupId: (id: string, groupId: string | undefined) => void;
  setResult: (id: string, result: TestResult | null) => void;
  setQueryTarget: (id: string) => void;
  /** Look one up without subscribing to it. */
  byId: (id: string) => DbConnection | null;
  /** Main first, then the externals: the order every picker offers them in. */
  all: () => DbConnection[];
  /**
   * Why this connection may not use this dialect, or null when it may. The
   * in-browser engines are one instance per page, so two connections on SQLite
   * (or two on DuckDB) would silently be the same database.
   */
  dialectConflict: (id: string, dialect: Dialect) => string | null;
}

interface Persisted {
  version: 2;
  main: DbConnection;
  externals: DbConnection[];
  queryTargetId?: string;
}

/** Drop anything that is not a setting, and repair a hand-edited or half-written entry. */
function sanitize(raw: unknown): DbConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<DbConnection>;
  const config = c.config as Partial<ConnectionConfig> | undefined;
  if (!config || !DIALECTS.some((d) => d.id === config.dialect)) return null;
  const merged = { ...defaultConnection(config.dialect as Dialect), ...config } as ConnectionConfig;
  return makeConnection({
    id: typeof c.id === 'string' && c.id ? c.id : undefined,
    name: typeof c.name === 'string' ? c.name : undefined,
    config: merged,
    containerId: typeof c.containerId === 'string' ? c.containerId : undefined,
    groupId: typeof c.groupId === 'string' ? c.groupId : undefined,
  });
}

function load(): { main: DbConnection; externals: DbConnection[]; queryTargetId: string } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Persisted>;
      const main = sanitize(saved.main);
      if (!main) return null;
      const externals: DbConnection[] = [];
      for (const e of Array.isArray(saved.externals) ? saved.externals : []) {
        const c = sanitize(e);
        // An external that ended up on the main's engine would be the same
        // in-browser database under two names; the main keeps it.
        if (c && c.id !== main.id && !externals.some((x) => x.id === c.id) && !sharesEngine(c.config.dialect, [main, ...externals])) externals.push(c);
      }
      const target = typeof saved.queryTargetId === 'string' ? saved.queryTargetId : main.id;
      return { main, externals, queryTargetId: [main, ...externals].some((c) => c.id === target) ? target : main.id };
    }
    // The single connection this app used to keep becomes the main one.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const main = sanitize({ config: JSON.parse(legacy) as ConnectionConfig });
      if (main) return { main, externals: [], queryTargetId: main.id };
    }
  } catch {
    /* a browser with storage switched off, or a half-written entry: start fresh */
  }
  return null;
}

/** Whether any of these connections already speaks for that in-browser engine. */
function sharesEngine(dialect: Dialect, among: DbConnection[]): boolean {
  return isEmbeddedDialect(dialect) && among.some((c) => c.config.dialect === dialect);
}

function persist(s: Pick<ConnectionState, 'main' | 'externals' | 'queryTargetId'>): void {
  try {
    const strip = (c: DbConnection): DbConnection => ({ id: c.id, name: c.name, config: c.config, containerId: c.containerId, groupId: c.groupId });
    const out: Persisted = { version: 2, main: strip(s.main), externals: s.externals.map(strip), queryTargetId: s.queryTargetId };
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
}

const booted = load();
const firstMain = booted?.main ?? makeConnection({ config: defaultConnection('postgresql'), name: 'Main database' });

export const useConnection = create<ConnectionState>()((set, get) => {
  /** Write the new shape, keep it on disk, and never let the query target dangle. */
  const commit = (next: Partial<Pick<ConnectionState, 'main' | 'externals' | 'queryTargetId'>>): void => {
    const s = get();
    const merged = { main: next.main ?? s.main, externals: next.externals ?? s.externals, queryTargetId: next.queryTargetId ?? s.queryTargetId };
    if (![merged.main, ...merged.externals].some((c) => c.id === merged.queryTargetId)) merged.queryTargetId = merged.main.id;
    set(merged);
    persist(merged);
  };

  /** Apply a patch to whichever connection has this id. */
  const patch = (id: string, fn: (c: DbConnection) => DbConnection): void => {
    const s = get();
    if (s.main.id === id) commit({ main: fn(s.main) });
    else if (s.externals.some((c) => c.id === id)) commit({ externals: s.externals.map((c) => (c.id === id ? fn(c) : c)) });
  };

  return {
    main: firstMain,
    externals: booted?.externals ?? [],
    queryTargetId: booted?.queryTargetId ?? firstMain.id,
    defaultHost: '127.0.0.1',

    setMainConfig: (config, meta) =>
      commit({
        main: {
          ...get().main,
          config,
          name: meta?.name?.trim() || suggestedName(config),
          containerId: meta?.containerId,
          // A different database behind the same entry: its old test result and
          // the group read out of it no longer describe anything.
          groupId: undefined,
          result: undefined,
        },
      }),
    setMainField: (key, value) => patch(get().main.id, (c) => ({ ...c, config: { ...c.config, [key]: value }, result: undefined })),
    setMainDialect: (dialect) => get().setDialect(get().main.id, dialect),

    setDefaultHost: (host) => {
      const s = get();
      if (!host || host === s.defaultHost) return;
      // Connections still sitting on the loopback default were never really
      // told where to look, so they follow; anything typed in stays.
      const move = (c: DbConnection): DbConnection => (c.config.host === '127.0.0.1' && !isEmbeddedDialect(c.config.dialect) ? { ...c, config: { ...c.config, host } } : c);
      set({ defaultHost: host });
      commit({ main: move(s.main), externals: s.externals.map(move) });
    },

    addExternal: (init) => {
      const s = get();
      const base = init?.config ?? {
        ...defaultConnection(isEmbeddedDialect(s.main.config.dialect) ? 'postgresql' : s.main.config.dialect),
        host: s.defaultHost,
      };
      const c = makeConnection({ name: init?.name, config: base, containerId: init?.containerId });
      commit({ externals: [...s.externals, c] });
      return c.id;
    },
    removeExternal: (id) => commit({ externals: get().externals.filter((c) => c.id !== id) }),
    promote: (id) => {
      const s = get();
      const next = s.externals.find((c) => c.id === id);
      if (!next) return;
      // A straight swap: the diagram is now designed for `next`, and what the
      // main database was is one more database read from the outside.
      commit({ main: next, externals: s.externals.map((c) => (c.id === id ? s.main : c)) });
    },

    setName: (id, name) => patch(id, (c) => ({ ...c, name })),
    setField: (id, key, value) => patch(id, (c) => ({ ...c, config: { ...c.config, [key]: value }, result: undefined })),
    setDialect: (id, dialect) =>
      patch(id, (c) => (c.config.dialect === dialect ? c : { ...c, config: { ...defaultConnection(dialect), password: c.config.password }, groupId: undefined, result: undefined })),
    setGroupId: (id, groupId) => patch(id, (c) => ({ ...c, groupId })),
    setResult: (id, result) => patch(id, (c) => ({ ...c, result: result ?? undefined })),
    setQueryTarget: (id) => commit({ queryTargetId: id }),
    byId: (id) => {
      const s = get();
      return s.main.id === id ? s.main : (s.externals.find((c) => c.id === id) ?? null);
    },
    all: () => [get().main, ...get().externals],
    dialectConflict: (id, dialect) => {
      if (!isEmbeddedDialect(dialect)) return null;
      const others = get().all().filter((c) => c.id !== id);
      const clash = others.find((c) => c.config.dialect === dialect);
      return clash
        ? `${engineName(dialect)} runs inside this page as a single database, and "${clash.name}" is already using it. Point that one somewhere else first, or connect this database to a server.`
        : null;
    },
  };
});
