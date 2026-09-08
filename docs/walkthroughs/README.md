# Walkthroughs

Fifteen short, hands-on guides to Database Visualizer. Each one takes a task you
would actually set out to do, walks it end to end, and ships the finished
diagram so you can open it instead of typing along if you would rather read.

Start at [Your first diagram](00-your-first-diagram.md) if you have never opened
the app. Otherwise jump to whatever you are stuck on — every walkthrough says
what it assumes at the top.

<!-- generated: walkthrough index, run `node scripts/build-walkthrough-index.mjs` -->

| # | Walkthrough | Level | Time | What you end up with |
| --- | --- | --- | --- | --- |
| 00 | [Your first diagram](00-your-first-diagram.md) | beginner | 15 min | A tour of the whole window and the whole loop — two tables, a dragged foreign key, generated SQL, and a saved file. |
| 01 | [Set up a table](01-set-up-a-table.md) | beginner | 15 min | Two tables typed almost entirely from the keyboard, with the right types, keys, flags, defaults and checks on every column. |
| 02 | [Connect two tables](02-connect-two-tables.md) | beginner | 12 min | Turn a plain column into a real foreign key, then meet the three other kinds of connection a foreign key cannot express. |
| 03 | [Group tables, and read another database](03-group-tables.md) | intermediate | 15 min | Box related tables into a named region, then mark one as living in another database so the script only ever documents it. |
| 04 | [Create an enum and use it](04-create-an-enum.md) | beginner | 10 min | An order_status enum and a postal_address composite type, both put to work by typing their name into a column's type cell. |
| 05 | [Fill one table from another](05-fill-one-table-from-another.md) | advanced | 25 min | Two rollup tables wired to data-flow edges whose derivations aggregate through a foreign key and average the gaps between a customer's orders. |
| 06 | [Simulate a data flow](06-simulate-a-data-flow.md) | intermediate | 15 min | Pick a table a data flow feeds, run every flow upstream of it over sample rows, and watch stages, lineage and what-if edits play out live. |
| 07 | [Add indexes that get used](07-add-indexes.md) | intermediate | 12 min | Composite and unique indexes on the order path, why a composite index's column order decides what it can serve, and what Problems catches when one is missing. |
| 08 | [Build a view](08-build-a-view.md) | intermediate | 12 min | A read-only view over three tables, its SELECT typed once and its source links drawn for you by Detect from SQL. |
| 09 | [Import an existing schema](09-import-an-existing-schema.md) | beginner | 12 min | Paste, drop or read in someone else's CREATE TABLE script and get a real diagram back, plus the foreign keys the DDL never bothered to declare. |
| 10 | [Fix what Problems finds](10-fix-what-problems-finds.md) | beginner | 12 min | A bookshop schema with eighteen real mistakes, what Problems says about each one, and which ones fix themselves with one click. |
| 11 | [Trace a path between tables](11-trace-a-path-between-tables.md) | beginner | 10 min | Ask Trace for the shortest chain of connections between two tables, read what it found, and generate the JOIN it implies. |
| 12 | [Read a big diagram](12-read-a-big-diagram.md) | intermediate | 12 min | Collapsing, focus mode, Detangle, hand alignment, the command palette and colour conventions — how to read an eleven-table schema without getting lost in it. |
| 13 | [Run the schema on a real database](13-run-the-schema-on-a-real-database.md) | advanced | 20 min | A five-table PostgreSQL bookshop schema you create inside a Docker container, query, seed, migrate after a change, and read back into the diagram. |
| 14 | [Export, share and save](14-export-share-and-save.md) | beginner | 10 min | Turn a finished diagram into SQL, a Markdown dictionary, Mermaid, DBML, a picture, a link or a portable file, and see exactly what each one keeps. |

Each one ships a finished diagram you can open with **File → Open** (`Ctrl+O`),
or by dropping the file on the canvas:

- [`diagrams/00-your-first-diagram.dbviz.json`](diagrams/00-your-first-diagram.dbviz.json) — Your first diagram
- [`diagrams/01-set-up-a-table.dbviz.json`](diagrams/01-set-up-a-table.dbviz.json) — Set up a table
- [`diagrams/02-connect-two-tables.dbviz.json`](diagrams/02-connect-two-tables.dbviz.json) — Connect two tables
- [`diagrams/03-group-tables.dbviz.json`](diagrams/03-group-tables.dbviz.json) — Group tables, and read another database
- [`diagrams/04-create-an-enum.dbviz.json`](diagrams/04-create-an-enum.dbviz.json) — Create an enum and use it
- [`diagrams/05-fill-one-table-from-another.dbviz.json`](diagrams/05-fill-one-table-from-another.dbviz.json) — Fill one table from another
- [`diagrams/06-simulate-a-data-flow.dbviz.json`](diagrams/06-simulate-a-data-flow.dbviz.json) — Simulate a data flow
- [`diagrams/07-add-indexes.dbviz.json`](diagrams/07-add-indexes.dbviz.json) — Add indexes that get used
- [`diagrams/08-build-a-view.dbviz.json`](diagrams/08-build-a-view.dbviz.json) — Build a view
- [`diagrams/09-import-an-existing-schema.dbviz.json`](diagrams/09-import-an-existing-schema.dbviz.json) — Import an existing schema
- [`diagrams/10-fix-what-problems-finds.dbviz.json`](diagrams/10-fix-what-problems-finds.dbviz.json) — Fix what Problems finds
- [`diagrams/11-trace-a-path-between-tables.dbviz.json`](diagrams/11-trace-a-path-between-tables.dbviz.json) — Trace a path between tables
- [`diagrams/12-read-a-big-diagram.dbviz.json`](diagrams/12-read-a-big-diagram.dbviz.json) — Read a big diagram
- [`diagrams/13-run-the-schema-on-a-real-database.dbviz.json`](diagrams/13-run-the-schema-on-a-real-database.dbviz.json) — Run the schema on a real database
- [`diagrams/14-export-share-and-save.dbviz.json`](diagrams/14-export-share-and-save.dbviz.json) — Export, share and save

<!-- /generated -->

## Writing one

The house format is [`WALKTHROUGH_FORMAT.md`](WALKTHROUGH_FORMAT.md); copy
[`_TEMPLATE.md`](_TEMPLATE.md) to start, and check the labels and shortcuts you
name against [`UI_REFERENCE.md`](UI_REFERENCE.md) rather than memory.

```bash
node scripts/validate-walkthrough.mjs            # format, links, shortcuts, diagrams
node scripts/build-walkthrough-index.mjs         # rewrite the index above
npx vitest run tests/walkthroughs.test.ts        # run every walkthrough's checks:
```

The `checks:` in a walkthrough's front matter are assertions about its companion
diagram — the SQL it generates, whether it lints clean, whether it simulates —
run against the app's own code. They are what stops these pages from drifting out
of date as the app changes.
