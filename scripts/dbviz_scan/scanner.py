"""
Walking the source tree.

One program per source, a module per directory, a module per file, and the
file handed to whichever front end reads that language. Everything the front
ends need from each other — which module a dotted name refers to, what a file
imported, which queries a file parked in a constant — is registered here, in
one place, because a call in one file usually names a function in another and
neither reader can see both.
"""

from __future__ import annotations

import argparse
import fnmatch
from pathlib import Path
from typing import Optional

from .bracesource import BraceReader
from .model import (
    DATA_LANGUAGES,
    DEFAULT_EXCLUDES,
    LANGUAGE_BY_ID,
    TEST_DIRS,
    TEST_FILE_PATTERNS,
    Language,
    ModuleInfo,
    Node,
    language_of,
    rel,
)
from .pysource import PythonReader
from .reader import SourceReader


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
        # The YAML and JSON files found on the way, so a load step naming one
        # by its path has somewhere to look it up.
        self.data_nodes: list[Node] = []
        # Queries whose table is substituted in at run time: read, understood to
        # be a query, and impossible to point at anything.
        self.dynamic = 0
        # Languages actually read, so the report can say what it looked at.
        self.languages: dict[str, int] = {}
        self.readers: dict[str, SourceReader] = {'python': PythonReader(self)}
        self._seen_modules: set[int] = set()
        # Every name a constant holding SQL was bound to, anywhere in the scan,
        # so a body can tell a query constant from an ordinary variable without
        # asking every module about every word it holds.
        self.query_names: dict[str, list[ModuleInfo]] = {}
        self.wanted: Optional[str] = getattr(opts, 'lang', None)

    def note(self, message: str) -> None:
        self.notes.append(message)

    def reader_for(self, language: Language) -> SourceReader:
        found = self.readers.get(language.id)
        if found is None:
            # Everything that is not Python is a brace language, and one reader
            # serves them all: what differs between Rust and Java is a table of
            # keywords, not a different way of walking a file.
            found = BraceReader(self, language.id)
            self.readers[language.id] = found
        return found

    # -- walking the tree ---------------------------------------------------

    def excluded(self, name: str) -> bool:
        if not self.opts.include_tests and name in TEST_DIRS:
            return True
        patterns = list(DEFAULT_EXCLUDES) + list(self.opts.exclude or [])
        if not self.opts.include_tests:
            patterns += TEST_FILE_PATTERNS
        return any(fnmatch.fnmatch(name, p) for p in patterns)

    def language_for(self, path: Path) -> Optional[Language]:
        """The language of a file, or None when the scan should not open it."""
        found = language_of(path, self.wanted)
        if found is None:
            return None
        if self.wanted and found.id != self.wanted:
            return None
        return found

    def worth_entering(self, directory: Path) -> bool:
        """Whether a directory holds anything this scan would read."""
        for path in directory.rglob('*'):
            if path.is_file() and self.language_for(path) is not None:
                return True
        return False

    def scan_root(self, root: Path, name: str) -> Node:
        program = Node(kind='program', name=name, lineno=0)
        self.programs.append(program)
        if root.is_file():
            language = self.language_for(root)
            if language is None:
                raise SystemExit(f'{root}: the scanner has no reader for that file.')
            self.scan_file(root, program, root.stem, program, language)
            program.entrypoint = rel(root)
        else:
            # A root that is a Python package is a package: without its name in
            # front, "from . import inventory" at the top level counts from
            # nothing. No other language here counts a directory that way.
            prefix = f'{root.name}.' if (root / '__init__.py').exists() else ''
            self.scan_dir(root, program, prefix, program)
            program.entrypoint = rel(self.entry_file(root, program) or root)
        program.language = dominant_language(program)
        return program

    def entry_file(self, root: Path, program: Node) -> Optional[Path]:
        """The file that says "this is where the program starts", if there is one."""
        language = LANGUAGE_BY_ID.get(dominant_language(program))
        for candidate in (language.entry_files if language else ()):
            hit = root / candidate
            if hit.exists():
                return hit
            # Rust and Go bury theirs one level down, which is the convention
            # rather than an accident: src/main.rs, cmd/api/main.go.
            deeper = sorted(root.glob(f'*/{candidate}')) + sorted(root.glob(f'*/*/{candidate}'))
            if deeper:
                return deeper[0]
        return None

    def scan_dir(self, directory: Path, parent: Node, prefix: str, program: Node) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (p.is_dir(), p.name))
        except OSError as e:
            self.note(f'{directory}: {e}')
            return
        init = directory / '__init__.py'
        if init.exists() and prefix and self.language_for(init) is not None:
            # A package's __init__.py is the package, not a file inside it — at
            # the root, that package is the program node.
            self.scan_file(init, parent, prefix.rstrip('.'), program, LANGUAGE_BY_ID['python'], own_node=parent)
        pairs = self.paired_headers(entries)
        taken = set(pairs.values())
        for entry in entries:
            if self.excluded(entry.name):
                continue
            if entry in taken:
                continue
            if entry.is_dir():
                if not self.worth_entering(entry):
                    continue
                child = Node(kind='module', name=entry.name, parent=parent, lineno=0)
                child.entrypoint = rel(entry)
                parent.children.append(child)
                # A directory is a package in Go, Rust and C, where an import
                # names the directory and the function lives in some file in
                # it, so it is registered as something a name can resolve to.
                folder = ModuleInfo(node=child, dotted=f'{prefix}{entry.name}', is_package=True, is_directory=True)
                child.module = folder
                self.register(folder, program)
                self.scan_dir(entry, child, f'{prefix}{entry.name}.', program)
            elif entry.is_file():
                language = self.language_for(entry)
                if language is None:
                    continue
                if entry.name == '__init__.py' and prefix:
                    continue
                self.scan_file(entry, parent, f'{prefix}{entry.stem}', program, language,
                               also=pairs.get(entry))

    def paired_headers(self, entries: list[Path]) -> dict[Path, Path]:
        """
        Which header belongs to which source.

        In C and C++ `orders.h` and `orders.c` are one module written twice: the
        header declares what the source defines. Reading them into two nodes
        would draw every function twice and make every call to one of them
        ambiguous, so they are read into one — the header first, so its comments
        are kept and the source's signatures win.
        """
        out: dict[Path, Path] = {}
        files = [e for e in entries if e.is_file() and not self.excluded(e.name)]
        for source in files:
            language = self.language_for(source)
            if language is None or not language.header_suffixes:
                continue
            if source.suffix.lower() in language.header_suffixes:
                continue
            for header in files:
                if header.stem == source.stem and header.suffix.lower() in language.header_suffixes:
                    out[source] = header
                    break
        return out

    def scan_file(
        self,
        path: Path,
        parent: Node,
        dotted: str,
        program: Node,
        language: Language,
        own_node: Optional[Node] = None,
        also: Optional[Path] = None,
    ) -> None:
        # A data file is not read. Nothing runs in a YAML or JSON file, so
        # there are no queries in it and no calls out of it — it is a node
        # other code points at, and the file's own contents are its business.
        if language.data:
            node = Node(kind='data', name=path.name, parent=parent, lineno=0, language=language.id)
            parent.children.append(node)
            node.entrypoint = rel(path)
            info = ModuleInfo(node=node, dotted=dotted, is_package=False, language=language.id)
            node.module = info
            self.register(info, program)
            self.languages[language.id] = self.languages.get(language.id, 0) + 1
            self.data_nodes.append(node)
            return

        try:
            source = path.read_text(encoding='utf-8', errors='replace')
        except OSError as e:
            self.note(f'{rel(path)}: {e}')
            return

        node = own_node or Node(kind='module', name=path.name, parent=parent, lineno=0)
        if own_node is None:
            parent.children.append(node)
        node.entrypoint = rel(path)
        node.language = language.id
        info = ModuleInfo(node=node, dotted=dotted, is_package=path.name == '__init__.py', language=language.id)
        node.module = info
        self.register(info, program)
        self.languages[language.id] = self.languages.get(language.id, 0) + 1
        reader = self.reader_for(language)
        if also is not None and also != path:
            try:
                reader.read(also, also.read_text(encoding='utf-8', errors='replace'), info)
            except OSError as e:
                self.note(f'{rel(also)}: {e}')
        reader.read(path, source, info)
        # A front end may know better than the path does: Java's `package`
        # line, Go's `package`, a Rust `mod` path. Whatever it settled on is
        # registered too, so an import can find the file by either name.
        if info.dotted != dotted:
            self.register(info, program)

    def register(self, info: ModuleInfo, program: Node) -> None:
        if id(info) not in self._seen_modules:
            self._seen_modules.add(id(info))
            self.modules.append(info)
        dotted = info.dotted
        if not dotted:
            return
        self.by_dotted.setdefault(dotted, info)
        self.by_dotted.setdefault(f'{program.name}.{dotted}', info)
        parts = dotted.split('.')
        for i in range(len(parts)):
            bucket = self.by_suffix.setdefault('.'.join(parts[i:]), [])
            if not any(b is info for b in bucket):
                bucket.append(info)


def dominant_language(program: Node) -> str:
    """
    What a program is written in: whatever most of its files are.

    A service with forty Go files and a build script is a Go service, and the
    node says so; the files themselves keep their own language either way, so
    nothing is lost by the program node rounding. The data files do not get a
    vote: a program is not written in YAML however much of it there is.
    """
    counts: dict[str, int] = {}
    for node in program.descendants():
        if node.kind == 'module' and node.module is not None and not node.module.is_directory:
            counts[node.language] = counts.get(node.language, 0) + 1
    if not counts:
        return 'other'
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


def spread_language(program: Node) -> None:
    """
    Give every class and function the language of the file it sits in.

    The readers set it as they go; this catches the containers, which are made
    by the walk above rather than by a reader, and a directory node whose files
    turned out to be Go.
    """
    def visit(node: Node, inherited: str) -> None:
        # A file node already knows; a class or a function was given the
        # reader's language as it was made. Only the containers the walk built
        # are open, and they take whatever most of their members turned out to
        # be — which needs the members settled first, hence post-order.
        for child in node.children:
            visit(child, node.language if node.language != 'other' else inherited)
        if node.kind in ('class', 'function') or (node.module is not None and not node.module.is_directory):
            return
        # A directory of YAML is not a directory written in YAML: nothing runs
        # in a data language, so a container may never take one. A folder with
        # nothing but data files in it keeps whatever it inherited.
        kids = [c.language for c in node.children if c.language != 'other' and c.language not in DATA_LANGUAGES]
        node.language = max(set(kids), key=kids.count) if kids else inherited

    visit(program, program.language)
