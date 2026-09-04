import type { ConnectionConfig, IntrospectResponse, StatementResult } from '../../src/shared/types';
import * as postgres from './postgres';
import * as maria from './mariadb';

export function validateConnection(input: unknown): ConnectionConfig {
  if (!input || typeof input !== 'object') throw new Error('Connection settings are required.');
  const o = input as Record<string, unknown>;
  const dialect = o.dialect === 'mariadb' ? 'mariadb' : o.dialect === 'postgresql' ? 'postgresql' : null;
  if (!dialect) throw new Error('dialect must be "postgresql" or "mariadb".');
  const host = typeof o.host === 'string' && o.host.trim() ? o.host.trim() : '127.0.0.1';
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535.');
  const user = typeof o.user === 'string' ? o.user : '';
  if (!user) throw new Error('user is required.');
  const password = typeof o.password === 'string' ? o.password : '';
  const database = typeof o.database === 'string' ? o.database : '';
  return { dialect, host, port, user, password, database };
}

export function friendlyDbError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED/.test(msg)) return `Connection refused (${msg}). Is the database running and the port correct?`;
  if (/ETIMEDOUT|timeout/i.test(msg)) return `Connection timed out (${msg}). The container may still be starting.`;
  if (/password authentication failed|Access denied/i.test(msg)) return `Authentication failed: ${msg}`;
  if (/database ".*" does not exist|Unknown database/i.test(msg)) return `Database not found: ${msg}`;
  return msg;
}

export function testConnection(cfg: ConnectionConfig): Promise<string> {
  return cfg.dialect === 'postgresql' ? postgres.testConnection(cfg) : maria.testConnection(cfg);
}

export function applyStatements(cfg: ConnectionConfig, statements: string[], stopOnError: boolean): Promise<StatementResult[]> {
  return cfg.dialect === 'postgresql' ? postgres.applyStatements(cfg, statements, stopOnError) : maria.applyStatements(cfg, statements, stopOnError);
}

export function introspect(cfg: ConnectionConfig): Promise<IntrospectResponse> {
  return cfg.dialect === 'postgresql' ? postgres.introspect(cfg) : maria.introspect(cfg);
}
