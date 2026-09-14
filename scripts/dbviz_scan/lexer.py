"""
A tolerant lexer for the brace languages.

Python gets a real syntax tree because the standard library hands one over.
Rust, Go, C, C++, Java, JavaScript and TypeScript would each need a parser of
their own, which is not a thing to keep in a repository about drawing
databases — so they get this instead: something that knows comments, strings,
numbers, words and punctuation, and nothing else.

That is less than a parser and more than a regex, and the difference from a
regex is the point. A `SELECT` inside a comment is a comment, a brace inside a
string is not a brace, and `"INSERT INTO " + table` is one string with a hole in
it. Those three facts are what a grep over the source gets wrong, and they are
most of what reading code for queries needs.

What it deliberately does not do is decide what anything *means*. It hands the
reader above a flat list of tokens with their line, column and offset, and that
reader works out which of them declare a function.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

#: Punctuation that is one token rather than two, because the reader looks at
#: it: a path separator, a member access through a pointer, an arrow function.
DIGRAPHS = ('::', '->', '=>', '...', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', ':=')


@dataclass
class Tok:
    kind: str  # 'word' | 'string' | 'number' | 'punct' | 'attr' | 'directive'
    text: str  # a string's value, an attribute's contents, otherwise the spelling
    line: int
    col: int
    pos: int   # offset into the source, so a declaration's own text can be quoted back
    end: int = 0

    @property
    def at(self) -> tuple[int, int]:
        return (self.line, self.col)


class Lexer:
    """
    One file, lexed. `tokens` is everything that is not a comment; `docs` maps
    a line to the comment block that sits immediately above it, which is where
    every one of these languages writes what a declaration is for.
    """

    def __init__(self, source: str, language: str) -> None:
        self.src = source
        self.lang = language
        self.tokens: list[Tok] = []
        self.docs: dict[int, str] = {}
        self.i = 0
        self.line = 1
        self.line_start = 0
        #: A comment block at the top of the file that no declaration claimed:
        #: Rust's `//!`, or a header block with a blank line under it. That is
        #: what a file says about itself, as opposed to about its first function.
        self.leading: Optional[str] = None
        self._comment: Optional[tuple[list[str], int, int]] = None
        self._bang = False
        self._run()

    # -- helpers ------------------------------------------------------------

    def _col(self, pos: int) -> int:
        return pos - self.line_start

    def _advance_to(self, end: int) -> None:
        """Move to `end`, counting the lines crossed on the way."""
        chunk = self.src[self.i:end]
        crossed = chunk.count('\n')
        if crossed:
            self.line += crossed
            self.line_start = self.i + chunk.rfind('\n') + 1
        self.i = end

    def _emit(self, kind: str, text: str, start: int, end: int) -> None:
        tok = Tok(kind, text, self.line, self._col(start), start, end)
        # A comment block only counts as documentation for the line right under
        # it; anything further down was about something else.
        if self._comment is not None:
            lines, began, ended = self._comment
            if kind == 'directive':
                # An include guard is not what the comment above it was about.
                if self.leading is None and began <= 3:
                    self.leading = '\n'.join(lines)
                self._comment = None
                self._bang = False
                self._advance_to(end)
                self.tokens.append(tok)
                return
            if ended + 1 >= tok.line and not self._bang:
                self.docs.setdefault(tok.line, '\n'.join(lines))
            elif self.leading is None and began <= 3:
                self.leading = '\n'.join(lines)
            self._comment = None
            self._bang = False
        self._advance_to(end)
        self.tokens.append(tok)

    def _comment_block(self, text: str, begin_line: int, end_line: int) -> None:
        cleaned = clean_doc(text)
        if text.lstrip().startswith(('//!', '/*!')):
            self._bang = True
        if not cleaned:
            return
        if self._comment is not None and self._comment[2] + 1 >= begin_line:
            self._comment = (self._comment[0] + cleaned, self._comment[1], end_line)
        else:
            self._comment = (cleaned, begin_line, end_line)

    # -- the scan -----------------------------------------------------------

    def _run(self) -> None:
        src = self.src
        n = len(src)
        while self.i < n:
            ch = src[self.i]
            if ch in ' \t\r\n':
                self._advance_to(self.i + 1)
                continue
            start = self.i

            # Line comments, block comments, and C's preprocessor, which is
            # read as one token per line so a #define holding a brace cannot
            # throw the block structure off.
            if src.startswith('//', self.i):
                end = src.find('\n', self.i)
                end = n if end == -1 else end
                line = self.line
                text = src[self.i:end]
                self._advance_to(end)
                self._comment_block(text, line, line)
                continue
            if src.startswith('/*', self.i):
                close = src.find('*/', self.i + 2)
                end = n if close == -1 else close + 2
                text = src[self.i:end]
                began = self.line
                self._advance_to(end)
                self._comment_block(text, began, self.line)
                continue
            if ch == '#' and self.lang in ('c', 'cpp') and self._at_line_start(start):
                end = self._directive_end(start)
                self._emit('directive', src[start:end].strip(), start, end)
                continue
            if ch == '#' and self.lang == 'rust' and src.startswith(('#[', '#!['), self.i):
                end = self._balanced(src.index('[', self.i), '[', ']')
                self._emit('attr', src[src.index('[', start) + 1:end - 1].strip(), start, end)
                continue
            if ch == '@' and self.lang in ('java', 'typescript', 'javascript') and _ident_start(src[self.i + 1:self.i + 2]):
                end = self.i + 1
                while end < n and _ident_part(src[end]):
                    end += 1
                while end < n and src[end] in ' \t':
                    end += 1
                if end < n and src[end] == '(':
                    end = self._balanced(end, '(', ')')
                self._emit('attr', ' '.join(src[start + 1:end].split()), start, end)
                continue

            string = self._string_at(start)
            if string is not None:
                value, end = string
                self._emit('string', value, start, end)
                continue

            if ch.isdigit():
                end = self.i + 1
                while end < n and (src[end].isalnum() or src[end] in '._' and src[end + 1:end + 2].isdigit()):
                    end += 1
                self._emit('number', src[start:end], start, end)
                continue

            if _ident_start(ch):
                end = self.i + 1
                while end < n and _ident_part(src[end]):
                    end += 1
                self._emit('word', src[start:end], start, end)
                continue

            for digraph in DIGRAPHS:
                if src.startswith(digraph, self.i):
                    self._emit('punct', digraph, start, start + len(digraph))
                    break
            else:
                self._emit('punct', ch, start, start + 1)

    def _at_line_start(self, pos: int) -> bool:
        return not self.src[self.line_start:pos].strip()

    def _directive_end(self, start: int) -> int:
        """A preprocessor line, following backslash continuations to their end."""
        i = start
        n = len(self.src)
        while i < n:
            nl = self.src.find('\n', i)
            if nl == -1:
                return n
            if not self.src[:nl].rstrip().endswith('\\'):
                return nl
            i = nl + 1
        return n

    def _balanced(self, start: int, open_ch: str, close_ch: str) -> int:
        """The offset just past the bracket group starting at `start`."""
        depth = 0
        i = start
        n = len(self.src)
        while i < n:
            c = self.src[i]
            if c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        return n

    # -- strings ------------------------------------------------------------

    def _string_at(self, start: int) -> Optional[tuple[str, int]]:
        """
        The value and the end of a string literal starting here, or None.

        The value is what the *query reader* should see, so escapes are undone
        and an interpolated hole becomes `{expr}` — the same spelling Python's
        f-strings leave behind, so one rule downstream covers `${table}` in a
        template literal and `{table}` in an f-string alike.
        """
        src = self.src
        n = len(src)
        ch = src[start]

        if self.lang == 'cpp' and ch == 'R' and src.startswith('R"', start):
            open_paren = src.find('(', start + 2)
            if open_paren != -1:
                delim = src[start + 2:open_paren]
                close = f'){delim}"'
                at = src.find(close, open_paren + 1)
                end = n if at == -1 else at + len(close)
                return src[open_paren + 1:at if at != -1 else n], end

        if self.lang == 'rust' and ch in 'rb' and src[start:start + 4].lstrip('rb').startswith(('"', '#')):
            head = start
            while head < n and src[head] in 'rb':
                head += 1
            hashes = 0
            while head + hashes < n and src[head + hashes] == '#':
                hashes += 1
            if head + hashes < n and src[head + hashes] == '"':
                close = '"' + '#' * hashes
                at = src.find(close, head + hashes + 1)
                end = n if at == -1 else at + len(close)
                return src[head + hashes + 1:at if at != -1 else n], end

        if self.lang == 'java' and src.startswith('"""', start):
            at = src.find('"""', start + 3)
            end = n if at == -1 else at + 3
            return _text_block(src[start + 3:at if at != -1 else n]), end

        if ch == '`' and self.lang in ('go', 'javascript', 'typescript'):
            at = src.find('`', start + 1)
            end = n if at == -1 else at + 1
            body = src[start + 1:at if at != -1 else n]
            # Go's backticks are raw; a template literal's holes are exactly the
            # unknowns an f-string has, and are kept as such.
            return (body if self.lang == 'go' else _template_holes(body)), end

        if ch == '"' or (ch == "'" and not self._is_lifetime(start)):
            i = start + 1
            out: list[str] = []
            while i < n:
                c = src[i]
                if c == '\\' and i + 1 < n:
                    out.append(_unescape(src[i + 1]))
                    i += 2
                    continue
                if c == ch:
                    i += 1
                    break
                # An unterminated literal ends at the line, so one typo colours
                # one line rather than eating the rest of the file.
                if c == '\n':
                    break
                out.append(c)
                i += 1
            return ''.join(out), i

        return None

    def _is_lifetime(self, start: int) -> bool:
        """Rust writes `'static` for a lifetime and `'a'` for a character."""
        if self.lang != 'rust':
            return False
        after = self.src[start + 1:start + 2]
        if not (_ident_start(after) or after == '_'):
            return False
        end = start + 1
        while end < len(self.src) and _ident_part(self.src[end]):
            end += 1
        return self.src[end:end + 1] != "'"


def _ident_start(ch: str) -> bool:
    return bool(ch) and (ch.isalpha() or ch in '_$' or ord(ch) > 127)


def _ident_part(ch: str) -> bool:
    return bool(ch) and (ch.isalnum() or ch in '_$' or ord(ch) > 127)


_ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'", '`': '`', '\n': ''}


def _unescape(ch: str) -> str:
    return _ESCAPES.get(ch, ch)


def _template_holes(body: str) -> str:
    """`${table}` becomes `{table}`: a hole, said the way the rest of the scanner says it."""
    out: list[str] = []
    i = 0
    while i < len(body):
        if body.startswith('${', i):
            depth = 0
            j = i + 1
            while j < len(body):
                if body[j] == '{':
                    depth += 1
                elif body[j] == '}':
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            out.append('{' + body[i + 2:j] + '}')
            i = j + 1
            continue
        out.append(body[i])
        i += 1
    return ''.join(out)


def _text_block(body: str) -> str:
    """A Java text block, minus the incidental indentation the compiler strips."""
    lines = body.split('\n')
    if lines and not lines[0].strip():
        lines = lines[1:]
    indents = [len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()]
    cut = min(indents) if indents else 0
    return '\n'.join(ln[cut:] if len(ln) >= cut else ln.lstrip() for ln in lines)


def clean_doc(text: str) -> list[str]:
    """A comment as prose: the markers off, the leading stars off, blanks kept."""
    lines: list[str] = []
    for raw in text.split('\n'):
        line = raw.strip()
        if line.startswith('/**'):
            line = line[3:]
        elif line.startswith('/*'):
            line = line[2:]
        if line.endswith('*/'):
            line = line[:-2]
        line = line.strip()
        if line.startswith('///'):
            line = line[3:]
        elif line.startswith('//!'):
            line = line[3:]
        elif line.startswith('//'):
            line = line[2:]
        elif line.startswith('*'):
            line = line[1:]
        lines.append(line.strip())
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return lines
