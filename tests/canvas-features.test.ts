import { describe, expect, it, vi } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { importSql } from '../src/lib/sql/import';
import { createColumn, createTable, emptyDiagram } from '../src/lib/model';
import { alignTables, distributeTables, groupBySchema, snapAllToGrid } from '../src/lib/canvasOps';
import { estimateNodeSize, placementSizes } from '../src/lib/geometry';
import { layoutDiagram } from '../src/lib/layout';
import { effectiveDisplay, nextDisplay, visibleColumns } from '../src/lib/visibleColumns';
import { classifyPastedText, decodeClipboard, encodeClipboard } from '../src/lib/clipboard';
import { buildContextMenu, createGroupsBySchema, type MenuAction, type MenuEnv, type MenuNode } from '../src/components/ui/contextMenuItems';
import { sampleDiagram } from '../src/lib/sample';
import type { Store } from '../src/store/useStore';
import { useUi } from '../src/store/useUi';

function shop(): Diagram {
  const d = emptyDiagram('postgresql', 'Shop');
  const r = importSql(
    `CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT UNIQUE, name TEXT);
     CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total NUMERIC, note TEXT);
     CREATE TABLE sales.regions (id SERIAL PRIMARY KEY);
     CREATE TABLE sales.reps (id SERIAL PRIMARY KEY, region_id INTEGER REFERENCES sales.regions(id));`,
    'postgresql',
  );
  d.tables = r.tables;
  d.relationships = r.relationships;
  return d;
}

const box = (id: string, x: number, y: number, w = 100, h = 50) => {
  const t = createTable({ name: id, position: { x, y } });
  t.id = id;
  return { t, size: { width: w, height: h } };
};

describe('canvasOps', () => {
  const a = box('a', 0, 0);
  const b = box('b', 300, 80, 200, 100);
  const c = box('c', 900, 20, 100, 60);
  const tables = [a.t, b.t, c.t];
  const sizes = { a: a.size, b: b.size, c: c.size };

  it('aligns edges and centres', () => {
    expect(alignTables(tables, sizes, 'left').map((m) => m.position.x)).toEqual([0, 0, 0]);
    expect(alignTables(tables, sizes, 'right').map((m) => m.position.x)).toEqual([900, 800, 900]);
    expect(alignTables(tables, sizes, 'top').map((m) => m.position.y)).toEqual([0, 0, 0]);
    expect(alignTables(tables, sizes, 'bottom').map((m) => m.position.y)).toEqual([130, 80, 120]);
    expect(alignTables(tables, sizes, 'centerX').map((m) => m.position.x)).toEqual([450, 400, 450]);
    expect(alignTables([a.t], sizes, 'left')).toEqual([]);
  });

  it('distributes with equal gaps and keeps the outer tables in place', () => {
    const moves = distributeTables(tables, sizes, 'x');
    const byId = Object.fromEntries(moves.map((m) => [m.id, m.position.x]));
    expect(byId.a).toBe(0);
    expect(byId.c).toBe(900);
    // gaps: total span 1000, widths 400 -> 300 each side
    expect(byId.b).toBe(400);
    expect(distributeTables([a.t, b.t], sizes, 'x')).toEqual([]);
  });

  it('snaps to the grid only when something moves', () => {
    const t = box('t', 33, 47).t;
    expect(snapAllToGrid([t])).toEqual([{ id: 't', position: { x: 40, y: 40 } }]);
    expect(snapAllToGrid([box('u', 40, 60).t])).toEqual([]);
  });

  it('groups ungrouped tables by schema', () => {
    const d = shop();
    const groups = groupBySchema(d);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('sales');
    expect(groups[0].tableIds).toHaveLength(2);
  });
});

describe('visibleColumns', () => {
  it('follows the collapse mode and the zoom level of detail', () => {
    const d = shop();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    const fks = new Set(d.relationships.filter((r) => r.sourceTableId === orders.id).flatMap((r) => r.sourceColumnIds));
    expect(visibleColumns(orders, 'full', fks)).toHaveLength(4);
    expect(visibleColumns(orders, 'keys', fks).map((c) => c.name)).toEqual(['id', 'customer_id']);
    expect(visibleColumns(orders, 'header', fks)).toEqual([]);
    expect(effectiveDisplay({ collapsed: 'keys' }, false)).toBe('keys');
    expect(effectiveDisplay({ collapsed: undefined }, false)).toBe('full');
    expect(effectiveDisplay({ collapsed: undefined }, true)).toBe('header');
    expect(nextDisplay(undefined)).toBe('keys');
    expect(nextDisplay('keys')).toBe('header');
    expect(nextDisplay('header')).toBeUndefined();
  });
});

describe('placementSizes', () => {
  /** A hub with four eight-column children, so one rank of the layout holds a stack of tall tables. */
  function hubAndSpokes(): Diagram {
    const d = emptyDiagram('postgresql', 'Hub');
    const spokes = [1, 2, 3, 4]
      .map((n) => `CREATE TABLE spoke${n} (id SERIAL PRIMARY KEY, hub_id INTEGER REFERENCES hub(id), a TEXT, b TEXT, c TEXT, d TEXT, e TEXT, f TEXT);`)
      .join('\n');
    const r = importSql(`CREATE TABLE hub (id SERIAL PRIMARY KEY);\n${spokes}`, 'postgresql');
    d.tables = r.tables;
    d.relationships = r.relationships;
    return d;
  }

  /** How many pairs of tables would overlap once every table is drawn at its own display mode again. */
  function overlaps(d: Diagram, positions: Record<string, { x: number; y: number }>): number {
    const sizes = placementSizes(d, undefined, false);
    const rects = d.tables.map((t) => ({ ...positions[t.id], ...sizes[t.id] }));
    let n = 0;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) n++;
      }
    }
    return n;
  }

  it('ignores the measurements taken while the zoom has the tables collapsed', () => {
    const d = hubAndSpokes();
    // What the canvas measures below the level-of-detail zoom: every table a bare header.
    const collapsed = Object.fromEntries(d.tables.map((t) => [t.id, { width: 240, height: 82 }]));
    expect(placementSizes(d, collapsed, true)).toEqual(placementSizes(d, undefined, false));
    expect(placementSizes(d, collapsed, false)).toEqual(collapsed);
  });

  it('leaves a detangle room for the columns the zoom is hiding', () => {
    const d = hubAndSpokes();
    const collapsed = Object.fromEntries(d.tables.map((t) => [t.id, { width: 240, height: 82 }]));
    // Laying out from the collapsed sizes is the bug: the tables are packed for
    // headers, so they overlap the moment zooming back in restores the columns.
    expect(overlaps(d, layoutDiagram(d, { direction: 'LR', sizes: collapsed }))).toBeGreaterThan(0);
    expect(overlaps(d, layoutDiagram(d, { direction: 'LR', sizes: placementSizes(d, collapsed, true) }))).toBe(0);
  });

  it('still honours a collapse mode the table itself is in, which the zoom does not own', () => {
    const d = hubAndSpokes();
    const spoke = d.tables.find((t) => t.name === 'spoke1')!;
    spoke.collapsed = 'header';
    const sizes = placementSizes(d, undefined, true);
    expect(sizes[spoke.id]).toEqual(estimateNodeSize([]));
    expect(sizes[spoke.id].height).toBeLessThan(sizes[d.tables.find((t) => t.name === 'spoke2')!.id].height);
  });
});

describe('clipboard', () => {
  it('round-trips tables with only the relationships inside the copied set', () => {
    const d = shop();
    const customers = d.tables.find((t) => t.name === 'customers')!;
    const orders = d.tables.find((t) => t.name === 'orders')!;
    const regions = d.tables.find((t) => t.name === 'regions')!;
    const text = encodeClipboard(d, [customers.id, orders.id, regions.id]);
    const payload = decodeClipboard(text)!;
    expect(payload.tables.map((t) => t.name).sort()).toEqual(['customers', 'orders', 'regions']);
    expect(payload.relationships).toHaveLength(1); // orders -> customers; reps -> regions is outside
    expect(classifyPastedText(text)).toBe('clipboard');
    expect(classifyPastedText('CREATE TABLE x (id INT);')).toBe('sql');
    expect(classifyPastedText(JSON.stringify({ tables: [] }))).toBe('diagram');
    expect(classifyPastedText('hello')).toBe('unknown');
    expect(decodeClipboard('{"nope":1}')).toBeNull();
  });
});

describe('context menu additions', () => {
  function env(diagram: Diagram, over: Partial<Store> = {}) {
    const store = {
      diagram,
      past: [],
      future: [],
      nodeSizes: {},
      placementSizes: () => placementSizes(diagram, {}, false),
      selection: { tableIds: [], noteIds: [], programIds: [], relationshipId: null, groupId: null },
      trace: { fromId: null, toId: null, result: null, searched: false, picking: false },
      addTable: vi.fn(),
      addNote: vi.fn(),
      setTableDisplay: vi.fn(),
      openDrawer: vi.fn(),
      setSelection: vi.fn(),
      beginDrag: vi.fn(),
      moveItems: vi.fn(),
      endDrag: vi.fn(),
      mutate: vi.fn((fn: (d: Diagram) => void) => fn(diagram)),
      toast: vi.fn(),
      requestFitView: vi.fn(),
      applyLayout: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      focusTable: vi.fn(),
      colorElements: vi.fn(),
      clearSelection: vi.fn(),
      setTracePicking: vi.fn(),
      setTraceEndpoints: vi.fn(),
      runTrace: vi.fn(),
      ...over,
    } as unknown as Store;
    const e: MenuEnv = { store, copy: vi.fn(), renameTable: vi.fn(), remove: vi.fn(), removeGroup: vi.fn(), pasteAt: vi.fn() };
    return { store, env: e };
  }
  const ids = (items: MenuNode[]) => items.filter((i) => i.kind === 'action').map((i) => i.id);
  const action = (items: MenuNode[], id: string) => items.find((i): i is MenuAction => i.kind === 'action' && i.id === id)!;

  it('offers views, paste, group-by-schema and canvas toggles on the background', () => {
    const d = shop();
    const { store, env: e } = env(d);
    const items = buildContextMenu({ type: 'pane', flowPosition: { x: 200, y: 100 } }, e);
    expect(ids(items)).toEqual(expect.arrayContaining(['add-view', 'paste', 'group-by-schema', 'snap', 'cardinality']));
    action(items, 'add-view').run();
    expect(store.addTable).toHaveBeenCalledWith({ x: 80, y: 80 }, { kind: 'view' });
    action(items, 'paste').run();
    expect(e.pasteAt).toHaveBeenCalledWith({ x: 200, y: 100 });
    expect(action(items, 'group-by-schema').disabled).toBe(false);
    expect(createGroupsBySchema(store)).toBe(1);
    expect(d.groups).toHaveLength(1);
    expect(d.tables.filter((t) => t.groupId === d.groups[0].id)).toHaveLength(2);
    const before = useUi.getState().snapToGrid;
    action(items, 'snap').run();
    expect(useUi.getState().snapToGrid).toBe(!before);
    useUi.getState().setSnapToGrid(before);
  });

  it('adds collapse modes, focus and clipboard rows to a table', () => {
    const d = sampleDiagram();
    const table = d.tables[0];
    const { store, env: e } = env(d);
    const items = buildContextMenu({ type: 'table', tableId: table.id }, e);
    expect(ids(items)).toEqual(expect.arrayContaining(['rename-inline', 'copy', 'cut', 'show-sql', 'show-full', 'show-keys', 'show-header', 'focus', 'zoom']));
    expect(action(items, 'show-full').checked).toBe(true);
    action(items, 'show-keys').run();
    expect(store.setTableDisplay).toHaveBeenCalledWith([table.id], 'keys');
    action(items, 'focus').run();
    expect(useUi.getState().focus).toEqual({ tableId: table.id, hops: 1 });
    const again = buildContextMenu({ type: 'table', tableId: table.id }, e);
    expect(ids(again)).toContain('unfocus');
    action(again, 'unfocus').run();
    expect(useUi.getState().focus).toBeNull();
  });

  it('arranges a multi-selection in one undo step', () => {
    const d = shop();
    const three = d.tables.slice(0, 3).map((t) => t.id);
    const { store, env: e } = env(d, { selection: { tableIds: three, noteIds: [], programIds: [], relationshipId: null, groupId: null } } as Partial<Store>);
    const items = buildContextMenu({ type: 'selection' }, e);
    expect(ids(items)).toEqual(expect.arrayContaining(['align-left', 'distribute-x', 'show-keys', 'copy', 'cut']));
    action(items, 'align-left').run();
    expect(store.beginDrag).toHaveBeenCalledTimes(1);
    expect(store.moveItems).toHaveBeenCalledTimes(1);
    expect(store.endDrag).toHaveBeenCalledTimes(1);
  });

  it('renders a view with a view-specific SQL label', () => {
    const d = shop();
    const v = createTable({ name: 'v', kind: 'view', viewSql: 'SELECT 1' });
    v.columns.push(createColumn({ name: 'x' }));
    d.tables.push(v);
    const { env: e } = env(d);
    const items = buildContextMenu({ type: 'table', tableId: v.id }, e);
    expect(action(items, 'copy-sql').label).toBe('CREATE VIEW');
  });
});
