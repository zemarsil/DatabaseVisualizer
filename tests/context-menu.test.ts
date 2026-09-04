import { describe, expect, it, vi } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { buildContextMenu, hasActions, type MenuAction, type MenuEnv, type MenuNode } from '../src/components/ui/contextMenuItems';
import { sampleDiagram } from '../src/lib/sample';
import type { Store } from '../src/store/useStore';

/** A store stub: real state, recorded actions. */
function makeEnv(diagram: Diagram, over: Partial<Store> = {}) {
  const actions = {
    addTable: vi.fn(),
    addNote: vi.fn(),
    addColumn: vi.fn(),
    addIndex: vi.fn(),
    updateTable: vi.fn(),
    updateTables: vi.fn(),
    updateColumn: vi.fn(),
    updateNote: vi.fn(),
    updateRelationship: vi.fn(),
    deleteColumn: vi.fn(),
    deleteNote: vi.fn(),
    deleteRelationship: vi.fn(),
    duplicateTable: vi.fn(),
    duplicateNote: vi.fn(),
    swapRelationship: vi.fn(),
    moveColumn: vi.fn(),
    applyLayout: vi.fn(),
    requestFitView: vi.fn(),
    focusTable: vi.fn(),
    openDrawer: vi.fn(),
    setSelection: vi.fn(),
    setInspectorOpen: vi.fn(),
    clearSelection: vi.fn(),
    setTraceEndpoints: vi.fn(),
    setTracePicking: vi.fn(),
    runTrace: vi.fn(),
    clearTrace: vi.fn(),
    toast: vi.fn(),
  };
  const store = {
    diagram,
    past: [],
    future: [],
    selection: { tableIds: [], relationshipId: null, noteId: null },
    trace: { fromId: null, toId: null, result: null, searched: false, picking: false },
    ...actions,
    ...over,
  } as unknown as Store;
  const env: MenuEnv = { store, copy: vi.fn(), renameTable: vi.fn(), removeTables: vi.fn() };
  return { env, store, actions };
}

const ids = (items: MenuNode[]) => items.filter((i) => i.kind === 'action').map((i) => i.id);
const action = (items: MenuNode[], id: string) => items.find((i): i is MenuAction => i.kind === 'action' && i.id === id)!;
const heading = (items: MenuNode[]) => items.find((i) => i.kind === 'heading');

describe('canvas background menu', () => {
  it('adds a table at the clicked point and offers diagram-wide actions', () => {
    const d = sampleDiagram();
    const { env, actions } = makeEnv(d);
    const items = buildContextMenu({ type: 'pane', flowPosition: { x: 500, y: 300 } }, env);
    expect(ids(items)).toEqual(
      expect.arrayContaining(['add-table', 'add-note', 'select-all', 'detangle', 'fit', 'undo', 'redo', 'sql', 'types', 'import', 'database']),
    );
    action(items, 'add-table').run();
    expect(actions.addTable).toHaveBeenCalledWith({ x: 380, y: 280 });
  });

  it('greys out undo/redo when there is no history and offers to clear an active trace', () => {
    const d = sampleDiagram();
    const { env } = makeEnv(d, { past: [d], trace: { fromId: 'a', toId: 'b', result: { tableIds: [] }, searched: true, picking: false } as never });
    const items = buildContextMenu({ type: 'pane', flowPosition: { x: 0, y: 0 } }, env);
    expect(action(items, 'undo').disabled).toBe(false);
    expect(action(items, 'redo').disabled).toBe(true);
    expect(action(items, 'clear-trace')).toBeTruthy();
  });
});

describe('table menu', () => {
  it('describes the table and copies its CREATE TABLE', () => {
    const d = sampleDiagram();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    const { env } = makeEnv(d);
    const items = buildContextMenu({ type: 'table', tableId: orders.id }, env);
    expect(heading(items)).toMatchObject({ label: 'orders' });
    expect(ids(items)).toEqual(expect.arrayContaining(['rename', 'add-column', 'duplicate', 'copy-sql', 'focus', 'select-connected', 'delete']));
    expect(items.some((i) => i.kind === 'swatches')).toBe(true);
    action(items, 'copy-sql').run();
    expect(env.copy).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE'), expect.stringContaining('orders'));
  });

  it('offers to trace on to a second table once one endpoint is picked', () => {
    const d = sampleDiagram();
    const [a, b] = d.tables;
    const { env, actions } = makeEnv(d, { trace: { fromId: a.id, toId: null, result: null, searched: false, picking: true } });
    const items = buildContextMenu({ type: 'table', tableId: b.id }, env);
    expect(action(items, 'trace-to').label).toBe(`Trace ${a.name} → ${b.name}`);
    action(items, 'trace-to').run();
    expect(actions.setTraceEndpoints).toHaveBeenCalledWith(a.id, b.id);
    expect(actions.runTrace).toHaveBeenCalled();
  });

  it('acts on the whole group when the clicked table is part of a multi-selection', () => {
    const d = sampleDiagram();
    const [a, b] = d.tables;
    const { env, actions } = makeEnv(d, { selection: { tableIds: [a.id, b.id], relationshipId: null, noteId: null } });
    const items = buildContextMenu({ type: 'table', tableId: b.id }, env);
    expect(heading(items)).toMatchObject({ label: '2 tables selected' });
    expect(action(items, 'delete').label).toBe('Delete 2 tables');
    action(items, 'delete').run();
    expect(env.removeTables).toHaveBeenCalledWith([a.id, b.id]);
    const swatches = items.find((i) => i.kind === 'swatches')!;
    if (swatches.kind === 'swatches') swatches.pick('teal');
    expect(actions.updateTables).toHaveBeenCalledWith([a.id, b.id], { color: 'teal' });
  });
});

describe('column menu', () => {
  it('mirrors the column flags and inserts below the clicked row', () => {
    const d = sampleDiagram();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    const pk = orders.columns[0];
    const { env, actions } = makeEnv(d);
    const items = buildContextMenu({ type: 'table', tableId: orders.id, columnId: pk.id }, env);
    expect(heading(items)).toMatchObject({ label: `orders.${pk.name}` });
    expect(action(items, 'pk').checked).toBe(pk.primaryKey);
    expect(action(items, 'nn').checked).toBe(!pk.nullable);
    expect(action(items, 'up').disabled).toBe(true);
    action(items, 'add-below').run();
    expect(actions.addColumn).toHaveBeenCalledWith(orders.id, undefined, { after: pk.id });
    action(items, 'pk').run();
    expect(actions.updateColumn).toHaveBeenCalledWith(orders.id, pk.id, { primaryKey: !pk.primaryKey });
    expect(action(items, 'delete').label).toBe('Delete column');
  });
});

describe('custom types', () => {
  it('offers a jump to the type a column is declared with', () => {
    const d = sampleDiagram();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    const status = orders.columns.find((c) => c.name === 'status')!;
    d.customTypes = [{ id: 'ct1', name: 'order_status', kind: 'enum', values: ['pending', 'shipped'] }];
    status.type = 'order_status';
    const { env, actions } = makeEnv(d);
    const items = buildContextMenu({ type: 'table', tableId: orders.id, columnId: status.id }, env);
    expect(heading(items)).toMatchObject({ detail: 'order_status · enum' });
    action(items, 'edit-type').run();
    expect(actions.openDrawer).toHaveBeenCalledWith('types');

    // a plain SQL type gets no such entry
    const plain = buildContextMenu({ type: 'table', tableId: orders.id, columnId: orders.columns[0].id }, env);
    expect(ids(plain)).not.toContain('edit-type');
  });
});

describe('connection menu', () => {
  it('turns a foreign key into a data flow', () => {
    const d = sampleDiagram();
    const fk = d.relationships.find((r) => r.kind === 'fk')!;
    const { env, actions } = makeEnv(d);
    const items = buildContextMenu({ type: 'relationship', relationshipId: fk.id }, env);
    expect(action(items, 'convert').label).toBe('Turn into a data flow');
    action(items, 'convert').run();
    expect(actions.updateRelationship).toHaveBeenCalledWith(fk.id, { kind: 'flow' });
  });

  it('fills in column pairs when a data flow becomes a foreign key', () => {
    const d = sampleDiagram();
    const flow = d.relationships.find((r) => r.kind === 'flow')!;
    flow.sourceColumnIds = [];
    flow.targetColumnIds = [];
    const src = d.tables.find((t) => t.id === flow.sourceTableId)!;
    const tgt = d.tables.find((t) => t.id === flow.targetTableId)!;
    const { env, actions } = makeEnv(d);
    const items = buildContextMenu({ type: 'relationship', relationshipId: flow.id }, env);
    action(items, 'convert').run();
    expect(actions.updateRelationship).toHaveBeenCalledWith(flow.id, {
      kind: 'fk',
      sourceColumnIds: [src.columns[0].id],
      targetColumnIds: [(tgt.columns.find((c) => c.primaryKey) ?? tgt.columns[0]).id],
    });
  });

  it('cannot copy a query that is not there', () => {
    const d = sampleDiagram();
    const bare = d.relationships.find((r) => !r.query)!;
    const { env } = makeEnv(d);
    expect(action(buildContextMenu({ type: 'relationship', relationshipId: bare.id }, env), 'copy-query').disabled).toBe(true);
  });
});

describe('note menu', () => {
  it('offers note actions, and nothing at all for a target that is gone', () => {
    const d = sampleDiagram();
    const note = d.notes[0];
    const { env, actions } = makeEnv(d);
    const items = buildContextMenu({ type: 'note', noteId: note.id }, env);
    expect(ids(items)).toEqual(['edit', 'duplicate', 'copy-text', 'delete']);
    action(items, 'duplicate').run();
    expect(actions.duplicateNote).toHaveBeenCalledWith(note.id);

    const gone = buildContextMenu({ type: 'note', noteId: 'nope' }, env);
    expect(gone).toEqual([]);
    expect(hasActions(gone)).toBe(false);
  });
});
