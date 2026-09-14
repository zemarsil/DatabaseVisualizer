"""
The map as the scanner builds it: nodes, steps, and the languages it can read.

A `Node` is a program, a module, a class or a function — the four kinds the
code map format has — and a `Step` is one thing a node does, before ids exist:
it still names its table and its target the way the source did, because that is
all a single file can know. The second pass turns those names into nodes.

The language table below is what makes the rest of the scanner language-blind.
A front end says which files it reads, how it spells a comment, which words are
never a function, and how a name written in that language is normalised into
the dotted form the resolver understands — `self.repo.load`, whether the source
said `self.repo.load()`, `this.repo.load()` or `Repo::load(...)`. Everything
else is shared.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

from .sqlread import Access

# Decorators that say nothing about how a function is reached. Anything else —
# a route, a task, a signal handler — is exactly the answer to "nothing calls
# this function", so it is worth carrying into the node's comment.
DULL_DECORATORS = {
    'staticmethod', 'classmethod', 'property', 'abstractmethod', 'abstractproperty',
    'override', 'overload', 'cached_property', 'setter', 'getter', 'deleter',
    'functools.wraps', 'functools.cache', 'functools.lru_cache', 'contextlib.contextmanager',
    'dataclass', 'dataclasses.dataclass',
    # The brace languages' equivalents: annotations and attributes that mark a
    # declaration rather than saying who calls it.
    'Override', 'FunctionalInterface', 'SafeVarargs', 'SuppressWarnings', 'Deprecated',
    'Autowired', 'Inject', 'Nullable', 'NonNull', 'Test', 'BeforeEach', 'AfterEach',
    'derive', 'test', 'inline', 'allow', 'cfg', 'cfg_attr', 'must_use', 'repr', 'serde',
}

# Method names on a cursor or a connection. They never resolve to a node in the
# map, but the guess-by-name fallback would happily invent a call to a function
# of the same name in some other file, so it is told not to try.
DRIVER_METHODS = {
    'execute', 'executemany', 'executescript', 'fetchone', 'fetchall', 'fetchmany',
    'commit', 'rollback', 'close', 'cursor', 'connect', 'begin', 'mogrify', 'scalar',
    'append', 'get', 'set', 'add', 'update', 'items', 'keys', 'values', 'join', 'format',
    # The same list for the brace languages, where the driver call is the line
    # the scanner most often sees next to a query.
    'query', 'queryRow', 'Query', 'QueryRow', 'QueryRowContext', 'QueryContext', 'Exec',
    'ExecContext', 'Prepare', 'Scan', 'Next', 'Close', 'Err', 'Rows', 'Row', 'Begin',
    'Commit', 'Rollback', 'prepare', 'prepareStatement', 'executeQuery', 'executeUpdate',
    'setString', 'setInt', 'setObject', 'getString', 'getInt', 'getLong', 'next', 'bind',
    'fetch_all', 'fetch_one', 'fetch_optional', 'exec', 'all', 'run', 'push', 'println',
    'printf', 'sprintf', 'fprintf', 'malloc', 'free', 'strcmp', 'unwrap', 'expect',
    'to_string', 'into', 'clone', 'await', 'then', 'catch', 'map', 'filter', 'forEach',
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
    # The `ProgramLanguage` this node is written in. A program node holding
    # files of several languages takes the one most of them are in, which is
    # the honest answer to "what is this service written in".
    language: str = 'other'

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
    language: str = 'other'
    #: A directory rather than a file. Go, Rust and C all import the directory,
    #: so it is a thing a name can resolve to, but nobody read it.
    is_directory: bool = False
    symbols: dict[str, Sym] = field(default_factory=dict)
    # Constants holding SQL: name -> the statement. A query parked at the top of
    # a file is run by whatever names it, not by the file.
    queries: dict[str, str] = field(default_factory=dict)
    # (module imported from, names taken out of it, where it was written)
    imports: list[tuple[str, list[str], tuple[int, int]]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# The languages it reads
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Language:
    """
    One language the scanner can read, and the few facts that differ per
    language once the front end has done its work.
    """
    id: str
    label: str
    #: Suffixes that belong to this language, including the leading dot.
    suffixes: tuple[str, ...]
    #: Files whose presence says "this is where the program starts".
    entry_files: tuple[str, ...] = ()
    #: A package is a directory, so a call naming one means a function in some
    #: file inside it, not a file called that. True for Go, Rust and C.
    package_is_directory: bool = False
    #: Directory names that hold this language's dependencies, never its code.
    vendor_dirs: tuple[str, ...] = ()
    #: Suffixes that declare rather than define. A header and the source beside
    #: it are two halves of one module, and are read into one node.
    header_suffixes: tuple[str, ...] = ()


LANGUAGES: tuple[Language, ...] = (
    Language('python', 'Python', ('.py',),
             entry_files=('__main__.py', 'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py', 'cli.py', 'run.py'),
             vendor_dirs=('__pycache__', 'site-packages', 'venv', 'env', '.venv')),
    Language('rust', 'Rust', ('.rs',),
             entry_files=('main.rs', 'lib.rs'),
             package_is_directory=True, vendor_dirs=('target',)),
    Language('go', 'Go', ('.go',),
             entry_files=('main.go',),
             package_is_directory=True, vendor_dirs=('vendor',)),
    Language('java', 'Java', ('.java',), vendor_dirs=('target', 'build', '.gradle')),
    Language('typescript', 'TypeScript', ('.ts', '.tsx', '.mts', '.cts'),
             entry_files=('main.ts', 'index.ts', 'server.ts', 'app.ts'),
             vendor_dirs=('node_modules', 'dist', 'build')),
    Language('javascript', 'JavaScript', ('.js', '.jsx', '.mjs', '.cjs'),
             entry_files=('main.js', 'index.js', 'server.js', 'app.js'),
             vendor_dirs=('node_modules', 'dist', 'build')),
    Language('cpp', 'C++', ('.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.ipp'),
             entry_files=('main.cpp', 'main.cc'),
             package_is_directory=True, vendor_dirs=('build', 'cmake-build-debug'),
             header_suffixes=('.hpp', '.hh', '.hxx', '.ipp', '.h')),
    # C last of the two: a bare .h is claimed by C++ only when the tree has no
    # C in it at all, which `language_of` settles with the directory's mix.
    Language('c', 'C', ('.c', '.h'),
             entry_files=('main.c',),
             package_is_directory=True, vendor_dirs=('build',),
             header_suffixes=('.h',)),
)

LANGUAGE_BY_ID = {lang.id: lang for lang in LANGUAGES}

#: Suffix -> language, first one wins, which is why C++ is listed before C.
SUFFIXES: dict[str, Language] = {}
for _lang in LANGUAGES:
    for _suffix in _lang.suffixes:
        SUFFIXES.setdefault(_suffix, _lang)

#: Every suffix the scanner will open, for the "is there anything here" check.
ALL_SUFFIXES = tuple(SUFFIXES)


def language_of(path: Path, prefer: Optional[str] = None) -> Optional[Language]:
    """
    The language a file is written in, from its suffix.

    `.h` is the one real ambiguity — it is C's header and C++'s too — so a tree
    that holds any C++ at all reads its headers as C++, and `--lang` settles it
    outright when someone knows better.
    """
    suffix = path.suffix.lower()
    if prefer:
        chosen = LANGUAGE_BY_ID.get(prefer)
        if chosen and suffix in chosen.suffixes:
            return chosen
    if suffix == '.h' and prefer == 'cpp':
        return LANGUAGE_BY_ID['cpp']
    return SUFFIXES.get(suffix)


# Directories that are never someone's own code, or never the code that talks
# to the database, and would only make the map longer.
DEFAULT_EXCLUDES = ['.*', 'migrations', 'alembic', '__pycache__', '*.egg-info']
for _lang in LANGUAGES:
    DEFAULT_EXCLUDES.extend(_lang.vendor_dirs)
DEFAULT_EXCLUDES = sorted(set(DEFAULT_EXCLUDES))

TEST_DIRS = {'tests', 'test', 'testing', '__tests__', 'spec'}
# Filenames that are a language's own test convention rather than a directory.
TEST_FILE_PATTERNS = ['*_test.go', '*.test.ts', '*.test.js', '*.spec.ts', '*.spec.js', 'test_*.py', '*_test.py']


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------


def summary(doc: Optional[str]) -> Optional[str]:
    """
    A doc comment as the one-line comment a node carries.

    Every language here has the field the format wants — what this is for,
    written by the person who wrote the code — so the scanner does not invent
    prose, it quotes it. The first paragraph is the summary by every convention
    there is.
    """
    if not doc:
        return None
    para = doc.strip().split('\n\n')[0]
    text = ' '.join(part.strip() for part in para.split('\n') if part.strip())
    if len(text) > 400:
        text = text[:397].rstrip() + '...'
    return text or None


def slug(text: str) -> str:
    out = re.sub(r'[^A-Za-z0-9]+', '_', text).strip('_')
    return out or 'x'


def rel(path: Path) -> str:
    """Where the file is, said the shortest way that still points at it."""
    try:
        short = os.path.relpath(path)
    except ValueError:
        return str(path)
    return str(path) if short.startswith('..') else short


def count(n: int, one: str, many: Optional[str] = None) -> str:
    return f'{n} {one}' if n == 1 else f'{n} {many or one + "s"}'


def tidy_sql(text: str) -> str:
    """
    The statement as it was written, minus the indentation of the file it sat in.

    A query in a triple-quoted string, a Rust `r#"…"#` or a Java text block
    carries the function's indentation into every line; keeping it would make
    the inspector show a query indented further the deeper in the code it was
    found.
    """
    lines = [ln.rstrip() for ln in text.strip().split('\n')]
    if len(lines) == 1:
        return re.sub(r'\s+', ' ', lines[0]).strip()
    indents = [len(ln) - len(ln.lstrip()) for ln in lines[1:] if ln.strip()]
    cut = min(indents) if indents else 0
    return '\n'.join([lines[0]] + [ln[cut:] if len(ln) >= cut else ln for ln in lines[1:]]).strip()


def reached_through(marks: list[str]) -> Optional[str]:
    """
    The sentence a decorator, an annotation or an attribute is worth: it is the
    answer to "nothing calls this function", which is a thing Problems asks.
    """
    useful = [m for m in marks if m and m.split('(')[0].split('.')[-1].split('::')[-1] not in DULL_DECORATORS
              and m.split('(')[0] not in DULL_DECORATORS]
    if not useful:
        return None
    return 'Reached through ' + ', '.join('@' + m for m in useful[:3]) + '.'
