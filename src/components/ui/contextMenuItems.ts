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
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Box,
  Boxes,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode,
  SquareFunction,
  Braces,
  ClipboardCopy,
  ClipboardPaste,
  Code2,
  Copy,
  Cpu,
  Crosshair,
  Database,
  Eye,
  FileDown,
  FileText,
  Focus,
  FolderInput,
  KeyRound,
  ListPlus,
  Maximize,
  PanelRight,
  Pencil,
  Play,
  Plus,
  Redo2,
  Route,
  Scissors,
  Shapes,
  Shuffle,
  Sigma,
  SquareDashedMousePointer,
  TextCursorInput,
  Ungroup,
  StickyNote,
  Trash2,
  Undo2,
  Wand2,
  Waypoints,
  X,
  type LucideIcon,
} from 'lucide-react';
import { CODE_KINDS, RELATIONSHIP_KINDS, canContain, codeKindMeta, codeKindOf, kindMeta, programLanguageMeta, type CodeKind, type Column, type Relationship, type Table, type TableDisplay } from '@shared/types';
import { codeChildren, codeDescendantIds, codePath } from '@/lib/codemap';
import { generateProgramCode } from '@/lib/code/generate';
import { flowDerivations, matchColumnsByName } from '@/lib/derivation';
import { buildLineage, columnOrigin, derivedColumnIds, type Lineage } from '@/lib/lineage';
import { createGroup, customTypeByName, relationshipKindPatch, uniqueGroupName } from '@/lib/model';
import { emptySelection, selectionSize, type Selection } from '@/lib/selection';
import { selectionMarkdown, selectionSql } from '@/lib/selectionExport';
import { encodeClipboard } from '@/lib/clipboard';
import { alignTables, distributeTables, groupBySchema, type AlignMode } from '@/lib/canvasOps';
import { copySelectionToClipboard, cutSelection, pasteFromClipboard } from '@/lib/canvasActions';
import { PALETTE } from '@/lib/palette';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';
import { sheetDiagram, type Store } from '@/store/useStore';

/** What the user right-clicked. */
export type ContextTarget =
  | { type: 'pane'; flowPosition: { x: number; y: number } }
  | { type: 'table'; tableId: string; columnId?: string }
  | { type: 'note'; noteId: string }
  | { type: 'program'; programId: string }
  | { type: 'relationship'; relationshipId: string }
  | { type: 'group'; groupId: string }
  /** Several tables are selected; act on all of them. */
  | { type: 'selection' }
  /** A diagram's tab in the sheet strip above the canvas. */
  | { type: 'sheet'; sheetId: string };

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

/** Small caption above a group of related items, e.g. the connection kinds. */
export interface MenuCaption {
  kind: 'caption';
  id: string;
  text: string;
}

/** A row of palette swatches, e.g. the table header colour. */
export interface MenuSwatches {
  kind: 'swatches';
  id: string;
  label: string;
  value: string | null;
  pick: (colorKey: string) => void;
}

export type MenuNode = MenuAction | MenuHeading | MenuSeparator | MenuCaption | MenuSwatches;

export interface MenuEnv {
  store: Store;
  /** Copy to the clipboard and toast. */
  copy: (text: string, message: string) => void;
  /** Ask for a new name and apply it. */
  renameTable: (tableId: string) => void;
  /** Delete tables, notes and/or code nodes, confirming first when connections would go with them. */
  remove: (ids: { tableIds?: string[]; noteIds?: string[]; programIds?: string[] }) => void;
  /** Delete a group's region together with its tables, confirming first. */
  removeGroup: (groupId: string) => void;
  /** Paste the clipboard at a canvas position (defaults to the shared clipboard action). */
  pasteAt?: (at: { x: number; y: number }) => void;
  /** Sheet tab actions that ask something first; wired by ContextMenu.tsx. */
  renameSheet?: (id: string) => void;
  closeSheet?: (id: string) => void;
  addSheet?: () => void;
}

const sep = (id: string): MenuSeparator => ({ kind: 'separator', id });

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 tables and 1 note" — shared by the group menu and its confirm dialog. */
export function describeElements({ tableIds = [], noteIds = [], programIds = [] }: { tableIds?: string[]; noteIds?: string[]; programIds?: string[] }, joiner = ' and '): string {
  const parts = [
    tableIds.length && plural(tableIds.length, 'table'),
    noteIds.length && plural(noteIds.length, 'note'),
    programIds.length && plural(programIds.length, 'code node'),
  ].filter(Boolean) as string[];
  return parts.join(joiner);
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

function selectOnly(store: Store, patch: Partial<Selection>): void {
  store.setSelection({ ...emptySelection(), ...patch });
}

/** True when the clicked node is part of a group selection, so the menu should act on the group. */
function inGroup(store: Store, kind: 'table' | 'note' | 'program', id: string): boolean {
  const sel = store.selection;
  if (selectionSize(sel) < 2) return false;
  return kind === 'note' ? sel.noteIds.includes(id) : kind === 'program' ? sel.programIds.includes(id) : sel.tableIds.includes(id);
}

const KIND_ICONS: Record<CodeKind, LucideIcon> = { program: Cpu, module: FileCode, class: Box, function: SquareFunction };

/* ------------------------------------------------------------------ */
/* Shared rows: collapse modes and arrange                             */
/* ------------------------------------------------------------------ */

const DISPLAY_MODES: { id: string; label: string; value: TableDisplay | undefined }[] = [
  { id: 'show-full', label: 'All columns', value: undefined },
  { id: 'show-keys', label: 'Keys only', value: 'keys' },
  { id: 'show-header', label: 'Header only', value: 'header' },
];

/** "Show: All columns / Keys only / Header only" for one or more tables. */
function displayItems(store: Store, tableIds: string[]): MenuNode[] {
  const tables = store.diagram.tables.filter((t) => tableIds.includes(t.id));
  const current = tables.length && tables.every((t) => (t.collapsed ?? null) === (tables[0].collapsed ?? null)) ? (tables[0].collapsed ?? undefined) : null;
  return [
    { kind: 'caption', id: 'show-caption', text: tableIds.length > 1 ? `Show (${tableIds.length} tables)` : 'Show' },
    ...DISPLAY_MODES.map((m) => ({
      kind: 'action' as const,
      id: m.id,
      label: m.label,
      checked: current !== null && current === m.value,
      disabled: tables.length === 0,
      run: () => store.setTableDisplay(tableIds, m.value),
    })),
  ];
}

/**
 * The "Copy as" rows, shared by the table, selection and group menus.
 *
 * Every format here covers exactly `tableIds` and the connections between them;
 * anything pointing at a table that did not come along is left out, and the text
 * says so rather than dropping it silently. That holds for a single table too:
 * its own DDL would carry a foreign key to a table you did not copy, which does
 * not run on its own.
 */
function copyAsItems(env: MenuEnv, tableIds: string[], what: string): MenuNode[] {
  const d = env.store.diagram;
  const only = tableIds.length === 1 ? d.tables.find((t) => t.id === tableIds[0]) : undefined;
  const sqlLabel = only ? (only.kind === 'view' ? 'CREATE VIEW' : 'CREATE TABLE') : 'SQL script';
  return [
    { kind: 'caption', id: 'copy-as-caption', text: 'Copy as' },
    { kind: 'action', id: 'copy-sql', label: sqlLabel, icon: Code2, run: () => env.copy(selectionSql(d, tableIds).text, `Copied the SQL for ${what}.`) },
    { kind: 'action', id: 'copy-markdown', label: 'Markdown', icon: FileText, run: () => env.copy(selectionMarkdown(d, tableIds), `Copied ${what} as a Markdown table.`) },
    {
      kind: 'action',
      id: 'copy-markdown-sql',
      label: 'Markdown + SQL',
      icon: FileText,
      run: () => env.copy(selectionMarkdown(d, tableIds, { includeSql: true }), `Copied ${what} as Markdown with the SQL below it.`),
    },
    { kind: 'action', id: 'copy-json', label: 'Diagram JSON', icon: Braces, run: () => env.copy(encodeClipboard(d, tableIds), `Copied ${what} as diagram JSON.`) },
  ];
}

const ALIGN_ITEMS: { id: string; label: string; icon: LucideIcon; mode: AlignMode }[] = [
  { id: 'align-left', label: 'Align left edges', icon: AlignStartVertical, mode: 'left' },
  { id: 'align-center-x', label: 'Align centres (vertical axis)', icon: AlignCenterVertical, mode: 'centerX' },
  { id: 'align-right', label: 'Align right edges', icon: AlignEndVertical, mode: 'right' },
  { id: 'align-top', label: 'Align top edges', icon: AlignStartHorizontal, mode: 'top' },
  { id: 'align-center-y', label: 'Align middles (horizontal axis)', icon: AlignCenterHorizontal, mode: 'centerY' },
  { id: 'align-bottom', label: 'Align bottom edges', icon: AlignEndHorizontal, mode: 'bottom' },
];

/** One undo step for a set of moves. */
function applyMoves(store: Store, moves: { id: string; position: { x: number; y: number } }[]): void {
  if (!moves.length) return;
  store.beginDrag();
  store.moveItems(moves);
  store.endDrag();
}

function arrangeItems(store: Store, tableIds: string[]): MenuNode[] {
  const tables = store.diagram.tables.filter((t) => tableIds.includes(t.id));
  // Placement sizes, not drawn sizes: arranging by zoom-collapsed headers would
  // leave the tables overlapping as soon as the columns come back.
  const sizes = store.placementSizes();
  return [
    { kind: 'caption', id: 'arrange-caption', text: 'Arrange' },
    ...ALIGN_ITEMS.map((a) => ({
      kind: 'action' as const,
      id: a.id,
      label: a.label,
      icon: a.icon,
      disabled: tables.length < 2,
      run: () => applyMoves(store, alignTables(tables, sizes, a.mode)),
    })),
    {
      kind: 'action',
      id: 'distribute-x',
      label: 'Distribute horizontally',
      icon: AlignHorizontalDistributeCenter,
      disabled: tables.length < 3,
      hint: tables.length < 3 ? 'needs 3+' : undefined,
      run: () => applyMoves(store, distributeTables(tables, sizes, 'x')),
    },
    {
      kind: 'action',
      id: 'distribute-y',
      label: 'Distribute vertically',
      icon: AlignVerticalDistributeCenter,
      disabled: tables.length < 3,
      hint: tables.length < 3 ? 'needs 3+' : undefined,
      run: () => applyMoves(store, distributeTables(tables, sizes, 'y')),
    },
  ];
}

function focusItem(store: Store, tableId: string): MenuAction {
  const ui = useUi.getState();
  const focused = ui.focus?.nodeId === tableId;
  return {
    kind: 'action',
    id: focused ? 'unfocus' : 'focus',
    label: focused ? 'Clear focus' : 'Focus neighborhood',
    icon: Focus,
    hint: '.',
    disabled: !focused && store.diagram.relationships.every((r) => r.sourceTableId !== tableId && r.targetTableId !== tableId),
    run: () => ui.setFocus(focused ? null : { nodeId: tableId, hops: 1 }),
  };
}

/** Create one region per schema name, in a single undo step. */
export function createGroupsBySchema(store: Store): number {
  const specs = groupBySchema(store.diagram);
  if (!specs.length) return 0;
  store.mutate((d) => {
    for (const spec of specs) {
      const g = createGroup({ name: uniqueGroupName(d, spec.name), color: PALETTE[d.groups.length % PALETTE.length].key });
      d.groups.push(g);
      const ids = new Set(spec.tableIds);
      for (const t of d.tables) if (ids.has(t.id)) t.groupId = g.id;
    }
  });
  return specs.length;
}

/* ------------------------------------------------------------------ */
/* Canvas background                                                   */
/* ------------------------------------------------------------------ */

function paneMenu(at: { x: number; y: number }, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const tables = s.diagram.tables;
  const ui = useUi.getState();
  const schemaGroups = groupBySchema(s.diagram).length;
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
      id: 'add-view',
      label: 'Add view here',
      icon: Eye,
      run: () => s.addTable({ x: Math.round(at.x - 120), y: Math.round(at.y - 20) }, { kind: 'view' }),
    },
    {
      kind: 'action',
      id: 'add-note',
      label: 'Add note here',
      icon: StickyNote,
      hint: 'N',
      run: () => s.addNote({ x: Math.round(at.x - 110), y: Math.round(at.y - 60) }),
    },
    {
      kind: 'action',
      id: 'add-program',
      label: 'Add program here',
      icon: Cpu,
      run: () => s.addProgram({ position: { x: Math.round(at.x - 130), y: Math.round(at.y - 30) } }),
    },
    // The three levels of a code map, so a codebase can be sketched from the
    // canvas the way it would be sketched on paper: files, classes, functions.
    ...(['module', 'class', 'function'] as const).map((k) => ({
      kind: 'action' as const,
      id: `add-${k}`,
      label: `Add ${codeKindMeta(k).label.toLowerCase()} here`,
      icon: KIND_ICONS[k],
      run: () => s.addProgram({ kind: k, position: { x: Math.round(at.x - 130), y: Math.round(at.y - 30) } }),
    })),
    {
      kind: 'action',
      id: 'paste',
      label: 'Paste here',
      icon: ClipboardPaste,
      hint: 'Ctrl+V',
      run: () => (env.pasteAt ? env.pasteAt(at) : void pasteFromClipboard(at)),
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
    {
      kind: 'action',
      id: 'group-by-schema',
      label: 'Group tables by schema',
      icon: Boxes,
      disabled: schemaGroups === 0,
      hint: schemaGroups ? `${schemaGroups} schema${schemaGroups === 1 ? '' : 's'}` : 'no schemas',
      run: () => {
        const n = createGroupsBySchema(s);
        s.toast('success', `Created ${n} group${n === 1 ? '' : 's'} from schema names.`);
      },
    },
    sep('s-canvas'),
    { kind: 'caption', id: 'canvas-caption', text: 'Canvas' },
    { kind: 'action', id: 'snap', label: 'Snap to grid', checked: ui.snapToGrid, run: () => ui.setSnapToGrid(!ui.snapToGrid) },
    { kind: 'action', id: 'cardinality', label: 'Cardinality labels', checked: ui.showCardinality, run: () => ui.setShowCardinality(!ui.showCardinality) },
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

/** "Simulate data flowing in" for a table at least one data flow feeds. */
function simulateItem(store: Store, table: Table): MenuAction {
  const fed = store.diagram.relationships.some((r) => r.kind === 'flow' && r.targetTableId === table.id && r.sourceTableId !== table.id);
  const sim = useSimulation.getState();
  const on = sim.targetId === table.id;
  return {
    kind: 'action',
    id: on ? 'simulate-stop' : 'simulate',
    label: on ? 'Stop simulating' : 'Simulate data flowing in',
    icon: Play,
    hint: on ? 'Esc' : fed ? 'S' : 'nothing feeds it',
    disabled: !on && !fed,
    run: () => (on ? sim.stop() : sim.start(table.id)),
  };
}

/** "Show the N derived columns" for a table that has some; the plain lens toggle otherwise. */
function derivedTableItem(store: Store, table: Table): MenuAction {
  const n = derivedColumnIds(buildLineage(store.diagram), table).length;
  const ui = useUi.getState();
  return {
    kind: 'action',
    id: 'derived-table',
    label: n ? `Show the ${n} derived column${n === 1 ? '' : 's'}` : ui.derived ? 'Turn the derived lens off' : 'Derived-column lens',
    icon: Sigma,
    hint: n ? undefined : 'D',
    run: () => {
      if (!n) return ui.toggleDerived();
      ui.setDerived({ columnId: null, downstream: true });
      selectOnly(store, { tableIds: [table.id] });
      store.openDrawer('derived');
    },
  };
}

/**
 * "Show where this comes from" for one column, which is the lens pointed at it.
 * A stored column nothing reads has no lineage worth opening, so it gets nothing.
 */
function derivedColumnItems(store: Store, lineage: Lineage, column: Column): MenuNode[] {
  const origin = columnOrigin(lineage, column.id);
  const readers = lineage.feeds.get(column.id)?.length ?? 0;
  if (origin === 'stored' && readers === 0) return [];
  return [
    sep('s-derived'),
    {
      kind: 'action',
      id: 'lineage',
      label: origin === 'stored' ? `Show what this feeds (${readers})` : 'Show where this comes from',
      icon: Sigma,
      run: () => {
        useUi.getState().showLineage(column.id);
        store.openDrawer('derived');
      },
    },
  ];
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
    { kind: 'action', id: 'rename-inline', label: 'Rename in place', icon: TextCursorInput, hint: 'F2', run: () => useUi.getState().setRenamingNodeId(table.id) },
    { kind: 'action', id: 'add-column', label: 'Add column', icon: Plus, run: () => s.addColumn(table.id) },
    sep('s1'),
    { kind: 'swatches', id: 'color', label: 'Color', value: table.color, pick: (key) => s.updateTable(table.id, { color: key }) },
    sep('s2'),
    { kind: 'action', id: 'duplicate', label: 'Duplicate table', icon: Copy, run: () => s.duplicateTable(table.id) },
    { kind: 'action', id: 'copy', label: 'Copy table', icon: ClipboardCopy, hint: 'Ctrl+C', run: () => void copySelectionToClipboard([table.id]) },
    {
      kind: 'action',
      id: 'cut',
      label: 'Cut table',
      icon: Scissors,
      hint: 'Ctrl+X',
      run: () => {
        selectOnly(s, { tableIds: [table.id] });
        cutSelection();
      },
    },
    sep('s-copy-as'),
    ...copyAsItems(env, [table.id], table.name || 'the table'),
    { kind: 'action', id: 'copy-name', label: 'Table name', icon: ClipboardCopy, run: () => env.copy(table.name, 'Copied the table name.') },
    sep('s-sql-tab'),
    {
      kind: 'action',
      id: 'show-sql',
      label: 'Show in SQL tab',
      icon: Code2,
      run: () => {
        selectOnly(s, { tableIds: [table.id] });
        s.openDrawer('sql');
      },
    },
    sep('s-show'),
    ...displayItems(s, [table.id]),
    sep('s3'),
    focusItem(s, table.id),
    { kind: 'action', id: 'zoom', label: 'Zoom to table', icon: Crosshair, run: () => s.focusTable(table.id) },
    {
      kind: 'action',
      id: 'select-connected',
      label: `Select connected (${connected.length})`,
      icon: Waypoints,
      disabled: connected.length === 0,
      run: () => selectOnly(s, { tableIds: [table.id, ...connected] }),
    },
    traceItem(table, env),
    simulateItem(s, table),
    derivedTableItem(s, table),
    sep('s4'),
    { kind: 'action', id: 'delete', label: 'Delete table', icon: Trash2, danger: true, hint: 'Del', run: () => env.remove({ tableIds: [table.id] }) },
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
  const lineage = buildLineage(s.diagram);
  const origin = columnOrigin(lineage, column.id);
  return [
    {
      kind: 'heading',
      id: 'head',
      label: `${table.name}.${column.name}`,
      detail: [column.type, customType && (customType.kind === 'enum' ? 'enum' : 'struct'), isFk && 'foreign key', origin === 'derived' && 'computed', origin === 'view' && 'from the view’s SELECT']
        .filter(Boolean)
        .join(' · '),
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
    ...derivedColumnItems(s, lineage, column),
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
  const { tableIds, noteIds, programIds } = s.selection;
  const tableNames = tableIds.map((id) => s.diagram.tables.find((t) => t.id === id)?.name ?? '?');
  const noteNames = noteIds.map((id) => s.diagram.notes.find((n) => n.id === id)?.text.split('\n')[0] || 'Empty note');
  const codeNames = programIds.map((id) => s.diagram.programs.find((p) => p.id === id)?.name ?? '?');
  // Same phrasing the inspector uses for a mixed group, e.g. "2 tables + 1 note".
  return [
    { kind: 'heading', id: 'head', label: `${describeElements(s.selection, ' + ')} selected`, detail: [...tableNames, ...noteNames, ...codeNames].join(', ') },
    ...(tableIds.length > 1
      ? [
          {
            kind: 'action' as const,
            id: 'trace',
            label: `Trace ${tableNames[0]} → ${tableNames[1]}`,
            icon: Route,
            run: () => {
              s.setTraceEndpoints(tableIds[0], tableIds[1]);
              s.runTrace();
            },
          },
          { kind: 'action' as const, id: 'detangle', label: 'Detangle layout', icon: Shuffle, hint: 'L', run: () => s.applyLayout() },
          sep('s1'),
        ]
      : []),
    { kind: 'swatches', id: 'color', label: 'Color for all', value: null, pick: (key) => s.colorElements({ tableIds, noteIds, programIds }, key) },
    ...(programIds.length > 1
      ? [
          {
            kind: 'action' as const,
            id: 'fold',
            label: `Collapse the ${plural(programIds.length, 'container')}`,
            icon: ChevronsDownUp,
            disabled: !programIds.some((id) => codeChildren(s.diagram).get(id)?.length),
            run: () => s.setCodeCollapsed(programIds, true),
          },
          {
            kind: 'action' as const,
            id: 'unfold',
            label: `Expand the ${plural(programIds.length, 'container')}`,
            icon: ChevronsUpDown,
            disabled: !programIds.some((id) => s.diagram.programs.find((p) => p.id === id)?.collapsed),
            run: () => s.setCodeCollapsed(programIds, false),
          },
        ]
      : []),
    ...(tableIds.length
      ? [
          sep('s-show'),
          ...displayItems(s, tableIds),
          sep('s-arrange'),
          ...arrangeItems(s, tableIds),
          sep('s-clip'),
          { kind: 'action' as const, id: 'copy', label: `Copy ${plural(tableIds.length, 'table')}`, icon: ClipboardCopy, hint: 'Ctrl+C', run: () => void copySelectionToClipboard(tableIds) },
          { kind: 'action' as const, id: 'cut', label: `Cut ${plural(tableIds.length, 'table')}`, icon: Scissors, hint: 'Ctrl+X', run: () => cutSelection() },
          sep('s-copy-as'),
          ...copyAsItems(env, tableIds, plural(tableIds.length, 'table')),
        ]
      : []),
    sep('s2'),
    { kind: 'action', id: 'clear', label: 'Clear selection', icon: X, hint: 'Esc', run: () => s.clearSelection() },
    {
      kind: 'action',
      id: 'delete',
      label: `Delete ${describeElements(s.selection)}`,
      icon: Trash2,
      danger: true,
      hint: 'Del',
      run: () => env.remove({ tableIds, noteIds, programIds }),
    },
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
        selectOnly(s, { noteIds: [note.id] });
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
/* Program                                                             */
/* ------------------------------------------------------------------ */

function programMenu(programId: string, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const prg = s.diagram.programs.find((p) => p.id === programId);
  if (!prg) return [];
  const lang = programLanguageMeta(prg.language);
  const kind = codeKindOf(prg);
  const noun = codeKindMeta(kind).label.toLowerCase();
  const starter = generateProgramCode(s.diagram, prg);
  const members = codeChildren(s.diagram).get(prg.id) ?? [];
  const inside = codeDescendantIds(s.diagram, prg.id);
  const parent = prg.parentId ? s.diagram.programs.find((p) => p.id === prg.parentId) : undefined;
  const ui = useUi.getState();
  const focused = ui.focus?.nodeId === prg.id;
  const memberKinds = CODE_KINDS.filter((k) => canContain(kind, k.id));
  const detail = [kind === 'program' ? `${lang.label} program` : `${noun}, ${lang.label}`, parent && `in ${codePath(s.diagram, parent)}`, inside.length > 0 && `${plural(inside.length, 'node')} inside`]
    .filter(Boolean)
    .join(' · ');
  return [
    { kind: 'heading', id: 'head', label: prg.name, detail },
    {
      kind: 'action',
      id: 'edit',
      label: 'Edit steps',
      icon: Pencil,
      run: () => {
        selectOnly(s, { programIds: [prg.id] });
        s.setInspectorOpen(true);
      },
    },
    { kind: 'action', id: 'rename-inline', label: 'Rename in place', icon: TextCursorInput, hint: 'F2', run: () => ui.setRenamingNodeId(prg.id) },
    { kind: 'action', id: 'add-step', label: 'Add a step', icon: Plus, run: () => s.addProgramStep(prg.id) },
    ...memberKinds.map((k) => ({
      kind: 'action' as const,
      id: `add-member-${k.id}`,
      label: `Add a ${k.label.toLowerCase()} inside`,
      icon: KIND_ICONS[k.id],
      run: () => s.addProgram({ kind: k.id, parentId: prg.id }),
    })),
    { kind: 'swatches', id: 'color', label: 'Color', value: prg.color, pick: (key) => s.updateProgram(prg.id, { color: key }) },
    sep('s-fold'),
    ...(members.length
      ? [
          prg.collapsed
            ? { kind: 'action' as const, id: 'unfold', label: `Expand: show the ${plural(inside.length, 'node')} inside`, icon: ChevronsUpDown, run: () => s.setCodeCollapsed([prg.id], false) }
            : { kind: 'action' as const, id: 'fold', label: 'Collapse to one node', icon: ChevronsDownUp, run: () => s.setCodeCollapsed([prg.id], true) },
          {
            kind: 'action' as const,
            id: 'select-members',
            label: `Select the ${plural(inside.length, 'node')} inside`,
            icon: SquareDashedMousePointer,
            run: () => selectOnly(s, { programIds: inside }),
          },
        ]
      : []),
    ...(parent
      ? [{ kind: 'action' as const, id: 'move-out', label: `Move out of ${parent.name}`, icon: FolderInput, run: () => s.setCodeParent([prg.id], parent.parentId ?? null) }]
      : []),
    {
      kind: 'action',
      id: focused ? 'unfocus' : 'focus',
      label: focused ? 'Clear focus' : 'Focus neighborhood',
      icon: Focus,
      hint: '.',
      run: () => ui.setFocus(focused ? null : { nodeId: prg.id, hops: 1 }),
    },
    {
      kind: 'action',
      id: 'trace-from',
      label: 'Trace from here…',
      icon: Route,
      hint: 'pick a 2nd node',
      run: () => {
        s.setTracePicking(true);
        s.setTraceEndpoints(prg.id, null);
        s.openDrawer('trace');
      },
    },
    sep('s1'),
    {
      kind: 'action',
      id: 'copy-code',
      label: `Copy the ${lang.label} starter`,
      icon: Code2,
      disabled: prg.steps.length === 0,
      run: () => env.copy(starter, `Copied the ${lang.label} starter for ${prg.name}.`),
    },
    { kind: 'action', id: 'copy', label: `Copy ${noun}`, icon: ClipboardCopy, hint: 'Ctrl+C', run: () => void copySelectionToClipboard([], [prg.id]) },
    { kind: 'action', id: 'duplicate', label: `Duplicate ${noun}`, icon: Copy, run: () => s.duplicateProgram(prg.id) },
    sep('s2'),
    ...(members.length ? [{ kind: 'action' as const, id: 'dissolve', label: `Dissolve: keep the ${plural(inside.length, 'node')}, drop the ${noun}`, icon: Ungroup, run: () => s.dissolveCodeNode(prg.id) }] : []),
    {
      kind: 'action',
      id: 'delete',
      label: inside.length ? `Delete ${noun} and the ${plural(inside.length, 'node')} inside` : `Delete ${noun}`,
      icon: Trash2,
      danger: true,
      hint: 'Del',
      run: () => env.remove({ programIds: [prg.id] }),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Relationship (edge)                                                 */
/* ------------------------------------------------------------------ */

/**
 * One checkable row per connection kind. Switching kind follows the same rules as
 * the inspector: an embed keeps only the column the target is serialized into, and
 * a foreign key needs a column pair, so one is filled in when it is missing.
 */
function kindItems(r: Relationship, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const src = s.diagram.tables.find((t) => t.id === r.sourceTableId);
  const tgt = s.diagram.tables.find((t) => t.id === r.targetTableId);
  const canPair = Boolean(src?.columns.length && tgt?.columns.length);
  return [
    { kind: 'caption', id: 'kind-caption', text: 'Connection kind' },
    ...RELATIONSHIP_KINDS.map((k) => {
      const blocked = k.needsColumnPairs && !canPair && r.kind !== k.id;
      return {
        kind: 'action' as const,
        id: `kind-${k.id}`,
        label: k.label,
        checked: r.kind === k.id,
        disabled: blocked,
        hint: blocked ? 'needs columns' : undefined,
        run: () => s.updateRelationship(r.id, relationshipKindPatch(s.diagram, r, k.id)),
      };
    }),
  ];
}

function relationshipMenu(relationshipId: string, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const r = s.diagram.relationships.find((x) => x.id === relationshipId);
  if (!r) return [];
  const name = (id: string) => s.diagram.tables.find((t) => t.id === id)?.name ?? '?';
  const query = r.query?.trim() ?? '';
  const derived = flowDerivations(r).length;
  const select = () => {
    selectOnly(s, { relationshipId: r.id });
    s.setInspectorOpen(true);
  };
  // Target columns a source column of the same name could fill: the repetitive
  // half of a passthrough flow, offered here as one click.
  const src = s.diagram.tables.find((t) => t.id === r.sourceTableId);
  const tgt = s.diagram.tables.find((t) => t.id === r.targetTableId);
  const matches = r.kind === 'flow' && src && tgt && src.id !== tgt.id ? matchColumnsByName(src.columns, tgt.columns, r.derivations ?? []) : [];
  return [
    {
      kind: 'heading',
      id: 'head',
      label: `${name(r.sourceTableId)} → ${name(r.targetTableId)}`,
      detail: [kindMeta(r.kind).label, derived > 0 && plural(derived, 'derived column')].filter(Boolean).join(' · '),
    },
    { kind: 'action', id: 'edit', label: query ? 'Edit connection' : 'Edit connection / tag a query', icon: PanelRight, run: select },
    ...(r.kind === 'flow' && r.sourceTableId !== r.targetTableId
      ? [
          {
            kind: 'action' as const,
            id: 'simulate',
            label: `Simulate rows flowing into ${name(r.targetTableId)}`,
            icon: Play,
            hint: derived ? undefined : 'add derived columns first',
            run: () => useSimulation.getState().start(r.targetTableId),
          },
        ]
      : []),
    ...(r.kind === 'flow'
      ? [
          {
            kind: 'action' as const,
            id: 'match-by-name',
            label: 'Match columns by name',
            icon: Wand2,
            disabled: matches.length === 0,
            hint: matches.length ? plural(matches.length, 'column') : derived ? 'all mapped' : 'no matching names',
            run: () => {
              const n = s.fillFlowByName(r.id);
              if (n > 0) s.toast('success', `Filled ${plural(n, 'column')} of ${name(r.targetTableId)} from ${name(r.sourceTableId)}.`);
            },
          },
        ]
      : []),
    { kind: 'action', id: 'swap', label: 'Swap direction', icon: ArrowLeftRight, run: () => s.swapRelationship(r.id) },
    sep('s1'),
    ...kindItems(r, env),
    sep('s2'),
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
    sep('s3'),
    { kind: 'action', id: 'delete', label: 'Delete connection', icon: Trash2, danger: true, hint: 'Del', run: () => s.deleteRelationship(r.id) },
  ];
}

function groupMenu(groupId: string, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const group = s.diagram.groups.find((g) => g.id === groupId);
  if (!group) return [];
  const members = s.diagram.tables.filter((t) => t.groupId === groupId);
  const ids = members.map((t) => t.id);
  return [
    {
      kind: 'heading',
      id: 'head',
      label: group.name || 'Untitled group',
      detail: `${plural(members.length, 'table')}${group.external ? ' · in another database' : ''}`,
    },
    {
      kind: 'action',
      id: 'select',
      label: `Select its ${plural(members.length, 'table')}`,
      icon: SquareDashedMousePointer,
      disabled: members.length === 0,
      run: () => s.setSelection({ ...emptySelection(), tableIds: ids }),
    },
    {
      kind: 'action',
      id: 'external',
      label: 'In another database',
      checked: group.external,
      hint: group.external ? 'not created by the script' : undefined,
      run: () => s.updateGroup(groupId, { external: !group.external }),
    },
    { kind: 'action', id: 'inspector', label: 'Edit group…', icon: PanelRight, run: () => s.selectGroup(groupId) },
    ...(members.length ? [sep('s-show'), ...displayItems(s, ids)] : []),
    ...(members.length
      ? [
          sep('s-clip'),
          { kind: 'action' as const, id: 'copy', label: `Copy its ${plural(members.length, 'table')}`, icon: ClipboardCopy, run: () => void copySelectionToClipboard(ids) },
          sep('s-copy-as'),
          ...copyAsItems(env, ids, group.name || 'the group'),
        ]
      : []),
    sep('s1'),
    {
      kind: 'action',
      id: 'ungroup',
      label: 'Remove region, keep tables',
      icon: Ungroup,
      run: () => {
        s.deleteGroup(groupId, false);
        s.toast('info', `Removed the "${group.name}" region. Its tables are still in the diagram.`);
      },
    },
    {
      kind: 'action',
      id: 'delete',
      label: `Delete region and its ${plural(members.length, 'table')}`,
      icon: Trash2,
      danger: true,
      disabled: members.length === 0,
      run: () => env.removeGroup(groupId),
    },
  ];
}

/* ------------------------------------------------------------------ */

/** The tab of one diagram in the workspace. */
function sheetMenu(sheetId: string, env: MenuEnv): MenuNode[] {
  const s = env.store;
  const at = s.sheetIds.indexOf(sheetId);
  const name = sheetDiagram(s, sheetId)?.name ?? 'this diagram';
  const last = s.sheetIds.length === 1;
  return [
    { kind: 'action', id: 'sheet-rename', label: 'Rename…', icon: Pencil, run: () => env.renameSheet?.(sheetId) },
    { kind: 'action', id: 'sheet-duplicate', label: 'Duplicate', icon: Copy, run: () => void s.duplicateSheet(sheetId) },
    sep('sheet-order'),
    { kind: 'action', id: 'sheet-left', label: 'Move left', icon: ArrowLeft, disabled: at <= 0, run: () => s.moveSheet(sheetId, at - 1) },
    { kind: 'action', id: 'sheet-right', label: 'Move right', icon: ArrowRight, disabled: at < 0 || at >= s.sheetIds.length - 1, run: () => s.moveSheet(sheetId, at + 1) },
    sep('sheet-end'),
    { kind: 'action', id: 'sheet-add', label: 'New diagram in this workspace', icon: Plus, run: () => env.addSheet?.() },
    { kind: 'action', id: 'sheet-close', label: last ? `Empty "${name}"` : `Close "${name}"`, icon: X, danger: true, run: () => env.closeSheet?.(sheetId) },
  ];
}

export function buildContextMenu(target: ContextTarget, env: MenuEnv): MenuNode[] {
  const s = env.store;
  switch (target.type) {
    case 'pane':
      return paneMenu(target.flowPosition, env);
    case 'table': {
      const table = s.diagram.tables.find((t) => t.id === target.tableId);
      if (!table) return [];
      // Right-clicking inside a group selection acts on the whole group.
      if (inGroup(s, 'table', table.id)) return selectionMenu(env);
      const column = target.columnId ? table.columns.find((c) => c.id === target.columnId) : undefined;
      return column ? columnMenu(table, column, env) : tableMenu(table, env);
    }
    case 'selection': {
      const { tableIds, noteIds, programIds } = s.selection;
      if (selectionSize(s.selection) > 1) return selectionMenu(env);
      if (tableIds.length === 1) {
        const table = s.diagram.tables.find((t) => t.id === tableIds[0]);
        return table ? tableMenu(table, env) : [];
      }
      if (programIds.length === 1) return programMenu(programIds[0], env);
      return noteIds.length === 1 ? noteMenu(noteIds[0], env) : [];
    }
    case 'note':
      return inGroup(s, 'note', target.noteId) ? selectionMenu(env) : noteMenu(target.noteId, env);
    case 'program':
      return inGroup(s, 'program', target.programId) ? selectionMenu(env) : programMenu(target.programId, env);
    case 'relationship':
      return relationshipMenu(target.relationshipId, env);
    case 'group':
      return groupMenu(target.groupId, env);
    case 'sheet':
      return sheetMenu(target.sheetId, env);
  }
}

/** True when the menu has something clickable (used to skip empty menus). */
export function hasActions(items: MenuNode[]): boolean {
  return items.some((i) => i.kind === 'action' || i.kind === 'swatches');
}
