"""
Reading SQL out of source code.

Every front end ends up here: whatever the language, a query is a string
literal, and what the map wants to know about it is which tables it touches and
which of their columns. That question has nothing to do with the language the
string was written in, so it is answered once, here, and the readers above only
have to find the strings.

It is a tolerant reader, not a parser: it knows the clauses that name a table
(FROM, JOIN, INTO, UPDATE) and the ones that name a column, and anything it
cannot make sense of it leaves alone rather than guessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

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
                        add_name(owner.columns, after.text)
                    i += 3
                    continue
                i += 2
                continue
            scope = _scope(reads, t.depth)
            if len(scope) == 1:
                add_name(scope[0].columns, t.text)
            else:
                for r in scope:
                    add_name(r.maybe, t.text)
        i += 1


def add_name(seq: list[str], name: str) -> None:
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


#: What a value pasted into a statement before it ran looks like afterwards: an
#: f-string's hole, a Rust or Java format hole, a printf placeholder.
HOLE = re.compile(r'\{[^\']*\}|%[sdv]|\$\{')


def has_hole(statement: str) -> bool:
    """Whether a statement had something substituted into it before it ran."""
    return bool(HOLE.search(statement))


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
