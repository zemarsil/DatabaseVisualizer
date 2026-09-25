import { describe, expect, it } from 'vitest';
import { highlightSql, inLiteralAt, scanSql, tableAliases, type SqlScope } from '../src/lib/sql/highlight';
import { applyCompletion, completions, wordAtCaret } from '../src/lib/sql/complete';
import { checkExpression, checkStatement, referencedTables, splitStatements, statementAt } from '../src/lib/sql/analyze';
import { formatSql } from '../src/lib/sql/format';
import { relationshipQueryTemplates } from '../src/lib/sql/templates';
import { createColumn, createRelationship, createTable, emptyDiagram } from '../src/lib/model';
import { diagramScope, flowScope, reachableTables, tableScope } from '../src/lib/sqlScope';
import {
  autoClosePair,
  deleteEmptyPair,
  editorKeyAction,
  indentSelection,
  insertSnippet,
  lineColAt,
  newlineWithIndent,
  offsetOfLine,
  stepOverClosing,
  toggleLineComment,
  type EditState,
} from '../src/lib/sqlEditorKeys';

const scope: SqlScope = {
  tables: [
    { name: 'orders', columns: [{ name: 'id', type: 'INT' }, { name: 'status', type: 'TEXT' }, { name: 'customer_id', type: 'INT' }, { name: 'placed_at', type: 'TIMESTAMPTZ' }] },
    { name: 'order_items', columns: [{ name: 'id', type: 'INT' }, { name: 'quantity', type: 'INT' }, { name: 'unit_price_cents', type: 'INT' }, { name: 'order_id', type: 'INT' }] },
    { name: 'customers', columns: [{ name: 'id', type: 'INT' }, { name: 'email', type: 'TEXT' }], hint: 'table' },
  ],
};

/* ------------------------------------------------------------------ */
/* Scanner and highlighter                                             */
/* ------------------------------------------------------------------ */

describe('scanSql', () => {
  it('covers every character, so the overlay matches the textarea', () => {
    const samples = [
      "select 'it''s', \"quoted\", `tick`, 1.5e3, 0x1f, $1, :name, ? -- tail\n/* block */ x::int, a->>'k'",
      "unterminated 'string",
      '/* never closed',
      'arr[1] and [bracketed] name',
      '',
      '\n\n  \t',
    ];
    for (const s of samples) expect(scanSql(s).map((x) => x.text).join('')).toBe(s);
  });

  it('never throws on text the strict tokenizer rejects', () => {
    expect(scanSql("select 'open").map((s) => s.kind)).toEqual(['word', 'space', 'string']);
    expect(scanSql('/* open').map((s) => s.kind)).toEqual(['comment']);
    expect(scanSql('"open').map((s) => s.kind)).toEqual(['quoted']);
  });

  it('tells a subscript from a bracketed identifier', () => {
    expect(scanSql('arr[1]').map((s) => `${s.kind}:${s.text}`)).toEqual(['word:arr', 'punct:[', 'number:1', 'punct:]']);
    expect(scanSql('[my col]').map((s) => `${s.kind}:${s.text}`)).toEqual(['quoted:[my col]']);
  });

  it('keeps parameters and multi-character operators whole', () => {
    expect(scanSql("x::int <> $2 || :tag ->> 'k'").filter((s) => s.kind !== 'space').map((s) => s.text)).toEqual(['x', '::', 'int', '<>', '$2', '||', ':tag', '->>', "'k'"]);
  });
});

describe('highlightSql', () => {
  it('colours keywords, strings, numbers, comments and functions', () => {
    const by = Object.fromEntries(highlightSql("select count(*) from t where a = 'x' and b > 10 -- c").filter((s) => s.cls !== 'text' && s.cls !== 'punct').map((s) => [s.text, s.cls]));
    expect(by.select).toBe('keyword');
    expect(by.count).toBe('function');
    expect(by["'x'"]).toBe('string');
    expect(by['10']).toBe('number');
    expect(by['-- c']).toBe('comment');
  });

  it('knows the diagram: tables, their columns, aliases, and columns reached through an alias', () => {
    const spans = highlightSql('select o.status, c.email, quantity from orders o join customers as c on c.id = o.customer_id', scope);
    const cls = (text: string, nth = 0) => spans.filter((s) => s.text === text)[nth]?.cls;
    expect(cls('orders')).toBe('table');
    expect(cls('customers')).toBe('table');
    expect(cls('o')).toBe('alias');
    expect(cls('status')).toBe('column');
    expect(cls('email')).toBe('column');
    expect(cls('quantity')).toBe('column');
  });

  it('a column called date is a column, DATE(x) is a function', () => {
    const spans = highlightSql('select date, date(x) from t', { tables: [{ name: 't', columns: [{ name: 'date', type: 'DATE' }] }] });
    expect(spans.filter((s) => s.text === 'date').map((s) => s.cls)).toEqual(['column', 'function']);
  });

  it('marks what an expression cannot resolve only in strict mode', () => {
    const strict = highlightSql('quantity * orders.status + nope', { ...scope, primary: 'order_items' }, { strict: true });
    expect(strict.find((s) => s.text === 'nope')?.cls).toBe('unknown');
    expect(strict.find((s) => s.text === 'quantity')?.cls).toBe('column');
    const loose = highlightSql('quantity * nope', { ...scope, primary: 'order_items' });
    expect(loose.find((s) => s.text === 'nope')?.cls).toBe('text');
  });

  it('reads aliases off FROM, JOIN and UPDATE', () => {
    const a = tableAliases('update orders as o set x = 1 from customers c where c.id = o.customer_id');
    expect(a.get('o')).toBe('orders');
    expect(a.get('c')).toBe('customers');
    // a keyword after the table is not an alias, nor is a function's argument list
    expect(tableAliases('select * from orders where x = 1').size).toBe(0);
    expect(tableAliases('select * from unnest(a) u').size).toBe(0);
  });

  it('knows when the caret is inside a literal, including one still being typed', () => {
    expect(inLiteralAt("where a = 'pa", 13)).toBe(true);
    expect(inLiteralAt("where a = 'paid'", 16)).toBe(false);
    expect(inLiteralAt("where a = 'paid' and", 12)).toBe(true);
    expect(inLiteralAt('select 1 -- note', 16)).toBe(true);
    expect(inLiteralAt('select /* x */ 1', 14)).toBe(false);
    expect(inLiteralAt('select 1', 8)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

describe('a routine body in dollar quotes', () => {
  // The user's report, nearly verbatim: the whole body used to come out as one green string.
  const proc = `CREATE OR REPLACE PROCEDURE myproc(
	otherstuff		int DEFAULT 1,
    nslices        int DEFAULT 16,
    max_rows       bigint DEFAULT 0,
    slack          float8 DEFAULT 0.0001)
LANGUAGE plpgsql AS $$
DECLARE
    n_slice bigint;
    total bigint := 0;


BEGIN
  UPDATE orders SET status = 'done' WHERE id = n_slice;
END $$;`;

  it('colours the body as SQL, and only the literal inside it as a string', () => {
    const spans = highlightSql(proc, scope);
    expect(spans.map((s) => s.text).join('')).toBe(proc);
    const of = (text: string) => spans.filter((s) => s.text === text).map((s) => s.cls);
    expect(of('$$')).toEqual(['punct', 'punct']);
    expect(of('DECLARE')).toEqual(['keyword']);
    expect(of('UPDATE')).toEqual(['keyword']);
    expect(of('orders')).toEqual(['table']);
    expect(of('status')).toEqual(['column']);
    expect(of("'done'")).toEqual(['string']);
    expect(of('bigint')).toEqual(['type', 'type', 'type']);
  });

  it('colours a body while its closing quote is still to be typed', () => {
    const spans = highlightSql('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT id FROM orders', scope);
    expect(spans.find((s) => s.text === 'orders')?.cls).toBe('table');
  });

  it('keeps a dollar-quoted literal that is not a body a string', () => {
    const spans = highlightSql('SELECT $$ from orders $$ AS label', scope);
    expect(spans.find((s) => s.text.startsWith('$$'))).toMatchObject({ cls: 'string', text: '$$ from orders $$' });
  });

  it('offers completion inside the body, where it used to see a string', () => {
    const text = 'CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ord';
    expect(inLiteralAt(text, text.length)).toBe(false);
    expect(completions(text, text.length, scope)?.items.map((i) => i.label)).toContain('orders');
    expect(inLiteralAt("SELECT $$ from ord", 'SELECT $$ from ord'.length)).toBe(true);
  });

  it('still counts the whole CREATE as one statement', () => {
    expect(splitStatements(`${proc}
SELECT 1;`).map((s) => s.text.slice(0, 16))).toEqual(['CREATE OR REPLAC', 'SELECT 1;']);
    expect(scanSql(proc).filter((s) => s.kind === 'string').length).toBe(1);
  });
});

describe('completions', () => {
  it('finds the word and its qualifier at the caret', () => {
    expect(wordAtCaret('select o.sta', 12)).toEqual({ word: 'sta', start: 9, end: 12, qualifier: 'o' });
    expect(wordAtCaret('select "Orders".id', 18)).toMatchObject({ word: 'id', qualifier: 'Orders' });
    expect(wordAtCaret('select ', 7)).toMatchObject({ word: '', qualifier: null });
  });

  it('after table. or alias. offers only that table’s columns', () => {
    const t = 'select orders.st from orders';
    expect(completions(t, 16, scope)?.items.map((i) => i.label)).toEqual(['status']);
    const a = 'select o.cu from orders o';
    expect(completions(a, 11, scope)?.items.map((i) => i.label)).toEqual(['customer_id']);
    expect(completions('select x.no from orders', 11, scope)).toBeNull();
  });

  it('ranks columns of the tables being written about, then everyday keywords, then tables', () => {
    const t = 'select st from orders';
    const items = completions(t, 9, scope)!.items;
    expect(items[0]).toMatchObject({ kind: 'column', label: 'status' });
    expect(completions('sel', 3, scope)!.items[0]).toMatchObject({ kind: 'keyword', insert: 'select' });
    expect(completions('SEL', 3, scope)!.items[0]).toMatchObject({ kind: 'keyword', insert: 'SELECT' });
    expect(completions('select * from cust', 18, scope)!.items[0]).toMatchObject({ kind: 'table', label: 'customers' });
  });

  it('does not open inside a string, with too little typed, or when the word is already complete', () => {
    expect(completions("where a = 'st", 13, scope)).toBeNull();
    expect(completions('s', 1, scope)).toBeNull();
    expect(completions('select status', 13, scope)).toBeNull();
    expect(completions('s', 1, scope, { explicit: true })).not.toBeNull();
  });

  it('functions insert with parentheses and put the caret between them', () => {
    const t = 'select coal';
    const res = completions(t, 11, scope)!;
    expect(res.items[0]).toMatchObject({ kind: 'function', insert: 'coalesce()', caretBack: 1 });
    expect(applyCompletion(t, res, res.items[0])).toEqual({ text: 'select coalesce()', caret: 16 });
    // no doubled parens when one already follows
    const u = 'select coal(a, b)';
    expect(applyCompletion(u, { from: 7, to: 11 }, res.items[0])).toEqual({ text: 'select coalesce(a, b)', caret: 15 });
  });

  it('with a primary table, bare names are its columns and extras reach the rest', () => {
    const { scope: s, extras } = flowScope(
      createTable({ name: 'order_items', columns: [createColumn({ name: 'quantity', type: 'INT' })] }),
      [{ table: createTable({ name: 'orders', columns: [createColumn({ name: 'status', type: 'TEXT' })] }), via: 'order_items.order_id' }],
    );
    const items = completions('qu', 2, s, { extras })!.items;
    expect(items[0]).toMatchObject({ label: 'quantity' });
    expect(completions('sta', 3, s, { extras })!.items[0]).toMatchObject({ label: 'orders.status' });
    expect(completions('orders.st', 9, s, { extras })!.items[0]).toMatchObject({ label: 'status' });
  });
});

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

describe('referencedTables', () => {
  it('reads FROM lists, JOINs and writes, with aliases, and skips CTEs and functions', () => {
    const refs = referencedTables('with x as (select 1) insert into daily (a) select a from orders o, customers as c left join x on x.a = c.a join unnest(arr) u on true');
    expect(refs.map((r) => `${r.role}:${r.name}${r.alias ? `=${r.alias}` : ''}`)).toEqual(['write:daily', 'read:orders=o', 'read:customers=c']);
    expect(referencedTables('update only orders set a = 1; delete from refunds where x').map((r) => `${r.role}:${r.name}`)).toEqual(['write:orders', 'write:refunds']);
    expect(referencedTables('insert into t values (1) on duplicate key update a = 1').map((r) => r.name)).toEqual(['t']);
  });
});

describe('checkStatement', () => {
  it('reports unclosed strings and unbalanced parentheses with a position', () => {
    expect(checkStatement("select * from t where x = 'a")).toMatchObject([{ severity: 'error', message: 'Unterminated string literal', start: 26 }]);
    expect(checkStatement('select (1 + (2)')).toMatchObject([{ severity: 'error', message: 'Parenthesis never closed', start: 7 }]);
    expect(checkStatement('select 1)')).toMatchObject([{ severity: 'error', start: 8 }]);
    expect(checkStatement('select (1)')).toEqual([]);
  });

  it('warns about a table the diagram does not have, but not about aliases or CTEs', () => {
    const d = checkStatement('with r as (select 1) select * from ordrs o join order_items oi on oi.order_id = o.id join r on true', scope);
    expect(d).toMatchObject([{ severity: 'warning', message: 'ordrs is not a table in this diagram', start: 35, end: 40 }]);
    expect(checkStatement('select * from public.orders', scope)).toEqual([]);
  });
});

describe('checkExpression', () => {
  const s = { ...scope, primary: 'order_items' };
  it('accepts what the expression language accepts and points at what it cannot resolve', () => {
    expect(checkExpression('quantity * unit_price_cents', s)).toEqual([]);
    expect(checkExpression('*', s)).toEqual([]);
    expect(checkExpression('', s)).toEqual([]);
    expect(checkExpression("CASE WHEN orders.status = 'paid' THEN quantity ELSE 0 END", s)).toEqual([]);
    const d = checkExpression('quantity * foo + orders.nope + nope.x', s);
    expect(d.map((x) => x.message)).toEqual([
      'foo is not a column of order_items',
      'orders has no column nope',
      'nope is not a table the expression can reach from order_items',
    ]);
    expect(d[0]).toMatchObject({ start: 11, end: 14 });
  });

  it('suggests the qualified name when the column lives in a reachable table', () => {
    expect(checkExpression('status', s)[0].message).toBe('status is not a column of order_items — write orders.status to read it through the foreign key');
  });

  it('reports a parse error as an error', () => {
    expect(checkExpression('quantity * (', s)).toMatchObject([{ severity: 'error' }]);
    expect(checkExpression("'open", s)).toMatchObject([{ severity: 'error' }]);
  });
});

describe('statements', () => {
  const script = "select 1;\nselect ';' from t;\n\n-- note\nselect (select 2; from x)";
  it('splits at semicolons outside strings and parentheses', () => {
    expect(splitStatements(script).map((s) => s.text)).toEqual(['select 1;', "select ';' from t;", '-- note\nselect (select 2; from x)']);
  });
  it('finds the statement under the caret, or the one before it', () => {
    expect(statementAt(script, 12).text).toBe("select ';' from t;");
    expect(statementAt(script, 9).text).toBe('select 1;');
    expect(statementAt(script, 30).text).toBe('-- note\nselect (select 2; from x)');
    expect(statementAt('select 1', 3).text).toBe('select 1');
  });
});

/* ------------------------------------------------------------------ */
/* Formatter                                                           */
/* ------------------------------------------------------------------ */

describe('formatSql', () => {
  const idempotent = (sql: string) => {
    const once = formatSql(sql);
    expect(formatSql(once)).toBe(once);
    return once;
  };

  it('puts each clause on its own line and upper-cases keywords, leaving names and strings alone', () => {
    expect(idempotent("select o.Id, 'From x' as s from orders o where o.status = 'paid' order by o.id limit 10;")).toBe(
      "SELECT o.Id, 'From x' AS s\nFROM orders o\nWHERE o.status = 'paid'\nORDER BY o.id\nLIMIT 10;",
    );
  });

  it('breaks a long select list one entry per line and a long WHERE before AND', () => {
    const out = idempotent(
      'select order_id, product_id, sum(quantity) as units, sum(quantity * unit_price_cents) as revenue_cents from order_items where a = 1 and b = 2 and c = 3 and d = 4 and eeeeeeeeeeeeeeeeee = 5 and f between 1 and 2 group by order_id, product_id',
    );
    expect(out).toBe(
      [
        'SELECT',
        '  order_id,',
        '  product_id,',
        '  sum(quantity) AS units,',
        '  sum(quantity * unit_price_cents) AS revenue_cents',
        'FROM order_items',
        'WHERE a = 1',
        '  AND b = 2',
        '  AND c = 3',
        '  AND d = 4',
        '  AND eeeeeeeeeeeeeeeeee = 5',
        '  AND f BETWEEN 1 AND 2',
        'GROUP BY order_id, product_id',
      ].join('\n'),
    );
  });

  it('indents subqueries and CTEs, and keeps function calls tight', () => {
    expect(idempotent('with recent as (select * from orders where placed_at > now() - interval \'1 day\') select r.id, -1 as neg, 3 - 1 as diff from recent r where r.id in (select order_id from order_items)')).toBe(
      [
        'WITH recent AS (',
        '  SELECT *',
        '  FROM orders',
        "  WHERE placed_at > now() - INTERVAL '1 day'",
        ')',
        'SELECT r.id, -1 AS neg, 3 - 1 AS diff',
        'FROM recent r',
        'WHERE r.id IN (',
        '  SELECT order_id',
        '  FROM order_items',
        ')',
      ].join('\n'),
    );
  });

  it('writes CREATE TABLE one column per line and separates statements with a blank line', () => {
    expect(idempotent('create table a (id serial primary key, name varchar(120) not null); create table b (id int references a(id));')).toBe(
      'CREATE TABLE a (\n  id serial PRIMARY KEY,\n  name varchar(120) NOT NULL\n);\n\nCREATE TABLE b (\n  id int REFERENCES a(id)\n);',
    );
  });

  it('handles upserts in both spellings', () => {
    expect(idempotent('insert into t (a, b) values (1, 2) on conflict (a) do update set b = excluded.b')).toBe('INSERT INTO t (a, b)\nVALUES (1, 2)\nON CONFLICT (a) DO UPDATE\nSET b = EXCLUDED.b');
    expect(idempotent('insert into t (a, b) values (1, 2) on duplicate key update b = values(b)')).toBe('INSERT INTO t (a, b)\nVALUES (1, 2)\nON DUPLICATE KEY UPDATE b = VALUES(b)');
  });

  it('keeps comments where they were: own-line ones on their line, trailing ones after the comma', () => {
    expect(idempotent('-- head\nselect a, -- first\n  b\nfrom t /* why */ where x = 1 -- tail\n;')).toBe('-- head\nSELECT\n  a, -- first\n  b\nFROM t /* why */\nWHERE x = 1; -- tail');
  });

  it('leaves an expression alone apart from spacing and keyword case', () => {
    expect(idempotent("case when status='paid' then quantity*unit_price_cents else 0 end")).toBe("CASE WHEN status = 'paid' THEN quantity * unit_price_cents ELSE 0 END");
    expect(idempotent('')).toBe('');
  });

  it('does not choke on text with an unclosed string or paren', () => {
    expect(idempotent("select 'open")).toBe("SELECT 'open");
    expect(idempotent('select (1')).toBe('SELECT (1');
  });
});

/* ------------------------------------------------------------------ */
/* Templates and scope                                                 */
/* ------------------------------------------------------------------ */

function shop() {
  const d = emptyDiagram('postgresql');
  const customers = createTable({ name: 'customers', columns: [createColumn({ name: 'id', type: 'SERIAL', primaryKey: true, autoIncrement: true }), createColumn({ name: 'email', type: 'TEXT' })] });
  const orders = createTable({
    name: 'orders',
    columns: [createColumn({ name: 'id', type: 'SERIAL', primaryKey: true, autoIncrement: true }), createColumn({ name: 'customer_id', type: 'INT' }), createColumn({ name: 'status', type: 'TEXT' }), createColumn({ name: 'payload', type: 'JSONB' })],
  });
  const daily = createTable({ name: 'daily_sales', columns: [createColumn({ name: 'day', type: 'DATE', primaryKey: true }), createColumn({ name: 'status', type: 'TEXT' }), createColumn({ name: 'orders_count', type: 'INT' })] });
  d.tables.push(customers, orders, daily);
  const fk = createRelationship({ kind: 'fk', sourceTableId: orders.id, sourceColumnIds: [orders.columns[1].id], targetTableId: customers.id, targetColumnIds: [customers.columns[0].id] });
  const flow = createRelationship({ kind: 'flow', sourceTableId: orders.id, sourceColumnIds: [], targetTableId: daily.id, targetColumnIds: [] });
  const embed = createRelationship({ kind: 'embed', sourceTableId: orders.id, sourceColumnIds: [orders.columns[3].id], targetTableId: customers.id, targetColumnIds: [] });
  d.relationships.push(fk, flow, embed);
  return { d, customers, orders, daily, fk, flow, embed };
}

describe('relationshipQueryTemplates', () => {
  it('writes the join, the orphan check and the count for a foreign key from its column pairs', () => {
    const { d, fk } = shop();
    const t = relationshipQueryTemplates(d, fk);
    expect(t.map((x) => x.id)).toEqual(['join', 'orphans', 'count']);
    expect(t[0].sql).toBe('SELECT o.*, c.*\nFROM orders o\nJOIN customers c ON o.customer_id = c.id;');
    expect(t[1].sql).toContain('LEFT JOIN customers c ON o.customer_id = c.id\nWHERE o.customer_id IS NOT NULL\n  AND c.id IS NULL');
    expect(t[2].sql).toContain('GROUP BY c.id');
  });

  it('pairs a flow’s columns by name, leaves the rest NULL, and spells the upsert for the dialect', () => {
    const { d, flow } = shop();
    const t = relationshipQueryTemplates(d, flow);
    expect(t.map((x) => x.id)).toEqual(['insert-select', 'upsert', 'rebuild']);
    expect(t[0].sql).toBe('INSERT INTO daily_sales (day, status, orders_count)\nSELECT NULL AS day, o.status, NULL AS orders_count\nFROM orders o;');
    expect(t[1].sql).toContain('ON CONFLICT (day) DO UPDATE SET\n  status = EXCLUDED.status,\n  orders_count = EXCLUDED.orders_count;');
    d.dialect = 'mariadb';
    expect(relationshipQueryTemplates(d, flow)[1].sql).toContain('ON DUPLICATE KEY UPDATE\n  status = VALUES(status)');
  });

  it('leads with the generated statement once a flow has derivations', () => {
    const { d, flow, daily, orders } = shop();
    flow.derivations = [{ id: 'dv', targetColumnId: daily.columns[2].id, expression: '*', aggregate: 'COUNT', groupBy: ['status'] }];
    void orders;
    const t = relationshipQueryTemplates(d, flow);
    expect(t[0].id).toBe('derived');
    expect(t[0].sql).toContain('INSERT INTO daily_sales');
  });

  it('unpacks an embed with the dialect’s JSON functions', () => {
    const { d, embed } = shop();
    expect(relationshipQueryTemplates(d, embed)[0].sql).toContain('CROSS JOIN LATERAL jsonb_array_elements(o.payload) AS c');
    d.dialect = 'sqlite';
    expect(relationshipQueryTemplates(d, embed)[0].sql).toContain('json_each(o.payload) AS c');
    d.dialect = 'mariadb';
    expect(relationshipQueryTemplates(d, embed)[0].sql).toContain('JSON_TABLE(o.payload');
  });
});

describe('scopes', () => {
  it('reads the diagram into a scope, and a flow into a primary table with reachable ones', () => {
    const { d, orders, customers } = shop();
    expect(diagramScope(d).tables.map((t) => t.name)).toEqual(['customers', 'orders', 'daily_sales']);
    expect(tableScope(orders)).toMatchObject({ primary: 'orders' });
    const reach = reachableTables(d.tables, d.relationships, orders);
    expect(reach.map((r) => `${r.table.name} via ${r.via}`)).toEqual(['customers via orders.customer_id']);
    const { scope: s, extras } = flowScope(orders, reach);
    expect(s.primary).toBe('orders');
    expect(s.tables.map((t) => t.name)).toEqual(['orders', 'customers']);
    expect(extras.map((x) => x.label)).toEqual(['customers.id', 'customers.email']);
    void customers;
  });
});

/* ------------------------------------------------------------------ */
/* Keys and edits                                                      */
/* ------------------------------------------------------------------ */

const st = (text: string, start = text.length, end = start): EditState => ({ text, start, end });
const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {}) => ({ key: k, ...mods });
const multi = { popupOpen: false, multiline: true, hasSubmit: true };
const single = { popupOpen: false, multiline: false, hasSubmit: false };

describe('editorKeyAction', () => {
  it('maps the editing keys in a multi-line editor and leaves Tab alone in a single-line one', () => {
    expect(editorKeyAction(key('Tab'), multi)).toBe('indent');
    expect(editorKeyAction(key('Tab', { shiftKey: true }), multi)).toBe('outdent');
    expect(editorKeyAction(key('Tab'), single)).toBeNull();
    expect(editorKeyAction(key('Enter'), multi)).toBe('newline');
    expect(editorKeyAction(key('Enter', { shiftKey: true }), multi)).toBeNull();
    expect(editorKeyAction(key('Enter'), single)).toBe('noop');
    expect(editorKeyAction(key('Enter'), { ...single, hasSubmit: true })).toBe('submit');
    expect(editorKeyAction(key('Enter', { ctrlKey: true }), multi)).toBe('submit');
    expect(editorKeyAction(key('Enter', { metaKey: true }), { ...multi, hasSubmit: false })).toBeNull();
    expect(editorKeyAction(key('/', { ctrlKey: true }), multi)).toBe('comment');
    expect(editorKeyAction(key('F', { ctrlKey: true, shiftKey: true, code: 'KeyF' }), multi)).toBe('format');
    expect(editorKeyAction(key(' ', { ctrlKey: true }), single)).toBe('complete');
    expect(editorKeyAction(key('a'), multi)).toBeNull();
  });

  it('drives the completion list while it is open', () => {
    const open = { ...multi, popupOpen: true };
    expect(editorKeyAction(key('ArrowDown'), open)).toBe('down');
    expect(editorKeyAction(key('ArrowUp'), open)).toBe('up');
    expect(editorKeyAction(key('Enter'), open)).toBe('accept');
    expect(editorKeyAction(key('Tab'), open)).toBe('accept');
    expect(editorKeyAction(key('Escape'), open)).toBe('close');
    expect(editorKeyAction(key('Enter', { ctrlKey: true }), open)).toBe('submit');
    expect(editorKeyAction(key('Escape'), multi)).toBeNull();
  });
});

describe('edits', () => {
  it('indents a caret and shifts every selected line, and shifts them back', () => {
    expect(indentSelection(st('ab', 1), false)).toEqual({ text: 'a  b', start: 3, end: 3 });
    const sel = indentSelection(st('one\ntwo\nthree', 1, 9), false);
    expect(sel).toEqual({ text: '  one\n  two\n  three', start: 3, end: 15 });
    expect(indentSelection(sel, true)).toEqual({ text: 'one\ntwo\nthree', start: 1, end: 9 });
    expect(indentSelection(st('  x', 3), true)).toEqual({ text: 'x', start: 1, end: 1 });
  });

  it('a new line keeps the indentation and opens a parenthesis one level deeper', () => {
    expect(newlineWithIndent(st('  a'))).toEqual({ text: '  a\n  ', start: 6, end: 6 });
    expect(newlineWithIndent(st('f(', 2))).toEqual({ text: 'f(\n  ', start: 5, end: 5 });
    expect(newlineWithIndent(st('f()', 2))).toEqual({ text: 'f(\n  \n)', start: 5, end: 5 });
  });

  it('comments lines out and back in', () => {
    const on = toggleLineComment(st('a\n  b', 0, 5));
    expect(on).toEqual({ text: '-- a\n  -- b', start: 0, end: 11 });
    expect(toggleLineComment(on)).toEqual({ text: 'a\n  b', start: 0, end: 5 });
    expect(toggleLineComment(st('x = 1', 2))).toEqual({ text: '-- x = 1', start: 5, end: 5 });
  });

  it('closes parentheses and quotes, wraps a selection, steps over a closer, and deletes an empty pair', () => {
    expect(autoClosePair(st('a = ', 4), '(')).toEqual({ text: 'a = ()', start: 5, end: 5 });
    expect(autoClosePair(st('a = ', 4), "'")).toEqual({ text: "a = ''", start: 5, end: 5 });
    expect(autoClosePair(st('a = x', 4), '(')).toBeNull(); // something follows
    expect(autoClosePair(st("it", 2), "'")).toBeNull(); // apostrophe
    expect(autoClosePair(st('f(x)', 2, 3), '(')).toEqual({ text: 'f((x))', start: 3, end: 4 });
    expect(stepOverClosing(st('()', 1), ')')).toEqual({ text: '()', start: 2, end: 2 });
    expect(stepOverClosing(st('(a', 2), ')')).toBeNull();
    expect(deleteEmptyPair(st("a = ''", 5))).toEqual({ text: 'a = ', start: 4, end: 4 });
    expect(deleteEmptyPair(st("a = 'x'", 5))).toBeNull();
  });

  it('inserts a snippet at the caret with the spacing a chip wants', () => {
    expect(insertSnippet(st('quantity *', 10), 'unit_price_cents', { spaced: true })).toEqual({ text: 'quantity * unit_price_cents', start: 27, end: 27 });
    expect(insertSnippet(st('a  b', 2), 'x', { spaced: true })).toEqual({ text: 'a x b', start: 3, end: 3 });
    expect(insertSnippet(st('sum(', 4), 'quantity', { spaced: true })).toEqual({ text: 'sum(quantity', start: 12, end: 12 });
    expect(insertSnippet(st('a, b', 1, 3), 'x')).toEqual({ text: 'axb', start: 2, end: 2 });
    expect(insertSnippet(st(''), 'COALESCE()', { caretBack: 1 })).toEqual({ text: 'COALESCE()', start: 9, end: 9 });
  });

  it('converts between offsets and line/column', () => {
    expect(lineColAt('ab\ncd', 4)).toEqual({ line: 2, col: 2 });
    expect(offsetOfLine('ab\ncd\nef', 2, 2)).toBe(4);
    expect(offsetOfLine('ab\ncd', 9)).toBe(5);
    expect(offsetOfLine('ab\ncd', 1, 99)).toBe(2);
  });
});
