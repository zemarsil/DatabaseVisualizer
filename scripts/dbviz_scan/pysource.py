"""
The Python front end.

Python is the one language here the scanner does not have to guess at: the
standard library will parse it, so this reader works from a real syntax tree.
A `def` inside a string is not a function and a commented-out query is not a
step, for free.

The brace languages next door get a tolerant lexer instead, which is a weaker
tool — but the two end up producing the same thing, because everything above
this file talks about nodes and steps rather than about syntax.
"""

from __future__ import annotations

import ast
import copy
from pathlib import Path
from typing import Optional

from .model import ModuleInfo, Node, Step, Sym, reached_through, summary
from .reader import SourceReader


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


def decorator_name(expr: ast.AST) -> Optional[str]:
    if isinstance(expr, ast.Call):
        base = dotted_of(expr.func)
        if not base:
            return None
        args = [ast.unparse(a) for a in expr.args[:1]]
        return f'{base}({", ".join(args)})' if args else base
    return dotted_of(expr)


class PythonReader(SourceReader):
    language = 'python'

    def read(self, path: Path, source: str, info: ModuleInfo) -> None:
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as e:
            self.note(f'{info.node.entrypoint or path}: could not be parsed ({e.msg} on line {e.lineno}); skipped.')
            return
        node = info.node
        node.comment = node.comment or summary(ast.get_docstring(tree))
        self.collect_imports(tree, info)
        self.walk_defs(tree.body, node, info, docstring=ast.get_docstring(tree) is not None)

    # -- what the file can see ---------------------------------------------

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

    # -- the declarations ---------------------------------------------------

    def walk_defs(self, body: list[ast.stmt], owner: Node, module: ModuleInfo, docstring: bool = False) -> None:
        for i, st in enumerate(body):
            if docstring and i == 0 and isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant):
                continue
            if self.named_query(st, module):
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
        if text is None or not self.maybe_sql(text):
            return False
        self.record_query(module, name, text)
        return True

    def make_function(self, st: ast.AST, owner: Node, module: ModuleInfo) -> None:
        node = Node(kind='function', name=st.name, parent=owner, lineno=st.lineno, module=module,
                    language=self.language)
        owner.children.append(node)
        prefix = 'async ' if isinstance(st, ast.AsyncFunctionDef) else ''
        node.entrypoint = prefix + signature(st)
        node.comment = summary(ast.get_docstring(st))
        reached = reached_through([d for d in (decorator_name(x) for x in st.decorator_list) if d])
        if reached:
            node.comment = f'{node.comment} {reached}' if node.comment else reached
        # A def inside a def is not a node — a function is the leaf of the map —
        # so its steps belong to the function that holds it.
        body = st.body[1:] if ast.get_docstring(st) else st.body
        for inner in body:
            self.collect(inner, node, module)

    def make_class(self, st: ast.ClassDef, owner: Node, module: ModuleInfo) -> None:
        node = Node(kind='class', name=st.name, parent=owner, lineno=st.lineno, module=module,
                    language=self.language)
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
                    if self.maybe_sql(text):
                        self.emit_sql(text, _at(n), owner)
                    else:
                        self.emit_data_load(text, _at(n), owner)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                self.emit_named_query(n.id, _at(n), owner, module)
            elif isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in ('self', 'cls'):
                self.emit_named_query(n.attr, _at(n), owner, module)
            if isinstance(n, ast.Call):
                name = dotted_of(n.func)
                if name:
                    owner.steps.append(Step(op='call', order=_at(n), ref=name))
            for child in ast.iter_child_nodes(n):
                visit(child)

        visit(tree)


def _at(n: ast.AST) -> tuple[int, int]:
    return (getattr(n, 'lineno', 0), getattr(n, 'col_offset', 0))
