import { create } from 'zustand';
import { DIALECTS, type ConnectionConfig, type Dialect } from '@shared/types';

/**
 * The database connection the Database, Query, Migrate and Seed panels share.
 * dialect === 'sqlite' means the in-browser engine; host/port/user are unused.
 */

const CONN_KEY = 'dbviz:connection';

export function defaultConnection(dialect: Dialect): ConnectionConfig {
  const d = DIALECTS.find((x) => x.id === dialect)!;
  return { dialect, host: '127.0.0.1', port: d.defaultPort, user: d.defaultUser, password: '', database: dialect === 'sqlite' ? 'local.sqlite' : 'app' };
}

function loadConnection(): ConnectionConfig | null {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (!c || !DIALECTS.some((d) => d.id === c.dialect)) return null;
    return { ...defaultConnection(c.dialect as Dialect), ...c } as ConnectionConfig;
  } catch {
    return null;
  }
}

export interface TestResult {
  ok: boolean;
  message: string;
}

interface ConnectionState {
  conn: ConnectionConfig;
  testResult: TestResult | null;
  setConn: (conn: ConnectionConfig) => void;
  setField: <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) => void;
  /** Switch engines, keeping the password. */
  setDialect: (dialect: Dialect) => void;
  setTestResult: (r: TestResult | null) => void;
}

export const useConnection = create<ConnectionState>()((set, get) => ({
  conn: loadConnection() ?? defaultConnection('postgresql'),
  testResult: null,
  setConn: (conn) => {
    set({ conn, testResult: null });
    persist(conn);
  },
  setField: (key, value) => {
    const conn = { ...get().conn, [key]: value };
    set({ conn, testResult: null });
    persist(conn);
  },
  setDialect: (dialect) => {
    const conn = { ...defaultConnection(dialect), password: get().conn.password };
    set({ conn, testResult: null });
    persist(conn);
  },
  setTestResult: (testResult) => set({ testResult }),
}));

function persist(conn: ConnectionConfig): void {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(conn));
  } catch {
    /* ignore */
  }
}
