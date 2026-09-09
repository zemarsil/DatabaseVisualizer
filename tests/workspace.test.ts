import { beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../src/shared/types';
import { parseDiagramFile, parseWorkspaceFile, serializeDiagram, serializeWorkspace } from '../src/lib/io';
import { createTable, emptyDiagram, emptyWorkspace, singleSheetWorkspace, uniqueSheetName } from '../src/lib/model';
import { sampleDiagram } from '../src/lib/sample';
import { currentWorkspace, sheetDiagram, useStore } from '../src/store/useStore';

function workspaceOf(...names: string[]): Workspace {
  const sheets = names.map((name, i) => ({ id: `sht_${i + 1}`, diagram: emptyDiagram('postgresql', name) }));
  return { version: 1, name: 'Bookshop', activeSheetId: sheets[0].id, sheets };
}

describe('workspace files', () => {
  it('writes one diagram as the plain diagram file it has always been', () => {
    const d = sampleDiagram();
    const text = serializeWorkspace(singleSheetWorkspace(d, 'sht_1'));
    expect(text).toBe(serializeDiagram(d));
    expect(JSON.parse(text).sheets).toBeUndefined();
    // ...and it is still readable as a bare diagram by anything that reads one.
    expect(parseDiagramFile(text).tables).toHaveLength(d.tables.length);
  });

  it('writes the envelope as soon as a sheet name cannot be inferred from the workspace name', () => {
    const one: Workspace = { version: 1, name: 'Bookshop', activeSheetId: 'sht_1', sheets: [{ id: 'sht_1', diagram: emptyDiagram('postgresql', 'Core') }] };
    const back = parseWorkspaceFile(serializeWorkspace(one));
    expect(back.name).toBe('Bookshop');
    expect(back.sheets[0].diagram.name).toBe('Core');
    expect(back.sheets[0].id).toBe('sht_1');
  });

  it('round-trips several diagrams, their order, their ids and which one was open', () => {
    const ws = workspaceOf('Core', 'Reporting', 'Warehouse');
    ws.activeSheetId = 'sht_2';
    ws.sheets[1].diagram.tables = [createTable({ name: 'daily_sales', position: { x: 0, y: 0 } })];
    const text = serializeWorkspace(ws);
    expect(JSON.parse(text).kind).toBe('workspace');

    const back = parseWorkspaceFile(text);
    expect(back.name).toBe('Bookshop');
    expect(back.activeSheetId).toBe('sht_2');
    expect(back.sheets.map((s) => s.id)).toEqual(['sht_1', 'sht_2', 'sht_3']);
    expect(back.sheets.map((s) => s.diagram.name)).toEqual(['Core', 'Reporting', 'Warehouse']);
    expect(back.sheets[1].diagram.tables.map((t) => t.name)).toEqual(['daily_sales']);
  });

  it('reads a file written before workspaces existed as a workspace of one', () => {
    const d = sampleDiagram();
    const ws = parseWorkspaceFile(serializeDiagram(d), { sheetId: 'dgm_old' });
    expect(ws.sheets).toHaveLength(1);
    // The old library id becomes the sheet id, so checkpoints taken against it still resolve.
    expect(ws.sheets[0].id).toBe('dgm_old');
    expect(ws.activeSheetId).toBe('dgm_old');
    expect(ws.name).toBe(d.name);
  });

  it('repairs duplicate ids and an activeSheet that points nowhere', () => {
    const text = JSON.stringify({
      version: 1,
      kind: 'workspace',
      name: 'Two',
      activeSheet: 'sht_missing',
      sheets: [
        { id: 'same', ...emptyDiagram('postgresql', 'A') },
        { id: 'same', ...emptyDiagram('postgresql', 'B') },
      ],
    });
    const ws = parseWorkspaceFile(text);
    expect(ws.sheets[0].id).toBe('same');
    expect(ws.sheets[1].id).not.toBe('same');
    expect(ws.activeSheetId).toBe(ws.sheets[0].id);
  });

  it('says which diagram of a workspace is unreadable', () => {
    const text = JSON.stringify({ version: 1, kind: 'workspace', name: 'Broken', sheets: [emptyDiagram(), { name: 'no tables here' }] });
    expect(() => parseWorkspaceFile(text)).toThrow(/Sheet 2 /);
  });

  it('names a new sheet clear of the ones already there', () => {
    expect(uniqueSheetName(['Core'], 'Core')).toBe('Core 2');
    expect(uniqueSheetName(['Core', 'Core 2'], 'Core')).toBe('Core 3');
    expect(uniqueSheetName(['Core'], 'Reporting')).toBe('Reporting');
  });
});

describe('sheets in the store', () => {
  beforeEach(() => {
    useStore.getState().setWorkspace(emptyWorkspace('postgresql', 'Bookshop'));
  });

  it('adds a diagram after the one you are on and switches to it', () => {
    const first = useStore.getState().activeSheetId;
    const id = useStore.getState().addSheet();
    const s = useStore.getState();
    expect(s.sheetIds).toEqual([first, id]);
    expect(s.activeSheetId).toBe(id);
    expect(s.diagram.tables).toHaveLength(0);
    expect(s.diagram.name).toBe('Untitled diagram');
    // A second one cannot take the same name.
    useStore.getState().addSheet();
    expect(useStore.getState().diagram.name).toBe('Untitled diagram 2');
    // The one you left is waiting, whole.
    expect(s.parked[first].diagram.name).toBe('Bookshop');
  });

  it('keeps each diagram, its selection and its undo history to itself', () => {
    const first = useStore.getState().activeSheetId;
    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'orders' });
    const orders = useStore.getState().diagram.tables[0].id;
    useStore.getState().selectTable(orders);

    const second = useStore.getState().addSheet({ name: 'Reporting' });
    // The new sheet starts clean: nothing selected, nothing to undo.
    expect(useStore.getState().selection.tableIds).toEqual([]);
    expect(useStore.getState().past).toHaveLength(0);
    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'daily_sales' });
    expect(useStore.getState().diagram.tables.map((t) => t.name)).toEqual(['daily_sales']);

    useStore.getState().switchSheet(first);
    const back = useStore.getState();
    expect(back.diagram.tables.map((t) => t.name)).toEqual(['orders']);
    expect(back.selection.tableIds).toEqual([orders]);
    // Undo on this sheet undoes this sheet's edit, and leaves the other alone.
    back.undo();
    expect(useStore.getState().diagram.tables).toHaveLength(0);
    expect(sheetDiagram(useStore.getState(), second)?.tables).toHaveLength(1);
  });

  it('duplicates a diagram into a tab of its own', () => {
    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'orders' });
    const source = useStore.getState().activeSheetId;
    const copy = useStore.getState().duplicateSheet(source);
    const s = useStore.getState();
    expect(s.sheetIds).toEqual([source, copy]);
    expect(s.activeSheetId).toBe(copy);
    expect(s.diagram.name).toBe('Bookshop copy');
    expect(s.diagram.tables.map((t) => t.name)).toEqual(['orders']);
    // Editing the copy leaves the original untouched.
    s.updateTable(s.diagram.tables[0].id, { name: 'orders_v2' });
    expect(sheetDiagram(useStore.getState(), source)?.tables[0].name).toBe('orders');
  });

  it('closes a tab onto its neighbour, and empties the last one instead of leaving nothing', () => {
    const first = useStore.getState().activeSheetId;
    const second = useStore.getState().addSheet({ name: 'Reporting' });
    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'daily_sales' });

    useStore.getState().closeSheet(second);
    expect(useStore.getState().sheetIds).toEqual([first]);
    expect(useStore.getState().activeSheetId).toBe(first);

    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'orders' });
    useStore.getState().closeSheet(first);
    const s = useStore.getState();
    expect(s.sheetIds).toEqual([first]);
    expect(s.diagram.tables).toHaveLength(0);
    // Emptying the last tab keeps the name the workspace is saved under.
    expect(s.workspaceName).toBe('Bookshop');
    expect(s.diagram.name).toBe('Bookshop');
  });

  it('reorders tabs and leaves the diagram you are on where it was', () => {
    const first = useStore.getState().activeSheetId;
    const second = useStore.getState().addSheet({ name: 'Reporting' });
    const third = useStore.getState().addSheet({ name: 'Warehouse' });
    useStore.getState().moveSheet(third, 0);
    expect(useStore.getState().sheetIds).toEqual([third, first, second]);
    expect(useStore.getState().activeSheetId).toBe(third);
  });

  it('ties the workspace name to the diagram while there is only one, and lets them part after that', () => {
    useStore.getState().setWorkspaceName('Bookshop 2026');
    expect(useStore.getState().diagram.name).toBe('Bookshop 2026');

    const second = useStore.getState().addSheet({ name: 'Reporting' });
    useStore.getState().setWorkspaceName('Bookshop, everything');
    expect(useStore.getState().workspaceName).toBe('Bookshop, everything');
    expect(useStore.getState().diagram.name).toBe('Reporting');
    useStore.getState().renameSheet(second, 'Reporting and returns');
    expect(useStore.getState().workspaceName).toBe('Bookshop, everything');
    expect(useStore.getState().diagram.name).toBe('Reporting and returns');
  });

  it('hands the whole workspace over to be saved, and takes one back', () => {
    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'orders' });
    useStore.getState().addSheet({ name: 'Reporting' });
    useStore.getState().addTable({ x: 0, y: 0 }, { name: 'daily_sales' });

    const text = serializeWorkspace(currentWorkspace(useStore.getState()));
    useStore.getState().setWorkspace(parseWorkspaceFile(text), { fileBacked: true });

    const s = useStore.getState();
    expect(s.sheetIds).toHaveLength(2);
    expect(s.diagram.name).toBe('Reporting');
    expect(s.diagram.tables.map((t) => t.name)).toEqual(['daily_sales']);
    expect(sheetDiagram(s, s.sheetIds[0])?.tables.map((t) => t.name)).toEqual(['orders']);
    expect(s.dirty).toBe(false);
    expect(s.fileBacked).toBe(true);
  });
});
