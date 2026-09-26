/**
 * Host-language code, lexed for reading rather than for colouring.
 *
 * The highlighter next door already knows every language's comments and
 * strings, so this starts from its spans and adds the three things reading
 * needs that colouring does not:
 *
 *  - a string's *value*, prefix and quotes gone, so `f"SELECT …"` and a Rust
 *    `r#"…"#` are both just the query they hold;
 *  - the strings the highlighter cannot see, because they are not delimited by
 *    quotes at all: a Perl or shell heredoc, and a shell or Perl string that
 *    runs on over several lines;
 *  - statements. A step's code is "the statement the query sits in", which in
 *    most of these languages is a line, except when a bracket is still open or
 *    the line ends on an operator that wants another operand.
 *
 * Like the highlighter it never throws, and like the Python scanner's lexer it
 * decides nothing about what the code *means*: that is `read.ts`.
 */
import { PROGRAM_LANGUAGES, type ProgramLanguage } from '@shared/types';
import { highlightCode } from './highlight';

export interface CodeToken {
  kind: 'word' | 'string' | 'number' | 'punct' | 'comment' | 'space';
  /** The spelling, exactly as in the source. */
  text: string;
  start: number;
  end: number;
  /** A string's contents: prefix, quotes and escapes gone. */
  value?: string;
  /**
   * Where a heredoc's body ends. The token itself is only the `<<SQL` marker,
   * so the rest of its line still reads in order; the statement it belongs to
   * runs on to here.
   */
  bodyEnd?: number;
}

/** The languages whose strings interpolate `$name`, run on over lines, and have heredocs. */
const SIGIL_LANGS = new Set<ProgramLanguage>(['perl', 'shell']);

/** Python's string prefixes: raw, format, bytes, unicode, and the pairs of them. */
const PY_PREFIX = /^(?:[rR][bBfF]?|[bBfF][rR]?|[uU])$/;

const HEREDOC = /^<<([-~]?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/;

function unescape(body: string): string {
  return body.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

/** A string literal's contents, from its spelling. */
function stringValue(text: string, language: ProgramLanguage): string {
  // C++'s R"delim( … )delim"
  const raw = /^R"([^(]*)\(([\s\S]*)\)\1"$/.exec(text);
  if (raw) return raw[2];
  // Rust's r#"…"#, br"…"
  const hashed = /^[rb]+(#*)"([\s\S]*)"\1$/.exec(text);
  if (hashed && language === 'rust') return hashed[2];
  for (const q of ['"""', "'''"]) {
    if (text.startsWith(q)) {
      const body = text.endsWith(q) && text.length >= 6 ? text.slice(3, -3) : text.slice(3);
      // A Java text block starts on the line after its quotes and is
      // indented with the code; the query is what is left once both go.
      return language === 'java' ? dedent(body.replace(/^[ \t]*\r?\n/, '')) : body;
    }
  }
  const q = text[0];
  const body = text.length >= 2 && text.endsWith(q) ? text.slice(1, -1) : text.slice(1);
  // Single quotes in the shell and Perl are verbatim: no escapes at all.
  if (q === "'" && SIGIL_LANGS.has(language)) return body;
  return q === '`' && language === 'go' ? body : unescape(body);
}

/** Where a string that started at `start` really ends, in a language whose plain quotes span lines. */
function sigilStringEnd(text: string, start: number): number {
  const q = text[start];
  let j = start + 1;
  while (j < text.length) {
    if (text[j] === '\\' && q !== "'") {
      j += 2;
      continue;
    }
    if (text[j] === q) return j + 1;
    j++;
  }
  return text.length;
}

/**
 * Tokens for a piece of code, in source order. Every character outside a
 * heredoc's body is covered; the body is the value of its marker's token.
 *
 * Built on `highlightCode`: its spans are the tokens, except where it could not
 * know better — a heredoc, a multi-line shell string — and there the scan is
 * restarted past the literal so nothing inside it is read as code.
 */
export function lexCode(text: string, language: ProgramLanguage): CodeToken[] {
  const out: CodeToken[] = [];
  lexFrom(text, 0, text.length, language, out);
  return out;
}

function lexFrom(text: string, from: number, to: number, language: ProgramLanguage, out: CodeToken[]): void {
  let base = from;
  const sigils = SIGIL_LANGS.has(language);
  restart: while (base < to) {
    const spans = highlightCode(text.slice(base, to), language);
    for (const sp of spans) {
      const start = base + sp.start;
      const end = base + sp.end;
      if (sp.cls === 'string') {
        if (sigils && (text[start] === '"' || text[start] === "'") && (end - start < 2 || text[end - 1] !== text[start] || end - 1 === start)) {
          // The highlighter ends a plain string at the newline; these
          // languages do not, and a query spread over lines is the usual case.
          const real = Math.min(to, sigilStringEnd(text, start));
          const spelled = text.slice(start, real);
          out.push({ kind: 'string', text: spelled, start, end: real, value: stringValue(spelled, language) });
          base = real;
          continue restart;
        }
        let tokStart = start;
        const spelled = text.slice(start, end);
        // Python's f"…", r"…", b"…": the highlighter reads the prefix as a word.
        const prev = out[out.length - 1];
        if (language === 'python' && prev && prev.kind === 'word' && prev.end === start && PY_PREFIX.test(prev.text)) {
          out.pop();
          tokStart = prev.start;
        }
        out.push({ kind: 'string', text: text.slice(tokStart, end), start: tokStart, end, value: stringValue(spelled, language) });
        continue;
      }
      if (sigils && sp.cls === 'punct' && sp.text === '<' && text[start + 1] === '<' && text[start - 1] !== '<' && text[start + 2] !== '<') {
        const m = HEREDOC.exec(text.slice(start, Math.min(to, start + 80)));
        if (m) {
          const marker = m[2] ?? m[3] ?? m[4];
          const markerEnd = start + m[0].length;
          let lineEnd = text.indexOf('\n', markerEnd);
          if (lineEnd === -1 || lineEnd > to) lineEnd = to;
          const indented = m[1] !== '';
          // The body is every line up to the one holding only the marker.
          let pos = lineEnd + 1;
          let bodyEnd = to;
          let after = to;
          while (pos <= to) {
            let nl = text.indexOf('\n', pos);
            if (nl === -1 || nl > to) nl = to;
            const line = text.slice(pos, nl);
            if ((indented ? line.trim() : line.replace(/\r$/, '')) === marker) {
              bodyEnd = pos;
              after = nl;
              break;
            }
            if (nl >= to) break;
            pos = nl + 1;
          }
          const body = text.slice(Math.min(lineEnd + 1, to), bodyEnd);
          out.push({ kind: 'string', text: text.slice(start, markerEnd), start, end: markerEnd, value: indented ? dedent(body) : body, bodyEnd: after });
          // The rest of the marker's line is still code, and reads before the body.
          lexFrom(text, markerEnd, lineEnd, language, out);
          base = after;
          continue restart;
        }
      }
      const kind: CodeToken['kind'] =
        sp.cls === 'comment' ? 'comment' : sp.cls === 'number' && /^[0-9.]/.test(sp.text) ? 'number' : sp.cls === 'punct' ? 'punct' : /^\s+$/.test(sp.text) ? 'space' : 'word';
      out.push({ kind, text: sp.text, start, end });
    }
    break;
  }
}

/* ------------------------------------------------------------------ */
/* Statements                                                          */
/* ------------------------------------------------------------------ */

/**
 * One statement: a logical line. Usually a physical line, but it runs on while
 * a bracket is open, while the line ends on an operator that needs another
 * operand, while the next line opens with a method call or a `+`, and across a
 * heredoc's body.
 */
export interface CodeStatement {
  /** Offset of the first character of its first line. */
  lineStart: number;
  /** Offset just past the last character of its last line (before the newline). */
  lineEnd: number;
  /** Its tokens, without spaces. Comments are kept; `solid` drops them too. */
  toks: CodeToken[];
  /** Column of the first token: what Python's structure is made of. */
  indent: number;
}

/** A statement's tokens that are code: no comments. */
export function solid(st: CodeStatement): CodeToken[] {
  return st.toks.filter((t) => t.kind !== 'comment');
}

/** Tokens at the end of a line that say the statement goes on. */
const TRAILING = new Set(['+', '-', '*', '/', '.', ',', '=', '(', '[', '&', '|', '\\', '?', ':', '%', '<', '>', '!', '^']);
/** Tokens at the start of a line that say it continues the one above. */
const LEADING = new Set(['.', '+', '?', '&', '|']);

function isPunct(t: CodeToken, text: string): boolean {
  return t.kind === 'punct' && t.text === text;
}
function isOpen(t: CodeToken, pyBraces: boolean): boolean {
  return t.kind === 'punct' && (t.text === '(' || t.text === '[' || (pyBraces && t.text === '{'));
}
function isClose(t: CodeToken, pyBraces: boolean): boolean {
  return t.kind === 'punct' && (t.text === ')' || t.text === ']' || (pyBraces && t.text === '}'));
}

export function codeStatements(text: string, toks: CodeToken[], language: ProgramLanguage): CodeStatement[] {
  const out: CodeStatement[] = [];
  // Braces are brackets in Python; everywhere else they are blocks, and a block
  // is many statements rather than one long one.
  const pyBraces = language === 'python';
  // In Python a line ending ':' opens a block, so it does not continue; in a
  // brace language a trailing ':' is a label, a case or a ternary half.
  const trailing = new Set(TRAILING);
  if (language === 'python' || language === 'shell') trailing.delete(':');
  if (language === 'shell') for (const t of ['-', '*', '/', '%', '<', '>', '!', '^', '?', '.', ',', '=', '(', '[', '+']) trailing.delete(t);
  const leading = new Set(LEADING);
  if (language === 'shell' || language === 'python') leading.clear();
  let depth = 0;
  let hold = 0;
  let cur: CodeToken[] = [];
  const lineStartOf = (pos: number) => text.lastIndexOf('\n', pos - 1) + 1;
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    const lineStart = lineStartOf(first.start);
    const reach = Math.max(...cur.map((t) => Math.max(t.end, t.bodyEnd ?? 0)));
    let lineEnd = text.indexOf('\n', reach);
    if (lineEnd === -1) lineEnd = text.length;
    if (text[lineEnd - 1] === '\r') lineEnd--;
    out.push({ lineStart, lineEnd, toks: cur, indent: first.start - lineStart });
    cur = [];
  };
  const nextSolid = (i: number): CodeToken | undefined => {
    for (let j = i + 1; j < toks.length; j++) if (toks[j].kind !== 'space' && toks[j].kind !== 'comment') return toks[j];
    return undefined;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'space') {
      const nl = t.text.indexOf('\n');
      if (nl === -1 || t.start + nl < hold) continue;
      const lastSolid = [...cur].reverse().find((x) => x.kind !== 'comment');
      const next = nextSolid(i);
      // A preprocessor line ends at its newline unless it ends in a backslash:
      // `#include <stdio.h>` does not continue because it ends in '>'.
      const directive = (language === 'c' || language === 'cpp') && cur[0]?.text.startsWith('#');
      const continues = directive
        ? lastSolid?.text === '\\'
        : depth > 0 || (lastSolid?.kind === 'punct' && trailing.has(lastSolid.text)) || (cur.length > 0 && next?.kind === 'punct' && leading.has(next.text));
      if (!continues) flush();
      continue;
    }
    if (t.bodyEnd) hold = Math.max(hold, t.bodyEnd);
    if (isOpen(t, pyBraces)) depth++;
    else if (isClose(t, pyBraces)) depth = Math.max(0, depth - 1);
    cur.push(t);
    // Two statements on one line, `a(); b();`, are two statements. A brace
    // does not split one: `import { a } from 'x'` and `} else {` are each one
    // thing, and the outline reads the braces inside a statement anyway.
    if (!pyBraces && depth === 0 && isPunct(t, ';') && language !== 'shell') {
      const next = nextSolid(i);
      if (next && lineStartOf(next.start) === lineStartOf(t.start) && next.start >= hold) flush();
    }
  }
  flush();
  return out;
}

/** The source of a statement, whole lines, as written. */
export function statementText(text: string, st: CodeStatement): string {
  return text.slice(st.lineStart, st.lineEnd);
}

/** Text with the indentation every non-blank line shares taken off. */
export function dedent(text: string): string {
  const lines = text.split('\n');
  let common = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^[ \t]*/.exec(l);
    common = Math.min(common, m ? m[0].length : 0);
  }
  if (!Number.isFinite(common) || common === 0) return text;
  return lines.map((l) => (l.trim() ? l.slice(common) : l.trimEnd())).join('\n');
}

/* ------------------------------------------------------------------ */
/* Which language a paste is in                                        */
/* ------------------------------------------------------------------ */

const SHEBANGS: [RegExp, ProgramLanguage][] = [
  [/python/, 'python'],
  [/perl/, 'perl'],
  [/\b(?:ba|z|k|da)?sh\b/, 'shell'],
  [/\b(?:node|deno|bun)\b/, 'javascript'],
];

/** Signals, each worth its weight when the paste matches it. */
const SIGNALS: [ProgramLanguage, RegExp, number][] = [
  ['python', /^[ \t]*(?:async[ \t]+)?def[ \t]+\w+[ \t]*\([^)]*\)?[^:\n]*:[ \t]*(?:#.*)?$/m, 4],
  ['python', /^[ \t]*class[ \t]+\w+[ \t]*(?:\([^)]*\))?[ \t]*:[ \t]*$/m, 4],
  ['python', /^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+/m, 3],
  ['python', /^[ \t]*import[ \t]+[\w.]+(?:[ \t]+as[ \t]+\w+)?[ \t]*$/m, 1],
  ['python', /\bself\.\w+/, 1],
  ['python', /^[ \t]*(?:elif\b.*|else|try|finally|except\b.*):[ \t]*$/m, 2],
  ['python', /\b(?:None|True|False)\b/, 1],
  ['python', /^[ \t]*(?:with\b.*|for\b.*\bin\b.*|if\b.*|while\b.*):[ \t]*(?:#.*)?$/m, 2],
  // A line ending in ':' with the next one indented further: a block by indentation.
  ['python', /^([ \t]*)[^\s#][^\n]*:[ \t]*(?:#[^\n]*)?\n\1[ \t]+\S/m, 2],
  ['python', /\bif\b[^\n{}]*\belse\b|\bnot in\b|\bis not\b|\bf["']/, 2],
  ['rust', /\bfn[ \t]+\w+[ \t]*(?:<[^>]*>)?[ \t]*\(/, 4],
  ['rust', /\blet[ \t]+mut\b/, 3],
  ['rust', /^[ \t]*(?:pub[ \t]+)?(?:use|mod)[ \t]+[\w:{}]+(?:::[\w{}*, ]+)*;/m, 3],
  ['rust', /\bimpl\b[^{\n]*\{/, 3],
  ['rust', /#\[\w+/, 2],
  ['rust', /\b\w+!\(/, 1],
  // Go's package line has no semicolon; Java's has one.
  ['go', /^package[ \t]+\w+[ \t]*(?:\/\/.*)?$/m, 4],
  ['java', /^package[ \t]+[\w.]+;/m, 4],
  ['go', /\bfunc[ \t]+(?:\([^)]*\)[ \t]*)?\w+[ \t]*\(/, 4],
  ['go', /:=/, 2],
  ['go', /\berr[ \t]*!=[ \t]*nil\b/, 3],
  ['java', /\b(?:public|private|protected)[ \t]+(?:static[ \t]+)?(?:final[ \t]+)?[\w<>[\], ]+[ \t]+\w+[ \t]*\([^)]*\)[ \t]*(?:throws[ \t]+[\w., ]+)?[ \t]*\{/, 4],
  ['java', /^[ \t]*import[ \t]+(?:static[ \t]+)?[\w.]+(?:\.\*)?;/m, 3],
  ['java', /\b(?:System\.out|@Override|PreparedStatement|ResultSet)\b/, 3],
  ['java', /\b(?:public|final)[ \t]+class\b/, 2],
  ['c', /^[ \t]*#[ \t]*include[ \t]*[<"]/m, 4],
  ['c', /\b(?:printf|malloc|free|sizeof|PQexec\w*|sqlite3_\w+)[ \t]*\(/, 2],
  ['cpp', /\bstd::/, 4],
  ['cpp', /^[ \t]*(?:namespace|template[ \t]*<|using[ \t]+namespace)\b/m, 3],
  ['cpp', /\b\w+::\w+[ \t]*\(/, 2],
  ['cpp', /\b(?:nullptr|cout|cerr|auto&?)\b/, 2],
  ['javascript', /\bfunction\b[ \t]*\w*[ \t]*\(/, 3],
  ['javascript', /\b(?:const|let|var)[ \t]+\w+[ \t]*=/, 2],
  ['javascript', /=>/, 2],
  ['javascript', /\brequire\([ \t]*['"]/, 3],
  ['javascript', /^[ \t]*(?:import\b[^;\n]*\bfrom[ \t]+['"]|export[ \t]+(?:default|const|function|async|class)\b)/m, 3],
  ['javascript', /\b(?:console\.log|module\.exports|await)\b/, 2],
  ['typescript', /:[ \t]*(?:string|number|boolean|void|any|unknown|Promise<[^>]*>)\b/, 3],
  ['typescript', /^[ \t]*(?:export[ \t]+)?(?:interface|type)[ \t]+\w+[ \t]*(?:<[^>]*>)?[ \t]*[={]/m, 3],
  ['typescript', /\bimport[ \t]+type\b|\bas[ \t]+const\b/, 3],
  ['perl', /\bmy[ \t]+[$@%]\w+/, 4],
  ['perl', /^[ \t]*sub[ \t]+\w+[ \t]*\{/m, 4],
  ['perl', /^[ \t]*use[ \t]+(?:strict|warnings|DBI)\b/m, 4],
  ['perl', /\$\w+->\w+|\$\w+->\{|=~|@_\b/, 2],
  ['shell', /^[ \t]*(?:function[ \t]+)?[\w-]+[ \t]*\(\)[ \t]*\{/m, 4],
  ['shell', /\$\(|\$\{\w+/, 2],
  ['shell', /^[ \t]*(?:fi|done|esac|then|do)[ \t]*$/m, 3],
  ['shell', /^[ \t]*(?:echo|local|export|source|set[ \t]+-\w+)\b/m, 2],
  ['shell', /\[\[? .* \]\]?/, 1],
];

/**
 * The language a paste is written in, or null when nothing about it is
 * distinctive enough to say. Used when code lands somewhere that has no
 * language of its own yet — the canvas, or a node still called 'other'.
 *
 * Scored, not decided by the first match, because the signals overlap: `=>`
 * is JavaScript and Rust, `::` is C++ and Rust and Perl. A winner has to be
 * clearly ahead, or the answer is null and the caller asks nobody and keeps
 * what it had.
 */
export function guessLanguage(text: string): ProgramLanguage | null {
  const head = /^#![^\n]*/.exec(text.trimStart());
  if (head) for (const [re, lang] of SHEBANGS) if (re.test(head[0])) return lang;
  const score = languageScores(text);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [best, top] = ranked[0];
  const second = ranked.find(([l]) => l !== best && !(best === 'typescript' && l === 'javascript') && !(best === 'cpp' && l === 'c'))?.[1] ?? 0;
  if (top < 4 || top - second < 2) return null;
  return best;
}

/** How strongly a paste reads as each language. */
function languageScores(text: string): Map<ProgramLanguage, number> {
  const score = new Map<ProgramLanguage, number>();
  for (const [lang, re, weight] of SIGNALS) if (re.test(text)) score.set(lang, (score.get(lang) ?? 0) + weight);
  // TypeScript is JavaScript with more to say, and C++ is C with more to say:
  // the richer one wins only on signals of its own, but counts the shared ones.
  if (score.has('typescript')) score.set('typescript', score.get('typescript')! + (score.get('javascript') ?? 0));
  if (score.has('cpp')) score.set('cpp', score.get('cpp')! + (score.get('c') ?? 0));
  return score;
}

/**
 * Whether a paste reads as written in `language` at all: something distinctive
 * of it is there. A node that already says it is Java keeps saying so for a
 * paste that looks like Java, even if it looks a little like Go too.
 */
export function readsAs(text: string, language: ProgramLanguage): boolean {
  const score = languageScores(text);
  const own = score.get(language) ?? 0;
  // JavaScript read as TypeScript, or C read as C++, is still readable.
  const kin = language === 'typescript' ? (score.get('javascript') ?? 0) : language === 'cpp' ? (score.get('c') ?? 0) : 0;
  return own + kin >= 4;
}

/** The language a file name says it is written in, from its extension. */
export function languageFromFilename(name: string): ProgramLanguage | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!ext) return null;
  const extra: Record<string, ProgramLanguage> = {
    h: 'c',
    hpp: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    pm: 'perl',
    bash: 'shell',
    zsh: 'shell',
    pyw: 'python',
  };
  if (extra[ext]) return extra[ext];
  const hit = PROGRAM_LANGUAGES.find((l) => l.extension === ext && l.id !== 'other' && !l.data);
  return hit ? hit.id : null;
}
