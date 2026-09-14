import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canContain, type Diagram } from '../src/shared/types';
import { createColumn, createProgram, createProgramStep, createTable, emptyDiagram, uniqueProgramName } from '../src/lib/model';
import {
  CODE_HEADER,
  CODE_PADDING,
  EMPTY_CODE_HEIGHT,
  EMPTY_CODE_WIDTH,
  canBeParentOf,
  codeBounds,
  codeContainerAtPoint,
  codeLinks,
  codeNodeRect,
  codePath,
  codeSubtreeIds,
  codeVisibility,
  defaultCodeOp,
  drawnCodeEdges,
  drawnTableLinks,
  findCodeByPath,
  nextCodePosition,
  wouldNestInItself,
} from '../src/lib/codemap';
import { describeProgram } from '../src/lib/programs';
import { generateProgramCode, hasStarter, programCodeFilename, resolveUnits } from '../src/lib/code/generate';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { lintDiagram } from '../src/lib/lint';
import { generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { buildJoinQuery, describeHop, findPath, reachableNodes } from '../src/lib/trace';
import { layoutDiagram } from '../src/lib/layout';
import { decodeClipboard, encodeClipboard } from '../src/lib/clipboard';
import { decodeDiagramFromUrl, encodeDiagramForUrl } from '../src/lib/share';
import { runWalkthroughCheck } from '../src/lib/walkthroughChecks';
import { EMPTY_VIEW, applyGoal, evaluateGoal, parseGoal } from '../src/lib/tour/goals';
import { useStore } from '../src/store/useStore';

/**
 * A checkout service, the case the code map exists for: a program holding two
 * files, one of them holding a class, and two functions — one that reads a
 * customer, writes an order and calls the other, which locks and updates a
 * stock row. Every arrow on the canvas is derived from these six nodes and
 * their steps; nothing else is stored.
 */
function checkout() {
  const d = emptyDiagram('postgresql', 'Checkout');
  const customers = createTable({
    name: 'customers',
    position: { x: 0, y: 0 },
    columns: [createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'email', type: 'TEXT', nullable: false })],
  });
  const orders = createTable({
    name: 'orders',
    position: { x: 0, y: 300 },
    columns: [
      createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }),
      createColumn({ name: 'customer_id', type: 'INTEGER', nullable: false }),
      createColumn({ name: 'total_cents', type: 'INTEGER', nullable: false }),
    ],
  });
  const stock = createTable({
    name: 'stock_levels',
    position: { x: 0, y: 600 },
    columns: [createColumn({ name: 'book_id', type: 'INTEGER', primaryKey: true, nullable: false }), createColumn({ name: 'on_hand', type: 'INTEGER', nullable: false })],
  });
  d.tables = [customers, orders, stock];

  const api = createProgram({ id: 'prg_api', name: 'api', role: 'service', position: { x: -900, y: -60 } });
  const ordersPy = createProgram({
    id: 'mod_orders',
    name: 'orders.py',
    kind: 'module',
    parentId: 'prg_api',
    position: { x: -870, y: -10 },
    steps: [createProgramStep({ op: 'import', codeId: 'mod_inventory' })],
  });
  const service = createProgram({ id: 'cls_service', name: 'OrderService', kind: 'class', parentId: 'mod_orders', position: { x: -850, y: 40 } });
  const placeOrder = createProgram({
    id: 'fn_place',
    name: 'place_order',
    kind: 'function',
    parentId: 'cls_service',
    position: { x: -820, y: 90 },
    steps: [
      createProgramStep({ op: 'read', tableId: customers.id, columnIds: [customers.columns[0].id], sql: 'SELECT id FROM customers WHERE email = %s' }),
      createProgramStep({ op: 'compute', note: 'total the cart' }),
      createProgramStep({ op: 'write', tableId: orders.id, columnIds: [orders.columns[1].id, orders.columns[2].id], sql: 'INSERT INTO orders (customer_id, total_cents) VALUES (%s, %s)' }),
      createProgramStep({ op: 'call', codeId: 'fn_reserve', note: 'once per line' }),
    ],
  });
  const inventoryPy = createProgram({ id: 'mod_inventory', name: 'inventory.py', kind: 'module', parentId: 'prg_api', position: { x: -870, y: 500 } });
  const reserveStock = createProgram({
    id: 'fn_reserve',
    name: 'reserve_stock',
    kind: 'function',
    parentId: 'mod_inventory',
    position: { x: -820, y: 560 },
    steps: [
      createProgramStep({ op: 'read', tableId: stock.id, columnIds: [stock.columns[1].id], sql: 'SELECT on_hand FROM stock_levels WHERE book_id = %s FOR UPDATE' }),
      createProgramStep({ op: 'write', tableId: stock.id, columnIds: [stock.columns[1].id] }),
    ],
  });
  d.programs = [api, ordersPy, service, placeOrder, inventoryPy, reserveStock];
  return { d, customers, orders, stock, api, ordersPy, service, placeOrder, inventoryPy, reserveStock };
}

const tableName = (d: Diagram, id: string) => d.tables.find((t) => t.id === id)?.name;
const within = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

describe('the code tree', () => {
  it('names a node by the containers above it, and finds it by that name', () => {
    const { d, placeOrder, ordersPy } = checkout();
    expect(codePath(d, placeOrder)).toBe('api/orders.py/OrderService/place_order');
    expect(findCodeByPath(d, 'api/orders.py/OrderService/place_order')).toBe(placeOrder);
    expect(findCodeByPath(d, 'API/Orders.py')).toBe(ordersPy);
  });

  it('accepts a bare name only while one node in the map carries it', () => {
    const { d, placeOrder, inventoryPy } = checkout();
    expect(findCodeByPath(d, 'place_order')).toBe(placeOrder);
    const twin = createProgram({ name: 'place_order', kind: 'function', parentId: inventoryPy.id });
    d.programs.push(twin);
    // Two place_orders: a bare name now says nothing, a path still does.
    expect(findCodeByPath(d, 'place_order')).toBeUndefined();
    expect(findCodeByPath(d, 'api/inventory.py/place_order')).toBe(twin);
  });

  it('knows which kinds can hold which', () => {
    const { d, placeOrder, service, ordersPy, reserveStock } = checkout();
    expect(canContain('program', 'module')).toBe(true);
    expect(canContain('class', 'class')).toBe(true);
    expect(canContain('class', 'module')).toBe(false);
    expect(canContain('function', 'function')).toBe(false);
    expect(canBeParentOf(d, placeOrder, service)).toBe(false);
    expect(canBeParentOf(d, ordersPy, reserveStock)).toBe(true);
  });

  it('refuses to put a container inside its own subtree', () => {
    const { d, ordersPy, placeOrder, inventoryPy, api } = checkout();
    expect(wouldNestInItself(d, ordersPy.id, placeOrder.id)).toBe(true);
    expect(wouldNestInItself(d, api.id, api.id)).toBe(true);
    expect(wouldNestInItself(d, ordersPy.id, inventoryPy.id)).toBe(false);
  });

  it('collects a container together with everything inside it', () => {
    const { d, ordersPy, service, placeOrder } = checkout();
    expect([...codeSubtreeIds(d, [ordersPy.id])].sort()).toEqual([ordersPy.id, service.id, placeOrder.id].sort());
    expect(codeSubtreeIds(d, [placeOrder.id])).toEqual([placeOrder.id]);
  });

  it('scopes unique names to siblings, so two classes may each have a save', () => {
    const { d, service, inventoryPy } = checkout();
    expect(uniqueProgramName(d, 'place_order', service.id)).toBe('place_order_2');
    expect(uniqueProgramName(d, 'place_order', inventoryPy.id)).toBe('place_order');
    expect(uniqueProgramName(d, 'api')).toBe('api_2');
  });

  it('describes a node by its kind and what it reaches', () => {
    const { d, api, placeOrder, reserveStock } = checkout();
    expect(describeProgram(d, api)).toBe('api, a service, holds 2 nodes.');
    expect(describeProgram(d, placeOrder)).toBe('place_order, a Python function, reads customers; writes orders; calls reserve_stock; 1 step of work outside the database.');
    expect(describeProgram(d, reserveStock)).toBe('reserve_stock, a Python function, reads and writes stock_levels.');
  });
});

describe('what the canvas draws', () => {
  it('draws one numbered arrow per step while everything is expanded', () => {
    const { d, ordersPy, inventoryPy, placeOrder, reserveStock } = checkout();
    expect(codeLinks(d).map((l) => [l.fromId, l.toId, l.op, l.step])).toEqual([
      [ordersPy.id, inventoryPy.id, 'import', 1],
      [placeOrder.id, reserveStock.id, 'call', 4],
    ]);
    expect(drawnCodeEdges(d).every((e) => e.direct && e.links.length === 1)).toBe(true);
    const tables = drawnTableLinks(d);
    expect(tables).toHaveLength(4);
    expect(tables.every((e) => e.direct)).toBe(true);
  });

  it('gathers every arrow onto a collapsed program and hides the ones inside it', () => {
    const { d, api, placeOrder } = checkout();
    api.collapsed = true;
    const vis = codeVisibility(d);
    expect(vis.standIn.get(placeOrder.id)).toBe(api.id);
    expect(vis.hidden.get(api.id)).toBe(5);
    expect(vis.drawn.map((p) => p.id)).toEqual([api.id]);
    // The import and the call both start and end inside the folded node.
    expect(drawnCodeEdges(d, vis)).toEqual([]);
    expect(drawnTableLinks(d, vis).map((e) => [e.nodeId, tableName(d, e.tableId), e.op, e.direct])).toEqual([
      [api.id, 'customers', 'read', false],
      [api.id, 'orders', 'write', false],
      [api.id, 'stock_levels', 'read', false],
      [api.id, 'stock_levels', 'write', false],
    ]);
  });

  it('lets the outermost folded container answer for a folded class inside it', () => {
    const { d, ordersPy, service, placeOrder, inventoryPy, reserveStock } = checkout();
    service.collapsed = true;
    ordersPy.collapsed = true;
    const vis = codeVisibility(d);
    expect(vis.standIn.get(placeOrder.id)).toBe(ordersPy.id);
    expect(vis.drawn.map((p) => p.id)).not.toContain(service.id);
    // The module's own import is still its own step; the call it gathered from
    // place_order is not, so it loses its number.
    expect(drawnCodeEdges(d, vis).map((e) => [e.fromId, e.toId, e.op, e.direct])).toEqual([
      [ordersPy.id, inventoryPy.id, 'import', true],
      [ordersPy.id, reserveStock.id, 'call', false],
    ]);
  });

  it('merges two calls out of a folded module into one arrow carrying both', () => {
    const { d, ordersPy, service, reserveStock } = checkout();
    d.programs.push(createProgram({ name: 'cancel_order', kind: 'function', parentId: service.id, steps: [createProgramStep({ op: 'call', codeId: reserveStock.id })] }));
    ordersPy.collapsed = true;
    const call = drawnCodeEdges(d).find((e) => e.op === 'call');
    expect(call?.fromId).toBe(ordersPy.id);
    expect(call?.links).toHaveLength(2);
  });

  it('sizes a container from what is inside it, one level at a time', () => {
    const { d, api, ordersPy, service, placeOrder } = checkout();
    const bounds = codeBounds(d);
    const inner = bounds[service.id];
    const mid = bounds[ordersPy.id];
    const outer = bounds[api.id];
    expect(inner.x).toBe(placeOrder.position.x - CODE_PADDING);
    expect(inner.y).toBe(placeOrder.position.y - CODE_PADDING - CODE_HEADER);
    expect(within(inner, mid)).toBe(true);
    expect(within(mid, outer)).toBe(true);
    // A function is a leaf: it has a box, never a region.
    expect(bounds[placeOrder.id]).toBeUndefined();
  });

  it('gives an empty container a region to drop the first member into', () => {
    const { d, api } = checkout();
    const empty = createProgram({ name: 'util.py', kind: 'module', parentId: api.id, position: { x: -870, y: 900 } });
    d.programs.push(empty);
    expect(codeBounds(d)[empty.id]).toEqual({ x: -870, y: 900, width: EMPTY_CODE_WIDTH, height: EMPTY_CODE_HEIGHT });
  });

  it('finds the innermost region under a point', () => {
    const { d, api, ordersPy, service, placeOrder } = checkout();
    const bounds = codeBounds(d);
    expect(codeContainerAtPoint(bounds, placeOrder.position)).toBe(service.id);
    expect(codeContainerAtPoint(bounds, { x: bounds[api.id].x + 5, y: bounds[api.id].y + 5 })).toBe(api.id);
    expect(codeContainerAtPoint(bounds, placeOrder.position, new Set([service.id]))).toBe(ordersPy.id);
    expect(codeContainerAtPoint(bounds, { x: 5000, y: 5000 })).toBeNull();
  });

  it('places a new member under the last one, or in the corner of an empty region', () => {
    const { d, api, inventoryPy, reserveStock } = checkout();
    const fallback = { x: 1, y: 1 };
    const under = nextCodePosition(d, inventoryPy.id, fallback);
    expect(under.x).toBe(reserveStock.position.x);
    expect(under.y).toBeGreaterThan(reserveStock.position.y);
    const empty = createProgram({ name: 'util.py', kind: 'module', parentId: api.id, position: { x: -870, y: 900 } });
    d.programs.push(empty);
    expect(nextCodePosition(d, empty.id, fallback)).toEqual({ x: -870 + CODE_PADDING, y: 900 + CODE_PADDING + CODE_HEADER });
    expect(nextCodePosition(d, undefined, fallback)).toEqual(fallback);
  });

  it('reads the step a drag should mean off what the two ends are', () => {
    const { service, ordersPy, inventoryPy, placeOrder, reserveStock, api } = checkout();
    expect(defaultCodeOp(service, service)).toBe('extends');
    expect(defaultCodeOp(ordersPy, inventoryPy)).toBe('import');
    expect(defaultCodeOp(api, placeOrder)).toBe('import');
    expect(defaultCodeOp(placeOrder, reserveStock)).toBe('call');
  });
});

describe('the file', () => {
  it('round-trips kinds, parents and collapsed state', () => {
    const { d, api } = checkout();
    api.collapsed = true;
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.programs).toEqual(d.programs);
  });

  it('loads a file written before code maps existed', () => {
    const { d } = checkout();
    // Such a file has programs with read, write and compute steps, and has
    // never heard of kinds, parents, folding or steps that name code.
    const raw = JSON.parse(serializeDiagram(d)) as { programs: Record<string, unknown>[] };
    for (const p of raw.programs) {
      delete p.kind;
      delete p.parentId;
      delete p.collapsed;
      p.steps = (p.steps as { op: string }[]).filter((s) => s.op === 'read' || s.op === 'write' || s.op === 'compute');
    }
    const back = parseDiagramFile(JSON.stringify(raw));
    expect(back.programs.map((p) => p.name)).toEqual(d.programs.map((p) => p.name));
    expect(back.programs.every((p) => p.kind === undefined && p.parentId === undefined)).toBe(true);
    expect(codeLinks(back)).toEqual([]);
    expect(drawnTableLinks(back)).toHaveLength(4);
  });

  it('reads a kind it has never heard of as a program, and keeps the rest', () => {
    const { d } = checkout();
    const raw = JSON.parse(serializeDiagram(d)) as { programs: Record<string, unknown>[] };
    raw.programs[3].kind = 'gadget';
    const back = parseDiagramFile(JSON.stringify(raw));
    expect(back.programs[3].kind).toBeUndefined();
    expect(back.programs[3].name).toBe('place_order');
    expect(back.programs[3].steps).toHaveLength(4);
  });

  it('drops a parent pointer that names nothing, or that would loop', () => {
    const { d } = checkout();
    const raw = JSON.parse(serializeDiagram(d)) as { programs: Record<string, unknown>[] };
    raw.programs[3].parentId = 'nope';
    // orders.py inside OrderService inside orders.py: the pointer that closes the loop goes.
    raw.programs[1].parentId = 'cls_service';
    const back = parseDiagramFile(JSON.stringify(raw));
    expect(back.programs[3].parentId).toBeUndefined();
    expect(back.programs[1].parentId).toBeUndefined();
    expect(back.programs[2].parentId).toBe('mod_orders');
  });

  it('keeps a call whose target has gone, draws nothing for it, and lets Problems remove it', () => {
    const { d, placeOrder, reserveStock } = checkout();
    d.programs = d.programs.filter((p) => p.id !== reserveStock.id);
    expect(placeOrder.steps).toHaveLength(4);
    expect(codeLinks(d).map((l) => l.op)).toEqual(['import']);
    const finding = lintDiagram(d).find((f) => f.rule === 'code-step-missing-target');
    expect(finding?.severity).toBe('error');
    expect(finding?.programId).toBe(placeOrder.id);
    // The step may hold the only copy of its code, so the fix is never bulk-applied.
    expect(finding?.fix?.safe).toBe(false);
    finding!.fix!.apply(d);
    expect(placeOrder.steps.map((s) => s.op)).toEqual(['read', 'compute', 'write']);
  });

  it('carries the whole map in a share link', async () => {
    const { d } = checkout();
    const back = await decodeDiagramFromUrl(await encodeDiagramForUrl(d));
    expect(back?.programs).toEqual(d.programs);
  });
});

describe('the SQL script', () => {
  it('keeps the code out of the DDL and carries it home by path', () => {
    const { d } = checkout();
    const script = generateSchema(d).script;
    const ddl = script.slice(0, script.indexOf('-- dbviz:connections'));
    expect(ddl).not.toContain('place_order');
    expect(script).toContain('"parent": "api/orders.py/OrderService"');
    expect(script).toContain('"target": "api/inventory.py/reserve_stock"');

    const back = importSql(script, 'postgresql');
    expect(back.warnings).toEqual([]);
    const byName = new Map(back.programs.map((p) => [p.name, p]));
    expect(byName.get('place_order')?.parentId).toBe(byName.get('OrderService')?.id);
    expect(byName.get('OrderService')?.parentId).toBe(byName.get('orders.py')?.id);
    expect(byName.get('place_order')?.steps[3].codeId).toBe(byName.get('reserve_stock')?.id);
    expect(byName.get('orders.py')?.steps[0].codeId).toBe(byName.get('inventory.py')?.id);
    expect(byName.get('place_order')?.steps[0].tableId).toBe(back.tables.find((t) => t.name === 'customers')?.id);
  });

  it('keeps a node whose container the script does not describe, and says so', () => {
    const { d } = checkout();
    const script = generateSchema(d).script.replace('"parent": "api/orders.py/OrderService"', '"parent": "api/nowhere"');
    const back = importSql(script, 'postgresql');
    expect(back.warnings.some((w) => w.includes('place_order was inside api/nowhere'))).toBe(true);
    expect(back.programs.find((p) => p.name === 'place_order')?.parentId).toBeUndefined();
  });

  it('keeps a step whose target the script does not describe, and says so', () => {
    const { d } = checkout();
    const script = generateSchema(d).script.replace('"target": "api/inventory.py/reserve_stock"', '"target": "api/inventory.py/gone"');
    const back = importSql(script, 'postgresql');
    expect(back.warnings.some((w) => w.includes('kept its code') && w.includes('api/inventory.py/gone'))).toBe(true);
    const step = back.programs.find((p) => p.name === 'place_order')?.steps[3];
    expect(step?.op).toBe('call');
    expect(step?.codeId).toBeUndefined();
    expect(step?.note).toBe('once per line');
  });
});

describe('Problems', () => {
  const rules = (d: Diagram, rule: string) => lintDiagram(d).filter((f) => f.rule === rule);

  it('objects to a container holding a kind it cannot, and moves it up a level', () => {
    const { d, inventoryPy, service, ordersPy } = checkout();
    inventoryPy.parentId = service.id;
    const [finding] = rules(d, 'code-cannot-contain');
    expect(finding.programId).toBe(inventoryPy.id);
    expect(finding.fix?.label).toBe('Move it up into orders.py');
    finding.fix!.apply(d);
    expect(inventoryPy.parentId).toBe(ordersPy.id);
    expect(rules(d, 'code-cannot-contain')).toEqual([]);
  });

  it('reports a circular import once', () => {
    const { d, inventoryPy, ordersPy } = checkout();
    inventoryPy.steps.push(createProgramStep({ op: 'import', codeId: ordersPy.id }));
    const found = rules(d, 'code-import-cycle');
    expect(found).toHaveLength(1);
    expect(found[0].message).toBe('orders.py imports inventory.py imports orders.py again: a circular import.');
  });

  it('points out a function nothing calls, but only once the map has calls in it', () => {
    const { d, placeOrder } = checkout();
    expect(rules(d, 'code-uncalled-function').map((f) => f.programId)).toEqual([placeOrder.id]);
    placeOrder.steps = placeOrder.steps.filter((s) => s.op !== 'call');
    // No call anywhere: every function is uncalled, which is not news.
    expect(rules(d, 'code-uncalled-function')).toEqual([]);
  });

  it('lets two classes each have a save, and objects when one class has two', () => {
    const { d, service, ordersPy } = checkout();
    const customer = createProgram({ name: 'Customer', kind: 'class', parentId: ordersPy.id });
    d.programs.push(customer, createProgram({ name: 'save', kind: 'function', parentId: service.id }), createProgram({ name: 'save', kind: 'function', parentId: customer.id }));
    expect(rules(d, 'duplicate-program-name')).toEqual([]);
    d.programs.push(createProgram({ name: 'save', kind: 'function', parentId: service.id }));
    expect(rules(d, 'duplicate-program-name')).toHaveLength(2);
  });

  it('accepts recursion and objects to a module importing itself', () => {
    const { d, placeOrder, ordersPy } = checkout();
    placeOrder.steps.push(createProgramStep({ op: 'call', codeId: placeOrder.id }));
    expect(rules(d, 'code-step-names-itself')).toEqual([]);
    ordersPy.steps.push(createProgramStep({ op: 'import', codeId: ordersPy.id }));
    expect(rules(d, 'code-step-names-itself').map((f) => f.programId)).toEqual([ordersPy.id]);
  });

  it('is quiet about a well-formed map apart from the entry point', () => {
    const { d } = checkout();
    const code = lintDiagram(d).filter((f) => f.programId);
    expect(code.map((f) => f.rule)).toEqual(['code-uncalled-function']);
  });
});

describe('Trace', () => {
  it('walks from a function to a table through the call', () => {
    const { d, placeOrder, reserveStock, stock } = checkout();
    const path = findPath(d, placeOrder.id, stock.id)!;
    expect(path.nodeIds).toEqual([placeOrder.id, reserveStock.id, stock.id]);
    expect(path.hops.map((h) => describeHop(d, h))).toEqual(['place_order calls reserve_stock (step 4)', 'reserve_stock reads stock_levels (step 1)']);
    // A hop through code is not something the database can join across.
    expect(buildJoinQuery(d, path)).toContain('-- This path runs through code, so there is no single query for it.');
  });

  it('reaches code from a table, and the next table through it', () => {
    const { d, customers, placeOrder, reserveStock, stock } = checkout();
    const hops = reachableNodes(d, customers.id);
    expect(hops.get(placeOrder.id)).toBe(1);
    expect(hops.get(reserveStock.id)).toBe(2);
    expect(hops.get(stock.id)).toBe(3);
  });
});

describe('Detangle', () => {
  it('parks the code beside the tables with members still inside their containers', () => {
    const { d, api, ordersPy, service } = checkout();
    const pos = layoutDiagram(d);
    for (const p of d.programs) if (pos[p.id]) p.position = pos[p.id];
    const vis = codeVisibility(d);
    const leaves = d.programs.filter((p) => !vis.expanded.includes(p));
    expect(leaves.every((p) => pos[p.id])).toBe(true);
    const bounds = codeBounds(d);
    expect(within(bounds[service.id], bounds[ordersPy.id])).toBe(true);
    expect(within(bounds[ordersPy.id], bounds[api.id])).toBe(true);
    // Left to right, the code block sits to the left of every table.
    const rightEdge = Math.max(...leaves.map((p) => codeNodeRect(p, vis).x + codeNodeRect(p, vis).width));
    expect(rightEdge).toBeLessThan(Math.min(...d.tables.map((t) => pos[t.id].x)));
  });
});

describe('copy and paste', () => {
  it('copies a container with everything inside it', () => {
    const { d, ordersPy } = checkout();
    const payload = decodeClipboard(encodeClipboard(d, [], [ordersPy.id]))!;
    expect(payload.programs.map((p) => p.name)).toEqual(['orders.py', 'OrderService', 'place_order']);
    expect(payload.tables).toEqual([]);
  });

  it('re-points pasted steps at the pasted tables and keeps the steps whose tables stayed behind', () => {
    const { d, customers, ordersPy } = checkout();
    const payload = decodeClipboard(encodeClipboard(d, [customers.id], [ordersPy.id]))!;
    useStore.setState({ diagram: emptyDiagram('postgresql', 'Elsewhere'), past: [], future: [] });
    useStore.getState().pasteTables(payload.tables, payload.relationships, payload.customTypes, { x: 0, y: 0 }, payload.extensions, payload.programs);
    const target = useStore.getState().diagram;
    const pasted = new Map(target.programs.map((p) => [p.name, p]));
    const pastedCustomers = target.tables.find((t) => t.name === 'customers')!;
    const fn = pasted.get('place_order')!;
    expect(fn.parentId).toBe(pasted.get('OrderService')!.id);
    expect(pasted.get('orders.py')!.parentId).toBeUndefined();
    // customers came along: the read follows it, column and all.
    expect(fn.steps[0].tableId).toBe(pastedCustomers.id);
    expect(fn.steps[0].columnIds).toEqual([pastedCustomers.columns[0].id]);
    // orders and reserve_stock did not: the steps stay, with their text, pointing at nothing.
    expect(fn.steps[2].op).toBe('write');
    expect(fn.steps[2].tableId).toBeUndefined();
    expect(fn.steps[2].sql).toContain('INSERT INTO orders');
    expect(fn.steps[3].op).toBe('call');
    expect(fn.steps[3].codeId).toBeUndefined();
    expect(fn.steps[3].note).toBe('once per line');
  });
});

describe('the walkthrough vocabulary', () => {
  it('checks a code node by kind and path', () => {
    const { d } = checkout();
    expect(runWalkthroughCheck('code | function api/orders.py/OrderService/place_order', d).ok).toBe(true);
    const wrongKind = runWalkthroughCheck('code | module place_order', d);
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.detail).toBe('place_order is a function, not a module.');
    expect(runWalkthroughCheck('calls | place_order -> reserve_stock', d).ok).toBe(true);
    expect(runWalkthroughCheck('imports | orders.py -> inventory.py', d).ok).toBe(true);
    expect(runWalkthroughCheck('reads table | reserve_stock -> customers', d).detail).toBe('reserve_stock has no read step on customers yet.');
    expect(runWalkthroughCheck('trace | place_order -> stock_levels', d).detail).toBe('Trace finds place_order → stock_levels in 2 hops.');
  });

  it('builds a map from the outside in when a step is done for you', () => {
    const d = emptyDiagram('postgresql', 'Fresh');
    const ctx = { diagram: d, view: EMPTY_VIEW };
    const done = (raw: string) => applyGoal(parseGoal(raw), d, ctx);
    expect(done('code | program api')).toBe(true);
    expect(done('code | module api/orders.py')).toBe(true);
    expect(done('code | function api/orders.py/place_order')).toBe(true);
    // The container has to exist first; a path into nowhere builds nothing.
    expect(done('code | function api/nowhere/x')).toBe(false);
    expect(done('code | program api')).toBe(false);
    expect(done('code | module api/inventory.py')).toBe(true);
    expect(done('imports | orders.py -> inventory.py')).toBe(true);
    expect(done('imports | orders.py -> inventory.py')).toBe(false);
    expect(done('code collapsed | api : on')).toBe(true);
    const fn = findCodeByPath(d, 'api/orders.py/place_order')!;
    expect(fn.kind).toBe('function');
    expect(fn.parentId).toBe(findCodeByPath(d, 'api/orders.py')!.id);
    for (const raw of ['code | module api/orders.py', 'imports | orders.py -> inventory.py', 'code collapsed | api : on']) {
      expect(evaluateGoal(parseGoal(raw), ctx).ok, raw).toBe(true);
    }
  });
});

describe('the validator script', () => {
  it('catches a parent of the wrong kind and a call to nothing before the file is opened', () => {
    const { d, inventoryPy, service, placeOrder } = checkout();
    inventoryPy.parentId = service.id;
    placeOrder.steps[3].codeId = 'fn_gone';
    const file = join(mkdtempSync(join(tmpdir(), 'dbviz-')), 'broken.dbviz.json');
    writeFileSync(file, serializeDiagram(d));
    let out = '';
    try {
      execFileSync('node', ['scripts/validate-dbviz.mjs', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? '';
    }
    expect(out).toContain('ERROR  programs[4] "inventory.py" is a module inside a class');
    expect(out).toContain('ERROR  programs[3] "place_order" step 4: codeId "fn_gone" is not a code node in this file.');
  });
});

describe('the starter a container writes', () => {
  it('writes the module as the file it stands for: its class, and the function inside that', () => {
    const { d, ordersPy } = checkout();
    const code = generateProgramCode(d, ordersPy);
    expect(code).toContain('class OrderService:');
    // The method is indented inside the class, not left beside it.
    expect(code).toContain('    def place_order(self, conn):');
    expect(code.indexOf('class OrderService:')).toBeLessThan(code.indexOf('def place_order'));
    // And the header says so, rather than leaving the reader to notice.
    expect(code).toContain('OrderService and place_order sit inside it on the diagram');
  });

  it('stops at the file boundary: a sibling module is imported, never inlined', () => {
    const { d, ordersPy, api } = checkout();
    const code = generateProgramCode(d, ordersPy);
    expect(code).toContain('import inventory');
    expect(code).not.toContain('def reserve_stock');
    // A program holds modules, and a module is a file of its own.
    const program = generateProgramCode(d, api);
    expect(program).not.toContain('class OrderService');
    expect(program).toContain('orders.py and inventory.py are modules of their own');
  });

  it('turns an import step into an import line rather than a stub that raises', () => {
    const { d, ordersPy } = checkout();
    const code = generateProgramCode(d, ordersPy);
    expect(code).not.toContain('def import_inventory_py');
    expect(code).not.toContain('import_inventory_py(row)');
    // Nothing is left for main to do, so there is no empty main under the class.
    expect(code).not.toContain('def main()');
  });

  it('gives a class with no steps of its own the class it holds', () => {
    const { d, service } = checkout();
    expect(service.steps).toHaveLength(0);
    expect(hasStarter(d, service)).toBe(true);
    const code = generateProgramCode(d, service);
    expect(code).toContain('class OrderService:');
    expect(code).toContain('def place_order(self, conn):');
    // A class is a definition, not a script: no main, and no entry point.
    expect(code).not.toContain('if __name__ == "__main__":');
  });

  it('leaves a leaf alone: a node with neither steps nor members has no starter', () => {
    const { d, service } = checkout();
    const empty = createProgram({ name: 'nothing_yet', kind: 'function', parentId: service.id });
    d.programs.push(empty);
    expect(hasStarter(d, empty)).toBe(false);
  });

  it('keeps one namespace for the file, so two functions cannot collide', () => {
    const { d, ordersPy, service } = checkout();
    const twin = createProgram({
      name: 'quote_order',
      kind: 'function',
      parentId: service.id,
      steps: [
        createProgramStep({ op: 'read', tableId: d.tables[0].id, sql: 'SELECT id FROM customers WHERE email = %s' }),
        createProgramStep({ op: 'compute', note: 'price it' }),
      ],
    });
    d.programs.push(twin);
    const code = generateProgramCode(d, ordersPy);
    // Both read customers and both compute at step 2; each keeps its own name.
    expect(code).toContain('PLACE_ORDER_READ_CUSTOMERS');
    expect(code).toContain('QUOTE_ORDER_READ_CUSTOMERS');
    expect(code).toContain('def place_order_compute_2(row):');
    expect(code).toContain('def quote_order_compute_2(row):');
    const units = resolveUnits(d, ordersPy);
    const slugs = units.members.flatMap((u) => [u, ...u.members]).flatMap((u) => u.steps.map((s) => s.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses the signature the node declares, and hands it the connection when it names one', () => {
    const { d, inventoryPy, reserveStock, placeOrder } = checkout();
    reserveStock.entrypoint = 'def reserve_stock(conn, book_id, quantity) -> None';
    const code = generateProgramCode(d, inventoryPy);
    expect(code).toContain('def reserve_stock(conn, book_id, quantity) -> None:');
    // It was handed a connection, so it does not open one of its own.
    expect(code).toContain('with conn.cursor() as cur:');
    expect(code).not.toContain('with psycopg.connect(DSN)');
    // A signature written in another language is not pasted into this one: it
    // is quoted in the comment and a Java one is synthesised beside it.
    placeOrder.entrypoint = 'def place_order(self, email, cart) -> int';
    const java = generateProgramCode(d, { ...d.programs[1], language: 'java' });
    expect(java.split('\n').some((l) => l.trim().startsWith('def '))).toBe(false);
    expect(java).toContain('static void placeOrder(Connection conn) throws Exception {');
  });

  it('hands a stub a row only where there is one: inside the loop, never before it', () => {
    const { d, ordersPy, service } = checkout();
    const early = createProgram({
      name: 'warm_cache',
      kind: 'function',
      parentId: service.id,
      steps: [createProgramStep({ op: 'compute', note: 'fill the price cache' })],
    });
    d.programs.push(early);
    const code = generateProgramCode(d, ordersPy);
    expect(code).toContain('def compute_1():');
    expect(code).toContain('result_1 = compute_1()');
  });

  it('nests the members in every language that has somewhere to nest them', () => {
    const { d, ordersPy } = checkout();
    const rust = generateProgramCode(d, { ...ordersPy, language: 'rust' });
    expect(rust).toContain('pub struct OrderService;');
    expect(rust).toContain('impl OrderService {');
    expect(rust).toContain('    pub async fn place_order(&self)');
    const go = generateProgramCode(d, { ...ordersPy, language: 'go' });
    expect(go).toContain('type OrderService struct{}');
    expect(go).toContain('func (o *OrderService) placeOrder(db *sql.DB) error {');
    const java = generateProgramCode(d, { ...ordersPy, language: 'java' });
    expect(java).toContain('public class Orders {');
    expect(java).toContain('    static class OrderService {');
    const ts = generateProgramCode(d, { ...ordersPy, language: 'typescript' });
    expect(ts).toContain('class OrderService {');
    expect(ts).toContain('  async placeOrder(db: Db): Promise<void> {');
    // C has nowhere to nest, so it flattens and says where each came from —
    // and is handed the connection, since it is not the one that opened it.
    const c = generateProgramCode(d, { ...ordersPy, language: 'c' });
    expect(c).toContain('static int order_service_place_order(PGconn *conn) {');
    // And a language with no template still walks the tree in comments.
    const csharp = generateProgramCode(d, { ...ordersPy, language: 'csharp' });
    expect(csharp).toContain('// OrderService/place_order —');
    expect(csharp.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))).toEqual([]);
  });

  it('names the file after the node, without doubling the extension', () => {
    const { d, ordersPy, api } = checkout();
    expect(programCodeFilename(ordersPy)).toBe('orders.py');
    expect(programCodeFilename(api)).toBe('api.py');
    expect(generateProgramCode(d, { ...ordersPy, language: 'java' })).toContain('public class Orders {');
  });

  it('drops an import of something this file already holds, and renames one that clashes', () => {
    const { d, ordersPy, service, inventoryPy } = checkout();
    // orders.py importing its own class: it is right here, so there is nothing to import.
    ordersPy.steps.push(createProgramStep({ op: 'import', codeId: service.id }));
    const code = generateProgramCode(d, ordersPy);
    expect(code).toContain('import inventory');
    expect(code).not.toContain('import order_service');
    // A class named for the module it imports would shadow the import.
    d.programs.push(createProgram({ name: 'inventory', kind: 'class', parentId: ordersPy.id }));
    expect(generateProgramCode(d, ordersPy)).toContain('import inventory as inventory_2');
    const js = generateProgramCode(d, { ...ordersPy, language: 'javascript' });
    expect(js).toContain("import * as inventory2 from './inventory.js';");
    expect(inventoryPy.name).toBe('inventory.py');
  });

  it('survives a parent pointer that loops back on itself', () => {
    const { d, ordersPy, service } = checkout();
    ordersPy.parentId = service.id;
    expect(() => generateProgramCode(d, ordersPy)).not.toThrow();
  });
});
