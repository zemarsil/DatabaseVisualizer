# Database Visualizer

A locally hosted web app for designing relational schemas visually.

- Draw tables and their connections on a pan/zoom canvas: crow's-foot foreign keys plus three kinds the database cannot enforce — data flows, serialized copies, and plain dependencies. Views are nodes too, fed by the tables their `SELECT` reads.
- Say how a connection *reads*: "orders **contains** order_items", "customers **has** addresses", "orders **uses** addresses". The verb is documentation, so it never changes the DDL.
- Tag any connection with the query that moves data across it, so the diagram documents *how* one table feeds another, not just that they are related.
- **Group** tables into a labelled region — handy when part of the diagram is a *different* database you only read from. Mark that group external and the generated script documents those tables instead of creating them.
- Generate the `CREATE TABLE` script for **PostgreSQL**, **MariaDB**, **SQLite** or **DuckDB** from the diagram, or paste DDL (including `pg_dump` / `mysqldump` output) and get the diagram back. Enum and composite types are first-class.
- **Problems**: a schema linter that flags missing primary keys, foreign keys onto non-unique columns, type mismatches, duplicate names, reserved words and more — most findings fix themselves with one click — plus foreign-key suggestions read off column names.
- **Detangle**: a layered auto-layout that ranks referenced tables before the tables that reference them and minimises edge crossings. Align, distribute, snap to grid and nudge with the arrow keys for the last few pixels.
- **Trace**: pick two tables and get the shortest chain of connections between them, highlighted on the canvas, plus the `JOIN` query for that path.
- **Simulate**: pick a table and watch sample rows flow into it. Every data flow upstream runs once, stage by stage: dots travel the connections on the canvas, the columns being read and written light up, and a grid shows each produced row with the rows it came from and how every value was computed. Edit a raw input cell and the change propagates.
- **Describe how data moves**: a data-flow connection carries one derivation per target column: an expression, an aggregate over a grouping, a filter, and, for sequences, an operation over rows in order (change since the previous row, running total, rank…). Expressions may read columns of other tables as `table.column`; the diagram's own foreign keys say how they join. The same description drives the edge summary, the generated `INSERT … SELECT` (window functions and joins included, per dialect) and the simulation.
- **Programs**: the work that happens *outside* the database gets a node of its own. A program is an ordered list of steps — read a table, compute something the database never sees, write the answer back — and each step that names a table draws a numbered arrow, so a round trip reads straight off the canvas. Steps carry the statement they run and the host-language code around it, and the app writes a starter for you: the real driver for your language and engine, your table and column names, parameters spelled the way that driver expects.
- **Code maps**: a program can open up into the codebase behind it — modules as regions, classes inside them, functions as the nodes whose steps say what each one reads, writes and calls — so *this function reads that table* is one arrow in the same picture as the schema, and a rename or a drop can be traced into the code that would break. Every arrow and every region is derived from the steps and the containment, never stored; collapse a module and its arrows gather onto it. The whole map rides in the SQL script's annotation block, the Markdown export and the clipboard.
- **Read a big diagram**: collapse tables to keys or headers (automatically when zoomed out), focus on one table and its neighbours, cardinality labels on every connection, and one-click grouping by schema.
- **Command palette** (`Ctrl+K`): jump to any table or run any action by typing a few letters.
- **Migrate and seed**: diff the diagram against a live database and get the `ALTER` statements that bring it up to date; generate deterministic seed rows that respect foreign keys, uniqueness and enums.
- **Query**: run read-only `SELECT`s against the connected database with a results grid, snippets built from the diagram, and history.
- **SQL editing**: every box you type SQL into — a connection's tagged query, a view's `SELECT`, a data flow's expressions and filters, column defaults and checks, the Query and Import tabs — colours the diagram's own table and column names, completes them along with keywords and functions (`Ctrl+Space`), checks as you type, and formats on `Ctrl+Shift+F`. A connection's query can start from one written for it: the `JOIN` of a foreign key, an `INSERT … SELECT` or upsert for a data flow, JSON unpacking for a serialized one.
- Export as PNG, SVG, SQL, Markdown, Mermaid or DBML; save a `.dbviz.json` file; or copy a **share link** that carries the whole diagram in its URL. Every diagram you work on is kept in the browser's library with thumbnails and named checkpoints.
- **Docker & database**: start a PostgreSQL or MariaDB container from the UI, create the schema in it (or in any database you can reach), and pull an existing database's schema into the diagram. With the SQLite or DuckDB dialect the database runs *inside the browser*, no server required.

## Requirements

- Node.js 20 or newer.
- Docker (optional, only for the container features). The API server talks to the daemon over `/var/run/docker.sock`, or `DOCKER_HOST` if set.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  (Vite dev server + API on :8787)
```

For a production-style build served by the API server on a single port:

```bash
npm run build
npm start          # http://127.0.0.1:8787
```

Environment variables for the server: `PORT` (default `8787`), `HOST` (default `127.0.0.1`; the server binds to localhost only, because it can run arbitrary DDL against databases you point it at), `DOCKER_HOST` / `DOCKER_SOCKET`.

### Install scripts, and why not to run `npm audit fix --force`

`package.json` carries an `allowScripts` block, so recent npm (11.x and 12.x, which block dependency lifecycle scripts by default) installs without stopping to ask about them. `esbuild` is allowed, because its script swaps in the native binary that Vite and `tsx` run on. `ssh2`, `cpu-features` and `protobufjs` are denied — their scripts build native SSH crypto and CLI scaffolding this project never reaches, since `dockerode` talks to the daemon over a socket or TCP rather than SSH. The entries are deliberately unpinned, so a routine version bump does not put the question back.

Please do not run `npm audit fix --force`. It rewrites `package.json` and `package-lock.json` in place, which is what turns the next `git pull` into a merge conflict, and it upgrades further than this project supports — at the time of writing it moves Vitest to 5.x, which needs Node 22.12, while this project supports Node 20. Advisories are resolved here instead, by pinning a version that is both patched and in range.

### Running the app itself in Docker

```bash
docker compose up --build
```

`docker-compose.yml` mounts the Docker socket into the container so the "create a database container" feature keeps working. Databases it creates are bound to `127.0.0.1` on the host, so from inside the app container point connections at `host.docker.internal` (already the default there).

## Using it

| What | How |
| --- | --- |
| Several databases at once | The tabs above the canvas are the diagrams of this workspace, like the worksheets of a spreadsheet: **+** adds one, double-click a tab to rename it, drag to reorder, right-click for duplicate / move / close, `Ctrl+PgUp` / `Ctrl+PgDn` steps between them. Each tab keeps its own dialect, undo history, selection and viewport; `Ctrl+C` in one and `Ctrl+V` in another copies tables across; **File → Save** writes every tab into one `.dbviz.json` |
| Find anything | `Ctrl+K` opens the command palette: type a table name to jump to it, or the first letters of an action (export, detangle, collapse, switch dialect…) |
| Add a table | Double-click the canvas, press `T`, or use the **+ Table** button; the menu next to it adds a view, a note, a group or an enum type |
| Select a group | `Shift` + drag a box over the canvas — every table and note it touches is selected; drag any of them (or the dashed box) to move the group, `Delete` removes it in one undo step |
| Right-click anything | Every target has its own menu: the canvas (add a table or note right here, select all, detangle, undo, open a drawer), a table (rename, duplicate, colour, **Copy as** SQL / Markdown / Markdown + SQL / diagram JSON, trace, delete), a column row inside a table (toggle PK / NN / UQ / AI, add a column below, index it, reorder, delete), a connection (swap direction, switch its kind, copy the tagged query), a note, a group region (copy all of its tables in any format), and the entries in the table list. Right-clicking inside a selected group acts on the whole group |
| Edit columns | Select a table; the inspector on the right has the column grid (PK / NN / UQ / AI toggles, expand a row for default, check, comment) plus indexes and table checks. `Enter` anywhere in a row adds the next one, `Shift+Enter` inserts above, `Alt+P` / `Alt+N` / `Alt+U` / `Alt+I` tick PK / NN / UQ / AI without the cursor leaving the box, the arrow keys walk the rows, `Ctrl+Backspace` on an empty name deletes; drag the grip to reorder |
| Type a table end to end | A new table opens with the cursor in its name. `Enter` goes on to the schema, `Enter` again drops into the column grid (adding the first row if there is none), and from there name, `Tab`, type, `Alt`+a flag, `Enter` repeats down the table. The colour palette and each row's flag toggles are one tab stop each, walked with the arrow keys |
| Views | Switch a table to **View** in the inspector, paste its `SELECT`, and **Detect from SQL** draws the data-flow links from the tables it reads. Tick **Materialized** (PostgreSQL) to store the rows instead of recomputing them per query; on MariaDB, SQLite and DuckDB the script falls back to a plain view and the setting is kept for when you switch back |
| Extensions | Bottom drawer → **Types** → *Extensions*: declare what the engine has to have loaded — PostGIS for a `geometry` column, pgvector for an embedding, pg_trgm for a fuzzy-search index. `CREATE EXTENSION` goes to the top of the generated script, the extension's types join every column's TYPE autocomplete, and a column typed with something no enabled extension provides becomes an error in **Problems** with a one-click fix. Definitions for anything the app does not ship with come from a JSON pack (file or URL) or straight off the database you are connected to |
| Rename in place | Double-click a table header (or press `F2`) |
| Foreign key | Hover a table and drag the handle beside a column onto a column of another table |
| Group tables | Select them and press `G` (or the group button in the top bar). Drag a table into or out of a region to change what is in it; drag a region by its title bar to move everything inside it |
| Mark a group as another database | Select the region, tick **These tables live in another database** in the inspector |
| Any other connection | Drag the orange handle in a table header onto another table, then pick the kind in the inspector (data flow, serialized, dependency) |
| Change how a connection reads | Select it; **Reads as** offers the verbs that fit its kind and previews the sentence in both directions |
| Derived columns | On a data-flow edge, add one entry per target column: target column, aggregate, source expression, group-by keys, filter, and optionally a **sequence** operation (previous / next value, change since the previous row, running total or average, row number, rank) with its order-by and partition-by keys. Expressions are SQL and may name a column of any table the source points at through foreign keys as `table.column` (`orders.status` from `order_items`). The edge shows a `Σ` count and a per-column summary, and the script gets an `INSERT ... SELECT` skeleton with the `JOIN`s and window functions written for the current dialect |
| See what is computed | Any column a data flow fills carries a **Σ** mark, and its table a **Σ n** badge that survives collapsing. `D` (or **View → Derived-column lens**) turns that into a way of reading the whole canvas: computed columns take the green rail, the columns feeding them the flow colour, foreign keys step back. The **Derived** drawer tab lists every one with its formula; pick a column — there, or by right-clicking it → *Show where this comes from* — and the canvas narrows to that column's chain: every column read to produce it, and everything computed from it in turn. `Esc` widens the chain back, then puts the lens away |
| One source, several look-alike targets | On a data-flow edge, **Match by name** adds a plain passthrough derivation for every target column a source column of the same name can fill (case and underscores ignored; columns already derived are left alone). *Feed other tables the same way* then ticks off the other tables that share those column names and draws the same flow into each, its derivations re-pointed at the columns each table spells the same way. Five tables fed from one is five edges either way — a connection joins two tables — but not five sets of derivations typed by hand |
| Say what talks to the database from outside | Right-click the canvas → **Add program here** (or `Ctrl+K` → *Add program*). Name it, pick its language, then add steps in the order they happen: read a table, compute something the database never sees, write the answer back. Each step naming a table draws a numbered arrow, and the node says *round trip: jobs* when it both reads and writes one. Every step holds the statement it runs and the code around it; **Show the … starter** writes a runnable skeleton from the steps with the right driver for your language and engine, and on a module or a class it writes the whole file, definitions and all |
| Map the code behind a program | With a program selected, the `▾` beside **+ Table** adds a **Module**, **Class** or **Function** inside it (or right-click the canvas → **Add module here**, or the **+ Module** buttons in the inspector's *Inside* section). A container is drawn as a region around its members; drag a node into or out of one to move it. Give a function read and write steps as you would a program, drag the handle on its header onto another node for a **call** (an **import** between modules, an **extends** between classes), and drag from a table's column handle onto a node for a read on that column. Right-click a region → **Collapse to one node** folds it and gathers its arrows; **Trace** accepts a code node at either end |
| Simulate data flow | **Simulate** button (or `S`) with a table selected, the **Simulate** drawer tab, or right-click a table → *Simulate data flowing in*. Sample rows are generated for the raw inputs (filter values such as `'paid'` are planted so filters have something to match), every flow upstream runs in order, and playback steps through the stages: the canvas animates rows along each flow, the grids show the source and target rows, and clicking a produced row highlights the rows it came from and explains each column. Double-click a raw input cell to change it; `Esc` leaves the mode |
| Tag a query on any edge | Click the edge, fill in **Tagged query**; a badge appears on the edge and the query is added as a comment block in the generated script. Free text and derived columns coexist — use the query for joins and conditions the structured form cannot express. The menu above the box offers queries written for this connection from what the diagram knows — the `JOIN` of a foreign key, its orphan check, an `INSERT … SELECT` with columns paired by name or a dialect-correct upsert for a data flow, the statement built from the derivations, JSON unpacking for a serialized one — as a starting point; `Ctrl+Enter` runs the query in the Query tab, and the expand button opens it in a bigger window |
| Write SQL anywhere | Every SQL box is the same editor: the diagram's table and column names are coloured (so a typo shows up as plain text), `Ctrl+Space` completes tables, columns, keywords and functions — `orders.` or an alias's `o.` narrows to that table's columns — and problems show under the box as you type: an expression the simulator cannot parse, a column the source table does not have (with the `table.column` spelling that would reach it), a table the diagram does not have, an unclosed string or parenthesis. `Enter` keeps the indentation, `(` and `'` close themselves, `Tab` / `Shift+Tab` indent, `Ctrl+/` comments lines out, `Ctrl+Shift+F` formats |
| See / copy DDL | Bottom drawer → **SQL** (whole schema or the selected table). The table inspector also has a preview |
| Import DDL | Bottom drawer → **Import SQL**, paste or load a `.sql` file, choose add/replace; optionally drop it all into a group. The preview follows the text — tables, foreign keys, errors and warnings appear a moment after you stop typing, and clicking an error puts the caret on its line; `Ctrl+Enter` imports. Dropping a `.sql`, `.dbviz.json`, SQLite or DuckDB database file on the canvas, or pasting DDL with `Ctrl+V`, does the same |
| Check the schema | Bottom drawer → **Problems**: lint findings with one-click fixes, and suggested foreign keys from column names |
| Copy / paste tables | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` on the selection; pasting between browser tabs or diagrams works too |
| Copy tables out as text | One `Ctrl+C` puts the selection on the clipboard three ways and the paste target picks: a text editor gets the `CREATE TABLE` script (one statement block per table), a Markdown editor such as Obsidian gets the data dictionary — a table of columns per table, then the connections, then the DDL in a `sql` fence — and this app gets the tables back with their positions, colours and every connection kind. Right-click → **Copy as** (or `Ctrl+K` → *Copy the selected tables as…*) picks one format explicitly. Every format covers only the tables you selected: a foreign key to a table you did not copy is left out, and the text says which ones and why |
| Switch dialect | Top bar selector (PostgreSQL, MariaDB, SQLite, DuckDB); known column types are translated (`SERIAL` ↔ `INT AUTO_INCREMENT`, `TIMESTAMPTZ` ↔ `TIMESTAMP`, `JSONB` ↔ `JSON`, `INT UNSIGNED` ↔ `UINTEGER`, …). Undo reverts |
| Collapse tables | The chevron in a table header cycles all columns → keys only → header only; **View → All tables** does it for everything; zooming far out collapses automatically |
| Focus on a table | Select it and press `.` (or right-click → Focus); `[` / `]` change how many hops stay visible, `Esc` clears |
| Align and tidy | Box-select, then right-click → Align / Distribute; **View → Snap to grid**, a toggle that makes tables land on the grid as you drag them; arrow keys nudge the selection (`Shift` for bigger steps); right-click the canvas → **Group tables by schema** |
| Detangle | **Detangle** button (`L`), direction menu next to it |
| Trace | **Trace** button: with two tables selected it traces immediately, otherwise it enters pick mode; or use the **Trace** drawer tab |
| Save / open | File menu, `Ctrl+S` / `Ctrl+O` (`.dbviz.json`, the whole workspace in one file). **File → Open recent…** lists every workspace this browser has worked on, with thumbnails |
| Checkpoints | Inspector → Diagram panel → **Checkpoints**, or **File → Save checkpoint…**: a named snapshot you can restore any time. A checkpoint belongs to the tab it was taken on |
| Export | File menu → PNG, SVG, SQL script, Markdown data dictionary, Mermaid ER diagram, or DBML; the SQL tab previews all the text formats |
| Share | **File → Copy share link**: the whole diagram is compressed into the URL, so whoever opens it gets a copy with nothing to install |
| Docker & database | **Database** button → left column manages containers, right column tests a connection, runs the schema, reads an existing schema, **migrates** a live database to match the diagram, or **seeds** it with generated rows |
| Query | Bottom drawer → **Query**: read-only `SELECT`s against the connected database, with `Ctrl+Enter` to run the selection or the statement under the cursor, snippets from the diagram, history and CSV / JSON copy |
| SQLite in the browser | Pick the SQLite dialect and the Database tab runs the schema in an in-browser database (persisted in this browser) that Query, Migrate and Seed all talk to |
| DuckDB in the browser | Pick the DuckDB dialect and the Database tab runs DuckDB-Wasm: the database is a real `.duckdb` file kept in the browser's private file storage, so it survives reloads, can be downloaded, and a `.duckdb` file can be opened or dropped on the canvas |

Press `?` in the app for the full shortcut list.

## Walkthroughs

[`docs/walkthroughs/`](docs/walkthroughs/) is seventeen hands-on guides that build
**one database, once**: walkthrough 00 puts two tables on the canvas, walkthrough
14 exports the eighteen-table bookshop they grew into, walkthrough 15 adds
the one column type PostgreSQL cannot make without an extension, and walkthrough
16 draws the checkout service that uses all of it beside the tables. Each one
picks the canvas up exactly where the last put it down — the foreign keys from
02 are what the derivations in 05 resolve through, the enum from 04 is what the
seeded rows in 13 obey — so the schema in front of you is always the one you
built.

In the app they run as clickthroughs rather than pages to read: pick one from
the **?** menu and a card follows you around the window, pointing at the button,
field or table each step is about, ticking itself off as you do the work, and
offering to **Do it for me** when you would rather watch the change happen than
type it. Nothing is blocked while it is up — you are working in the real app.

Start with [Your first diagram](docs/walkthroughs/00-your-first-diagram.md), or
open any walkthrough and press **Set up the canvas**: it loads the diagram that
one starts from, so you can begin at
[filling one table from another](docs/walkthroughs/05-fill-one-table-from-another.md),
[indexes](docs/walkthroughs/07-add-indexes.md) or
[importing someone else's schema](docs/walkthroughs/09-import-an-existing-schema.md)
without typing the ones before it. **Check my work**, in the **Walkthrough**
drawer tab, runs that walkthrough's own checks against your canvas and says what
is missing.

Those checks are the walkthrough's front matter — assertions about its companion
diagram, like the SQL it generates, whether it lints clean, whether it simulates
— and `npm test` runs the same ones against the app's own code, so the pages
cannot quietly go out of date and the button can never disagree with CI. Each
step's ticks work the same way: a step declares what it is for once, and that one
declaration is both what the card checks and what **Do it for me** performs, so
the two can never describe different things.
[`docs/walkthroughs/WALKTHROUGH_FORMAT.md`](docs/walkthroughs/WALKTHROUGH_FORMAT.md)
is the format and the procedure for adding one.

## Connection types

A connection has two independent halves. Its **kind** is what the database
actually does, and it drives everything mechanical — DDL, joins, layout,
drawing. Its **verb** is how the connection reads in English, and it only
changes the words.

| Kind | Drawn as | In the script | Means |
| --- | --- | --- | --- |
| Foreign key | solid, crow's foot | `FOREIGN KEY … REFERENCES …` | A constraint the database enforces |
| Data flow | dashed, filled arrow | a comment, read back on import | Rows in the target are built from the source by a job, rollup, or trigger |
| Serialized | solid, filled diamond at the container | a comment, read back on import | The target's rows live encoded inside one column of the source (JSONB, an array, a blob, a composite type) |
| Dependency | dotted, open arrow | a comment, read back on import | The source reads the target through a view, a job, or application code, with nothing enforcing it |

"a comment" is not the same as "lost": the script's own comments carry every
connection back, so exporting SQL and importing it again returns the diagram
you exported. See [Exporting a script and importing it back](#exporting-a-script-and-importing-it-back).

Verbs are always stored source → target, so every one of them also gives you
the reverse reading for free — which is where the rest of the vocabulary comes
from:

| You want to say | Pick | Reads back as |
| --- | --- | --- |
| `orders` **has** `order_items` | foreign key, *belongs to* (on the child) | order_items belongs to orders |
| `orders` **contains** `order_items` | foreign key, *is part of* (on the child) | order_items is part of orders |
| `orders` **uses** `currencies` | foreign key, *uses* | currencies used by orders |
| `report` **uses** a table with no FK | dependency, *uses* | orders used by report |
| `line_item` **serialized** into `orders` | serialized, *serializes* (on the container) | line_item serialized into orders |
| `employees` **extends** `people` | foreign key, *extends* | people extended by employees |

So "has", "contains" and "used by" are not separate connections — they are the
same edge read from the other end, which is why the inspector shows you both
sentences before you commit to a direction. "Serialized" is the one that has no
foreign key behind it at all, so it gets a kind of its own; a dependency covers
"uses" when nothing in the schema records it.

Only foreign keys become `JOIN` conditions in a trace. The other kinds are
still walked (a path can cross them) but appear as `CROSS JOIN` plus a comment
saying why there is nothing to join on.

## Describing and simulating how data moves

A data-flow connection says *that* rows in the target are built from the source.
Its **derived columns** say *how*, one entry per target column, and each entry is
made of parts the app can reason about:

| Part | Example | Meaning |
| --- | --- | --- |
| Expression | `quantity * unit_price_cents` | SQL evaluated on each source row. May use another table's column as `table.column` when the source reaches it through foreign keys: `orders.status` from `order_items` follows `order_items.order_id → orders.id` |
| Aggregate | `SUM`, `COUNT`, `AVG`, `MIN`, `MAX` | Wrapped around the expression; the rows are grouped by the group-by keys first |
| Group by | `product_id`, `CAST(orders.placed_at AS DATE)` | Keys that define the groups. A key that names a target column fills it |
| Filter | `orders.status = 'paid'` | Source rows the flow ignores |
| Sequence | change since the previous row, ordered by `placed_at`, partitioned by `customer_id` | Put the rows in order and compute each value from its neighbours: previous / next value, the difference to the previous row (seconds for timestamps, days for dates), a running total or average, a row number or rank. A sequence result can then be aggregated: the average gap between orders |

So "table B's `key1` is the average of table A's `key2` grouped by A's `key1`"
is one entry: target `key1`, aggregate `AVG`, expression `key2`, group by
`key1`. "Table C holds the time between consecutive points of table D where
`key3 >= 4`" is one entry too: target `gap`, sequence *change since the previous
row* over expression `ts` ordered by `ts`, filter `key3 >= 4`.

Once a flow says that much, the app knows which columns are **computed** rather
than stored, and marks them everywhere it shows a column: the canvas, the
inspector's column grid, the Markdown data dictionary. A column counts as
computed when an entry fills it, when a group-by key of the same name is carried
into it (which is how a rollup keyed on `product_id` fills the target's own
`product_id`), and when it belongs to a view, whose SELECT produces every one of
its columns. Everything else is stored: rows arrive carrying the value. The
**Derived** tab reads the chain in both directions — what a column is computed
from, following each flow back through the ones before it, and what is computed
from it — resolving `table.column` references through the same foreign keys the
generator writes JOINs for.

**Simulate** turns that description into rows you can watch. Pick the table you
want to see fed and every flow upstream of it runs once over generated sample
data, in dependency order: raw inputs are seeded (values a filter compares
against are planted so it has something to match), each flow filters, orders,
groups and aggregates its source, and the result becomes the input of the next
flow. Playback walks the stages: on the canvas the flow in play pulses, dots
travel it from source to target, the columns being read and written light up,
and every table shows how many rows it holds so far; in the drawer the source
grid marks which rows survived the filter, the target grid grows, and clicking
a produced row highlights the rows that fed it and spells out each column
(`units_sold = SUM(quantity) over 3 rows [#2: 4, #5: 1, #9: 12] = 17`). Raw
input cells can be edited in place to try a what-if. The simulation is a
model of the derivations, not a database: expressions use a SQL subset
(arithmetic, comparisons, `AND`/`OR`/`NOT` with `NULL` logic, `IN`, `BETWEEN`,
`LIKE`, `CASE`, `CAST`, `EXTRACT`, and the common scalar functions), joins that
are not foreign keys stay in the free-text query, and anything it cannot compute
is reported as a warning on the stage rather than guessed.

## Project layout

```
src/shared/types.ts      data model + API contracts shared by client and server
src/lib/sql/             tokenizer, parser (DDL -> model), generator (model -> DDL), dialect helpers
src/lib/sql/annotations.ts  the connections a script carries in its comments, so exported SQL imports back whole
src/lib/groups.ts        table groups: region geometry, membership, external tables
src/lib/programs.ts      programs: the arrows derived from their steps, round-trip detection, prose summaries
src/lib/codemap.ts       code maps: the containment tree, what a collapsed container stands in for, gathered arrows, container regions, paths
src/lib/code/           drivers.ts: which package each language reaches each engine with; generate.ts: the starter, one file per container; highlight.ts: a lexer per host language
src/lib/layout.ts        dagre-based "detangle" (groups become dagre clusters)
src/lib/trace.ts         BFS path finding + join-query builder
src/lib/lineage.ts       which columns are computed rather than stored, what each one reads, and the chain in both directions
src/lib/simulate/        expression.ts: SQL expression parser/evaluator; engine.ts: runs the data flows over sample rows with lineage
src/lib/io.ts            .dbviz.json save/load (one diagram, or a workspace of several)
src/lib/sheets.ts        add / rename / close a diagram tab, with the questions each one asks first
src/lib/extensions/      engine extensions: bundled definitions, loadable packs, and the registry that merges them with what a live server reports
src/lib/lint.ts          schema linter with one-click fixes; suggest.ts proposes foreign keys
src/lib/migrate/         diagram vs. database diff and per-dialect ALTER generation
src/lib/seed.ts          deterministic seed-data generator
src/lib/export/          Mermaid and DBML exporters (markdownExport.ts for the data dictionary)
src/lib/selectionExport.ts  a selection as SQL / Markdown / HTML, keeping only the connections inside it
src/lib/canvasActions.ts    copy, cut and paste: which clipboard flavor each paste target gets
src/lib/share.ts         share links (diagram compressed into the URL hash)
src/lib/library.ts       IndexedDB workspace library and per-diagram checkpoints
src/lib/sqlite/          in-browser SQLite engine (sql.js) behind the same interface as the server
src/lib/duckdb/          in-browser DuckDB engine (DuckDB-Wasm on the origin-private file system) behind the same interface
src/store/useStore.ts    zustand store with undo/redo and autosave; the sheets of the workspace live here
src/components/SheetTabs.tsx  the diagram tabs above the canvas
src/store/useSimulation.ts  simulation mode: target, sample options, playback, recompute on edit
src/components/          React UI (canvas, inspector, drawer panels, command palette)
server/                  Express API: Docker control, pg / MariaDB execution, introspection and read-only queries
scripts/                 validate-dbviz.mjs (diagram files), validate-walkthrough.mjs and build-walkthrough-index.mjs (docs/walkthroughs)
docs/                    ADVISOR_OUTPUT_FORMAT.md, CODE_MAP_FORMAT.md, EXTENSION_PACK_FORMAT.md, examples, and walkthroughs/
tests/                   vitest unit tests for the SQL round-trip, lint, migrate, seed, exports, tracing, column lineage, layout, file format, the simulation, extensions, code maps, the walkthroughs and their clickthroughs, plus the server's catalog queries against a real PostgreSQL (PGlite)
```

```bash
npm test          # unit tests
npm run typecheck # client + server
```

## Feeding it from another tool (or an AI advisor)

[`docs/ADVISOR_OUTPUT_FORMAT.md`](docs/ADVISOR_OUTPUT_FORMAT.md) is a hand-off spec you can
paste into a database advisor agent's instructions: it tells the agent when to emit plain
DDL (for the **Import SQL** drawer) versus a full `.dbviz.json` (for **File → Open**),
documents every field of the diagram file, and lists the rules that keep a hand-written
file loadable. [`docs/examples/orders-rollup.dbviz.json`](docs/examples/orders-rollup.dbviz.json)
is a complete example.

Check a generated file before opening it:

```bash
node scripts/validate-dbviz.mjs recommendation.dbviz.json
```

It flags duplicate ids, dangling table/column/group references, mismatched foreign-key
column lists, verbs that do not fit their connection kind, dialect/type mix-ups, unknown
colour keys and stacked table positions — all things the app loads without complaint but
that produce a wrong diagram.

## Programs: the work that happens outside the database

Everything else on the canvas is something the database contains. A program is
the opposite: it is the caller. It exists because *where a computation happens*
is a design decision worth drawing, and because the one placement the diagram
could not previously show is the interesting one — a fit, a render, a model
call, a request to somebody else's API. None of those can be SQL, and a rollup
that could have been SQL does not need a program at all.

A program is an **ordered list of steps**, and the order is the whole point:

| Step | Means |
| --- | --- |
| Read | A `SELECT`: rows leave the table and arrive in the program |
| Write | An `INSERT`, `UPDATE` or `DELETE`: the program puts rows back |
| Compute | Work the database never sees, and the reason the program exists |

Written that way, a round trip reads straight off the canvas without opening
anything — `1 read jobs`, `2 compute`, `3 write results`, `4 write jobs` — with
a numbered arrow per step, pointing at the program for a read and at the table
for a write. A program that both reads and writes the same table says so
underneath: *round trip: jobs*.

The arrows are never stored. They are derived from the steps, the same way a
group's rectangle is derived from its member tables, so reordering a step moves
its arrow with it and an arrow that means nothing cannot exist. Deleting a
table does **not** delete the steps that named it: their SQL and their code are
the part nobody can reconstruct, so they stay, and **Problems** reports the
dangling reference with a one-click fix that removes the step once you agree.

### Code, and a starter written from the steps

Each step holds the statement it runs and the host-language code around it,
coloured by a lexer written alongside the SQL one. Leave a step's SQL empty and
the generated starter writes one from the table and columns you picked.

The **starter** is the same move the app already makes for `CREATE TABLE`,
`JOIN`s, `INSERT … SELECT`, seed rows and `ALTER` scripts, pointed outward at
the client instead of inward at the schema. It names the driver a reader would
actually reach for, binds parameters the way that driver expects, and puts
everything after the first read inside a row loop, which is what a worker
usually wants:

| Language | PostgreSQL | MariaDB | SQLite | DuckDB |
| --- | --- | --- | --- | --- |
| Python | psycopg 3 | MariaDB Connector/Python | `sqlite3` | duckdb |
| Rust | sqlx (postgres) | sqlx (mysql) | sqlx (sqlite) | duckdb |
| Go | pgx | go-sql-driver/mysql | modernc.org/sqlite | go-duckdb |
| C / C++ | libpq | MariaDB Connector/C | SQLite | DuckDB C API |
| Java | PostgreSQL JDBC | MariaDB JDBC | SQLite JDBC | DuckDB JDBC |
| JavaScript / TypeScript | node-postgres | mariadb | `node:sqlite` | @duckdb/node-api |

It is a starting point and says so: compute steps come out as stubs that raise,
because the work outside the database is exactly what the diagram cannot know.
C#, Ruby, Shell and *Other* have no driver template, so they get the plan in
comments rather than code pretending to compile.

Ask a **container** for its starter and you get the whole file, not one step
list. A module is a file, so its classes and the functions in them are written
out as real definitions, nested the way the canvas nests them, sharing one
namespace so two functions can never collide over a constant. A class is a
definition wherever you select it, so you get the class and its methods. The
one line the file does not cross is the file boundary: a module inside a module
gets a starter of its own and is named in the header instead of being inlined,
which is the same reason a program does not swallow the modules under it.

Two more things come from the node rather than from a guess. An **import** step
becomes an import line at the top of the file — `import inventory`, `use
crate::inventory`, `import * as inventory from './inventory.js'` — and an
**extends** step becomes the base class in the declaration, or a comment where
the language has no inheritance. And *Signature or location* is used as the
signature when what you typed reads as one in the file's own language, so
`def place_order(self, email, cart) -> int` is the signature you get; a
signature that already names the connection is handed it, and one that does not
opens its own, because the diagram cannot say where yours comes from.

### Where they show up

Programs are documentation, so they never reach the `CREATE TABLE` script — but
they are not lost by it either. They ride in the same `-- dbviz:connections`
comment block the data flows use, and **Import SQL** reads them back, so
exporting a diagram and importing it again returns what you exported. Markdown
gets a section per program plus a *touched from outside the database* list on
every table one reaches; Mermaid draws them as entities marked with a comment;
DBML, which has only tables, keeps them as notes.

**Problems** knows a few things worth being told: a step writing a column a
data flow already computes (one of the two is wrong about where the value comes
from), a write to a view, a write to a table you marked as living in another
database, and a program that never touches the schema at all.

### Modules, classes and functions: mapping a codebase

A program is enough for "a job does this nightly". It is not enough for the
question a schema change really raises — *which function writes this column,
and what does it call on the way?* — so a program can open up into the code
behind it. The pieces are the same node with a **kind** and a **parent**:

| Kind | Is | Sits inside |
| --- | --- | --- |
| Program | something that runs: a service, a job, a script | nothing; it is the root |
| Module | a file or a package | a program, or another module |
| Class | a class, a struct, a type with methods | a program, a module, or another class |
| Function | a function or a method, and the node whose steps say what it does | any of those |

Three more kinds of step name code instead of a table — **call**, **import**
and **extends** — and each draws its arrow to the node it names, numbered in
step order like a read or a write. So `place_order` reads `customers`, writes
`orders`, writes `order_items` and calls `reserve_stock`, which reads and
writes `stock_levels`: four arrows to tables and one to a function, and
**Trace** from `place_order` to `stock_levels` runs through the call.

Nothing about the map is stored except the nodes, their parents and their
steps. A module or class with members is drawn as a **region** — the bounding
box of what is inside it, like a group's rectangle — and dragging a node into
or out of a region is how it changes container. **Collapse** a container and
it folds to one node; every arrow into or out of what it hides is redrawn from
the folded node, and arrows that then say the same thing are gathered into
one carrying a count, so a whole service reads as one node with one arrow per
table, exactly as a plain program would. Only the outermost collapsed
container counts, so folding a program hides its folded modules too.

The map goes everywhere a program goes, the generated starter included: a
module's starter is the file, holding the classes and functions drawn inside it.
The SQL annotation block names nodes
by **path** (`bookshop_api/orders.py/OrderService/place_order`) rather than
id, so it survives a re-import; the Markdown export's `## Code` section walks
the tree; Mermaid and DBML carry each node; copying a container copies its
members; **Problems** adds the rules a map needs — a container holding a kind
it cannot, a call to something that is gone (the step and its code are kept,
the fix is one click), a function nothing calls, a circular import. The file
format, the annotation block and the derived-versus-stored rules are in
[`docs/CODE_MAP_FORMAT.md`](docs/CODE_MAP_FORMAT.md); walkthrough
[16](docs/walkthroughs/16-map-the-code-that-talks-to-it.md) builds one by hand.

## Several diagrams in one workspace

The tabs above the canvas are the diagrams of one workspace, the way a
spreadsheet holds several worksheets in one file. Use them for the databases a
system actually has — the application database, the warehouse it feeds, the
third-party database you only read — or for versions of one schema you want to
compare side by side.

Each tab is a whole diagram: its own dialect, tables, connections, groups,
notes, and its own undo history, selection and viewport, so switching away and
back puts you exactly where you were. What is global stays global: the theme,
the panel sizes, and the one database connection the **Database** and **Query**
tabs talk to. A simulation stops when you leave the tab it was running on.
`Ctrl+C` in one tab and `Ctrl+V` in another copies tables between diagrams,
connections and all.

Saving writes the whole workspace into one `.dbviz.json`:

```json
{ "version": 1, "kind": "workspace", "name": "Orders platform",
  "activeSheet": "sht_app",
  "sheets": [ { "id": "sht_app",  "name": "Application", "dialect": "postgresql", "tables": [ … ] },
              { "id": "sht_wh",   "name": "Warehouse",   "dialect": "postgresql", "tables": [ … ] } ] }
```

A workspace holding a single diagram is written as a bare diagram instead —
byte for byte the file this app has always written — so nothing that reads
`.dbviz.json` has to learn a new shape until there is a second diagram to put
in it. Files written before workspaces existed load as a workspace of one, and
`node scripts/validate-dbviz.mjs` reads both shapes.
[`docs/ADVISOR_OUTPUT_FORMAT.md`](docs/ADVISOR_OUTPUT_FORMAT.md) documents the
envelope for tools that generate one.

**File → Open recent…** lists workspaces rather than single diagrams, and each
tab has its own checkpoints, so restoring one puts back that diagram and leaves
the others alone. A share link still carries one diagram: opening one adds it to
your workspace as a new tab instead of replacing what you had.

## Groups and a second database

A group is a labelled region drawn around a set of tables. Its rectangle is
derived from where its member tables sit rather than stored, so Detangle, an
import or a drag can never leave the region and its contents out of step.
Membership lives on the table (`Table.groupId`); dragging a table into a region
joins it, dragging it clearly outside leaves.

Ticking **These tables live in another database** makes the group *external*,
which is the case for a database you query but do not own:

- its tables are left out of the generated `CREATE TABLE` script, out of
  **Run schema**, and out of the `DROP TABLE` prefix;
- a foreign key from your schema into one of those tables cannot exist, so it is
  emitted as a commented-out `ALTER TABLE` in an **External sources** appendix,
  with a warning in the SQL tab;
- foreign keys *inside* the external group are that database's business and are
  skipped entirely;
- data-flow links and their tagged queries still work across the boundary — that
  is the point: the diagram documents how you pull the data across. Tracing a
  path that crosses the boundary says so in the generated `JOIN`.

**Database → Read schema** and **Import SQL** can both drop everything they
bring in straight into a new group, external by default, which is usually what
you want when you are reading someone else's database.

## Extensions

A schema that stores embeddings in a `vector(1536)` column or shapes in a
`geometry(Point,4326)` one depends on something the engine does not have out of the
box. Declare it in **Types → Extensions** and the diagram carries that dependency:

- the generated script opens with `CREATE EXTENSION IF NOT EXISTS vector;`, before
  the types and tables that need it;
- the extension's types appear in every column's TYPE box and its functions in the
  DEFAULT box, so `vector(1536)` and `gen_random_uuid()` autocomplete;
- **Problems** reports a column whose type needs an extension you have not enabled —
  a real error, because the `CREATE TABLE` would fail — and offers to enable it;
- importing a schema that says `CREATE EXTENSION`, or reading one off a live
  database, brings the extensions with it.

Only PostgreSQL installs extensions from a schema script. MariaDB's equivalent is a
plugin loaded into the whole server with `INSTALL SONAME`, and SQLite's modules are
compiled in or loaded by the client, so on those two the declaration documents the
dependency and the script carries the exact statement as a comment rather than
running it with your schema. DuckDB is the other engine where it is plain SQL:
`INSTALL spatial; LOAD spatial;` opens the script, and the in-browser engine fetches
the extension from extensions.duckdb.org the first time it runs.

**Where the definitions come from.** The diagram stores only an extension's name, so
a file you share stays small and opens for someone who has never heard of it. What an
extension *provides* comes from a catalog with three layers, each outranking the one
before it:

1. **Bundled** — the usual PostgreSQL extensions, MariaDB plugins, SQLite modules and DuckDB extensions,
   shipped with the app so the common cases work offline.
2. **Packs** — one JSON file listing what a set of extensions provides, loaded from
   disk or a URL. This is how you teach the app about anything it does not bundle.
   The format is [`docs/EXTENSION_PACK_FORMAT.md`](docs/EXTENSION_PACK_FORMAT.md),
   with an example in [`docs/examples/`](docs/examples/).
3. **A live database** — **Read from the database** asks the server you are connected
   to. A PostgreSQL server that has an extension installed knows exactly what it
   added, because `pg_depend` ties every type, function, index access method and
   operator class back to the extension that created it. So the app can describe an
   extension nobody wrote a definition for, and describe it correctly for *that*
   server — which is why it beats both other layers. **Keep as a pack** saves what it
   said. MariaDB answers from `information_schema.PLUGINS`, the in-browser SQLite
   from `PRAGMA compile_options` and DuckDB from `duckdb_extensions()`.

A definition only ever teaches the app names and prose. Nothing in a pack becomes SQL,
and an extension with no definition at all still generates the right statement — it
just gets no autocomplete and no checks.

## Exporting a script and importing it back

A `.sql` file can only say what an engine understands, and most of what the
diagram knows has no SQL to be written in: a data flow, a serialized copy, a
dependency, the verb a connection reads with, the note and the query tagged
onto it, the derived columns behind a rollup, and the programs that talk to the
schema from outside it. So the generated script says all of it twice at the end — once as prose, for whoever opens the
file, and once as JSON inside `--` comments, for **Import SQL**:

```sql
-- [flow] orders feeds customer_cadence (nightly rollup)
--   Full rebuild, not incremental.
--   Derived columns:
--     order_count = COUNT(*) GROUP BY customer_id WHERE status <> 'cancelled'

-- ----------------------------------------------------------------
-- Connection metadata: the same connections once more, in the form Import SQL
-- reads. …
-- dbviz:connections v1
-- {
--   "connections": [
--     {
--       "kind": "flow",
--       "verb": "feeds",
--       "from": "orders",
--       "to": "customer_cadence",
--       "name": "nightly rollup",
--       "derivations": [ … ]
--     }
--   ],
--   "programs": [
--     {
--       "name": "scorer",
--       "language": "python",
--       "role": "job",
--       "steps": [
--         { "op": "read", "table": "jobs", "columns": ["id", "payload"] },
--         { "op": "compute", "note": "score the payload" },
--         { "op": "write", "table": "results", "columns": ["job_id", "score"] }
--       ]
--     }
--   ]
-- }
-- dbviz:end
```

Export, edit the file in a text editor, import it again, and the connections
come home with it. Three things follow from how it is written:

- **It is a comment.** Every engine ignores it, the statement list the
  **Database** tab runs never contains it, and deleting the block costs you the
  annotations and nothing else.
- **It names tables and columns rather than ids.** Rename a table in the DDL
  and rename it in the block and the two still match; paste the script into a
  diagram whose ids came from somewhere else and it still lands. A foreign key
  the DDL already carries is enriched by the block, not duplicated by it.
- **It only covers what the script creates.** A connection with an end in an
  external group is left to the "External sources" appendix, because the script
  does not create those tables and there would be nothing to attach it to.
  Positions, colours, groups and sticky notes are not connections and are not
  in it either — `.dbviz.json` is still the format that keeps the whole diagram.
- **A program step keeps its work even when its table does not come back.** A
  connection with a missing end describes nothing and is reported as skipped; a
  step whose table the script does not define is still the SQL and the code
  somebody wrote, so it comes back without the pointer and **Problems** takes it
  from there.

An unreadable block (a hand edit that broke the JSON, or a version a later
build wrote) is reported as a warning and the DDL imports regardless, and a
script that has no block at all — anything `pg_dump` or `mysqldump` wrote —
imports exactly as it always did.

## Notes on the SQL support

The parser is purpose-built for schema DDL rather than a full SQL grammar. It handles `CREATE TABLE` with column and table constraints in both dialects, `ALTER TABLE … ADD CONSTRAINT / ADD COLUMN / ALTER COLUMN SET DEFAULT|NOT NULL`, `CREATE [UNIQUE] INDEX`, `COMMENT ON`, `CREATE TYPE … AS ENUM`, and `CREATE EXTENSION` (plus MariaDB's `INSTALL SONAME` / `INSTALL PLUGIN`). Anything else is skipped with a warning, and a broken statement does not stop the rest of the script from importing. Generated columns, partitioning, and expression indexes are dropped with a warning because the model does not represent them.

Views are first-class: `CREATE VIEW … AS SELECT …` (PostgreSQL, MariaDB and SQLite flavours, including `MATERIALIZED`, `ALGORITHM=`/`DEFINER=` prefixes and `WITH CHECK OPTION`) becomes a view node fed by data-flow links from the tables its SELECT reads, and the generated script creates views after every table, in dependency order. A materialized view stays materialized through import, save and introspection; because only PostgreSQL has them, the other two dialects generate a plain `CREATE VIEW` with a warning rather than a statement they cannot run, and the flag is preserved so switching back restores it. SQLite is a third dialect: the generator writes `INTEGER PRIMARY KEY AUTOINCREMENT`, keeps every foreign key inline (SQLite resolves them at run time, so cycles need no `ALTER TABLE`), turns enum types into `CHECK (col IN (…))`, drops schema prefixes and moves comments into the script, and the parser accepts `AUTOINCREMENT`, `[bracketed]` identifiers, `WITHOUT ROWID` and `STRICT`. Column types are translated when you switch to or from SQLite.

DuckDB is the fourth dialect, and the second that runs inside the browser (DuckDB-Wasm, in a Web Worker). Its DDL is PostgreSQL's with a few rules of its own, which the generator follows: there is no serial or identity column, so an auto-increment column reads its default from a sequence created just before its table (`CREATE SEQUENCE orders_id_seq;` … `id INTEGER PRIMARY KEY DEFAULT nextval('orders_id_seq')`); enum and composite types are real `CREATE TYPE … AS ENUM` / `AS STRUCT(…)`; foreign keys support no referential action beyond refusing the change, so `ON DELETE CASCADE` is left out with a warning and Problems flags it; a foreign key can only be written inside `CREATE TABLE`, so one that closes a reference cycle is documented as a comment instead; comments are real `COMMENT ON`; schemas are created with `CREATE SCHEMA IF NOT EXISTS`. Types are translated on the way in and out (`INT UNSIGNED` ↔ `UINTEGER`, `TEXT[]` ↔ `VARCHAR[]`, `STRUCT(…)` → `JSONB`, `HUGEINT` → `NUMERIC(39,0)`), the parser reads `STRUCT(…)` / `MAP(…)` / `INTEGER[3]` types, `CREATE TYPE … AS STRUCT`, `CREATE SEQUENCE` and `INSTALL` / `LOAD`, and reading a live schema uses DuckDB's own `duckdb_tables()` / `duckdb_columns()` / `duckdb_constraints()` catalog functions, mapping an enum column back to the named type it was declared with. In the browser the database is a real `.duckdb` file on the origin-private file system, so it survives reloads and downloads as a file the DuckDB CLI opens; a browser without that storage falls back to an in-memory database for the session. Extensions a script loads (`json`, `spatial`, …) are fetched from extensions.duckdb.org, so they need the network the first time.

**Migrate** introspects the connected database and diffs it against the diagram: new and dropped tables, added / dropped / retyped columns, nullability and default changes, foreign keys and indexes. The `ALTER TABLE` script it writes follows each dialect's rules (`ALTER COLUMN … TYPE` in PostgreSQL, `MODIFY COLUMN` in MariaDB, a create-copy-drop-rename rebuild for the changes SQLite cannot express, and for DuckDB the indexes dropped and recreated around a column change, since it refuses to alter an indexed table), with destructive statements grouped at the end and commented out unless you tick them. DuckDB cannot add or drop a constraint on an existing table (a primary key can be added once), so those changes are written as notes rather than statements it would reject. It works from the diagram alone, so it cannot see data; review the script before running it.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
