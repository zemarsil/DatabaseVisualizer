"""
Ids, positions, tables and the file the map is written into.

Everything above this point talks about code. Everything here talks about the
diagram: which table a query's name matches, what id a node gets, where it
lands on the canvas, and how a second scan of the same program updates the map
in place instead of leaving a copy of every function beside the first.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .model import Node, slug
from .sqlread import Access, TableRef, add_name


ID_PREFIX = {'program': 'prg_', 'module': 'mod_', 'class': 'cls_', 'function': 'fn_', 'data': 'dat_'}

PROGRAM_WIDTH = 260
PROGRAM_HEADER_HEIGHT = 44
PROGRAM_STEP_HEIGHT = 26
PROGRAM_FOOTER_HEIGHT = 10
PROGRAM_EMPTY_HEIGHT = 30
CODE_PADDING = 22
CODE_HEADER = 30
# Vertical room a container fills before its members wrap into a second column,
# so a file with forty functions is a block rather than a mile of canvas.
COLUMN_HEIGHT = 1100
ROW_GAP = 30
COLUMN_GAP = 60

COLOR_OF_KIND = {'program': 'pink', 'module': 'indigo', 'class': 'indigo', 'function': 'pink', 'data': 'slate'}


def assign_ids(programs: list[Node], taken: Optional[set[str]] = None) -> None:
    """
    A readable id per node, stable across scans of the same tree.

    Readable because the cross-references are meant to be reviewable in the
    file; stable because re-scanning a codebase should update the map rather
    than grow a second copy of it. The short form is used where it is free —
    "fn_place_order" — and lengthened towards the full path only where two
    nodes would otherwise collide.

    `taken` is what the diagram being written into already holds, so scanning a
    second service into a map somebody drew by hand cannot land on one of its
    ids — which the file's own validator would rightly refuse.
    """
    taken = set(taken or ())
    for program in programs:
        for node in [program, *program.descendants()]:
            names = [n.name for n in reversed([node, *list(node.ancestors())])]
            for i in range(len(names) - 1, -1, -1):
                tail = names[i:]
                if tail and '.' in tail[-1]:
                    tail = tail[:-1] + [tail[-1].rsplit('.', 1)[0]]
                candidate = ID_PREFIX[node.kind] + slug('_'.join(tail))
                if candidate not in taken:
                    break
            else:                                     # pragma: no cover - len >= 1 always
                candidate = ID_PREFIX[node.kind] + slug(node.name)
            base = candidate
            n = 2
            while candidate in taken:
                candidate = f'{base}_{n}'
                n += 1
            taken.add(candidate)
            node.node_id = candidate


def node_height(node: Node) -> int:
    rows = len(node.steps) * PROGRAM_STEP_HEIGHT if node.steps else PROGRAM_EMPTY_HEIGHT
    return PROGRAM_HEADER_HEIGHT + rows + PROGRAM_FOOTER_HEIGHT


def layout(programs: list[Node], origin: tuple[float, float]) -> None:
    """
    Place the leaves. The regions follow.

    Nothing here draws a box around a module: the app derives every container's
    rectangle from where its members sit, bottom-up, so the scanner's whole job
    is to give each function somewhere sensible to be and each container an
    anchor for when it is folded.
    """
    positions: dict[int, list[float]] = {}

    def place(node: Node) -> tuple[float, float]:
        positions[id(node)] = [0.0, 0.0]
        if not node.children:
            return float(PROGRAM_WIDTH), float(node_height(node))
        x = y = 0.0
        column_width = 0.0
        width = height = 0.0
        for child in node.children:
            w, h = place(child)
            if y > 0 and y + h > COLUMN_HEIGHT:
                x += column_width + COLUMN_GAP
                y, column_width = 0.0, 0.0
            shift(child, x, y)
            y += h + ROW_GAP
            column_width = max(column_width, w)
            width = max(width, x + column_width)
            height = max(height, y - ROW_GAP)
        for child in node.children:
            shift(child, CODE_PADDING, CODE_PADDING + CODE_HEADER)
        return width + CODE_PADDING * 2, height + CODE_PADDING * 2 + CODE_HEADER

    def shift(node: Node, dx: float, dy: float) -> None:
        for n in [node, *node.descendants()]:
            positions[id(n)][0] += dx
            positions[id(n)][1] += dy

    x, y = origin
    for program in programs:
        w, _ = place(program)
        shift(program, x, y)
        x += w + 120
    for program in programs:
        for node in [program, *program.descendants()]:
            px, py = positions[id(node)]
            node.position = (round(px), round(py))


class Schema:
    """
    The tables the map is allowed to point at, by the names the SQL used.

    Resolving against a real diagram is what makes the columns right: a query
    that mentions "created_at" while joining three tables is ambiguous in the
    text and unambiguous the moment you know which of the three has the column.
    """

    def __init__(self, diagram: dict, stub: bool) -> None:
        self.diagram = diagram
        self.stub_allowed = stub
        self.tables: list[dict] = diagram.setdefault('tables', [])
        self.index: dict[str, dict] = {}
        self.stubbed: list[str] = []
        for t in self.tables:
            self._register(t)
        xs = [t.get('position', {}).get('x', 0) for t in self.tables]
        ys = [t.get('position', {}).get('y', 0) for t in self.tables]
        self._next_stub = [max(xs) + 360 if xs else 0, min(ys) if ys else 0]

    def _register(self, table: dict) -> None:
        name = str(table.get('name', '')).lower()
        if not name:
            return
        self.index.setdefault(name, table)
        schema = table.get('schema')
        if schema:
            self.index.setdefault(f'{str(schema).lower()}.{name}', table)

    def find(self, ref: TableRef) -> Optional[dict]:
        if ref.schema:
            hit = self.index.get(f'{ref.schema.lower()}.{ref.name.lower()}')
            if hit is not None:
                return hit
        return self.index.get(ref.name.lower())

    def stub(self, ref: TableRef, columns: list[str], seen_in: str) -> Optional[dict]:
        """
        A table the code reads that the diagram has never heard of.

        Inventing it is the lesser evil: the alternative is a step pointing at
        nothing, which draws no arrow and makes the file fail its own validator.
        What the scanner knows is the name and the columns the queries named, so
        that is exactly what the stub says, and it says where it came from. When
        the queries named no columns at all — a bare DELETE FROM, a SELECT * —
        there is no table to write, and the step is left dangling for Problems
        to report, which is the more useful complaint of the two.
        """
        if not self.stub_allowed or not columns:
            return None
        table = {
            'id': f'tbl_{slug(ref.key)}',
            'name': ref.name,
            'columns': [],
            'indexes': [],
            'checks': [],
            'position': {'x': self._next_stub[0], 'y': self._next_stub[1]},
            'color': 'slate',
            'comment': f'Seen in the code ({seen_in}), not in this diagram. '
                       'Columns are the ones its queries named; the types are placeholders.',
        }
        if ref.schema:
            table['schema'] = ref.schema
        self._next_stub[1] += 220
        self.tables.append(table)
        self._register(table)
        self.stubbed.append(ref.key)
        for name in columns:
            self.column_id(table, name, create=True)
        return table

    def column_id(self, table: dict, name: str, create: bool = False) -> Optional[str]:
        for c in table.get('columns', []):
            if str(c.get('name', '')).lower() == name.lower():
                return c.get('id')
        if not create:
            return None
        cid = f'col_{slug(table.get("name", "t"))}_{slug(name)}'
        table.setdefault('columns', []).append({
            'id': cid,
            'name': name,
            'type': 'TEXT',
            'nullable': True,
            'primaryKey': False,
            'unique': False,
            'autoIncrement': False,
        })
        return cid

    def order_of(self, table: dict) -> dict[str, int]:
        return {str(c.get('id')): i for i, c in enumerate(table.get('columns', []))}


@dataclass
class Report:
    nodes: int = 0
    functions: int = 0
    reads: int = 0
    writes: int = 0
    calls: int = 0
    imports: int = 0
    loads: int = 0
    dropped: int = 0
    missing_tables: dict[str, int] = field(default_factory=dict)
    missing_columns: dict[str, int] = field(default_factory=dict)


def plan_stubs(programs: list[Node], schema: Schema) -> None:
    """
    Work out every table the diagram has not got before writing any step.

    In one pass a table would be invented by whichever query reached it first,
    with only that query's columns: "DELETE FROM book_totals" would leave a
    table with no columns at all, and the INSERT two lines later would have
    nowhere to put its three. Collecting first means a stub arrives complete.
    """
    wanted: dict[str, tuple[TableRef, list[str], str]] = {}
    for program in programs:
        for node in [program, *program.descendants()]:
            for step in node.steps:
                if step.op not in ('read', 'write') or step.access is None:
                    continue
                ref = step.access.table
                if schema.find(ref) is not None:
                    continue
                entry = wanted.setdefault(ref.key.lower(), (ref, [], node.path))
                for name in step.access.columns:
                    add_name(entry[1], name)
    for ref, columns, seen_in in wanted.values():
        schema.stub(ref, columns, seen_in)


def build_programs(
    programs: list[Node],
    schema: Schema,
    opts: argparse.Namespace,
    previous: dict[str, dict],
) -> tuple[list[dict], Report]:
    """The nodes as the diagram stores them, steps resolved against the schema."""
    report = Report()
    plan_stubs(programs, schema)
    out: list[dict] = []
    collapse = set(opts.collapse or [])
    for program in programs:
        for node in [program, *program.descendants()]:
            report.nodes += 1
            if node.kind == 'function':
                report.functions += 1
            old = previous.get(node.node_id, {})
            entry: dict = {'id': node.node_id, 'name': node.name}
            if node.kind != 'program':
                entry['kind'] = node.kind
            if node.parent is not None:
                entry['parentId'] = node.parent.node_id
            if node.kind in collapse and node.children:
                entry['collapsed'] = True
            elif old.get('collapsed'):
                entry['collapsed'] = True
            entry['language'] = node.language or 'other'
            if node.kind == 'program' and opts.role:
                entry['role'] = opts.role
            if node.entrypoint:
                entry['entrypoint'] = node.entrypoint
            comment = node.comment or old.get('comment')
            if comment:
                entry['comment'] = comment
            entry['color'] = old.get('color') or COLOR_OF_KIND[node.kind]
            keep_position = old.get('position') if not opts.relayout else None
            entry['position'] = keep_position or {'x': node.position[0], 'y': node.position[1]}
            entry['steps'] = build_steps(node, schema, report)
            out.append(entry)
    return out, report


def build_steps(node: Node, schema: Schema, report: Report) -> list[dict]:
    """One step per thing the node does, with the keys in the order the format writes them."""
    steps: list[dict] = []
    for i, step in enumerate(node.steps, start=1):
        entry: dict = {'id': f'stp_{node.node_id}_{i}', 'op': step.op}
        if step.op in ('read', 'write'):
            access = step.access
            assert access is not None
            table = schema.find(access.table)
            if table is None:
                key = access.table.key
                report.missing_tables[key] = report.missing_tables.get(key, 0) + 1
            entry['tableId'] = table['id'] if table else f'tbl_{slug(access.table.key)}'
            entry['columnIds'] = column_ids(access, table, schema, report) if table else []
            if step.sql:
                entry['sql'] = step.sql
            report.reads += step.op == 'read'
            report.writes += step.op == 'write'
        else:
            entry['columnIds'] = []
            assert step.target is not None
            entry['codeId'] = step.target.node_id
            report.calls += step.op == 'call'
            report.imports += step.op in ('import', 'extends')
            report.loads += step.op == 'load'
        if step.note:
            entry['note'] = step.note
        ordered = {'id': entry['id'], 'op': entry['op']}
        if 'tableId' in entry:
            ordered['tableId'] = entry['tableId']
        ordered['columnIds'] = entry['columnIds']
        for key in ('codeId', 'sql', 'note'):
            if key in entry:
                ordered[key] = entry[key]
        steps.append(ordered)
    return steps


def column_ids(access: Access, table: dict, schema: Schema, report: Report) -> list[str]:
    """
    The columns of a step, in the table's own order.

    "SELECT *" is the whole row, and the whole row is written as no columns at
    all — which is both the format's default and the honest name for it.
    """
    if access.whole_row:
        return []
    found: list[str] = []
    for name in access.columns:
        cid = schema.column_id(table, name)
        if cid:
            found.append(cid)
        else:
            key = f'{table.get("name")}.{name}'
            report.missing_columns[key] = report.missing_columns.get(key, 0) + 1
    for name in access.maybe:
        cid = schema.column_id(table, name)
        if cid and cid not in found:
            found.append(cid)
    order = schema.order_of(table)
    return sorted(dict.fromkeys(found), key=lambda c: order.get(c, 1 << 30))


# ---------------------------------------------------------------------------
# The diagram it writes into
# ---------------------------------------------------------------------------


def empty_diagram(name: str, dialect: str) -> dict:
    return {
        'version': 1,
        'name': name,
        'dialect': dialect,
        'tables': [],
        'relationships': [],
        'groups': [],
        'customTypes': [],
        'notes': [],
        'programs': [],
    }


def load_target(path: Optional[str], sheet: Optional[str], name: str, dialect: str) -> tuple[dict, dict]:
    """
    The document to write into and the diagram inside it.

    A workspace holds several diagrams under "sheets"; the map goes into the one
    named by --sheet, or the one that was open.
    """
    if not path:
        d = empty_diagram(name, dialect)
        return d, d
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(document, dict):
        raise SystemExit(f'{path}: not a diagram file.')
    sheets = document.get('sheets')
    if not isinstance(sheets, list):
        return document, document
    if not sheets:
        raise SystemExit(f'{path}: the workspace has no diagrams in it.')
    if sheet:
        chosen = next((s for s in sheets if s.get('id') == sheet or s.get('name') == sheet), None)
        if chosen is None:
            names = ', '.join(str(s.get('name')) for s in sheets)
            raise SystemExit(f'{path}: no diagram called "{sheet}". It holds: {names}.')
    else:
        chosen = next((s for s in sheets if s.get('id') == document.get('activeSheet')), sheets[0])
    return document, chosen


def strip_previous(diagram: dict, names: set[str]) -> dict[str, dict]:
    """
    Take out what an earlier scan of the same programs left, keeping what a
    person did to it.

    A scan owns the program node it writes and everything under it: running it
    again after the code moved should update the map rather than leave a second
    copy of every function beside the first. What the re-scan cannot work out
    for itself — where you dragged a node, what colour you gave it, a comment
    you wrote where the code had no docstring — comes back on the node with the
    same id.
    """
    programs: list[dict] = diagram.setdefault('programs', [])
    doomed = {p['id'] for p in programs if not p.get('parentId') and p.get('name') in names and p.get('id')}
    while True:
        more = {p['id'] for p in programs if p.get('parentId') in doomed and p.get('id') not in doomed}
        if not more:
            break
        doomed |= more
    previous = {p['id']: p for p in programs if p.get('id') in doomed}
    diagram['programs'] = [p for p in programs if p.get('id') not in doomed]
    return previous


def shift_all(programs: list[Node], dx: float, dy: float) -> None:
    for p in programs:
        for n in [p, *p.descendants()]:
            n.position = (n.position[0] + dx, n.position[1] + dy)


def park_beside_schema(programs: list[Node], diagram: dict) -> None:
    """
    Put the map to the left of the schema, the way Detangle parks a program:
    the caller is not part of the tables' dependency order, and it reads best
    coming into them from outside.
    """
    xs = [n.position[0] + PROGRAM_WIDTH for p in programs for n in [p, *p.descendants()]]
    if not xs:
        return
    tables = diagram.get('tables') or []
    left = min((t.get('position', {}).get('x', 0) for t in tables), default=0)
    top = min((t.get('position', {}).get('y', 0) for t in tables), default=0)
    shift_all(programs, left - max(xs) - 220, top)
