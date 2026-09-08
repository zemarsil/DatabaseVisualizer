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
| 00 | [Your first diagram](00-your-first-diagram.md) | beginner | 15 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 01 | [Set up a table](01-set-up-a-table.md) | beginner | 15 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 02 | [Connect two tables](02-connect-two-tables.md) | beginner | 12 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 03 | [Group tables, and read another database](03-group-tables.md) | intermediate | 15 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 04 | [Create an enum and use it](04-create-an-enum.md) | beginner | 10 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 05 | [Fill one table from another](05-fill-one-table-from-another.md) | advanced | 25 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 06 | [Simulate a data flow](06-simulate-a-data-flow.md) | intermediate | 15 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 07 | [Add indexes that get used](07-add-indexes.md) | intermediate | 12 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 08 | [Build a view](08-build-a-view.md) | intermediate | 12 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 09 | [Import an existing schema](09-import-an-existing-schema.md) | beginner | 12 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 10 | [Fix what Problems finds](10-fix-what-problems-finds.md) | beginner | 12 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 11 | [Trace a path between tables](11-trace-a-path-between-tables.md) | beginner | 10 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 12 | [Read a big diagram](12-read-a-big-diagram.md) | intermediate | 12 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 13 | [Run the schema on a real database](13-run-the-schema-on-a-real-database.md) | advanced | 20 min | TODO one sentence, under 180 characters, ending in a full stop. |
| 14 | [Export, share and save](14-export-share-and-save.md) | beginner | 10 min | TODO one sentence, under 180 characters, ending in a full stop. |

Every walkthrough below ships a finished diagram you can open with **File → Open** (`Ctrl+O`)
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
