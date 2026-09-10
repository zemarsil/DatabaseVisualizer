/**
 * A pretty-printer for the SQL typed into the app: tagged queries, view
 * definitions, the Query tab. It is built on the tolerant scanner, so it
 * never fails on text the parser would reject, and it only moves whitespace
 * and re-cases keywords — strings, quoted names, numbers, comments and the
 * order of everything else come through untouched.
 *
 * The shape it produces is the common one: each clause on its own line, a
 * list that fits on one line stays there, a list that does not gets one entry
 * per line, subqueries and CREATE TABLE bodies indent inside their
 * parentheses, WHERE breaks before AND / OR once it is too long. Running it
 * twice gives the same text as running it once.
 */
import { SQL_KEYWORDS, scanSql, type SqlSegment } from './highlight';

export interface FormatOptions {
  /** Line width a clause may fill before its list is broken up (default 80). */
  width?: number;
  /** One level of indentation (default two spaces). */
  indent?: string;
}

/** Words that begin a clause: a newline goes before them, at the level of the statement they are in. */
const CLAUSE_START = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INSERT',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'RETURNING',
  'WITH',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'FULL',
  'CROSS',
  'NATURAL',
  'WINDOW',
  'CREATE',
  'ALTER',
  'DROP',
  'FETCH',
]);

/** (previous word, this word): the second continues the first, so it does not start a clause of its own. */
const CONTINUES: Record<string, Set<string>> = {
  LEFT: new Set(['JOIN', 'OUTER']),
  RIGHT: new Set(['JOIN', 'OUTER']),
  INNER: new Set(['JOIN']),
  FULL: new Set(['JOIN', 'OUTER']),
  CROSS: new Set(['JOIN']),
  NATURAL: new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL']),
  OUTER: new Set(['JOIN']),
  INSERT: new Set(['INTO']),
  DELETE: new Set(['FROM']),
  GROUP: new Set(['BY']),
  ORDER: new Set(['BY']),
  PARTITION: new Set(['BY']),
  UNION: new Set(['ALL', 'DISTINCT']),
  INTERSECT: new Set(['ALL', 'DISTINCT']),
  EXCEPT: new Set(['ALL', 'DISTINCT']),
  ON: new Set(['CONFLICT', 'DUPLICATE']),
  DUPLICATE: new Set(['KEY']),
  KEY: new Set(['UPDATE']),
  DO: new Set(['UPDATE', 'NOTHING']),
  CREATE: new Set(['TABLE', 'VIEW', 'INDEX', 'UNIQUE', 'TEMP', 'TEMPORARY', 'MATERIALIZED', 'OR', 'EXTENSION', 'TYPE', 'SCHEMA', 'SEQUENCE', 'TRIGGER', 'FUNCTION']),
  OR: new Set(['REPLACE']),
  ALTER: new Set(['TABLE', 'VIEW', 'TYPE', 'INDEX', 'SEQUENCE']),
  DROP: new Set(['TABLE', 'VIEW', 'INDEX', 'TYPE', 'EXTENSION', 'SCHEMA', 'SEQUENCE', 'TRIGGER']),
  WITH: new Set(['RECURSIVE']),
  FETCH: new Set(['FIRST', 'NEXT']),
  FOR: new Set(['UPDATE', 'SHARE']),
  UNIQUE: new Set(['INDEX']),
  TEMP: new Set(['TABLE']),
  TEMPORARY: new Set(['TABLE']),
  MATERIALIZED: new Set(['VIEW']),
  IS: new Set(['NOT', 'NULL', 'TRUE', 'FALSE', 'DISTINCT']),
  NOT: new Set(['EXISTS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'NULL', 'MATERIALIZED']),
  IF: new Set(['NOT', 'EXISTS']),
};

/** Clauses whose body is a comma list: broken one entry per line when long. */
const LIST_CLAUSES = new Set(['SELECT', 'GROUP BY', 'ORDER BY', 'SET', 'RETURNING', 'VALUES', 'WITH', 'WITH RECURSIVE', 'PARTITION BY', 'WINDOW']);
/** Clauses whose body is a condition: broken before AND / OR when long. */
const CONDITION_CLAUSES = new Set(['WHERE', 'HAVING']);

/** Keywords that keep a space before a parenthesis; any other word typed tight against "(" is a call and stays tight. */
const SPACED_BEFORE_PAREN = new Set([
  'IN', 'EXISTS', 'ON', 'AS', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'THEN', 'ELSE', 'WHEN', 'SELECT', 'JOIN', 'USING', 'BY', 'WITH',
  'DISTINCT', 'FILTER', 'OVER', 'RETURNING', 'SET', 'KEY', 'CONFLICT', 'INTO', 'UPDATE', 'INSERT', 'DELETE', 'BETWEEN', 'LIKE', 'IS',
  'NULL', 'TRUE', 'FALSE', 'END', 'TABLE', 'VIEW', 'INDEX', 'CHECK', 'DEFAULT', 'REFERENCES', 'UNIQUE', 'PRIMARY', 'LIMIT', 'OFFSET',
  'HAVING', 'ORDER', 'GROUP', 'PARTITION', 'WINDOW', 'ROWS', 'RANGE', 'CASE', 'ANY', 'ALL', 'SOME', 'RECURSIVE', 'LATERAL', 'ENUM',
]);

/** Operators written without spaces around them. */
const TIGHT_OPS = new Set(['::', '.', '->', '->>', '#>', '#>>']);
const NO_SPACE_BEFORE = new Set([',', ')', ']', ';', ...TIGHT_OPS]);
const NO_SPACE_AFTER = new Set(['(', '[', ...TIGHT_OPS]);

/** A `--` comment that followed the node on its line stays glued to it, after any comma. */
type Node = { kind: 'tok'; seg: SqlSegment; ownLine: boolean; trail?: string } | { kind: 'paren'; children: Node[]; block: 'query' | 'list' | null; open: SqlSegment; close: SqlSegment | null; trail?: string };

const word = (n: Node | undefined): string => (n && n.kind === 'tok' && n.seg.kind === 'word' ? n.seg.text.toUpperCase() : '');
const punct = (n: Node | undefined): string => (n && n.kind === 'tok' && n.seg.kind === 'punct' ? n.seg.text : '');

/** Group the segments into a tree of parentheses, deciding which parens are blocks. */
function buildTree(text: string): Node[] {
  const segs = scanSql(text);
  const root: Node[] = [];
  const stack: { children: Node[]; open: SqlSegment; parent: Node[] }[] = [];
  let children = root;
  let sawNewline = true;
  let afterCreateTable = false;
  for (const s of segs) {
    if (s.kind === 'space') {
      if (s.text.includes('\n')) sawNewline = true;
      continue;
    }
    if (s.kind === 'punct' && s.text === '(') {
      stack.push({ children, open: s, parent: children });
      const node: Node = { kind: 'paren', children: [], block: null, open: s, close: null };
      // CREATE TABLE name ( ... ) lists its columns one per line.
      if (afterCreateTable) {
        node.block = 'list';
        afterCreateTable = false;
      }
      children.push(node);
      children = node.children;
      sawNewline = false;
      continue;
    }
    if (s.kind === 'punct' && s.text === ')') {
      const frame = stack.pop();
      if (frame) {
        const node = frame.parent[frame.parent.length - 1] as Extract<Node, { kind: 'paren' }>;
        node.close = s;
        if (!node.block) {
          const first = word(node.children[0]);
          if (first === 'SELECT' || first === 'WITH' || first === 'VALUES') node.block = 'query';
        }
        children = frame.parent;
      } else {
        children.push({ kind: 'tok', seg: s, ownLine: false }); // stray close paren: keep it
      }
      sawNewline = false;
      continue;
    }
    if (s.kind === 'word') {
      const up = s.text.toUpperCase();
      if (up === 'TABLE') {
        const prev = children[children.length - 1];
        const p = word(prev);
        if (p === 'CREATE' || p === 'TEMP' || p === 'TEMPORARY' || p === 'UNLOGGED') afterCreateTable = true;
      } else if (afterCreateTable && (up === 'AS' || up === 'SELECT' || up === 'LIKE')) afterCreateTable = false;
      else if (up === 'CREATE' || up === 'INSERT' || up === 'SELECT') afterCreateTable = false;
    }
    if (s.kind === 'punct' && s.text === ';') afterCreateTable = false;
    if (s.kind === 'comment' && s.text.startsWith('--') && !sawNewline && children.length) {
      // a line comment after some code on its line: keep it on that code's line, after the comma if there is one
      let host = children[children.length - 1];
      if (punct(host) === ',' && children.length > 1) host = children[children.length - 2];
      host.trail = host.trail ? `${host.trail} ${s.text}` : s.text;
      continue;
    }
    children.push({ kind: 'tok', seg: s, ownLine: s.kind === 'comment' && (sawNewline || !children.length) });
    sawNewline = false;
  }
  return root;
}

interface Clause {
  /** Upper-cased head words, e.g. "LEFT JOIN", "GROUP BY"; empty for text before any clause word. */
  head: string;
  body: Node[];
  /** A comment that stood on its own line: rendered as is. */
  comment?: string;
}

/** Split a statement's nodes into clauses at the words that start one. */
function splitClauses(nodes: Node[]): Clause[] {
  const out: Clause[] = [];
  let cur: Clause = { head: '', body: [] };
  let i = 0;
  const flush = () => {
    if (cur.head || cur.body.length) out.push(cur);
    cur = { head: '', body: [] };
  };
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.kind === 'tok' && n.seg.kind === 'comment' && n.ownLine) {
      flush();
      out.push({ head: '', body: [], comment: n.seg.text });
      i++;
      continue;
    }
    const w = word(n);
    const prevWord = word(nodes[i - 1]);
    const continues = Boolean(prevWord && CONTINUES[prevWord]?.has(w));
    // ON starts a clause only as ON CONFLICT / ON DUPLICATE
    // VALUES(a) in ON DUPLICATE KEY UPDATE a = VALUES(a) is a function, not the clause
    const valuesCall = w === 'VALUES' && punct(nodes[i - 1]) !== '' && punct(nodes[i - 1]) !== ')';
    const startsClause = w && !continues && !valuesCall && (CLAUSE_START.has(w) || (w === 'ON' && CONTINUES.ON.has(word(nodes[i + 1]))));
    if (startsClause) {
      flush();
      const head = [w];
      let j = i + 1;
      while (j < nodes.length && CONTINUES[head[head.length - 1]]?.has(word(nodes[j]))) {
        head.push(word(nodes[j]));
        j++;
      }
      cur = { head: head.join(' '), body: [] };
      i = j;
      continue;
    }
    cur.body.push(n);
    i++;
  }
  flush();
  return out;
}

class Printer {
  constructor(
    private readonly width: number,
    private readonly unit: string,
  ) {}

  private pad(level: number): string {
    return this.unit.repeat(level);
  }

  /** Tokens on one line, spaced the way SQL is usually written. */
  inline(nodes: Node[], level: number, omitLastTrail = false): string {
    let out = '';
    let afterBreak = false;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const prev = nodes[i - 1];
      let text: string;
      if (n.kind === 'paren') text = this.paren(n, level);
      else if (n.seg.kind === 'word') text = SQL_KEYWORDS.has(n.seg.text.toUpperCase()) && punct(prev) !== '.' ? n.seg.text.toUpperCase() : n.seg.text;
      else text = n.seg.text;
      if (prev && !afterBreak) {
        const p = punct(prev);
        const c = punct(n);
        let space = true;
        if (c && NO_SPACE_BEFORE.has(c)) space = false;
        else if (p && NO_SPACE_AFTER.has(p)) space = false;
        else if (n.kind === 'paren' && prev.kind === 'tok' && p === ')' && n.open.start === prev.seg.end) space = false; // (a)(b)
        else if (n.kind === 'paren' && prev.kind === 'tok' && (prev.seg.kind === 'word' || prev.seg.kind === 'quoted')) {
          // count(*), CAST(x AS y): a call is tight; IN (…), VALUES (…) keep their space
          const up = prev.seg.text.toUpperCase();
          const keyword = prev.seg.kind === 'word' && SQL_KEYWORDS.has(up);
          const adjacent = n.open.start === prev.seg.end;
          if (adjacent && (!keyword || !SPACED_BEFORE_PAREN.has(up))) space = false;
        } else if ((p === '-' || p === '+') && isUnary(nodes, i - 1)) space = false; // -1, not - 1
        if (space) out += ' ';
      }
      afterBreak = false;
      out += text;
      const last = i === nodes.length - 1;
      if (n.trail && !(last && omitLastTrail)) {
        out += ` ${n.trail}`;
        if (!last) {
          out += `\n${this.pad(level)}`;
          afterBreak = true;
        }
      } else if (n.kind === 'tok' && n.seg.kind === 'comment' && n.seg.text.startsWith('--') && !last) {
        out += `\n${this.pad(level)}`;
        afterBreak = true;
      }
    }
    return out;
  }

  /** A comma list, one entry per line; a trailing comment goes after the comma. */
  private entries(entries: Node[][], level: number): string[] {
    return entries.map((e, i) => {
      const trail = e.length ? e[e.length - 1].trail : undefined;
      return `${this.pad(level)}${this.inline(e, level, true)}${i < entries.length - 1 ? ',' : ''}${trail ? ` ${trail}` : ''}`;
    });
  }

  /** A parenthesised group: inline, or a block with its content indented inside. */
  private paren(n: Extract<Node, { kind: 'paren' }>, level: number): string {
    const close = n.close ? ')' : '';
    if (n.block === 'query') return `(\n${this.pad(level + 1)}${this.statement(n.children, level + 1)}\n${this.pad(level)}${close}`;
    if (n.block === 'list') {
      const lines = this.entries(splitAt(n.children, (x) => punct(x) === ','), level + 1);
      return `(\n${lines.join('\n')}\n${this.pad(level)}${close}`;
    }
    return `(${this.inline(n.children, level)}${close}`;
  }

  /** One clause: head + body, on one line when it fits, else broken the way its kind of list breaks. */
  private clause(c: Clause, level: number): string {
    const pad = this.pad(level);
    if (c.comment !== undefined) return `${pad}${c.comment}`;
    const bodyInline = this.inline(c.body, level);
    const oneLine = c.head ? (bodyInline ? `${c.head} ${bodyInline}` : c.head) : bodyInline;
    const fits = !oneLine.includes('\n') && pad.length + oneLine.length <= this.width;
    if (!c.head || fits) return `${pad}${oneLine}`;

    if (LIST_CLAUSES.has(c.head)) {
      const entries = splitAt(c.body, (x) => punct(x) === ',');
      if (entries.length <= 1 && !oneLine.includes('\n')) return `${pad}${oneLine}`;
      if (c.head.startsWith('WITH')) {
        // WITH x AS (...),\ny AS (...)  — hanging, so the query below stays at the margin
        return this.entries(entries, level)
          .map((line, i) => (i === 0 ? `${pad}${c.head} ${line.slice(pad.length)}` : line))
          .join('\n');
      }
      return `${pad}${c.head}\n${this.entries(entries, level + 1).join('\n')}`;
    }
    if (CONDITION_CLAUSES.has(c.head) || c.head.endsWith('JOIN')) {
      // WHERE a\n  AND b; for a JOIN the ON condition breaks the same way after the first AND
      const parts = splitConditions(c.body);
      if (parts.length > 1) {
        const first = `${pad}${c.head} ${this.inline(parts[0].nodes, level)}`;
        const rest = parts.slice(1).map((p) => `${this.pad(level + 1)}${p.op} ${this.inline(p.nodes, level + 1)}`);
        return [first, ...rest].join('\n');
      }
    }
    return `${pad}${oneLine}`;
  }

  /** A statement (or a subquery's body): its clauses, one per line. */
  statement(nodes: Node[], level: number): string {
    const clauses = splitClauses(nodes);
    return clauses
      .map((c) => this.clause(c, level))
      .join('\n')
      .replace(new RegExp(`^${this.pad(level)}`), '');
  }
}

/** The sign at nodes[i] is unary when what precedes it cannot end an operand. */
function isUnary(nodes: Node[], i: number): boolean {
  const before = nodes[i - 1];
  if (!before) return true;
  if (before.kind === 'paren') return false;
  if (before.seg.kind === 'punct') return before.seg.text !== ')' && before.seg.text !== ']';
  if (before.seg.kind === 'word') return SQL_KEYWORDS.has(before.seg.text.toUpperCase()) && !/^(?:END|NULL|TRUE|FALSE)$/.test(before.seg.text.toUpperCase());
  return false;
}

function splitAt(nodes: Node[], isSep: (n: Node) => boolean): Node[][] {
  const out: Node[][] = [[]];
  for (const n of nodes) {
    if (isSep(n)) out.push([]);
    else out[out.length - 1].push(n);
  }
  return out.filter((e, i) => e.length || i === 0);
}

/** A condition split at its top-level AND / OR: the operator that precedes each part after the first. */
function splitConditions(nodes: Node[]): { op: string; nodes: Node[] }[] {
  const out: { op: string; nodes: Node[] }[] = [{ op: '', nodes: [] }];
  let depthCase = 0;
  let betweenPending = false;
  for (const n of nodes) {
    const w = word(n);
    if (w === 'CASE') depthCase++;
    else if (w === 'END' && depthCase > 0) depthCase--;
    else if (w === 'BETWEEN') betweenPending = true;
    if ((w === 'AND' || w === 'OR') && depthCase === 0) {
      // the AND of BETWEEN x AND y belongs to the BETWEEN
      if (w === 'AND' && betweenPending) betweenPending = false;
      else {
        out.push({ op: w, nodes: [] });
        continue;
      }
    }
    out[out.length - 1].nodes.push(n);
  }
  return out.filter((p, i) => p.nodes.length || i === 0);
}

/** Pretty-print SQL. Text the scanner cannot make sense of comes back with its tokens intact, just re-spaced. */
export function formatSql(text: string, opts: FormatOptions = {}): string {
  const width = opts.width ?? 80;
  const unit = opts.indent ?? '  ';
  const tree = buildTree(text);
  // Statements are separated by ";" at the top level.
  const statements: Node[][] = [[]];
  for (const n of tree) {
    statements[statements.length - 1].push(n);
    if (punct(n) === ';') statements.push([]);
  }
  const printer = new Printer(width, unit);
  const out: string[] = [];
  for (const nodes of statements) {
    if (!nodes.length) continue;
    const ends = punct(nodes[nodes.length - 1]) === ';';
    const body = ends ? nodes.slice(0, -1) : nodes;
    if (!body.length) {
      // a lone ";" — glue it to the previous statement
      if (out.length) out[out.length - 1] += ';';
      continue;
    }
    // "SELECT 1 -- note\n;" — the semicolon must not end up inside the comment
    const lastNode = body[body.length - 1];
    let tail = ends ? ';' : '';
    if (ends && lastNode.trail) {
      tail = `; ${lastNode.trail}`;
      delete lastNode.trail;
    }
    const trailOfSemi = ends ? nodes[nodes.length - 1].trail : undefined;
    if (trailOfSemi) tail += ` ${trailOfSemi}`;
    out.push(printer.statement(body, 0) + tail);
  }
  return out.join('\n\n');
}
