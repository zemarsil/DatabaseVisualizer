#!/usr/bin/env python3
"""
Read a Python codebase into a Database Visualizer code map.

The code map (docs/CODE_MAP_FORMAT.md) says what talks to the database: the
program, the files inside it, the classes in those, the functions that actually
run a SELECT or an INSERT, and the calls and imports between them. Drawing one
by hand is the right way to map a service you are designing. Drawing one by
hand for a codebase that already exists is an afternoon of grep, which is what
this script is for.

    python3 scripts/scan_python.py services/api --into bookshop.dbviz.json -o mapped.dbviz.json

It reads the code with Python's own ``ast`` — not with a regex over the source,
so a ``def`` inside a string is not a function and a commented-out query is not
a step — and writes the nodes, their parents and their steps. Everything else
about the picture (the arrows, the regions around the containers) the app
derives from those, so the scanner only has to place the leaves.

What it cannot do is guess. A table name assembled at run time, a query built
by an ORM, a call through a registry: none of those are in the syntax, so none
of them are in the map. The map it writes is the part the code says out loud,
and the honest way to use it is as a first draft to correct, the same as an
imported schema.
"""

from __future__ import annotations

import argparse
import ast
import copy
import fnmatch
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

# ---------------------------------------------------------------------------
# Reading SQL
# ---------------------------------------------------------------------------

# A string only counts as a statement if it *starts* with one of these, so a
# sentence that happens to contain the word "update" is prose and stays prose.
SQL_VERBS = {'SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'TRUNCATE'}

# Verbs that change rows. Everything here draws a write arrow; SELECT draws a
# read. DDL (CREATE, ALTER, DROP) is deliberately absent: a migration writes the
# schema, not the rows in it, and the schema half of the app already owns that.
WRITE_VERBS = {'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'TRUNCATE'}

TOKEN_RE = re.compile(
    r"""
      (?P<ws>\s+)
    | (?P<comment>--[^\n]*|\#[^\n]*|/\*.*?\*/)
    | (?P<cast>::)
    | (?P<param>%\([A-Za-z_]\w*\)s|%[sd]|\?|:\w+|\$\d+|\{[^{}]*\})
    | (?P<ident>"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[A-Za-z_]\w*\])
    | (?P<lit>'(?:[^']|'')*')
    | (?P<word>[A-Za-z_]\w*)
    | (?P<number>\d+(?:\.\d+)?)
    | (?P<punct>.)
    """,
    re.X | re.S,
)

# Words that are never a column name. Function names do not need to be here:
# an identifier followed by "(" is read as a call and skipped either way.
SQL_KEYWORDS = {
    'ALL', 'AND', 'ANY', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CONFLICT', 'CROSS',
    'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT',
    'DISTINCTROW', 'DO', 'DUPLICATE', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXCLUDED', 'EXISTS',
    'FALSE', 'FETCH', 'FILTER', 'FIRST', 'FOLLOWING', 'FOR', 'FROM', 'FULL', 'GROUP', 'HAVING',
    'IGNORE', 'ILIKE', 'IN', 'INNER', 'INSERT', 'INTERSECT', 'INTERVAL', 'INTO', 'IS', 'JOIN',
    'KEY', 'LAST', 'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'LOCKED', 'MATCHED', 'MERGE', 'NATURAL',
    'NEXT', 'NO', 'NOT', 'NOTHING', 'NOWAIT', 'NULL', 'NULLS', 'OF', 'OFFSET', 'ON', 'ONLY', 'OR',
    'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRECEDING', 'RANGE', 'RECURSIVE', 'REPLACE',
    'RETURNING', 'RIGHT', 'ROW', 'ROWS', 'SELECT', 'SET', 'SHARE', 'SKIP', 'SOME', 'TABLE', 'THEN',
    'TIES', 'TIME', 'TRUE', 'TRUNCATE', 'UNBOUNDED', 'UNION', 'UPDATE', 'USING', 'VALUES', 'WHEN',
    'WHERE', 'WINDOW', 'WITH', 'WITHIN', 'ZONE',
}

@dataclass
class Token:
    kind: str
    text: str
    depth: int = 0

    @property
    def word(self) -> str:
        """Upper-cased text, for comparing against keywords."""
        return self.text.upper() if self.kind == 'word' else ''


def tokenize(sql: str) -> list[Token]:
    """
    SQL as a flat token list with parenthesis depth on each token.

    Quoted identifiers ("orders", `orders`, [orders]) come back as plain words
    with the quotes off, so the rest of the reader never has to care which
    dialect wrote them. Placeholders of every flavour the drivers use — %s,
    %(name)s, ?, :name, $1 — collapse to one 'param' token, as does the {expr}
    left behind by an f-string, because what matters downstream is only that
    something was substituted there.
    """
    out: list[Token] = []
    depth = 0
    for m in TOKEN_RE.finditer(sql):
        kind = m.lastgroup or 'punct'
        text = m.group()
        if kind in ('ws', 'comment'):
            continue
        if kind == 'ident':
            out.append(Token('word', text[1:-1].replace('""', '"').replace('``', '`'), depth))
            continue
        if kind == 'punct':
            if text == '(':
                out.append(Token('punct', text, depth))
                depth += 1
                continue
            if text == ')':
                depth = max(0, depth - 1)
                out.append(Token('punct', text, depth))
                continue
        out.append(Token(kind, text, depth))
    return out


def looks_like_sql(text: str) -> bool:
    """
    Whether a string literal is a statement rather than prose.

    The test is the first word, which is what keeps a docstring describing an
    update from becoming a write arrow.
    """
    stripped = text.lstrip()
    while stripped.startswith('--') or stripped.startswith('/*'):
        if stripped.startswith('--'):
            stripped = stripped.split('\n', 1)[1].lstrip() if '\n' in stripped else ''
        else:
            end = stripped.find('*/')
            stripped = stripped[end + 2:].lstrip() if end >= 0 else ''
    m = re.match(r'[A-Za-z_]\w*', stripped)
    return bool(m) and m.group().upper() in SQL_VERBS


@dataclass
class TableRef:
    """A table named in a statement, with whatever the statement calls it."""
    name: str
    alias: Optional[str] = None
    schema: Optional[str] = None

    @property
    def key(self) -> str:
        return f'{self.schema}.{self.name}' if self.schema else self.name


@dataclass
class Access:
    """One table one statement touches, and how."""
    op: str                                     # 'read' | 'write'
    table: TableRef
    columns: list[str] = field(default_factory=list)
    # Unqualified columns in a statement that names several tables. Which table
    # owns them is a question only the schema can answer, so they are carried
    # separately and matched once the diagram is in hand.
    maybe: list[str] = field(default_factory=list)
    whole_row: bool = False
    # Depth of the FROM or JOIN that named it, so a bare column in a subquery
    # is handed to the subquery's table rather than to the outer one.
    depth: int = 0


def _read_table_ref(tokens: list[Token], i: int, func_guard: bool = True) -> tuple[Optional[TableRef], int]:
    """
    Parse "[schema.]name [AS] [alias]" at i. Returns the ref and the index after it.

    A '(' at i is a subquery or a set-returning function — there is no table to
    name, and the scan that called this goes on to find the FROMs inside it.
    That guard is only right after FROM and JOIN: after INSERT INTO, the very
    same '(' is the column list, so the callers there turn it off.
    """
    n = len(tokens)
    if i >= n or tokens[i].kind != 'word' or tokens[i].word in SQL_KEYWORDS:
        return None, i
    parts = [tokens[i].text]
    i += 1
    while i + 1 < n and tokens[i].kind == 'punct' and tokens[i].text == '.' and tokens[i + 1].kind == 'word':
        parts.append(tokens[i + 1].text)
        i += 2
    if func_guard and i < n and tokens[i].kind == 'punct' and tokens[i].text == '(':
        return None, i
    if any(ch in part for part in parts for ch in '{}%?'):
        # "FROM \"{0}\"": the table is chosen at run time, so there is no table
        # to name and guessing one would be worse than saying nothing.
        return None, i
    schema = '.'.join(parts[:-1]) or None
    ref = TableRef(name=parts[-1], schema=schema)
    if i < n and tokens[i].kind == 'word' and tokens[i].word == 'AS':
        i += 1
    if i < n and tokens[i].kind == 'word' and tokens[i].word not in SQL_KEYWORDS:
        nxt = tokens[i + 1] if i + 1 < n else None
        if not (nxt and nxt.kind == 'punct' and nxt.text in '(.'):
            ref.alias = tokens[i].text
            i += 1
    return ref, i


def _column_list(tokens: list[Token], i: int) -> tuple[list[str], int]:
    """The "(a, b, c)" after INSERT INTO t. Returns the names and the index after ')'."""
    if i >= len(tokens) or tokens[i].text != '(':
        return [], i
    inner = tokens[i].depth + 1
    cols: list[str] = []
    j = i + 1
    while j < len(tokens):
        t = tokens[j]
        if t.kind == 'punct' and t.text == ')' and t.depth == inner - 1:
            return cols, j + 1
        if t.kind == 'word' and t.depth == inner and t.word not in SQL_KEYWORDS:
            nxt = tokens[j + 1] if j + 1 < len(tokens) else None
            if not (nxt and nxt.kind == 'punct' and nxt.text == '('):
                cols.append(t.text)
        j += 1
    return cols, j


def _set_columns(tokens: list[Token], i: int) -> tuple[list[str], set[int]]:
    """
    The assignment targets of a SET clause: the columns an UPDATE writes.

    Only the left of each '=' at the clause's own depth counts, which is what
    keeps "SET on_hand = on_hand - %s" from claiming to write the column twice
    and "WHERE book_id = %s" from being mistaken for one at all.
    """
    cols: list[str] = []
    at: set[int] = set()
    base = tokens[i].depth if i < len(tokens) else 0
    expect = True
    j = i
    while j < len(tokens):
        t = tokens[j]
        if t.kind == 'word' and t.depth == base and t.word in ('FROM', 'WHERE', 'RETURNING'):
            break
        if t.depth == base:
            if t.kind == 'punct' and t.text == ',':
                expect = True
            elif expect and t.kind == 'word' and t.word not in SQL_KEYWORDS:
                cols.append(t.text)
                at.add(j)
                expect = False
            elif t.kind == 'punct' and t.text == '=':
                expect = False
        j += 1
    return cols, at


def _leading_ctes(tokens: list[Token]) -> tuple[set[str], int, list[int]]:
    """
    Names bound by a leading WITH — query results, not tables — and the index
    where the statement they feed actually begins.

    That index is what tells a real UPDATE from the "FOR UPDATE" at the end of a
    locking SELECT: the verb only counts when it is the statement's own.
    """
    if not tokens or tokens[0].word != 'WITH':
        return set(), 0, []
    names: set[str] = set()
    at: list[int] = []
    i = 1
    if i < len(tokens) and tokens[i].word == 'RECURSIVE':
        i += 1
    while i < len(tokens):
        if tokens[i].kind != 'word' or tokens[i].word in SQL_KEYWORDS:
            break
        names.add(tokens[i].text.lower())
        at.append(i)
        i += 1
        if i < len(tokens) and tokens[i].text == '(':   # the optional column list
            depth = tokens[i].depth
            i += 1
            while i < len(tokens) and not (tokens[i].text == ')' and tokens[i].depth == depth):
                i += 1
            i += 1
        while i < len(tokens) and tokens[i].word in ('AS', 'MATERIALIZED', 'NOT'):
            i += 1
        if i >= len(tokens) or tokens[i].text != '(':
            break
        depth = tokens[i].depth
        i += 1
        while i < len(tokens) and not (tokens[i].text == ')' and tokens[i].depth == depth):
            i += 1
        i += 1
        if i < len(tokens) and tokens[i].kind == 'punct' and tokens[i].text == ',':
            i += 1
            continue
        break
    return names, i, at


def _has_shape(tokens: list[Token], start: int) -> bool:
    """
    Whether a string that opens with a SQL verb goes on to be a statement.

    Starting with the verb is most of the test, but not all of it: "Update the
    row in place" and "Select a warehouse first" open the same way and are
    English. A statement's second keyword is not optional — an UPDATE has a SET,
    a DELETE has a FROM — so requiring it costs nothing real and turns a prose
    string back into prose.
    """
    verb = tokens[start].word
    needed = {'UPDATE': ('SET',), 'DELETE': ('FROM',), 'INSERT': ('INTO',),
              'REPLACE': ('INTO',), 'MERGE': ('INTO', 'USING')}.get(verb)
    if not needed:
        return True
    return any(t.word in needed for t in tokens[start + 1:])


def read_statement(tokens: list[Token]) -> list[Access]:
    """
    One statement as the tables it touches, reads first and the write last.

    The reading rule is the one the format's own example implies: a write's
    columns are the ones it names as targets — the INSERT column list, the SET
    assignments — and every other column mentioned anywhere belongs to the
    tables being read. That is why "UPDATE stock_levels SET on_hand = on_hand -
    %s WHERE book_id = %s" writes one column rather than three, and why "SELECT
    id FROM customers WHERE email = %s" reads two rather than one.
    """
    if not tokens or tokens[0].kind != 'word':
        return []
    ctes, start, cte_at = _leading_ctes(tokens)
    n = len(tokens)
    if start >= n or tokens[start].word not in SQL_VERBS or not _has_shape(tokens, start):
        return []

    write: Optional[Access] = None
    consumed: set[int] = set(cte_at)   # token indexes already spoken for

    verb_at = start if tokens[start].word in WRITE_VERBS else None
    if verb_at is not None:
        verb = tokens[verb_at].word
        i = verb_at + 1
        if verb in ('INSERT', 'REPLACE', 'MERGE'):
            while i < n and tokens[i].word in ('INTO', 'IGNORE', 'OR', 'ABORT', 'ROLLBACK'):
                consumed.add(i)
                i += 1
            ref, after = _read_table_ref(tokens, i, func_guard=False)
            if ref:
                cols, after = _column_list(tokens, after)
                write = Access('write', ref, columns=cols)
                consumed.update(range(i, after))
        elif verb == 'UPDATE':
            while i < n and tokens[i].word in ('ONLY', 'IGNORE', 'OR', 'ABORT'):
                i += 1
            ref, after = _read_table_ref(tokens, i, func_guard=False)
            if ref:
                set_at = next((j for j in range(after, n) if tokens[j].depth == 0 and tokens[j].word == 'SET'), None)
                cols, at = _set_columns(tokens, set_at + 1) if set_at is not None else ([], set())
                write = Access('write', ref, columns=cols)
                consumed.update(range(i, after))
                consumed.update(at)
        elif verb == 'DELETE':
            if i < n and tokens[i].word == 'FROM':
                consumed.add(i)
                i += 1
            ref, after = _read_table_ref(tokens, i, func_guard=False)
            if ref:
                write = Access('write', ref)
                consumed.update(range(i, after))
        elif verb == 'TRUNCATE':
            if i < n and tokens[i].word == 'TABLE':
                i += 1
            ref, after = _read_table_ref(tokens, i, func_guard=False)
            if ref:
                write = Access('write', ref)
                consumed.update(range(i, after))

        # An upsert writes what its DO UPDATE names as well, and the columns it
        # conflicts on are the key it matched by, not a column it read.
        if write and verb in ('INSERT', 'REPLACE', 'MERGE'):
            for j in range(verb_at, n):
                if tokens[j].word == 'CONFLICT':
                    _, after = _column_list(tokens, j + 1)
                    consumed.update(range(j, after))
                    break
            for j in range(verb_at, n):
                upsert = tokens[j].word == 'SET' or (tokens[j].word == 'UPDATE' and j and tokens[j - 1].word == 'KEY')
                if upsert and j not in consumed:
                    cols, at = _set_columns(tokens, j + 1)
                    consumed.update(at)
                    for c in cols:
                        if c not in write.columns:
                            write.columns.append(c)
                    break

    # Every remaining FROM / JOIN / USING names something being read, at any
    # depth, which is what makes a subquery in a WHERE clause show up as the
    # read it is without the reader having to understand nesting.
    reads: list[Access] = []
    by_alias: dict[str, Access] = {}
    i = 0
    while i < n:
        t = tokens[i]
        if i in consumed or t.kind != 'word':
            i += 1
            continue
        w = t.word
        source = w in ('FROM', 'JOIN') or (w == 'USING' and verb_at is not None
                                           and tokens[verb_at].word == 'DELETE')
        if not source:
            i += 1
            continue
        j = i + 1
        while True:
            ref, after = _read_table_ref(tokens, j)
            if ref and ref.name.lower() not in ctes:
                acc = Access('read', ref, depth=t.depth)
                reads.append(acc)
                for k in (ref.alias, ref.name):
                    if k:
                        by_alias.setdefault(k.lower(), acc)
            j = max(after, j + 1) if ref else j
            # "FROM a, b" is a join written the old way.
            if ref and j < n and tokens[j].kind == 'punct' and tokens[j].text == ',' and tokens[j].depth == t.depth:
                j += 1
                continue
            break
        i = max(j, i + 1)

    _attribute_columns(tokens, reads, by_alias, consumed)

    out: list[Access] = [r for r in reads]
    if write:
        out.append(write)
    return out


def _scope(reads: list[Access], depth: int) -> list[Access]:
    """
    The tables a bare column at this parenthesis depth could belong to: the
    innermost ones in scope. In "SELECT title FROM books WHERE id IN (SELECT
    book_id FROM order_items ...)" that puts title on books and book_id on
    order_items, which is what a reader would have done.
    """
    candidates = [r for r in reads if r.depth <= depth]
    if not candidates:
        return []
    best = max(r.depth for r in candidates)
    return [r for r in candidates if r.depth == best]


def _attribute_columns(
    tokens: list[Token],
    reads: list[Access],
    by_alias: dict[str, Access],
    consumed: set[int],
) -> None:
    """
    Hand every column the statement mentions to the table it belongs to.

    Qualified ones (o.status) say which table themselves. Bare ones go to the
    only table in scope, if there is only one; otherwise they are held as
    "maybe" and settled later against the real schema, which is the only thing
    that actually knows which of three joined tables has a "created_at".
    """
    n = len(tokens)
    in_source = False
    i = 0
    while i < n:
        t = tokens[i]
        nxt = tokens[i + 1] if i + 1 < n else None
        prev = tokens[i - 1] if i else None
        if t.kind == 'word':
            w = t.word
            if w in ('FROM', 'JOIN', 'UPDATE', 'INTO'):
                in_source = True
            elif w in ('WHERE', 'SELECT', 'SET', 'ON', 'GROUP', 'ORDER', 'HAVING', 'VALUES',
                       'RETURNING', 'LIMIT', 'WINDOW', 'USING', 'AND', 'OR'):
                in_source = False
            if w == 'AS':               # the alias that follows names nothing in a table
                i += 2
                continue
        if t.kind == 'punct' and t.text == '*' and not in_source:
            # "SELECT *" and "SELECT a, *" are the whole row. "count(*)" is not,
            # and "o.*" belongs to o, which the qualified branch below handles.
            if prev is None or prev.text in (',',) or (prev.kind == 'word' and prev.word in ('SELECT', 'DISTINCT')):
                for r in _scope(reads, t.depth):
                    r.whole_row = True
        if t.kind == 'word' and t.word not in SQL_KEYWORDS and not in_source and i not in consumed:
            if prev and prev.kind == 'punct' and prev.text == '.':
                i += 1                   # the tail of a qualified name, already taken
                continue
            if nxt and nxt.kind == 'punct' and nxt.text == '(':
                i += 1                   # a function call, not a column
                continue
            if nxt and nxt.kind == 'punct' and nxt.text == '.':
                owner = by_alias.get(t.text.lower())
                after = tokens[i + 2] if i + 2 < n else None
                if after and after.kind == 'punct' and after.text == '*':
                    if owner:
                        owner.whole_row = True
                    i += 3
                    continue
                if after and after.kind == 'word':
                    if owner:
                        _add(owner.columns, after.text)
                    i += 3
                    continue
                i += 2
                continue
            scope = _scope(reads, t.depth)
            if len(scope) == 1:
                _add(scope[0].columns, t.text)
            else:
                for r in scope:
                    _add(r.maybe, t.text)
        i += 1


def _add(seq: list[str], name: str) -> None:
    if not any(x.lower() == name.lower() for x in seq):
        seq.append(name)


def split_sql_text(text: str) -> list[str]:
    """
    A string of SQL as its statements, kept as written.

    Splitting on the raw text rather than on tokens is what lets each step carry
    the statement the way the author typed it — the line breaks and the
    indentation included — instead of a reassembled one.
    """
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "'\"`":
            j = i + 1
            while j < n:
                if text[j] == ch:
                    if j + 1 < n and text[j + 1] == ch:
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            buf.append(text[i:j])
            i = j
            continue
        if text.startswith('--', i):
            j = text.find('\n', i)
            j = n if j < 0 else j
            buf.append(text[i:j])
            i = j
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i)
            j = n if j < 0 else j + 2
            buf.append(text[i:j])
            i = j
            continue
        if ch == ';':
            out.append(''.join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    out.append(''.join(buf))
    return [s for s in (part.strip() for part in out) if s]


def read_sql(text: str) -> list[tuple[str, list[Access]]]:
    """
    Every statement in a string of SQL, paired with the tables it touches.

    The statement text comes back with it because that is the part of a step
    nobody can reconstruct: the diagram can re-derive which arrow a read draws,
    but not the query that made it.
    """
    out: list[tuple[str, list[Access]]] = []
    for stmt in split_sql_text(text):
        out.append((stmt, read_statement(tokenize(stmt))))
    return out


# ---------------------------------------------------------------------------
# The map: nodes, steps and where they came from
# ---------------------------------------------------------------------------

# Decorators that say nothing about how a function is reached. Anything else —
# a route, a task, a signal handler — is exactly the answer to "nothing calls
# this function", so it is worth carrying into the node's comment.
DULL_DECORATORS = {
    'staticmethod', 'classmethod', 'property', 'abstractmethod', 'abstractproperty',
    'override', 'overload', 'cached_property', 'setter', 'getter', 'deleter',
    'functools.wraps', 'functools.cache', 'functools.lru_cache', 'contextlib.contextmanager',
    'dataclass', 'dataclasses.dataclass',
}

# Method names on a cursor or a connection. They never resolve to a node in the
# map, but the guess-by-name fallback would happily invent a call to a function
# of the same name in some other file, so it is told not to try.
DRIVER_METHODS = {
    'execute', 'executemany', 'executescript', 'fetchone', 'fetchall', 'fetchmany',
    'commit', 'rollback', 'close', 'cursor', 'connect', 'begin', 'mogrify', 'scalar',
    'append', 'get', 'set', 'add', 'update', 'items', 'keys', 'values', 'join', 'format',
}


@dataclass
class Step:
    """A step before it has ids: it still names things the way the code did."""
    op: str
    order: tuple[int, int]
    access: Optional[Access] = None
    sql: Optional[str] = None
    note: Optional[str] = None
    # A call, import or extends before resolution: the dotted expression as
    # written, plus the module it was written in, which is what gives the name
    # its meaning.
    ref: Optional[str] = None
    target: Optional['Node'] = None


@dataclass(eq=False)
class Node:
    kind: str
    name: str
    parent: Optional['Node'] = None
    children: list['Node'] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    entrypoint: Optional[str] = None
    comment: Optional[str] = None
    module: Optional['ModuleInfo'] = None
    lineno: int = 0
    node_id: str = ''
    position: tuple[float, float] = (0.0, 0.0)

    @property
    def path(self) -> str:
        parts: list[str] = []
        n: Optional[Node] = self
        while n is not None:
            parts.append(n.name)
            n = n.parent
        return '/'.join(reversed(parts))

    def descendants(self) -> Iterator['Node']:
        for c in self.children:
            yield c
            yield from c.descendants()

    def ancestors(self) -> Iterator['Node']:
        n = self.parent
        while n is not None:
            yield n
            n = n.parent


@dataclass
class Sym:
    """What a name in a file's namespace was imported from."""
    module: str
    attr: Optional[str] = None


@dataclass
class ModuleInfo:
    """A scanned file: its node, its dotted name and the names it can see."""
    node: Node
    dotted: str
    is_package: bool
    symbols: dict[str, Sym] = field(default_factory=dict)
    # Constants holding SQL: name -> the statement. A query parked at the top of
    # a file is run by whatever names it, not by the file.
    queries: dict[str, str] = field(default_factory=dict)
    # (module imported from, names taken out of it, where it was written)
    imports: list[tuple[str, list[str], tuple[int, int]]] = field(default_factory=list)


def summary(doc: Optional[str]) -> Optional[str]:
    """
    A docstring as the one-line comment a node carries.

    Python already has the field the format wants — what this is for, written by
    the person who wrote the code — so the scanner does not invent prose, it
    quotes it. The first paragraph is the summary by every convention there is.
    """
    if not doc:
        return None
    para = doc.strip().split('\n\n')[0]
    text = ' '.join(part.strip() for part in para.split('\n') if part.strip())
    if len(text) > 400:
        text = text[:397].rstrip() + '...'
    return text or None


def dotted_of(expr: ast.AST) -> Optional[str]:
    """"a.b.c" for the parts of an expression that are plain names and attributes."""
    parts: list[str] = []
    cur: ast.AST = expr
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return '.'.join(reversed(parts))
    return None


def signature(fn: ast.AST) -> str:
    """"def place_order(self, email, cart) -> int", from the syntax rather than the source."""
    clone = copy.copy(fn)
    clone.body = [ast.Expr(value=ast.Constant(value=Ellipsis))]
    clone.decorator_list = []
    try:
        text = ast.unparse(ast.fix_missing_locations(clone))
    except Exception:
        return f'def {getattr(fn, "name", "?")}(...)'
    head = text.split('\n', 1)[0].rstrip()
    return head[:-1] if head.endswith(':') else head


def class_signature(cls: ast.ClassDef) -> str:
    bases = [dotted_of(b) or ast.unparse(b) for b in cls.bases]
    bases += [f'{kw.arg}={ast.unparse(kw.value)}' for kw in cls.keywords if kw.arg]
    return f'class {cls.name}({", ".join(bases)})' if bases else f'class {cls.name}'


def string_value(expr: ast.AST) -> Optional[str]:
    """
    The text of a string expression, or None if it is not one.

    f-strings keep their holes as {expr}: a query with a table name substituted
    in cannot be read, and leaving the hole visible is how the map says so
    rather than guessing. Concatenated literals are folded, because a query
    split over three lines with + is still one query.
    """
    if isinstance(expr, ast.Constant):
        return expr.value if isinstance(expr.value, str) else None
    if isinstance(expr, ast.JoinedStr):
        out: list[str] = []
        for part in expr.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                out.append(part.value)
            elif isinstance(part, ast.FormattedValue):
                try:
                    out.append('{' + ast.unparse(part.value) + '}')
                except Exception:
                    out.append('{}')
            else:
                return None
        return ''.join(out)
    if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
        left = string_value(expr.left)
        right = string_value(expr.right)
        return None if left is None or right is None else left + right
    return None


# Directories that are never someone's own code, or never the code that talks
# to the database, and would only make the map longer.
DEFAULT_EXCLUDES = [
    '.*', '__pycache__', 'node_modules', 'venv', 'env', 'build', 'dist', 'site-packages',
    '*.egg-info', 'migrations', 'alembic',
]
TEST_DIRS = {'tests', 'test', 'testing'}
# Files whose presence says "this is where the program starts".
ENTRY_FILES = ['__main__.py', 'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py', 'cli.py', 'run.py']


class Scanner:
    """
    One pass over the source, then one over what it found.

    The two passes exist because a call may name a function in a file that has
    not been read yet, which is the same reason the SQL annotation block restores
    a code map in two passes: the names only mean something once every node
    exists.
    """

    def __init__(self, opts: argparse.Namespace) -> None:
        self.opts = opts
        self.programs: list[Node] = []
        self.modules: list[ModuleInfo] = []
        self.by_dotted: dict[str, ModuleInfo] = {}
        self.by_suffix: dict[str, list[ModuleInfo]] = {}
        self.notes: list[str] = []
        # Queries whose table is substituted in at run time: read, understood to
        # be a query, and impossible to point at anything.
        self.dynamic = 0

    def note(self, message: str) -> None:
        self.notes.append(message)

    # -- walking the tree ---------------------------------------------------

    def excluded(self, name: str) -> bool:
        if not self.opts.include_tests and name in TEST_DIRS:
            return True
        patterns = list(DEFAULT_EXCLUDES) + list(self.opts.exclude or [])
        return any(fnmatch.fnmatch(name, p) for p in patterns)

    def scan_root(self, root: Path, name: str) -> Node:
        program = Node(kind='program', name=name, lineno=0)
        program.comment = None
        self.programs.append(program)
        if root.is_file():
            self.scan_file(root, program, root.stem, program)
            program.entrypoint = _rel(root)
        else:
            # A root that is a package is a package: without its name in front,
            # "from . import inventory" at the top level counts from nothing.
            prefix = f'{root.name}.' if (root / '__init__.py').exists() else ''
            self.scan_dir(root, program, prefix, program)
            entry = next((f for f in ENTRY_FILES if (root / f).exists()), None)
            program.entrypoint = _rel(root / entry) if entry else _rel(root)
        return program

    def scan_dir(self, directory: Path, parent: Node, prefix: str, program: Node) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_dir(), p.name))
        except OSError as e:
            self.note(f'{directory}: {e}')
            return
        init = directory / '__init__.py'
        if init.exists() and prefix:
            # A package's __init__.py is the package, not a file inside it — at
            # the root, that package is the program node.
            self.scan_file(init, parent, prefix.rstrip('.'), program, own_node=parent)
        for entry in entries:
            if entry.is_dir():
                if self.excluded(entry.name):
                    continue
                if not any(entry.rglob('*.py')):
                    continue
                child = Node(kind='module', name=entry.name, parent=parent, lineno=0)
                child.entrypoint = _rel(entry)
                parent.children.append(child)
                self.scan_dir(entry, child, f'{prefix}{entry.name}.', program)
            elif entry.suffix == '.py':
                if entry.name == '__init__.py' and prefix:
                    continue
                if self.excluded(entry.name):
                    continue
                self.scan_file(entry, parent, f'{prefix}{entry.stem}', program)

    def scan_file(
        self,
        path: Path,
        parent: Node,
        dotted: str,
        program: Node,
        own_node: Optional[Node] = None,
    ) -> None:
        try:
            source = path.read_text(encoding='utf-8', errors='replace')
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as e:
            self.note(f'{_rel(path)}: could not be parsed ({e.msg} on line {e.lineno}); skipped.')
            return
        except OSError as e:
            self.note(f'{_rel(path)}: {e}')
            return

        node = own_node or Node(kind='module', name=path.name, parent=parent, lineno=0)
        if own_node is None:
            parent.children.append(node)
        node.entrypoint = _rel(path)
        node.comment = node.comment or summary(ast.get_docstring(tree))
        info = ModuleInfo(node=node, dotted=dotted, is_package=path.name == '__init__.py')
        node.module = info
        self.modules.append(info)
        self.by_dotted.setdefault(dotted, info)
        self.by_dotted.setdefault(f'{program.name}.{dotted}', info)
        parts = dotted.split('.')
        for i in range(len(parts)):
            self.by_suffix.setdefault('.'.join(parts[i:]), []).append(info)

        self.collect_imports(tree, info)
        self.walk_defs(tree.body, node, info, docstring=ast.get_docstring(tree) is not None)

    def collect_imports(self, tree: ast.AST, module: ModuleInfo) -> None:
        """
        What the file can see, and what it depends on.

        Both come off the same statements: the local name a symbol is bound to,
        which is how a call is resolved later, and the module it came from,
        which is the import step's arrow.
        """
        wanted: dict[str, tuple[list[str], tuple[int, int]]] = {}
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                for a in n.names:
                    if a.asname:
                        module.symbols[a.asname] = Sym(a.name)
                    else:
                        module.symbols[a.name] = Sym(a.name)
                        module.symbols[a.name.split('.')[0]] = Sym(a.name.split('.')[0])
                    wanted.setdefault(a.name, ([], (n.lineno, n.col_offset)))
            elif isinstance(n, ast.ImportFrom):
                base = self.relative_base(module, n.module, n.level)
                if not base:
                    continue
                names: list[str] = []
                for a in n.names:
                    if a.name == '*':
                        continue
                    module.symbols[a.asname or a.name] = Sym(base, a.name)
                    names.append(a.name)
                entry = wanted.setdefault(base, ([], (n.lineno, n.col_offset)))
                for name in names:
                    if name not in entry[0]:
                        entry[0].append(name)
        for target, (names, order) in wanted.items():
            module.imports.append((target, names, order))

    def relative_base(self, module: ModuleInfo, name: Optional[str], level: int) -> str:
        """The absolute module a "from . import x" is counting from."""
        if not level:
            return name or ''
        base = module.dotted if module.is_package else module.dotted.rsplit('.', 1)[0] if '.' in module.dotted else ''
        for _ in range(level - 1):
            base = base.rsplit('.', 1)[0] if '.' in base else ''
        if name and base:
            return f'{base}.{name}'
        return name or base

    def walk_defs(self, body: list[ast.stmt], owner: Node, module: ModuleInfo, docstring: bool = False) -> None:
        for i, st in enumerate(body):
            if docstring and i == 0 and isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant):
                continue
            named = self.named_query(st, module)
            if named:
                continue
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.make_function(st, owner, module)
            elif isinstance(st, ast.ClassDef):
                self.make_class(st, owner, module)
            else:
                self.collect(st, owner, module)

    def named_query(self, st: ast.stmt, module: ModuleInfo) -> bool:
        """
        SQL bound to a name at the top of a file or a class.

        The module does not run it — the function that names it does — so the
        text is put aside here and turned into a step wherever it is used. A
        constant nobody uses draws nothing, which is the right answer for one.
        """
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            name, value = st.targets[0].id, st.value
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.value is not None:
            name, value = st.target.id, st.value
        else:
            return False
        text = string_value(value)
        if text is None or not looks_like_sql(text):
            return False
        module.queries[name] = text
        return True

    def make_function(self, st: ast.AST, owner: Node, module: ModuleInfo) -> None:
        node = Node(kind='function', name=st.name, parent=owner, lineno=st.lineno, module=module)
        owner.children.append(node)
        prefix = 'async ' if isinstance(st, ast.AsyncFunctionDef) else ''
        node.entrypoint = prefix + signature(st)
        node.comment = summary(ast.get_docstring(st))
        marks = [d for d in (dotted_of(x) or _decorator_name(x) for x in st.decorator_list)
                 if d and d.split('.')[-1] not in DULL_DECORATORS and d not in DULL_DECORATORS]
        if marks:
            reached = 'Reached through ' + ', '.join('@' + m for m in marks[:3]) + '.'
            node.comment = f'{node.comment} {reached}' if node.comment else reached
        # A def inside a def is not a node — a function is the leaf of the map —
        # so its steps belong to the function that holds it.
        body = st.body[1:] if ast.get_docstring(st) else st.body
        for inner in body:
            self.collect(inner, node, module)

    def make_class(self, st: ast.ClassDef, owner: Node, module: ModuleInfo) -> None:
        node = Node(kind='class', name=st.name, parent=owner, lineno=st.lineno, module=module)
        owner.children.append(node)
        node.entrypoint = class_signature(st)
        node.comment = summary(ast.get_docstring(st))
        for base in st.bases:
            name = dotted_of(base)
            if name:
                node.steps.append(Step(op='extends', order=(st.lineno, st.col_offset), ref=name))
        self.walk_defs(st.body, node, module, docstring=ast.get_docstring(st) is not None)

    def collect(self, tree: ast.AST, owner: Node, module: ModuleInfo) -> None:
        """
        The statements of a node, as the steps they are: queries and calls.

        Strings are folded before they are read, so a query written as three
        concatenated literals is one step, and the pieces are not read again as
        three half-statements.
        """
        folded: set[int] = set()

        def visit(n: ast.AST) -> None:
            if id(n) not in folded and isinstance(n, (ast.Constant, ast.JoinedStr, ast.BinOp)):
                text = string_value(n)
                if text is not None:
                    for d in ast.walk(n):
                        if d is not n:
                            folded.add(id(d))
                    if looks_like_sql(text):
                        self.emit_sql(text, n, owner)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                self.emit_named_query(n.id, n, owner, module)
            elif isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in ('self', 'cls'):
                self.emit_named_query(n.attr, n, owner, module)
            if isinstance(n, ast.Call):
                name = dotted_of(n.func)
                if name:
                    owner.steps.append(Step(op='call', order=(n.lineno, n.col_offset), ref=name))
            for child in ast.iter_child_nodes(n):
                visit(child)

        visit(tree)

    def emit_named_query(self, name: str, at: ast.AST, owner: Node, module: ModuleInfo) -> None:
        """A reference to a query constant, here or in a file this one imported."""
        text = module.queries.get(name)
        if text is None:
            sym = module.symbols.get(name)
            if sym is not None and sym.attr:
                other = self.by_dotted.get(sym.module)
                text = other.queries.get(sym.attr) if other else None
        if text is not None:
            self.emit_sql(text, at, owner)

    def emit_sql(self, text: str, at: ast.AST, owner: Node) -> None:
        order = (getattr(at, 'lineno', 0), getattr(at, 'col_offset', 0))
        for statement, accesses in read_sql(text):
            if not accesses and '{' in statement:
                self.dynamic += 1
            for access in accesses:
                owner.steps.append(Step(op=access.op, order=order, access=access, sql=_tidy_sql(statement)))


def _decorator_name(expr: ast.AST) -> Optional[str]:
    if isinstance(expr, ast.Call):
        base = dotted_of(expr.func)
        if not base:
            return None
        args = [ast.unparse(a) for a in expr.args[:1]]
        return f'{base}({", ".join(args)})' if args else base
    return dotted_of(expr)


def _rel(path: Path) -> str:
    """Where the file is, said the shortest way that still points at it."""
    try:
        short = os.path.relpath(path)
    except ValueError:
        return str(path)
    return str(path) if short.startswith('..') else short


def _count(n: int, one: str, many: Optional[str] = None) -> str:
    return f'{n} {one}' if n == 1 else f'{n} {many or one + "s"}'



def _tidy_sql(text: str) -> str:
    """
    The statement as it was written, minus the indentation of the file it sat in.

    A query in a triple-quoted string carries the function's indentation into
    every line; keeping it would make the inspector show a query indented
    further the deeper in the code it was found.
    """
    lines = [ln.rstrip() for ln in text.strip().split('\n')]
    if len(lines) == 1:
        return re.sub(r'\s+', ' ', lines[0]).strip()
    indents = [len(ln) - len(ln.lstrip()) for ln in lines[1:] if ln.strip()]
    cut = min(indents) if indents else 0
    return '\n'.join([lines[0]] + [ln[cut:] if len(ln) >= cut else ln for ln in lines[1:]]).strip()


# ---------------------------------------------------------------------------
# Second pass: what the names meant
# ---------------------------------------------------------------------------


class Resolver:
    """
    Turns the names the code used into the nodes the map holds.

    Three things get resolved, in that order because each needs the one before
    it: imports (which module is that), inheritance (which class is that), and
    calls (which function is that — possibly one the class inherits).
    """

    def __init__(self, scan: Scanner) -> None:
        self.scan = scan
        self.nodes: list[Node] = [n for p in scan.programs for n in [p, *p.descendants()]]
        self.by_name: dict[str, list[Node]] = {}
        for n in self.nodes:
            if n.kind in ('function', 'class'):
                self.by_name.setdefault(n.name, []).append(n)

    # -- lookups ------------------------------------------------------------

    def module(self, dotted: str) -> Optional[Node]:
        info = self.scan.by_dotted.get(dotted)
        if info:
            return info.node
        same = self.scan.by_suffix.get(dotted)
        if same and len(same) == 1:
            return same[0].node
        return None

    def child(self, node: Node, name: str) -> Optional[Node]:
        for c in node.children:
            if c.name == name or (c.kind == 'module' and c.name == f'{name}.py'):
                return c
        return None

    def method(self, cls: Node, name: str, seen: Optional[set[int]] = None) -> Optional[Node]:
        """A method of this class or, failing that, of one it inherits from."""
        seen = seen if seen is not None else set()
        if id(cls) in seen:
            return None
        seen.add(id(cls))
        found = self.child(cls, name)
        if found:
            return found
        for step in cls.steps:
            if step.op == 'extends' and step.target is not None:
                inherited = self.method(step.target, name, seen)
                if inherited:
                    return inherited
        return None

    def descend(self, node: Optional[Node], rest: list[str]) -> Optional[Node]:
        for name in rest:
            if node is None:
                return None
            nxt = self.method(node, name) if node.kind == 'class' else self.child(node, name)
            if nxt is None and node.kind == 'module' and node.module is not None:
                nxt = self.module(f'{node.module.dotted}.{name}')
            node = nxt
        return node

    def symbol(self, sym: Sym) -> Optional[Node]:
        if sym.attr is None:
            return self.module(sym.module)
        owner = self.module(sym.module)
        if owner is not None:
            found = self.method(owner, sym.attr) if owner.kind == 'class' else self.child(owner, sym.attr)
            if found is not None:
                return found
        # "from package import module" names a module, not something in one.
        return self.module(f'{sym.module}.{sym.attr}')

    def expression(self, expr: str, owner: Node, guess: bool) -> Optional[Node]:
        """
        The node a dotted expression names, read the way Python would read it:
        self first, then the names the file imported, then the names it defines,
        and only then the map as a whole.
        """
        parts = expr.split('.')
        module = owner.module
        if parts[0] in ('self', 'cls') and len(parts) > 1:
            holder = next((a for a in [owner, *owner.ancestors()] if a.kind == 'class'), None)
            if holder is not None:
                found = self.descend(self.method(holder, parts[1]), parts[2:])
                if found is not None:
                    return found
        if module is not None:
            for k in range(len(parts), 0, -1):
                sym = module.symbols.get('.'.join(parts[:k]))
                if sym is None:
                    continue
                found = self.descend(self.symbol(sym), parts[k:])
                if found is not None:
                    return found
            local = self.child(module.node, parts[0])
            if local is not None:
                found = self.descend(local, parts[1:])
                if found is not None:
                    return found
        # A name the file never bound: a method on an object we cannot type, a
        # helper reached through a registry. The format's own rule for reading a
        # path applies — a bare name is enough when exactly one node carries it.
        if guess and parts[-1] not in DRIVER_METHODS:
            same = self.by_name.get(parts[-1], [])
            if len(same) == 1:
                return same[0]
        return None

    # -- the passes ---------------------------------------------------------

    def run(self) -> None:
        self.imports()
        for node in self.nodes:
            for step in node.steps:
                if step.op == 'extends':
                    step.target = self.expression(step.ref or '', node, guess=False)
                    if step.target is not None and step.target.kind != 'class':
                        step.target = None
        for node in self.nodes:
            for step in node.steps:
                if step.op == 'call':
                    step.target = self.expression(step.ref or '', node, guess=not self.scan.opts.strict_calls)
        for node in self.nodes:
            node.steps = [s for s in self.keep_steps(node)]

    def imports(self) -> None:
        for info in self.scan.modules:
            for base, names, order in info.imports:
                targets: dict[int, tuple[Node, list[str]]] = {}
                outer = self.module(base)
                for name in names:
                    sub = self.module(f'{base}.{name}')
                    if sub is not None:
                        targets.setdefault(id(sub), (sub, []))
                    elif outer is not None:
                        targets.setdefault(id(outer), (outer, []))[1].append(name)
                if not names and outer is not None:
                    targets.setdefault(id(outer), (outer, []))
                for target, taken in targets.values():
                    # An arrow from a file to the package it sits in says only
                    # what the nesting already says.
                    if target is info.node or any(a is target for a in info.node.ancestors()):
                        continue
                    note = 'for ' + ', '.join(taken[:4]) + ('…' if len(taken) > 4 else '') if taken else None
                    info.node.steps.append(Step(op='import', order=order, target=target, note=note))

    def keep_steps(self, node: Node) -> Iterator[Step]:
        """
        A node's steps in the order they run, each said once.

        A query inside a loop is one step, not one per iteration, and a function
        called three times is called: the map says what the code does, not how
        many times the source says it.
        """
        seen: set[tuple] = set()
        for step in sorted(node.steps, key=lambda s: s.order):
            if step.op in ('call', 'import', 'extends'):
                if step.target is None:
                    continue
                # The validator is right to refuse these: an arrow from a node
                # to itself draws nothing. Recursion is real, but it is not an
                # edge.
                if step.target is node:
                    continue
                key = (step.op, id(step.target))
            else:
                access = step.access
                key = (step.op, access.table.key.lower(), tuple(access.columns), step.sql) if access else (step.op, step.sql)
            if key in seen:
                continue
            seen.add(key)
            yield step


# ---------------------------------------------------------------------------
# What to keep
# ---------------------------------------------------------------------------


def prune(programs: list[Node], opts: argparse.Namespace) -> int:
    """
    Drop the code that has nothing to do with the database.

    A repository of any size has thousands of functions and a handful that run
    a query. Drawing all of them would answer no question the canvas is for —
    the code map exists to point at tables — so what stays is the functions that
    touch the database, the ones that call those (as far out as --callers), and
    the containers they sit in. --all keeps the lot.

    A call or an inheritance whose other end did not survive loses its arrow
    with it, which is the same bargain: a base class whose methods never touch
    the database is not part of the answer to what touches this table, and the
    one whose methods do is kept by the rule above without needing a special
    case.
    """
    nodes = [n for p in programs for n in [p, *p.descendants()]]
    if opts.all:
        keep = {id(n) for n in nodes}
    else:
        keep = {id(n) for n in nodes if any(s.op in ('read', 'write') for s in n.steps)}
        for _ in range(max(0, opts.callers)):
            ring = {id(n) for n in nodes
                    if id(n) not in keep
                    and any(s.op == 'call' and s.target is not None and id(s.target) in keep for s in n.steps)}
            if not ring:
                break
            keep |= ring
    final = set(keep)
    for n in nodes:
        if id(n) in keep:
            final.update(id(a) for a in n.ancestors())
    final.update(id(p) for p in programs)

    def filter_children(n: Node) -> None:
        n.children = [c for c in n.children if id(c) in final]
        for c in n.children:
            filter_children(c)

    for p in programs:
        filter_children(p)
    kept = [n for p in programs for n in [p, *p.descendants()]]
    for n in kept:
        n.steps = [s for s in n.steps if s.target is None or id(s.target) in final]
    return len(nodes) - len(kept)


# ---------------------------------------------------------------------------
# Ids, positions and the file
# ---------------------------------------------------------------------------

ID_PREFIX = {'program': 'prg_', 'module': 'mod_', 'class': 'cls_', 'function': 'fn_'}

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

COLOR_OF_KIND = {'program': 'pink', 'module': 'indigo', 'class': 'indigo', 'function': 'pink'}


def slug(text: str) -> str:
    out = re.sub(r'[^A-Za-z0-9]+', '_', text).strip('_')
    return out or 'x'


def assign_ids(programs: list[Node]) -> None:
    """
    A readable id per node, stable across scans of the same tree.

    Readable because the cross-references are meant to be reviewable in the
    file; stable because re-scanning a codebase should update the map rather
    than grow a second copy of it. The short form is used where it is free —
    "fn_place_order" — and lengthened towards the full path only where two
    nodes would otherwise collide.
    """
    taken: set[str] = set()
    for program in programs:
        for node in [program, *program.descendants()]:
            names = [n.name for n in reversed([node, *list(node.ancestors())])]
            for i in range(len(names) - 1, -1, -1):
                tail = names[i:]
                if tail and tail[-1].endswith('.py'):
                    tail = tail[:-1] + [tail[-1][:-3]]
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
                    _add(entry[1], name)
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
            entry['language'] = 'python'
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


# ---------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------

USAGE = """
  python3 scripts/scan_python.py services/api --into bookshop.dbviz.json -o mapped.dbviz.json
  python3 scripts/scan_python.py . --all --collapse module > map.dbviz.json
"""


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog='scan_python.py',
        description='Read a Python codebase into a Database Visualizer code map.',
        epilog=f'examples:{USAGE}',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('sources', nargs='+', metavar='SOURCE',
                    help='a package, a directory or a single .py file; one program per source.')
    ap.add_argument('--into', metavar='FILE',
                    help='the .dbviz.json to write the map into. Its tables are what the '
                         'steps point at, matched by name. Without it the scan writes a new '
                         'diagram whose tables are the ones the queries implied.')
    ap.add_argument('-o', '--out', metavar='FILE',
                    help='where to write (default: standard output). Pass the --into file to '
                         'update it in place.')
    ap.add_argument('--sheet', metavar='NAME', help='which diagram of a workspace file to write into.')
    ap.add_argument('--name', metavar='NAME', help='what to call the program (default: the source\'s name).')
    ap.add_argument('--role', choices=['service', 'job', 'script', 'etl'], help='what kind of program it is.')
    ap.add_argument('--dialect', default='postgresql', choices=['postgresql', 'mariadb', 'sqlite', 'duckdb'],
                    help='dialect for a diagram the scan creates (default: postgresql).')
    ap.add_argument('--all', action='store_true',
                    help='keep every function, not only the ones that reach the database.')
    ap.add_argument('--callers', type=int, default=1, metavar='N',
                    help='how many call hops away from a query to keep (default: 1).')
    ap.add_argument('--exclude', action='append', metavar='GLOB',
                    help='skip files and directories matching this, on top of the defaults. Repeatable.')
    ap.add_argument('--include-tests', action='store_true', help='scan tests/ as well.')
    ap.add_argument('--no-stub-tables', dest='stub_tables', action='store_false',
                    help='do not invent a table for SQL that names one the diagram has not got; '
                         'leave the step pointing at nothing, for Problems to report.')
    ap.add_argument('--collapse', action='append', choices=['program', 'module', 'class'], metavar='KIND',
                    help='fold containers of this kind on the canvas. Repeatable.')
    ap.add_argument('--relayout', action='store_true',
                    help='lay every node out afresh, discarding where an earlier scan or a person put it.')
    ap.add_argument('--strict-calls', action='store_true',
                    help='only draw a call the code names unambiguously; never guess from a unique name.')
    ap.add_argument('-q', '--quiet', action='store_true', help='report nothing but errors.')
    return ap.parse_args(argv)


def report_lines(report: Report, scan: Scanner, schema: Schema, dropped: int, opts: argparse.Namespace) -> list[str]:
    lines = [
        f'{_count(report.nodes, "node")} ({_count(report.functions, "function")}), '
        f'{_count(report.reads, "read")}, {_count(report.writes, "write")}, '
        f'{_count(report.calls, "call")}, {_count(report.imports, "import or inheritance", "imports and inheritances")}.'
    ]
    if dropped and not opts.all:
        lines.append(f'{_count(dropped, "node")} left out: nothing in them reaches the database. --all keeps them.')
    if scan.dynamic:
        lines.append(f'{_count(scan.dynamic, "query")} name a table that is built at run time, '
                     'so there is nothing to draw an arrow to; add those steps by hand.'
                     if scan.dynamic > 1 else
                     'one query names a table that is built at run time, so there is nothing to '
                     'draw an arrow to; add that step by hand.')
    if not report.reads and not report.writes:
        lines.append('No SQL found. The scanner reads string literals; an ORM builds its queries '
                     'somewhere this cannot see.')
    for key, count in sorted(report.missing_tables.items()):
        lines.append(f'"{key}" is not a table in the diagram; {_count(count, "step")} '
                     f'{"points" if count == 1 else "point"} at nothing.')
    missing = sorted(report.missing_columns.items())
    if missing:
        shown = ', '.join(f'{k} ({v})' for k, v in missing[:6])
        lines.append(f'columns named in SQL that their table has not got, left off the steps: {shown}'
                     + ('…' if len(missing) > 6 else ''))
    if schema.stubbed:
        names = ', '.join(sorted(schema.stubbed))
        them = 'it' if len(schema.stubbed) == 1 else 'them'
        lines.append(f'invented {_count(len(schema.stubbed), "table")} the code names but the diagram '
                     f'has not got: {names}. Check {them} before you keep {them}.')
    if scan.notes:
        lines.extend(scan.notes)
    return lines


def main(argv: Optional[list[str]] = None) -> int:
    opts = parse_args(argv)
    scan = Scanner(opts)

    used: set[str] = set()
    for source in opts.sources:
        root = Path(source)
        if not root.exists():
            raise SystemExit(f'{source}: no such file or directory.')
        name = opts.name if opts.name and len(opts.sources) == 1 else (root.stem if root.is_file() else root.name)
        name = name or 'program'
        base, n = name, 2
        while name in used:
            name, n = f'{base}_{n}', n + 1
        used.add(name)
        scan.scan_root(root, name)

    Resolver(scan).run()
    dropped = prune(scan.programs, opts)
    assign_ids(scan.programs)

    document, diagram = load_target(opts.into, opts.sheet, scan.programs[0].name, opts.dialect)
    previous = strip_previous(diagram, {p.name for p in scan.programs})
    layout(scan.programs, (0.0, 0.0))
    park_beside_schema(scan.programs, diagram)
    schema = Schema(diagram, stub=opts.stub_tables)
    entries, report = build_programs(scan.programs, schema, opts, previous)
    diagram.setdefault('programs', []).extend(entries)

    text = json.dumps(document, indent=2, ensure_ascii=False) + '\n'
    if opts.out:
        Path(opts.out).write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text)
    if not opts.quiet:
        headline, *rest = report_lines(report, scan, schema, dropped, opts)
        print(f'{opts.out or "standard output"}: {headline}', file=sys.stderr)
        for line in rest:
            print(f'  {line}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
