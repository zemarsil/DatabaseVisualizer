import { isProcedure } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { backendFor } from './backend';
import { introspectionToDiagram } from './introspectImport';

/**
 * Reading a live database into the diagram, for whichever database is asked for.
 *
 * The Database panel does this for the main database and for every external one,
 * and they differ in two ways that are worth having in one place. The main
 * database *is* what the diagram describes, so reading it may switch the
 * diagram's dialect. An external one is somebody else's: its tables arrive in a
 * group marked "another database" (so nothing generated ever tries to create
 * them), its column types keep the spelling that database uses, and the diagram
 * dialect is left alone, because the schema being designed is still the main
 * one's.
 */

export interface ReadSchemaOptions {
  /** 'replace' clears the diagram first; 'merge' adds to it. Default 'merge'. */
  mode?: 'merge' | 'replace';
  /** Put everything read into one group named after the database. Default true. */
  group?: boolean;
  /** Overrides the group name; the database's own name is the default. */
  groupName?: string;
  /** Mark that group as another database, keeping its tables out of the generated script. */
  external?: boolean;
}

export interface ReadSchemaResult {
  tables: number;
  /** The group everything landed in, when the import made or refreshed one. */
  groupId: string | null;
  /** True when this read replaced an earlier reading of the same database. */
  refreshed: boolean;
  serverVersion: string;
  warnings: string[];
}

/**
 * Read one connection's schema — tables, columns, keys, indexes, foreign keys,
 * views, enums and installed extensions — into the current diagram.
 *
 * Reading the same database twice refreshes the group it went into the first
 * time rather than dropping a second copy of it on the canvas; the connection
 * remembers which group that was.
 *
 * Throws whatever the backend threw, so callers can show it.
 */
export async function readSchemaInto(connectionId: string, opts: ReadSchemaOptions = {}): Promise<ReadSchemaResult> {
  const conn = useConnection.getState().byId(connectionId);
  if (!conn) throw new Error('That database is no longer connected.');
  const isMain = useConnection.getState().main.id === connectionId;
  const mode = opts.mode ?? 'merge';
  const external = opts.external ?? !isMain;

  const backend = backendFor(conn.config);
  const res = await backend.introspect();

  const store = useStore.getState();
  // Only the main database decides what dialect the diagram is written in.
  if (isMain && conn.config.dialect !== store.diagram.dialect) store.setDialect(conn.config.dialect, false);
  const diagram = useStore.getState().diagram;

  // A group this connection filled before, if it is still in this diagram: the
  // same database read again belongs in the region it already has.
  const refreshId = mode === 'merge' && conn.groupId && diagram.groups.some((g) => g.id === conn.groupId) ? conn.groupId : undefined;
  // What the import is compared against, to rename a clashing table and to spot
  // a relationship the diagram already has. A re-read replaces the earlier
  // reading, so that reading is not there to clash with: without this every
  // table would come back as "accounts_2" for colliding with its own last copy.
  const replaced = new Set(refreshId ? diagram.tables.filter((t) => t.groupId === refreshId).map((t) => t.id) : []);
  const against = !replaced.size
    ? diagram
    : {
        ...diagram,
        tables: diagram.tables.filter((t) => !replaced.has(t.id)),
        relationships: diagram.relationships.filter((r) => !replaced.has(r.sourceTableId) && !replaced.has(r.targetTableId)),
      };
  const converted = introspectionToDiagram(res, conn.config.dialect, mode === 'merge' ? against : null);
  if (converted.tables.length === 0) return { tables: 0, groupId: null, refreshed: false, serverVersion: res.serverVersion, warnings: converted.warnings };

  // A connection that already filled a group keeps filling it, even when this
  // read asked for no group: its tables live there, and a second copy of them
  // beside the first is never what "do not group them" meant. Promoting an
  // external database to the main one and reading it lands here, and the group
  // stops being marked as another database, which is exactly right — it is the
  // database being designed now.
  const useGroup = (opts.group ?? true) || Boolean(refreshId);
  // Stored procedures are part of the schema they live in. The main database's
  // come in as procedures of this diagram; another database's stay there, since
  // anything in this diagram is something its script creates.
  const procedures = converted.programs.filter(isProcedure);
  const warnings = [...converted.warnings];
  if (external && procedures.length) {
    warnings.push(`${procedures.length} stored procedure${procedures.length === 1 ? '' : 's'} in ${conn.name || conn.config.database} ${procedures.length === 1 ? 'was' : 'were'} left out: ${procedures.length === 1 ? 'it belongs' : 'they belong'} to another database, and the diagram would create ${procedures.length === 1 ? 'it' : 'them'} here.`);
  }
  const groupId = useStore.getState().importTables(converted.tables, converted.relationships, mode, {
    customTypes: converted.customTypes,
    extensions: converted.extensions,
    programs: external ? [] : procedures,
    // Reading the same database again restates its procedures rather than adding a second copy of each.
    refreshProcedures: !external,
    group: useGroup
      ? {
          name: opts.groupName?.trim() || conn.name || conn.config.database || 'Imported database',
          external,
          note: backend.label,
          refreshId,
        }
      : undefined,
  });
  useConnection.getState().setGroupId(conn.id, groupId ?? undefined);
  return { tables: converted.tables.length, groupId, refreshed: Boolean(refreshId) && groupId === refreshId, serverVersion: res.serverVersion, warnings };
}
