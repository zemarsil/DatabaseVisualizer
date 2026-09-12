# Code maps: how a codebase is written into a diagram

A schema says what the database holds. A code map says what talks to it: the
programs, the files inside them, the classes inside those, the functions that
actually run a `SELECT` or an `INSERT`, and the calls and imports between them.
The point of putting both on one canvas is that *"this function reads that
table"* is one arrow in one picture, and *"what breaks if I drop this column"*
is a **Trace** rather than a grep.

This document is the file format for that half of the diagram. It is written
for someone producing a `.dbviz.json` by hand or from a script — a scanner over
a repository, an advisor agent, a person with a text editor — and it is the
companion to [`ADVISOR_OUTPUT_FORMAT.md`](ADVISOR_OUTPUT_FORMAT.md), which
documents everything else in the file. The walkthrough that builds one by hand
is [`walkthroughs/16-map-the-code-that-talks-to-it.md`](walkthroughs/16-map-the-code-that-talks-to-it.md).

## One node family, four kinds

There is no separate "module" object. Everything in the code map is the same
node the diagram already had for a program — *a node whose ordered steps are
the things it does* — with a `kind` and, optionally, a `parentId` saying what
it sits inside. That is deliberate: a function that reads a table and a program
that reads a table are drawn, annotated, traced, exported and linted by the
same code, so a feature that works for one cannot quietly not work for the
other.

| `kind` | Is | May sit inside | May hold |
| --- | --- | --- | --- |
| `program` (the default, left unwritten) | something that runs: a service, a job, a script | nothing — a program is a root | modules, classes, functions |
| `module` | a file or a package | a program, or another module | modules, classes, functions |
| `class` | a class, a struct, a type with methods | a program, a module, or another class | classes, functions |
| `function` | a function or a method | a program, a module or a class | nothing — a function is a leaf |

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
| `kind` | no | `module`, `class` or `function`. Omit it for a program; a program is written without the field so old files and new ones agree byte for byte. |
| `parentId` | no | The id of the node this one sits inside. Omit it for a top-level node. |
| `collapsed` | no | `true` folds a container to a single node on the canvas. See [Collapsing](#collapsing-what-a-folded-container-stands-in-for). Meaningless on a function. |
| `language` | no | Same list as a program: `python`, `rust`, `go`, `cpp`, `c`, `java`, `javascript`, `typescript`, `csharp`, `ruby`, `shell`, `other`. Defaults to `other`. A member added in the app inherits its container's language. |
| `role` | no | `service`, `job`, `script` or `etl`. **Programs only**; on any other kind it is dropped on load, because a file is not scheduled. |
| `entrypoint` | no | Free text with a per-kind meaning: where a program starts, a module's path, a class's declaration, a function's signature. The inspector labels the box accordingly. |
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

Only `read` and `write` may name a table; only `call`, `import` and `extends`
may name code. The loader strips a `tableId` or `sql` from any other kind of
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
| `code-step-without-target` | warning | a `call`, `import` or `extends` that names nothing, so it draws no arrow. |
| `code-step-missing-target` | error | it names a node that is no longer in the diagram. The step and its code stay; the fix removes the step, and is never applied in bulk. |
| `code-step-names-itself` | warning | a module that imports itself, a class that extends itself. A function calling itself is recursion and is left alone. |
| `code-import-cycle` | warning | `a imports b imports a`: the circular import that fails at run time and hides well in a big map. Reported once per cycle. |
| `duplicate-program-name` | warning | two nodes with the same name **in the same container**. Siblings only; `Order.save` and `Customer.save` are fine. |

The program rules still apply to every kind: a `write` to a column a data flow
already computes, a write to a view or to a table marked as living in another
database, a step naming a table that is gone.

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
