/**
 * Composition of the right-click menus.
 *
 * What you click decides what you get: the canvas offers diagram-level actions,
 * a table offers table actions, a column row inside a table offers column
 * actions, an edge offers connection actions, and so on. The builder is kept
 * free of JSX so it can be unit-tested; `icon` is a component reference that
 * ContextMenu.tsx instantiates.
 */
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ClipboardCopy,
  Code2,
  Copy,
  Crosshair,
  Database,
  FileDown,
  GitBranch,
  KeyRound,
  Link2,
  ListPlus,
  Maximize,
  PanelRight,
  Pencil,
  Plus,
  Redo2,
  Route,
  Shapes,
  Shuffle,
  SquareDashedMousePointer,
  StickyNote,
  Trash2,
  Undo2,
  Waypoints,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Column, Relationship, Table } from '@shared/types';
import { customTypeByName } from '@/lib/model';
import { generateTableSql } from '@/lib/sql/generator';
import type { Store } from '@/store/useStore';

/** What the user right-clicked. */
export type ContextTarget =
  | { type: 'pane'; flowPosition: { x: number; y: number } }
  | { type: 'table'; tableId: string; columnId?: string }
  | { type: 'note'; noteId: string }
  | { type: 'relationship'; relationshipId: string }
  /** Several tables are selected; act on all of them. */
  | { type: 'selection' };

export interface MenuAction {
  kind: 'action';
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Right-aligned shortcut or annotation. */
  hint?: string;
  /** Renders a check mark in place of the icon; used for toggles. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface MenuHeading {
  kind: 'heading';
  id: string;
  label: string;
  detail?: string;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

/** A row of palette swatches, e.g. the table header colour. */
export interface MenuSwatches {
  kind: 'swatches';
  id: string;
  label: string;
  value: string | null;
  pick: (colorKey: string) => void;
}

export type MenuNode = MenuAction | MenuHeading | MenuSeparator | MenuSwatches;

export interface MenuEnv {
  store: Store;
  /** Copy to the clipboard and toast. */
  copy: (text: string, message: string) => void;
  /** Ask for a new name and apply it. */
  renameTable: (tableId: string) => void;
  /** Delete tables, confirming first when connections would go with them. */
  removeTables: (ids: string[]) => void;
}

const sep = (id: string): MenuSeparator => ({ kind: 'separator', id });

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Tables on the other end of any connection touching `tableId`. */
function connectedTableIds(store: Store, tableId: string): string[] {
  const ids = new Set<string>();
  for (const r of store.diagram.relationships) {
    if (r.sourceTableId === tableId) ids.add(r.targetTableId);
    if (r.targetTableId === tableId) ids.add(r.sourceTableId);
  }
  ids.delete(tableId);
  return [...ids];
}

function selectOnly(store: Store, patch: { tableIds?: string[]; relationshipId?: string | null; noteId?: string | null }): void {
  store.setSelection({ tableIds: [], relationshipId: null, noteId: null, ...patch });
}

/* ------------------------------------------------------------------ */
/* Canvas background                                                   */
/* ------------------------------------------------------------------ */

function paneMenu(at: { x: number; y: number }, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const tables = s.diagram.tables;
  const items: MenuNode[] = [
    {
      kind: 'action',
      id: 'add-table',
      label: 'Add table here',
      icon: Plus,
      hint: 'T',
      run: () => s.addTable({ x: Math.round(at.x - 120), y: Math.round(at.y - 20) }),
    },
    {
      kind: 'action',
      id: 'add-note',
      label: 'Add note here',
      icon: StickyNote,
      hint: 'N',
      run: () => s.addNote({ x: Math.round(at.x - 110), y: Math.round(at.y - 60) }),
    },
    sep('s1'),
    {
      kind: 'action',
      id: 'select-all',
      label: 'Select all tables',
      icon: SquareDashedMousePointer,
      disabled: tables.length === 0,
      run: () => selectOnly(s, { tableIds: tables.map((t) => t.id) }),
    },
    {
      kind: 'action',
      id: 'detangle',
      label: 'Detangle layout',
      icon: Shuffle,
      hint: 'L',
      disabled: tables.length < 2,
      run: () => s.applyLayout(),
    },
    { kind: 'action', id: 'fit', label: 'Fit to window', icon: Maximize, hint: 'F', run: () => s.requestFitView() },
  ];

  if (s.trace.picking) {
    items.push(sep('s-trace'), { kind: 'action', id: 'cancel-picking', label: 'Cancel trace picking', icon: X, run: () => s.setTracePicking(false) });
  } else if (s.trace.result) {
    items.push(sep('s-trace'), { kind: 'action', id: 'clear-trace', label: 'Clear trace highlight', icon: X, run: () => s.clearTrace() });
  }

  items.push(
    sep('s2'),
    { kind: 'action', id: 'undo', label: 'Undo', icon: Undo2, hint: 'Ctrl+Z', disabled: s.past.length === 0, run: () => s.undo() },
    { kind: 'action', id: 'redo', label: 'Redo', icon: Redo2, hint: 'Ctrl+Shift+Z', disabled: s.future.length === 0, run: () => s.redo() },
    sep('s3'),
    { kind: 'action', id: 'sql', label: 'SQL script', icon: Code2, run: () => s.openDrawer('sql') },
    { kind: 'action', id: 'types', label: 'Custom types', icon: Shapes, run: () => s.openDrawer('types') },
    { kind: 'action', id: 'import', label: 'Import SQL…', icon: FileDown, run: () => s.openDrawer('import') },
    { kind: 'action', id: 'database', label: 'Docker & database', icon: Database, run: () => s.openDrawer('database') },
  );
  return items;
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

function traceItem(table: Table, env: MenuEnv): MenuAction {
  const s = env.store;
  const from = s.trace.fromId && s.trace.fromId !== table.id ? s.diagram.tables.find((t) => t.id === s.trace.fromId) : undefined;
  if (from) {
    return {
      kind: 'action',
      id: 'trace-to',
      label: `Trace ${from.name} → ${table.name}`,
      icon: Route,
      run: () => {
        s.setTraceEndpoints(from.id, table.id);
        s.runTrace();
      },
    };
  }
  return {
    kind: 'action',
    id: 'trace-from',
    label: 'Trace from here…',
    icon: Route,
    hint: 'pick a 2nd table',
    disabled: s.diagram.tables.length < 2,
    run: () => {
      s.setTracePicking(true);
      s.setTraceEndpoints(table.id, null);
      s.openDrawer('trace');
    },
  };
}

function tableMenu(table: Table, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const connected = connectedTableIds(s, table.id);
  const relCount = s.diagram.relationships.filter((r) => r.sourceTableId === table.id || r.targetTableId === table.id).length;
  return [
    {
      kind: 'heading',
      id: 'head',
      label: table.name || 'untitled',
      detail: `${plural(table.columns.length, 'column')} · ${plural(relCount, 'connection')}`,
    },
    {
      kind: 'action',
      id: 'inspect',
      label: 'Edit in inspector',
      icon: PanelRight,
      run: () => {
        selectOnly(s, { tableIds: [table.id] });
        s.setInspectorOpen(true);
      },
    },
    { kind: 'action', id: 'rename', label: 'Rename…', icon: Pencil, run: () => env.renameTable(table.id) },
    { kind: 'action', id: 'add-column', label: 'Add column', icon: Plus, run: () => s.addColumn(table.id) },
    sep('s1'),
    { kind: 'swatches', id: 'color', label: 'Color', value: table.color, pick: (key) => s.updateTable(table.id, { color: key }) },
    sep('s2'),
    { kind: 'action', id: 'duplicate', label: 'Duplicate table', icon: Copy, run: () => s.duplicateTable(table.id) },
    {
      kind: 'action',
      id: 'copy-sql',
      label: 'Copy CREATE TABLE',
      icon: Code2,
      run: () => env.copy(generateTableSql(s.diagram, table.id), `Copied the CREATE TABLE for ${table.name}.`),
    },
    { kind: 'action', id: 'copy-name', label: 'Copy table name', icon: ClipboardCopy, run: () => env.copy(table.name, 'Copied the table name.') },
    sep('s3'),
    { kind: 'action', id: 'focus', label: 'Zoom to table', icon: Crosshair, run: () => s.focusTable(table.id) },
    {
      kind: 'action',
      id: 'select-connected',
      label: `Select connected (${connected.length})`,
      icon: Waypoints,
      disabled: connected.length === 0,
      run: () => selectOnly(s, { tableIds: [table.id, ...connected] }),
    },
    traceItem(table, env),
    sep('s4'),
    { kind: 'action', id: 'delete', label: 'Delete table', icon: Trash2, danger: true, hint: 'Del', run: () => env.removeTables([table.id]) },
  ];
}

/* ------------------------------------------------------------------ */
/* Column row inside a table                                           */
/* ------------------------------------------------------------------ */

function columnMenu(table: Table, column: Column, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const patch = (p: Partial<Column>) => s.updateColumn(table.id, column.id, p);
  const index = table.columns.findIndex((c) => c.id === column.id);
  const isFk = s.diagram.relationships.some((r) => r.kind === 'fk' && r.sourceColumnIds.includes(column.id));
  const customType = customTypeByName(s.diagram, column.type);
  return [
    {
      kind: 'heading',
      id: 'head',
      label: `${table.name}.${column.name}`,
      detail: [column.type, customType && (customType.kind === 'enum' ? 'enum' : 'struct'), isFk && 'foreign key'].filter(Boolean).join(' · '),
    },
    { kind: 'action', id: 'pk', label: 'Primary key', icon: KeyRound, checked: column.primaryKey, run: () => patch({ primaryKey: !column.primaryKey }) },
    { kind: 'action', id: 'nn', label: 'Not null', checked: !column.nullable, run: () => patch({ nullable: !column.nullable }) },
    { kind: 'action', id: 'uq', label: 'Unique', checked: column.unique, run: () => patch({ unique: !column.unique }) },
    { kind: 'action', id: 'ai', label: 'Auto-increment', checked: column.autoIncrement, run: () => patch({ autoIncrement: !column.autoIncrement }) },
    sep('s1'),
    { kind: 'action', id: 'add-below', label: 'Add column below', icon: Plus, run: () => s.addColumn(table.id, undefined, { after: column.id }) },
    { kind: 'action', id: 'index', label: 'Create index on this column', icon: ListPlus, run: () => s.addIndex(table.id, [column.id]) },
    { kind: 'action', id: 'up', label: 'Move up', icon: ArrowUp, disabled: index <= 0, run: () => s.moveColumn(table.id, column.id, -1) },
    {
      kind: 'action',
      id: 'down',
      label: 'Move down',
      icon: ArrowDown,
      disabled: index === table.columns.length - 1,
      run: () => s.moveColumn(table.id, column.id, 1),
    },
    { kind: 'action', id: 'copy-name', label: 'Copy column name', icon: ClipboardCopy, run: () => env.copy(column.name, 'Copied the column name.') },
    ...(customType
      ? [{ kind: 'action' as const, id: 'edit-type', label: `Edit type "${customType.name}"`, icon: Shapes, run: () => s.openDrawer('types') }]
      : []),
    sep('s2'),
    {
      kind: 'action',
      id: 'inspect',
      label: `Edit ${table.name} in inspector`,
      icon: PanelRight,
      run: () => {
        selectOnly(s, { tableIds: [table.id] });
        s.setInspectorOpen(true);
      },
    },
    sep('s3'),
    { kind: 'action', id: 'delete', label: 'Delete column', icon: Trash2, danger: true, run: () => s.deleteColumn(table.id, column.id) },
  ];
}

/* ------------------------------------------------------------------ */
/* Several tables at once                                              */
/* ------------------------------------------------------------------ */

function selectionMenu(env: MenuEnv): MenuNode[] {
  const s = env.store;
  const ids = s.selection.tableIds;
  const names = ids.map((id) => s.diagram.tables.find((t) => t.id === id)?.name ?? '?');
  return [
    { kind: 'heading', id: 'head', label: `${plural(ids.length, 'table')} selected`, detail: names.join(', ') },
    {
      kind: 'action',
      id: 'trace',
      label: `Trace ${names[0]} → ${names[1]}`,
      icon: Route,
      run: () => {
        s.setTraceEndpoints(ids[0], ids[1]);
        s.runTrace();
      },
    },
    { kind: 'action', id: 'detangle', label: 'Detangle layout', icon: Shuffle, hint: 'L', run: () => s.applyLayout() },
    sep('s1'),
    { kind: 'swatches', id: 'color', label: 'Color for all', value: null, pick: (key) => s.updateTables(ids, { color: key }) },
    sep('s2'),
    { kind: 'action', id: 'clear', label: 'Clear selection', icon: X, hint: 'Esc', run: () => s.clearSelection() },
    { kind: 'action', id: 'delete', label: `Delete ${plural(ids.length, 'table')}`, icon: Trash2, danger: true, hint: 'Del', run: () => env.removeTables(ids) },
  ];
}

/* ------------------------------------------------------------------ */
/* Note                                                                */
/* ------------------------------------------------------------------ */

function noteMenu(noteId: string, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const note = s.diagram.notes.find((n) => n.id === noteId);
  if (!note) return [];
  const firstLine = note.text.split('\n')[0].trim();
  return [
    { kind: 'heading', id: 'head', label: firstLine || 'Empty note', detail: 'Note' },
    {
      kind: 'action',
      id: 'edit',
      label: 'Edit text',
      icon: Pencil,
      run: () => {
        selectOnly(s, { noteId: note.id });
        s.setInspectorOpen(true);
      },
    },
    { kind: 'swatches', id: 'color', label: 'Color', value: note.color, pick: (key) => s.updateNote(note.id, { color: key }) },
    sep('s1'),
    { kind: 'action', id: 'duplicate', label: 'Duplicate note', icon: Copy, run: () => s.duplicateNote(note.id) },
    { kind: 'action', id: 'copy-text', label: 'Copy text', icon: ClipboardCopy, disabled: !note.text, run: () => env.copy(note.text, 'Copied the note.') },
    sep('s2'),
    { kind: 'action', id: 'delete', label: 'Delete note', icon: Trash2, danger: true, hint: 'Del', run: () => s.deleteNote(note.id) },
  ];
}

/* ------------------------------------------------------------------ */
/* Relationship (edge)                                                 */
/* ------------------------------------------------------------------ */

function convertItem(r: Relationship, env: MenuEnv): MenuAction {
  const s = env.store;
  const src = s.diagram.tables.find((t) => t.id === r.sourceTableId);
  const tgt = s.diagram.tables.find((t) => t.id === r.targetTableId);
  if (r.kind === 'fk') {
    return { kind: 'action', id: 'convert', label: 'Turn into a data flow', icon: GitBranch, run: () => s.updateRelationship(r.id, { kind: 'flow' }) };
  }
  // A flow may have no anchor columns; a foreign key needs one pair, so pick a
  // sensible default (first column -> primary key) when they are missing.
  const canConvert = Boolean(src?.columns.length && tgt?.columns.length);
  return {
    kind: 'action',
    id: 'convert',
    label: 'Turn into a foreign key',
    icon: Link2,
    disabled: !canConvert,
    hint: canConvert ? undefined : 'needs columns',
    run: () => {
      if (!src || !tgt) return;
      const sourceColumnIds = r.sourceColumnIds.filter(Boolean);
      const targetColumnIds = r.targetColumnIds.filter(Boolean);
      s.updateRelationship(r.id, {
        kind: 'fk',
        sourceColumnIds: sourceColumnIds.length ? sourceColumnIds : [src.columns[0].id],
        targetColumnIds: targetColumnIds.length ? targetColumnIds : [(tgt.columns.find((c) => c.primaryKey) ?? tgt.columns[0]).id],
      });
    },
  };
}

function relationshipMenu(relationshipId: string, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const r = s.diagram.relationships.find((x) => x.id === relationshipId);
  if (!r) return [];
  const name = (id: string) => s.diagram.tables.find((t) => t.id === id)?.name ?? '?';
  const query = r.query?.trim() ?? '';
  const select = () => {
    selectOnly(s, { relationshipId: r.id });
    s.setInspectorOpen(true);
  };
  return [
    {
      kind: 'heading',
      id: 'head',
      label: `${name(r.sourceTableId)} → ${name(r.targetTableId)}`,
      detail: r.kind === 'fk' ? 'Foreign key' : 'Data flow',
    },
    { kind: 'action', id: 'edit', label: query ? 'Edit connection' : 'Edit connection / tag a query', icon: PanelRight, run: select },
    { kind: 'action', id: 'swap', label: 'Swap direction', icon: ArrowLeftRight, run: () => s.swapRelationship(r.id) },
    convertItem(r, env),
    sep('s1'),
    {
      kind: 'action',
      id: 'copy-query',
      label: 'Copy tagged query',
      icon: Code2,
      disabled: !query,
      hint: query ? undefined : 'none yet',
      run: () => env.copy(query, 'Copied the tagged query.'),
    },
    {
      kind: 'action',
      id: 'select-tables',
      label: 'Select both tables',
      icon: SquareDashedMousePointer,
      run: () => selectOnly(s, { tableIds: [r.sourceTableId, r.targetTableId] }),
    },
    sep('s2'),
    { kind: 'action', id: 'delete', label: 'Delete connection', icon: Trash2, danger: true, hint: 'Del', run: () => s.deleteRelationship(r.id) },
  ];
}

/* ------------------------------------------------------------------ */

export function buildContextMenu(target: ContextTarget, env: MenuEnv): MenuNode[] {
  const s = env.store;
  switch (target.type) {
    case 'pane':
      return paneMenu(target.flowPosition, env);
    case 'table': {
      const table = s.diagram.tables.find((t) => t.id === target.tableId);
      if (!table) return [];
      // Right-clicking one of several selected tables acts on the whole group.
      if (s.selection.tableIds.length > 1 && s.selection.tableIds.includes(table.id)) return selectionMenu(env);
      const column = target.columnId ? table.columns.find((c) => c.id === target.columnId) : undefined;
      return column ? columnMenu(table, column, env) : tableMenu(table, env);
    }
    case 'selection': {
      const ids = s.selection.tableIds;
      if (ids.length > 1) return selectionMenu(env);
      const table = ids.length === 1 ? s.diagram.tables.find((t) => t.id === ids[0]) : undefined;
      return table ? tableMenu(table, env) : [];
    }
    case 'note':
      return noteMenu(target.noteId, env);
    case 'relationship':
      return relationshipMenu(target.relationshipId, env);
  }
}

/** True when the menu has something clickable (used to skip empty menus). */
export function hasActions(items: MenuNode[]): boolean {
  return items.some((i) => i.kind === 'action' || i.kind === 'swatches');
}
