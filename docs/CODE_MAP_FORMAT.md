# Code maps: how a codebase is written into a diagram

A schema says what the database holds. A code map says what talks to it: the
programs, the files inside them, the classes inside those, the functions that
actually run a `SELECT` or an `INSERT`, and the calls and imports between them.
The point of putting both on one canvas is that *"this function reads that
table"* is one arrow in one picture, and *"what breaks if I drop this column"*
is a **Trace** rather than a grep.

This document is the file format for that half of the diagram. It is written
for someone producing a `.dbviz.json` by hand or from a script — an advisor
agent, a person with a text editor, a scanner over a repository — and it is the
companion to [`ADVISOR_OUTPUT_FORMAT.md`](ADVISOR_OUTPUT_FORMAT.md), which
documents everything else in the file. There is a scanner in the box:
[`scripts/scan_code.py`](#scanning-a-codebase), which reads Python, Rust, Go, C,
C++, Java, JavaScript, TypeScript, Perl and the shell, and walks the YAML and
JSON files they read. The walkthrough that builds a map by hand
is [`walkthroughs/16-map-the-code-that-talks-to-it.md`](walkthroughs/16-map-the-code-that-talks-to-it.md).

## One node family, five kinds

There is no separate "module" object. Everything in the code map is the same
node the diagram already had for a program — *a node whose ordered steps are
the things it does* — with a `kind` and, optionally, a `parentId` saying what
it sits inside. That is deliberate: a function that reads a table and a program
that reads a table are drawn, annotated, traced, exported and linted by the
same code, so a feature that works for one cannot quietly not work for the
other.

| `kind` | Is | May sit inside | May hold |
| --- | --- | --- | --- |
| `program` (the default, left unwritten) | something that runs: a service, a job, a script | nothing — a program is a root | modules, classes, functions, data files |
| `module` | a file or a package | a program, or another module | modules, classes, functions, data files |
| `class` | a class, a struct, a type with methods | a program, a module, or another class | classes, functions |
| `function` | a function or a method | a program, a module or a class | nothing — a function is a leaf |
| `data` | a YAML or JSON file other code reads | a program or a module | nothing — and it does nothing either |

The last one is the only node that is not code. Nothing runs in a YAML or JSON
file, so a data file has **no steps at all**, and the only arrow it may be on
the end of is a [`load`](#steps-the-ordered-list-of-what-a-node-does). Its
`kind` and its `language` are two halves of one fact: a node written in `yaml`
or `json` loads as a data file whatever kind it claims, a data file written in
anything else loads as `yaml`, and steps written on one are dropped on load
rather than kept where they could never happen.

A `.dbviz.json` written before code maps existed has only programs and no
`kind` or `parentId` anywhere, and it loads unchanged. A file written *by* this
version and opened by an older one loses the two fields and shows every node at
the top level: nothing else is lost, because everything else about a node was
already there.

## The node

```json
{
  "id": "fn_place_order",
  "name": "place_order",
  "kind": "function",
  "parentId": "cls_order_service",
  "language": "python",
  "entrypoint": "def place_order(self, email, cart) -> int",
  "comment": "Turns a cart into an order and its lines, then reserves the stock for each line.",
  "color": "pink",
  "position": { "x": -780, "y": 90 },
  "steps": [
    { "id": "stp_po_read_customers", "op": "read", "tableId": "tbl_customers",
      "columnIds": ["col_customers_id", "col_customers_email"],
      "sql": "SELECT id FROM customers WHERE email = %s", "note": "who is buying" },
    { "id": "stp_po_price", "op": "compute", "columnIds": [], "note": "total the cart in cents" },
    { "id": "stp_po_write_orders", "op": "write", "tableId": "tbl_orders",
      "columnIds": ["col_orders_customer_id", "col_orders_status", "col_orders_total_cents"] },
    { "id": "stp_po_call_reserve", "op": "call", "columnIds": [], "codeId": "fn_reserve_stock",
      "note": "once per line, inside the same transaction" }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique across the whole file, like every other id. Readable ones — `prg_api`, `mod_orders`, `cls_order_service`, `fn_place_order` — make the cross-references reviewable. |
| `name` | yes | What the node is called. `orders.py`, `OrderService`, `place_order`. Names only have to be unique among **siblings** — two classes may each have a `save` — and **Problems** says so when they are not. |
| `kind` | no | `module`, `class`, `function` or `data`. Omit it for a program; a program is written without the field so old files and new ones agree byte for byte. |
| `parentId` | no | The id of the node this one sits inside. Omit it for a top-level node. |
| `collapsed` | no | `true` folds a container to a single node on the canvas. See [Collapsing](#collapsing-what-a-folded-container-stands-in-for). Meaningless on a function. |
| `language` | no | Same list as a program: `python`, `rust`, `go`, `cpp`, `c`, `java`, `javascript`, `typescript`, `perl`, `shell`, `yaml`, `json`, `other`. Defaults to `other`. A member added in the app inherits its container's language. `yaml` and `json` are the two nothing runs in, and a node written in one is a data file. |
| `role` | no | `service`, `job`, `script` or `etl`. **Programs only**; on any other kind it is dropped on load, because a file is not scheduled. |
| `entrypoint` | no | Free text with a per-kind meaning: where a program starts, a module's path, a class's declaration, a function's signature. The inspector labels the box accordingly. A function's, when it reads as a signature in the node's own language, is the signature the generated starter writes. |
| `comment` | no | What it is for. Travels into the SQL annotation block, the Markdown export and the DBML note. |
| `color`, `position` | no | As for a table. For an **expanded container** the position is only an anchor — see [What is derived](#what-is-derived-never-stored). |
| `steps` | no | Ordered. What the node does, in the order it does it. |

## Steps

A step is one thing the node does. The order is the point: it is what makes
*read, compute, write* a round trip on the canvas instead of three unrelated
arrows.

| `op` | Means | Carries | Draws |
| --- | --- | --- | --- |
| `read` | a `SELECT` | `tableId`, `columnIds` (empty means the whole row), `sql`, `code`, `note` | a numbered arrow from the table to the node |
| `write` | an `INSERT`, `UPDATE` or `DELETE` | the same | a numbered arrow from the node to the table |
| `compute` | work the database never sees | `code`, `note` | nothing; the step number is skipped on the canvas |
| `call` | hands control or data to another function, class or program | `codeId`, `code`, `note` | a numbered dashed arrow to that node |
| `import` | depends on another module, or on a name defined in one | `codeId`, `code`, `note` | a dotted arrow with an open head to that node |
| `extends` | inherits from another class | `codeId`, `code`, `note` | a solid arrow with a hollow head to that node |
| `load` | reads values out of a data file: settings, fixtures, a lookup table | `codeId`, `code`, `note` | a finely dotted arrow to that data file |

A `load` is separate from an `import` because it happens at run time and what
it names runs nothing, and separate from a `read` because a file is not a
table. It is also the only op that may name a `data` node, and `call`, `import`
and `extends` are the only ops that may not: **Problems** reports either
mistake with a one-click fix that changes the op rather than throwing the step
away.

Only `read` and `write` may name a table; only `call`, `import`, `extends` and
`load` may name code. The loader strips a `tableId` or `sql` from any other kind of
step and a `codeId` from a step that is not a code step, rather than drawing
something the step cannot mean. `columnIds` is always present and always empty
on every step that is not a `read` or a `write`.

A step whose `codeId` names nothing in the file, or whose `tableId` does, is
**kept**: its `sql`, `code` and `note` are the part nobody can reconstruct, so
the app never discards them on its own. It draws no arrow and **Problems**
reports it with a one-click fix that removes the step once you agree.

## What is derived, never stored

The file holds nodes, parent pointers and steps. Everything else on the canvas
is computed from those every time, the same way a group's rectangle is computed
from where its member tables sit:

- **Every arrow.** A `read` or `write` step draws the arrow between its node and
  its table; a `call`, `import` or `extends` step draws the arrow between its
  node and the node it names. Reorder the steps and the numbers move; delete a
  step and its arrow is gone. There is no edge object to get out of step with
  the step that means it.
- **Every container's region.** An expanded module is drawn as a box around its
  members, and the box is the bounding rectangle of whatever is inside it plus a
  margin and a title strip, computed bottom-up so a class's box fits inside its
  module's box. Dragging a member grows the region; dragging the region's title
  bar moves every member with it. A node's `position` is where *it* sits;
  for a container that has members it is only an anchor, used while the
  container is empty or collapsed.
- **Who stands in for whom** when something is collapsed — next section.

So a scanner writing this file only has to place the leaves. Give each
function a position inside its file's area and the regions follow.

## Collapsing: what a folded container stands in for

`"collapsed": true` on a container folds it to one node the size of a program,
badged with how many nodes it hides. Its members keep their positions and are
simply not drawn — expand it again and they are where they were.

The arrows fold with it. Every arrow whose end is inside the folded container
is redrawn from the container instead, and arrows that then say the same thing
are gathered into one: three functions in `orders.py` that each read
`customers` become one arrow, `orders.py` reads `customers`, carrying a count.
A call between two functions of the same folded module is inside the node now,
so it is not drawn at all. Collapse a whole program and the canvas shows what
walkthroughs 00 to 15 would have shown for it: one node, one arrow per table
and operation.

Only the outermost collapsed container counts. A class folded inside a folded
module is not drawn either, and it is the module that answers for the class's
functions.

## Paths: how the SQL block and the walkthroughs name a node

An id means nothing once a file has been re-imported, and a bare name is
ambiguous the moment two classes each have a `save`. So wherever a code node is
named outside its own file, it is named by its **path**: its containers' names
and its own, joined with `/`.

```
bookshop_api/orders.py/OrderService/place_order
```

The SQL annotation block, the walkthrough `checks:` and step `goals:`, the
Markdown export's step tables and the command palette all use this form. Where
a path is *read* rather than written — a walkthrough goal, a `code:` step
target — a bare name is also accepted as long as exactly one node in the map
carries it, so `calls | place_order -> reserve_stock` need not spell out
containers nobody would confuse.

## The SQL annotation block

Nothing in the code map reaches a `CREATE TABLE`. The whole map rides in the
same `-- dbviz:connections` comment block the data flows and tagged queries
use, and **Import SQL** reads it back, so exporting a diagram and importing it
again returns what was exported — code and all.

```sql
-- dbviz:connections v1
-- {
--   "connections": [ … ],
--   "programs": [
--     {
--       "name": "bookshop_api",
--       "language": "python",
--       "role": "service",
--       "entrypoint": "services/api/main.py",
--       "steps": []
--     },
--     {
--       "name": "orders.py",
--       "kind": "module",
--       "parent": "bookshop_api",
--       "language": "python",
--       "steps": [
--         { "op": "import", "target": "bookshop_api/inventory.py", "note": "for reserve_stock" }
--       ]
--     },
--     {
--       "name": "place_order",
--       "kind": "function",
--       "parent": "bookshop_api/orders.py/OrderService",
--       "language": "python",
--       "entrypoint": "def place_order(self, email, cart) -> int",
--       "steps": [
--         { "op": "read", "table": "customers", "columns": ["id", "email"], "sql": "SELECT id FROM customers WHERE email = %s" },
--         { "op": "compute", "note": "total the cart in cents" },
--         { "op": "write", "table": "orders", "columns": ["customer_id", "status", "total_cents"] },
--         { "op": "call", "target": "bookshop_api/inventory.py/reserve_stock" }
--       ]
--     }
--   ]
-- }
-- dbviz:end
```

The differences from the `.dbviz.json` form are the ones every other entry in
the block has: **names, never ids**. `parentId` becomes `parent`, the path of
the container; a step's `codeId` becomes `target`, the path of the node it
names; `tableId` and `columnIds` become `table` and `columns`. `kind` and
`collapsed` are written only when they are not the default.

Import restores the nodes in two passes — every node first, then the parents
and targets by path — so a function may name a module written after it, and
the order of the array does not matter. A `parent` the script does not
describe leaves the node at the top level with a warning; a `target` it does
not describe keeps the step (and its code) with a warning, exactly as a `table`
that is missing does. Nothing is silently dropped.

## Where the map shows up

- **The canvas.** Programs and functions are nodes with their steps listed;
  modules and classes are regions with a title strip, or a single node when
  collapsed. Drag a node into a region to move it inside; drag it out to move it
  up a level. Drag the handle on a node's header onto another code node to draw
  a call (an import when it leaves a module, an extends between two classes).
  Between code and a table the rows travel the way you drag: from a table's
  handle onto a node adds a read, from the node's header onto a table adds a
  write.
- **Trace.** Either end of a trace may be a code node, and a path may run
  through code: `place_order → stock_levels` is *place_order calls
  reserve_stock; reserve_stock reads stock_levels*. A path that runs through
  code has no single query, so the **Trace** tab prints the hops as a comment
  rather than a `JOIN` it would have to invent.
- **Focus** (the full-stop key with a node selected) treats code nodes as
  neighbours of the tables they touch, so a function's neighbourhood is the
  tables it reads and writes and the functions it calls.
- **Markdown** gets a `## Code` section — one subsection per node in tree
  order, its step table naming tables and code by path — and a *touched from
  outside the database* list on every table something reads or writes.
  **Mermaid** draws each node as an entity carrying a `%% kind: name in
  container` comment; **DBML**, which has only tables, keeps each as a `Note`.
- **The generated starter.** Asking a container for one gets the file it
  stands for: the classes and functions drawn inside it written out as real
  definitions, nested where the language can nest them and hoisted with a
  comment where it cannot, all sharing one namespace so two functions never
  collide over a constant. A **module** ends the file — one inside another gets
  a starter of its own and is only named in the header — which is why a program
  never swallows its modules. `import` steps become import lines, `extends`
  steps become the base class in the declaration, and `entrypoint` becomes the
  signature whenever what it holds reads as one in the file's own language.
- **Copy and paste.** Copying a container copies everything inside it; a paste
  into another diagram re-points the steps at the pasted copies of their tables
  and keeps the ones whose tables did not come along.
- **Share links** and the browser library carry the whole map, because both
  carry the whole diagram.

## What Problems says about it

| Rule | Severity | Says |
| --- | --- | --- |
| `code-cannot-contain` | warning | a function inside a function, a module inside a class: the parent pointer names a kind that cannot hold this one. Fix: move it up a level. |
| `code-empty-container` | info | a module or class with nothing in it and no steps of its own; it draws as an empty region. |
| `code-uncalled-function` | info | nothing in the map calls this function. Either it is an entry point — a route, `main`, a handler the framework reaches — or the call has not been drawn yet. Only raised once the map has at least one call, so a plain program never sees it. |
| `code-step-without-target` | warning | a `call`, `import`, `extends` or `load` that names nothing, so it draws no arrow. |
| `code-step-missing-target` | error | it names a node that is no longer in the diagram. The step and its code stay; the fix removes the step, and is never applied in bulk. |
| `code-step-names-itself` | warning | a module that imports itself, a class that extends itself. A function calling itself is recursion and is left alone. |
| `code-step-op-mismatch` | warning | a `load` naming something that is not a data file, or a `call`, `import` or `extends` naming one. Nothing runs in a YAML or JSON file, so it can only be loaded. Fix: change the op; the step keeps its code and its note. |
| `code-data-unread` | info | a data file nothing in the map loads. A YAML or JSON file is on the canvas because something reads it, so either that step has not been drawn or the file is no longer used. |
| `code-import-cycle` | warning | `a imports b imports a`: the circular import that fails at run time and hides well in a big map. Reported once per cycle. |
| `duplicate-program-name` | warning | two nodes with the same name **in the same container**. Siblings only; `Order.save` and `Customer.save` are fine. |

The program rules still apply to every kind: a `write` to a column a data flow
already computes, a write to a view or to a table marked as living in another
database, a step naming a table that is gone.

## Scanning a codebase

Drawing a map by hand is the right way to design a service. Drawing one by hand
for a service that already exists is an afternoon of grep, so there is a
scanner:

```bash
python3 scripts/scan_code.py services/api --into bookshop.dbviz.json -o mapped.dbviz.json
```

It needs nothing but Python 3.9 or newer, whatever the code it is pointed at is
written in, and it writes the whole file back out with the map in it, leaving
everything else in the diagram alone. Without `--into` it writes a new diagram
whose tables are the ones the queries implied.

### The languages it reads

| Language | Files | Read with |
| --- | --- | --- |
| Python | `.py` | the standard library's own `ast` |
| Rust | `.rs` | the tolerant lexer |
| Go | `.go` | the tolerant lexer |
| Java | `.java` | the tolerant lexer |
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | the tolerant lexer |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | the tolerant lexer |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` | the tolerant lexer |
| C | `.c` `.h` | the tolerant lexer |
| Perl | `.pl` `.pm` | the tolerant lexer |
| Shell | `.sh` `.bash` | the tolerant lexer |
| YAML | `.yaml` `.yml` | not read at all — the file becomes a data node |
| JSON | `.json` | not read at all — the file becomes a data node |

Everything in one tree is read at once, so a service whose API is TypeScript
and whose workers are Go arrives as one program with both in it; `--lang`
narrows it to one, and also settles whether a `.h` is C or C++.

Python is parsed, which is why a `def` inside a string is not a function and a
commented-out query is not a step. The other nine get a lexer instead — it
knows comments, strings, numbers, words and punctuation, and works out
declarations from where the blocks open and close. That is less than a parser
and more than a regex, and the difference from a regex is the point: a `SELECT`
inside a comment is a comment, a brace inside a string is not a brace, and
`"INSERT INTO " + table` is one string with a hole in it.

The shell is the one that stretches the word "brace": its blocks are `then …
fi` and `do … done`, and what the walk actually needs from it is `name() {` and
the `}` that ends it. Perl and the shell also bring the heredoc, which is how
both of them write a long query — it is read at its `<<SQL` and skipped where
its body sits, so `my $sql = <<'SQL';` stays one statement. In both, a `$name`
inside a double-quoted string or an unquoted heredoc is a hole, spelled `{name}`
like every other hole, so a query built by interpolation is reported rather than
drawn as one naming a table called `$table`.

YAML and JSON are walked and never read: nothing runs in one, so there is
nothing in it to read. What each file becomes is a `data` node, and what puts it
on the canvas is something else naming it — a string holding its path
(`open("config/settings.yaml")`, `yq … config/settings.yaml`) or a JavaScript
`import rates from './rates.json'`, which is read as the run-time file read it
really is. A data file nothing loads is dropped like any other node nothing
reaches, so a repository full of YAML does not become a map full of it, and
`package.json`, `package-lock.json`, `tsconfig*.json` and `composer.json` are
excluded outright as build metadata rather than anything a program reads.

### What it reads

- **The shape.** One program per source you give it; a directory becomes a
  module, a file becomes a module inside that, and a package's `__init__.py` is
  the package rather than a file in it. Classes and functions are nodes; a
  function inside a function is not, because a function is the leaf of the map —
  its queries and calls belong to the function that holds it. Each language's
  own way of spelling the same thing is followed: a Go method hangs off the type
  in its receiver, every `impl Foo` in Rust adds methods to the one `Foo`, a C++
  `namespace` is a module, and a C or C++ header is read into the same node as
  the source file beside it rather than drawn as a second copy of every
  function in it.
- **The queries.** String literals that *begin* with `SELECT`, `INSERT`,
  `UPDATE`, `DELETE`, `REPLACE`, `MERGE`, `TRUNCATE` or `WITH` and go on to have
  the shape of one — an `UPDATE` has a `SET`, a `DELETE` has a `FROM` — which is
  what keeps "Update the stock count whenever an order is placed" a sentence
  rather than a write arrow. However the language writes a long one: a Rust
  `r#"…"#`, a C++ `R"sql(…)sql"`, a Java text block, a Go or JavaScript
  backtick. Literals concatenated with `+` are folded first, as are the adjacent
  literals C uses for the same job; an f-string, a template literal and a value
  glued in with `+` all keep their holes as `{expr}`. A statement's tables come off its `FROM`, `JOIN`, `INTO` and
  `UPDATE` clauses at any depth, so a subquery in a `WHERE` is the read it is.
  A query parked in a module-level or class-level constant is a step on
  *whatever names it*, not on the file that holds it.
- **The columns.** What a write names as its target — the `INSERT` column list,
  the `SET` assignments — is what the write touches. Every other column the
  statement mentions belongs to the tables it reads, attributed by alias where
  it is qualified and by scope where it is not, so `SELECT title FROM books
  WHERE id IN (SELECT book_id FROM order_items …)` gives `title` to `books` and
  `book_id` to `order_items`. `SELECT *` is the whole row, which the format
  writes as no columns at all.
- **The links.** A call becomes a `call` step, an import of another scanned
  module an `import` step, a base class an `extends` step — `extends Base`,
  `implements Runnable`, `class Foo : public Bar`, `impl Restocker for
  WarehouseDesk` — and a data file the code names a `load` step. Names are
  resolved the way the language resolves them: whatever the receiver is called,
  first — `self`, `this`, `Self`, the `$self` in Perl, or the `r` in `func (r
  *Repo)` — then what the file imported, then what it defines. Perl's `package`
  line names the file the way Java's does, `use` is its import, and the shell's
  is `source`; a bare word at the start of a shell command is a call, kept only
  where it names a function the map actually holds, since otherwise every
  `echo` in the script would invent one. Import
  paths are matched from their tail, so `"github.com/acme/api/store"` finds the
  `store` package and `#include "store/orders.h"` finds `orders`. A name none of
  that explains falls back to the format's own rule for reading a path — a bare
  name will do where exactly one node in the map carries it — which
  `--strict-calls` turns off.
- **The prose.** A node's `comment` is the first paragraph of its docstring, or
  of the comment block written immediately above it: a `///`, a `/** … */`, the
  `// ReserveStock locks the row` a Go reader expects. A function carrying a
  decorator, an annotation or an attribute that is not `@staticmethod`,
  `@Override`, `#[derive]` and friends gets a sentence saying so: *Reached
  through `@app.post('/orders')`* — or `@PostMapping("/orders")`, or
  `#[post("/orders")]` — is the answer to "nothing calls this function".
- **The entrypoint.** A module's path, a class's declaration, a function's
  signature, as the source wrote it with the newlines taken out, so a signature
  split over six lines arrives as one.

### What it keeps

A repository of any size has thousands of functions and a handful that run a
query, and the code map exists to point at tables. So by default what survives
is the functions that touch the database, the ones that call those (`--callers
N` hops, one by default), the data files those read, and the containers they
all sit in. `--all` keeps everything. A call or an `extends` whose other end did not survive loses its
arrow with it — which means a base class whose methods never touch the database
is not drawn, and one whose methods do is kept by the same rule as everything
else.

### Tables, and tables it has never heard of

Steps point at the tables of the diagram named by `--into`, matched by name and
then by `schema.name`. A table the code names that the diagram has not got is
**invented**: a stub carrying the columns its queries named, a `slate` colour
and a comment saying where it came from. That is the lesser evil — a step
pointing at nothing draws no arrow and fails the validator below — and it is
also a useful signal, because a stub is either a table you forgot to draw or a
query naming one that is gone. `--no-stub-tables` leaves the reference dangling
instead, for **Problems** to report with its one-click fix. When the queries
named no columns at all (`DELETE FROM x` and nothing else) there is no stub to
write, so that reference dangles either way.

### What it cannot read

Everything that is not in the syntax:

- **ORMs and query builders.** `session.query(Order)`, `Order.objects.filter(…)`,
  a SQLAlchemy select over mapped classes, GORM, Diesel, Hibernate, Knex: the
  table name is in the mapping, not in any string. Those functions come out as
  plain calls with no read or write, and the tables they touch have to be added
  by hand. A query in an annotation the scanner can see — JPA's `@Query("SELECT
  …")` — is read, because that one *is* a string literal.
- **Queries assembled at run time** — a table name substituted into an
  f-string, a `WHERE` clause built by appending to a list, SQL read from a file.
  A statement with a hole in it is still read and still drawn, holes and all;
  one whose *table* is the hole draws nothing, and is counted in the report so
  you know to add the step yourself.
- **Dynamic dispatch.** A handler looked up in a registry, a callback passed in,
  a function pointer, a call through an interface whose implementation is chosen
  at run time, a method on an object whose type the scanner cannot know. Where
  the name is unique in the map it is guessed; otherwise the call is not drawn.
- **What a macro or a generated file invented.** A name that exists only after
  `cgo`, `bindgen`, a Rust `macro_rules!` or a C `#define` expands is not in the
  syntax the scanner reads.
- **`compute` steps.** Whether the work between a read and a write is worth a
  step is a judgement about what matters, and the scanner has no way to make
  it. Add those by hand; they are usually the most interesting line on the node.

One shape is worth knowing about because it is so common: in JavaScript and
TypeScript a route body written as an arrow function — `app.post('/orders',
async (req, res) => { … })` — is not a node, because there is no name to give
it. Its queries and calls belong to the file instead, which is where a reader
would look for them. Naming the handler makes it a node.

None of this is a reason not to scan — it is the reason the output is a first
draft to correct, the same as an imported schema. What the scanner is good at
is the tedious half: finding every query in forty files and getting the column
lists right.

### Scanning again

Ids are derived from the path of the node, so a second scan updates the map
rather than growing a second copy of it: the scan owns the program node it
writes and everything under it, and replaces exactly that. What it cannot work
out for itself comes back on the node with the same id — where you dragged it,
what colour you gave it, a comment you wrote where the code had no docstring —
unless you pass `--relayout`. Everything else in the diagram is untouched, so
pointing the scanner at `--into` the file it wrote last week is the normal way
to use it.

### The flags

| Flag | Does |
| --- | --- |
| `--into FILE` | the diagram to write into; its tables are what the steps point at. |
| `-o, --out FILE` | where to write (default: standard output). Pass the `--into` file to update it in place. |
| `--sheet NAME` | which diagram of a workspace file to write into. |
| `--name NAME`, `--role ROLE` | what to call the program, and whether it is a service, job, script or etl. |
| `--all`, `--callers N` | keep everything; or keep N call hops out from the database (default 1). |
| `--lang LANG` | read only this language, instead of every one found; also settles whether a `.h` file is C or C++. |
| `--exclude GLOB`, `--include-tests` | on top of the defaults, which skip `.*`, `__pycache__`, `node_modules`, `vendor`, `target`, virtualenvs, build output, `migrations`, `alembic`, `tests` and each language's own test-file convention (`*_test.go`, `*.test.ts`, `test_*.py`). |
| `--no-stub-tables` | never invent a table; leave the reference dangling. |
| `--collapse KIND` | fold every container of that kind, which is how a big map opens readable. |
| `--relayout` | lay every node out afresh, discarding where an earlier scan or a person put it. |
| `--strict-calls` | only draw a call the code names unambiguously. |

Whatever it could not work out — a file that would not parse, a table the
diagram has not got, a column a query names that its table has not — goes to
standard error, so the diagram on standard output stays a diagram.

## Checking a file

```bash
node scripts/validate-dbviz.mjs path/to/file.dbviz.json
```

For the code map it checks that every `kind` is one of the four, that every
`parentId` names a node in the file, is of a kind that may hold this one and
does not loop back to itself, that every `call`, `import` or `extends` names a
node in the file (and not the node it belongs to), that `extends` points at a
class, and that no step carries a field its `op` cannot have. The loader
tolerates all of these — a bad parent lands the node at the top level, a bad
target keeps the step without an arrow — which is exactly why the script is
worth running first: none of them produces an error in the app, only a map
that is quietly not the one you meant.

## Absorbed: the send / receive idea

An earlier sketch had programs exchanging messages with each other through a
separate `send` / `receive` pair. It is not built, and this design is why: a
message from one program to another is a `call` whose `note` says what is
passed and whose `code` holds the line that sends it, and a program that only
receives is the one with the arrow coming in. Two ops would have meant two more
edge shapes, two more lint rules and two more annotation keys for a distinction
the `note` already makes. If the direction of data ever needs to be drawn
separately from the direction of control, the place for it is a field on the
`call` step, not a new op.
