/**
 * Code pasted into a code node, read into steps: the lexer and statement
 * splitter under it, the language guess, the reader itself across the
 * bookshop fixtures, and the places the kept code travels to — the store's
 * undo history, the saved file, the SQL annotation block and the Markdown
 * export.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Diagram, Program, ProgramLanguage } from '../src/shared/types';
import { createColumn, createProgram, createTable, emptyDiagram } from '../src/lib/model';
import { codeStatements, guessLanguage, languageFromFilename, lexCode, readsAs, statementText } from '../src/lib/code/lex';
import { cleanDoc, looksLikeSql, outlineSource, pastedKind, readSourceInto } from '../src/lib/code/read';
import { classifyPastedText } from '../src/lib/clipboard';
import { parseDiagramFile, serializeDiagram } from '../src/lib/io';
import { generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { generateMarkdown } from '../src/lib/markdownExport';
import { useStore } from '../src/store/useStore';

const FIXTURES = join(__dirname, 'fixtures');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** The bookshop schema the fixtures query. */
function shop(): Diagram {
  const d = emptyDiagram();
  const table = (name: string, cols: string[]) => d.tables.push(createTable({ name, columns: cols.map((c) => createColumn({ name: c, type: 'integer' })) }));
  table('customers', ['id', 'email', 'updated_at', 'crm_id']);
  table('orders', ['id', 'customer_id', 'status', 'total_cents', 'placed_at']);
  table('order_items', ['order_id', 'book_id', 'quantity', 'unit_price_cents']);
  table('stock_levels', ['book_id', 'warehouse_code', 'on_hand']);
  table('audit_log', ['action', 'book_id', 'at']);
  table('jobs', ['id', 'payload', 'status']);
  table('results', ['job_id', 'score', 'label']);
  return d;
}

/** Every fixture file of one tree read into a module node each, twice, so calls across files resolve. */
function readTree(dir: string, language: ProgramLanguage): Diagram {
  const d = shop();
  const paths = files(join(FIXTURES, dir)).filter((p) => languageFromFilename(p) !== null && !p.endsWith('__init__.py'));
  const nodes = paths.map((p) => {
    const node = createProgram({ name: p.split('/').pop()!, kind: 'module', language });
    d.programs.push(node);
    return node;
  });
  for (let pass = 0; pass < 2; pass++) paths.forEach((p, i) => readSourceInto(d, nodes[i].id, readFileSync(p, 'utf8')));
  return d;
}

const byName = (d: Diagram, name: string, kind?: string): Program => {
  const p = d.programs.find((x) => x.name === name && (!kind || (x.kind ?? 'program') === kind));
  if (!p) throw new Error(`no node ${name}`);
  return p;
};

/** A node's steps as "op target" strings, the way the canvas numbers them. */
function stepList(d: Diagram, p: Program): string[] {
  return p.steps.map((s) => {
    const target = d.tables.find((t) => t.id === s.tableId)?.name ?? d.programs.find((x) => x.id === s.codeId)?.name ?? '';
    return `${s.op}${target ? ` ${target}` : ''}`;
  });
}

const columnNames = (d: Diagram, p: Program, i: number) => {
  const s = p.steps[i];
  const t = d.tables.find((x) => x.id === s.tableId)!;
  return s.columnIds.map((id) => t.columns.find((c) => c.id === id)!.name);
};

describe('lexing code for reading', () => {
  it('gives a string its value, whatever the language spells around it', () => {
    const py = lexCode('q = f"SELECT {x} FROM t"; r = rb"raw"', 'python').filter((t) => t.kind === 'string');
    expect(py.map((t) => t.value)).toEqual(['SELECT {x} FROM t', 'raw']);
    expect(py[0].text).toBe('f"SELECT {x} FROM t"');
    const rs = lexCode('let q = r#"SELECT "a" FROM t"#;', 'rust').find((t) => t.kind === 'string')!;
    expect(rs.value).toBe('SELECT "a" FROM t');
    const cpp = lexCode('auto q = R"sql(SELECT 1 FROM t)sql";', 'cpp').find((t) => t.kind === 'string')!;
    expect(cpp.value).toBe('SELECT 1 FROM t');
    const java = lexCode('String q = """\n    SELECT id\n    FROM t\n    """;', 'java').find((t) => t.kind === 'string')!;
    expect(java.value?.trim()).toBe('SELECT id\nFROM t');
  });

  it('reads a heredoc as one string, and the rest of its line as code', () => {
    const src = 'order_id=$(psql "$DSN" -At <<SQL\nINSERT INTO orders (id) VALUES (1)\nSQL\n)\necho done';
    const toks = lexCode(src, 'shell').filter((t) => t.kind !== 'space');
    const heredoc = toks.find((t) => t.text === '<<SQL')!;
    expect(heredoc.value).toBe('INSERT INTO orders (id) VALUES (1)\n');
    // Nothing inside the body came out as code of its own.
    expect(toks.some((t) => t.text === 'INSERT')).toBe(false);
    expect(toks.map((t) => t.text)).toContain('echo');
  });

  it('lets a shell or Perl string run on over lines, as those languages do', () => {
    const toks = lexCode("psql -c 'SELECT id\n  FROM customers'\necho ok", 'shell');
    const str = toks.find((t) => t.kind === 'string')!;
    expect(str.value).toBe('SELECT id\n  FROM customers');
    expect(toks.find((t) => t.text === 'echo')).toBeTruthy();
  });

  it('keeps a statement together across open brackets, a trailing operator and a leading method call', () => {
    const src = 'cur.execute(\n  "SELECT 1"\n  " FROM t",\n)\nx = 1';
    const py = codeStatements(src, lexCode(src, 'python'), 'python');
    expect(py.map((s) => statementText(src, s))).toEqual(['cur.execute(\n  "SELECT 1"\n  " FROM t",\n)', 'x = 1']);
    const js = 'const rows = await db\n  .query(q)\n  .all();\nconst s = "a" +\n  "b";';
    expect(codeStatements(js, lexCode(js, 'javascript'), 'javascript')).toHaveLength(2);
  });
});

describe('telling the language', () => {
  it('names the language of every fixture file that says enough to tell', () => {
    for (const p of files(FIXTURES)) {
      const ext = languageFromFilename(p);
      if (!ext || p.endsWith('__init__.py')) continue;
      const guess = guessLanguage(readFileSync(p, 'utf8'));
      // A header holding one macro says too little to tell C from C++, and
      // no guess is the right answer to that; a wrong guess never is.
      if (guess !== null) expect([p, guess]).toEqual([p, ext]);
    }
  });

  it('says nothing about prose or SQL', () => {
    expect(guessLanguage('Hello there, this is a note about the schema.')).toBeNull();
    expect(guessLanguage('SELECT id, email FROM customers WHERE id = 1;')).toBeNull();
    expect(guessLanguage('The function place_order() writes orders.')).toBeNull();
  });

  it('reads a shebang first, and tells a snippet with no definition by its shape', () => {
    expect(guessLanguage('#!/usr/bin/env bash\nls')).toBe('shell');
    expect(guessLanguage('for row in rows:\n    total = row.price if row else 0\n    print(total)')).toBe('python');
  });

  it('knows a language from a file name, and a data file is not code', () => {
    expect(languageFromFilename('orders.py')).toBe('python');
    expect(languageFromFilename('inventory.hpp')).toBe('cpp');
    expect(languageFromFilename('Orders.pm')).toBe('perl');
    expect(languageFromFilename('server.mjs')).toBe('javascript');
    expect(languageFromFilename('settings.yaml')).toBeNull();
    expect(languageFromFilename('README')).toBeNull();
  });

  it('keeps a node in its own language when the paste reads as it', () => {
    const java = readFileSync(join(FIXTURES, 'bookshop_java/src/com/example/bookshop/BaseService.java'), 'utf8');
    expect(readsAs(java, 'java')).toBe(true);
    expect(readsAs(java, 'go')).toBe(false);
  });

  it('classifies code pasted on the canvas as code, and leaves SQL as SQL', () => {
    expect(classifyPastedText('def place_order(email):\n    return 1\n')).toBe('code');
    expect(classifyPastedText('CREATE TABLE t (id int);')).toBe('sql');
    expect(classifyPastedText('just some words')).toBe('unknown');
  });
});

describe('what counts as a query', () => {
  it('wants a statement, not a sentence that starts with one of its words', () => {
    expect(looksLikeSql('SELECT id FROM t')).toBe(true);
    expect(looksLikeSql('Update failed, try again')).toBe(false);
    expect(looksLikeSql('Select a customer')).toBe(false);
    expect(looksLikeSql('delete this?')).toBe(false);
    expect(looksLikeSql('insert into t values (1)')).toBe(true);
    expect(looksLikeSql('CALL archive_orders(1)')).toBe(true);
  });

  it('cleans a doc comment down to its first paragraph', () => {
    expect(cleanDoc('/**\n * Turns a cart into an order.\n *\n * @param cart the lines\n */')).toBe('Turns a cart into an order.');
    expect(cleanDoc('/// Totals the cart\n/// in cents.')).toBe('Totals the cart in cents.');
  });
});

describe('reading a function', () => {
  const worker = [
    '# Score every pending job and write the result back.',
    `rows = cur.execute("SELECT id, payload FROM jobs WHERE status = 'pending'").fetchall()`,
    'for job_id, payload in rows:',
    '    # turn the payload into model features',
    '    features = extract(payload)',
    '    score = model.predict(features)',
    '    label = "hot" if score > 0.8 else "cold"',
    '    cur.execute("INSERT INTO results (job_id, score, label) VALUES (?, ?, ?)", (job_id, score, label))',
    `    cur.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))`,
    'conn.commit()',
  ].join('\n');

  it('reads a round trip as read, compute, write, write — the work in between its own step', () => {
    const d = shop();
    const fn = createProgram({ name: 'score_jobs', kind: 'function', language: 'python' });
    d.programs.push(fn);
    const r = readSourceInto(d, fn.id, worker)!;
    expect(r.steps).toBe(4);
    expect(stepList(d, fn)).toEqual(['read jobs', 'compute', 'write results', 'write jobs']);
    expect(fn.source).toBe(worker);
    // The comment above the work names it.
    expect(fn.steps[1].note).toBe('turn the payload into model features');
    expect(fn.steps[1].code).toContain('score = model.predict(features)');
    // Each step keeps the statement it runs, and the code it came from.
    expect(fn.steps[0].sql).toBe("SELECT id, payload FROM jobs WHERE status = 'pending'");
    expect(fn.steps[2].code).toBe('cur.execute("INSERT INTO results (job_id, score, label) VALUES (?, ?, ?)", (job_id, score, label))');
    expect(columnNames(d, fn, 2)).toEqual(['job_id', 'score', 'label']);
    // The glue after the last step rides with it rather than being dropped.
    expect(fn.steps[3].code).toContain('conn.commit()');
  });

  it('takes the name, signature and doc of the one definition it is, but not over a comment already written', () => {
    const d = shop();
    const fn = createProgram({ name: 'new_function', kind: 'function', language: 'rust', comment: 'Mine.' });
    d.programs.push(fn);
    const src = [
      '/// Totals yesterday per customer.',
      'pub async fn daily_report(pool: &PgPool) -> Result<()> {',
      '    let rows = sqlx::query(r#"SELECT customer_id, SUM(total_cents) FROM orders GROUP BY customer_id"#)',
      '        .fetch_all(pool)',
      '        .await?;',
      '    Ok(())',
      '}',
    ].join('\n');
    const r = readSourceInto(d, fn.id, src)!;
    expect(r.renamed).toBe('daily_report');
    expect(fn.name).toBe('daily_report');
    expect(fn.entrypoint).toBe('pub async fn daily_report(pool: &PgPool) -> Result<()>');
    expect(fn.comment).toBe('Mine.');
    expect(stepList(d, fn)).toEqual(['read orders']);
    expect(fn.steps[0].code).toContain('.fetch_all(pool)');
  });

  it('leaves a signature box holding a path alone', () => {
    const d = shop();
    const fn = createProgram({ name: 'f', kind: 'function', language: 'python', entrypoint: 'services/api/orders.py' });
    d.programs.push(fn);
    readSourceInto(d, fn.id, 'def f(x):\n    return x\n');
    expect(fn.entrypoint).toBe('services/api/orders.py');
  });

  it('reads a query from a named constant where it is used, not where it is defined', () => {
    const d = readTree('bookshop_go', 'go');
    const place = byName(d, 'PlaceOrder');
    expect(stepList(d, place)).toEqual(['read customers', 'call TotalCents', 'write orders', 'write order_items', 'call ReserveStock']);
    // The write of orders is the line that runs the constant.
    expect(place.steps[2].code).toContain('s.db.QueryRow(insertOrder, customerID, total)');
    expect(place.steps[2].sql).toContain('INSERT INTO orders');
    // The module that defines the constant does not run it.
    expect(stepList(d, byName(d, 'orders.go'))).toEqual(['import inventory.go', 'import money.go']);
  });

  it('follows a shell string that interpolates a named query', () => {
    const d = readTree('bookshop_sh', 'shell');
    expect(stepList(d, byName(d, 'reserve_stock'))).toEqual(['read stock_levels', 'write stock_levels', 'call audit']);
    expect(stepList(d, byName(d, 'place_order'))).toEqual(['read customers', 'call total_cents', 'write orders', 'write order_items', 'call reserve_stock']);
  });

  it('reads a Perl heredoc query and the work around it', () => {
    const d = shop();
    const prg = createProgram({ name: 'sync', language: 'perl' });
    d.programs.push(prg);
    const src = [
      'my $sth = $dbh->prepare(<<\'SQL\');',
      'SELECT id, email FROM customers WHERE updated_at > ?',
      'SQL',
      '$sth->execute($since);',
      'while (my $row = $sth->fetchrow_hashref) {',
      '    my $resp = $ua->post($crm_url, $row);',
      '    my $crm_id = decode_json($resp->content)->{id};',
      '    log_sync($row->{id}, $crm_id);',
      '    $dbh->do("UPDATE customers SET crm_id = ? WHERE id = ?", undef, $crm_id, $row->{id});',
      '}',
    ].join('\n');
    readSourceInto(d, prg.id, src);
    expect(stepList(d, prg)).toEqual(['read customers', 'compute', 'write customers']);
    expect(columnNames(d, prg, 2)).toEqual(['id', 'crm_id']);
  });

  it('draws nothing to a table name only known at run time, and keeps the code anyway', () => {
    const d = shop();
    const fn = createProgram({ name: 'count_rows', kind: 'function', language: 'python' });
    d.programs.push(fn);
    const src = 'def count_rows(conn, table):\n    return conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]\n';
    expect(readSourceInto(d, fn.id, src)!.steps).toBe(0);
    expect(fn.source).toBe(src);
  });

  it('refuses a data file and a procedure, which hold no host code', () => {
    const d = shop();
    const data = createProgram({ name: 'settings.yaml', kind: 'data', language: 'yaml' });
    const proc = createProgram({ name: 'archive', kind: 'procedure', language: 'other' });
    d.programs.push(data, proc);
    expect(readSourceInto(d, data.id, 'def f(): pass')).toBeNull();
    expect(readSourceInto(d, proc.id, 'def f(): pass')).toBeNull();
  });
});

describe('reading a file', () => {
  it('makes a member for each class and function, methods inside their class', () => {
    const d = readTree('bookshop_api', 'python');
    const service = byName(d, 'OrderService', 'class');
    expect(service.parentId).toBe(byName(d, 'orders.py').id);
    expect(d.programs.filter((p) => p.parentId === service.id).map((p) => p.name)).toEqual(['__init__', 'place_order', 'total_cents', 'history']);
    const place = byName(d, 'place_order');
    expect(place.entrypoint).toBe('def place_order(self, email, cart)');
    expect(place.comment).toBe('Turn a cart into an order and its lines, then reserve the stock.');
    expect(place.source?.startsWith('def place_order(self, email, cart):')).toBe(true);
    expect(stepList(d, place)).toEqual(['read customers', 'call total_cents', 'write orders', 'write order_items', 'call reserve_stock']);
    // What an INSERT hands back is not a column it writes.
    expect(columnNames(d, place, 2)).toEqual(['customer_id', 'status', 'total_cents']);
    expect(stepList(d, byName(d, 'orders.py'))).toEqual(['import inventory.py', 'import money.py']);
    expect(byName(d, 'orders.py').comment).toBe('Everything about taking an order.');
  });

  it('reads again in place: no second copy of a member, and each keeps where it was dragged', () => {
    const d = readTree('bookshop_api', 'python');
    const place = byName(d, 'place_order');
    place.position = { x: 999, y: 999 };
    const count = d.programs.length;
    const r = readSourceInto(d, byName(d, 'orders.py').id, readFileSync(join(FIXTURES, 'bookshop_api/orders.py'), 'utf8'))!;
    expect(r.created).toBe(0);
    expect(r.updated).toBe(5);
    expect(d.programs).toHaveLength(count);
    expect(byName(d, 'place_order').position).toEqual({ x: 999, y: 999 });
  });

  it('reads a Go method into the struct its receiver names', () => {
    const d = readTree('bookshop_go', 'go');
    const service = byName(d, 'Service', 'class');
    expect(d.programs.filter((p) => p.parentId === service.id).map((p) => p.name)).toEqual(['PlaceOrder', 'TotalCents', 'History']);
    expect(byName(d, 'PlaceOrder').entrypoint).toBe('func (s *Service) PlaceOrder(email string, cart []Line) (int64, error)');
  });

  it("merges a Rust type with its impl blocks, and reads a trait impl as what it extends", () => {
    const d = readTree('bookshop_rs', 'rust');
    const desk = byName(d, 'WarehouseDesk', 'class');
    expect(stepList(d, desk)).toEqual(['extends Restocker']);
    expect(d.programs.filter((p) => p.parentId === desk.id).map((p) => p.name)).toEqual(['restock']);
    const service = byName(d, 'OrderService', 'class');
    expect(d.programs.filter((p) => p.parentId === service.id).map((p) => p.name)).toEqual(['new', 'place_order', 'total_cents', 'history']);
  });

  it('reads Java extends, JavaScript classes and C++ methods defined outside their class', () => {
    const java = readTree('bookshop_java', 'java');
    expect(stepList(java, byName(java, 'OrderService', 'class'))).toEqual(['extends BaseService']);
    const js = readTree('bookshop_js', 'javascript');
    expect(stepList(js, byName(js, 'placeOrder'))).toEqual(['read customers', 'call totalCents', 'write orders', 'write order_items', 'call reserveStock']);
    const cpp = readTree('bookshop_cpp', 'cpp');
    const inventory = cpp.programs.find((p) => p.name === 'Inventory' && p.parentId === byName(cpp, 'inventory.cpp').id)!;
    expect(cpp.programs.filter((p) => p.parentId === inventory.id).map((p) => p.name)).toEqual(['Inventory', 'reserve_stock', 'warehouse_stock', 'restock', 'audit']);
  });

  it('does not take a C prototype for a call', () => {
    const d = readTree('bookshop_c', 'c');
    expect(stepList(d, byName(d, 'inventory.c'))).toEqual(['import inventory.h']);
    expect(stepList(d, byName(d, 'inventory.h'))).toEqual([]);
    expect(stepList(d, byName(d, 'main'))).toEqual(['call place_order', 'call warehouse_stock']);
  });

  it('reads the same bookshop out of all ten languages', () => {
    const trees: [string, ProgramLanguage, string][] = [
      ['bookshop_api', 'python', 'place_order'],
      ['bookshop_go', 'go', 'PlaceOrder'],
      ['bookshop_js', 'javascript', 'placeOrder'],
      ['bookshop_ts', 'typescript', 'placeOrder'],
      ['bookshop_java', 'java', 'placeOrder'],
      ['bookshop_rs', 'rust', 'place_order'],
      ['bookshop_c', 'c', 'place_order'],
      ['bookshop_cpp', 'cpp', 'place_order'],
      ['bookshop_pl', 'perl', 'place_order'],
      ['bookshop_sh', 'shell', 'place_order'],
    ];
    for (const [dir, language, fn] of trees) {
      const d = readTree(dir, language);
      const node = byName(d, fn, 'function');
      const touched = stepList(d, node).filter((s) => s.startsWith('read') || s.startsWith('write'));
      expect([dir, touched]).toEqual([dir, ['read customers', 'write orders', 'write order_items']]);
    }
  });

  it('says what a paste is before there is a node for it', () => {
    const one = outlineSource('def f(x):\n    return x\n', 'python');
    expect(pastedKind(one)).toEqual({ kind: 'function', name: 'f' });
    const cls = outlineSource('class A:\n    def f(self):\n        pass\n', 'python');
    expect(pastedKind(cls)).toEqual({ kind: 'class', name: 'A' });
    const file = outlineSource('import os\n\ndef f():\n    pass\n\ndef g():\n    pass\n', 'python');
    expect(pastedKind(file).kind).toBe('module');
    const script = outlineSource('def f():\n    pass\n\nf()\nprint("done")\n', 'python');
    expect(pastedKind(script).kind).toBe('program');
  });
});

describe('the kept code, everywhere a node goes', () => {
  it('reads code into a node in one undo step', () => {
    const d = shop();
    const mod = createProgram({ name: 'orders.py', kind: 'module', language: 'python' });
    d.programs.push(mod);
    useStore.setState({ diagram: d, past: [], future: [] });
    const r = useStore.getState().readCode(mod.id, readFileSync(join(FIXTURES, 'bookshop_api/orders.py'), 'utf8'))!;
    expect(r.created).toBe(5);
    expect(useStore.getState().diagram.programs).toHaveLength(6);
    useStore.getState().undo();
    const back = useStore.getState().diagram;
    expect(back.programs).toHaveLength(1);
    expect(back.programs[0].source).toBeUndefined();
  });

  it('makes a node of the right kind from a paste, inside the selected container', () => {
    const d = shop();
    const mod = createProgram({ name: 'orders.py', kind: 'module', language: 'python' });
    d.programs.push(mod);
    useStore.setState({ diagram: d, past: [], future: [] });
    const made = useStore.getState().addCodeFromSource({ source: 'def history(conn, cid):\n    return conn.execute("SELECT id FROM orders WHERE customer_id = %s", (cid,))\n', language: 'python', parentId: mod.id })!;
    expect(made.kind).toBe('function');
    const node = useStore.getState().diagram.programs.find((p) => p.id === made.id)!;
    expect(node).toMatchObject({ name: 'history', kind: 'function', parentId: mod.id });
    expect(stepList(useStore.getState().diagram, node)).toEqual(['read orders']);
    const file = useStore.getState().addCodeFromSource({ source: 'def f():\n    pass\n', language: 'python', name: 'money.py', file: true })!;
    expect(file.kind).toBe('module');
    expect(useStore.getState().diagram.programs.find((p) => p.id === file.id)!.name).toBe('money.py');
  });

  it('drops the code when a node becomes a data file', () => {
    const d = shop();
    const fn = createProgram({ name: 'f', kind: 'function', language: 'python', source: 'def f(): pass' });
    d.programs.push(fn);
    useStore.setState({ diagram: d, past: [], future: [] });
    useStore.getState().updateProgram(fn.id, { kind: 'data' });
    expect(useStore.getState().diagram.programs[0].source).toBeUndefined();
  });

  it('saves with the diagram, and never on a data file or a procedure', () => {
    const d = shop();
    d.programs.push(
      createProgram({ name: 'f', kind: 'function', language: 'python', source: 'def f():\n    pass\n' }),
      { ...createProgram({ name: 'cfg.yaml', kind: 'data', language: 'yaml' }), source: 'a: 1' },
      { ...createProgram({ name: 'p', kind: 'procedure', language: 'other' }), source: 'nope' },
    );
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.programs.find((p) => p.name === 'f')!.source).toBe('def f():\n    pass\n');
    expect(back.programs.find((p) => p.name === 'cfg.yaml')!.source).toBeUndefined();
    expect(back.programs.find((p) => p.name === 'p')!.source).toBeUndefined();
  });

  it('survives the SQL export and import', () => {
    const d = shop();
    const fn = createProgram({ name: 'score', kind: 'function', language: 'python' });
    d.programs.push(fn);
    readSourceInto(d, fn.id, 'def score(cur):\n    cur.execute("SELECT id FROM jobs")\n');
    const back = importSql(generateSchema(d).script, 'postgresql');
    const again = back.programs.find((p) => p.name === 'score')!;
    expect(again.source).toBe('def score(cur):\n    cur.execute("SELECT id FROM jobs")');
    expect(again.steps.map((s) => s.op)).toEqual(['read']);
  });

  it('is printed once in the Markdown export, rather than once per step', () => {
    const d = shop();
    const fn = createProgram({ name: 'score', kind: 'function', language: 'python' });
    d.programs.push(fn);
    readSourceInto(d, fn.id, 'def score(cur):\n    cur.execute("SELECT id FROM jobs")\n    cur.execute("UPDATE jobs SET status = 1 WHERE id = 2")\n');
    const md = generateMarkdown(d);
    expect(md).toContain('**Code**');
    expect(md).not.toContain('**Step 1 code**');
    expect(md.match(/cur\.execute\("SELECT id FROM jobs"\)/g)).toHaveLength(1);
  });
});
