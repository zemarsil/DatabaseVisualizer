# UI reference for walkthrough authors

Labels, shortcuts and defaults, read out of the source rather than remembered.
Quote them exactly. When something you need is not here, open the file named in
the right-hand column and read the label before you write it down — every entry
below carries where it came from so you can re-check it after the app changes.

---

## The window

```
┌──────────────────────────────────────────────────────── TopBar.tsx ─────────┐
│ DB Visualizer · [diagram name] · [dialect ▾] · undo/redo · + Table ▾ · …    │
├───────────┬───────────────────────────────────────────┬─────────────────────┤
│ Sidebar   │                                           │ Inspector           │
│ table     │              Canvas                       │ (selection-driven)  │
│ list      │              (pan / zoom)                 │                     │
├───────────┴───────────────────────────────────────────┴─────────────────────┤
│ Drawer: SQL · Types · Import SQL · Trace · Simulate · Problems · Query · DB  │
└─────────────────────────────────────────────────────────────────────────────┘
```

The **inspector** on the right always shows whatever is selected: a table, a
connection, a note, or a group region. The **bottom drawer** holds the eight
tabs. The **sidebar** on the left is the table list. All three toggle from the
**View** menu or the icon buttons at the far right of the top bar.

---

## Top bar, left to right

Source: `src/components/TopBar.tsx`

| Control | Notes |
| --- | --- |
| Diagram name field | Placeholder *Diagram name*. |
| Dialect selector | *PostgreSQL*, *MariaDB*, *SQLite (in browser)*. Switching translates known column types; undo reverts it. |
| Undo / Redo | `Ctrl+Z`, `Ctrl+Shift+Z` (also `Ctrl+Y`). |
| **+ Table** | Adds a table (`T`). |
| The `▾` beside it | *Table* `T`, *View*, *Note* `N`, *Group region* `G` (reads *Group the N selected tables* when several are selected), then *Enum type* and *Composite type*, which both open the **Types** tab. |
| Group icon button | Same as *Group region* (`G`). |
| Note icon button | Same as *Note* (`N`). |
| **Detangle** | Auto-layout (`L`). Its `▾` holds *Layout direction* → *Left to right* / *Top to bottom*. |
| **Trace** | With two tables selected it traces immediately; otherwise it enters pick mode. |
| **Simulate** | Simulate data flowing into the selected table (`S`). Pressing it again, or `Esc`, leaves the mode. |
| Fit icon button | *Fit to window* (`F`). |
| Command palette button | *Command palette: jump to a table or run any action* (`Ctrl+K`). |
| **Database** | Opens the **Database** drawer tab. |
| **File** menu | *New diagram*, *Open…* `Ctrl+O`, *Open recent…*, *Save as .dbviz.json* `Ctrl+S`, *Save checkpoint…*, *Export PNG*, *Export SVG*, *Export SQL script*, *Export Markdown*, *Export Mermaid ER diagram*, *Export DBML*, *Copy share link*, *Load example diagram*. |
| **View** menu | Checkboxes *Table list*, *Inspector*, *Bottom drawer*, *Dark theme*, *Cardinality labels*, *Snap to grid*, *Warn before closing unsaved*; then under *All tables*: *Show every column*, *Keys only*, *Headers only*. |
| Panel toggles + theme + **?** | Table list, drawer, inspector, theme, help (`?`). |

---

## Bottom drawer tabs

Source: `src/components/drawer/Drawer.tsx` and the panels beside it

| Tab | What it does |
| --- | --- |
| **SQL** | The generated script. Format selector (SQL, Markdown, Mermaid, DBML), *Whole schema* / *Selected table*, a *Prefix DROP TABLE statements* checkbox, statement count, **Copy** and **Download**. Generator warnings appear above the code. |
| **Types** | Enum and composite types. *Values (N)* for an enum, *Fields (N)* for a composite, plus a *Comment*. Badge shows how many types exist. |
| **Import SQL** | Paste or load a `.sql` file; *Add to the current diagram* or replace; optionally drop everything into a new group. |
| **Trace** | *From table…* / *To table…*, the hop list, and *Join along the path*. |
| **Simulate** | *Simulate data flow*: the stage list, the source and target grids, row lineage, and editable raw-input cells. |
| **Problems** | Lint findings with one-click fixes, filterable (*All severities*, *Errors only*, *Warnings only*, *Notes only*), plus *Suggested foreign keys*. Badge shows the error count. |
| **Query** | Read-only `SELECT`s against the connected database. `Ctrl+Enter` runs, `Tab` indents; snippets, history, CSV/JSON copy. |
| **Database** | Left column *Docker* (containers: *Container name*, *Image*, *Host port*, *Engine*), right column *Connection* (*Host*, *Port*, *User*, *Password*), then *Create the schema*, *Import from the database*, **Migrate** and *Seed data*. |

---

## Inspector

Source: `src/components/inspector/*.tsx`

**Table** (`TableEditor.tsx`) — a Table / View switch, *Name*, *Schema*,
*Comment*, *Colour*, *Group*, the column grid with **PK / NN / UQ / AI**
toggles (expand a row for *Default*, *Check*, *Comment*), *Indexes (N)*,
*Table checks (N)*, *Connections (N)* and *Quick actions*.

**View** (`ViewEditor.tsx`) — *View definition (SELECT …)* and *Source tables
(N)* with a **Detect from SQL** button that links the diagram tables named in
the `SELECT`.

**Connection** (`RelationshipEditor.tsx`) — *Kind* (the four **Connection
types**), *Reads as* (the verb, previewed in both directions), the direction
row (*Referencing → referenced* for a foreign key, *Container → embedded* for a
serialized one, *Source → target* otherwise), *Column pairs* (or *Anchor columns
(optional)*), *Constraint name* / *Label*, *Reverse label*, *On delete*,
*On update*, *Tagged query*, *Derived columns (N)* — each with *Expression on
{source}*, *Group by*, *Filter (WHERE)* and *Sequence (window)* — and
*Generated from these derivations*.

**Group** (`GroupEditor.tsx`) — *Name*, the checkbox *These tables live in
another database*, *Note*, *Colour*, counts of tables and crossing connections,
*Tables (N)*, **Remove the region, keep the tables** and **Delete the region and
its N table(s)**.

**Diagram** (`DiagramPanel.tsx`) — shown with nothing selected: *Diagram name*,
*Connection types*, *Groups*, *Custom types*, *Tips* and *Checkpoints (N)*.

---

## Keyboard shortcuts

Sources: `src/App.tsx`, `src/components/canvas/Canvas.tsx`,
`src/components/CommandPalette.tsx`, `src/components/inspector/TableEditor.tsx`,
`src/components/drawer/QueryPanel.tsx`. **This list is exhaustive** — the
walkthrough validator rejects any keystroke that is not on it, and rejects any
spelling other than the one in the left column.

| Key | Does |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / redo / redo |
| `Ctrl+S` / `Ctrl+O` | Save / open a `.dbviz.json` |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy, cut, paste the selection; paste also accepts DDL, DBML and `.dbviz.json` text |
| `T` / `N` / `G` | Add table / note / group region |
| `L` / `F` | Detangle / fit to window |
| `S` | Simulate into the selected table (again, or `Esc`, to stop) |
| `F2` | Rename the selected table in place |
| `.` | Focus on the selected table |
| `[` / `]` | Narrow / widen the focus neighbourhood |
| `Arrow keys` | Nudge the selection 10 px |
| `Shift+Arrow keys` | Nudge 50 px |
| `Enter` | In a column name: add the next column |
| `Shift+Enter` | In a column name: insert one above |
| `Ctrl+Backspace` | On an empty column name: delete the row |
| `Ctrl+Enter` | **Query** tab: run |
| `Tab` | **Query** tab: indent |
| `Shift+click` | Add a table or note to the selection |
| `Shift+drag` | Box-select everything the box touches |
| `Delete` / `Backspace` | Delete the selection |
| `Esc` | Clear focus, selection, trace picking or simulation |
| `?` | Help |

---

## Right-click menus

Sources: `src/components/ui/contextMenuItems.ts`, `src/lib/canvasActions.ts`

- **Canvas**: *Add table here*, *Add view here*, *Add note here*, *Paste here*,
  *Select all tables*, *Group tables by schema*, *Snap to grid*, *Detangle
  layout*, *Fit to window*, *Undo*, *Redo*, and the drawer tabs.
- **Table**: *Rename in place*, *Rename…*, *Duplicate table*, *Color*,
  *Copy table*, *Cut table*, *Copy table name*, *Show in SQL tab*,
  *All columns* / *Keys only* / *Header only*, *Zoom to table*,
  *Trace from here…*, *Simulate*, *Delete table*.
- **Column row**: *Primary key*, *Not null*, *Unique*, *Auto-increment*,
  *Add column below*, *Create index on this column*, *Move up*, *Move down*,
  *Copy column name*, *Delete column*.
- **Connection**: *Swap direction*, the four kinds, *Copy tagged query*,
  *Edit in inspector*, *Delete connection*.
- **Group region**: *Edit group…*, *In another database*,
  *Remove region, keep tables*.
- **Multi-selection**: adds *Align left edges* / *right edges* / *top edges* /
  *bottom edges* / *centres (vertical axis)* / *middles (horizontal axis)*,
  *Distribute horizontally*, *Distribute vertically*, *Color for all*.
- **Note**: *Edit text*, *Duplicate note*, *Copy text*, *Delete note*.

---

## Defaults worth knowing

Sources: `src/lib/model.ts`, `src/store/useStore.ts`

- A **new table** is called `new_table` (then `new_table_2`, …) and arrives with
  one column: `id`, `INTEGER` on PostgreSQL and SQLite or `INT` on MariaDB,
  primary key, not null, auto-increment.
- A **new column** defaults to `VARCHAR(255)`, or `INTEGER` if it is a primary
  key, and is nullable unless it is a primary key.
- A **new view** is called `new_view` and starts with no columns.
- A **new group** is called *New group*, colour `slate`, not external.
- A **new relationship** gets `onDelete` and `onUpdate` of `NO ACTION`.
- Palette colour keys: `blue`, `teal`, `green`, `yellow`, `orange`, `red`,
  `pink`, `purple`, `indigo`, `slate`. A table's colour is derived from its name
  unless you set one.

---

## Connections: kind vs. verb

Source: `src/shared/types.ts`

A connection has two independent halves. The **kind** is what the database does
and drives everything mechanical; the **verb** is only how the edge reads.

| Kind | Drawn | In the script | Joinable in a trace | Needs column pairs |
| --- | --- | --- | --- | --- |
| `fk` — Foreign key | solid, crow's foot | `FOREIGN KEY … REFERENCES …` | yes | yes |
| `flow` — Data flow | dashed, filled arrow | a comment | no | no |
| `embed` — Serialized | solid, filled diamond at the container | a comment | no | no (`sourceColumnIds[0]` holds them) |
| `dependency` — Dependency | dotted, open arrow | a comment | no | no |

Verbs, stored source → target, with the reverse reading you get for free:

| Verb | Reads forward / back | Allowed on |
| --- | --- | --- |
| `references` | references / referenced by | `fk` |
| `belongs-to` | belongs to / has | `fk` |
| `part-of` | is part of / contains | `fk` |
| `extends` | extends / extended by | `fk` |
| `uses` | uses / used by | `fk`, `dependency` |
| `feeds` | feeds / fed by | `flow` |
| `mirrors` | mirrors / mirrored by | `flow` |
| `serializes` | serializes / serialized into | `embed` |
| `embeds` | embeds / embedded in | `embed` |

Defaults when no verb is set: `references`, `feeds`, `serializes`, `uses`.

---

## Derivations

Source: `src/shared/types.ts`, `src/lib/derivation.ts`, `src/lib/simulate/`

One entry per target column on a `flow` edge: an `expression`, an optional
`aggregate` (`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`), `groupBy` keys, a `filter`,
and an optional `window`:

| `window.fn` | *Sequence (window)* label | Meaning |
| --- | --- | --- |
| `DIFF` | Change since the previous row | this row minus the previous one (seconds for timestamps, days for dates) |
| `LAG` | Previous row's value | |
| `LEAD` | Next row's value | |
| `RUNNING_SUM` | Running total | |
| `RUNNING_AVG` | Running average | |
| `ROW_NUMBER` | Row number | ignores the expression |
| `RANK` | Rank | ignores the expression; ties share a rank |

A window needs `orderBy` and may take `partitionBy`. The window runs **first**,
then the grouping and aggregate — so an `AVG` of a `DIFF` is a mean gap.

Expressions, keys and filters may name a column of another table as
`table.column` when the source reaches it through foreign keys in the diagram
(`orders.status` from `order_items` follows `order_items.order_id → orders.id`).
Use the bare table name, never `schema.table`.

---

## What the model cannot hold

Say so plainly rather than working around it:

- generated / computed columns, partitioning, expression indexes, triggers and
  stored functions — the DDL importer drops them with a warning;
- joins that are not foreign keys inside a derivation — those belong in the
  edge's free-text *Tagged query*;
- a named enum type on MariaDB or SQLite (PostgreSQL alone emits `CREATE TYPE`;
  MariaDB inlines `ENUM(...)` per column and SQLite becomes a `CHECK`);
- a group's rectangle — it is derived from where its member tables sit, never
  stored, so a group cannot be dragged away from its contents.
