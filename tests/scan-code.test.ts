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
 * The scanner, against a service written to be scanned — once per language.
 *
 * tests/fixtures/bookshop_api is the checkout service walkthrough 16 draws by
 * hand, as code: the same two files, the same class, the same round trip. So
 * the interesting assertion is not that the scanner produces *a* map, it is
 * that it produces the one a person drew from the same program — and that what
 * it writes is a file the app loads, the linter passes and the validator
 * accepts.
 *
 * The same service is then written again in Rust, Go, Java, TypeScript,
 * JavaScript, C, C++, Perl and the shell, and asserted against the same
 * schema. One reader covers all nine, so the point of scanning each is that
 * the shapes they spell differently — a receiver, an `impl` block, a header
 * and its source, a template literal, a `package` line, a heredoc — all arrive
 * as the same nodes and the same steps.
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

function scanOf(source: string, ...args: string[]): { diagram: Diagram; file: string; report: string } {
  const file = join(out, `scan-${++serial}.dbviz.json`);
  // The diagram goes where it was asked to go; what the scan could not work
  // out goes to stderr, which is the half these tests check as closely.
  const run = spawnSync(python as string, ['scripts/scan_code.py', source, '-o', file, ...args], {
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`the scan failed (${run.status}): ${run.stderr}`);
  return { diagram: parseDiagramFile(readFileSync(file, 'utf8')), file, report: run.stderr };
}

function scan(...args: string[]): { diagram: Diagram; file: string; report: string } {
  return scanOf(SOURCE, ...args);
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

describe.skipIf(!python)('scripts/scan_code.py', () => {
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

/**
 * The same service, written seven more times.
 *
 * One reader covers Rust, Go, Java, TypeScript, JavaScript, C and C++, so what
 * is worth asserting per language is the shape only that language has: Go's
 * receiver, Rust's `impl` block, C's header beside its source, Java's text
 * block, a template literal's hole. Everything the seven have in common — a
 * query is a step, a call is an arrow, a constant is followed to whatever runs
 * it — is asserted once, for all of them, in the table at the top.
 */
interface LanguageCase {
  /** What the fixture is called, and what the program node is therefore named. */
  name: string;
  language: string;
  /** Path of the function that places an order, and of the one that reserves stock. */
  place: string;
  reserve: string;
  /** Path of the file that holds `reserve_stock`, for the import assertion. */
  inventory: string;
  /** Path of the file or class that imports it. */
  importer: string;
  /** The comment above `place`, which Go writes starting with the name. */
  comment?: string;
}

const CASES: LanguageCase[] = [
  {
    name: 'bookshop_rs',
    language: 'rust',
    place: 'bookshop_rs/src/orders.rs/OrderService/place_order',
    reserve: 'bookshop_rs/src/inventory.rs/reserve_stock',
    inventory: 'bookshop_rs/src/inventory.rs',
    importer: 'bookshop_rs/src/orders.rs',
  },
  {
    name: 'bookshop_go',
    language: 'go',
    place: 'bookshop_go/orders/orders.go/Service/PlaceOrder',
    reserve: 'bookshop_go/inventory/inventory.go/ReserveStock',
    inventory: 'bookshop_go/inventory',
    importer: 'bookshop_go/orders/orders.go',
    comment: 'PlaceOrder turns a cart into an order and its lines, then reserves the stock.',
  },
  {
    name: 'bookshop_java',
    language: 'java',
    place: 'bookshop_java/src/com/example/bookshop/OrderService.java/OrderService/placeOrder',
    reserve: 'bookshop_java/src/com/example/bookshop/stock/Inventory.java/Inventory/reserveStock',
    inventory: 'bookshop_java/src/com/example/bookshop/stock/Inventory.java',
    importer: 'bookshop_java/src/com/example/bookshop/OrderService.java',
  },
  {
    name: 'bookshop_ts',
    language: 'typescript',
    place: 'bookshop_ts/src/orders.ts/OrderService/placeOrder',
    reserve: 'bookshop_ts/src/inventory.ts/reserveStock',
    inventory: 'bookshop_ts/src/inventory.ts',
    importer: 'bookshop_ts/src/orders.ts',
  },
  {
    name: 'bookshop_js',
    language: 'javascript',
    place: 'bookshop_js/orders.js/OrderService/placeOrder',
    reserve: 'bookshop_js/inventory.js/reserveStock',
    inventory: 'bookshop_js/inventory.js',
    importer: 'bookshop_js/orders.js',
  },
  {
    name: 'bookshop_c',
    language: 'c',
    place: 'bookshop_c/orders.c/place_order',
    reserve: 'bookshop_c/inventory.c/reserve_stock',
    inventory: 'bookshop_c/inventory.c',
    importer: 'bookshop_c/orders.c',
  },
  {
    name: 'bookshop_cpp',
    language: 'cpp',
    place: 'bookshop_cpp/orders.cpp/bookshop/OrderService/place_order',
    reserve: 'bookshop_cpp/inventory.cpp/bookshop/Inventory/reserve_stock',
    inventory: 'bookshop_cpp/inventory.cpp',
    importer: 'bookshop_cpp/orders.cpp',
  },
  {
    name: 'bookshop_pl',
    language: 'perl',
    place: 'bookshop_pl/lib/Bookshop/Orders.pm/place_order',
    reserve: 'bookshop_pl/lib/Bookshop/Inventory.pm/reserve_stock',
    inventory: 'bookshop_pl/lib/Bookshop/Inventory.pm',
    importer: 'bookshop_pl/lib/Bookshop/Orders.pm',
  },
  {
    name: 'bookshop_sh',
    language: 'shell',
    place: 'bookshop_sh/lib/orders.sh/place_order',
    reserve: 'bookshop_sh/lib/inventory.sh/reserve_stock',
    inventory: 'bookshop_sh/lib/inventory.sh',
    importer: 'bookshop_sh/lib/orders.sh',
  },
];

/** The paths this scan added, as opposed to the ones the target diagram already had. */
function own(d: Diagram, program: string): string[] {
  return d.programs.map((p) => codePath(d, p)).filter((p) => p === program || p.startsWith(`${program}/`));
}

describe.skipIf(!python)('scripts/scan_code.py, on the languages that are not Python', () => {
  const scans = new Map<string, ReturnType<typeof scanOf>>();
  for (const one of CASES) scans.set(one.name, scanOf(`tests/fixtures/${one.name}`, '--into', SCHEMA));

  describe.each(CASES)('$language', (one) => {
    const mapped = () => scans.get(one.name)!;

    it('reads the round trip off the queries, in the order the code runs them', () => {
      expect(steps(mapped().diagram, one.place)).toEqual([
        'read customers [id,email]',
        'write orders [customer_id,status,total_cents]',
        'write order_items [order_id,book_id,quantity,unit_price_cents]',
        `call ${one.reserve}`,
      ]);
    });

    it('follows a query parked in a constant to the function that actually runs it', () => {
      expect(steps(mapped().diagram, one.inventory)).not.toContain('read stock_levels [warehouse_code,book_id,on_hand]');
      expect(steps(mapped().diagram, one.reserve).slice(0, 2)).toEqual([
        'read stock_levels [warehouse_code,book_id,on_hand]',
        'write stock_levels [on_hand]',
      ]);
    });

    it('leaves a sentence that opens with a SQL verb alone', () => {
      // "Update the stock count whenever an order is placed." has no SET, so it
      // is English rather than a statement, and draws nothing.
      const audits = mapped().diagram.programs.filter((p) => /^audit$/i.test(p.name));
      expect(audits).toHaveLength(1);
      expect(steps(mapped().diagram, codePath(mapped().diagram, audits[0]))).toEqual([
        'write audit_log [action,book_id,at]',
      ]);
    });

    it('draws the import between the file that calls and the file that holds', () => {
      expect(steps(mapped().diagram, one.importer)).toContain(`import ${one.inventory}`);
    });

    it('says which language every node it drew is written in', () => {
      // The target diagram already holds a Python map drawn by hand, so the
      // question is what this scan added, not what the file ends up holding.
      // The data files are left out: a YAML file is YAML in any program, which
      // is the whole of why it is a kind of its own.
      const drew = own(mapped().diagram, one.name);
      const languages = new Set(
        mapped()
          .diagram.programs.filter((p) => drew.includes(codePath(mapped().diagram, p)) && p.kind !== 'data')
          .map((p) => p.language),
      );
      expect([...languages]).toEqual([one.language]);
    });

    it('takes a node’s comment from the comment above it', () => {
      expect(at(mapped().diagram, one.place).comment).toBe(
        one.comment ?? 'Turn a cart into an order and its lines, then reserve the stock.',
      );
    });

    it('writes a diagram the app loads, the linter has nothing to fault, and the validator accepts', () => {
      expect(lintDiagram(mapped().diagram).filter((f) => f.severity === 'error')).toEqual([]);
      const report = execFileSync('node', ['scripts/validate-dbviz.mjs', mapped().file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(report).toContain('OK');
    });

    it('updates a map on a second scan rather than growing a second copy of it', () => {
      const again = scanOf(`tests/fixtures/${one.name}`, '--into', mapped().file);
      expect(readFileSync(again.file, 'utf8')).toBe(readFileSync(mapped().file, 'utf8'));
    });
  });

  it('reads a Go method as a method of the type it hangs off', () => {
    const diagram = scans.get('bookshop_go')!.diagram;
    // `func (s *Service) PlaceOrder(...)` names its receiver, and a call on
    // that receiver is a call on the type, not on a variable called s.
    expect(at(diagram, 'bookshop_go/orders/orders.go/Service').kind).toBe('class');
    expect(steps(diagram, 'bookshop_go/orders/orders.go/Service/PlaceOrder')).toContain(
      'call bookshop_go/inventory/inventory.go/ReserveStock',
    );
  });

  it('reads a YAML file as a data file: a node with a language, a kind, and nothing it does', () => {
    const map = scans.get('bookshop_sh')!.diagram;
    const settings = at(map, 'bookshop_sh/config/settings.yaml');
    expect(settings.kind).toBe('data');
    expect(settings.language).toBe('yaml');
    // Nothing runs in it, so there is nothing it does in order.
    expect(settings.steps).toEqual([]);
    // And the function that names its path is the one that reads it.
    expect(steps(map, 'bookshop_sh/main.sh/main')).toContain('load bookshop_sh/config/settings.yaml');
    expect(steps(map, 'bookshop_sh/main.sh/main')).toContain('load bookshop_sh/config/rates.json');
    expect(at(map, 'bookshop_sh/config/rates.json').language).toBe('json');
    // The directory holding them is not "written in YAML": a container never
    // takes a language nothing runs in.
    expect(at(map, 'bookshop_sh/config').language).toBe('shell');
  });

  it('keeps a data file only while something in the map reads it', () => {
    const map = scans.get('bookshop_sh')!.diagram;
    // config/logging.yaml sits in the same directory and nothing loads it.
    expect(own(map, 'bookshop_sh')).not.toContain('bookshop_sh/config/logging.yaml');
    const all = scanOf('tests/fixtures/bookshop_sh', '--into', SCHEMA, '--all');
    expect(own(all.diagram, 'bookshop_sh')).toContain('bookshop_sh/config/logging.yaml');
  });

  it('reads an import of a JSON file as the read of a file it really is', () => {
    const map = scans.get('bookshop_ts')!.diagram;
    // `import rates from './rates.json'` is an import in the source and a file
    // read at run time; nothing in a data file can be imported.
    expect(steps(map, 'bookshop_ts/src/orders.ts')).toContain('load bookshop_ts/src/rates.json');
    expect(steps(map, 'bookshop_ts/src/orders.ts')).not.toContain('import bookshop_ts/src/rates.json');
    expect(at(map, 'bookshop_ts/src/rates.json').kind).toBe('data');
  });

  it('merges a Rust struct with the impl blocks that give it its methods', () => {
    const all = scanOf('tests/fixtures/bookshop_rs', '--into', SCHEMA, '--all');
    const paths = own(all.diagram, 'bookshop_rs');
    expect(paths.filter((p) => p.endsWith('/OrderService'))).toHaveLength(1);
    // `impl Restocker for WarehouseDesk` is inheritance, spelled the other way round.
    expect(steps(all.diagram, 'bookshop_rs/src/inventory.rs/WarehouseDesk')).toEqual([
      'extends bookshop_rs/src/inventory.rs/Restocker',
    ]);
  });

  it('reads a Java text block, and a class extends a base in the same package', () => {
    const all = scanOf('tests/fixtures/bookshop_java', '--into', SCHEMA, '--all');
    const insert = at(all.diagram, CASES[2].place).steps.find((s) => s.sql?.startsWith('INSERT INTO orders'));
    expect(insert?.sql).toBe("INSERT INTO orders (customer_id, status, total_cents)\nVALUES (?, 'pending', ?)");
    expect(steps(all.diagram, 'bookshop_java/src/com/example/bookshop/OrderService.java/OrderService')).toEqual([
      'extends bookshop_java/src/com/example/bookshop/BaseService.java/BaseService',
    ]);
  });

  it('reads a header and the source beside it as one module', () => {
    const all = scanOf('tests/fixtures/bookshop_c', '--into', SCHEMA, '--all');
    const paths = own(all.diagram, 'bookshop_c');
    // inventory.h declares what inventory.c defines: one module, one function.
    expect(paths).not.toContain('bookshop_c/inventory.h');
    expect(paths.filter((p) => p.endsWith('/reserve_stock'))).toEqual(['bookshop_c/inventory.c/reserve_stock']);
  });

  it('reads a C++ class split over a header and a source, inside its namespace', () => {
    const all = scanOf('tests/fixtures/bookshop_cpp', '--into', SCHEMA, '--all');
    expect(at(all.diagram, 'bookshop_cpp/inventory.cpp/bookshop').kind).toBe('module');
    expect(steps(all.diagram, 'bookshop_cpp/inventory.cpp/bookshop/Inventory')).toEqual([
      'extends bookshop_cpp/inventory.cpp/bookshop/Restocker',
    ]);
    // The raw string literal keeps its newlines and loses its R"sql( … )sql".
    expect(at(all.diagram, CASES[6].reserve).steps[0].sql).toContain('\nWHERE book_id = $1');
  });

  it('reads a Perl heredoc and a shell one as the query they hold', () => {
    // Both fixtures write their INSERT as a heredoc, which is the shape the
    // lexer has to read at the `<<SQL` and skip where the body actually sits.
    const perl = at(scans.get('bookshop_pl')!.diagram, CASES[7].place).steps.find((x) => x.sql?.startsWith('INSERT INTO orders'));
    expect(perl?.sql).toContain("VALUES (?, 'pending', ?) RETURNING id");
    const shell = at(scans.get('bookshop_sh')!.diagram, CASES[8].place).steps.find((x) => x.sql?.startsWith('INSERT INTO order_items'));
    expect(shell?.sql).toContain('INSERT INTO order_items (order_id, book_id, quantity, unit_price_cents)');
  });

  it('reads a shell function called by name, and a file it sources, as a call and an import', () => {
    const map = scans.get('bookshop_sh')!.diagram;
    expect(steps(map, 'bookshop_sh/lib/orders.sh')).toContain('import bookshop_sh/lib/inventory.sh');
    expect(steps(map, 'bookshop_sh/lib/inventory.sh/reserve_stock')).toContain('call bookshop_sh/lib/inventory.sh/audit');
  });

  it('keeps the hole where a table name was pasted in, rather than inventing a table', () => {
    for (const name of ['bookshop_rs', 'bookshop_go', 'bookshop_java', 'bookshop_ts', 'bookshop_c']) {
      const mapped = scans.get(name)!;
      expect(mapped.report).toContain('built at run time');
      expect(mapped.diagram.tables.some((t) => /[{%]/.test(t.name))).toBe(false);
    }
  });

  it('reads only the language it was asked for', () => {
    const only = scanOf('tests/fixtures/bookshop_ts', '--into', SCHEMA, '--lang', 'go', '--all');
    // The TypeScript is there and is not read, so the program node stands alone.
    expect(own(only.diagram, 'bookshop_ts')).toEqual(['bookshop_ts']);
    expect(only.report).toContain('No SQL found');
  });
});
