/**
 * Syntax colouring for the host languages a program is written in.
 *
 * Deliberately the same shape as `scanSql` next door: a tolerant scanner that
 * never throws, keeps every character so the spans concatenate back to the
 * input, and produces the same `HighlightSpan` classes the SQL editors already
 * have colours for. An overlay highlighter needs exactly that, and reusing the
 * classes means one palette rather than two that drift apart.
 *
 * It is a lexer, not a parser. It knows comments, strings, numbers, words and
 * punctuation, and it colours a word by looking it up in the language's keyword
 * and type sets. That is enough to read code with, and it cannot be wrong about
 * anything it does not claim to know.
 */
import { programLanguageMeta, type ProgramLanguage } from '@shared/types';
import type { HighlightSpan } from '../sql/highlight';

/** How one language spells its comments and strings. */
interface LanguageSyntax {
  /** Line-comment markers. */
  line: string[];
  /** Block-comment delimiters. */
  block?: { open: string; close: string };
  /** Quote characters that open a string. */
  quotes: string[];
  /** Triple-quoted strings (Python, Java text blocks), checked before single quotes. */
  triples?: string[];
  /** Raw strings introduced by a prefix, e.g. Rust's r#"..."#. */
  rawHash?: boolean;
  /** C++11's R"delim(...)delim", where the delimiter is chosen per literal. */
  rawParen?: boolean;
  keywords: Set<string>;
  types: Set<string>;
  /** Literals coloured apart from keywords: true, nil, None. */
  constants: Set<string>;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_BLOCK = { open: '/*', close: '*/' };

const PYTHON: LanguageSyntax = {
  line: ['#'],
  quotes: ['"', "'"],
  triples: ['"""', "'''"],
  keywords: words(`and as assert async await break class continue def del elif else except finally for from global if
    import in is lambda nonlocal not or pass raise return try while with yield match case`),
  types: words(`int float str bytes bool list dict set tuple frozenset complex object type bytearray memoryview range`),
  constants: words(`True False None NotImplemented Ellipsis self cls`),
};

const RUST: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'"],
  rawHash: true,
  keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod
    move mut pub ref return self Self static struct super trait type unsafe use where while macro_rules`),
  types: words(`i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box
    Rc Arc HashMap HashSet BTreeMap Cow`),
  constants: words(`true false None Some Ok Err`),
};

const GO: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'", '`'],
  keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface
    map package range return select struct switch type var`),
  types: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8
    uint16 uint32 uint64 uintptr any`),
  constants: words(`true false nil iota make new len cap append copy delete panic recover`),
};

// C and C++ get separate tables rather than one: `class` and `namespace` are
// not C keywords, and colouring them in a .c file would be telling the reader
// something untrue about the language they are in.
const C_LANG: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'"],
  keywords: words(`auto break case const continue default do else enum extern for goto if inline register restrict
    return sizeof static struct switch typedef union volatile while _Atomic _Bool _Generic _Noreturn _Static_assert
    include define ifdef ifndef endif pragma undef elif`),
  types: words(`char double float int long short signed unsigned void size_t ssize_t ptrdiff_t int8_t int16_t int32_t
    int64_t uint8_t uint16_t uint32_t uint64_t FILE va_list`),
  constants: words(`NULL true false EOF stdin stdout stderr`),
};

const CPP: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'"],
  rawParen: true,
  keywords: words(`alignas alignof auto break case catch class co_await co_return co_yield concept const consteval
    constexpr constinit continue decltype default delete do else enum explicit export extern for friend goto if inline
    mutable namespace new noexcept operator private protected public register requires return sizeof static
    static_cast dynamic_cast const_cast reinterpret_cast struct switch template this throw try typedef typename union
    using virtual volatile while include define ifdef ifndef endif pragma`),
  types: words(`bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t
    ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t string string_view vector map set
    unordered_map unordered_set pair array optional variant span unique_ptr shared_ptr`),
  constants: words(`true false NULL nullptr std this`),
};

const JAVA: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'"],
  triples: ['"""'],
  keywords: words(`abstract assert break case catch class const continue default do else enum extends final finally for
    goto if implements import instanceof interface native new package private protected public return static strictfp
    super switch synchronized this throw throws transient try var void volatile while record sealed yield`),
  types: words(`boolean byte char double float int long short String Integer Long Double Float Boolean Character Object
    List Map Set Optional Connection PreparedStatement ResultSet Statement`),
  constants: words(`true false null`),
};

const JS: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'", '`'],
  keywords: words(`as async await break case catch class const continue debugger default delete do else export extends
    finally for from function get if implements import in instanceof interface let new of return set static super
    switch this throw try type typeof var void while with yield satisfies keyof readonly declare namespace enum`),
  types: words(`any bigint boolean never number object string symbol unknown void Array Promise Record Map Set Date
    RegExp Error JSON Math`),
  constants: words(`true false null undefined NaN Infinity console process`),
};

const RUBY: LanguageSyntax = {
  line: ['#'],
  quotes: ['"', "'"],
  keywords: words(`alias and begin break case class def defined do else elsif end ensure for if in module next not or
    redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor
    attr_reader attr_writer`),
  types: words(`Array Hash String Symbol Integer Float Range Struct Proc Time`),
  constants: words(`true false nil __FILE__ __LINE__`),
};

const CSHARP: LanguageSyntax = {
  line: ['//'],
  block: C_BLOCK,
  quotes: ['"', "'"],
  keywords: words(`abstract as async await base break case catch checked class const continue default delegate do else
    enum event explicit extern finally fixed for foreach get goto if implicit in interface internal is lock namespace
    new operator out override params private protected public readonly record ref return sealed set sizeof stackalloc
    static struct switch this throw try typeof unchecked unsafe using var virtual void volatile while yield`),
  types: words(`bool byte char decimal double float int long object sbyte short string uint ulong ushort dynamic List
    Dictionary Task IEnumerable`),
  constants: words(`true false null value`),
};

const SHELL: LanguageSyntax = {
  line: ['#'],
  quotes: ['"', "'"],
  keywords: words(`if then elif else fi for while until do done case esac function in select return break continue
    local export readonly declare set unset shift source eval exec trap`),
  types: new Set<string>(),
  constants: words(`true false echo printf cd test cat grep sed awk psql mysql sqlite3 duckdb`),
};

const SYNTAX: Record<ProgramLanguage, LanguageSyntax> = {
  python: PYTHON,
  rust: RUST,
  go: GO,
  c: C_LANG,
  cpp: CPP,
  java: JAVA,
  javascript: JS,
  typescript: JS,
  csharp: CSHARP,
  ruby: RUBY,
  shell: SHELL,
  // Unknown language: comments and strings still read correctly, and no word is
  // claimed to be a keyword, which is the honest thing to do.
  other: { line: ['#', '//'], block: C_BLOCK, quotes: ['"', "'"], keywords: new Set(), types: new Set(), constants: new Set() },
};

const WORD_START = /[A-Za-z_$@#\u0080-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/**
 * Colour a piece of code. Spans cover every character of `text`, in order, so
 * an overlay built from them lines up with the textarea underneath it exactly.
 */
export function highlightCode(text: string, language: ProgramLanguage): HighlightSpan[] {
  const syn = SYNTAX[language] ?? SYNTAX.other;
  const out: HighlightSpan[] = [];
  const n = text.length;
  let i = 0;
  const push = (cls: HighlightSpan['cls'], end: number) => {
    if (end > i) out.push({ cls, text: text.slice(i, end), start: i, end });
    i = end;
  };

  while (i < n) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      push('text', j);
      continue;
    }

    // C++11's R"sql( … )sql", whose delimiter is chosen per literal so that a
    // query holding a quote needs no escaping. Checked before words, or the R
    // reads as an identifier and the SQL as code.
    if (syn.rawParen && ch === 'R' && text[i + 1] === '"') {
      const open = text.indexOf('(', i + 2);
      if (open !== -1) {
        const close = `)${text.slice(i + 2, open)}"`;
        const at = text.indexOf(close, open + 1);
        push('string', at === -1 ? n : at + close.length);
        continue;
      }
    }

    // Raw strings first: Rust's r"..." and r#"..."# would otherwise read as a
    // word followed by a string, and the hashes would leak out of it.
    if (syn.rawHash && (ch === 'r' || ch === 'b') && (text[i + 1] === '"' || text[i + 1] === '#')) {
      const m = /^[rb]+(#*)"/.exec(text.slice(i, i + 16));
      if (m) {
        const close = `"${m[1]}`;
        const at = text.indexOf(close, i + m[0].length);
        push('string', at === -1 ? n : at + close.length);
        continue;
      }
    }

    const triple = syn.triples?.find((t) => text.startsWith(t, i));
    if (triple) {
      const at = text.indexOf(triple, i + triple.length);
      push('string', at === -1 ? n : at + triple.length);
      continue;
    }

    if (syn.line.some((m) => text.startsWith(m, i))) {
      let j = text.indexOf('\n', i);
      if (j === -1) j = n;
      push('comment', j);
      continue;
    }

    if (syn.block && text.startsWith(syn.block.open, i)) {
      const at = text.indexOf(syn.block.close, i + syn.block.open.length);
      push('comment', at === -1 ? n : at + syn.block.close.length);
      continue;
    }

    if (syn.quotes.includes(ch)) {
      let j = i + 1;
      for (;;) {
        if (j >= n) break;
        // A backslash escapes the next character in every language here. A
        // backtick string may span lines; a plain one ends at the newline, so a
        // missing closing quote colours one line rather than the rest of the file.
        if (text[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j++;
          break;
        }
        if (text[j] === '\n' && ch !== '`') break;
        j++;
      }
      push('string', j);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:0[xXbBoO][0-9A-Fa-f_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)[a-zA-Z_]*/.exec(text.slice(i, i + 64));
      push('number', i + (m ? m[0].length : 1));
      continue;
    }

    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j])) j++;
      // A preprocessor directive is written #include but its keyword is the
      // word after the hash, so the bare spelling is what gets looked up.
      const bare = text.slice(i, j).replace(/^[#@]/, '');
      let k = 0;
      while (j + k < n && /\s/.test(text[j + k])) k++;
      // A word followed by "(" is being called, which is the one useful thing a
      // lexer can tell about a name it does not otherwise know.
      const callish = text[j + k] === '(';
      const cls: HighlightSpan['cls'] = syn.keywords.has(bare)
        ? 'keyword'
        : syn.types.has(bare)
          ? 'type'
          : syn.constants.has(bare)
            ? 'number'
            : callish
              ? 'function'
              : 'text';
      push(cls, j);
      continue;
    }

    push('punct', i + 1);
  }
  return out;
}

/** The marker this language starts a line comment with. */
export function commentMarker(language: ProgramLanguage): string {
  return programLanguageMeta(language).comment;
}
