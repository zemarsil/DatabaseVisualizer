# Database Visualizer

A locally hosted web app for designing relational schemas visually.

- Draw tables and their connections on a pan/zoom canvas: crow's-foot foreign keys plus three kinds the database cannot enforce — data flows, serialized copies, and plain dependencies.
- Say how a connection *reads*: "orders **contains** order_items", "customers **has** addresses", "orders **uses** addresses". The verb is documentation, so it never changes the DDL.
- Tag any connection with the query that moves data across it, so the diagram documents *how* one table feeds another, not just that they are related.
- Generate the `CREATE TABLE` script for **PostgreSQL** or **MariaDB** from the diagram, or paste DDL (including `pg_dump` / `mysqldump` output) and get the diagram back.
- **Detangle**: a layered auto-layout that ranks referenced tables before the tables that reference them and minimises edge crossings.
- **Trace**: pick two tables and get the shortest chain of connections between them, highlighted on the canvas, plus the `JOIN` query for that path.
- Export as PNG/SVG, or save a `.dbviz.json` file that loads back with everything intact. The browser also autosaves your work.
- **Docker & database**: start a PostgreSQL or MariaDB container from the UI, create the schema in it (or in any database you can reach), and pull an existing database's schema into the diagram.

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
| Add a table | Double-click the canvas, press `T`, or use the **+ Table** button |
| Select a group | `Shift` + drag a box over the canvas — every table and note it touches is selected; drag any of them (or the dashed box) to move the group, `Delete` removes it in one undo step |
| Edit columns | Select a table; the inspector on the right has the column grid (PK / NN / UQ / AI toggles, expand a row for default, check, comment) plus indexes and table checks |
| Foreign key | Hover a table and drag the handle beside a column onto a column of another table |
| Any other connection | Drag the orange handle in a table header onto another table, then pick the kind in the inspector (data flow, serialized, dependency) |
| Change how a connection reads | Select it; **Reads as** offers the verbs that fit its kind and previews the sentence in both directions |
| Derived columns | On a data-flow edge, add one entry per target column: target column, aggregate, source expression, group-by keys, filter. The edge shows a `Σ` count and a per-column summary, and the script gets an `INSERT ... SELECT ... GROUP BY` skeleton built from it |
| Tag a query on any edge | Click the edge, fill in **Tagged query**; a badge appears on the edge and the query is added as a comment block in the generated script. Free text and derived columns coexist — use the query for joins and conditions the structured form cannot express |
| See / copy DDL | Bottom drawer → **SQL** (whole schema or the selected table). The table inspector also has a preview |
| Import DDL | Bottom drawer → **Import SQL**, paste or load a `.sql` file, choose add/replace |
| Switch dialect | Top bar selector; known column types are translated (`SERIAL` ↔ `INT AUTO_INCREMENT`, `TIMESTAMPTZ` ↔ `TIMESTAMP`, `JSONB` ↔ `JSON`, …). Undo reverts |
| Detangle | **Detangle** button (`L`), direction menu next to it |
| Trace | **Trace** button: with two tables selected it traces immediately, otherwise it enters pick mode; or use the **Trace** drawer tab |
| Save / open | File menu, `Ctrl+S` / `Ctrl+O` (`.dbviz.json`) |
| Export | File menu → PNG, SVG, or the `.sql` script |
| Docker & database | **Database** button → left column manages containers, right column tests a connection, runs the schema, or reads an existing schema |

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
src/lib/layout.ts        dagre-based "detangle"
src/lib/trace.ts         BFS path finding + join-query builder
src/lib/io.ts            .dbviz.json save/load
src/store/useStore.ts    zustand store with undo/redo and autosave
src/components/          React UI (canvas, inspector, drawer panels)
server/                  Express API: Docker control, pg / MariaDB execution and introspection
tests/                   vitest unit tests for the SQL round-trip, tracing, layout and file format
```

```bash
npm test          # unit tests
npm run typecheck # client + server
```

## Notes on the SQL support

The parser is purpose-built for schema DDL rather than a full SQL grammar. It handles `CREATE TABLE` with column and table constraints in both dialects, `ALTER TABLE … ADD CONSTRAINT / ADD COLUMN / ALTER COLUMN SET DEFAULT|NOT NULL`, `CREATE [UNIQUE] INDEX`, `COMMENT ON`, and `CREATE TYPE … AS ENUM`. Anything else is skipped with a warning, and a broken statement does not stop the rest of the script from importing. Generated columns, partitioning, and expression indexes are dropped with a warning because the model does not represent them.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
