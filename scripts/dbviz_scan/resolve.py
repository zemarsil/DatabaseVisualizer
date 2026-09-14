"""
Second pass: what the names the code used actually meant, and what to keep.

The first pass reads files and can only write down the names it saw — `save`,
`self.repo.load`, `store.Get`. Which node each of those is cannot be known
until every file has been read, which is why resolution is its own pass, the
same way the SQL annotation block restores a code map in two.

Pruning follows it because a call whose other end was dropped has to lose its
arrow with it, and that can only be decided once the arrows exist.
"""

from __future__ import annotations

import argparse
from typing import Iterator, Optional

from pathlib import Path

from .model import DRIVER_METHODS, Node, Step, Sym

#: Languages whose imports name a path rather than a module: Go's
#: "github.com/acme/api/store", C's "store/orders.h", a relative JavaScript
#: import. Only the tail of such a path is ever a module the scan has seen, so
#: only for these is a name allowed to match the end of what was asked for.
PATH_IMPORTS = {'go', 'c', 'cpp', 'javascript', 'typescript', 'rust'}

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

    def module(self, dotted: str, tails: bool = False) -> Optional[Node]:
        info = self.scan.by_dotted.get(dotted)
        if info:
            return info.node
        same = self.scan.by_suffix.get(dotted)
        if same and len(same) == 1:
            return same[0].node
        if tails:
            # "github.com/acme/api/store" is the store package with a
            # repository in front of it, and the scan only ever saw the tail.
            # The longest tail that names exactly one module wins; a tail that
            # names two is no answer at all and is left alone.
            parts = dotted.split('.')
            for i in range(1, len(parts)):
                found = self.module('.'.join(parts[i:]))
                if found is not None:
                    return found
        return None

    def child(self, node: Node, name: str) -> Optional[Node]:
        for c in node.children:
            if c.name == name or (c.kind == 'module' and Path(c.name).stem == name):
                return c
        # A package is a directory in Go, Rust and C, and which of its files
        # holds the function is not part of the name the caller wrote.
        if node.module is not None and node.module.is_directory:
            for c in node.children:
                if c.kind == 'module':
                    for grandchild in c.children:
                        if grandchild.name == name:
                            return grandchild
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

    def symbol(self, sym: Sym, tails: bool = False) -> Optional[Node]:
        if sym.attr is None:
            return self.module(sym.module, tails)
        owner = self.module(sym.module, tails)
        if owner is not None:
            found = self.method(owner, sym.attr) if owner.kind == 'class' else self.child(owner, sym.attr)
            if found is not None:
                return found
        # "from package import module" names a module, not something in one.
        return self.module(f'{sym.module}.{sym.attr}', tails)

    def expression(self, expr: str, owner: Node, guess: bool) -> Optional[Node]:
        """
        The node a dotted expression names, read the way Python would read it:
        self first, then the names the file imported, then the names it defines,
        and only then the map as a whole.
        """
        parts = expr.split('.')
        module = owner.module
        tails = (module.language if module else '') in PATH_IMPORTS
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
                found = self.descend(self.symbol(sym, tails), parts[k:])
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
            same = _innermost(self.by_name.get(parts[-1], []))
            if len(same) == 1:
                return same[0]
        return None

    # -- the passes ---------------------------------------------------------

    def run(self) -> None:
        self.imports()
        for node in self.nodes:
            for step in node.steps:
                if step.op == 'extends':
                    # A base class in the same package is named without an
                    # import in Java and without a `use` in Rust, so the guess
                    # the format allows for a path is allowed here too; the
                    # kind check below throws away anything that is not a class.
                    step.target = self.expression(step.ref or '', node, guess=not self.scan.opts.strict_calls)
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
            tails = info.language in PATH_IMPORTS
            for base, names, order in info.imports:
                targets: dict[int, tuple[Node, list[str]]] = {}
                outer = self.module(base, tails)
                for name in names:
                    sub = self.module(f'{base}.{name}', tails)
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


def _innermost(nodes: list[Node]) -> list[Node]:
    """
    Of several nodes sharing a name, the ones that actually are the thing.

    Two cases, both of them one thing written twice. `new OrderService(...)`
    names the class and its constructor: the constructor is what was called, so
    a node holding another candidate loses to the one it holds. And a C
    prototype in a header names the same function as the definition in the
    source beside it: the one with a body is the one that does the work.
    """
    if len(nodes) < 2:
        return nodes
    holders = {id(a) for n in nodes for a in n.ancestors()}
    inner = [n for n in nodes if id(n) not in holders] or nodes
    if len(inner) < 2:
        return inner
    bodied = [n for n in inner if n.steps or n.children]
    return bodied or inner


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
