# How a walkthrough is built

Every file in this directory teaches one thing you can do in Database Visualizer,
in the same shape, checked by the same tooling. This document is the procedure:
read it before writing one, and the result will pass the validator on the first
or second try.

A walkthrough is **two artefacts**:

1. **`NN-slug.md`** — the prose, with front matter that machines read.
2. **`diagrams/NN-slug.dbviz.json`** — the finished diagram, which the reader can
   open with **File → Open** (`Ctrl+O`) to land exactly where the walkthrough
   ends up. It is not decoration: the front matter's `checks:` assert what the
   app really generates from it, so the walkthrough cannot quietly rot when the
   app changes.

The markdown is not only read. In the app a walkthrough **runs**: a card follows
the reader around the window, anchored to whatever the current step points at,
ticking each step off as the work gets done and offering to do any step for
them. That clickthrough is built from this file — `## Steps` becomes the cards,
`## What you'll build` and `## The mental model` the one before them,
`## Check your work`, `## Gotchas` and `## Where to go next` the one after — so
there is nothing to keep in sync. What it needs from you is one HTML comment per
step, described in [Steps](#steps) below.

Both are checked in CI:

```bash
node scripts/validate-walkthrough.mjs docs/walkthroughs/NN-slug.md   # format + diagram structure
npx vitest run tests/walkthroughs.test.ts -t NN-slug                 # the checks: entries
npx vitest run tests/tour.test.ts -t NN-slug                         # the step blocks
```

---

## The series is one build

The fifteen walkthroughs are not fifteen exercises. They build **one database,
once**: walkthrough N starts from exactly what N-1 left on the canvas, and the
schema grows the whole way down. That shapes everything below, so it comes
first.

The mechanism is one front-matter key. A walkthrough's `start:` is the previous
walkthrough's `diagram:` — *the same file*, not a copy, so the two can never
drift apart — and the first walkthrough in the series has `start: empty`.
`validateSeries()` in `scripts/walkthrough-lib.mjs` enforces three things:

- `start` is the previous walkthrough's `diagram` (or `empty` for the first);
- `prerequisites` is exactly the previous slug and `next` exactly the following
  one — the chain says the same thing in prose;
- the cast only grows: a table that exists at the end of N is still there at the
  end of N+1, because the reader still has it.

Two consequences worth internalising before you write a step:

**Never rebuild what the reader already has.** "Press `T` three times and type
these columns" is only ever right for tables the series does not have yet. A
step that recreates `customers` because this walkthrough needs one is a bug in
the series, not a convenience.

**A walkthrough that changes nothing sets `diagram:` to its own `start:`.**
Simulate and Export read the canvas without editing it; both point at the
previous stage's file rather than shipping a copy of it. The validator allows
exactly this and nothing else borrowed.

In the app, this is the reader's side of the same idea: **Set up the canvas**
loads `start`, and **Check my work** runs `checks` against the live canvas
(`src/lib/walkthroughChecks.ts`, the same module CI uses). Between them, a reader
can begin at any walkthrough in the series without having typed the ones before
it — which is the whole reason the chain can be strict. Both buttons are on the
card the clickthrough opens with, and in the **Walkthrough** drawer tab.

---

## The procedure

### 1. Pick the scope, then write the ending first

A walkthrough covers **one task a person would actually set out to do** ("connect
two tables", "fill one table from another"), not one feature of the UI. Decide
what the reader has on their canvas when they finish, and build *that diagram
first*, in the app or by hand. Everything else is written backwards from it.

Because the series is one continuous build, "the ending" means *the previous
stage plus your delta*. Start from `diagrams/` for the walkthrough before yours,
add what this one teaches, and save that as your own stage. Keep the delta
small: one to four new tables is almost always enough, and a walkthrough that
changes nothing but the reader's understanding (Simulate) is legitimate.

### 2. Build the companion diagram

Write `diagrams/NN-slug.dbviz.json` by hand following
[`../ADVISOR_OUTPUT_FORMAT.md`](../ADVISOR_OUTPUT_FORMAT.md), which documents
every field of the file. The rules that matter most:

- Ids are readable and unique across the whole file: `tbl_orders`,
  `col_orders_customer_id`, `rel_orders_customer`, `drv_total`.
- Lay the tables out on a grid — `x = 340 * column`, `y = 300 * row` — parents
  above children, derived tables at the bottom. Never leave everything at `0,0`.
  A table keeps the position it was given when it arrived, in every later
  stage: the reader's canvas does not rearrange itself between walkthroughs.
- Cluster a region's members: a group's rectangle is the bounding box of its
  tables, so members scattered across the grid draw a box over everything
  between them.
- Match `dialect` to the front matter, and spell the types that dialect's way.
- Put the *why* in `comment` fields and sticky `notes`. They survive into the
  generated script and into the Markdown export, so the diagram teaches on its
  own once it is open.

Then check it:

```bash
node scripts/validate-dbviz.mjs docs/walkthroughs/diagrams/NN-slug.dbviz.json
```

It must print `OK` with no warnings. The reader's first move is often **Problems**,
so the example should also lint clean unless a lint finding is the point of the
walkthrough — say so in the prose when it is not clean.

### 3. Verify every UI claim against the source

The single fastest way to write documentation that lies is to describe a button
from memory. [`UI_REFERENCE.md`](UI_REFERENCE.md) lists what has been checked;
for anything not in it, open the component and read the label:

| What you are describing | Where it lives |
| --- | --- |
| Top-bar buttons and the File / View menus | `src/components/TopBar.tsx` |
| Keyboard shortcuts | `src/App.tsx`, `src/components/canvas/Canvas.tsx` |
| The in-app help text | `src/components/ui/Modal.tsx` (`HelpContent`) |
| Bottom-drawer tabs | `src/components/drawer/Drawer.tsx` |
| Inspector panels | `src/components/inspector/*.tsx` |
| Right-click menus | `src/components/ui/contextMenuItems.ts`, `src/lib/canvasOps.ts` |
| Command palette entries | `src/components/CommandPalette.tsx` |
| What the model can and cannot hold | `src/shared/types.ts` |

Quote labels **exactly**, in the app's spelling (it is British in places:
*Colour*, *serialised*, *Detangle*). Bold them: **Detangle**, **Import SQL**,
*These tables live in another database*. Shortcuts go in backticks and must use
the canonical spelling — the validator rejects any other, and rejects shortcuts
the app does not bind at all.

### 4. Write the markdown

Copy [`_TEMPLATE.md`](_TEMPLATE.md) and fill it in. The skeleton is fixed
(see below); the voice is yours.

### 5. Run the tooling until it is quiet

```bash
node scripts/validate-walkthrough.mjs docs/walkthroughs/NN-slug.md
npx vitest run tests/walkthroughs.test.ts -t NN-slug
npx vitest run tests/tour.test.ts -t NN-slug
node scripts/build-walkthrough-index.mjs
```

---

## The running example

The series shares one small domain so a reader moving between walkthroughs is
never learning a new cast of tables at the same time as a new feature. Use the
subset you need; do not invent a different world unless the topic demands it.

**A bookshop**, built one walkthrough at a time. The "from" column is the
walkthrough that puts each table on the canvas; every later stage still has it.

| Table | From | Used for |
| --- | --- | --- |
| `authors` | 00 | the parent side of the first foreign key |
| `books` | 00 | the child side; a natural unique key in `isbn`; the embed container |
| `customers` | 01 | the one table typed from nothing, end to end |
| `orders` | 02 | the foreign key taught properly; `status` becomes the enum in 04 |
| `contributors` | 02 | the target of the serialized (embed) connection |
| `customer_cadence` | 02 | a flow drawn empty in 02 and given derivations in 05 |
| `catalog_export` | 02 | the dependency: read by a job, enforced by nothing |
| `crm_contacts`, `crm_accounts` | 03 | the external group; never created by the script |
| `order_items` | 05 | the grain that rollups aggregate |
| `daily_sales` | 05 | a derived table fed by a data flow |
| `book_totals` | 06 | the second stage of a two-stage flow |
| `v_customer_orders` | 08 | the view, with its sources detected from SQL |
| `warehouses`, `stock_levels`, `shipments`, `shipment_items` | 09 | imported from someone else's script, mistakes included; cleaned up in 10 |
| `reviews` | 11 | a second path between `books` and `customers`, for tracing |

Conventions that keep the examples consistent with each other and with
`docs/examples/orders-rollup.dbviz.json`:

- money in integer cents (`price_cents`, `total_cents`), never floats;
- `BIGSERIAL` surrogate keys on PostgreSQL, `id` as the primary key, and
  `<table_singular>_id` for the foreign key that points at it;
- timestamps as `TIMESTAMPTZ` with `DEFAULT now()`, dates as `DATE`;
- `order_status` as the enum: `pending`, `paid`, `shipped`, `cancelled`;
- source tables `blue`, derived tables `orange`, views `teal`, external
  tables and their group `purple`, sticky notes `yellow`.

---

## Front matter

Between two `---` fences at the very top. The syntax is a deliberately tiny
subset of YAML: `key: value` on one line, or `key:` followed by `  - item` lines
(exactly two spaces, then `- `). No quoting, no nesting, no comments.

```yaml
---
title: Connect two tables
slug: 02-connect-two-tables
summary: Two tables, a foreign key between them, and the three other kinds of connection that a foreign key cannot express.
level: beginner
minutes: 12
dialect: postgresql
covers:
  - Foreign key handles
  - Connection kinds
  - Reads as
shortcuts:
  - T
  - Ctrl+K
start: diagrams/01-set-up-a-table.dbviz.json
diagram: diagrams/02-connect-two-tables.dbviz.json
checks:
  - tables | authors, books
  - kinds | fk:1
  - contains | REFERENCES public.authors (id)
  - lint clean
prerequisites:
  - 01-set-up-a-table
next:
  - 03-group-tables
---
```

| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Sentence case, ≤ 60 chars, no full stop. Must match the `# ` heading exactly. |
| `slug` | yes | The filename without `.md`. |
| `summary` | yes | **One** sentence, ≤ 180 chars, ending in a full stop, saying what the reader ends up with. It becomes the row in the index. |
| `level` | yes | `beginner`, `intermediate` or `advanced`. |
| `minutes` | yes | Honest whole number, 3–60, for someone typing along. |
| `dialect` | yes | `postgresql`, `mariadb` or `sqlite`; must match the companion diagram. |
| `covers` | yes | ≥ 3 short noun phrases naming the features touched. |
| `shortcuts` | no | Keystrokes the walkthrough teaches. Every entry must be one the app binds. |
| `start` | yes | The canvas this walkthrough begins from: `empty`, or the previous walkthrough's `diagram` path. Powers **Set up the canvas**. |
| `diagram` | no | `diagrams/NN-slug.dbviz.json`, or the same path as `start` when the walkthrough changes nothing. Omit only if the topic genuinely has no end state (rare). |
| `checks` | with `diagram` | ≥ 2 assertions about that diagram — see below. Also what **Check my work** runs against the reader's canvas. |
| `prerequisites` | yes | Exactly the previous walkthrough's slug, or `none` for the first. |
| `next` | yes | Exactly the following walkthrough's slug, or `none` for the last. |

### `checks:`

Each entry is `verb` or `verb | argument`. They are run against the companion
diagram by `tests/walkthroughs.test.ts`, using the same code the app uses.

| Check | Asserts |
| --- | --- |
| `contains \| <text>` | the generated `CREATE TABLE` script contains that text |
| `omits \| <text>` | it does **not** — how you prove an external group is never created |
| `tables \| a, b, c` | the diagram's table names, **in file order**, exactly |
| `views \| v_x` | the view nodes, in order, exactly |
| `groups \| Name` | the group names, in order, exactly |
| `types \| order_status` | the custom type names, in order, exactly |
| `kinds \| fk:3, flow:1` | relationship counts per kind; a kind you leave out must be absent |
| `indexes \| 2` | total indexes across every table |
| `derivations \| 4` | total derivations across every flow |
| `lint clean` | the **Problems** tab reports no errors |
| `lint errors \| 2` | it reports *exactly* that many errors — for a walkthrough that deliberately ends broken, like the import that the next one cleans up |
| `simulate \| daily_sales` | **Simulate** into that table runs, produces rows, and warns about nothing |
| `trace \| authors -> reviews` | **Trace** finds a path between those two tables |

Pick checks that would **break if the walkthrough's claims stopped being true**.
A walkthrough about external groups wants `omits | CREATE TABLE public.crm_contacts`.
One about derivations wants `simulate | …` and `derivations | N`. Do not pad the
list with checks that only restate that the file parsed.

Remember that these run twice: against the companion diagram in CI, and against
the reader's own canvas when they press **Check my work**. So write them as
things a *reader* would want to be told — "connections: fk:8, flow:2" is a
useful failure, "tables | (seventeen names)" is not. On a big stage, prefer a
few targeted checks over one exhaustive list.

The two runs differ in one deliberate way: CI compares `tables`, `views`,
`groups` and `types` **in order**, the button compares them as sets, because a
reader who added the same tables in a different order has still done the
walkthrough.

Values are split on commas, so no check argument may contain one.

---

## The body

Exactly one `# ` heading (the title), then these `## ` sections, in this order,
all of them present:

| Section | What goes in it |
| --- | --- |
| `## What you'll build` | Two or three sentences, then a ```mermaid sketch of the end state. Required — the reader should be able to decide from this alone whether they are in the right place. |
| `## Before you start` | Prerequisites, which dialect and why, and the one-line "open `diagrams/NN-slug.dbviz.json` if you would rather read the finished thing". |
| `## The mental model` | The *why*, anchored to something the reader already knows: the SQL it becomes, a data structure, a filesystem, a spreadsheet. One or two paragraphs. Not steps. |
| `## Steps` | `### 1.`, `### 2.`, … at least three, numbered in sequence, each an imperative title, each ending in a **You should see:** line. |
| `## Other ways to do it` | Every other route to the same result: keyboard, right-click, command palette, import, drag-and-drop, hand-written JSON. The app is deliberately redundant and readers arrive by different doors. |
| `## Check your work` | How the reader knows it worked, with a ```sql block of what the app actually generates (copy it from the **SQL** tab, do not write it from memory). |
| `## Try it yourself` *(optional)* | Two to four open-ended experiments: change one thing, predict, look. |
| `## Gotchas` | The things that bite, as a bullet list. Be specific: what goes wrong, why, and what to do instead. |
| `## Where to go next` | Links to the following walkthroughs, one line each on why you would read them. |

Optional extra sections, if you need them, are `## Try it yourself` and
`## Reference`, and they sit between `## Steps` and `## Where to go next`.

### Steps

```markdown
### 3. Give the book an author

<!-- step
target: column:books.author_id
goals:
  - fk | books.author_id -> authors.id
hint: The handle only appears while the pointer is over the table.
-->

Hover the `books` table and drag the small handle beside `author_id` onto the
`id` row of `authors`.

**You should see:** a solid line with a crow's foot at the `books` end, and the
inspector switch to the connection with **Kind** set to *Foreign key*.
```

- One action per step. If a step has an "and then also", it is two steps.
- Name the exact affordance, and give the shortcut in backticks the first time.
- **You should see:** is not optional and is not a summary — it is the
  observable change, so a reader who typed something wrong finds out immediately.
  When it introduces a fenced block — the query Trace prints, the lineage
  Simulate explains — the block comes with it onto the card.
- Every step carries exactly one `<!-- step … -->` block, and it must sit inside
  `## Steps`. It is invisible wherever the markdown is read as a document.

#### The step block

Same tiny YAML as the front matter: `key: value`, or `key:` followed by
`  - item` lines.

| Key | Required | Meaning |
| --- | --- | --- |
| `target` | yes | What the card points at, and what has to be open for it to exist. |
| `goals` | no | What the step is *for*: what makes it done, and what **Do it for me** does. |
| `hint` | no | One line of aside, shown in smaller type under the instruction. |
| `transient` | no | `true` when a later step undoes this one — an index built in the wrong order on purpose. Exempt from the tests that replay a walkthrough. |

#### `target:`

One token: a kind, a colon, and what to look for.

| Target | Points at |
| --- | --- |
| `ui:add-table` | app chrome, by the `data-tour` attribute the component carries. The validator lists the ones that exist. |
| `tab:sql` | a drawer tab, opening the drawer on it first |
| `panel:simulate` | the drawer's body with that tab in front |
| `field:Reads as` | an inspector field, found by its visible label; opens the inspector |
| `section:Indexes` | an inspector section, found by its visible title |
| `sidebar` | the table list |
| `table:orders` | a table on the canvas, panning to it only if it is off-screen |
| `column:books.author_id` | one column row inside a table node |
| `rel:books -> authors` | a connection on the canvas |
| `none` | nothing; the card floats free |

Because `field:` and `section:` are matched on the label the reader sees, they
only exist while the right thing is selected — so the tour selects whatever the
step's goals are about before it looks. Quote the label exactly as the component
spells it (`Color`, not `Colour`, in the table editor).

#### `goals:`

Each entry is `verb` or `verb | argument`, and each is read two ways: as a
question ("has the reader done this?") and as an instruction ("do it for them").
That is deliberate — one sentence, so the tick and the button can never disagree
about what the step means. Write them as things a *reader* would want to be
told, and only assert what the walkthrough actually asked for; a goal that
depends on something the prose never mentioned tells a reader they have failed
when they have not.

Every `checks:` verb from the table above is also a goal verb, so a final step
can assert exactly what the front matter asserts. On top of those:

| Goal | Asserts | Done for you |
| --- | --- | --- |
| `table \| orders` | a table by that name exists | adds it |
| `view \| v_customer_orders` | it exists and is a view | adds or converts it |
| `no table \| x`, `no column \| t.c` | it is gone | deletes it |
| `column \| orders.status : TEXT` | the column exists, with that type if given | adds it or retypes it |
| `flags \| orders.id : pk nn ai` | those flags, `-uq` for one that must be off | sets them |
| `default \| orders.placed_at : now()` | the default expression | sets it |
| `check \| t.c : expr`, `check \| t : expr` | a column or table CHECK | writes it |
| `schema \| warehouses : public` | the table's schema | sets it |
| `collapsed \| authors : keys` | how much of the node is showing | sets it |
| `materialized \| v_x : on` | the view is stored, not recomputed | ticks it |
| `viewsql \| v_x` | the view has a SELECT | writes the step's fenced block into it |
| `import \| a, b, c` | those tables are in the diagram | runs the step's fenced script through **Import SQL** |
| `fk \| books.author_id -> authors.id` | a foreign key between that column pair | draws it |
| `flow`, `embed`, `dependency` `\| a -> b` | a connection of that kind | draws it |
| `reads \| books belongs to authors` | the connection's verb | sets it |
| `label`, `reverse label` `\| a -> b : text` | how the connection is named | types it |
| `ondelete \| child -> parent : RESTRICT` | the referential action | sets it |
| `query \| a -> b` | the connection carries a tagged query | tags it with the step's fenced block |
| `derivation \| daily_sales.units : SUM(quantity) group by book_id` | a derived column computed that way | adds it to the flow |
| `index`, `unique index` `\| orders (customer_id, placed_at)` | an index on those columns, in that order | creates it |
| `group`, `external group` `\| shop : a, b` | a region by that name holding those tables | creates it and moves them in |
| `enum \| order_status : pending, paid` | the enum and its values, in order | creates it |
| `composite \| postal_address : street TEXT` | the struct and its fields | creates it |
| `dialect \| postgresql` | the diagram's dialect | switches it |

And five that describe the screen rather than the diagram — they are never run
against a companion diagram, because there is no screen in CI:

| Goal | Asserts |
| --- | --- |
| `open \| problems` | that drawer tab is in front |
| `select table \| authors`, `select connection \| a -> b` | it is selected, so the inspector shows it |
| `cardinality \| on` | the **View** menu's cardinality labels |
| `simulating \| daily_sales` | a simulation is feeding that table |
| `traced \| books -> customers` | **Trace** is showing that path |
| `focus \| books` | the canvas is focused on that neighbourhood (`none` for cleared) |

A step with no goals is legitimate — "read what Problems says", "try a what-if
edit" — and is ticked off when the reader presses **Continue**.

### House style

- Second person, present tense, imperative in steps. "Drag the handle", not "the
  user should drag the handle".
- **Bold** for UI labels, *italics* for checkbox and radio wording, `backticks`
  for identifiers, SQL fragments, file paths and shortcuts.
- Anchor new ideas to old ones. The reader is a programmer: "a group is a
  namespace", "a data flow is the `INSERT … SELECT` you have not written yet",
  "`DIFF` is `x[i] - x[i-1]`". Every walkthrough should do this at least once,
  in `## The mental model`.
- Say what the app *cannot* do as plainly as what it can. `## Gotchas` is where
  a walkthrough earns trust.
- Prefer showing generated output over describing it.
- At least 3500 characters of prose (code fences do not count). This is a floor
  for thoroughness, not a target — do not pad to reach it.

---

## What the tooling checks

`scripts/validate-walkthrough.mjs`, per file:

- the filename is `NN-lower-kebab.md` and `slug` agrees with it;
- every front-matter key is known, every required one present, lists are lists;
- `level`, `dialect`, `minutes`, `title` and `summary` are within their limits;
- `prerequisites` and `next` name walkthroughs that exist (or `none`);
- every `shortcuts` entry, and every shortcut-shaped `` `code span` `` in the
  prose, is a keystroke the app actually binds;
- the companion diagram exists and passes `scripts/validate-dbviz.mjs`;
- `checks` use known verbs with well-formed arguments;
- the `# ` heading matches `title`; the `## ` sections are all present, known,
  and in order;
- `## Steps` has ≥ 3 sequentially numbered `### N.` steps, each with a
  **You should see:** line and exactly one `<!-- step … -->` block, whose
  `target` names a `data-tour` attribute or drawer tab that really exists and
  whose `goals` use known verbs with well-formed arguments;
- `## What you'll build` has a ```mermaid block and `## Check your work` has a
  ```sql block;
- internal links resolve, no `TODO`/`TBD`/`FIXME` survives, and the prose clears
  the length floor.

`tests/walkthroughs.test.ts`, additionally:

- the series is numbered `00, 01, 02, …` with no gaps;
- `diagrams/` contains no file no walkthrough references;
- `README.md`'s index is current (`node scripts/build-walkthrough-index.mjs`);
- every companion diagram loads through the app's own `parseDiagramFile`;
- every `checks:` entry passes.

`tests/tour.test.ts`, for the clickthrough:

- every step points somewhere, keeps its instruction and its **You should see:**
  line, and uses goal verbs the app implements (the validator's copy of that
  list is checked against the app's, so the two cannot drift);
- every goal is true of the diagram the walkthrough ends with;
- replaying a whole walkthrough through **Do it for me**, from the canvas it
  starts on, satisfies those same goals — which is what stops the button and the
  prose describing different things.

## Adding one to the series

The chain makes this more than dropping a file in. To **append** one at the end:

1. Take the next free `NN`.
2. Write `docs/walkthroughs/NN-slug.md`, and build
   `docs/walkthroughs/diagrams/NN-slug.dbviz.json` by starting from the previous
   walkthrough's diagram and adding your delta.
3. Set `start:` to the previous walkthrough's `diagram:`, and
   `prerequisites:` to its slug.
4. Change the previous walkthrough's `next:` from `none` to your slug, and set
   yours to `none`.
5. `node scripts/build-walkthrough-index.mjs`
6. `node scripts/validate-walkthrough.mjs && npm test`

To **insert** one in the middle, you are splicing a chain: renumber everything
after it (which breaks inbound links, so grep for the old slugs), rebuild every
later stage's diagram on top of your new one, and re-point the `start:`,
`prerequisites:` and `next:` on both sides of the join. The validator will list
every break it finds, so work until `validate-walkthrough.mjs` reports "chained
end to end" — but weigh the churn first. Appending is usually the better trade.
