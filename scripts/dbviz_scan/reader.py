"""
What every front end has in common.

A front end's job is to turn one file into nodes and steps. The part that is
the same whatever the language — a string that turned out to be a query becomes
one step per statement in it, a name that refers to a query constant becomes
the same thing, and a query whose table is pasted in at run time is a hole to
report rather than an arrow to draw — lives here so the readers only have to
find the strings.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .model import DATA_SUFFIXES, ModuleInfo, Node, Step, tidy_sql
from .sqlread import has_hole, looks_like_sql, read_sql

if TYPE_CHECKING:  # pragma: no cover - import for types only
    from .scanner import Scanner


class SourceReader:
    """One language's reading of one file. Subclasses implement `read`."""

    #: The `ProgramLanguage` the nodes this reader makes are written in.
    language = 'other'

    def __init__(self, scan: 'Scanner') -> None:
        self.scan = scan

    def read(self, path, source: str, info: ModuleInfo) -> None:
        raise NotImplementedError

    # -- the shared half ----------------------------------------------------

    def note(self, message: str) -> None:
        self.scan.note(message)

    def emit_sql(self, text: str, order: tuple[int, int], owner: Node) -> None:
        """Every statement in a string, as the steps it is."""
        for statement, accesses in read_sql(text):
            if not accesses and has_hole(statement):
                self.scan.dynamic += 1
            for access in accesses:
                owner.steps.append(Step(op=access.op, order=order, access=access, sql=tidy_sql(statement)))

    def emit_data_load(self, text: str, order: tuple[int, int], owner: Node) -> bool:
        """
        A string naming a YAML or JSON file, as the step that reads it.

        The same move `emit_sql` makes and for the same reason: a string
        literal is the one place a file this program opens is written down in
        full. What it names may not be in the scan at all — a path to somewhere
        else on the machine, a template — and the resolver drops a load whose
        file it never saw, so nothing here has to decide that.
        """
        name = text.strip()
        if not name or '\n' in name or len(name) > 200:
            return False
        if not name.lower().endswith(DATA_SUFFIXES):
            return False
        owner.steps.append(Step(op='load', order=order, ref=name))
        return True

    def emit_named_query(self, name: str, order: tuple[int, int], owner: Node, module: ModuleInfo) -> None:
        """A reference to a query constant, here or in a file this one imported."""
        text = self.query_text(name, module)
        if text is not None:
            self.emit_sql(text, order, owner)

    def query_text(self, name: str, module: ModuleInfo) -> Optional[str]:
        text = module.queries.get(name)
        if text is not None:
            return text
        sym = module.symbols.get(name)
        if sym is not None and sym.attr:
            other = self.scan.by_dotted.get(sym.module)
            if other is not None:
                return other.queries.get(sym.attr)
        if sym is not None and sym.attr is None:
            other = self.scan.by_dotted.get(sym.module)
            if other is not None:
                return other.queries.get(name)
        # A constant a sibling file exported under the same name: the brace
        # languages import a symbol without always saying which file it came
        # from, and one unambiguous match is the format's own rule for a path.
        hits = self.scan.query_names.get(name) or []
        return hits[0].queries[name] if len(hits) == 1 else None

    def record_query(self, info: ModuleInfo, name: str, text: str) -> None:
        """A constant holding SQL, remembered here and named across the scan."""
        info.queries[name] = text
        self.scan.query_names.setdefault(name, []).append(info)

    def maybe_sql(self, text: str) -> bool:
        return looks_like_sql(text)
