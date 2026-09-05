# Database Visualizer

A locally hosted web app for designing relational schemas visually.

- Draw tables and their connections on a pan/zoom canvas: crow's-foot foreign keys plus three kinds the database cannot enforce — data flows, serialized copies, and plain dependencies. Views are nodes too, fed by the tables their `SELECT` reads.
- Say how a connection *reads*: "orders **contains** order_items", "customers **has** addresses", "orders **uses** addresses". The verb is documentation, so it never changes the DDL.
- Tag any connection with the query that moves data across it, so the diagram documents *how* one table feeds another, not just that they are related.
- **Group** tables into a labelled region — handy when part of the diagram is a *different* database you only read from. Mark that group external and the generated script documents those tables instead of creating them.
- Generate the `CREATE TABLE` script for **PostgreSQL**, **MariaDB** or **SQLite** from the diagram, or paste DDL (including `pg_dump` / `mysqldump` output) and get the diagram back. Enum and composite types are first-class.
- **Problems**: a schema linter that flags missing primary keys, foreign keys onto non-unique columns, type mismatches, duplicate names, reserved words and more — most findings fix themselves with one click — plus foreign-key suggestions read off column names.
- **Detangle**: a layered auto-layout that ranks referenced tables before the tables that reference them and minimises edge crossings. Align, distribute, snap to grid and nudge with the arrow keys for the last few pixels.
- **Trace**: pick two tables and get the shortest chain of connections between them, highlighted on the canvas, plus the `JOIN` query for that path.
- **Read a big diagram**: collapse tables to keys or headers (automatically when zoomed out), focus on one table and its neighbours, cardinality labels on every connection, and one-click grouping by schema.
- **Command palette** (`Ctrl+K`): jump to any table or run any action by typing a few letters.
- **Migrate and seed**: diff the diagram against a live database and get the `ALTER` statements that bring it up to date; generate deterministic seed rows that respect foreign keys, uniqueness and enums.
- **Query**: run read-only `SELECT`s against the connected database with a results grid, snippets built from the diagram, and history.
- Export as PNG, SVG, SQL, Markdown, Mermaid or DBML; save a `.dbviz.json` file; or copy a **share link** that carries the whole diagram in its URL. Every diagram you work on is kept in the browser's library with thumbnails and named checkpoints.
- **Docker & database**: start a PostgreSQL or MariaDB container from the UI, create the schema in it (or in any database you can reach), and pull an existing database's schema into the diagram. With the SQLite dialect the database runs *inside the browser*, no server required.

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

### Running the app itself in Docker

```bash
docker compose up --build
```

`docker-compose.yml` mounts the Docker socket into the container so the "create a database container" feature keeps working. Databases it creates are bound to `127.0.0.1` on the host, so from inside the app container point connections at `host.docker.internal` (already the default there).

## Using it

| What | How |
| --- | --- |
| Find anything | `Ctrl+K` opens the command palette: type a table name to jump to it, or the first letters of an action (export, detangle, collapse, switch dialect…) |
| Add a table | Double-click the canvas, press `T`, or use the **+ Table** button; the menu next to it adds a view, a note, a group or an enum type |
| Select a group | `Shift` + drag a box over the canvas — every table and note it touches is selected; drag any of them (or the dashed box) to move the group, `Delete` removes it in one undo step |
| Right-click anything | Every target has its own menu: the canvas (add a table or note right here, select all, detangle, undo, open a drawer), a table (rename, duplicate, colour, copy `CREATE TABLE`, trace, delete), a column row inside a table (toggle PK / NN / UQ / AI, add a column below, index it, reorder, delete), a connection (swap direction, switch its kind, copy the tagged query), a note, and the entries in the table list. Right-clicking inside a selected group acts on the whole group |
| Edit columns | Select a table; the inspector on the right has the column grid (PK / NN / UQ / AI toggles, expand a row for default, check, comment) plus indexes and table checks. `Enter` in a column name adds the next row, `Shift+Enter` inserts above, `Ctrl+Backspace` on an empty name deletes; drag the grip to reorder |
| Views | Switch a table to **View** in the inspector, paste its `SELECT`, and **Detect from SQL** draws the data-flow links from the tables it reads |
| Rename in place | Double-click a table header (or press `F2`) |
| Foreign key | Hover a table and drag the handle beside a column onto a column of another table |
| Group tables | Select them and press `G` (or the group button in the top bar). Drag a table into or out of a region to change what is in it; drag a region by its title bar to move everything inside it |
| Mark a group as another database | Select the region, tick **These tables live in another database** in the inspector |
| Any other connection | Drag the orange handle in a table header onto another table, then pick the kind in the inspector (data flow, serialized, dependency) |
| Change how a connection reads | Select it; **Reads as** offers the verbs that fit its kind and previews the sentence in both directions |
| Derived columns | On a data-flow edge, add one entry per target column: target column, aggregate, source expression, group-by keys, filter. The edge shows a `Σ` count and a per-column summary, and the script gets an `INSERT ... SELECT ... GROUP BY` skeleton built from it |
| Tag a query on any edge | Click the edge, fill in **Tagged query**; a badge appears on the edge and the query is added as a comment block in the generated script. Free text and derived columns coexist — use the query for joins and conditions the structured form cannot express |
| See / copy DDL | Bottom drawer → **SQL** (whole schema or the selected table). The table inspector also has a preview |
| Import DDL | Bottom drawer → **Import SQL**, paste or load a `.sql` file, choose add/replace; optionally drop it all into a group. Dropping a `.sql`, `.dbml` or `.dbviz.json` file on the canvas, or pasting DDL with `Ctrl+V`, does the same |
| Check the schema | Bottom drawer → **Problems**: lint findings with one-click fixes, and suggested foreign keys from column names |
| Copy / paste tables | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` on the selection; pasting between browser tabs or diagrams works too |
| Switch dialect | Top bar selector (PostgreSQL, MariaDB, SQLite); known column types are translated (`SERIAL` ↔ `INT AUTO_INCREMENT`, `TIMESTAMPTZ` ↔ `TIMESTAMP`, `JSONB` ↔ `JSON`, …). Undo reverts |
| Collapse tables | The chevron in a table header cycles all columns → keys only → header only; **View → All tables** does it for everything; zooming far out collapses automatically |
| Focus on a table | Select it and press `.` (or right-click → Focus); `[` / `]` change how many hops stay visible, `Esc` clears |
| Align and tidy | Box-select, then right-click → Align / Distribute; **View → Snap tables to the grid**; arrow keys nudge the selection (`Shift` for bigger steps); right-click the canvas → **Group by schema** |
| Detangle | **Detangle** button (`L`), direction menu next to it |
| Trace | **Trace** button: with two tables selected it traces immediately, otherwise it enters pick mode; or use the **Trace** drawer tab |
| Save / open | File menu, `Ctrl+S` / `Ctrl+O` (`.dbviz.json`). **File → Open recent…** lists every diagram this browser has worked on, with thumbnails |
| Checkpoints | Inspector → Diagram panel → **Checkpoints**, or **File → Save checkpoint…**: a named snapshot you can restore any time |
| Export | File menu → PNG, SVG, SQL script, Markdown data dictionary, Mermaid ER diagram, or DBML; the SQL tab previews all the text formats |
| Share | **File → Copy share link**: the whole diagram is compressed into the URL, so whoever opens it gets a copy with nothing to install |
| Docker & database | **Database** button → left column manages containers, right column tests a connection, runs the schema, reads an existing schema, **migrates** a live database to match the diagram, or **seeds** it with generated rows |
| Query | Bottom drawer → **Query**: read-only `SELECT`s against the connected database, with `Ctrl+Enter` to run, snippets from the diagram, history and CSV / JSON copy |
| SQLite in the browser | Pick the SQLite dialect and the Database tab runs the schema in an in-browser database (persisted in this browser) that Query, Migrate and Seed all talk to |

Press `?` in the app for the full shortcut list.

## Connection types

A connection has two independent halves. Its **kind** is what the database
actually does, and it drives everything mechanical — DDL, joins, layout,
drawing. Its **verb** is how the connection reads in English, and it only
changes the words.

| Kind | Drawn as | In the script | Means |
| --- | --- | --- | --- |
| Foreign key | solid, crow's foot | `FOREIGN KEY … REFERENCES …` | A constraint the database enforces |
| Data flow | dashed, filled arrow | a comment | Rows in the target are built from the source by a job, rollup, or trigger |
| Serialized | solid, filled diamond at the container | a comment | The target's rows live encoded inside one column of the source (JSONB, an array, a blob, a composite type) |
| Dependency | dotted, open arrow | a comment | The source reads the target through a view, a job, or application code, with nothing enforcing it |

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

## Project layout

```
src/shared/types.ts      data model + API contracts shared by client and server
src/lib/sql/             tokenizer, parser (DDL -> model), generator (model -> DDL), dialect helpers
src/lib/groups.ts        table groups: region geometry, membership, external tables
src/lib/layout.ts        dagre-based "detangle" (groups become dagre clusters)
src/lib/trace.ts         BFS path finding + join-query builder
src/lib/io.ts            .dbviz.json save/load
src/lib/lint.ts          schema linter with one-click fixes; suggest.ts proposes foreign keys
src/lib/migrate/         diagram vs. database diff and per-dialect ALTER generation
src/lib/seed.ts          deterministic seed-data generator
src/lib/export/          Mermaid and DBML exporters (markdownExport.ts for the data dictionary)
src/lib/share.ts         share links (diagram compressed into the URL hash)
src/lib/library.ts       IndexedDB diagram library and checkpoints
src/lib/sqlite/          in-browser SQLite engine (sql.js) behind the same interface as the server
src/store/useStore.ts    zustand store with undo/redo and autosave
src/components/          React UI (canvas, inspector, drawer panels, command palette)
server/                  Express API: Docker control, pg / MariaDB execution, introspection and read-only queries
tests/                   vitest unit tests for the SQL round-trip, lint, migrate, seed, exports, tracing, layout and file format
```

```bash
npm test          # unit tests
npm run typecheck # client + server
```

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

## Notes on the SQL support

The parser is purpose-built for schema DDL rather than a full SQL grammar. It handles `CREATE TABLE` with column and table constraints in both dialects, `ALTER TABLE … ADD CONSTRAINT / ADD COLUMN / ALTER COLUMN SET DEFAULT|NOT NULL`, `CREATE [UNIQUE] INDEX`, `COMMENT ON`, and `CREATE TYPE … AS ENUM`. Anything else is skipped with a warning, and a broken statement does not stop the rest of the script from importing. Generated columns, partitioning, and expression indexes are dropped with a warning because the model does not represent them.

Views are first-class: `CREATE VIEW … AS SELECT …` (PostgreSQL, MariaDB and SQLite flavours, including `MATERIALIZED`, `ALGORITHM=`/`DEFINER=` prefixes and `WITH CHECK OPTION`) becomes a view node fed by data-flow links from the tables its SELECT reads, and the generated script creates views after every table, in dependency order. SQLite is a third dialect: the generator writes `INTEGER PRIMARY KEY AUTOINCREMENT`, keeps every foreign key inline (SQLite resolves them at run time, so cycles need no `ALTER TABLE`), turns enum types into `CHECK (col IN (…))`, drops schema prefixes and moves comments into the script, and the parser accepts `AUTOINCREMENT`, `[bracketed]` identifiers, `WITHOUT ROWID` and `STRICT`. Column types are translated when you switch to or from SQLite.

**Migrate** introspects the connected database and diffs it against the diagram: new and dropped tables, added / dropped / retyped columns, nullability and default changes, foreign keys and indexes. The `ALTER TABLE` script it writes follows each dialect's rules (`ALTER COLUMN … TYPE` in PostgreSQL, `MODIFY COLUMN` in MariaDB, and a create-copy-drop-rename rebuild for the changes SQLite cannot express), with destructive statements grouped at the end and commented out unless you tick them. It works from the diagram alone, so it cannot see data; review the script before running it.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
