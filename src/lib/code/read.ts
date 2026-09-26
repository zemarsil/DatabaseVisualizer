/**
 * Code pasted into a code node, read into the steps it implies.
 *
 * The Python scanner in scripts/dbviz_scan reads a whole codebase from disk.
 * This is the same reading done in the browser, on one paste at a time: a
 * function, a class, a whole file, a script. It keeps the scanner's rules so the
 * two agree about what a piece of code does —
 *
 *  - a query is a string literal holding SQL, and a string in a comment is a
 *    comment; adjacent and `+`-joined literals are one query, and a heredoc is a
 *    string too;
 *  - a query kept in a named constant runs where the constant is used, not where
 *    it is defined;
 *  - a call is a name followed by `(` (in the shell, a word where a command
 *    goes) that names a node the diagram holds;
 *  - a function is the leaf of the map, so a closure or a nested `def` is more
 *    of the function around it, while a class holds its methods;
 *
 * — and adds the one thing a paste has that a scan does not: the code in
 * between. A step's code is the statement it came from plus the lines that lead
 * into it, and a run of real work between two steps that touches nothing is a
 * *compute* step of its own, holding that code. So the steps read, in order,
 * as the code does, and nothing pasted is lost from them.
 *
 * It is a reading, not a parse, and says so where it matters: an ORM builds its
 * queries where no string literal exists, and a table name substituted in at run
 * time is a hole. The code itself is kept on the node either way, so a step list
 * that missed something can be fixed by hand or read again.
 */
import {
  canContain,
  canStepName,
  codeKindOf,
  isDataNode,
  isProcedure,
  type CodeKind,
  type Diagram,
  type Program,
  type ProgramLanguage,
  type ProgramStep,
  type ProgramStepOp,
  type Table,
} from '@shared/types';
import { codeStatements, dedent, guessLanguage, lexCode, readsAs, solid, type CodeStatement, type CodeToken } from './lex';
import { createProgram, createProgramStep, uniqueProgramName } from '../model';
import { nextCodePosition } from '../codemap';
import { stepsFromBody } from '../procedures';
import { scanSql } from '../sql/highlight';
import type { SizeMap } from '../geometry';

/* ------------------------------------------------------------------ */
/* The outline: what a paste defines                                   */
/* ------------------------------------------------------------------ */

export interface SourceDefinition {
  kind: 'function' | 'class';
  name: string;
  /** "def place_order(self, email, cart) -> int", "func (s *Service) PlaceOrder(email string) error". */
  signature: string;
  /** The class a method written outside its class belongs to: Go's receiver, C++'s `Repo::`, Rust's `impl`. */
  owner?: string;
  /** What a class says it is built on. */
  bases: string[];
  /** Its doc comment or docstring, first paragraph. */
  doc?: string;
  /** The definition's own text, decorators and doc comment included. Several for a Rust type and its `impl` blocks. */
  spans: { start: number; end: number }[];
  /** What runs when it is called: after the header and any docstring, before the closing brace. */
  body: { start: number; end: number };
  members: SourceDefinition[];
}

export interface SourceOutline {
  text: string;
  language: ProgramLanguage;
  toks: CodeToken[];
  stmts: CodeStatement[];
  /** Top-level definitions, methods inside their classes. */
  definitions: SourceDefinition[];
  /** What the paste says about itself: a module docstring, or the comment block it opens with. */
  doc?: string;
}

const CONTROL: Partial<Record<ProgramLanguage, Set<string>>> = {
  rust: new Set(['if', 'else', 'for', 'while', 'loop', 'match', 'unsafe', 'extern', 'move', 'return']),
  go: new Set(['if', 'else', 'for', 'switch', 'select', 'range', 'go', 'defer', 'return', 'case', 'default']),
  java: new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'synchronized', 'return', 'new', 'case', 'default', 'instanceof', 'throw', 'assert']),
  c: new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'return', 'case', 'default', 'sizeof', 'goto']),
  cpp: new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'return', 'case', 'default', 'sizeof', 'new', 'delete', 'throw', 'goto', 'co_await', 'co_return']),
  javascript: new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'return', 'new', 'case', 'default', 'with', 'throw', 'await', 'yield']),
  perl: new Set(['if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'foreach', 'do', 'eval', 'given', 'when', 'return', 'last', 'next', 'redo', 'my', 'our', 'local']),
  shell: new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'in', 'return', 'time']),
};
CONTROL.typescript = CONTROL.javascript;
CONTROL.other = new Set([...CONTROL.c!, ...CONTROL.javascript!]);

/** Keyword -> what the block after it is. A namespace holds definitions without being one. */
const CONTAINERS: Partial<Record<ProgramLanguage, Record<string, 'class' | 'namespace'>>> = {
  rust: { struct: 'class', enum: 'class', trait: 'class', union: 'class', mod: 'namespace' },
  java: { class: 'class', interface: 'class', enum: 'class', record: 'class' },
  cpp: { class: 'class', struct: 'class', union: 'class', namespace: 'namespace' },
  javascript: { class: 'class' },
  typescript: { class: 'class', interface: 'class', enum: 'class', namespace: 'namespace', module: 'namespace' },
  perl: { package: 'class' },
  other: { class: 'class' },
};

const FUNCTION_WORD: Partial<Record<ProgramLanguage, string>> = { rust: 'fn', go: 'func', javascript: 'function', typescript: 'function', perl: 'sub', shell: 'function' };

const MODIFIERS = new Set([
  'pub', 'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'virtual', 'override', 'sealed', 'async', 'const', 'constexpr', 'inline',
  'extern', 'explicit', 'friend', 'export', 'default', 'declare', 'readonly', 'get', 'set', 'unsafe', 'crate', 'mut', 'noexcept',
]);

const isPunct = (t: CodeToken | undefined, ...texts: string[]) => Boolean(t) && t!.kind === 'punct' && (texts.length === 0 || texts.includes(t!.text));
const isWord = (t: CodeToken | undefined, ...texts: string[]) => Boolean(t) && t!.kind === 'word' && (texts.length === 0 || texts.includes(t!.text));
/** A name without the sigil Perl and the shell write in front of it. */
const bare = (w: string) => w.replace(/^[$@%&*]+/, '');

/** Index of the parenthesis closing the one at `at`. */
function matchParen(ts: CodeToken[], at: number): number {
  let depth = 0;
  for (let i = at; i < ts.length; i++) {
    if (isPunct(ts[i], '(', '[')) depth++;
    else if (isPunct(ts[i], ')', ']')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return ts.length - 1;
}

/** The first `(` not inside another bracket, or -1. */
function topParen(ts: CodeToken[]): number {
  let angle = 0;
  for (let i = 0; i < ts.length; i++) {
    if (isPunct(ts[i], '<')) angle++;
    else if (isPunct(ts[i], '>')) angle = Math.max(0, angle - 1);
    else if (isPunct(ts[i], '(') && angle === 0) return i;
  }
  return -1;
}

/** Skip a `<…>` generic list starting at `at`, if there is one. */
function skipGenerics(ts: CodeToken[], at: number): number {
  if (!isPunct(ts[at], '<')) return at;
  let depth = 0;
  for (let i = at; i < ts.length; i++) {
    if (isPunct(ts[i], '<')) depth++;
    else if (isPunct(ts[i], '>')) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return ts.length;
}

/** `fmt::Display`, `Repo<T>`: the last name of a type path, and where it ends. */
function typePath(ts: CodeToken[], at: number): [string | null, number] {
  let name: string | null = null;
  let i = at;
  while (i < ts.length) {
    if (isWord(ts[i])) {
      name = ts[i].text;
      i = skipGenerics(ts, i + 1);
      if (isPunct(ts[i], ':') && isPunct(ts[i + 1], ':')) {
        i += 2;
        continue;
      }
      break;
    }
    if (isPunct(ts[i], '&', '*')) {
      i++;
      continue;
    }
    break;
  }
  return [name, i];
}

/** Everything a doc comment says, markers gone, first paragraph only. */
export function cleanDoc(raw: string): string | undefined {
  const lines = raw
    .replace(/^\s*\/\*+!?/, '')
    .replace(/\*+\/\s*$/, '')
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:\/\/[/!]?|#+|\*(?!\/)|--)\s?/, '')
        .replace(/^\s*=(?:pod|head\d|cut|item)\b.*$/, '')
        .trimEnd(),
    );
  const para: string[] = [];
  for (const l of lines) {
    if (!l.trim()) {
      if (para.length) break;
      continue;
    }
    // A doc tag starts the reference part, which is not what the node is for.
    if (/^\s*[@:](?:param|return|returns|throws|raises|type|rtype|arg)\b/.test(l)) break;
    para.push(l.trim());
  }
  const s = para.join(' ').replace(/\s+/g, ' ').trim();
  return s || undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+,/g, ',').trim();
}

function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndOf(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length : nl;
}

/**
 * Where a definition starts once what sits on top of it is counted: a doc
 * comment, a decorator, an annotation, an attribute — anything in the lines
 * straight above it with no blank line in between.
 */
function leadIn(text: string, stmts: CodeStatement[], at: number, language: ProgramLanguage): { start: number; doc?: string } {
  let start = stmts[at].lineStart;
  const comments: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const st = stmts[i];
    const between = text.slice(st.lineEnd, start);
    if ((between.match(/\n/g) ?? []).length > 1) break;
    const ts = solid(st);
    const decorator = ts.length > 0 && (ts[0].text.startsWith('@') || (language === 'rust' && ts[0].text === '#' && isPunct(ts[1], '[')));
    if (ts.length && !decorator) break;
    if (!ts.length) comments.unshift(st.toks.map((t) => t.text).join('\n'));
    start = st.lineStart;
  }
  return { start, doc: comments.length ? cleanDoc(comments.join('\n')) : undefined };
}

/* ---------------- Python: structure is indentation ---------------- */

function outlinePython(text: string, stmts: CodeStatement[]): SourceDefinition[] {
  const parse = (from: number, to: number): SourceDefinition[] => {
    const out: SourceDefinition[] = [];
    let i = from;
    while (i < to) {
      let j = i;
      while (j < to && solid(stmts[j])[0]?.text.startsWith('@')) j++;
      if (j >= to) break;
      const st = stmts[j];
      const ts = solid(st);
      const k = isWord(ts[0], 'async') ? 1 : 0;
      const kw = ts[k]?.text;
      if (!((kw === 'def' || kw === 'class') && isWord(ts[k + 1]))) {
        i = j + 1;
        continue;
      }
      const indent = st.indent;
      let e = j + 1;
      while (e < to && (solid(stmts[e]).length === 0 || stmts[e].indent > indent)) e++;
      // A comment at or left of the def's own indentation is about what follows it.
      while (e > j + 1 && solid(stmts[e - 1]).length === 0 && stmts[e - 1].indent <= indent) e--;
      // The header ends at the first ':' outside brackets after the name.
      let depth = 0;
      let colon = ts.length - 1;
      for (let x = k + 2; x < ts.length; x++) {
        if (isPunct(ts[x], '(', '[', '{')) depth++;
        else if (isPunct(ts[x], ')', ']', '}')) depth--;
        else if (depth === 0 && isPunct(ts[x], ':')) {
          colon = x;
          break;
        }
      }
      const name = ts[k + 1].text;
      const bases: string[] = [];
      if (kw === 'class' && isPunct(ts[k + 2], '(')) {
        const close = matchParen(ts, k + 2);
        let dotted = '';
        for (let x = k + 3; x <= close; x++) {
          const t = ts[x];
          if (isPunct(t, ',') || x === close) {
            if (dotted && !dotted.includes('=')) bases.push(dotted.split('.').pop()!);
            dotted = '';
          } else if (isPunct(t, '(', '[')) x = matchParen(ts, x);
          else dotted += t.text;
        }
      }
      const lead = leadIn(text, stmts, i, 'python');
      let bodyStart = ts[colon].end;
      let doc: string | undefined;
      const first = e > j + 1 ? solid(stmts[j + 1]) : [];
      if (first.length === 1 && first[0].kind === 'string') {
        doc = cleanDoc(first[0].value ?? '');
        bodyStart = stmts[j + 1].lineEnd;
      }
      const end = e > j + 1 ? stmts[e - 1].lineEnd : st.lineEnd;
      out.push({
        kind: kw === 'def' ? 'function' : 'class',
        name,
        signature: collapse(text.slice(ts[0].start, ts[colon].start)),
        bases: bases.filter((b) => b !== 'object'),
        doc: doc ?? lead.doc,
        spans: [{ start: lead.start, end }],
        body: { start: bodyStart, end },
        // A def inside a def is not a node — a function is the leaf of the
        // map — but a class holds its methods.
        members: kw === 'class' ? parse(j + 1, e) : [],
      });
      i = e;
    }
    return out;
  };
  return parse(0, stmts.length);
}

/* ---------------- Everything else: structure is braces ---------------- */

interface Classified {
  kind: 'function' | 'class' | 'namespace';
  name?: string;
  owner?: string;
  bases: string[];
}

function classify(ts: CodeToken[], language: ProgramLanguage, inClass: boolean): Classified | null {
  // Annotations and attributes sit in front of a declaration without changing it.
  let from = 0;
  while (from < ts.length) {
    if (ts[from].text.startsWith('@') && ts[from].kind === 'word') {
      from = isPunct(ts[from + 1], '(') ? matchParen(ts, from + 1) + 1 : from + 1;
      continue;
    }
    if (language === 'rust' && ts[from].text === '#' && isPunct(ts[from + 1], '[')) {
      from = matchParen(ts, from + 1) + 1;
      continue;
    }
    break;
  }
  ts = ts.slice(from);
  if (!ts.length) return null;
  const words = ts.filter((t) => t.kind === 'word').map((t) => t.text);
  const control = CONTROL[language] ?? CONTROL.other!;
  const lead = words.find((w) => !MODIFIERS.has(w)) ?? '';

  if (language === 'go') {
    if (words[0] === 'type' && words.length > 1 && (words.includes('struct') || words.includes('interface'))) return { kind: 'class', name: words[1], bases: [] };
    if (words[0] !== 'func') {
      if (inClass && topParen(ts) === 1 && isWord(ts[0])) return { kind: 'function', name: ts[0].text, bases: [] };
      return null;
    }
    if (isPunct(ts[1], '(')) {
      // A method: `func (r *Repo) Get(ctx) error {`.
      const close = matchParen(ts, 1);
      const inside = ts.slice(2, close).filter((t) => t.kind === 'word').map((t) => t.text);
      const name = isWord(ts[close + 1]) ? ts[close + 1].text : undefined;
      if (!name || !inside.length) return null;
      return { kind: 'function', name, owner: inside[inside.length - 1], bases: [] };
    }
    return words.length > 1 ? { kind: 'function', name: words[1], bases: [] } : null;
  }

  if (language === 'rust' && lead === 'impl') {
    // `impl Repo`, `impl<T> Repo<T>`, `impl fmt::Display for Order`: read off
    // the tokens, or `impl<T> Repo<T>` names a class called T.
    let at = ts.findIndex((t) => isWord(t, 'impl'));
    at = skipGenerics(ts, at + 1);
    const [first, after] = typePath(ts, at);
    if (isWord(ts[after], 'for')) {
      const [target] = typePath(ts, skipGenerics(ts, after + 1));
      return target ? { kind: 'class', name: target, bases: first ? [first] : [] } : null;
    }
    return first ? { kind: 'class', name: first, bases: [] } : null;
  }

  const containers = CONTAINERS[language] ?? {};
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.kind !== 'word' || !Object.prototype.hasOwnProperty.call(containers, t.text)) continue;
    // A function returning a `struct Foo` is not a declaration of one.
    if (language === 'cpp' && (t.text === 'class' || t.text === 'struct') && topParen(ts) >= 0) break;
    const name = ts.slice(i + 1).find((x) => x.kind === 'word')?.text;
    if (!name) break;
    return { kind: containers[t.text], name: name.replace(/^.*::/, ''), bases: basesOf(ts, language) };
  }

  const fnWord = FUNCTION_WORD[language];
  if (ts.some((t) => t.kind === 'word' && control.has(t.text)) && !(fnWord && words.includes(fnWord))) return null;

  if (fnWord && words.includes(fnWord)) {
    const at = words.indexOf(fnWord);
    let name = words[at + 1];
    // `const load = function (id) {` names the function on the left.
    if (!name && (language === 'javascript' || language === 'typescript')) {
      const eq = ts.findIndex((x) => isPunct(x, '='));
      if (eq > 0 && isWord(ts[eq - 1])) name = ts[eq - 1].text;
    }
    return name ? { kind: 'function', name: bare(name), bases: [] } : null;
  }

  if (language === 'javascript' || language === 'typescript') {
    if (isPunct(ts[ts.length - 1], '>') && isPunct(ts[ts.length - 2], '=')) {
      // `const load = async (id) => {`
      for (let i = 0; i < ts.length; i++) if (isWord(ts[i], 'const', 'let', 'var') && isWord(ts[i + 1])) return { kind: 'function', name: ts[i + 1].text, bases: [] };
      return null;
    }
    if (inClass) {
      const open = topParen(ts);
      if (open > 0 && isWord(ts[open - 1]) && !control.has(ts[open - 1].text)) return { kind: 'function', name: ts[open - 1].text, bases: [] };
    }
    return null;
  }

  if (language === 'shell') {
    // `place_order() {`: the shell's parentheses are always empty.
    const n = ts.length;
    if (n >= 3 && isWord(ts[n - 3]) && isPunct(ts[n - 2], '(') && isPunct(ts[n - 1], ')') && !control.has(ts[n - 3].text)) return { kind: 'function', name: ts[n - 3].text, bases: [] };
    return null;
  }

  if (language === 'java' || language === 'c' || language === 'cpp' || language === 'other') {
    // A name, a parameter list, a block. What is in front of the name is types
    // and modifiers; `Repo::save` says whose method it is.
    const open = topParen(ts);
    if (open <= 0) return null;
    const before = ts.slice(0, open);
    // `: conn_(conn), pool_(pool)` is a constructor's initialiser list, the
    // tail of a header rather than one.
    if (before[0].kind === 'punct' && !isPunct(before[0], '~', '*', '&')) return null;
    if (before.some((t) => isPunct(t, '=') || t.text === '=>')) return null;
    const last = before[before.length - 1];
    if (!isWord(last) || control.has(last.text) || MODIFIERS.has(last.text)) return null;
    // A call spelled across lines (`foo(\n…\n) {`) has nothing in front of the
    // name; a definition has a type there, or is a method of the class it is in.
    if (before.length === 1 && !inClass && language !== 'other') return null;
    if (before.length >= 2 && isPunct(before[before.length - 2], '.', '>')) return null;
    let owner: string | undefined;
    if (before.length >= 4 && isPunct(before[before.length - 2], ':') && isPunct(before[before.length - 3], ':') && isWord(before[before.length - 4])) owner = before[before.length - 4].text;
    return { kind: 'function', name: last.text.replace(/^~/, ''), owner, bases: [] };
  }
  return null;
}

/** The types a class declaration says it is built on. */
function basesOf(ts: CodeToken[], language: ProgramLanguage): string[] {
  const out: string[] = [];
  if (language === 'java' || language === 'javascript' || language === 'typescript' || language === 'other') {
    for (let i = 0; i < ts.length; i++) {
      if (!isWord(ts[i], 'extends', 'implements')) continue;
      let last: string | null = null;
      for (let j = i + 1; j < ts.length; j++) {
        const t = ts[j];
        if (isWord(t, 'extends', 'implements')) break;
        if (isWord(t)) last = t.text;
        else if (isPunct(t, '.')) continue;
        else if (isPunct(t, '<')) {
          j = skipGenerics(ts, j) - 1;
          continue;
        } else if (isPunct(t, ',')) {
          if (last) out.push(last);
          last = null;
          continue;
        } else break;
      }
      if (last) out.push(last);
    }
  } else if (language === 'cpp') {
    const colon = ts.findIndex((t, i) => isPunct(t, ':') && !isPunct(ts[i + 1], ':') && !isPunct(ts[i - 1], ':'));
    if (colon >= 0) {
      for (let j = colon + 1; j < ts.length; j++) {
        if (isPunct(ts[j], '<')) {
          j = skipGenerics(ts, j) - 1;
          continue;
        }
        if (isWord(ts[j]) && !['public', 'private', 'protected', 'virtual'].includes(ts[j].text) && !(isPunct(ts[j + 1], ':') && isPunct(ts[j + 2], ':'))) out.push(ts[j].text);
      }
    }
  }
  return [...new Set(out)].slice(0, 4);
}

interface Frame {
  kind: 'class' | 'function' | 'namespace' | 'block';
  def?: SourceDefinition;
}

function outlineBraces(text: string, stmts: CodeStatement[], language: ProgramLanguage): SourceDefinition[] {
  const root: SourceDefinition[] = [];
  const stack: Frame[] = [];
  const holder = (): SourceDefinition[] => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].def) return stack[i].def!.members;
    return root;
  };
  const isDirective = (t: CodeToken | undefined) => Boolean(t) && (language === 'c' || language === 'cpp') && t!.text.startsWith('#');
  for (let si = 0; si < stmts.length; si++) {
    const ts = solid(stmts[si]);
    let seg = 0;
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      if (t.kind !== 'punct') continue;
      if (t.text === ';' && language !== 'shell') {
        seg = k + 1;
        continue;
      }
      if (t.text === '{') {
        const inCode = stack.some((f) => f.kind === 'function' || f.kind === 'block');
        const top = stack[stack.length - 1];
        let header = ts.slice(seg, k);
        let headerAt = si;
        let cls = !inCode ? classify(header, language, top?.kind === 'class') : null;
        // Allman braces, and a signature that runs on over lines without an
        // open bracket to hold it together: the header is the statement above.
        if (!inCode && (!cls || cls.kind === 'namespace') && seg === 0 && si > 0) {
          const prev = solid(stmts[si - 1]);
          const last = prev[prev.length - 1];
          if (prev.length && !isPunct(last, ';', '{', '}') && !isDirective(prev[0])) {
            const joined = classify([...prev, ...header], language, top?.kind === 'class');
            if (joined && (!cls || joined.kind !== 'namespace')) {
              cls = joined;
              header = [...prev, ...header];
              headerAt = si - 1;
            }
          }
        }
        if (cls && cls.kind !== 'namespace' && cls.name) {
          const lead = leadIn(text, stmts, headerAt, language);
          const sigStart = header.find((x) => !x.text.startsWith('@') && x.text !== '#')?.start ?? header[0]?.start ?? t.start;
          const def: SourceDefinition = {
            kind: cls.kind,
            name: cls.name,
            signature: collapse(text.slice(sigStart, header.length ? header[header.length - 1].end : t.start)),
            ...(cls.owner ? { owner: cls.owner } : {}),
            bases: cls.bases,
            ...(lead.doc ? { doc: lead.doc } : {}),
            spans: [{ start: lead.start, end: text.length }],
            body: { start: t.end, end: text.length },
            members: [],
          };
          holder().push(def);
          stack.push({ kind: cls.kind, def });
        } else stack.push({ kind: cls?.kind === 'namespace' ? 'namespace' : 'block' });
        seg = k + 1;
        continue;
      }
      if (t.text === '}') {
        const f = stack.pop();
        if (f?.def) {
          f.def.body.end = t.start;
          f.def.spans[0].end = lineEndOf(text, t.end);
        }
        seg = k + 1;
      }
    }
  }
  return adopt(root);
}

/**
 * Methods written outside their class — Go's `func (s *Service) Place`,
 * C++'s `void Repo::save`, every Rust `impl Repo` block — moved in under the
 * class they belong to, and a class declared more than once made one.
 */
function adopt(defs: SourceDefinition[]): SourceDefinition[] {
  const out: SourceDefinition[] = [];
  const classes = new Map<string, SourceDefinition>();
  for (const d of defs) {
    if (d.kind !== 'class') continue;
    const seen = classes.get(d.name);
    if (seen) {
      seen.spans.push(...d.spans);
      seen.members.push(...d.members);
      for (const b of d.bases) if (!seen.bases.includes(b)) seen.bases.push(b);
      seen.doc ??= d.doc;
    } else {
      classes.set(d.name, d);
      out.push(d);
    }
  }
  for (const d of defs) {
    if (d.kind === 'class') continue;
    if (!d.owner) {
      out.push(d);
      continue;
    }
    let cls = classes.get(d.owner);
    if (!cls) {
      cls = { kind: 'class', name: d.owner, signature: d.owner, bases: [], spans: [], body: { ...d.body }, members: [] };
      classes.set(d.owner, cls);
      out.push(cls);
    }
    cls.members.push(d);
    cls.spans.push(...d.spans);
  }
  // Keep them in the order the file has them.
  for (const c of classes.values()) c.spans.sort((a, b) => a.start - b.start);
  return out.sort((a, b) => (a.spans[0]?.start ?? 0) - (b.spans[0]?.start ?? 0));
}

/** What a paste defines, and the tokens and statements it is made of. */
export function outlineSource(text: string, language: ProgramLanguage): SourceOutline {
  const toks = lexCode(text, language);
  const stmts = codeStatements(text, toks, language);
  const definitions = language === 'python' ? outlinePython(text, stmts) : outlineBraces(text, stmts, language);
  let doc: string | undefined;
  let at = stmts.findIndex((st) => st.toks.length);
  // A shebang is not what the file says about itself.
  if (at >= 0 && !solid(stmts[at]).length && /^#!/.test(stmts[at].toks[0].text)) at++;
  if (at >= 0 && at < stmts.length) {
    const ts = solid(stmts[at]);
    if (language === 'python' && ts.length === 1 && ts[0].kind === 'string') doc = cleanDoc(ts[0].value ?? '');
    else if (!ts.length) {
      // The comment block the file opens with, up to the first blank line.
      const block: string[] = [];
      for (let i = at; i < stmts.length && !solid(stmts[i]).length; i++) {
        if (i > at && (text.slice(stmts[i - 1].lineEnd, stmts[i].lineStart).match(/\n/g) ?? []).length > 1) break;
        block.push(stmts[i].toks.map((t) => t.text).join('\n'));
      }
      doc = cleanDoc(block.join('\n'));
    }
  }
  // A comment that turns out to be the first definition's doc is not the file's.
  if (doc && definitions[0]?.doc === doc) doc = undefined;
  return { text, language, toks, stmts, definitions, ...(doc ? { doc } : {}) };
}

/** The text a definition stands for: all of its spans, indentation shared by the lines taken off. */
export function definitionSource(outline: SourceOutline, def: SourceDefinition): string {
  return def.spans.map((s) => dedent(outline.text.slice(lineStartOf(outline.text, s.start), s.end)).replace(/\s+$/, '')).join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Queries kept in named constants                                     */
/* ------------------------------------------------------------------ */

const SQL_START = /^\s*\(?\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CALL|COPY|TRUNCATE)\b/i;

/** Whether a string holds a statement rather than a sentence that happens to start with "Update". */
export function looksLikeSql(value: string): boolean {
  if (!SQL_START.test(value)) return false;
  const v = value.trim();
  if (/^CALL\b/i.test(v)) return /^CALL\s+[\w."`]+\s*\(/i.test(v);
  if (/^(?:INSERT|REPLACE)\b/i.test(v)) return /\bINTO\b/i.test(v) || /^REPLACE\s+\w+\s*\(/i.test(v);
  if (/^UPDATE\b/i.test(v)) return /\bSET\b/i.test(v);
  if (/^DELETE\b/i.test(v)) return /\bFROM\b/i.test(v);
  if (/^SELECT\b/i.test(v)) return /\bFROM\b/i.test(v) || /^SELECT\s+[\w."`]+\s*\(/i.test(v);
  if (/^WITH\b/i.test(v)) return /\bAS\s*\(/i.test(v);
  return true;
}

interface Constant {
  name: string;
  sql: string;
  /** The tokens of the definition: its name and its strings, none of which is a use. */
  toks: Set<CodeToken>;
  pos: number;
}

/**
 * Strings joined into one: adjacent literals, and literals joined with `+` or
 * Perl's `.`. Returns the value and the index after the last one taken, or null
 * when a joiner is followed by something that is not a literal — a hole.
 */
function joinStrings(ts: CodeToken[], at: number, language: ProgramLanguage): { value: string; end: number; toks: CodeToken[]; open: boolean } {
  let value = ts[at].value ?? '';
  const toks = [ts[at]];
  let i = at + 1;
  let open = false;
  // Only C, C++ and Python run adjacent literals together; in the shell two
  // strings side by side are two arguments, and a heredoc is always its own.
  const adjacent = language === 'c' || language === 'cpp' || language === 'python' || language === 'other';
  while (i < ts.length) {
    if (ts[i].kind === 'string' && adjacent && !ts[i].bodyEnd && !ts[i - 1].bodyEnd) {
      value += ts[i].value ?? '';
      toks.push(ts[i]);
      i++;
      continue;
    }
    const joiner = isPunct(ts[i], '+') || (language === 'perl' && isPunct(ts[i], '.'));
    if (joiner && ts[i + 1]?.kind === 'string') {
      value += ts[i + 1].value ?? '';
      toks.push(ts[i + 1]);
      i += 2;
      continue;
    }
    if (joiner) open = true;
    break;
  }
  return { value, end: i, toks, open };
}

function findConstants(outline: SourceOutline): Constant[] {
  const out: Constant[] = [];
  const { language } = outline;
  for (const st of outline.stmts) {
    const ts = solid(st);
    for (let i = 1; i < ts.length; i++) {
      const eq = ts[i];
      if (!(isPunct(eq, '=') && !isPunct(ts[i + 1], '=') && !isPunct(ts[i - 1], '=', '!', '<', '>', '+', '-'))) continue;
      // Go's `:=` arrives as ':' then '='.
      let lhsEnd = isPunct(ts[i - 1], ':') ? i - 1 : i;
      // Rust's `const Q: &str =` and Python's `Q: str =` name the constant before the colon.
      let segStart = lhsEnd - 1;
      while (segStart > 0 && !isPunct(ts[segStart - 1], ';', '{', '}', '(', ',')) segStart--;
      const colon = ts.slice(segStart, lhsEnd).findIndex((t) => isPunct(t, ':'));
      if (colon > 0) lhsEnd = segStart + colon;
      const nameTok = ts[lhsEnd - 1];
      if (!isWord(nameTok)) continue;
      let at = i + 1;
      let wrapped = 0;
      while (isPunct(ts[at], '(')) {
        wrapped++;
        at++;
      }
      if (ts[at]?.kind !== 'string') continue;
      const joined = joinStrings(ts, at, language);
      let end = joined.end;
      for (let w = 0; w < wrapped && isPunct(ts[end], ')'); w++) end++;
      const stop = ts[end];
      // Only a literal, standing alone: `"SELECT …" % args` or `.format(…)`
      // make the statement an expression rather than a named query.
      const alone = !joined.open && (!stop || isPunct(stop, ';', ')', ',') || (isWord(stop) && lineStartOf(outline.text, stop.start) !== lineStartOf(outline.text, ts[at].start)));
      if (!alone || !looksLikeSql(joined.value)) continue;
      out.push({ name: bare(nameTok.text), sql: joined.value, toks: new Set([nameTok, ...joined.toks]), pos: nameTok.start });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Imports                                                             */
/* ------------------------------------------------------------------ */

interface ImportRef {
  /** As written: a dotted name, a `::` path, a file path. */
  ref: string;
  /** For `from X import a, b`: the names, tried when X itself is not on the canvas. */
  names?: string[];
  /** `use parent 'Base'`: Perl's way of spelling inheritance. */
  extends?: boolean;
}

const PERL_PRAGMAS = new Set(['strict', 'warnings', 'utf8', 'feature', 'lib', 'constant', 'vars', 'overload', 'integer', 'bytes', 'open', 'if', 'version', 'diagnostics', 'sigtrap', 'subs', 'POSIX', 'Carp', 'Exporter', 'DBI', 'JSON', 'Encode', 'Storable']);

/** The imports a statement makes, or null when it is not an import. */
function importsOf(ts: CodeToken[], language: ProgramLanguage): ImportRef[] | null {
  const w0 = ts[0]?.text;
  // `a.b.c` or `a::b::c`: names and separators taking turns, so the word after
  // the last name (`import`, `as`) is not swallowed into it.
  const dotted = (from: number, sep: '.' | '::'): [string, number] => {
    let s = '';
    let i = from;
    let wantName = true;
    while (i < ts.length) {
      const t = ts[i];
      const isSep = sep === '.' ? isPunct(t, '.') : isPunct(t, ':') && isPunct(ts[i + 1], ':');
      if (isSep) {
        s += sep;
        i += sep.length;
        wantName = true;
      } else if (wantName && isWord(t)) {
        s += t.text;
        i++;
        wantName = false;
      } else break;
    }
    return [s, i];
  };
  switch (language) {
    case 'python': {
      if (w0 === 'import') {
        const refs: ImportRef[] = [];
        let i = 1;
        while (i < ts.length) {
          const [name, next] = dotted(i, '.');
          if (name) refs.push({ ref: name });
          i = next;
          if (isWord(ts[i], 'as')) i += 2;
          if (isPunct(ts[i], ',')) i++;
          else break;
        }
        return refs;
      }
      if (w0 === 'from') {
        const [mod, at] = dotted(1, '.');
        if (!isWord(ts[at], 'import')) return null;
        const names = ts
          .slice(at + 1)
          .filter((t, i, all) => isWord(t) && t.text !== 'as' && !isWord(all[i - 1], 'as'))
          .map((t) => t.text);
        return [{ ref: mod.replace(/^\.+/, ''), names }];
      }
      return null;
    }
    case 'javascript':
    case 'typescript': {
      if (w0 !== 'import' && w0 !== 'export') return null;
      const from = ts.findIndex((t) => isWord(t, 'from'));
      const str = from >= 0 ? ts[from + 1] : ts[1];
      if (str?.kind !== 'string' || (w0 === 'export' && from < 0)) return null;
      return [{ ref: str.value ?? '' }];
    }
    case 'rust': {
      let at = 0;
      if (isWord(ts[at], 'pub')) at = isPunct(ts[at + 1], '(') ? matchParen(ts, at + 1) + 1 : at + 1;
      if (isWord(ts[at], 'mod') && isWord(ts[at + 1]) && isPunct(ts[at + 2], ';')) return [{ ref: ts[at + 1].text }];
      if (!isWord(ts[at], 'use')) return null;
      const [path, next] = dotted(at + 1, '::');
      const names = isPunct(ts[next], '{') ? ts.slice(next).filter((t) => isWord(t) && t.text !== 'self').map((t) => t.text) : undefined;
      return [{ ref: path.replace(/::$/, ''), ...(names ? { names } : {}) }];
    }
    case 'go': {
      if (w0 !== 'import') return null;
      return ts.filter((t) => t.kind === 'string').map((t) => ({ ref: t.value ?? '' }));
    }
    case 'java': {
      if (w0 !== 'import') return null;
      const [path] = dotted(isWord(ts[1], 'static') ? 2 : 1, '.');
      return path ? [{ ref: path }] : [];
    }
    case 'c':
    case 'cpp': {
      if (!/^#\s*include$/.test(w0 ?? '') && !(w0 === '#' && isWord(ts[1], 'include'))) return null;
      const str = ts.find((t) => t.kind === 'string');
      return str ? [{ ref: str.value ?? '' }] : [];
    }
    case 'perl': {
      if (w0 !== 'use' && w0 !== 'require') return null;
      const [path, next] = dotted(1, '::');
      if (path === 'parent' || path === 'base') {
        const bases = ts
          .slice(next)
          .flatMap((t) => (t.kind === 'string' ? [t.value ?? ''] : isWord(t) && t.text !== 'qw' ? [t.text] : []))
          .flatMap((v) => v.split(/\s+/))
          .filter((v) => v && !v.startsWith('-'));
        return bases.map((b) => ({ ref: b, extends: true }));
      }
      if (!path || PERL_PRAGMAS.has(path) || /^[\d.]+$/.test(path)) return [];
      return [{ ref: path }];
    }
    case 'shell': {
      if (w0 !== 'source' && !(w0 === '.' && ts.length > 1)) return null;
      const target = ts[1];
      if (!target) return [];
      return [{ ref: target.kind === 'string' ? (target.value ?? '') : ts.slice(1).map((t) => t.text).join('') }];
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Resolving names against the diagram                                 */
/* ------------------------------------------------------------------ */

const stripExt = (name: string) => name.replace(/\.[A-Za-z0-9]+$/, '');
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
const DATA_EXT = /\.(?:ya?ml|json)$/i;

/**
 * Finds the node a name in the code means, from the point of view of the node
 * the code is in. Names only have to be unique among siblings, so of two
 * `save`s the one nearer in the tree wins: a sibling method before a function
 * in another module.
 */
class Resolver {
  private byId: Map<string, Program>;
  private chain: string[];
  constructor(
    private d: Diagram,
    private from: Program,
  ) {
    this.byId = new Map(d.programs.map((p) => [p.id, p]));
    this.chain = this.ancestors(from);
  }
  private ancestors(p: Program): string[] {
    const out = [p.id];
    const seen = new Set(out);
    let cur = p.parentId ? this.byId.get(p.parentId) : undefined;
    while (cur && !seen.has(cur.id)) {
      out.push(cur.id);
      seen.add(cur.id);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return out;
  }
  private distance(p: Program): number {
    const other = this.ancestors(p);
    for (let i = 0; i < this.chain.length; i++) {
      const j = other.indexOf(this.chain[i]);
      if (j >= 0) return i + j;
    }
    return 100 + other.length;
  }
  private best(candidates: Program[]): Program | undefined {
    let pick: Program | undefined;
    let score = Infinity;
    for (const c of candidates) {
      const s = this.distance(c);
      if (s < score) {
        pick = c;
        score = s;
      }
    }
    return pick;
  }
  /** A node a step of this op may name, called `name`. */
  code(op: ProgramStepOp, name: string, test: (p: Program) => boolean = () => true): Program | undefined {
    const fromKind = codeKindOf(this.from);
    const ok = (p: Program) => p.id !== this.from.id && canStepName(op, codeKindOf(p), fromKind) && test(p);
    const exact = this.d.programs.filter((p) => ok(p) && p.name === name);
    if (exact.length) return this.best(exact);
    const lower = name.toLowerCase();
    return this.best(this.d.programs.filter((p) => ok(p) && p.name.toLowerCase() === lower));
  }
  /** A module, class or file a path or dotted name refers to: `orders` finds orders.py, by name or by path. */
  module(ref: string, sep: RegExp, op: ProgramStepOp = 'import'): Program | undefined {
    const fromKind = codeKindOf(this.from);
    const parts = ref.split(sep).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = stripExt(parts[i]).toLowerCase();
      if (!seg || seg === '.' || seg === '..') continue;
      const hit = this.best(
        this.d.programs.filter(
          (p) => p.id !== this.from.id && canStepName(op, codeKindOf(p), fromKind) && (stripExt(p.name).toLowerCase() === seg || stripExt(baseName(p.entrypoint ?? '')).toLowerCase() === seg),
        ),
      );
      if (hit) return hit;
      // A dotted import names its module last and its package before it; a
      // path names its file last, and before that only directories, which are
      // no node.
      if (sep.source.includes('/')) break;
    }
    return undefined;
  }
  /** The data file a path in a string names. */
  dataFile(path: string): Program | undefined {
    const base = baseName(path).toLowerCase();
    if (!base) return undefined;
    return this.best(this.d.programs.filter((p) => isDataNode(p) && (p.name.toLowerCase() === base || baseName(p.entrypoint ?? '').toLowerCase() === base)));
  }
  routine(name: string): Program | undefined {
    const lower = name.toLowerCase();
    return this.d.programs.find((p) => isProcedure(p) && p.name.toLowerCase() === lower);
  }
}

function tableResolver(d: Diagram): (name: string) => Table | undefined {
  const byName = new Map<string, Table>();
  for (const t of d.tables) {
    if (!byName.has(t.name.toLowerCase())) byName.set(t.name.toLowerCase(), t);
    if (t.schema) byName.set(`${t.schema}.${t.name}`.toLowerCase(), t);
  }
  return (name) => byName.get(name.replace(/["`[\]]/g, '').toLowerCase());
}

/**
 * The columns of `table` a statement names, in the table's own order. A read
 * of `*` is the whole row, which is what an empty list already means.
 */
function columnsNamed(sql: string, table: Table, op: 'read' | 'write'): string[] {
  const segs = scanSql(sql).filter((s) => s.kind !== 'space' && s.kind !== 'comment');
  const words = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind === 'word' || s.kind === 'quoted') words.add(s.text.replace(/^["`[]|["`\]]$/g, '').toLowerCase());
  }
  if (op === 'read') {
    const star = segs.findIndex((s, i) => s.text === '*' && (segs[i - 1]?.text.toUpperCase() === 'SELECT' || segs[i - 1]?.text === '.' || segs[i - 1]?.text === ','));
    if (star >= 0) return [];
  }
  return table.columns.filter((c) => c.name && words.has(c.name.toLowerCase()) && c.name.toLowerCase() !== table.name.toLowerCase()).map((c) => c.id);
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/** A statement that is structure rather than work: a brace, an `else`, a bare return, an error check. */
function isTrivial(st: CodeStatement, text: string, language: ProgramLanguage): boolean {
  const ts = solid(st);
  if (!ts.length) return true;
  if (ts.every((t) => t.kind === 'punct')) return true;
  // A string on its own is a docstring, or a comment spelled as one.
  if (ts.every((t) => t.kind === 'string' || isPunct(t, ';'))) return true;
  const w0 = ts[0].kind === 'word' ? ts[0].text : isPunct(ts[0], '}') && isWord(ts[1]) ? ts[1].text : '';
  if (/^(?:raise|throw|die|croak|exit|break|continue|pass|else|elif|elsif|try|finally|except|catch|end|fi|done|esac|then|do|if|for|foreach|while|until|unless|switch|match|with|loop|case|default|select|defer|goto|static_assert|assert)$/.test(w0)) {
    // A condition or a loop header is shape; its body is where the work is.
    return true;
  }
  const src = text.slice(st.lineStart, st.lineEnd);
  if (w0 === 'return') return !/[(+\-*/%]/.test(src.replace(/^\s*return\b/, '')) || ts.length <= 4;
  // A driver's bookkeeping between the steps it serves: bind a parameter,
  // fetch the row, read a column, commit, close. Counted as work, these would
  // make every read a compute.
  if (GLUE.test(src) && !/[+\-*/%]\s*[\w(]/.test(src.replace(/\[[^\]]*\]|\([^()]*\)/g, ''))) return true;
  if (importsOf(ts, language)) return true;
  // A declaration with nothing assigned: `var id int64`, `int total;`, `my $row;`.
  if (language !== 'shell' && !ts.some((t) => isPunct(t, '=', '(') || t.kind === 'string' || t.kind === 'number') && ts.filter((t) => t.kind === 'word').length <= 4) return true;
  return false;
}
/** Words a call may follow: `return f(x)`, `await f(x)`, `new Foo(x)`. After any other word, `name(` declares. */
const CALL_AFTER = new Set([
  'return', 'new', 'await', 'yield', 'throw', 'case', 'else', 'do', 'typeof', 'delete', 'in', 'of', 'and', 'or', 'not', 'if', 'elif', 'while', 'unless',
  'until', 'when', 'then', 'echo', 'print', 'go', 'defer', 'try', 'is', 'lambda', 'assert', 'raise', 'with', 'as', 'from', 'co_await', 'co_return', 'move', 'match',
]);

const GLUE =
  /(?:\.|->|::)(?:fetch\w*|commit|rollback|close|cursor|scan|next|err|finish|execute\w*|exec\w*|query\w*|prepare\w*|bind\w*|release|end|step|reset|finalize|all|one|first|run|(?:set|get)(?:String|Long|Int|Integer|Object|Double|Boolean|Timestamp|Date|Null|Bytes|Float|Short|BigDecimal)|column_\w+|rows_affected|last_insert_id|last_insert_rowid)\s*\(/i;

interface Found {
  /** Index of the statement it came from. */
  stmt: number;
  pos: number;
  steps: ProgramStep[];
}

interface Region {
  start: number;
  end: number;
  /** Spans inside it that belong to something else: the members a container hands its definitions to. */
  skip: { start: number; end: number }[];
}

const inRegion = (pos: number, r: Region) => pos >= r.start && pos < r.end && !r.skip.some((s) => pos >= s.start && pos < s.end);

interface ReadContext {
  outline: SourceOutline;
  constants: Constant[];
  /** Constants some code uses: their definitions are not steps, the uses are. */
  used: Set<Constant>;
  /** Token -> statement index. */
  stmtOf: Map<CodeToken, number>;
}

function readContext(outline: SourceOutline): ReadContext {
  const constants = findConstants(outline);
  const stmtOf = new Map<CodeToken, number>();
  outline.stmts.forEach((st, i) => st.toks.forEach((t) => stmtOf.set(t, i)));
  const used = new Set<Constant>();
  const byName = new Map<string, Constant[]>();
  for (const c of constants) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const t of outline.toks) {
    for (const name of referencedNames(t, outline.language)) {
      for (const c of byName.get(name) ?? []) if (!c.toks.has(t)) used.add(c);
    }
  }
  return { outline, constants, used, stmtOf };
}

/** The constant names a token could be a use of: a word, or `$NAME` inside a shell or Perl string. */
function referencedNames(t: CodeToken, language: ProgramLanguage): string[] {
  if (t.kind === 'word') return [bare(t.text)];
  if (t.kind === 'string' && (language === 'shell' || language === 'perl')) return [...(t.value ?? '').matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)].map((m) => m[1]);
  return [];
}

/** The definition of a constant a use at `pos` means: the last one before it, or the first there is. */
function constantFor(ctx: ReadContext, name: string, pos: number): Constant | undefined {
  const all = ctx.constants.filter((c) => c.name === name);
  if (!all.length) return undefined;
  return [...all].reverse().find((c) => c.pos < pos) ?? all[0];
}

/** Whether the shell would run this word as a command: first on its line, or after a pipe, `$(`, `;`, `&&`, `then`, `do`. */
function atCommand(ts: CodeToken[], i: number, text: string): boolean {
  const prev = ts[i - 1];
  if (!prev) return true;
  if (lineStartOf(text, prev.start) !== lineStartOf(text, ts[i].start)) return true;
  if (isPunct(prev, '|', ';', '&', '{', '`', '!')) return true;
  if (isPunct(prev, '(') && (ts[i - 2]?.text === '$' || !ts[i - 2])) return true;
  return isWord(prev, 'then', 'do', 'else', 'time', 'exec', 'if', 'while', 'until');
}

/**
 * The steps a region of code implies, in order: its queries, its calls, its
 * imports and the files it loads, with a compute step for each run of real
 * work in between that touches none of them.
 */
function stepsForRegion(ctx: ReadContext, region: Region, d: Diagram, node: Program): ProgramStep[] {
  const { outline } = ctx;
  const { text, language, stmts } = outline;
  const resolve = new Resolver(d, node);
  const table = tableResolver(d);
  const found: Found[] = [];
  const seenCode = new Set<string>();
  const add = (stmt: number, pos: number, steps: ProgramStep[]) => {
    const kept = steps.filter((s) => {
      if (!s.codeId || s.op === 'read' || s.op === 'write') return true;
      const key = `${s.op}:${s.codeId}`;
      if (seenCode.has(key)) return false;
      seenCode.add(key);
      return true;
    });
    if (kept.length) found.push({ stmt, pos, steps: kept });
  };
  const sqlSteps = (sql: string): ProgramStep[] => {
    const steps = stepsFromBody(sql, table, (name) => resolve.routine(name));
    for (const s of steps) {
      if ((s.op === 'read' || s.op === 'write') && s.tableId) {
        const t = d.tables.find((x) => x.id === s.tableId);
        // What an INSERT hands back is not what it writes.
        if (t) s.columnIds = columnsNamed((s.sql ?? sql).replace(s.op === 'write' ? /\bRETURNING\b[\s\S]*$/i : /$^/, ''), t, s.op);
      }
      // A CALL the SQL makes is still the statement the host code runs.
      if (s.op === 'call') {
        s.sql = undefined;
      }
    }
    return steps;
  };
  const codeStep = (op: ProgramStepOp, target: Program | undefined): ProgramStep[] => (target ? [createProgramStep({ op, codeId: target.id })] : []);

  const fromKind = codeKindOf(node);
  const importsHandled = new Set<number>();
  for (let si = 0; si < stmts.length; si++) {
    const st = stmts[si];
    const ts = solid(st);
    if (!ts.some((t) => inRegion(t.start, region))) continue;
    const imports = importsOf(ts, language);
    if (imports && !importsHandled.has(si)) {
      importsHandled.add(si);
      const sep = language === 'javascript' || language === 'typescript' || language === 'go' || language === 'c' || language === 'cpp' || language === 'shell' ? /[\\/]/ : language === 'rust' || language === 'perl' ? /::/ : /\./;
      for (const imp of imports) {
        if (imp.extends) {
          add(si, ts[0].start, codeStep('extends', resolve.code('extends', imp.ref.split('::').pop()!)));
          continue;
        }
        if (DATA_EXT.test(imp.ref)) {
          add(si, ts[0].start, codeStep('load', resolve.dataFile(imp.ref)));
          continue;
        }
        const target = imp.ref ? resolve.module(imp.ref, sep) : undefined;
        if (target) add(si, ts[0].start, codeStep('import', target));
        else for (const n of imp.names ?? []) add(si, ts[0].start, codeStep('import', resolve.module(n, sep)));
      }
      continue;
    }
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!inRegion(t.start, region)) continue;
      if (t.kind === 'string') {
        const joined = joinStrings(ts, i, language);
        i = joined.end - 1;
        const own = ctx.constants.find((c) => c.toks.has(t));
        if (own && ctx.used.has(own)) continue;
        const value = joined.value;
        if (looksLikeSql(value)) {
          add(si, t.start, sqlSteps(value));
        } else if (DATA_EXT.test(value.trim()) && !/\s/.test(value.trim())) {
          add(si, t.start, codeStep('load', resolve.dataFile(value.trim())));
        } else if (/^[\w.]+$/.test(value) && ts.some((x) => isWord(x) && /^(?:callproc|callProc|call|prepareCall)$/i.test(x.text))) {
          const routine = resolve.routine(value.replace(/^.*\./, ''));
          if (routine && canStepName('call', 'procedure', fromKind)) add(si, t.start, codeStep('call', routine));
        }
        // `"$LOCK"`: a shell or Perl string that interpolates a named query.
        for (const name of referencedNames(t, language)) {
          const c = constantFor(ctx, name, t.start);
          if (c && !c.toks.has(t)) add(si, t.start, sqlSteps(c.sql));
        }
        continue;
      }
      if (t.kind !== 'word') continue;
      const name = bare(t.text);
      const c = constantFor(ctx, name, t.start);
      if (c && !c.toks.has(t)) {
        add(si, t.start, sqlSteps(c.sql));
        continue;
      }
      // JavaScript's `require('./inventory')` and `import('./x')` are imports wherever they stand.
      if ((language === 'javascript' || language === 'typescript') && (name === 'require' || name === 'import') && isPunct(ts[i + 1], '(') && ts[i + 2]?.kind === 'string') {
        const ref = ts[i + 2].value ?? '';
        add(si, t.start, DATA_EXT.test(ref) ? codeStep('load', resolve.dataFile(ref)) : codeStep('import', resolve.module(ref, /[\\/]/)));
        i += 2;
        continue;
      }
      const called = language === 'shell' ? atCommand(ts, i, text) : isPunct(ts[i + 1], '(') || (language === 'perl' && t.text.startsWith('&'));
      if (!called) continue;
      if (isWord(ts[i - 1], 'def', 'function', 'fn', 'func', 'sub', 'class', 'struct')) continue;
      // `long total_cents(const struct line *cart, int lines);`: a type in front
      // of the name makes it a declaration of the function, not a call to it.
      if (language !== 'shell' && language !== 'perl' && (isWord(ts[i - 1]) || (isPunct(ts[i - 1], '*', '&') && isWord(ts[i - 2]))) && !CALL_AFTER.has((isWord(ts[i - 1]) ? ts[i - 1] : ts[i - 2]).text)) continue;
      const target = resolve.code('call', name);
      if (target) add(si, t.start, codeStep('call', target));
    }
  }

  return withCode(found, region, ctx);
}

/**
 * The steps with the code they came from, and compute steps for the work in
 * between. Each step's code is its statement plus the lines leading into it
 * since the step before; a run of three or more statements that do real work
 * and touch nothing becomes a compute step holding them instead. Three, not
 * one: a line of error handling or a log call is not the work a program
 * exists for, and a step list that says "compute" after every read says
 * nothing.
 */
function withCode(found: Found[], region: Region, ctx: ReadContext): ProgramStep[] {
  const { outline } = ctx;
  const { text, language, stmts } = outline;
  const inside: number[] = [];
  stmts.forEach((st, i) => {
    if (st.toks.some((t) => inRegion(t.start, region))) inside.push(i);
  });
  const byStmt = new Map<number, ProgramStep[]>();
  for (const f of found.sort((a, b) => a.pos - b.pos)) byStmt.set(f.stmt, [...(byStmt.get(f.stmt) ?? []), ...f.steps]);

  // The lines a run of statements covers, each once: two statements sharing
  // a line (`a(); b();`) are one line of code, not two copies of it.
  const sliceOf = (idx: number[]): string => {
    let out = '';
    let covered = -1;
    let prevEnd = -1;
    for (const i of idx) {
      const st = stmts[i];
      const start = Math.max(st.lineStart, covered);
      const end = st.lineEnd;
      if (end <= covered) continue;
      if (prevEnd >= 0) {
        const gap = text.slice(prevEnd, start);
        out += region.skip.some((s) => s.start >= prevEnd && s.start < start) || gap.trim() ? '\n' : gap;
      }
      out += text.slice(start, end);
      covered = end;
      prevEnd = end;
    }
    return dedent(out).replace(/^\s*\n/, '').replace(/\s+$/, '');
  };
  const out: ProgramStep[] = [];
  let pending: number[] = [];
  // A named query's definition is not work either: it runs where it is used.
  const defines = (i: number) => stmts[i].toks.some((t) => ctx.constants.some((c) => c.toks.has(t)));
  const real = (idx: number[]) => idx.filter((i) => !isTrivial(stmts[i], text, language) && !defines(i)).length;
  const firstComment = (idx: number[]) => {
    for (const i of idx) {
      const c = stmts[i].toks.find((t) => t.kind === 'comment');
      if (c) return cleanDoc(c.text);
    }
    return undefined;
  };
  const flushCompute = () => {
    if (real(pending) >= 3) {
      const note = firstComment(pending);
      out.push(createProgramStep({ op: 'compute', code: sliceOf(pending), ...(note ? { note } : {}) }));
      pending = [];
      return true;
    }
    return false;
  };
  for (const i of inside) {
    const steps = byStmt.get(i);
    if (!steps) {
      pending.push(i);
      continue;
    }
    flushCompute();
    const code = sliceOf([...pending, i]);
    for (const s of steps) out.push({ ...s, ...(code ? { code } : {}) });
    pending = [];
  }
  if (!flushCompute() && pending.length && out.length) {
    const last = out[out.length - 1];
    const tail = sliceOf(pending);
    if (tail.trim()) last.code = last.code ? `${last.code}\n${tail}` : tail;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading a paste into the diagram                                    */
/* ------------------------------------------------------------------ */

export interface SourceReading {
  language: ProgramLanguage;
  /** Steps drawn on the node itself. */
  steps: number;
  /** Member nodes made for definitions the node did not already hold. */
  created: number;
  /** Members that already existed by that name, read again. */
  updated: number;
  /** The node took the name of the one definition the paste is. */
  renamed?: string;
}

/** Whether what is in a node's signature box was a signature rather than a path someone typed. */
function looksLikeSignature(s: string | undefined): boolean {
  if (!s?.trim()) return true;
  return /\(/.test(s) || /^\s*(?:async\s+)?(?:def|class|fn|func|function|sub|struct|impl|interface|type|pub|public|private|protected|static|export)\b/.test(s);
}

/**
 * What a paste is, for a node that has none yet: one function, one class, a
 * file of several, or a script. Decides the kind a canvas paste makes.
 */
export function pastedKind(outline: SourceOutline): { kind: CodeKind; name?: string } {
  const defs = outline.definitions;
  const ctx = readContext(outline);
  const topLevelWork = outline.stmts.some((st) => {
    const ts = solid(st);
    if (!ts.length || defs.some((d) => d.spans.some((s) => ts[0].start >= s.start && ts[0].start < s.end))) return false;
    if (importsOf(ts, outline.language)) return false;
    if (ctx.constants.some((c) => ts.some((t) => c.toks.has(t)))) return false;
    return !isTrivial(st, outline.text, outline.language) && !(ts[0].text === 'package' || ts[0].text.startsWith('#'));
  });
  if (defs.length === 1 && !topLevelWork) return { kind: defs[0].kind, name: defs[0].name };
  if (defs.length >= 1) return { kind: topLevelWork ? 'program' : 'module' };
  return { kind: 'program' };
}

export interface ReadIntoOptions {
  /** Placement sizes for new members, so they stack under what is already drawn. */
  sizes?: SizeMap;
  /** The language to read in; otherwise the node's own, or a guess when the node has none. */
  language?: ProgramLanguage;
}

/**
 * Read `source` into the code node `programId` of `d`, in place: the code is
 * kept on the node, its steps are drawn, and what it defines becomes members.
 *
 *  - Pasted into a function, the paste is that function: one definition names
 *    the node, gives it its signature and doc, and its body is the steps; a
 *    bare body is read as one.
 *  - Pasted into a class, a class definition is the class — its bases become
 *    extends steps, its methods members — and a list of functions becomes its
 *    methods.
 *  - Pasted into a module or a program, every definition becomes a member
 *    (read again in place when one by that name is already inside), and what
 *    is left at the top level — the imports, a script's own statements — is the
 *    node's own steps.
 *
 * Returns null when the node cannot hold code: a data file, or a procedure,
 * whose body is SQL and has its own reader.
 */
export function readSourceInto(d: Diagram, programId: string, source: string, opts: ReadIntoOptions = {}): SourceReading | null {
  const node = d.programs.find((p) => p.id === programId);
  if (!node || isDataNode(node) || isProcedure(node)) return null;
  const kind = codeKindOf(node);
  const fresh = !node.steps.length && !node.source?.trim() && !d.programs.some((p) => p.parentId === node.id);
  // The node's own language stands unless it has none, or it is a node nobody
  // has written anything in yet and the paste plainly is not in its language —
  // a Go function pasted into a map that has so far been Python.
  const guessed = opts.language ?? (node.language === 'other' || (fresh && !readsAs(source, node.language)) ? guessLanguage(source) : null);
  const language: ProgramLanguage = guessed && guessed !== 'yaml' && guessed !== 'json' ? guessed : node.language;
  node.language = language;
  node.source = source;
  const outline = outlineSource(source, language);
  const ctx = readContext(outline);
  const reading: SourceReading = { language, steps: 0, created: 0, updated: 0 };
  const whole: Region = { start: 0, end: source.length, skip: [] };

  const defs = outline.definitions;
  const single = defs.length === 1 && defs[0].kind === (kind === 'class' ? 'class' : 'function') && (kind === 'function' || kind === 'class') ? defs[0] : undefined;

  // Pass one: what the paste defines, as nodes, so pass two can draw calls
  // between them — a call can only name a node that has an id.
  const jobs: { node: Program; region?: Region; bases?: string[] }[] = [];
  const upsert = (parent: Program, def: SourceDefinition): void => {
    const want: CodeKind = def.kind;
    if (!canContain(codeKindOf(parent), want)) return;
    let member = d.programs.find((p) => p.parentId === parent.id && p.name === def.name && codeKindOf(p) === want);
    if (member) reading.updated++;
    else {
      member = createProgram({
        name: uniqueProgramName(d, def.name, parent.id),
        kind: want,
        parentId: parent.id,
        language,
        color: parent.color,
        position: nextCodePosition(d, parent.id, { x: parent.position.x + 40, y: parent.position.y + 60 }, opts.sizes),
      });
      d.programs.push(member);
      reading.created++;
    }
    member.language = language;
    member.source = definitionSource(outline, def);
    if (looksLikeSignature(member.entrypoint)) member.entrypoint = def.signature;
    if (def.doc && !member.comment?.trim()) member.comment = def.doc;
    if (def.kind === 'class') {
      jobs.push({ node: member, bases: def.bases });
      for (const m of def.members) upsert(member, m);
    } else jobs.push({ node: member, region: { ...def.body, skip: [] } });
  };

  if (single) {
    if (node.name !== single.name) {
      node.name = uniqueProgramName({ ...d, programs: d.programs.filter((p) => p.id !== node.id) } as Diagram, single.name, node.parentId);
      reading.renamed = node.name;
    }
    if (looksLikeSignature(node.entrypoint)) node.entrypoint = single.signature;
    if (single.doc && !node.comment?.trim()) node.comment = single.doc;
    if (single.kind === 'function') jobs.push({ node, region: { ...single.body, skip: [] } });
    else {
      jobs.push({ node, bases: single.bases });
      for (const m of single.members) upsert(node, m);
    }
  } else if (kind === 'function') {
    // A function is the leaf of the map: whatever is pasted into one is its body.
    jobs.push({ node, region: whole });
  } else {
    for (const def of defs) upsert(node, def);
    if (outline.doc && !node.comment?.trim() && kind !== 'class') node.comment = outline.doc;
    jobs.push({ node, region: { ...whole, skip: defs.flatMap((x) => x.spans) } });
  }

  // Pass two: the steps.
  for (const job of jobs) {
    const steps: ProgramStep[] = [];
    for (const b of job.bases ?? []) {
      const target = new Resolver(d, job.node).code('extends', b, (p) => codeKindOf(p) === 'class') ?? new Resolver(d, job.node).code('extends', b);
      if (target) steps.push(createProgramStep({ op: 'extends', codeId: target.id }));
    }
    if (job.region) steps.push(...stepsForRegion(ctx, job.region, d, job.node));
    job.node.steps = steps;
    if (job.node === node) reading.steps = steps.length;
  }
  return reading;
}

