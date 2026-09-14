import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagram, Program } from '@shared/types';
import { codePath } from '@/lib/codemap';
import { parseDiagramFile } from '@/lib/io';
import { lintDiagram } from '@/lib/lint';

/**
 * The Python scanner, against a service written to be scanned.
 *
 * tests/fixtures/bookshop_api is the checkout service walkthrough 16 draws by
 * hand, as code: the same two files, the same class, the same round trip. So
 * the interesting assertion is not that the scanner produces *a* map, it is
 * that it produces the one a person drew from the same program — and that what
 * it writes is a file the app loads, the linter passes and the validator
 * accepts.
 */

const SOURCE = 'tests/fixtures/bookshop_api';
const SCHEMA = 'docs/walkthroughs/diagrams/16-map-the-code-that-talks-to-it.dbviz.json';

const python = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return 'python3';
  } catch {
    return null;
  }
})();

const out = mkdtempSync(join(tmpdir(), 'dbviz-scan-'));
let serial = 0;

function scan(...args: string[]): { diagram: Diagram; file: string; report: string } {
  const file = join(out, `scan-${++serial}.dbviz.json`);
  // The diagram goes where it was asked to go; what the scan could not work
  // out goes to stderr, which is the half these tests check as closely.
  const run = spawnSync(python as string, ['scripts/scan_python.py', SOURCE, '-o', file, ...args], {
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`the scan failed (${run.status}): ${run.stderr}`);
  return { diagram: parseDiagramFile(readFileSync(file, 'utf8')), file, report: run.stderr };
}

/** A node by the path the format names it with, which is how the docs name it too. */
function at(d: Diagram, path: string): Program {
  const found = d.programs.find((p) => codePath(d, p) === path);
  if (!found) throw new Error(`no code node at ${path}. The map holds: ${d.programs.map((p) => codePath(d, p)).join(', ')}`);
  return found;
}

/** A node's steps as "op target [columns]", which is what a step means on the canvas. */
function steps(d: Diagram, path: string): string[] {
  return at(d, path).steps.map((s) => {
    const table = d.tables.find((t) => t.id === s.tableId);
    const code = d.programs.find((p) => p.id === s.codeId);
    const columns = s.columnIds.map((id) => table?.columns.find((c) => c.id === id)?.name ?? `?${id}`);
    if (s.op === 'read' || s.op === 'write') return `${s.op} ${table?.name ?? `?${s.tableId}`} [${columns.join(',')}]`;
    return `${s.op} ${code ? codePath(d, code) : `?${s.codeId}`}`;
  });
}

describe.skipIf(!python)('scripts/scan_python.py', () => {
  const mapped = scan('--into', SCHEMA);

  it('draws the program, its files, its classes and the functions that reach the database', () => {
    const paths = mapped.diagram.programs.map((p) => codePath(mapped.diagram, p));
    expect(paths).toEqual([
      'bookshop_api',
      'bookshop_api/inventory.py',
      'bookshop_api/inventory.py/reserve_stock',
      'bookshop_api/inventory.py/warehouse_stock',
      'bookshop_api/inventory.py/audit',
      'bookshop_api/main.py',
      'bookshop_api/main.py/place_order_route',
      'bookshop_api/main.py/stock_route',
      'bookshop_api/orders.py',
      'bookshop_api/orders.py/OrderService',
      'bookshop_api/orders.py/OrderService/place_order',
      'bookshop_api/orders.py/OrderService/history',
      'bookshop_api/jobs',
      'bookshop_api/jobs/rollup.py',
      'bookshop_api/jobs/rollup.py/RollupJob',
      'bookshop_api/jobs/rollup.py/RollupJob/run',
      'bookshop_api/jobs/rollup.py/RollupJob/refresh_totals',
    ]);
    const kinds = ['bookshop_api', 'bookshop_api/orders.py', 'bookshop_api/orders.py/OrderService', 'bookshop_api/orders.py/OrderService/place_order']
      .map((p) => at(mapped.diagram, p).kind ?? 'program');
    expect(kinds).toEqual(['program', 'module', 'class', 'function']);
  });

  it('reads the round trip off the queries, in the order the code runs them', () => {
    expect(steps(mapped.diagram, 'bookshop_api/orders.py/OrderService/place_order')).toEqual([
      'read customers [id,email]',
      'write orders [customer_id,status,total_cents]',
      'write order_items [order_id,book_id,quantity,unit_price_cents]',
      'call bookshop_api/inventory.py/reserve_stock',
    ]);
  });

  it('gives a step the statement that made it, as it was written', () => {
    const [read] = at(mapped.diagram, 'bookshop_api/orders.py/OrderService/place_order').steps;
    expect(read.sql).toBe('SELECT id FROM customers WHERE email = %s');
    const insert = at(mapped.diagram, 'bookshop_api/orders.py/OrderService/place_order').steps[2];
    expect(insert.sql).toBe(
      'INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents)\nVALUES (%s, %s, %s, %s)',
    );
  });

  it('follows a query parked in a constant to the function that actually runs it', () => {
    // inventory.py holds LOCK at the top of the file, but the file does not run
    // it, so the file has no step for it.
    expect(steps(mapped.diagram, 'bookshop_api/inventory.py')).toEqual([]);
    expect(steps(mapped.diagram, 'bookshop_api/inventory.py/reserve_stock')).toEqual([
      'read stock_levels [warehouse_code,book_id,on_hand]',
      'write stock_levels [on_hand]',
      'call bookshop_api/inventory.py/audit',
    ]);
  });

  it('leaves a sentence that opens with a SQL verb alone', () => {
    // "Update the stock count whenever an order is placed." has no SET, so it
    // is English rather than a statement, and draws nothing.
    expect(steps(mapped.diagram, 'bookshop_api/inventory.py/audit')).toEqual([
      'write audit_log [action,book_id,at]',
    ]);
  });

  it('says so rather than guessing when the table is chosen at run time', () => {
    expect(mapped.report).toContain('built at run time');
    expect(mapped.diagram.tables.some((t) => t.name.includes('{'))).toBe(false);
  });

  it('calls the whole row the whole row when the query says SELECT *', () => {
    expect(steps(mapped.diagram, 'bookshop_api/inventory.py/warehouse_stock')).toEqual(['read stock_levels []']);
  });

  it('hands a column to the table it belongs to across a join', () => {
    expect(steps(mapped.diagram, 'bookshop_api/orders.py/OrderService/history')).toEqual([
      'read orders [id,customer_id,placed_at]',
      'read customers [id,email]',
    ]);
  });

  it('separates what an upsert writes from what its SELECT reads', () => {
    expect(steps(mapped.diagram, 'bookshop_api/jobs/rollup.py/RollupJob/refresh_totals')).toEqual([
      'write book_totals []',
      'read daily_sales [book_id,units,revenue_cents]',
      'write book_totals [book_id,total_units,total_revenue_cents]',
    ]);
  });

  it('draws the imports between files and the calls between functions', () => {
    expect(steps(mapped.diagram, 'bookshop_api/orders.py')).toEqual(['import bookshop_api/inventory.py']);
    expect(at(mapped.diagram, 'bookshop_api/orders.py').steps[0].note).toBe('for reserve_stock');
    expect(steps(mapped.diagram, 'bookshop_api/main.py/place_order_route')).toEqual([
      'call bookshop_api/orders.py/OrderService',
      'call bookshop_api/orders.py/OrderService/place_order',
    ]);
  });

  it('takes a node\'s comment from its docstring, and says how a route is reached', () => {
    expect(at(mapped.diagram, 'bookshop_api').comment).toBe('The web API the shop front talks to.');
    expect(at(mapped.diagram, 'bookshop_api/orders.py/OrderService/place_order').comment).toBe(
      'Turn a cart into an order and its lines, then reserve the stock.',
    );
    expect(at(mapped.diagram, 'bookshop_api/main.py/place_order_route').comment).toContain("@app.post('/orders')");
  });

  it('writes the signature, the file and the declaration as the entrypoint of each kind', () => {
    expect(at(mapped.diagram, 'bookshop_api/orders.py').entrypoint).toBe(`${SOURCE}/orders.py`);
    expect(at(mapped.diagram, 'bookshop_api/orders.py/OrderService').entrypoint).toBe('class OrderService');
    expect(at(mapped.diagram, 'bookshop_api/orders.py/OrderService/place_order').entrypoint).toBe(
      'def place_order(self, email, cart)',
    );
  });

  it('leaves out the code that reaches no table, and --all keeps it', () => {
    const paths = mapped.diagram.programs.map((p) => codePath(mapped.diagram, p));
    expect(paths).not.toContain('bookshop_api/money.py');
    expect(mapped.report).toContain('nothing in them reaches the database');

    const all = scan('--into', SCHEMA, '--all');
    const everything = all.diagram.programs.map((p) => codePath(all.diagram, p));
    expect(everything).toContain('bookshop_api/money.py/to_cents');
    expect(everything).toContain('bookshop_api/jobs/base.py/BaseJob');
    // The inheritance arrow comes back with the class it points at.
    expect(steps(all.diagram, 'bookshop_api/jobs/rollup.py/RollupJob')).toEqual([
      'extends bookshop_api/jobs/base.py/BaseJob',
    ]);
  });

  it('invents the table the code names that the diagram has not got, with the columns it named', () => {
    const audit = mapped.diagram.tables.find((t) => t.name === 'audit_log');
    expect(audit?.columns.map((c) => c.name)).toEqual(['action', 'book_id', 'at']);
    expect(audit?.comment).toContain('Seen in the code');
    expect(mapped.report).toContain('audit_log');
  });

  it('leaves the reference dangling instead, under --no-stub-tables, for Problems to report', () => {
    const bare = scan('--into', SCHEMA, '--no-stub-tables');
    expect(bare.diagram.tables.some((t) => t.name === 'audit_log')).toBe(false);
    const finding = lintDiagram(bare.diagram).find((f) => f.rule === 'program-step-missing-table');
    expect(finding?.severity).toBe('error');
    expect(bare.report).toContain('"audit_log" is not a table in the diagram');
  });

  it('writes a diagram the app loads, the linter has nothing to fault, and the validator accepts', () => {
    expect(lintDiagram(mapped.diagram).filter((f) => f.severity === 'error')).toEqual([]);
    const report = execFileSync('node', ['scripts/validate-dbviz.mjs', mapped.file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(report).toContain('OK');
  });

  it('places the leaves and leaves the regions to the app, parked clear of the schema', () => {
    const functions = mapped.diagram.programs.filter((p) => p.kind === 'function');
    expect(functions.length).toBeGreaterThan(0);
    const right = Math.max(...mapped.diagram.programs.map((p) => p.position.x));
    const leftmostTable = Math.min(...mapped.diagram.tables.map((t) => t.position.x));
    expect(right).toBeLessThan(leftmostTable);
    // Members sit inside their container's anchor, which is what makes the
    // derived region wrap them rather than the other way round.
    const module = at(mapped.diagram, 'bookshop_api/orders.py');
    const method = at(mapped.diagram, 'bookshop_api/orders.py/OrderService/place_order');
    expect(method.position.x).toBeGreaterThan(module.position.x);
    expect(method.position.y).toBeGreaterThan(module.position.y);
  });

  it('updates a map on a second scan rather than growing a second copy of it', () => {
    const again = scan('--into', mapped.file);
    expect(readFileSync(again.file, 'utf8')).toBe(readFileSync(mapped.file, 'utf8'));
  });

  it('keeps where a node was dragged and what colour it was given', () => {
    const edited = join(out, 'edited.dbviz.json');
    const doc = JSON.parse(readFileSync(mapped.file, 'utf8'));
    const moved = doc.programs.find((p: { name: string }) => p.name === 'place_order');
    moved.position = { x: -4242, y: -2424 };
    moved.color = 'teal';
    moved.steps = [];
    writeFileSync(edited, JSON.stringify(doc, null, 2));

    const rescan = scan('--into', edited);
    const back = at(rescan.diagram, 'bookshop_api/orders.py/OrderService/place_order');
    expect(back.position).toEqual({ x: -4242, y: -2424 });
    expect(back.color).toBe('teal');
    // What the code says is read again, though: the steps come back.
    expect(back.steps).toHaveLength(4);
  });
});
