import type { SqliteEngine } from './engine';

/** Placeholder until the sql.js implementation lands. */
export async function createSqlJsEngine(): Promise<SqliteEngine> {
  throw new Error('The in-browser SQLite engine is not available in this build yet.');
}
