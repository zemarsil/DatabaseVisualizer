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

Both are checked in CI:

```bash
node scripts/validate-walkthrough.mjs docs/walkthroughs/NN-slug.md   # format + diagram structure
npx vitest run tests/walkthroughs.test.ts -t NN-slug                 # the checks: entries
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

In the app, the two buttons around a walkthrough's text are the reader's side of
the same idea: **Set up the canvas** loads `start`, and **Check my work** runs
`checks` against the live canvas (`src/lib/walkthroughChecks.ts`, the same
module CI uses). Between them, a reader can begin at any walkthrough in the
series without having typed the ones before it — which is the whole reason the
chain can be strict.

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

Hover the `books` table and drag the small handle beside `author_id` onto the
`id` row of `authors`.

**You should see:** a solid line with a crow's foot at the `books` end, and the
inspector switch to the connection with **Kind** set to *Foreign key*.
```

- One action per step. If a step has an "and then also", it is two steps.
- Name the exact affordance, and give the shortcut in backticks the first time.
- **You should see:** is not optional and is not a summary — it is the
  observable change, so a reader who typed something wrong finds out immediately.

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
  **You should see:** line;
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
