# Handing recommendations to Database Visualizer

This document is written to be pasted (whole, or from "## The contract" down) into
the instructions of a database advisor agent, so that whatever it recommends can be
dropped straight into the Database Visualizer instead of being retyped by hand.

Two input channels exist. Pick one per recommendation; do not mix them in one file.

| Channel | How the user loads it | Carries | Loses |
| --- | --- | --- | --- |
| **`.dbviz.json` diagram** | File menu → Open (`Ctrl+O`) | everything below: tables, columns, indexes, checks, comments, views, enum/composite types, foreign keys, **data-flow edges with derivations**, **dependency and serialized edges**, **external-source groups**, **tagged queries**, **sticky notes**, colours, positions | nothing |
| **Plain DDL** | Bottom drawer → **Import SQL** → paste → *Add to the current diagram* / *Replace* | tables, columns, indexes, uniques, checks, `COMMENT ON`, foreign keys, `CREATE VIEW`, `CREATE TYPE` (enum and composite) | flows, dependencies, derivations, groups, tagged queries, notes, colours, positions |

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
`COMMENT ON TABLE|COLUMN`, `CREATE VIEW`, and `CREATE TYPE … AS ENUM` / `AS (…)`.
`pg_dump` and `mysqldump` output parses fine.

Silently dropped (with a warning): generated columns, partitioning, expression indexes,
triggers, functions. If your recommendation depends on one of those, use Option B and
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
  "customTypes": [ /* CustomType */ ],
  "groups": [ /* Group */ ],
  "tables": [ /* Table */ ],
  "relationships": [ /* Relationship */ ],
  "notes": [ /* Note */ ]
}
```

`dialect` is `"postgresql"`, `"mariadb"` or `"sqlite"` and decides how types are
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
  for MariaDB, `INTEGER`/`TEXT`/`REAL`/`BLOB` for SQLite); the app can translate later,
  but get it right the first time.
- `nullable` defaults to `true` if omitted — always set it to `false` on primary keys and
  anything `NOT NULL`.
- Use `"autoIncrement": true` for identity columns rather than a `nextval(...)` default.
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
`name` as that column's `type`. Only PostgreSQL emits `CREATE TYPE`; on MariaDB and
SQLite the type still documents the diagram but nothing is created, so prefer a CHECK
there and say so in a note.

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

### Rules that keep the file loadable

1. **Every id is a unique string across the whole file** — tables, columns, indexes,
   relationships, derivations, groups, custom types and notes share one namespace. Use
   readable, deterministic ids — `tbl_orders`, `col_orders_customer_id`,
   `idx_orders_customer`, `rel_orders_customer`, `note_partitioning` — not random ones.
   It makes the JSON reviewable and makes cross-references obvious.
2. **Every id referenced must exist**: `sourceTableId`/`targetTableId` name tables in this
   file; `sourceColumnIds` are columns of the source table, `targetColumnIds` of the
   target table; `columnIds` in an index belong to its own table; a `groupId` names a
   group in this file; a derivation's `targetColumnId` is a column of the flow's target.
   Dangling ids load without an error but draw a broken diagram — and a dangling `groupId`
   is dropped, so the table silently leaves the group.
3. **Lay out the tables.** Positions are pixels; tables are ~280 wide. Place them on a
   grid — `x = 320 * column`, `y = 260 * row` — with referenced (parent) tables above the
   tables that reference them and derived tables at the bottom. Keep a group's tables in
   their own band so the region drawn around them does not swallow anything else. Never
   leave everything at `{"x": 0, "y": 0}`; the user can press **L** (Detangle) to
   re-layout, but a sane starting layout is part of the recommendation.
4. Omit optional fields rather than sending `null`. Unknown fields are ignored.
5. One JSON object per recommendation, in one fenced block, valid JSON — no comments, no
   trailing commas.

Tell the user to save the block as `something.dbviz.json` and open it with
**File → Open** (`Ctrl+O`), and note whether it replaces or extends their current
diagram. A `.dbviz.json` always **replaces** the whole diagram on open; if you are only
proposing an addition to a schema they already have, either emit DDL (which can be
imported in *Add to the current diagram* mode) or restate their existing tables in the
JSON alongside yours.

---

## Checking a generated file

From the repo root:

```bash
node scripts/validate-dbviz.mjs path/to/file.dbviz.json
```

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
