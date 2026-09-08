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

## The procedure

### 1. Pick the scope, then write the ending first

A walkthrough covers **one task a person would actually set out to do** ("connect
two tables", "fill one table from another"), not one feature of the UI. Decide
what the reader has on their canvas when they finish, and build *that diagram
first*, in the app or by hand. Everything else is written backwards from it.

Keep it small. Three to six tables is almost always enough; a reader who has to
type twelve tables before the interesting part starts will not finish.

### 2. Build the companion diagram

Write `diagrams/NN-slug.dbviz.json` by hand following
[`../ADVISOR_OUTPUT_FORMAT.md`](../ADVISOR_OUTPUT_FORMAT.md), which documents
every field of the file. The rules that matter most:

- Ids are readable and unique across the whole file: `tbl_orders`,
  `col_orders_customer_id`, `rel_orders_customer`, `drv_total`.
- Lay the tables out on a grid — `x = 320 * column`, `y = 260 * row` — parents
  above children, derived tables at the bottom. Never leave everything at `0,0`.
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
| Right-click menus | `src/components/ui/contextMenuItems.ts`, `src/lib/canvasActions.ts` |
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

**A bookshop.**

| Table | Columns you can rely on | Used for |
| --- | --- | --- |
| `authors` | `id`, `name`, `country` | the parent side of the first foreign key |
| `books` | `id`, `author_id`, `title`, `isbn`, `price_cents`, `published_on` | the child side; a natural unique key in `isbn` |
| `customers` | `id`, `email`, `crm_contact_id`, `created_at` | the join into the external group |
| `orders` | `id`, `customer_id`, `status`, `total_cents`, `placed_at` | statuses, filters, and the time series for sequence derivations |
| `order_items` | `id`, `order_id`, `book_id`, `quantity`, `unit_price_cents` | the grain that rollups aggregate |
| `reviews` | `id`, `book_id`, `customer_id`, `rating`, `posted_at` | a second path between tables, for tracing |
| `daily_sales` | `day`, `book_id`, `units`, `revenue_cents` | a derived table fed by a data flow |
| `customer_cadence` | `customer_id`, `avg_gap_days`, `order_count` | a derived table fed by a *sequence* derivation |
| `crm_contacts` | `contact_id`, `email` | lives in the external group; never created by the script |

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
| `diagram` | no | `diagrams/NN-slug.dbviz.json`. Omit only if the topic genuinely has no end state (rare). |
| `checks` | with `diagram` | ≥ 2 assertions about that diagram — see below. |
| `prerequisites` | yes | Slugs to read first, or a single `none`. |
| `next` | yes | Slugs to read after, or a single `none`. |

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
| `simulate \| daily_sales` | **Simulate** into that table runs, produces rows, and warns about nothing |
| `trace \| authors -> reviews` | **Trace** finds a path between those two tables |

Pick checks that would **break if the walkthrough's claims stopped being true**.
A walkthrough about external groups wants `omits | CREATE TABLE crm_contacts`.
One about derivations wants `simulate | …` and `derivations | N`. Do not pad the
list with checks that only restate that the file parsed.

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

1. Take the next free `NN`. Renumbering existing files breaks links — append
   rather than insert unless the reordering is worth the churn.
2. Write `docs/walkthroughs/NN-slug.md` and `docs/walkthroughs/diagrams/NN-slug.dbviz.json`.
3. Add the new slug to the `next:` of whatever should lead into it.
4. `node scripts/build-walkthrough-index.mjs`
5. `node scripts/validate-walkthrough.mjs && npm test`
