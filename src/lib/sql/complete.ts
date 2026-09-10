/**
 * Autocomplete for the SQL editors: what to offer at the caret, and how to
 * put the choice into the text. Pure functions, so the ranking can be tested
 * without a DOM.
 *
 * Candidates come from the scope (the diagram's tables and columns), the
 * aliases declared in the text itself (`FROM orders o` makes `o.` offer the
 * columns of orders), and the keyword and function lists the highlighter
 * uses. `table.` narrows to that table; otherwise columns of the tables the
 * text already mentions come first, since those are the ones being written
 * about.
 */
import { fuzzyScore } from '../fuzzy';
import { SQL_FUNCTIONS, SQL_KEYWORDS, inLiteralAt, scanSql, tableAliases, type SqlScope, type SqlScopeTable } from './highlight';

export type CompletionKind = 'column' | 'table' | 'keyword' | 'function' | 'snippet';

export interface CompletionItem {
  /** Shown in the list. */
  label: string;
  /** Put into the text; usually the label, `NAME()` for a function. */
  insert: string;
  kind: CompletionKind;
  /** Column type, owning table, or a short explanation. */
  detail?: string;
  /** The caret lands this many characters before the end of `insert`: 1 for `fn()`. */
  caretBack?: number;
}

export interface WordAtCaret {
  /** The identifier prefix before the caret; empty when the caret follows punctuation or space. */
  word: string;
  start: number;
  end: number;
  /** The name before a dot immediately preceding the word: `orders` in `orders.st|`. */
  qualifier: string | null;
}

export interface CompletionResult {
  items: CompletionItem[];
  /** Replace text[from, to) with the chosen item's insert. */
  from: number;
  to: number;
  word: string;
  qualifier: string | null;
}

export interface CompletionOptions {
  /** Ctrl+Space: offer everything, even with nothing typed. */
  explicit?: boolean;
  /** Items always offered, e.g. columns reachable through foreign keys as `table.column`. */
  extras?: CompletionItem[];
  /** Offer keywords and functions (default true). Expression fields still get functions. */
  keywords?: boolean;
  /** Characters typed before the list opens by itself (default 2; a qualifier opens it at once). */
  minChars?: number;
  /** Cap on the list (default 12). */
  limit?: number;
}

/** The keywords a query is mostly made of; the long tail of the keyword list ranks below functions. */
const COMMON_KEYWORDS = new Set(
  `SELECT FROM WHERE JOIN ON AND OR NOT IN IS NULL AS GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE
   LEFT RIGHT INNER FULL OUTER CROSS UNION ALL DISTINCT CASE WHEN THEN ELSE END EXISTS BETWEEN LIKE ILIKE ASC DESC WITH RETURNING
   CONFLICT DO NOTHING TRUE FALSE OVER PARTITION CREATE TABLE VIEW INDEX PRIMARY KEY FOREIGN REFERENCES UNIQUE CHECK DEFAULT
   ALTER DROP ADD COLUMN CAST INTERVAL USING EXCLUDED DUPLICATE`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD_TAIL = /([A-Za-z_][A-Za-z0-9_$]*)$/;
const QUALIFIER_TAIL = /(?:([A-Za-z_][A-Za-z0-9_$]*)|"((?:[^"]|"")+)"|`((?:[^`]|``)+)`)\.$/;

/** The identifier being typed at `caret`, and what qualifies it. */
export function wordAtCaret(text: string, caret: number): WordAtCaret {
  const before = text.slice(0, caret);
  const m = WORD_TAIL.exec(before);
  const word = m ? m[1] : '';
  const start = caret - word.length;
  const q = QUALIFIER_TAIL.exec(before.slice(0, start));
  const qualifier = q ? (q[1] ?? q[2]?.replace(/""/g, '"') ?? q[3]?.replace(/``/g, '`')) : null;
  return { word, start, end: caret, qualifier };
}

/** Table names the text mentions (as words), lower-cased. */
function mentionedTables(text: string, tables: Map<string, SqlScopeTable>): Set<string> {
  const out = new Set<string>();
  for (const s of scanSql(text)) {
    if (s.kind !== 'word' && s.kind !== 'quoted') continue;
    const name = s.text.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
    const t = tables.get(name);
    if (t) out.add(t.name.toLowerCase());
  }
  return out;
}

function caseLike(word: string, upper: string): string {
  return word && word === word.toLowerCase() ? upper.toLowerCase() : upper;
}

interface Scored {
  item: CompletionItem;
  /** 0 prefix match, 1 fuzzy. */
  tier: number;
  priority: number;
  score: number;
}

/**
 * What to offer at the caret, or null when there is nothing worth showing:
 * inside a string, too little typed, or the only match is what is already
 * there.
 */
export function completions(text: string, caret: number, scope: SqlScope | undefined, opts: CompletionOptions = {}): CompletionResult | null {
  if (inLiteralAt(text, caret)) return null;
  const at = wordAtCaret(text, caret);
  const { word, qualifier } = at;
  const minChars = opts.minChars ?? 2;
  if (!opts.explicit && !qualifier && word.length < minChars) return null;

  const tables = new Map<string, SqlScopeTable>();
  for (const t of scope?.tables ?? []) {
    tables.set(t.name.toLowerCase(), t);
    if (t.schema) tables.set(`${t.schema}.${t.name}`.toLowerCase(), t);
  }

  const raw: { item: CompletionItem; priority: number }[] = [];
  if (qualifier) {
    const aliases = tableAliases(text);
    const key = qualifier.toLowerCase();
    const table = tables.get(key) ?? tables.get((aliases.get(key) ?? '').toLowerCase());
    if (table) {
      for (const c of table.columns) raw.push({ item: { label: c.name, insert: c.name, kind: 'column', detail: c.type }, priority: 0 });
    }
    // schema.table
    for (const t of scope?.tables ?? []) {
      if (t.schema && t.schema.toLowerCase() === key) raw.push({ item: { label: t.name, insert: t.name, kind: 'table', detail: t.hint ?? 'table' }, priority: 1 });
    }
    if (raw.length === 0) return null;
  } else {
    const mentioned = mentionedTables(text, tables);
    if (scope?.primary) mentioned.add(scope.primary.toLowerCase());
    const seen = new Map<string, { item: CompletionItem; priority: number; owners: string[] }>();
    const addColumn = (t: SqlScopeTable, c: { name: string; type: string }, priority: number) => {
      const key = c.name.toLowerCase();
      const hit = seen.get(key);
      if (hit) {
        hit.owners.push(t.name);
        if (priority < hit.priority) {
          hit.priority = priority;
          hit.item.detail = c.type;
        }
        return;
      }
      seen.set(key, { item: { label: c.name, insert: c.name, kind: 'column', detail: c.type }, priority, owners: [t.name] });
    };
    // With a primary table, bare names mean its columns; other tables' columns come as table.column extras.
    const bareTables = scope?.primary ? (scope.tables ?? []).filter((t) => t.name.toLowerCase() === scope.primary!.toLowerCase()) : (scope?.tables ?? []);
    // Ranks: columns of the tables written about, then the everyday keywords, tables, other columns, functions, rare keywords.
    for (const t of bareTables) for (const c of t.columns) addColumn(t, c, mentioned.has(t.name.toLowerCase()) ? 0 : 3);
    for (const entry of seen.values()) {
      if (entry.owners.length > 1 && !scope?.primary) entry.item.detail = `${entry.item.detail} · ${entry.owners.slice(0, 3).join(', ')}${entry.owners.length > 3 ? '…' : ''}`;
      raw.push(entry);
    }
    for (const t of scope?.tables ?? []) {
      if (scope?.primary && t.name.toLowerCase() === scope.primary.toLowerCase()) continue;
      raw.push({ item: { label: t.name, insert: t.name, kind: 'table', detail: t.hint ?? (t.schema ? `${t.schema}.${t.name}` : 'table') }, priority: 2 });
    }
    for (const x of opts.extras ?? []) raw.push({ item: x, priority: 2 });
    if (opts.keywords !== false) {
      for (const k of SQL_KEYWORDS) raw.push({ item: { label: k, insert: caseLike(word, k), kind: 'keyword' }, priority: COMMON_KEYWORDS.has(k) ? 1 : 5 });
    }
    for (const f of SQL_FUNCTIONS) {
      raw.push({ item: { label: `${f}()`, insert: `${caseLike(word, f)}()`, kind: 'function', caretBack: 1 }, priority: 4 });
    }
  }

  const lowerWord = word.toLowerCase();
  const scored: Scored[] = [];
  for (const { item, priority } of raw) {
    const label = item.label.replace(/\(\)$/, '');
    if (!lowerWord) {
      scored.push({ item, tier: 0, priority, score: 0 });
      continue;
    }
    const low = label.toLowerCase();
    // orders.status matches "sta" on its column part
    const last = low.includes('.') ? low.slice(low.lastIndexOf('.') + 1) : low;
    if (low.startsWith(lowerWord) || last.startsWith(lowerWord)) {
      scored.push({ item, tier: 0, priority, score: 1000 - label.length });
      continue;
    }
    // Fuzzy only for names one might misremember (columns, tables), and only once three letters narrow it down.
    if (word.length >= 3 && (item.kind === 'column' || item.kind === 'table' || item.kind === 'snippet')) {
      const s = fuzzyScore(word, label);
      if (s !== null) scored.push({ item, tier: 1, priority, score: s });
    }
  }
  scored.sort((a, b) => a.tier - b.tier || a.priority - b.priority || b.score - a.score || a.item.label.localeCompare(b.item.label));
  const items = scored.slice(0, opts.limit ?? 12).map((s) => s.item);
  if (items.length === 0) return null;
  // Nothing to add: the one candidate is exactly what is typed.
  if (!opts.explicit && items.length === 1 && items[0].label.replace(/\(\)$/, '').toLowerCase() === lowerWord && items[0].kind !== 'function') return null;
  return { items, from: at.start, to: at.end, word, qualifier };
}

/** The text with the item put in place of the typed prefix, and where the caret goes. */
export function applyCompletion(text: string, result: Pick<CompletionResult, 'from' | 'to'>, item: CompletionItem): { text: string; caret: number } {
  let insert = item.insert;
  let back = item.caretBack ?? 0;
  // Completing a function name right before an existing "(" must not double the parens.
  if (item.kind === 'function' && insert.endsWith('()') && text.slice(result.to).trimStart().startsWith('(')) {
    insert = insert.slice(0, -2);
    back = 0;
  }
  const next = text.slice(0, result.from) + insert + text.slice(result.to);
  return { text: next, caret: result.from + insert.length - back };
}
