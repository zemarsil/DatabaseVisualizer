# Database Visualizer

A locally hosted web app for designing relational schemas visually.

- Draw tables and their connections on a pan/zoom canvas (crow's-foot foreign keys, dashed data-flow links).
- Tag any connection with the query that moves data across it, so the diagram documents *how* one table feeds another, not just that they are related.
- **Group** tables into a labelled region — handy when part of the diagram is a *different* database you only read from. Mark that group external and the generated script documents those tables instead of creating them.
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
| Group tables | Select them and press `G` (or the group button in the top bar). Drag a table into or out of a region to change what is in it; drag a region by its title bar to move everything inside it |
| Mark a group as another database | Select the region, tick **These tables live in another database** in the inspector |
| Data-flow link | Drag the orange handle in a table header onto another table, then paste the query into **Tagged query** |
| Tag a query on any edge | Click the edge, fill in **Tagged query**; a badge appears on the edge and the query is added as a comment block in the generated script |
| See / copy DDL | Bottom drawer → **SQL** (whole schema or the selected table). The table inspector also has a preview |
| Import DDL | Bottom drawer → **Import SQL**, paste or load a `.sql` file, choose add/replace; optionally drop it all into a group |
| Switch dialect | Top bar selector; known column types are translated (`SERIAL` ↔ `INT AUTO_INCREMENT`, `TIMESTAMPTZ` ↔ `TIMESTAMP`, `JSONB` ↔ `JSON`, …). Undo reverts |
| Detangle | **Detangle** button (`L`), direction menu next to it |
| Trace | **Trace** button: with two tables selected it traces immediately, otherwise it enters pick mode; or use the **Trace** drawer tab |
| Save / open | File menu, `Ctrl+S` / `Ctrl+O` (`.dbviz.json`) |
| Export | File menu → PNG, SVG, or the `.sql` script |
| Docker & database | **Database** button → left column manages containers, right column tests a connection, runs the schema, or reads an existing schema |

Press `?` in the app for the full shortcut list.

## Project layout

```
src/shared/types.ts      data model + API contracts shared by client and server
src/lib/sql/             tokenizer, parser (DDL -> model), generator (model -> DDL), dialect helpers
src/lib/groups.ts        table groups: region geometry, membership, external tables
src/lib/layout.ts        dagre-based "detangle" (groups become dagre clusters)
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
