# Walkthroughs

Fifteen short, hands-on guides to Database Visualizer that build **one
database, once**. Walkthrough 00 puts two tables on the canvas; walkthrough 14
exports the eighteen-table bookshop those two tables grew into. Nothing is ever
thrown away and restarted: each walkthrough picks the canvas up exactly where
the last one put it down, so the schema in front of you is always the one you
built.

That is a promise the tooling checks. A walkthrough's `start:` is literally the
previous walkthrough's finished diagram — the same file — and
`scripts/validate-walkthrough.mjs` fails if the chain breaks or if a table the
reader built ever disappears.

**They are clickthroughs, not documents.** Pick one in the app and a card
appears over the window, anchored to whatever the step is about — the **+ Table**
button, the **Reads as** picker, a column row on the canvas, the **Problems**
tab. Do the thing it describes and the card ticks it off on its own, because
every step says what it is for in a form the app can check. Nothing is blocked
while it is up: you work in the real app and the card follows you.

Three buttons on that card do the work for you when you would rather watch than
type:

- **Do it for me** makes the current step's change — adds the table, draws the
  foreign key, writes the derivation — as one undo step, so `Ctrl+Z` puts it
  back.
- **Set up the canvas**, on the card you get before step 1, puts the tables,
  connections, types and regions that walkthrough starts from in front of you —
  the state the one before it leaves behind. Open walkthrough 09 on a blank
  canvas, press it, and you are ready to start walkthrough 09. **You do not have
  to start at 00.**
- **Check my work**, in the **Walkthrough** drawer tab, runs that walkthrough's
  own `checks:` against whatever is on your canvas and tells you, line by line,
  what does not match yet. They are the same checks CI runs against the
  companion diagram.

That drawer tab is also the map: every step in one list, ticks against the ones
that check out, a click to jump to any of them, and the full text underneath for
anyone who would rather read than be led.

Open the browser from the **?** button in the top bar, or press `Ctrl+K` and
type "walkthrough".

<!-- generated: walkthrough index, run `node scripts/build-walkthrough-index.mjs` -->

| # | Walkthrough | Level | Time | What you end up with |
| --- | --- | --- | --- | --- |
| 00 | [Your first diagram](00-your-first-diagram.md) | beginner | 15 min | A tour of the whole window and the whole loop — two tables, a dragged foreign key, generated SQL, and a saved file. |
| 01 | [Set up a table](01-set-up-a-table.md) | beginner | 15 min | The two sketched tables from walkthrough 00 get every type, key, flag, default and check they should have, and customers joins them. |
| 02 | [Connect two tables](02-connect-two-tables.md) | beginner | 12 min | Hang orders off the customers table, learn what the foreign key you dragged in walkthrough 00 really did, and meet the three other kinds of connection. |
| 03 | [Group tables, and read another database](03-group-tables.md) | intermediate | 15 min | Box the sales tables into a named region, then add two tables that live in another database so the script only ever documents them. |
| 04 | [Create an enum and use it](04-create-an-enum.md) | beginner | 10 min | An order_status enum and a postal_address composite, put to work by retyping two columns of the tables you already have. |
| 05 | [Fill one table from another](05-fill-one-table-from-another.md) | advanced | 25 min | Add order_items and daily_sales, then write the derivations that finally make both rollup tables compute — including the flow left empty in walkthrough 02. |
| 06 | [Simulate a data flow](06-simulate-a-data-flow.md) | intermediate | 15 min | Stack a second rollup on daily_sales, then run both flows over sample rows and watch stages, lineage and what-if edits play out live. |
| 07 | [Add indexes that get used](07-add-indexes.md) | intermediate | 12 min | Answer the five index warnings Problems has been showing since walkthrough 02, and learn why a composite index's column order decides what it can serve. |
| 08 | [Build a view](08-build-a-view.md) | intermediate | 12 min | A read-only view over three tables you already have, its SELECT typed once and its source links drawn for you by Detect from SQL. |
| 09 | [Import an existing schema](09-import-an-existing-schema.md) | beginner | 12 min | Merge the warehouse team's CREATE TABLE script into the diagram you have built, plus the foreign keys their DDL never bothered to declare. |
| 10 | [Fix what Problems finds](10-fix-what-problems-finds.md) | beginner | 15 min | Work the imported warehouse schema's two errors, ten warnings and one note down to nothing, and meet the two mistakes Problems cannot see. |
| 11 | [Trace a path between tables](11-trace-a-path-between-tables.md) | beginner | 10 min | Add reviews to give books and customers a second route, then ask Trace for the shortest chain between tables and read the JOIN it implies. |
| 12 | [Read a big diagram](12-read-a-big-diagram.md) | intermediate | 12 min | Collapsing, focus mode, Detangle, hand alignment, the command palette and regions — how to read the eighteen-table schema you have built without getting lost in it. |
| 13 | [Run the schema on a real database](13-run-the-schema-on-a-real-database.md) | advanced | 20 min | The whole bookshop schema, created inside a Docker PostgreSQL container, queried, seeded, migrated after a change, and read back into the diagram. |
| 14 | [Export, share and save](14-export-share-and-save.md) | beginner | 10 min | Turn the finished bookshop into SQL, a Markdown dictionary, Mermaid, DBML, a picture, a link or a portable file, and see exactly what each one keeps. |

The series builds one schema, so its diagrams are the stages of that build.
Open any of them with **File → Open** (`Ctrl+O`), or by dropping the file on
the canvas — or press **Set up the canvas** inside a walkthrough, which loads
the stage it starts from for you:

- [`diagrams/00-your-first-diagram.dbviz.json`](diagrams/00-your-first-diagram.dbviz.json) — the canvas at the end of 00 Your first diagram
- [`diagrams/01-set-up-a-table.dbviz.json`](diagrams/01-set-up-a-table.dbviz.json) — the canvas at the end of 01 Set up a table
- [`diagrams/02-connect-two-tables.dbviz.json`](diagrams/02-connect-two-tables.dbviz.json) — the canvas at the end of 02 Connect two tables
- [`diagrams/03-group-tables.dbviz.json`](diagrams/03-group-tables.dbviz.json) — the canvas at the end of 03 Group tables, and read another database
- [`diagrams/04-create-an-enum.dbviz.json`](diagrams/04-create-an-enum.dbviz.json) — the canvas at the end of 04 Create an enum and use it
- [`diagrams/05-fill-one-table-from-another.dbviz.json`](diagrams/05-fill-one-table-from-another.dbviz.json) — the canvas at the end of 05 Fill one table from another
- [`diagrams/06-simulate-a-data-flow.dbviz.json`](diagrams/06-simulate-a-data-flow.dbviz.json) — the canvas at the end of 06 Simulate a data flow
- [`diagrams/07-add-indexes.dbviz.json`](diagrams/07-add-indexes.dbviz.json) — the canvas at the end of 07 Add indexes that get used
- [`diagrams/08-build-a-view.dbviz.json`](diagrams/08-build-a-view.dbviz.json) — the canvas at the end of 08 Build a view
- [`diagrams/09-import-an-existing-schema.dbviz.json`](diagrams/09-import-an-existing-schema.dbviz.json) — the canvas at the end of 09 Import an existing schema
- [`diagrams/10-fix-what-problems-finds.dbviz.json`](diagrams/10-fix-what-problems-finds.dbviz.json) — the canvas at the end of 10 Fix what Problems finds
- [`diagrams/11-trace-a-path-between-tables.dbviz.json`](diagrams/11-trace-a-path-between-tables.dbviz.json) — the canvas at the end of 11 Trace a path between tables
- [`diagrams/12-read-a-big-diagram.dbviz.json`](diagrams/12-read-a-big-diagram.dbviz.json) — the canvas at the end of 12 Read a big diagram
- [`diagrams/13-run-the-schema-on-a-real-database.dbviz.json`](diagrams/13-run-the-schema-on-a-real-database.dbviz.json) — the canvas at the end of 13 Run the schema on a real database

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
run against the app's own code by
[`src/lib/walkthroughChecks.ts`](../../src/lib/walkthroughChecks.ts). They do
two jobs at once: they stop these pages drifting out of date as the app
changes, and they are what the reader's **Check my work** button runs against
their canvas. One implementation, so the button can never disagree with CI.
