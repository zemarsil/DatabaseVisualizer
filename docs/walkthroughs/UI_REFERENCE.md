# UI reference for walkthrough authors

Labels, shortcuts and defaults, read out of the source rather than remembered.
Quote them exactly. When something you need is not here, open the file named in
the right-hand column and read the label before you write it down — every entry
below carries where it came from so you can re-check it after the app changes.

---

## The window

```
┌──────────────────────────────────────────────────────── TopBar.tsx ─────────┐
│ DB Visualizer · [workspace name] · [dialect ▾] · undo/redo · + Table ▾ · …  │
├───────────┬───────────────────────────────────────────┬─────────────────────┤
│ Sidebar   │ Sheet tabs: one per diagram · +           │ Inspector           │
│ table     ├───────────────────────────────────────────┤ (selection-driven)  │
│ list      │              Canvas (pan / zoom)          │                     │
├───────────┴───────────────────────────────────────────┴─────────────────────┤
│ Drawer: Walkthrough · SQL · Types · Import SQL · Trace · Simulate · … · DB   │
└─────────────────────────────────────────────────────────────────────────────┘
```

The **inspector** on the right always shows whatever is selected: a table, a
connection, a note, a group region, or a code node (a program, a module, a
class or a function). The **bottom drawer** holds the ten
tabs. The **sidebar** on the left is the table list. All three toggle from the
**View** menu or the icon buttons at the far right of the top bar.

The **sheet tabs** between the top bar and the canvas are the diagrams of this
workspace — one per database, saved together in one file. Everything else on
screen (sidebar, inspector, drawer, the top bar's dialect selector) describes
the diagram of the tab you are on. Walkthroughs work on one tab and never need
a second; say "the canvas" as before.

---

## Sheet tabs (the diagrams of the workspace)

Source: `src/components/SheetTabs.tsx`, `src/lib/sheets.ts`

| Control | Notes |
| --- | --- |
| A tab | The diagram's name and its table count. Click to switch, double-click (or `F2`) to rename in place, drag to reorder, middle-click to close. |
| The `×` on a tab | *Close "name"*; asks first when the diagram has tables. Closing the last tab empties it rather than leaving no canvas. |
| **+** at the end of the strip | *Add another diagram to this workspace*. |
| Right-click a tab | *Rename…*, *Duplicate*, *Move left*, *Move right*, *New diagram in this workspace*, *Close "name"*. |
| `Ctrl+PgUp` / `Ctrl+PgDn` | Previous / next tab, wrapping around. Works while a field has focus. |

Each tab keeps its own dialect, undo history, selection, trace and viewport.
`Ctrl+S` saves every tab into the one `.dbviz.json` file.

---

## The walkthrough coach mark

Source: `src/components/tour/TourHost.tsx`

A walkthrough runs as a card floating over the window, anchored to whatever the
current step points at, with a ring drawn round it. It never takes the pointer:
the reader works in the real app while the card watches.

| Control | Notes |
| --- | --- |
| **Start** | On the opening card, after **What you'll build** and *Why it works this way*. |
| **Set up the canvas** | Also on the opening card: loads the diagram this walkthrough starts from. |
| **Back** / **Continue** | Move between steps. **Continue** turns primary with a tick once the step's goals pass. |
| **Do it for me** | Shown only while a step has something left that the app can do; makes the change as one undo step. |
| The checklist | Under the instruction: one line per goal, live, reading *"n of m done"* until they all pass. |
| **−** / **✕** | Tuck the card into a pill in the bottom-right corner; leave the walkthrough (progress is kept). |
| **Check your work** / **Gotchas** / **What next** | Tabs on the closing card. |

Where a step points is its `target:` — see
[`WALKTHROUGH_FORMAT.md`](WALKTHROUGH_FORMAT.md). Chrome is found by its
`data-tour` attribute, inspector fields and sections by the label the reader
sees, so renaming a visible label moves the coach mark with it.

---

## Top bar, left to right

Source: `src/components/TopBar.tsx`

| Control | Notes |
| --- | --- |
| Workspace name field | Placeholder *Diagram name* while the workspace holds one diagram, *Workspace name* once it holds more. With one diagram the name is the diagram's name too, so renaming either renames both; with several, each diagram is named on its own tab. |
| Dialect selector | *PostgreSQL*, *MariaDB*, *SQLite (in browser)*, *DuckDB (in browser)*. Switching translates known column types; undo reverts it. |
| Undo / Redo | `Ctrl+Z`, `Ctrl+Shift+Z` (also `Ctrl+Y`). |
| **+ Table** | Adds a table (`T`). |
| The `▾` beside it | *Table* `T`, *View*, *Note* `N`, *Group region* `G` (reads *Group the N selected tables* when several are selected); then, under a *Code map* label, *Program*, *Module*, *Class* and *Function* — a module, class or function goes inside the selected code node when that node can hold it and at the top level otherwise, and the inspector opens on the new node; then *Enum type* and *Composite type*, which both open the **Types** tab. |
| Group icon button | Same as *Group region* (`G`). |
| Note icon button | Same as *Note* (`N`). |
| **Detangle** | Auto-layout (`L`). Its `▾` holds *Layout direction* → *Left to right* / *Top to bottom*. |
| **Trace** | With two tables selected it traces immediately; otherwise it enters pick mode. |
| **Simulate** | Simulate data flowing into the selected table (`S`). Pressing it again, or `Esc`, leaves the mode. |
| Fit icon button | *Fit to window* (`F`). |
| Command palette button | *Command palette: jump to a table or run any action* (`Ctrl+K`). |
| **Database** | Opens the **Database** drawer tab. |
| **File** menu | *New diagram in this workspace*, *New workspace*, *Open…* `Ctrl+O`, *Open recent workspace…*, *Save as .dbviz.json* `Ctrl+S` (reads *Save workspace as .dbviz.json* with more than one diagram), *Save checkpoint…*, *Export PNG*, *Export SVG*, *Export SQL script*, *Export Markdown*, *Export Mermaid ER diagram*, *Export DBML*, *Copy share link*, *Load example diagram*. |
| **View** menu | Checkboxes *Table list*, *Inspector*, *Bottom drawer*, *Dark theme*, *Derived-column lens (D)*, *Cardinality labels*, *Snap to grid*, *Warn before closing unsaved*; then under *All tables*: *Show every column*, *Keys only*, *Headers only*. |
| Panel toggles + theme + **?** | Table list, drawer, inspector, theme, help (`?`). |

---

## Bottom drawer tabs

Source: `src/components/drawer/Drawer.tsx` and the panels beside it

| Tab | What it does |
| --- | --- |
| **Walkthrough** | The map beside the walkthrough you are running: every step in one list with a tick against the ones that check out, click any of them to move the coach mark there. Empty until you pick one from the **?** help modal's *Browse the sixteen walkthroughs*. Carries **Run the walkthrough** / **Show the step card**, **Set up the canvas** (loads the diagram that walkthrough starts from), **Read the whole thing** (the full text), **Check my work** (runs the walkthrough's `checks:` against the live canvas and lists what does not match), **Open the finished diagram**, and a *Next:* link. |
| **SQL** | The generated script. Format selector (SQL, Markdown, Mermaid, DBML), *Whole schema* / *Selected table*, a *Prefix DROP TABLE statements* checkbox, statement count, **Copy** and **Download**. Generator warnings appear above the code. |
| **Types** | Two sections in one scrolling panel. **Custom types** on top: its add buttons read **+ Enum** and **+ Struct type** — *Composite type* is only the top-bar `▾` menu's and the command palette's spelling. *Values (N)* for an enum, *Fields (N)* for a composite, plus a *Comment*. Neither values nor fields can be reordered: append and delete only. **Extensions** below it: a name box with catalog autocomplete and an **Add** button, one-click chips for extensions not yet declared, and a card per extension carrying *Version*, *Schema* (PostgreSQL only), *Why this schema needs it*, chips for the types / functions / index methods / operator classes it provides, and the statement it generates. A collapsed *Where definitions come from* block holds **Load a pack file**, **Read from the database**, **Keep as a pack**, a URL box with **Fetch**, and the list of loaded packs. Badge counts custom types and extensions together. |
| **Import SQL** | Paste or load a `.sql` file; *Add to the current diagram* or replace; optionally drop everything into a new group. |
| **Trace** | *From table…* / *To table…*, the hop list, and *Join along the path*. |
| **Simulate** | *Simulate data flow*: the stage list, the source and target grids, row lineage, and editable raw-input cells. |
| **Derived** | *Derived columns*: every column the schema computes rather than stores, grouped by table with its formula, and — for whichever one you pick — *What it is computed from* and *What is computed from it*. Carries **Lens on** / **Lens off** (the same lens as `D`) and **Clear**. Badge reads *lens* while the lens is on, otherwise the count of computed columns. |
| **Problems** | Lint findings with one-click fixes, filterable (*All severities*, *Errors only*, *Warnings only*, *Notes only*), plus *Suggested foreign keys*. Badge shows the error count. |
| **Query** | Read-only `SELECT`s against a connected database — the picker at the top left chooses which one when more than one is connected, the main database being marked *(main)*. `Ctrl+Enter` runs the selection or the statement under the cursor; snippets, history, CSV/JSON copy. The box is the **SQL editor** (below). |
| **Database** | Left column *Docker*: the containers, each running one offering **Main** (design for it) and **External** (connect it alongside), plus *Create a new database container* (*Container name*, *Image*, *Host port*, *Engine*). Right column *Main database* (*Name*, *Engine* — a dialect selector independent of the diagram's — *Host*, *Port*, *Database*, *User*, *Password*) and **Test connection**, then *Other databases* (**Connect another**, and per database **Test**, **Read schema** / **Re-read**, query, make main, disconnect, with *Group what is read* and *Mark as another database*), then *Create the schema*, **Migrate**, *Seed data* and *Import from the main database*. |

---

## Inspector

Source: `src/components/inspector/*.tsx`

**Table** (`TableEditor.tsx`) — a Table / View switch, *Name*, *Schema*,
*Comment*, *Colour*, *Group*, the column grid with **PK / NN / UQ / AI**
toggles (expand a row for *Default*, *Check*, *Comment*), *Indexes (N)*,
*Table checks (N)*, *Connections (N)* and *Quick actions*.

A new table opens with the cursor in *Name*. `Enter` walks the order a table is
actually typed in — *Name*, *Schema*, then the column grid, which gets its first
row if it has none. The colour palette and each row's flag toolbar hold one tab
stop apiece and move internally with the arrow keys, so `Tab` crosses the form
in a handful of stops rather than twenty.

**SQL editor** (`ui/SqlEditor.tsx`) — every box SQL is typed into: a
connection's *Tagged query*, a view's *View definition*, a derivation's
*Expression on {source}*, *Filter (WHERE)* and expression keys, a column's
*Default* and *Check*, *Table checks*, and the **Query** and **Import SQL**
tabs. It colours the diagram's table and column names, completes tables,
columns, keywords and functions (`Ctrl+Space`, or as you type; `table.` and an
alias's `o.` narrow to that table's columns), and reports under the box: an
expression the simulator cannot parse, a column or table it cannot resolve, an
unclosed string or parenthesis. The status row shows *Reads* / *Writes* for a
statement, *Ln, Col*, a **Format** button (`Ctrl+Shift+F`) and, in the
inspector, an expand button that opens the same box in a dialog. Generated SQL
shown read-only (*Generated from these derivations*, the table's DDL preview,
the **SQL** tab, **Trace**, **Migrate** and **Seed** previews) is coloured the
same way.

**View** (`ViewEditor.tsx`) — *View definition (SELECT …)* (`Ctrl+Enter` there
is **Detect from SQL**), the checkbox
*Materialized (store the rows, refresh on demand)* (PostgreSQL emits
`CREATE MATERIALIZED VIEW`; MariaDB, SQLite and DuckDB fall back to a plain view with a
generator warning, and the flag is kept for switching back), and *Source tables
(N)* with a **Detect from SQL** button that links the diagram tables named in
the `SELECT`. A materialized view's canvas badge reads **MAT VIEW** rather than
**VIEW**.

**Connection** (`RelationshipEditor.tsx`) — *Kind* (the four **Connection
types**), *Reads as* (the verb, previewed in both directions), the direction
row (*Referencing → referenced* for a foreign key, *Container → embedded* for a
serialized one, *Source → target* otherwise), *Column pairs* (or *Anchor columns
(optional)*), *Constraint name* / *Label*, *Reverse label*, *On delete*,
*On update*, *Tagged query* (with a **Run** button, a *Start from a query written
for this connection…* menu whose entries come from the connection itself — the
`JOIN`, orphan check and count for a foreign key; `INSERT … SELECT`, an upsert
in the dialect's spelling, a rebuild and the statement built from the
derivations for a data flow; JSON unpacking for a serialized one — and an
expand button), a free-text *Note* beside it, *Derived columns (N)* — each with *Expression on
{source}*, *Group by*, *Filter (WHERE)* and *Sequence (window)* — and
*Generated from these derivations*. On a data flow two shortcuts sit beside
them: **Match by name**, which adds a plain passthrough derivation for every
target column a source column of the same name can fill (also on the edge's
right-click menu as *Match columns by name*), and *Feed other tables the same
way*, which ticks off other tables and draws the same flow into each, its
derivations re-pointed at the columns those tables spell the same way.

**Group** (`GroupEditor.tsx`) — *Name*, the checkbox *These tables live in
another database*, *Note*, *Colour*, counts of tables and crossing connections,
*Tables (N)*, **Remove the region, keep the tables** and **Delete the region and
its N table(s)**.

**Code node** (`ProgramEditor.tsx`) — one panel for a program, a module, a
class and a function. *Name*, *Kind*, *Inside* (the container it sits in, or
nothing; only containers that can hold this kind are offered), *Language*,
*Runs as* (programs only: *Service*, *Job*, *Script*, *ETL*), a box whose label
follows the kind — *Where the code lives* for a program, *Path* for a module,
*Signature or location* for a class or function — *What it is for* and
*Color*. A container gets *Inside (N)*, listing its members with a
**Collapse** / **Expand** button and **+ Module**, **+ Class** and
**+ Function** buttons offering only the kinds it can hold; a node something
names gets *Reached from*. Then *Steps, in order* with **+ Read**, **+ Write**,
**+ Compute**, **+ Call**, **+ Import** and **+ Extends**: a read or write step
has a table box, *Columns it touches*, *The statement it runs*, *Note* and
*Code*; a call, import or extends step has a code-node box listing every node
by path, *Note* and *Code*; a compute step *Note* and *Code*. Under the steps:
**Show the {Language} starter** (**Hide** once open), **Duplicate**,
**Dissolve** for a container with members (removes it and moves what was
inside up a level) and **Delete {kind}**.

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
| `F2` | Rename the selected table or code node in place |
| `.` | Focus on the selected table or code node |
| `[` / `]` | Narrow / widen the focus neighbourhood |
| `Arrow keys` | Nudge the selection 10 px; in a column name, move to the same box one row up or down |
| `Shift+Arrow keys` | Nudge 50 px |
| `Enter` | In the table *Name*: move to *Schema*. In *Schema* or *Comment*: jump to the column grid. Anywhere in a column row: add the next column |
| `Shift+Enter` | In a column row: insert one above |
| `Alt+P` / `Alt+N` / `Alt+U` / `Alt+I` | In a column row: toggle **PK** / **NN** / **UQ** / **AI** without leaving the box |
| `Ctrl+Backspace` | On an empty column name: delete the row |
| `Tab` | In the canvas rename box: commit the name and carry on into the inspector's *Schema* |
| `Ctrl+Enter` | In a SQL box: run (**Query** tab — the selection, or the statement under the cursor; *Tagged query* — in the Query tab), import (**Import SQL**) or link the source tables (*View definition*) |
| `Ctrl+Space` | In a SQL box: open the completion list (`↑` `↓` choose, `Enter` / `Tab` insert, `Esc` close) |
| `Ctrl+Shift+F` | In a multi-line SQL box: format |
| `Ctrl+/` | In a multi-line SQL box: comment the selected lines out, or back in |
| `Tab` / `Shift+Tab` | In a multi-line SQL box: indent / outdent the selected lines; `Enter` keeps the indentation |
| `←` `→` `Home` `End` | Inside the colour palette or a column's flag toolbar, which share one tab stop each |
| `Shift+click` | Add a table or note to the selection |
| `Shift+drag` | Box-select everything the box touches |
| `Delete` / `Backspace` | Delete the selection. On an expanded code container it removes the container and keeps what was inside, the way it does for a group region |
| `D` | Derived-column lens on / off |
| `Esc` | Clear focus, the derived lens, selection, trace picking or simulation. With a column's lineage on screen the first `Esc` widens it back to the whole diagram and the second puts the lens away |
| `?` | Help |

---

## Right-click menus

Sources: `src/components/ui/contextMenuItems.ts`, which wires in the operations from
`src/lib/canvasOps.ts` (`src/lib/canvasActions.ts` holds only copy/paste/cut and file drops)

- **Canvas**: *Add table here*, *Add view here*, *Add note here*, *Add program
  here*, *Add module here*, *Add class here*, *Add function here*, *Paste here*,
  *Select all tables*, *Group tables by schema*, *Snap to grid* (a toggle — tables
  land on the grid as you drag them; there is no one-shot "snap everything now"), *Detangle
  layout*, *Fit to window*, *Undo*, *Redo*, and the drawer tabs.
- **Table**: *Rename in place*, *Rename…*, *Duplicate table*, *Color*,
  *Copy table*, *Cut table*, a **Copy as** group (*CREATE TABLE* / *CREATE VIEW*,
  *Markdown*, *Markdown + SQL*, *Diagram JSON*, *Table name*), *Show in SQL tab*,
  *All columns* / *Keys only* / *Header only*, *Zoom to table*,
  *Trace from here…*, *Simulate*, *Show the N derived columns* (a table with
  none gets *Derived-column lens*, or *Turn the derived lens off* while it is
  on), *Delete table*.
- **Column row**: *Primary key*, *Not null*, *Unique*, *Auto-increment*,
  *Add column below*, *Create index on this column*, *Move up*, *Move down*,
  *Copy column name*, then *Show where this comes from* on a computed column
  (*Show what this feeds (N)* on a stored one that some derivation reads, and
  nothing at all on a column neither applies to), *Delete column*.
- **Connection**: *Swap direction*, the four kinds, *Copy tagged query*,
  *Edit in inspector*, *Delete connection*.
- **Group region**: *Edit group…*, *In another database*, *Select its N table(s)*,
  *Copy its N table(s)* and the same **Copy as** group as a table,
  *Remove region, keep tables*, *Delete region and its N table(s)*.
- **Code node** (a program, module, class or function): *Edit steps*, *Rename
  in place* `F2`, *Add a step*, *Add a module inside* / *Add a class inside* /
  *Add a function inside* (only the kinds it can hold), *Color*, *Collapse to
  one node* or *Expand: show the N nodes inside*, *Select the N nodes inside*,
  *Move out of {container}* when it sits inside one, *Focus neighborhood* /
  *Clear focus*, *Trace from here…*, *Copy the {Language} starter*, *Copy
  {kind}* `Ctrl+C`, *Duplicate {kind}*, *Dissolve: keep the N nodes, drop the
  {kind}* on a container with members, and *Delete {kind}* (*Delete {kind} and
  the N nodes inside* on such a container).
- **Multi-selection**: adds *Align left edges* / *right edges* / *top edges* /
  *bottom edges* / *centres (vertical axis)* / *middles (horizontal axis)*,
  *Distribute horizontally*, *Distribute vertically*, *Color for all*, a **Copy as**
  group whose SQL row is the whole selection's script, and — at exactly
  two tables — *Trace {first} → {second}*, which traces immediately. With code
  containers in the selection it adds *Collapse the N containers* or *Expand the
  N containers*.
- **Note**: *Edit text*, *Duplicate note*, *Copy text*, *Delete note*.

---

## Defaults worth knowing

Sources: `src/lib/model.ts`, `src/store/useStore.ts`

- A **new table** is called `new_table` (then `new_table_2`, …) and arrives with
  one column: `id`, `INTEGER` on PostgreSQL, SQLite and DuckDB or `INT` on MariaDB,
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

### Reading them back: computed vs. stored

Source: `src/lib/lineage.ts`

A column is **computed** when an entry fills it, when a group-by key spelled like
a column of the target is carried into it (so a rollup keyed on `product_id`
fills the target's own `product_id` with no entry of its own), or when it belongs
to a view. Everything else is **stored**. A computed column carries a `Σ` mark on
the canvas and a green name box in the inspector's column grid, its table a
`Σ n` badge, and the Markdown data dictionary a `DERIVED` key plus a *Derived
columns* table. The derived lens (`D`) colours the whole canvas by that
distinction; pointing it at one column narrows it to that column's chain.

---

## Behaviour that surprises people

Found the hard way while writing these walkthroughs, each confirmed in the
source. Worth a `## Gotchas` entry wherever it is relevant:

- **A foreign key can be drawn backwards in silence.** Dragging a column handle
  from the parent onto the child creates a foreign key pointing the wrong way
  rather than refusing. The inspector's *Referencing → referenced* row and the
  crow's foot are what tell you which way round you are.
- **A view has no column handles** (`TableNode.tsx` suppresses them), so a
  connection touching a view can only start as a `flow` from the header handle.
  Nothing stops you switching its **Kind** to *Foreign key* afterwards, at which
  point the generator drops it with a warning — views cannot take part in
  foreign keys.
- **`CREATE MATERIALIZED VIEW` survives a round trip; `WITH CHECK OPTION` does
  not.** `materialized` is a real field on the table, carried through the
  parser, the `.dbviz.json`, share links and PostgreSQL introspection
  (`relkind` `'m'`). `WITH CHECK OPTION` and `ALGORITHM=`/`DEFINER=` parse
  without a warning and are then forgotten, so a round trip drops them.
- **DBML is export-only.** There is no DBML importer anywhere in the codebase,
  so a `.dbml` file cannot be dropped or pasted. Drop accepts `.sql`, `.txt`,
  `.dbviz.json`, SQLite database files (`.sqlite`, `.sqlite3`, `.db`) and DuckDB
  database files (`.duckdb`).
- **Simulate only draws the current stage's source and target.** A table reached
  only through a `table.column` foreign-key lookup feeds the computation but
  never gets its own grid, so its values cannot be what-if-edited.
- **Renaming a custom type cascades; renaming a column does not.**
  `updateCustomType` rewrites every column and composite field that names the
  type; a column rename leaves checks, defaults and tagged queries mentioning the
  old name untouched, because those are plain text.

## What the model cannot hold

Say so plainly rather than working around it:

- generated / computed columns, partitioning, expression indexes, triggers and
  stored functions — the DDL importer drops them with a warning;
- joins that are not foreign keys inside a derivation — those belong in the
  edge's free-text *Tagged query*;
- a named enum type on MariaDB or SQLite (PostgreSQL and DuckDB emit `CREATE TYPE`;
  MariaDB inlines `ENUM(...)` per column and SQLite becomes a `CHECK`);
- a group's rectangle — it is derived from where its member tables sit, never
  stored, so a group cannot be dragged away from its contents; a code
  container's region is the same: the box around its members, never a size of
  its own;
- an arrow between code nodes that is not a step — every call, import and
  extends is a step on the node it leaves, and the arrow is drawn from it;
- a function inside a function — a function is a leaf, so closures and nested
  helpers are one node, with the inner one's work in the *Code* box;
- an index's method or operator class — an index is a list of columns and a
  unique flag, so `USING gin (title gin_trgm_ops)` and pgvector's `hnsw` cannot
  be drawn even when the extension that provides them is declared.
