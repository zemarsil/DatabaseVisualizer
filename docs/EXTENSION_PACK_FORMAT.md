# Extension packs

An **extension pack** is one JSON file that tells Database Visualizer what a set of
database extensions provides. Loading one teaches the app about extensions it does
not ship with — a niche one, an in-house one, a new release of an existing one —
without waiting for a new version of the app.

Load a pack from **Types → Extensions → Where definitions come from**, either from a
file on disk or from a URL.

---

## What a pack is and is not

A pack carries **names and prose**. It never carries SQL, and nothing in it is ever
executed. Loading a pack changes four things and nothing else:

| What it changes | How |
| --- | --- |
| Column type autocomplete | An enabled extension's types appear in every column's TYPE box |
| Column default autocomplete | Its functions appear in the DEFAULT box |
| Problems | "This column's type needs an extension you have not enabled", with a one-click fix |
| The extension card | The summary, the chips, the docs link |

What a pack does **not** change is the generated SQL. That comes from the extension's
name and the diagram's dialect alone — `CREATE EXTENSION IF NOT EXISTS <name>;` on
PostgreSQL — so a diagram generates the right script on a machine that has never
loaded a single pack. This is deliberate: a `.dbviz.json` you share records only
which extensions it uses, never their definitions, so the file stays small and still
opens for someone who has never heard of them.

## Where definitions come from

The app merges three sources. Later ones win over earlier ones for the same
`(dialect, name)`:

1. **Bundled** — shipped with the app (`src/lib/extensions/bundled.ts`). Covers the
   usual PostgreSQL extensions, MariaDB plugins and SQLite modules. Always available,
   never authoritative.
2. **Packs** — this format. Kept in the browser's local storage until you remove them.
3. **A live database** — read straight off the server you are connected to.

The third is the one worth knowing about. A PostgreSQL server that has an extension
installed already knows exactly what it added: `pg_depend` ties every type, function,
index access method and operator class back to the extension that created it. **Read
from the database** in the Extensions section asks it, which means the app can
describe an extension nobody wrote a definition for — and describe it correctly for
*that server*, which is why it outranks both other sources. **Keep as a pack** saves
what the server said, in this format, so it survives a reload or travels to a machine
with no such server.

MariaDB answers the same question from `information_schema.PLUGINS`, and the
in-browser SQLite engine from `PRAGMA compile_options`.

---

## The format

```json
{
  "format": "dbviz-extension-pack",
  "version": 1,
  "id": "my-org-postgres",
  "name": "Our PostgreSQL extensions",
  "description": "What we run on the analytics cluster.",
  "dialect": "postgresql",
  "extensions": [ /* one entry per extension */ ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | recommended | Must be `"dbviz-extension-pack"`. A file without it is read as a pack anyway, with a warning; a file with a different value is refused. |
| `version` | no | Format version. `1` today. A higher number loads, and anything the app does not understand is ignored. |
| `id` | no | Stable identity. Reloading a pack with the same id replaces it rather than adding a second copy. Generated if absent. |
| `name` | no | Shown in the loaded-packs list. Defaults to the file name. |
| `description` | no | Tooltip in that list. |
| `dialect` | no | Default `dialect` for every entry, so a single-engine pack says it once. |
| `extensions` | **yes** | The definitions. A pack with none usable is refused. |

### An extension entry

```json
{
  "name": "vector",
  "dialect": "postgresql",
  "label": "pgvector",
  "summary": "Vector columns and approximate nearest-neighbour indexes.",
  "docsUrl": "https://github.com/pgvector/pgvector",
  "install": "create-extension",
  "types": [
    { "name": "vector", "example": "vector(1536)", "summary": "Fixed-length array of 4-byte floats." },
    { "name": "halfvec", "example": "halfvec(1536)" }
  ],
  "functions": [
    { "name": "l2_distance", "example": "l2_distance(a, b)", "summary": "Euclidean distance; the <-> operator." }
  ],
  "indexMethods": ["hnsw", "ivfflat"],
  "operatorClasses": ["vector_l2_ops", "vector_cosine_ops"],
  "requires": ["some_other_extension"],
  "note": "An index must name the operator class matching the distance you query with."
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | **yes** | Exactly as the engine spells it (`postgis`, `uuid-ossp`, `ha_connect`). This is the identity, matched case-insensitively, and the only part that reaches the generated SQL. |
| `dialect` | yes, unless the pack sets one | `postgresql`, `mariadb` or `sqlite`. |
| `label` | no | Display name. `vector` the extension is `pgvector` the project. |
| `summary` | no | One line, shown on the card and in the picker. |
| `docsUrl` | no | Linked from the card. |
| `install` | no | How the engine enables it — see below. Defaults to the engine's usual way. |
| `types` | no | The types it adds. These reach column autocomplete and the "needs an extension" check. |
| `functions` | no | The functions it adds. These reach the DEFAULT autocomplete. |
| `indexMethods` | no | Index access methods the extension *adds*, e.g. pgvector's `["hnsw", "ivfflat"]`. Most extensions add none — `gist`, `gin`, `spgist` and `brin` are built into PostgreSQL, and an extension supplies operator classes *for* them, which belong below. |
| `operatorClasses` | no | Operator classes, e.g. `["gin_trgm_ops"]`. |
| `requires` | no | Extensions that must be enabled first. Problems reports a missing one as an error, with a fix that adds it ahead of this one. |
| `note` | no | Anything worth knowing before enabling it: privileges, licensing, gotchas. |

`types` and `functions` each accept a bare string as shorthand for `{ "name": "..." }`,
so `"types": ["hstore"]` and `"types": [{ "name": "hstore" }]` mean the same thing.

For a type, `example` is what someone actually types into a column — `vector(1536)`,
not `vector` — so it is what the autocomplete offers first. `name` is the bare base
name and is what the "needs an extension" check matches against, after stripping
arguments and array brackets. For a function, `example` is a call you could paste
straight into a DEFAULT.

### `install`

Decides what the generator writes for this extension.

| Value | Generates |
| --- | --- |
| `create-extension` | `CREATE EXTENSION IF NOT EXISTS <name> [WITH SCHEMA …] [VERSION '…'];` — PostgreSQL's default |
| `install-soname` | A comment carrying `INSTALL SONAME '<name>';` — MariaDB's default. Not run with the schema: it installs into the whole server, needs SUPER, and only has to be done once |
| `client-loaded` | A comment saying the client has to load it — SQLite's default |
| `built-in` | Nothing. For something the engine already has, such as `plpgsql` or SQLite's FTS5 |

---

## Rules that keep a pack loadable

- **Names and prose only.** There is no field that carries SQL, and there is no way for
  a pack to introduce a statement the generator will run.
- **A bad entry is dropped, not fatal.** An entry with no `name`, or with a `dialect`
  that is not one of the three, is skipped and reported; the rest of the pack loads.
- **One entry per extension per dialect.** A repeat is ignored, and the first wins.
- **2 MB cap.** A pack is a list of names; anything larger is not one.
- **Packs live in the browser, not in the diagram.** Removing a pack never changes a
  diagram — the extensions it declares stay, they just lose their autocomplete and
  checks until a definition turns up again.

## Checking a pack

Load it. The toast says how many definitions were read and how many apply to the
current dialect, and any problem with the file is reported with the entry that caused
it. There is no separate validator: the parser that loads a pack is the one that
checks it.

## An example

`docs/examples/postgres-extras.extpack.json` is a small, valid pack covering three
PostgreSQL extensions the app does not bundle. Load it to see the format work, or
copy it as a starting point.
