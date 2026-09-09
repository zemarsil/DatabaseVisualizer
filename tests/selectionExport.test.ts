import { describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { emptyDiagram, createRelationship } from '../src/lib/model';
import { importSql } from '../src/lib/sql/import';
import { markdownToHtml } from '../src/lib/markdownToHtml';
import { decodeClipboard } from '../src/lib/clipboard';
import { selectionFlavors, selectionHtml, selectionMarkdown, selectionSql, sliceSelection } from '../src/lib/selectionExport';

const SHOP = `
CREATE TYPE order_status AS ENUM ('new', 'paid');
CREATE TABLE customers (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE);
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status order_status NOT NULL DEFAULT 'new',
  total NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  qty INTEGER NOT NULL
);
CREATE INDEX idx_items_order ON order_items (order_id);
`;

function shop(): Diagram {
  const d = emptyDiagram('postgresql', 'Shop');
  const r = importSql(SHOP, 'postgresql');
  d.tables = r.tables;
  d.relationships = r.relationships;
  d.customTypes = r.customTypes;
  return d;
}

const idOf = (d: Diagram, name: string) => d.tables.find((t) => t.name === name)!.id;

describe('sliceSelection', () => {
  it('keeps only the connections whose two ends are both selected', () => {
    const d = shop();
    const slice = sliceSelection(d, [idOf(d, 'orders'), idOf(d, 'order_items')]);
    expect(slice.diagram.tables.map((t) => t.name)).toEqual(['orders', 'order_items']);
    expect(slice.diagram.relationships).toHaveLength(1);
    expect(slice.omitted).toHaveLength(1);
    expect(slice.omitted[0].sourceTableId).toBe(idOf(d, 'orders'));
  });

  it('carries the custom types the selected columns actually use', () => {
    const d = shop();
    expect(sliceSelection(d, [idOf(d, 'orders')]).diagram.customTypes.map((t) => t.name)).toEqual(['order_status']);
    expect(sliceSelection(d, [idOf(d, 'customers')]).diagram.customTypes).toEqual([]);
  });

  it('follows the diagram table order, not the order the ids arrive in', () => {
    const d = shop();
    const slice = sliceSelection(d, [idOf(d, 'order_items'), idOf(d, 'customers')]);
    expect(slice.diagram.tables.map((t) => t.name)).toEqual(['customers', 'order_items']);
  });

  it('ignores ids that are not in the diagram', () => {
    const d = shop();
    expect(sliceSelection(d, ['nope']).diagram.tables).toEqual([]);
  });
});

describe('selectionSql', () => {
  it('writes the CREATE statements for the selection with a blank line between them', () => {
    const d = shop();
    const { text } = selectionSql(d, [idOf(d, 'customers'), idOf(d, 'orders')]);
    expect(text).toContain('CREATE TABLE customers');
    expect(text).toContain('CREATE TABLE orders');
    expect(text).toMatch(/\);\n\n/);
  });

  it('keeps a foreign key inside the selection and drops the one that leaves it', () => {
    const d = shop();
    const { text } = selectionSql(d, [idOf(d, 'customers'), idOf(d, 'orders')]);
    expect(text).toContain('REFERENCES customers');
    expect(text).not.toContain('CREATE TABLE order_items');
  });

  it('says which connections were left out', () => {
    const d = shop();
    const { text } = selectionSql(d, [idOf(d, 'orders'), idOf(d, 'order_items')]);
    expect(text).toContain('1 connection to a table outside this copy was left out');
    expect(text).toContain('customers is not part of this copy');
  });

  it('says nothing about omissions when the selection is closed', () => {
    const d = shop();
    const all = d.tables.map((t) => t.id);
    expect(selectionSql(d, all).text).not.toContain('left out');
  });

  it('brings along the enum a selected column is typed with', () => {
    const d = shop();
    expect(selectionSql(d, [idOf(d, 'orders')]).text).toContain('CREATE TYPE order_status');
    expect(selectionSql(d, [idOf(d, 'customers')]).text).not.toContain('CREATE TYPE');
  });

  it('is empty for an empty selection', () => {
    expect(selectionSql(shop(), []).text).toBe('');
  });
});

describe('selectionMarkdown', () => {
  it('is a fragment: table sections and connections, no title or diagram summary', () => {
    const d = shop();
    const md = selectionMarkdown(d, [idOf(d, 'customers'), idOf(d, 'orders')]);
    expect(md).not.toContain('# Shop');
    expect(md).not.toContain('```mermaid');
    expect(md).toContain('## customers');
    expect(md).toContain('## orders');
    expect(md).toContain('| Column | Type | Nullable | Default | Key | Check | Comment |');
    expect(md).toContain('| customer_id | INTEGER | no |');
    expect(md).toContain('## Relationships');
  });

  it('lists what the selection cut off', () => {
    const d = shop();
    const md = selectionMarkdown(d, [idOf(d, 'orders'), idOf(d, 'order_items')]);
    expect(md).toContain('_1 connection to a table outside this copy was left out:_');
    expect(md).toContain('- orders');
  });

  it('appends the DDL in a sql fence when asked', () => {
    const d = shop();
    const md = selectionMarkdown(d, [idOf(d, 'orders')], { includeSql: true });
    expect(md).toContain('## SQL');
    expect(md).toContain('```sql');
    expect(md).toContain('CREATE TABLE orders');
  });

  it('is empty for an empty selection', () => {
    expect(selectionMarkdown(shop(), [])).toBe('');
  });
});

describe('selectionHtml', () => {
  it('mirrors the markdown as a real HTML table so rich-text targets can convert it back', () => {
    const d = shop();
    const html = selectionHtml(d, [idOf(d, 'orders')], { includeSql: true });
    expect(html).toContain('<h2>orders</h2>');
    expect(html).toContain('<th>Column</th>');
    expect(html).toContain('<td>customer_id</td>');
    expect(html).toContain('<pre><code class="language-sql">');
  });

  it('is empty for an empty selection', () => {
    expect(selectionHtml(shop(), [])).toBe('');
  });
});

describe('markdownToHtml', () => {
  it('renders headings, tables, lists, code fences and inline marks', () => {
    const html = markdownToHtml(['## Title', '', '| A | B |', '| --- | --- |', '| `x` | **y** |', '', '- one', '- two', '', '```sql', 'SELECT 1;', '```'].join('\n'));
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(html).toContain('<td><code>x</code></td>');
    expect(html).toContain('<td><strong>y</strong></td>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<pre><code class="language-sql">SELECT 1;</code></pre>');
  });

  it('leaves underscores inside identifiers alone', () => {
    expect(markdownToHtml('| customer_id | order_id |\n| --- | --- |\n| a | b |')).toContain('<th>customer_id</th><th>order_id</th>');
  });

  it('unescapes the pipes markdown cells had to escape, and escapes HTML', () => {
    const html = markdownToHtml('| Check |\n| --- |\n| a \\| b <c> |');
    expect(html).toContain('<td>a | b &lt;c&gt;</td>');
  });

  it('renders italics written with underscores at word boundaries', () => {
    expect(markdownToHtml('_(view)_')).toContain('<em>(view)</em>');
  });
});

describe('non-foreign-key connections', () => {
  it('documents a data flow that stayed in the selection and drops one that did not', () => {
    const d = shop();
    d.relationships.push(
      createRelationship({ kind: 'flow', sourceTableId: idOf(d, 'orders'), targetTableId: idOf(d, 'order_items'), sourceColumnIds: [], targetColumnIds: [] }),
      createRelationship({ kind: 'flow', sourceTableId: idOf(d, 'customers'), targetTableId: idOf(d, 'orders'), sourceColumnIds: [], targetColumnIds: [] }),
    );
    const slice = sliceSelection(d, [idOf(d, 'orders'), idOf(d, 'order_items')]);
    expect(slice.diagram.relationships.filter((r) => r.kind === 'flow')).toHaveLength(1);
    expect(slice.omitted.filter((r) => r.kind === 'flow')).toHaveLength(1);
    expect(selectionSql(d, [idOf(d, 'orders'), idOf(d, 'order_items')]).text).toContain('[flow]');
  });
});

describe('clipboard flavors', () => {
  it('offers the DDL as text, the data dictionary as HTML and the fragment as JSON', () => {
    const d = shop();
    const ids = [idOf(d, 'orders'), idOf(d, 'order_items')];
    const flavors = selectionFlavors(d, ids)!;
    expect(flavors.text).toContain('CREATE TABLE orders');
    expect(flavors.text).toContain('CREATE TABLE order_items');
    expect(flavors.html).toContain('<h2>orders</h2>');
    expect(flavors.html).toContain('<pre><code class="language-sql">');
    expect(decodeClipboard(flavors.json)!.tables.map((t) => t.name)).toEqual(['orders', 'order_items']);
  });

  it('has nothing to offer for an empty selection', () => {
    expect(selectionFlavors(shop(), [])).toBeNull();
  });

  it('has nothing to offer when no selected id is a table any more', () => {
    expect(selectionFlavors(shop(), ['gone', 'also-gone'])).toBeNull();
  });
});

describe('anchors in the HTML flavor', () => {
  it('keeps a real link but flattens a same-page anchor, which means nothing off-page', () => {
    expect(markdownToHtml('[docs](https://example.com/x)')).toContain('<a href="https://example.com/x">docs</a>');
    const html = markdownToHtml('**Referenced by** [addresses](#addresses)');
    expect(html).toContain('<strong>Referenced by</strong> addresses');
    expect(html).not.toContain('<a ');
  });
});

describe('cell text that looks like markup', () => {
  const withCheck = (): Diagram => {
    const d = shop();
    const orders = d.tables.find((t) => t.name === 'orders')!;
    orders.columns.find((c) => c.name === 'total')!.check = 'total * 2 * 3 > 0';
    orders.columns.find((c) => c.name === 'total')!.comment = 'uses `total` and a | pipe';
    return d;
  };

  it('survives a markdown renderer: the asterisks are escaped, not emphasis', () => {
    const d = withCheck();
    const md = selectionMarkdown(d, [idOf(d, 'orders')]);
    expect(md).toContain('CHECK (total \\* 2 \\* 3 > 0)');
    expect(md).toContain('\\`total\\`');
  });

  it('reaches the HTML flavor with the expression intact', () => {
    const d = withCheck();
    const html = selectionHtml(d, [idOf(d, 'orders')]);
    expect(html).toContain('<td>CHECK (total * 2 * 3 &gt; 0)</td>');
    expect(html).toContain('<td>uses `total` and a | pipe</td>');
    // The only emphasis in the fragment is the note about what was left out.
    expect(html.slice(0, html.indexOf('</table>'))).not.toContain('<em>');
  });

  it('does not carry a javascript: link into whatever the user pastes into', () => {
    expect(markdownToHtml('see [docs](javascript:alert)')).toBe('<p>see docs</p>');
    expect(markdownToHtml('see [docs](data:text/html;base64,x)')).not.toContain('<a ');
    expect(markdownToHtml('see [docs](https://example.com)')).toContain('<a href="https://example.com">docs</a>');
  });

  it('stops a table at the first line that is not a row', () => {
    const html = markdownToHtml('| a | b |\n| --- | --- |\n| x | y |\ntrailing | pipe line');
    expect(html).toContain('<tbody><tr><td>x</td><td>y</td></tr></tbody>');
    expect(html).toContain('<p>trailing | pipe line</p>');
  });
});

describe('one table on its own', () => {
  it('is runnable: the enum comes along and the foreign key that would dangle does not', () => {
    const d = shop();
    const { text } = selectionSql(d, [idOf(d, 'orders')]);
    expect(text).toContain('CREATE TYPE order_status');
    expect(text).toContain('CREATE TABLE orders');
    expect(text).not.toContain('REFERENCES customers');
    expect(text).toContain('customers is not part of this copy');
  });
});

describe('generator warnings', () => {
  it('are written into the script instead of being dropped on the floor', () => {
    const d = shop();
    d.dialect = 'sqlite';
    d.tables.find((t) => t.name === 'orders')!.schema = 'shop';
    const out = selectionSql(d, [idOf(d, 'orders')]);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.text).toContain('-- Worth knowing:');
    expect(out.text).toContain('SQLite has no schemas');
  });
});
