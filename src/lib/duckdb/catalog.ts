/**
 * Reading a DuckDB schema back into the shape the app uses for every engine
 * (IntrospectResponse). DuckDB describes itself through table functions —
 * duckdb_tables(), duckdb_columns(), duckdb_constraints() and friends — which
 * is what these queries read. They run unchanged in the browser engine and in
 * the Node build the tests use.
 */
import type { DatabaseExtension, ExtensionsResponse, IntrospectResponse, IntrospectedTable } from '@shared/types';
import { viewBody } from '../sql/views';

/** The one thing the catalog reader needs from an engine: run SQL, get rows back with plain values. */
export type RunSql = (sql: string) => Promise<unknown[][]>;

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str);
  return [];
}

/** duckdb_indexes().expressions is text such as "[customer_id, status]" or "['(lower(email))']". */
export function indexColumns(expressions: string): string[] | null {
  const inner = expressions.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const columns: string[] = [];
  for (const p of parts) {
    // An expression index is quoted as a string: '(lower(email))'. Nothing in the model can hold it.
    if (p.startsWith("'") || p.includes('(')) return null;
    columns.push(p.replace(/^"|"$/g, ''));
  }
  return columns;
}

/** The labels of an inline enum type as DuckDB prints it: ENUM('sad', 'ok') -> ['sad', 'ok']. */
export function enumLabels(dataType: string): string[] | null {
  const m = /^ENUM\s*\((.*)\)$/is.exec(dataType.trim());
  if (!m) return null;
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[1]))) out.push(hit[1].replace(/''/g, "'"));
  return out;
}

function sameLabels(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export async function duckdbVersion(run: RunSql): Promise<string> {
  const rows = await run('SELECT version()');
  return str(rows[0]?.[0]).replace(/^v/, '') || '?';
}

export async function introspectDuckdb(run: RunSql): Promise<IntrospectResponse> {
  const version = await duckdbVersion(run);
  const own = 'database_name = current_database()';
  const tableRows = await run(`SELECT schema_name, table_name, comment FROM duckdb_tables() WHERE NOT internal AND NOT temporary AND ${own} ORDER BY schema_name, table_name`);
  const viewRows = await run(`SELECT schema_name, view_name, comment, sql FROM duckdb_views() WHERE NOT internal AND NOT temporary AND ${own} ORDER BY schema_name, view_name`);
  const columnRows = await run(
    `SELECT schema_name, table_name, column_name, data_type, is_nullable, column_default, comment FROM duckdb_columns() WHERE NOT internal AND ${own} ORDER BY schema_name, table_name, column_index`,
  );
  const constraintRows = await run(
    `SELECT schema_name, table_name, constraint_type, constraint_name, constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints() WHERE ${own} ORDER BY schema_name, table_name, constraint_index`,
  );
  const indexRows = await run(`SELECT schema_name, table_name, index_name, is_unique, expressions FROM duckdb_indexes() WHERE ${own} ORDER BY schema_name, table_name, index_name`);
  const enumRows = await run(`SELECT schema_name, type_name, labels FROM duckdb_types() WHERE NOT internal AND logical_type = 'ENUM' AND ${own} ORDER BY schema_name, type_name`);
  const extensionRows = await run(`SELECT extension_name, extension_version FROM duckdb_extensions() WHERE loaded AND install_mode <> 'STATICALLY_LINKED' ORDER BY extension_name`);

  const enums = enumRows.map((r) => ({ schema: str(r[0]), name: str(r[1]), values: list(r[2]) }));
  const key = (schema: unknown, name: unknown) => `${str(schema)}.${str(name)}`;
  const byKey = new Map<string, IntrospectedTable>();
  const tables: IntrospectedTable[] = [];

  for (const r of tableRows) {
    const t: IntrospectedTable = { schema: str(r[0]), name: str(r[1]), kind: 'table', comment: r[2] === null || r[2] === undefined ? null : str(r[2]), columns: [], primaryKey: [], uniques: [], indexes: [], foreignKeys: [] };
    byKey.set(key(r[0], r[1]), t);
    tables.push(t);
  }
  for (const r of viewRows) {
    const t: IntrospectedTable = {
      schema: str(r[0]),
      name: str(r[1]),
      kind: 'view',
      viewSql: viewBody(str(r[3])),
      comment: r[2] === null || r[2] === undefined ? null : str(r[2]),
      columns: [],
      primaryKey: [],
      uniques: [],
      indexes: [],
      foreignKeys: [],
    };
    byKey.set(key(r[0], r[1]), t);
    tables.push(t);
  }

  for (const r of columnRows) {
    const t = byKey.get(key(r[0], r[1]));
    if (!t) continue;
    let type = str(r[3]) || 'VARCHAR';
    // The catalog prints an enum column as its label list; when a named type has
    // exactly those labels, that name is what the column was declared with.
    const labels = enumLabels(type);
    if (labels) {
      const named = enums.find((e) => e.schema === t.schema && sameLabels(e.values, labels)) ?? enums.find((e) => sameLabels(e.values, labels));
      if (named) type = named.schema === t.schema || named.schema === 'main' ? named.name : `${named.schema}.${named.name}`;
    }
    const defaultValue = r[5] === null || r[5] === undefined ? null : str(r[5]);
    t.columns.push({
      name: str(r[2]),
      type,
      nullable: t.kind === 'view' ? true : Boolean(r[4]),
      defaultValue,
      autoIncrement: /^\s*nextval\s*\(/i.test(defaultValue ?? ''),
      comment: r[6] === null || r[6] === undefined ? null : str(r[6]),
    });
  }

  for (const r of constraintRows) {
    const t = byKey.get(key(r[0], r[1]));
    if (!t) continue;
    const kind = str(r[2]).toUpperCase();
    const columns = list(r[4]);
    if (kind === 'PRIMARY KEY') t.primaryKey = columns;
    else if (kind === 'UNIQUE') t.uniques.push({ name: str(r[3]) || `uq_${t.name}_${columns.join('_')}`, columns });
    else if (kind === 'FOREIGN KEY') {
      // DuckDB foreign keys stay inside one schema and support no referential
      // actions beyond refusing the change, which the model spells NO ACTION.
      t.foreignKeys.push({
        name: str(r[3]) || `fk_${t.name}_${str(r[5])}`,
        columns,
        refSchema: t.schema,
        refTable: str(r[5]),
        refColumns: list(r[6]),
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      });
    }
  }

  for (const r of indexRows) {
    const t = byKey.get(key(r[0], r[1]));
    if (!t) continue;
    const columns = indexColumns(str(r[4]));
    if (!columns || !columns.length) continue; // expression index: nothing the model can hold
    t.indexes.push({ name: str(r[2]), columns, unique: Boolean(r[3]) });
  }

  return {
    serverVersion: `DuckDB ${version}`,
    tables,
    enums,
    extensions: extensionRows.map((r) => ({ name: str(r[0]), version: str(r[1]) || undefined })),
  };
}

/** What the engine can be extended with and what is active in this session, from duckdb_extensions(). */
export async function listDuckdbExtensions(run: RunSql, engineLabel: string): Promise<ExtensionsResponse> {
  const version = await duckdbVersion(run);
  const rows = await run('SELECT extension_name, loaded, installed, description, extension_version, install_mode, aliases FROM duckdb_extensions() ORDER BY extension_name');
  const extensions: DatabaseExtension[] = rows.map((r) => {
    const loaded = Boolean(r[1]);
    const installed = Boolean(r[2]);
    const aliases = list(r[6]).filter(Boolean);
    const bits = [str(r[3])];
    if (aliases.length) bits.push(`Also known as ${aliases.join(', ')}.`);
    if (str(r[5]) === 'STATICALLY_LINKED') bits.push('Built into this engine.');
    else if (installed && !loaded) bits.push('Installed but not loaded in this session: LOAD it first.');
    return {
      name: str(r[0]),
      installed: loaded,
      installedVersion: str(r[4]) || undefined,
      comment: bits.filter(Boolean).join(' ') || undefined,
    };
  });
  return {
    serverVersion: `DuckDB ${version}${engineLabel ? ` (${engineLabel})` : ''}`,
    extensions,
    note: 'DuckDB fetches an extension with INSTALL and activates it for the session with LOAD; "enabled" here means loaded right now. The in-browser engine downloads extensions from extensions.duckdb.org when a script loads them.',
  };
}

/** Number of user tables, for status displays. */
export async function duckdbTableCount(run: RunSql): Promise<number> {
  const rows = await run("SELECT count(*) FROM duckdb_tables() WHERE NOT internal AND NOT temporary AND database_name = current_database()");
  return Number(rows[0]?.[0] ?? 0);
}
