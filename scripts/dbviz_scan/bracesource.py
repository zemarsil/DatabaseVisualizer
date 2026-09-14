"""
The front end for every language but Python: Rust, Go, C, C++, Java,
JavaScript, TypeScript, Perl and the shell.

Nine languages, one reader, because the differences between them are smaller
than they look from inside any one of them. Every one of these declares a
function and then a block, brings in other files by name near the top, and
writes its queries as string literals. What changes is the spelling: `fn` or
`func` or `function` or `sub` or nothing at all, `::` or `.` or `->`, `impl
Trait for Type` or `class X extends Y` or `use parent`. So the shapes live in
the table at the top of this file and the walk below is shared.

The shell is the one that stretches the name: its blocks are `then … fi` and
`do … done` rather than braces, and it has no nesting worth the word. What it
does have is a function that opens with `name() {` and closes with `}`, which
is all the walk actually needs, and a call that is a bare word — read only when
the word names a function this same file defines, since otherwise every `echo`
in the script would invent one.

The walk is a block walk, not a parse. It keeps the tokens since the last
`;`, `{` or `}` — the *header* — and when a `{` arrives it asks what that header
declared. Inside a function body it stops asking: a function is the leaf of the
map, so a closure, a match arm and an `if` block are all just more of the
function that holds them, and their queries and calls belong to it. That is the
same rule the Python reader follows for a `def` inside a `def`, arrived at from
the other direction.

Three things it will not see, said plainly because the map is only worth having
if its gaps are known: a query an ORM or a query builder assembles (there is no
string literal to read), a call made through a function pointer or an interface
whose implementation is chosen at run time (the syntax names no function), and a
name a macro invented. All three are holes to fill in by hand, and the report
says how many of the first kind it noticed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .lexer import Lexer, Tok
from .model import DRIVER_METHODS, ModuleInfo, Node, Step, Sym, reached_through, summary
from .reader import SourceReader

# ---------------------------------------------------------------------------
# What each language spells differently
# ---------------------------------------------------------------------------

#: Words that make the block after them a plain block rather than a declaration.
CONTROL = {
    'rust': {'if', 'else', 'for', 'while', 'loop', 'match', 'unsafe', 'extern', 'move', 'return'},
    'go': {'if', 'else', 'for', 'switch', 'select', 'range', 'go', 'defer', 'return', 'case', 'default'},
    'java': {'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'synchronized',
             'return', 'new', 'case', 'default', 'instanceof', 'throw', 'assert'},
    'c': {'if', 'else', 'for', 'while', 'do', 'switch', 'return', 'case', 'default', 'sizeof', 'goto'},
    'cpp': {'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'return', 'case', 'default',
            'sizeof', 'new', 'delete', 'throw', 'goto', 'co_await', 'co_return'},
    'javascript': {'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'return',
                   'new', 'case', 'default', 'with', 'throw', 'await', 'yield'},
    'perl': {'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'foreach', 'do', 'eval', 'given',
             'when', 'return', 'last', 'next', 'redo', 'my', 'our', 'local'},
    'shell': {'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
              'select', 'in', 'return', 'time'},
}
CONTROL['typescript'] = CONTROL['javascript']

#: Keyword -> the kind of node the block after it is. `mod` and `namespace` hold
#: classes and functions both, which is what a module is.
CONTAINERS = {
    'rust': {'struct': 'class', 'enum': 'class', 'trait': 'class', 'union': 'class', 'mod': 'module'},
    'go': {},
    'java': {'class': 'class', 'interface': 'class', 'enum': 'class', 'record': 'class'},
    'c': {},
    'cpp': {'class': 'class', 'struct': 'class', 'union': 'class', 'namespace': 'module'},
    'javascript': {'class': 'class'},
    'typescript': {'class': 'class', 'interface': 'class', 'enum': 'class', 'namespace': 'module', 'module': 'module'},
    # `package Orders { … }`. The commoner `package Orders;` has no block and
    # is read as the file's own name, in `declaration` below.
    'perl': {'package': 'class'},
    'shell': {},
}

#: The keyword that introduces a function, where there is one. The shell's is
#: optional — `name() { … }` is the commoner form — and `classify_shell` reads
#: that one off the parentheses.
FUNCTION_WORD = {'rust': 'fn', 'go': 'func', 'javascript': 'function', 'typescript': 'function',
                 'perl': 'sub', 'shell': 'function'}

#: Languages where an unqualified call inside a method is a method of the same
#: class. Java and C++ resolve it that way; JavaScript does not.
IMPLICIT_SELF = {'java', 'cpp'}

#: Languages whose names carry a sigil that is not part of the name: `$self`
#: and `$dbh` are `self` and `dbh` to everything downstream.
SIGIL_LANGS = {'perl', 'shell'}

#: What `use parent 'Base'` and `use base 'Base'` say: inheritance, written as
#: an import. Perl's only way of spelling `extends`.
PERL_PARENT_PRAGMAS = {'parent', 'base'}

#: Perl pragmas that bring in no module of this program's own.
PERL_PRAGMAS = {'strict', 'warnings', 'utf8', 'feature', 'lib', 'constant', 'vars', 'overload',
                'integer', 'bytes', 'open', 'if', 'version', 'diagnostics', 'sigtrap', 'subs'}

#: Words that may sit in front of a declaration without changing what it is.
MODIFIERS = {
    'pub', 'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'virtual',
    'override', 'sealed', 'async', 'const', 'constexpr', 'inline', 'extern', 'explicit', 'friend',
    'export', 'default', 'declare', 'readonly', 'get', 'set', 'unsafe', 'crate', 'mut', 'noexcept',
}


@dataclass
class Frame:
    """One open block: where its contents belong, and what it is."""
    node: Node
    kind: str
    in_function: bool
    class_node: Optional[Node] = None
    #: What `self` is spelled as in this method. Go picks the name per method
    #: (`func (r *Repo) Get()`), so a call on `r` is a call on the receiver.
    receiver: Optional[str] = None


class BraceReader(SourceReader):
    def __init__(self, scan, language: str) -> None:
        super().__init__(scan)
        self.language = language
        self.control = CONTROL.get(language, set())
        self.containers = CONTAINERS.get(language, {})
        self.fn_word = FUNCTION_WORD.get(language)
        # Go and the two JavaScripts end a statement at the end of a line, so
        # the walk has to as well or a file of constants reads as one statement.
        # Go and the two JavaScripts end a statement at the end of a line; the
        # shell does too, and far more strictly.
        self.asi = language in ('go', 'javascript', 'typescript', 'shell')

    # -- the walk -----------------------------------------------------------

    def read(self, path: Path, source: str, info: ModuleInfo) -> None:
        lex = Lexer(source, self.language)
        self.src = source
        self.docs = lex.docs
        self._module_node = info.node
        if lex.leading and not info.node.comment:
            info.node.comment = summary(lex.leading)
        self.walk(lex.tokens, info)

    def walk(self, toks: list[Tok], info: ModuleInfo) -> None:
        frames = [Frame(info.node, 'module', False)]
        header: list[Tok] = []
        i = 0
        n = len(toks)
        while i < n:
            t = toks[i]
            frame = frames[-1]
            if t.kind == 'directive':
                # `#include "orders.h"` is a statement of its own wherever it
                # stands, and is never part of the declaration under it.
                self.directive(t, info)
                i += 1
                continue
            if t.kind == 'punct' and t.text == '{':
                if not frame.in_function and _is_value_group(header, self.language):
                    # `import { save } from './orders.js'`, `use a::{b, c};`,
                    # `const x = { … }`: braces that hold a value, not a body.
                    # The statement carries on through them, and the frame is
                    # pushed anyway so the matching `}` has something to close.
                    header.append(t)
                    frames.append(Frame(frame.node, 'value', False, frame.class_node, frame.receiver))
                    i += 1
                    continue
                frames.append(self.open_block(header, t, frame, info))
                header = []
                i += 1
                continue
            if t.kind == 'punct' and t.text == '}':
                if frame.kind == 'value':
                    frames.pop()
                    header.append(t)
                    i += 1
                    continue
                # Go and JavaScript let the last statement of a block go
                # without a semicolon, and a Go interface body is nothing but
                # such statements.
                if header and not frame.in_function:
                    self.statement(header, frame, info)
                if len(frames) > 1:
                    frames.pop()
                header = []
                i += 1
                continue
            if t.kind == 'punct' and t.text == ';':
                if not frame.in_function:
                    self.statement(header, frame, info)
                header = []
                i += 1
                continue
            if frame.in_function:
                i = self.body_token(toks, i, frame, info)
                continue
            if self.asi and header and t.line > toks[i - 1].line and _ends_statement(toks[i - 1]) and _depth(header) == 0:
                self.statement(header, frame, info)
                header = []
            header.append(t)
            i += 1
        if header and not frames[-1].in_function:
            self.statement(header, frames[-1], info)

    # -- opening a block ----------------------------------------------------

    def open_block(self, header: list[Tok], brace: Tok, frame: Frame, info: ModuleInfo) -> Frame:
        """What the `{` just opened, and where the things inside it belong."""
        # Inside a function everything is the function: a closure, a match arm
        # and a loop body all do their work on its behalf.
        if frame.in_function:
            return Frame(frame.node, 'block', True, frame.class_node, frame.receiver)
        attrs = [t.text for t in header if t.kind == 'attr']
        ts = [t for t in header if t.kind not in ('attr', 'directive')]
        if not ts:
            return Frame(frame.node, 'block', False, frame.class_node)

        declared = self.classify(ts, frame)
        if declared is None:
            return Frame(frame.node, 'block', False, frame.class_node)
        kind, name, owner, extends, receiver = declared

        parent = owner or frame.node
        if kind in ('class', 'module'):
            node = self.container_node(kind, name, parent, ts, brace, info)
            for ref in extends:
                node.steps.append(Step(op='extends', order=ts[0].at, ref=self.normalise(ref)))
            return Frame(node, 'class' if kind == 'class' else 'module', False, node if kind == 'class' else frame.class_node)

        node = self.function_node(name, parent, ts, info)
        node.entrypoint = self.source_of(ts[0], brace)
        node.comment = node.comment or summary(self.docs.get(header[0].line) or self.docs.get(ts[0].line))
        reached = reached_through([_attr_name(a) for a in attrs])
        if reached:
            node.comment = f'{node.comment} {reached}' if node.comment else reached
        holder = owner if owner is not None and owner.kind == 'class' else frame.class_node
        return Frame(node, 'function', True, holder, receiver)

    def container_node(self, kind: str, name: str, parent: Node, ts: list[Tok], brace: Tok, info: ModuleInfo) -> Node:
        """
        The node for a class, a struct or a namespace, made once.

        Rust splits a type over `struct Order` and any number of `impl Order`
        blocks, Go over `type Repo struct` and its methods, C++ over a header's
        declaration and the file's definitions. All of them mean one class, so
        an existing node of the same name in the same place is reused rather
        than drawn twice.
        """
        for child in parent.children:
            if child.name == name and child.kind == kind:
                if not child.entrypoint:
                    child.entrypoint = self.source_of(ts[0], brace)
                return child
        node = Node(kind=kind, name=name, parent=parent, lineno=ts[0].line, module=info, language=self.language)
        parent.children.append(node)
        node.entrypoint = self.source_of(ts[0], brace)
        node.comment = summary(self.docs.get(ts[0].line))
        return node

    def classify(self, ts: list[Tok], frame: Frame):
        """
        `(kind, name, owner, extends, receiver)` for a header, or None when the
        block it opens is just a block.
        """
        words = [t.text for t in ts if t.kind == 'word']
        lang = self.language

        lead = next((w for w in words if w not in MODIFIERS), '')
        if lang == 'go':
            return self.classify_go(ts, words, frame)
        if lang == 'rust' and lead == 'impl':
            return self.classify_impl(ts)

        # A container keyword wins: `class Foo extends Bar`, `namespace ns`.
        for i, t in enumerate(ts):
            if t.kind != 'word' or t.text not in self.containers:
                continue
            if lang == 'cpp' and t.text in ('class', 'struct') and _has_top_paren(ts):
                break  # a function returning a `struct Foo`, not a declaration
            name = _word_after(ts, i)
            if not name:
                break
            return (self.containers[t.text], name, None, self.bases(ts), None)

        # `} else if (x) {`, `for (…) {`: a control word anywhere in a header
        # that is not a declaration keeps the block a block.
        if any(t.kind == 'word' and t.text in self.control for t in ts):
            if not (self.fn_word and self.fn_word in words):
                return None

        if self.fn_word and self.fn_word in words:
            at = words.index(self.fn_word)
            name = words[at + 1] if at + 1 < len(words) else None
            if not name:
                return None
            return ('function', name, None, [], None)

        if lang in ('javascript', 'typescript'):
            return self.classify_js(ts, words, frame)
        if lang == 'shell':
            return self.classify_shell(ts)
        if lang in ('java', 'c', 'cpp'):
            return self.classify_signature(ts, words, frame)
        return None

    def classify_shell(self, ts: list[Tok]):
        """
        `place_order() {`: a name, an empty pair of parentheses, a block.

        The shell's parentheses are always empty — arguments arrive as `$1` —
        so this shape is unambiguous, which is why it can be read off three
        tokens with no risk of taking a subshell for a declaration.
        """
        if len(ts) < 3:
            return None
        name, opener, closer = ts[-3], ts[-2], ts[-1]
        if name.kind != 'word' or opener.text != '(' or closer.text != ')':
            return None
        if name.text in self.control:
            return None
        return ('function', name.text, None, [], None)

    def classify_go(self, ts: list[Tok], words: list[str], frame: Frame):
        if words and words[0] == 'type' and len(words) > 1 and ('struct' in words or 'interface' in words):
            return ('class', words[1], None, [], None)
        if not words or words[0] != 'func':
            # `Get(id int64) (Row, error)` in an interface body is a method,
            # and Go writes those without the word `func`.
            if frame.kind == 'class' and _top_paren(ts) == 1 and ts[0].kind == 'word':
                return ('function', ts[0].text, None, [], None)
            return None
        if len(ts) > 1 and ts[1].kind == 'punct' and ts[1].text == '(':
            # A method: `func (r *Repo) Get(ctx) error {`.
            close = _match_paren(ts, 1)
            inside = [t.text for t in ts[2:close] if t.kind == 'word']
            name = _word_at(ts, close + 1)
            if not name or not inside:
                return None
            owner = self.find_class(inside[-1])
            receiver = inside[0] if len(inside) > 1 else None
            return ('function', name, owner, [], receiver)
        return ('function', words[1], None, [], None) if len(words) > 1 else None

    def classify_impl(self, ts: list[Tok]):
        """
        `impl Repo`, `impl<T> Repo<T>`, `impl fmt::Display for Order`.

        Read off the tokens rather than the words, because the generic
        parameters are words too and `impl<T> Repo<T>` would otherwise name a
        class called T.
        """
        at = next(i for i, t in enumerate(ts) if t.kind == 'word' and t.text == 'impl')
        at = _skip_generics(ts, at + 1)
        first, at = _type_path(ts, at)
        if at < len(ts) and ts[at].kind == 'word' and ts[at].text == 'for':
            target, _ = _type_path(ts, _skip_generics(ts, at + 1))
            if not target:
                return None
            return ('class', target, None, [first] if first else [], None)
        return ('class', first, None, [], None) if first else None

    def classify_js(self, ts: list[Tok], words: list[str], frame: Frame):
        # `const load = async (id) => {`, `export const load = () => {`
        if ts[-1].kind == 'punct' and ts[-1].text == '=>':
            for i, t in enumerate(ts):
                if t.kind == 'word' and t.text in ('const', 'let', 'var'):
                    name = _word_after(ts, i)
                    return ('function', name, None, [], None) if name else None
            return None
        # A method in a class body: `async place(order) {`, `get total() {`.
        if frame.kind == 'class':
            open_at = _top_paren(ts)
            if open_at is not None and open_at > 0 and ts[open_at - 1].kind == 'word':
                name = ts[open_at - 1].text
                return ('function', name, None, [], None) if name not in self.control else None
        return None

    def classify_signature(self, ts: list[Tok], words: list[str], frame: Frame):
        """
        The C, C++ and Java shape: a name, a parameter list, a block.

        Everything in front of the name is types and modifiers, which is exactly
        what the scanner does not need to understand — it needs the name, and
        `Repo::save` tells it whose method this is.
        """
        open_at = _top_paren(ts)
        if open_at is None or open_at == 0:
            return None
        before = ts[:open_at]
        if any(t.kind == 'punct' and t.text in ('=', '=>') for t in before):
            return None
        if before[-1].kind != 'word':
            return None
        name = before[-1].text
        if name in self.control or name in MODIFIERS:
            return None
        owner = None
        # `void Repo::save(...)`: a method defined outside its class.
        if len(before) >= 3 and before[-2].kind == 'punct' and before[-2].text == '::' and before[-3].kind == 'word':
            owner = self.find_class(before[-3].text)
            if owner is None:
                owner = self.container_node('class', before[-3].text, frame.node, before[-3:], ts[-1], frame.node.module)
        return ('function', name, owner, [], None)

    def bases(self, ts: list[Tok]) -> list[str]:
        """The types a class declaration says it is built on."""
        out: list[str] = []
        lang = self.language
        if lang in ('java', 'javascript', 'typescript'):
            for i, t in enumerate(ts):
                if t.kind == 'word' and t.text in ('extends', 'implements'):
                    for nxt in ts[i + 1:]:
                        if nxt.kind == 'word' and nxt.text in ('extends', 'implements'):
                            break
                        if nxt.kind == 'word':
                            out.append(nxt.text)
                        elif nxt.kind == 'punct' and nxt.text not in (',', '.', '::'):
                            break
        elif lang == 'cpp':
            colon = next((i for i, t in enumerate(ts) if t.kind == 'punct' and t.text == ':'), None)
            if colon is not None:
                for nxt in ts[colon + 1:]:
                    if nxt.kind == 'word' and nxt.text not in ('public', 'private', 'protected', 'virtual'):
                        out.append(nxt.text)
        # A name is a base class once; `extends Base<T>` names Base.
        return list(dict.fromkeys(out))[:4]

    def find_class(self, name: str) -> Optional[Node]:
        """A class of this name already made in the file being read."""
        node = getattr(self, '_module_node', None)
        if node is None:
            return None
        for child in node.descendants():
            if child.kind == 'class' and child.name == name:
                return child
        return None

    # -- statements outside a function --------------------------------------

    def statement(self, header: list[Tok], frame: Frame, info: ModuleInfo) -> None:
        ts = [t for t in header if t.kind != 'attr']
        if not ts:
            return
        if self.declaration(ts, info, frame):
            return
        if self.query_constant(ts, info):
            return
        if self.signature_only(ts, header, frame, info):
            return
        # Whatever is left is code that runs where it stands: a top-level query
        # in a script, a field set from a call. It belongs to the node holding it.
        self.scan_expression(ts, frame, info)

    def signature_only(self, ts: list[Tok], header: list[Tok], frame: Frame, info: ModuleInfo) -> bool:
        """
        A function declared without a body: a C prototype, a Java interface
        method, a Rust trait method, a pure virtual.

        It is a node — something else in the map implements or calls it — and it
        is emphatically not a call, which is what reading `restock(&self)` as an
        expression would make it.
        """
        declared = self.classify(ts, frame)
        if declared is None or declared[0] != 'function':
            return False
        _, name, owner, _, _ = declared
        parent = owner or frame.node
        node = self.function_node(name, parent, ts, info)
        if not node.entrypoint:
            node.entrypoint = ' '.join(self.src[ts[0].pos:ts[-1].end].split())
        node.comment = node.comment or summary(self.docs.get(header[0].line))
        return True

    def function_node(self, name: str, parent: Node, ts: list[Tok], info: ModuleInfo) -> Node:
        """
        The node for a function, made once however often it is declared.

        C declares a prototype in a header and the body in a source file, C++
        splits a class the same way, and an overload set is one name; all of
        them are one function as far as a map that points at tables is
        concerned.
        """
        for child in parent.children:
            if child.kind == 'function' and child.name == name:
                return child
        node = Node(kind='function', name=name, parent=parent, lineno=ts[0].line, module=info,
                    language=self.language)
        parent.children.append(node)
        return node

    def declaration(self, ts: list[Tok], info: ModuleInfo, frame: Optional[Frame] = None) -> bool:
        """An import, a module declaration or a package line. True when handled."""
        first = ts[0].text if ts[0].kind == 'word' else ''
        lang = self.language
        if lang == 'perl':
            return self.perl_declaration(ts, info, first, frame)
        if lang == 'shell':
            return self.shell_declaration(ts, info, first)
        if lang == 'java':
            if first == 'package':
                dotted = _dotted(ts[1:])
                if dotted:
                    info.dotted = f'{dotted}.{Path(info.node.name).stem}'
                return True
            if first == 'import':
                target = _dotted([t for t in ts[1:] if not (t.kind == 'word' and t.text == 'static')])
                if target:
                    tail = target.rsplit('.', 1)
                    if len(tail) == 2 and tail[1] != '*':
                        info.symbols[tail[1]] = Sym(tail[0], tail[1])
                        self.want(info, tail[0], [tail[1]], ts[0].at)
                    else:
                        self.want(info, tail[0], [], ts[0].at)
                return True
        if lang == 'rust':
            if first == 'mod':
                name = _word_at(ts, 1)
                if name:
                    info.symbols[name] = Sym(_sibling(info.dotted, name))
                    self.want(info, _sibling(info.dotted, name), [], ts[0].at)
                return True
            if first == 'use':
                for base, names in _rust_use(ts[1:]):
                    base = self.rust_base(base, info)
                    if names is None:
                        # `use crate::inventory::reserve_stock` may name a
                        # module or a function in one, and only the resolver can
                        # tell; it is given the pair and tries both.
                        base, _, leaf = base.rpartition('.')
                        names = [leaf] if base else []
                        if not base:
                            base = leaf
                    for name in names:
                        info.symbols[name] = Sym(base, name)
                    if not names:
                        info.symbols.setdefault(base.rsplit('.', 1)[-1], Sym(base))
                    self.want(info, base, names, ts[0].at)
                return True
        if lang == 'go':
            if first == 'package':
                return True
            if first == 'import':
                for t in ts[1:]:
                    if t.kind == 'string':
                        dotted = t.text.replace('/', '.')
                        info.symbols[dotted.rsplit('.', 1)[-1]] = Sym(dotted)
                        self.want(info, dotted, [], ts[0].at)
                return True
        if lang in ('javascript', 'typescript'):
            if first == 'import' or (first == 'export' and any(t.text == 'from' for t in ts if t.kind == 'word')):
                source = _import_source(ts)
                if source:
                    # `with`, `assert` and the words inside an import attribute
                    # are syntax rather than names the file took out of the file.
                    at = next((i for i, t in enumerate(ts) if t.kind == 'word' and t.text in ('with', 'assert')), len(ts))
                    names = [t.text for t in ts[1:at] if t.kind == 'word' and t.text not in ('from', 'as', 'type', 'import', 'export', 'default')]
                    self.bind(info, _module_path(source, info.dotted), names, ts[0].at)
                return True
            if any(t.kind == 'word' and t.text == 'require' for t in ts):
                source = next((t.text for t in ts if t.kind == 'string'), None)
                names = [t.text for t in ts if t.kind == 'word' and t.text not in ('const', 'let', 'var', 'require')]
                if source:
                    self.bind(info, _module_path(source, info.dotted), names, ts[0].at)
                return True
        return False

    def perl_declaration(self, ts: list[Tok], info: ModuleInfo, first: str, frame: Optional[Frame]) -> bool:
        """
        `package Orders;`, `use Bookshop::Inventory;`, `use parent 'Base';`.

        The package line is the file's own name, exactly as Java's is: a file
        called Orders.pm that says `package Bookshop::Orders` is reachable by
        both, and registering what it said is what makes a `use` elsewhere find
        it. `use parent` is Perl's spelling of inheritance — but only inside a
        `package … { }` block is there a class node for it to be about, so
        anywhere else it is read as what it also is, a dependency on that file.
        """
        if first == 'package':
            dotted = _perl_package(ts[1:])
            if dotted:
                info.dotted = dotted
            return True
        if first not in ('use', 'no', 'require'):
            return False
        name = _perl_package(ts[1:])
        if not name or name.split('.')[0] in PERL_PRAGMAS:
            return True
        if name in PERL_PARENT_PRAGMAS:
            # `use parent -norequire, 'Bookshop::Base'` — the bases are quoted.
            for t in ts:
                if t.kind != 'string':
                    continue
                base = t.text.replace('::', '.')
                if frame is not None and frame.class_node is not None:
                    frame.class_node.steps.append(Step(op='extends', order=ts[0].at, ref=base))
                else:
                    self.want(info, base, [], ts[0].at)
                    info.symbols.setdefault(base.rsplit('.', 1)[-1], Sym(base))
            return True
        # `use Bookshop::Inventory qw(reserve_stock);`
        names = _qw_names(ts)
        self.bind(info, name, names, ts[0].at)
        return True

    def shell_declaration(self, ts: list[Tok], info: ModuleInfo, first: str) -> bool:
        """
        `source lib/db.sh` and its one-character spelling, `. lib/db.sh`.

        A sourced file is the shell's whole import system: every function in it
        arrives at once, under its own name, which is why nothing but the file
        is bound here.
        """
        dot = ts[0].kind == 'punct' and ts[0].text == '.'
        if first != 'source' and not dot:
            return False
        if len(ts) < 2:
            return False
        raw = self.src[ts[1].pos:ts[-1].end]
        dotted = _shell_module(raw)
        if dotted:
            info.symbols.setdefault(dotted.rsplit('.', 1)[-1], Sym(dotted))
            self.want(info, dotted, [], ts[0].at)
        return True

    def directive(self, tok: Tok, info: ModuleInfo) -> None:
        """`#include "store/orders.h"`: C's import, quotes and all."""
        text = tok.text
        if not text.startswith('#include'):
            return
        rest = text[len('#include'):].strip()
        if not rest.startswith('"'):
            return  # <system header>: never this program's own code
        path = rest[1:rest.find('"', 1)] if rest.count('"') > 1 else rest.strip('"')
        dotted = path.rsplit('.', 1)[0].replace('/', '.')
        if dotted:
            info.symbols.setdefault(dotted.rsplit('.', 1)[-1], Sym(dotted))
            self.want(info, dotted, [], tok.at)

    def rust_base(self, base: str, info: ModuleInfo) -> str:
        """`crate::store::orders` and `super::orders` said as a plain dotted name."""
        parts = base.split('.')
        if parts and parts[0] in ('crate', 'self'):
            parts = parts[1:]
        while parts and parts[0] == 'super':
            parts = parts[1:]
        return '.'.join(parts)

    def bind(self, info: ModuleInfo, target: str, names: list[str], order: tuple[int, int]) -> None:
        for name in names:
            info.symbols[name] = Sym(target, name)
        if not names:
            info.symbols.setdefault(target.rsplit('.', 1)[-1], Sym(target))
        self.want(info, target, names, order)

    def want(self, info: ModuleInfo, target: str, names: list[str], order: tuple[int, int]) -> None:
        if not target:
            return
        for existing in info.imports:
            if existing[0] == target:
                for name in names:
                    if name not in existing[1]:
                        existing[1].append(name)
                return
        info.imports.append((target, list(names), order))

    def query_constant(self, ts: list[Tok], info: ModuleInfo) -> bool:
        """
        SQL bound to a name at the top of a file or a class.

        The file does not run it — whatever names it does — so the text is put
        aside here and becomes a step wherever it is used, exactly as a Python
        module-level constant does.
        """
        found = False
        for at, t in enumerate(ts):
            if not (t.kind == 'punct' and t.text == '='):
                continue
            text, _ = self.fold(ts, at + 1)
            if text is None or not self.maybe_sql(text):
                continue
            name = _declared_name(ts[:at])
            if name:
                self.record_query(info, name, text)
                found = True
        return found

    def scan_expression(self, ts: list[Tok], frame: Frame, info: ModuleInfo) -> None:
        i = 0
        while i < len(ts):
            i = self.body_token(ts, i, frame, info)

    # -- inside a function body ---------------------------------------------

    def body_token(self, toks: list[Tok], i: int, frame: Frame, info: ModuleInfo) -> int:
        t = toks[i]
        if t.kind == 'string':
            text, nxt = self.fold(toks, i)
            if text is not None:
                hole = _lone_hole(text)
                if hole and (hole in self.scan.query_names or hole in info.queries):
                    # `psql "$LOCK"` and `` db.query(`${LOCK}`) ``: a string
                    # that is nothing but one name is that name being used, and
                    # in the shell it is the only way to use one.
                    self.emit_named_query(hole, t.at, frame.node, info)
                elif self.maybe_sql(text):
                    self.emit_sql(text, t.at, frame.node)
                else:
                    # A string naming a YAML or JSON file is the code saying it
                    # reads one, which is the only thing a data file is here for.
                    self.emit_data_load(text, t.at, frame.node)
            return nxt
        if t.kind == 'word':
            after = toks[i + 1] if i + 1 < len(toks) else None
            if after is not None and after.kind == 'punct' and after.text == '(' and t.text not in self.control:
                before = toks[i - 1] if i else None
                fresh = before is not None and before.kind == 'word' and before.text == 'new'
                ref = self.name_chain(toks, i, frame, bare=fresh)
                if ref:
                    frame.node.steps.append(Step(op='call', order=t.at, ref=ref))
            elif self.language == 'shell' and _starts_command(toks, i) and t.text not in self.control and t.text not in DRIVER_METHODS:
                # A call in the shell is a word at the start of a command. Most
                # of them are `grep` and `psql`; the resolver keeps only the
                # ones that name a function the map actually holds.
                frame.node.steps.append(Step(op='call', order=t.at, ref=t.text))
            elif t.text in self.scan.query_names or t.text in info.queries:
                self.emit_named_query(t.text, t.at, frame.node, info)
        return i + 1

    def fold(self, toks: list[Tok], i: int) -> tuple[Optional[str], int]:
        """
        One string, however many literals the source spread it over.

        C writes a query as adjacent literals, Java and JavaScript join them
        with `+`, and all three mean one statement. A value joined in the middle
        — `"… FROM \"" + table + "\""` — is kept as `{}`, the same hole a
        template literal or an f-string leaves, because that is the whole of
        what the scanner knows about it and pretending otherwise would invent a
        table called `table`.

        Only C and C++ join two literals by writing them side by side. In the
        shell `psql "$DSN" <<SQL` is a command and its heredoc, and folding
        those two into one string would lose the query inside the second.
        """
        if i >= len(toks) or toks[i].kind != 'string':
            return None, i + 1
        parts = [toks[i].text]
        j = i + 1
        adjacent = self.language in ('c', 'cpp')
        while j < len(toks):
            t = toks[j]
            if t.kind == 'string':
                if not adjacent:
                    break
                parts.append(t.text)
                j += 1
                continue
            if t.kind == 'punct' and t.text == '+':
                if j + 1 < len(toks) and toks[j + 1].kind == 'string':
                    parts.append(toks[j + 1].text)
                    j += 2
                    continue
                parts.append('{}')
                j = self.skip_joined(toks, j + 1)
                continue
            break
        return ''.join(parts), j

    def skip_joined(self, toks: list[Tok], j: int) -> int:
        """Past the value glued into a string, to the `+` that joins the next piece."""
        depth = 0
        while j < len(toks):
            t = toks[j]
            if t.kind == 'punct':
                if t.text in ('(', '['):
                    depth += 1
                elif t.text in (')', ']'):
                    if depth == 0:
                        break
                    depth -= 1
                elif depth == 0 and t.text in (',', ';', '+', '}'):
                    break
            j += 1
        return j

    def name_chain(self, toks: list[Tok], i: int, frame: Frame, bare: bool = False) -> Optional[str]:
        """
        The dotted name of the thing being called, read backwards from its `(`.

        `self.repo.load`, whether the source wrote `self.repo.load()`,
        `this->repo.load()`, `r.repo.Load()` on a Go receiver named `r`, or
        `Repo::load(&self)`. The resolver only knows the one spelling, so the
        spellings are flattened here.
        """
        parts = [toks[i].text]
        j = i - 1
        while j >= 1:
            if toks[j].kind == 'punct' and toks[j].text in ('.', '::', '->') and toks[j - 1].kind == 'word':
                parts.append(toks[j - 1].text)
                j -= 2
                continue
            break
        parts.reverse()
        if self.language in SIGIL_LANGS:
            # `$self->repo->load` is `self.repo.load`: the sigil says what kind
            # of thing the variable is, not what it is called.
            parts = [p.lstrip('$@%&') for p in parts]
        if not parts[0]:
            return None
        if parts[0] in ('this', 'Self') or (frame.receiver and parts[0] == frame.receiver):
            parts[0] = 'self'
        elif len(parts) == 1 and not bare and frame.class_node is not None and self.language in IMPLICIT_SELF:
            # `save(row)` inside a method of `Repo` is `this->save(row)`, which
            # Java and C++ let you leave out and the resolver cannot.
            parts = ['self', parts[0]]
        name = '.'.join(parts)
        return name if name and not name.startswith('.') else None

    def normalise(self, ref: str) -> str:
        return ref.replace('::', '.').replace('->', '.')

    # -- odds and ends ------------------------------------------------------

    def source_of(self, first: Tok, brace: Tok) -> str:
        """
        A declaration exactly as written, on one line.

        Reconstructing it from tokens would lose the types; quoting the source
        keeps them, and collapsing the whitespace means a signature split over
        six lines arrives as one, which is what the node has room for.
        """
        text = ' '.join(self.src[first.pos:brace.pos].split())
        return text[:200].rstrip() if len(text) > 200 else text



#: What can sit in front of a `{` that opens a value rather than a body.
VALUE_BEFORE_PUNCT = {'=', '(', ',', ':', '[', '::', '?'}
#: And the words, per language. `const` belongs here for JavaScript, where
#: `const x = {…}` is an object, and emphatically not for C++, where a trailing
#: `const` is the last thing before a method's body.
VALUE_BEFORE_WORD = {
    # `with` and `assert` are the import attribute a JSON import carries:
    # `import rates from './rates.json' with { type: 'json' }`. Without them
    # here that brace opens a block and takes the import statement with it.
    'javascript': {'import', 'export', 'const', 'let', 'var', 'return', 'from', 'with', 'assert'},
    'rust': {'use', 'return'},
    'java': {'return'},
    'go': {'return'},
    'c': set(),
    'cpp': set(),
}
VALUE_BEFORE_WORD['typescript'] = VALUE_BEFORE_WORD['javascript']


def _is_value_group(header: list[Tok], language: str) -> bool:
    """
    Whether the `{` about to be read holds a value rather than a block.

    Told apart by what comes before it, which is all a lexer has: after `=`,
    `(` or `::` a brace is an object, a destructuring pattern or an import
    list; after a name or a `)` it is a body. A `{` with nothing in front of it
    at all is a bare block.
    """
    if not header:
        return False
    last = header[-1]
    if last.kind == 'punct':
        return last.text in VALUE_BEFORE_PUNCT
    return last.kind == 'word' and last.text in VALUE_BEFORE_WORD.get(language, set())


def _depth(header: list[Tok]) -> int:
    depth = 0
    for t in header:
        if t.kind == 'punct':
            if t.text in ('(', '['):
                depth += 1
            elif t.text in (')', ']'):
                depth -= 1
    return depth


def _ends_statement(t: Tok) -> bool:
    """Go's rule for inserting a semicolon, which JavaScript's is close enough to."""
    if t.kind in ('string', 'number', 'word'):
        return t.text not in ('return', 'go', 'defer', 'const', 'var', 'import', 'package', 'type', 'func')
    return t.kind == 'punct' and t.text in (')', ']', '}', '++', '--')


def _top_paren(ts: list[Tok]) -> Optional[int]:
    depth = 0
    for i, t in enumerate(ts):
        if t.kind != 'punct':
            continue
        if t.text == '(':
            if depth == 0:
                return i
            depth += 1
        elif t.text == ')':
            depth = max(0, depth - 1)
    return None


def _has_top_paren(ts: list[Tok]) -> bool:
    return _top_paren(ts) is not None


def _match_paren(ts: list[Tok], at: int) -> int:
    depth = 0
    for i in range(at, len(ts)):
        if ts[i].kind != 'punct':
            continue
        if ts[i].text == '(':
            depth += 1
        elif ts[i].text == ')':
            depth -= 1
            if depth == 0:
                return i
    return len(ts) - 1


def _word_after(ts: list[Tok], at: int) -> Optional[str]:
    for t in ts[at + 1:]:
        if t.kind == 'word':
            return t.text
        if t.kind == 'punct' and t.text not in ('*', '&'):
            return None
    return None


def _word_at(ts: list[Tok], at: int) -> Optional[str]:
    return ts[at].text if 0 <= at < len(ts) and ts[at].kind == 'word' else None


def _skip_generics(ts: list[Tok], at: int) -> int:
    """Past a `<…>` parameter list, if one starts here."""
    if at >= len(ts) or not (ts[at].kind == 'punct' and ts[at].text == '<'):
        return at
    depth = 0
    for i in range(at, len(ts)):
        if ts[i].kind != 'punct':
            continue
        if ts[i].text == '<':
            depth += 1
        elif ts[i].text == '>':
            depth -= 1
            if depth == 0:
                return i + 1
    return len(ts)


def _type_path(ts: list[Tok], at: int) -> tuple[Optional[str], int]:
    """`fmt::Display<T>` as `Display`, and where reading it stopped."""
    name = None
    i = at
    while i < len(ts):
        t = ts[i]
        if t.kind == 'word' and t.text in ('dyn', 'mut', 'impl'):
            i += 1
            continue
        if t.kind == 'word':
            name = t.text
            i += 1
            if i < len(ts) and ts[i].kind == 'punct' and ts[i].text == '::':
                i += 1
                continue
            i = _skip_generics(ts, i)
            break
        if t.kind == 'punct' and t.text in ('&', "'"):
            i += 1
            continue
        break
    return name, i


def _sibling(dotted: str, name: str) -> str:
    """`mod orders;` in `store/mod.rs` names `store::orders`, not `store::mod::orders`."""
    base, _, stem = dotted.rpartition('.')
    if stem in ('mod', 'lib', 'main'):
        return f'{base}.{name}' if base else name
    return f'{dotted}.{name}' if dotted else name


def _import_source(ts: list[Tok]) -> Optional[str]:
    """
    The file an import names: the string after `from`, or the only one there is.

    Not simply the last string in the statement, which an import attribute —
    `import rates from './rates.json' with { type: 'json' }` — would make
    `json`.
    """
    at = next((i for i, t in enumerate(ts) if t.kind == 'word' and t.text == 'from'), None)
    if at is not None:
        return next((t.text for t in ts[at + 1:] if t.kind == 'string'), None)
    return next((t.text for t in ts if t.kind == 'string'), None)


def _lone_hole(text: str) -> Optional[str]:
    """The name in a string that is nothing but one interpolated name."""
    m = re.fullmatch(r'\{(\w+)\}', text.strip())
    return m.group(1) if m else None


def _perl_package(ts: list[Tok]) -> str:
    """
    `Bookshop::Inventory` out of `use Bookshop::Inventory qw(reserve_stock);`.

    Not `_dotted`, which joins every word it meets: what follows a Perl module
    name is an import list rather than more of the name, so the name ends at
    the first word that is not preceded by a `::`.
    """
    out: list[str] = []
    want_sep = False
    for t in ts:
        if t.kind == 'word':
            if want_sep:
                break
            out.append(t.text)
            want_sep = True
            continue
        if t.kind == 'punct' and t.text in ('::', '.'):
            if not want_sep:
                break
            want_sep = False
            continue
        break
    return '.'.join(out)


def _qw_names(ts: list[Tok]) -> list[str]:
    """The names inside a `qw(reserve_stock restock)`, or a list of quoted ones."""
    out: list[str] = []
    for i, t in enumerate(ts):
        if t.kind == 'word' and t.text in ('qw', 'qw()'):
            for nxt in ts[i + 1:]:
                if nxt.kind == 'word':
                    out.append(nxt.text)
                elif nxt.kind == 'punct' and nxt.text == ')':
                    break
            break
        if t.kind == 'string' and t.text.isidentifier():
            out.append(t.text)
    return out


def _shell_module(raw: str) -> str:
    """
    The module a `source` names: "$(dirname "$0")/lib/db.sh" is `lib.db`.

    Only the path's tail is ever a file the scan has seen, and everything in
    front of it is the script working out where it is, so the tail is what is
    kept and the resolver matches it by suffix the way it does a Go import.
    """
    m = re.search(r'([\w.\-/]+)\.(?:sh|bash)\s*$', raw.strip().strip('"\''))
    if not m:
        return ''
    parts = [part for part in m.group(1).split('/') if part not in ('', '.', '..')]
    return '.'.join(parts)


def _starts_command(toks: list[Tok], i: int) -> bool:
    """Whether this token opens a command: the shell's answer to "is this a call"."""
    if i == 0:
        return True
    before = toks[i - 1]
    if before.kind == 'punct' and before.text in (';', '|', '&', '&&', '||', '(', ')', '{', '}'):
        return True
    return before.line < toks[i].line


def _dotted(ts: list[Tok]) -> str:
    out: list[str] = []
    for t in ts:
        if t.kind == 'word':
            out.append(t.text)
        elif t.kind == 'punct' and t.text == '*':
            out.append('*')
        elif not (t.kind == 'punct' and t.text in ('.', '::')):
            break
    return '.'.join(out)


def _declared_name(ts: list[Tok]) -> Optional[str]:
    """
    Which of the words in front of an `=` is the name being bound.

    `const READ: &str`, `var readJobs string`, `static const char *READ`,
    `private static final String READ`: the type comes before the name in some
    of these and after it in others, and the two markers that say which are a
    type annotation and a declaration keyword.
    """
    words = [t for t in ts if t.kind == 'word']
    if not words:
        return None
    colon = next((i for i, t in enumerate(ts) if t.kind == 'punct' and t.text == ':'), None)
    if colon is not None:
        before = [t.text for t in ts[:colon] if t.kind == 'word']
        if before:
            return before[-1]
    if words[0].text in ('var', 'let', 'const') and len(words) > 1:
        return words[1].text
    return words[-1].text


def _rust_use(ts: list[Tok]) -> list[tuple[str, Optional[list[str]]]]:
    """
    `use crate::store::{orders, books};` as the modules it names.

    A brace group is several imports of one prefix; anything else is one path,
    whose last segment may be a module or a name inside one — which the
    resolver is left to decide, since only it can see what exists.
    """
    prefix: list[str] = []
    for i, t in enumerate(ts):
        if t.kind == 'word':
            prefix.append(t.text)
        elif t.kind == 'punct' and t.text == '{':
            names = [x.text for x in ts[i + 1:] if x.kind == 'word']
            return [('.'.join(prefix), names)]
        elif t.kind == 'punct' and t.text not in ('::', '.'):
            break
    return [('.'.join(prefix), None)] if prefix else []


def _module_path(source: str, from_dotted: str) -> str:
    """`./orders.js` next to `api/main.ts` is `api.orders`."""
    text = source
    # `.json` belongs here too: importing one is how JavaScript reads a data
    # file, and the resolver turns that import into the read it really is.
    for suffix in ('.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.json'):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
            break
    if not text.startswith('.'):
        return text.replace('/', '.')
    here = from_dotted.rsplit('.', 1)[0] if '.' in from_dotted else ''
    parts = [p for p in text.split('/') if p not in ('', '.')]
    base = here.split('.') if here else []
    while parts and parts[0] == '..':
        parts.pop(0)
        if base:
            base.pop()
    if parts and parts[-1] == 'index':
        parts.pop()
    return '.'.join([p for p in base + parts if p])


def _attr_name(text: str) -> str:
    """`GetMapping("/orders")` and `get("/orders")` as one short phrase."""
    head = text.split('(')[0].strip()
    if '(' in text:
        inside = text[text.index('(') + 1:text.rindex(')')] if ')' in text else ''
        first = inside.split(',')[0].strip()
        if first:
            return f'{head}({first})'
    return head
