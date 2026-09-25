# Handing recommendations to Coditect

This document is written to be pasted (whole, or from "## The contract" down) into
the instructions of a database advisor agent, so that whatever it recommends can be
dropped straight into the Coditect instead of being retyped by hand.

Two input channels exist. Pick one per recommendation; do not mix them in one file.

| Channel | How the user loads it | Carries | Loses |
| --- | --- | --- | --- |
| **`.dbviz.json` diagram** | File menu → Open (`Ctrl+O`) | everything below: tables, columns, indexes, checks, comments, views, enum/composite types, **extensions**, foreign keys, **data-flow edges with derivations**, **dependency and serialized edges**, **external-source groups**, **tagged queries**, **programs that talk to the schema from outside it, and the code map inside them** (modules, classes, functions, calls), **sticky notes**, colours, positions — and, in the workspace form, **several diagrams in one file** | nothing |
| **Plain DDL** | Bottom drawer → **Import SQL** → paste → *Add to the current diagram* / *Replace* | tables, columns, indexes, uniques, checks, `COMMENT ON`, foreign keys, `CREATE VIEW`, `CREATE TYPE` (enum and composite), `CREATE EXTENSION` | flows, dependencies, derivations, groups, tagged queries, programs, notes, colours, positions |

The "Loses" column describes DDL *you* write. A `.sql` script the app itself exported
is a third thing: it carries its connections in a `-- dbviz:connections` comment block
that **Import SQL** reads back, so a user who hands you one is handing you their flows
and tagged queries too. Read that block for context if it is there; do not hand-write
one — emit a `.dbviz.json` instead, which is the channel for everything DDL cannot say.

Rule of thumb: if the recommendation is *only* "here is the schema", emit DDL — it is
easier to read and the user may want to run it. If it contains reasoning, computation
placement, derived/materialized tables, or "this feeds that", emit a `.dbviz.json`,
because those are exactly the parts DDL cannot express and the diagram can.

---

## The contract

You are producing input for a schema-diagram tool. Emit **one** of the following.

### Option A — DDL (schema-only recommendations)

Plain `CREATE TABLE` script for the target dialect, in one fenced ```sql block, no prose
inside the block. The importer is a purpose-built schema parser, not a full SQL engine.

Supported: `CREATE TABLE` with column and table constraints, `ALTER TABLE … ADD
CONSTRAINT / ADD COLUMN / ALTER COLUMN SET DEFAULT|NOT NULL`, `CREATE [UNIQUE] INDEX`,
`COMMENT ON TABLE|COLUMN`, `CREATE VIEW`, `CREATE TYPE … AS ENUM` / `AS (…)`, and
`CREATE EXTENSION` (plus MariaDB's `INSTALL SONAME` / `INSTALL PLUGIN` and DuckDB's `INSTALL` / `LOAD`),
and `CREATE [OR REPLACE] PROCEDURE | FUNCTION` with `COMMENT ON PROCEDURE | FUNCTION` — PostgreSQL's
dollar-quoted bodies and MariaDB's `BEGIN … END` bodies, `DELIMITER` lines included. A routine becomes
a procedure node whose steps are read out of its body. DuckDB's `STRUCT(…)` / `MAP(…)` / `INTEGER[3]` column types, `CREATE TYPE … AS STRUCT(…)` and
`CREATE SEQUENCE` + `DEFAULT nextval(…)` (read as an auto-increment column) parse as well.
`pg_dump` and `mysqldump` output parses fine.

Silently dropped (with a warning): generated columns, partitioning, expression indexes,
triggers, and functions in a language other than SQL or PL/pgSQL. If your recommendation depends on one of those, use Option B and
describe it in a note, or leave it in the script knowing it will not appear on the canvas.

Put your rationale in `COMMENT ON COLUMN` / `COMMENT ON TABLE` — those survive the round
trip and show up in the inspector.

### Option B — `.dbviz.json` (anything with reasoning, flows, or placement)

A single JSON document in one fenced ```json block. Shape:

```json
{
  "version": 1,
  "name": "Orders rollup — advisor recommendation",
  "dialect": "postgresql",
  "extensions": [ /* Extension */ ],
  "customTypes": [ /* CustomType */ ],
  "groups": [ /* Group */ ],
  "tables": [ /* Table */ ],
  "relationships": [ /* Relationship */ ],
  "programs": [ /* Program */ ],
  "notes": [ /* Note */ ]
}
```

`dialect` is `"postgresql"`, `"mariadb"`, `"sqlite"` or `"duckdb"` and decides how types are
generated, so write column types in that dialect's spelling. Only `tables` is required;
omit an array rather than sending an empty one you have nothing to put in.

**Table**

```json
{
  "id": "tbl_orders",
  "name": "orders",
  "schema": "public",
  "comment": "Why this table exists / what the advisor changed.",
  "color": "blue",
  "groupId": "grp_crm",
  "position": { "x": 0, "y": 0 },
  "columns": [ /* Column */ ],
  "indexes": [ /* Index */ ],
  "checks": ["total_cents >= 0"]
}
```

- `schema`, `comment`, `groupId` optional. `checks` are table-level CHECK **bodies only**
  — no `CHECK` keyword, no outer parentheses.
- `color` is one of: `blue`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`,
  `purple`, `indigo`, `slate`. Use colour to group: e.g. source tables blue, derived /
  materialized tables orange, tables you are proposing to add green.
- A **view** is a table with `"kind": "view"` and a `viewSql` holding the SELECT body
  (without `CREATE VIEW … AS`). Still list its `columns`: that is what the canvas draws
  and what other edges can point at.

**Column**

```json
{
  "id": "col_orders_id",
  "name": "id",
  "type": "BIGSERIAL",
  "nullable": false,
  "primaryKey": true,
  "unique": false,
  "autoIncrement": true,
  "defaultValue": "now()",
  "check": "total_cents >= 0",
  "comment": "Advisor note about this column."
}
```

- `type` is the raw SQL type string, exactly as it should appear in the DDL:
  `"VARCHAR(255)"`, `"NUMERIC(12,2)"`, `"INT UNSIGNED"`, `"TIMESTAMPTZ"`, `"JSONB"`, or
  the `name` of one of your `customTypes`. Match the declared dialect
  (`SERIAL`/`TIMESTAMPTZ`/`JSONB` for PostgreSQL, `INT AUTO_INCREMENT`/`TIMESTAMP`/`JSON`
  for MariaDB, `INTEGER`/`TEXT`/`REAL`/`BLOB` for SQLite, `INTEGER`/`VARCHAR`/`DOUBLE`/`BLOB`/
  `TIMESTAMPTZ`/`INTEGER[]`/`STRUCT(x INTEGER, y INTEGER)` for DuckDB); the app can translate later,
  but get it right the first time.
- `nullable` defaults to `true` if omitted — always set it to `false` on primary keys and
  anything `NOT NULL`.
- Use `"autoIncrement": true` for identity columns rather than a `nextval(...)` default.
  On DuckDB that becomes a sequence created before the table plus the `nextval` default.
- On DuckDB a foreign key's `onDelete` / `onUpdate` can only be `"NO ACTION"` or
  `"RESTRICT"`; the engine refuses `CASCADE`, `SET NULL` and `SET DEFAULT` outright, and
  a foreign key that closes a reference cycle cannot be created at all (the script
  documents it as a comment).
- `defaultValue` is a raw expression: `"now()"`, `"0"`, `"'pending'"` (note the inner
  quotes for a string literal). `check` is a body only, like the table-level ones.
- `comment` is the best place for per-column advice — it becomes `COMMENT ON COLUMN` in
  the generated script.

**Index**

```json
{ "id": "idx_orders_customer", "name": "orders_customer_id_idx", "columnIds": ["col_orders_customer_id"], "unique": false }
```

`columnIds` must be ids of columns **in the same table**, in the order the index should
declare them (order matters for composite indexes — say why in the table comment).
Expression indexes cannot be represented; put those in a note.

**Extension** — an engine extension the schema depends on.

```json
{
  "id": "ext_vector",
  "name": "vector",
  "schema": "extensions",
  "version": "0.7.0",
  "comment": "Embeddings on documents.body_vector."
}
```

`name` is exactly as the engine spells it (`postgis`, `vector`, `uuid-ossp`,
`pg_trgm`); it is the only field that reaches the generated SQL, as
`CREATE EXTENSION IF NOT EXISTS <name>` at the top of the script, before the types
and tables that need it. `schema` and `version` are optional and PostgreSQL-only;
omit both unless the recommendation depends on them.

**Declare an extension whenever a column's type needs one.** A `vector(1536)`,
`geometry(Point,4326)`, `citext` or `hstore` column with no matching extension is
reported as an error in the Problems tab, because the `CREATE TABLE` really will
fail. On DuckDB it generates `INSTALL name; LOAD name;` (a `GEOMETRY` column needs
`spatial`, an `INET` column needs `inet`). On MariaDB and SQLite the declaration
documents the dependency but generates only a comment, since neither engine installs
extensions from a schema script.

What an extension *provides* is never part of this file — the app keeps that in its
own catalog — so do not invent fields for its types or functions. If you are
recommending something obscure, say what it provides in a `note` instead.

**CustomType** — a named enum or composite type.

```json
{
  "id": "typ_order_status",
  "name": "order_status",
  "kind": "enum",
  "values": ["pending", "paid", "shipped", "cancelled"],
  "comment": "Why a type rather than a CHECK."
}
```

`kind` is `"enum"` (needs `values`) or `"composite"` (needs `fields`, each
`{ "id", "name", "type", "comment"? }`). Reference one from a column by writing its
`name` as that column's `type`. PostgreSQL and DuckDB emit `CREATE TYPE` (DuckDB spells a
composite `AS STRUCT(…)`); on MariaDB and SQLite the type still documents the diagram but
nothing is created, so prefer a CHECK there and say so in a note.

**Group** — a region for tables that live in **another database**.

```json
{
  "id": "grp_crm",
  "name": "CRM (read-only)",
  "color": "purple",
  "external": true,
  "note": "Vendor CRM over a foreign data wrapper; we only ever SELECT from it.",
  "position": { "x": -40, "y": -360 }
}
```

Point a table at it with `"groupId": "grp_crm"`. With `"external": true` those tables are
left out of the generated `CREATE TABLE` script and out of anything run against a live
database — the script documents them, and any foreign key into them, in an "External
sources" section instead. This is how you show a join to a source you do not own without
proposing to create it. `position` only matters while the group has no member tables.

**Relationship** — four kinds, and the distinction is the whole point of the tool.

```json
{
  "id": "rel_orders_customer",
  "kind": "fk",
  "verb": "belongs-to",
  "sourceTableId": "tbl_orders",
  "sourceColumnIds": ["col_orders_customer_id"],
  "targetTableId": "tbl_customers",
  "targetColumnIds": ["col_customers_id"],
  "name": "orders_customer_id_fkey",
  "onDelete": "CASCADE",
  "onUpdate": "NO ACTION"
}
```

- `"kind": "fk"` — a real `FOREIGN KEY`, emitted into the DDL. **`source` is the
  referencing (child, "many") side; `target` is the referenced (parent, "one") side.**
  Getting this backwards silently produces a wrong schema, so check it every time.
- `"kind": "flow"` — a dashed annotation meaning *rows in the target are derived from the
  source*. Never emitted as a constraint. This is how you express "compute this at ingest
  into a rollup table", "this materialized table is refreshed from those two", "this join
  is the hot path".
- `"kind": "dependency"` — the source reads the target without a constraint and without
  moving rows: a view, a job, or application code. Documentation only.
- `"kind": "embed"` — the target's rows are stored serialized inside **one column** of the
  source (JSONB, an array, a composite type). Put that column in `sourceColumnIds[0]` and
  leave `targetColumnIds` empty. Documentation only.
- `verb` sets how the edge reads. Each verb has a forward and a reverse phrasing, and the
  canvas shows the reverse one at the target end:

  | kind | verbs (forward / reverse) |
  | --- | --- |
  | `fk` | `references` (references / referenced by), `belongs-to` (belongs to / has), `part-of` (is part of / contains), `extends` (extends / extended by), `uses` (uses / used by) |
  | `flow` | `feeds` (feeds / fed by), `mirrors` (mirrors / mirrored by) |
  | `dependency` | `uses` (uses / used by) |
  | `embed` | `serializes` (serializes / serialized into), `embeds` (embeds / embedded in) |

  Omit `verb` to get the kind's default (`references`, `feeds`, `uses`, `serializes`). A
  verb that does not fit its kind is silently dropped back to that default.
- `name` is the constraint name on an `fk` and a free label on everything else, read
  source → target. `inverseName` overrides the verb's reverse phrasing at the target end.
- `query` (optional, any kind) is SQL that documents how data crosses the edge; it shows
  as a badge on the edge and is emitted as a comment block in the script.
- `note` (optional) is free text shown beside the query — put the *why* here.
- `onDelete` / `onUpdate` are one of `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`,
  `SET DEFAULT`; both default to `NO ACTION` and only mean anything on an `fk`.
- `sourceColumnIds` and `targetColumnIds` must be the same length and pair up positionally
  on an `fk`. Other kinds may leave both empty (`[]`) when the link is table-to-table.

**Derivations** — on a `flow`, say column by column how the target is computed, and the
app can build the `INSERT … SELECT` skeleton itself:

```json
"derivations": [
  { "id": "drv_total", "targetColumnId": "col_cm_total_cents", "expression": "total_cents", "aggregate": "SUM", "groupBy": ["customer_id", "month"], "filter": "status <> 'cancelled'" }
]
```

`targetColumnId` must be a column of the **target** table. `expression` is source-side
SQL (`"quantity * unit_price_cents"`, or `"*"` under `COUNT`). `aggregate` is one of
`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`, or omitted for a plain per-row value. `groupBy` and
`filter` are SQL text too.

Expressions, keys and filters may name a column of **another table** as `table.column`
when the source table reaches it through foreign keys in this file — `orders.status`
from an `order_items` flow follows `order_items.order_id → orders.id`. The app resolves
the lookup from the foreign keys, writes the `JOIN` into the generated skeleton, and
follows it when simulating, so prefer this over restating the join in `query`. Use the
plain table name (not `schema.table`) as the qualifier.

A **sequence** (window) operation puts the source rows in order and computes each value
from its neighbours:

```json
{ "id": "drv_gap", "targetColumnId": "col_gap_seconds", "expression": "placed_at", "filter": "status = 'paid'",
  "window": { "fn": "DIFF", "orderBy": ["placed_at"], "partitionBy": ["customer_id"] } }
```

`fn` is one of `DIFF` (this row minus the previous one — seconds for timestamps, days for
dates), `LAG`, `LEAD`, `RUNNING_SUM`, `RUNNING_AVG`, `ROW_NUMBER`, `RANK` (the last two
need no `expression`). `orderBy` is required (a key may end in ` DESC`); `partitionBy`
restarts the sequence per distinct value. A window may be combined with `aggregate` and
`groupBy` — the window runs first, then the grouping (an `AVG` of `DIFF`s is a mean gap) —
and the generator writes that as a subquery.

Use these alongside `query`, not instead of it: the structured form drives the summaries,
the generated skeleton and the **Simulate** mode (which runs the flows over sample rows and
shows the lineage of every value), the query covers what it cannot express (a join that is
not a foreign key, the upsert, the trigger).

**Program** — something outside the database that talks to it. A program can also be the
root of a **code map**: the modules inside it, the classes inside those, the functions that
run the statements, and the calls between them. The full format for that is
[`CODE_MAP_FORMAT.md`](CODE_MAP_FORMAT.md); the short version is at the end of this section.

```json
{
  "id": "prg_scorer",
  "name": "scorer",
  "language": "python",
  "role": "job",
  "entrypoint": "services/scorer/main.py",
  "comment": "Claims a pending job, scores it, writes the score back and marks the job done.",
  "color": "pink",
  "position": { "x": -360, "y": 120 },
  "steps": [
    { "id": "stp_1", "op": "read", "tableId": "tbl_jobs", "columnIds": ["col_jobs_id", "col_jobs_payload"],
      "sql": "SELECT id, payload FROM jobs WHERE status = 'pending' FOR UPDATE SKIP LOCKED",
      "note": "claim a batch" },
    { "id": "stp_2", "op": "compute", "columnIds": [], "note": "score the payload" },
    { "id": "stp_3", "op": "write", "tableId": "tbl_results", "columnIds": ["col_results_job_id", "col_results_score"] },
    { "id": "stp_4", "op": "write", "tableId": "tbl_jobs", "columnIds": ["col_jobs_status"],
      "sql": "UPDATE jobs SET status = 'done' WHERE id = $1" }
  ]
}
```

This is the one place to put **computation you are recommending happen outside the
database**. A rollup that could be a data flow should be a data flow; a program is for the
work SQL cannot do — a fit, a render, a model call, a request to somebody else's API — and
for the round trip around it.

- `language` is one of `python`, `rust`, `go`, `cpp`, `c`, `java`, `javascript`,
  `typescript`, `perl`, `shell`, `yaml`, `json`, `other`. Anything unrecognised loads as
  `other`, which still gets a node and highlighting, only no generated starter.
  `yaml` and `json` are not languages anything runs: a node written in one is a
  **data file**, which is a `kind` rather than a program (see below).
- `role` is optional: `service` (long-lived), `job` (scheduled), `script` (run by hand)
  or `etl` (bulk movement). It changes the badge and the wording, never the code.
- `steps` are **ordered, and the order is the point**: it is what makes a round trip
  legible on the canvas. `op` is `read`, `write` or `compute` — plus the four that name
  another node, below.
- A `compute` step must have **no** `tableId`, no `sql` and an empty `columnIds` — it is
  defined by not touching the database. A `read` or `write` step should name a `tableId`;
  `columnIds` narrows it to specific columns, and leaving it empty means the whole row.
- `sql` is the statement the program issues, optional. Leave it out and the app writes one
  from the table and columns for the generated starter. `code` (optional, per step) holds
  host-language code; use it when the code is the recommendation.
- Edges are **derived from the steps** — do not try to express a program with a
  relationship, which only joins two tables. Position the program to the left of the
  tables it touches so its arrows have room.

The code map inside a program uses the same object, plus `kind` and `parentId`:

```json
{ "id": "mod_orders", "name": "orders.py", "kind": "module", "parentId": "prg_api", "language": "python",
  "steps": [ { "id": "stp_1", "op": "import", "columnIds": [], "codeId": "mod_inventory" } ] },
{ "id": "cls_svc", "name": "OrderService", "kind": "class", "parentId": "mod_orders", "language": "python", "steps": [] },
{ "id": "fn_place", "name": "place_order", "kind": "function", "parentId": "cls_svc", "language": "python",
  "entrypoint": "def place_order(self, email, cart) -> int",
  "steps": [
    { "id": "stp_2", "op": "read", "tableId": "tbl_customers", "columnIds": ["col_customers_id"] },
    { "id": "stp_3", "op": "write", "tableId": "tbl_orders", "columnIds": [] },
    { "id": "stp_4", "op": "call", "columnIds": [], "codeId": "fn_reserve" }
  ] }
```

- `kind` is `module`, `class`, `function` or `data`; leave it out for a program.
  `parentId` names the node this one sits inside: a module inside a program or a module, a
  class inside a program, a module or a class, a function inside any of those, a data file
  inside a program or a module. A function holds nothing. Every node is a top-level entry
  of `programs`, whatever it sits inside — there is no nesting in the JSON.
- Four more `op`s name another node rather than a table: `call` (a function, class or
  program it hands control to), `import` (a module it depends on), `extends` (the class it
  inherits from) and `load` (a data file it reads values out of). Each carries `codeId`,
  the id of that node, and never a `tableId` or `sql`.
- A `"kind": "data"` node is a YAML or JSON file — settings, fixtures, a lookup table —
  and it is the one node that is not code. Write it with `"language": "yaml"` or
  `"json"`, an `entrypoint` holding its path, and **`"steps": []`**: nothing runs in it,
  so it does nothing in order, and steps written on one are dropped on load. The only
  arrow it may be on the end of is a `load`; a `call`, `import` or `extends` naming one is
  reported by Problems. Use it when the recommendation is that a value belongs in a
  config file rather than in the code or the schema — a rate, a threshold, a feature
  flag — and draw the load from the function that reads it.
- Put the statements on the **functions**, not on the modules: a module's steps are its
  imports, a function's steps are what it reads, writes and calls. Give every function a
  `position` inside its file's area; the regions for modules and classes are drawn around
  their members and never stored, so a container's own `position` only matters while it
  is empty or `"collapsed": true`.
- Use it when the recommendation is *about the code*: which function owns a write, what a
  column rename will break, where a transaction boundary should be. A single program with
  steps is still right for "a job does this nightly".

**Procedure** — a stored procedure or function: code the *database* runs. It is an entry of
`programs` with `"kind": "procedure"`, drawn with steps like any code node, but it is part of
the schema: the generated script creates it after the tables and views, and a migration
replaces it.

```json
{ "id": "prc_archive", "name": "archive_orders", "kind": "procedure", "language": "other",
  "position": { "x": 700, "y": 320 }, "color": "teal",
  "comment": "Moves orders older than the cutoff into the archive.",
  "params": [{ "id": "prm_cutoff", "name": "cutoff", "type": "DATE" }],
  "steps": [
    { "id": "stp_a1", "op": "write", "tableId": "tbl_orders_archive", "columnIds": [],
      "sql": "INSERT INTO orders_archive SELECT * FROM orders WHERE placed_at < cutoff" },
    { "id": "stp_a2", "op": "write", "tableId": "tbl_orders", "columnIds": [],
      "sql": "DELETE FROM orders WHERE placed_at < cutoff" }
  ] }
```

- `params` are `{ id, name, type, mode?, defaultValue? }`, `mode` being `in` (the default,
  left out), `out` or `inout`. `defaultValue` is PostgreSQL's alone.
- `returns` makes it a stored **function** (`CREATE FUNCTION … RETURNS`, used inside a
  query); leave it out for a procedure (`CREATE PROCEDURE`, run with `CALL`).
- `body` is the routine body as the engine takes it: on PostgreSQL what goes between the
  dollar quotes (a PL/pgSQL `BEGIN … END;` block, or plain statements with
  `"routineLanguage": "sql"`), on MariaDB one `BEGIN … END` compound statement. Leave it out
  and the body is written from the steps, each step's `sql` in order — often the clearest
  way to write one.
- Its steps are `read`, `write`, `compute` (procedural work: variables, `IF`, loops) and
  `call` naming another procedure. A program, module or function that runs it has a
  `call` step naming it; nothing may `import` or `extend` one.
- It never has a `parentId`. SQLite and DuckDB have no stored procedures: on those the
  script documents one as a comment rather than creating it.
- Use it when the recommendation is that the work belongs *in* the database — a batch
  that should be one transaction next to the data, logic every client must share — as
  opposed to a program, which says it belongs outside.

**Note** — sticky note on the canvas, for prose the schema cannot hold.

```json
{
  "id": "note_partitioning",
  "text": "orders is partitioned BY RANGE (created_at) monthly. The visualizer cannot model partitions; the DDL below is the parent table only.",
  "position": { "x": 700, "y": -180 },
  "width": 320,
  "height": 160,
  "color": "yellow"
}
```

Use notes for: the summary of the recommendation, anything the model cannot represent
(partitioning, generated columns, expression indexes, triggers), and trade-offs the user
should see next to the diagram. Same colour keys as tables.

### Option B2 — several diagrams in one file (a workspace)

When one recommendation spans more than one database — an application database and the
warehouse it feeds, a "today" and a "proposed" version of the same schema, one diagram per
bounded context — wrap the diagrams in a workspace instead of emitting several files. The
app opens it as a strip of tabs above the canvas, one per diagram, and saves them together:

```json
{
  "version": 1,
  "kind": "workspace",
  "name": "Orders platform — advisor recommendation",
  "activeSheet": "sht_app",
  "sheets": [
    { "id": "sht_app", "version": 1, "name": "Application database", "dialect": "postgresql", "tables": [] },
    { "id": "sht_warehouse", "version": 1, "name": "Warehouse", "dialect": "postgresql", "tables": [] }
  ]
}
```

Each entry of `sheets` is exactly an Option B document plus an `id`, so everything below
applies to it unchanged — including that ids must be unique **within** a sheet. Two sheets
may reuse an id between them; they are separate diagrams, and nothing references across
them. `activeSheet` is the id of the tab that opens first, and each sheet carries its own
`dialect`, so a PostgreSQL application database and a SQLite analytics copy can sit side by
side in one file.

Emit the plain Option B shape whenever there is only one diagram: a bare document is what
the app writes for a single diagram, and it is what every other tool that reads
`.dbviz.json` expects.

### Rules that keep the file loadable

1. **Every id is a unique string across the whole file** — tables, columns, indexes,
   relationships, derivations, groups, custom types, programs, program steps and notes
   share one namespace. Use
   readable, deterministic ids — `tbl_orders`, `col_orders_customer_id`,
   `idx_orders_customer`, `rel_orders_customer`, `note_partitioning` — not random ones.
   It makes the JSON reviewable and makes cross-references obvious.
2. **Every id referenced must exist**: `sourceTableId`/`targetTableId` name tables in this
   file; `sourceColumnIds` are columns of the source table, `targetColumnIds` of the
   target table; `columnIds` in an index belong to its own table; a `groupId` names a
   group in this file; a derivation's `targetColumnId` is a column of the flow's target;
   a program step's `tableId` names a table in this file and its `columnIds` are columns
   of that table; a code node's `parentId` names another node in `programs` whose kind
   may hold it, and a `call`, `import` or `extends` step's `codeId` names a node in
   `programs`.
   Dangling ids load without an error but draw a broken diagram — a dangling `groupId`
   is dropped, so the table silently leaves the group, and a dangling or looping
   `parentId` is dropped, so the node silently lands at the top level.
3. **Lay out the tables.** Positions are pixels; tables are ~280 wide. Place them on a
   grid — `x = 320 * column`, `y = 260 * row` — with referenced (parent) tables above the
   tables that reference them and derived tables at the bottom. Keep a group's tables in
   their own band so the region drawn around them does not swallow anything else. Never
   leave everything at `{"x": 0, "y": 0}`; the user can press **L** (Detangle) to
   re-layout, but a sane starting layout is part of the recommendation.
4. **Declare the extensions the column types need.** A type only an extension provides
   (`vector`, `geometry`, `geography`, `citext`, `hstore`, `ltree`, `cube`) is an error
   in the Problems tab until the matching extension is in `extensions`.
5. Omit optional fields rather than sending `null`. Unknown fields are ignored.
6. One JSON object per recommendation, in one fenced block, valid JSON — no comments, no
   trailing commas.

Tell the user to save the block as `something.dbviz.json` and open it with
**File → Open** (`Ctrl+O`), and note whether it replaces or extends what they have.
`Ctrl+O` always **replaces** the whole workspace. Dropping the file on the canvas is
gentler: a workspace file of several diagrams arrives as new tabs beside their own, and a
single-diagram file offers *Replace* or *Add tables*. If you are only proposing an
addition to a schema they already have, either emit DDL (which can be imported in *Add to
the current diagram* mode) or restate their existing tables in the JSON alongside yours.

---

## Checking a generated file

From the repo root:

```bash
node scripts/validate-dbviz.mjs path/to/file.dbviz.json
```

It reads a workspace file too, checking every sheet and naming the one at fault.
It reports duplicate ids, dangling references, mismatched FK column arrays, verbs that do
not fit their kind, derivations pointing at the wrong table, bad colour keys, bad
referential actions, dialect/type mix-ups and tables stacked at the same position — all
the things the app tolerates silently but that make the diagram wrong. Schema *advice*
(missing primary keys, unindexed foreign keys, mismatched key types) is not its job:
that is the app's own **Problems** tab, which the user can read once the file is open.

A complete, valid example lives in
[`docs/examples/orders-rollup.dbviz.json`](examples/orders-rollup.dbviz.json). It
exercises an external-source group, an enum type, a view, foreign keys with verbs, a flow
with derivations and a dependency edge.
