# Handing recommendations to Database Visualizer

This document is written to be pasted (whole, or from "## The contract" down) into
the instructions of a database advisor agent, so that whatever it recommends can be
dropped straight into the Database Visualizer instead of being retyped by hand.

Two input channels exist. Pick one per recommendation; do not mix them in one file.

| Channel | How the user loads it | Carries | Loses |
| --- | --- | --- | --- |
| **`.dbviz.json` diagram** | File menu → Open (`Ctrl+O`) | tables, columns, indexes, checks, comments, foreign keys, **data-flow edges**, **tagged queries**, **sticky notes**, colours, positions | nothing |
| **Plain DDL** | Bottom drawer → **Import SQL** → paste → *Add to the current diagram* / *Replace* | tables, columns, indexes, uniques, checks, `COMMENT ON`, foreign keys | flows, tagged queries, notes, colours, positions |

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
`COMMENT ON TABLE|COLUMN`, `CREATE TYPE … AS ENUM`. `pg_dump` and `mysqldump` output
parses fine.

Silently dropped (with a warning): generated columns, partitioning, expression indexes,
views, triggers, functions. If your recommendation depends on one of those, use Option B
and describe it in a note, or leave it in the script knowing it will not appear on the
canvas.

Put your rationale in `COMMENT ON COLUMN` / `COMMENT ON TABLE` — those survive the round
trip and show up in the inspector.

### Option B — `.dbviz.json` (anything with reasoning, flows, or placement)

A single JSON document in one fenced ```json block. Shape:

```json
{
  "version": 1,
  "name": "Orders rollup — advisor recommendation",
  "dialect": "postgresql",
  "tables": [ /* Table */ ],
  "relationships": [ /* Relationship */ ],
  "notes": [ /* Note */ ]
}
```

`dialect` is `"postgresql"` or `"mariadb"` and decides how types are generated, so write
column types in that dialect's spelling.

**Table**

```json
{
  "id": "tbl_orders",
  "name": "orders",
  "schema": "public",
  "comment": "Why this table exists / what the advisor changed.",
  "color": "blue",
  "position": { "x": 0, "y": 0 },
  "columns": [ /* Column */ ],
  "indexes": [ /* Index */ ],
  "checks": ["total_cents >= 0"]
}
```

- `schema`, `comment` optional. `checks` are table-level CHECK **bodies only** — no
  `CHECK` keyword, no outer parentheses.
- `color` is one of: `blue`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`,
  `purple`, `indigo`, `slate`. Use colour to group: e.g. source tables blue, derived /
  materialized tables orange, tables you are proposing to add green.

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
  `"VARCHAR(255)"`, `"NUMERIC(12,2)"`, `"INT UNSIGNED"`, `"TIMESTAMPTZ"`, `"JSONB"`.
  Match the declared dialect (`SERIAL`/`TIMESTAMPTZ`/`JSONB` for PostgreSQL,
  `INT AUTO_INCREMENT`/`TIMESTAMP`/`JSON` for MariaDB); the app can translate later, but
  get it right the first time.
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

**Relationship** — two kinds, and the distinction is the whole point of the tool.

```json
{
  "id": "rel_orders_customer",
  "kind": "fk",
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
  source by this query*. Never emitted as a constraint. This is how you express "compute
  this at ingest into a rollup table", "this materialized table is refreshed from those
  two", "this join is the hot path". Give it a `query` and, if useful, a `name` label.
- `query` (optional on either kind) is SQL that documents how data crosses the edge; it
  shows as a badge on the edge and is emitted as a comment block in the script.
- `note` (optional) is free text shown beside the query — put the *why* here.
- `onDelete` / `onUpdate` are one of `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`,
  `SET DEFAULT`; both default to `NO ACTION`.
- `sourceColumnIds` and `targetColumnIds` must be the same length and pair up positionally.
- A flow edge may use empty column arrays (`[]`) when it is table-to-table.

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
(partitioning, generated columns, expression indexes, views, triggers), and trade-offs
the user should see next to the diagram. Same colour keys as tables.

### Rules that keep the file loadable

1. **Every id is a unique string across the whole file.** Use readable, deterministic
   ids — `tbl_orders`, `col_orders_customer_id`, `idx_orders_customer`,
   `rel_orders_customer`, `note_partitioning` — not random ones. It makes the JSON
   reviewable and makes cross-references obvious.
2. **Every id referenced must exist**: `sourceTableId`/`targetTableId` name tables in this
   file; `sourceColumnIds` are columns of the source table, `targetColumnIds` of the
   target table; `columnIds` in an index belong to its own table. Dangling ids load
   without an error but draw a broken diagram.
3. **Lay out the tables.** Positions are pixels; tables are ~280 wide. Place them on a
   grid — `x = 320 * column`, `y = 260 * row` — with referenced (parent) tables above the
   tables that reference them and derived tables at the bottom. Never leave everything at
   `{"x": 0, "y": 0}`; the user can press **L** (Detangle) to re-layout, but a sane
   starting layout is part of the recommendation.
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

It reports duplicate ids, dangling references, mismatched FK column arrays, bad colour
keys, bad referential actions, and tables stacked at the same position — all the things
the app tolerates silently but that make the diagram wrong.

A complete, valid example lives in
[`docs/examples/orders-rollup.dbviz.json`](examples/orders-rollup.dbviz.json).
