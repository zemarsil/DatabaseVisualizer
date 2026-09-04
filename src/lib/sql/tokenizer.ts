/**
 * A small, dialect-tolerant SQL tokenizer. It understands:
 *  - bare words / keywords
 *  - quoted identifiers: "pg style" and `mariadb style`
 *  - string literals with '' escaping and backslash escapes, plus $$dollar$$ quoting
 *  - numbers, punctuation and multi-char operators (::, <=, >=, <>, !=, ||)
 *  - line (--, #) and block comments
 *
 * Every token keeps its source offsets so callers can slice raw text back out
 * (used for DEFAULT expressions and CHECK bodies, which we keep verbatim).
 */

export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  /** For words this is the raw text; use `upper` for keyword comparisons. */
  value: string;
  upper: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

const MULTI_PUNCT = ['::', '<=', '>=', '<>', '!=', '||', '->>', '->', '=>', '@>', '<@', '**'];

function isWordStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

export class SqlSyntaxError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(message);
    this.name = 'SqlSyntaxError';
  }
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = sql.length;

  const push = (type: TokenType, value: string, start: number, end: number, startLine: number, startCol: number) => {
    tokens.push({ type, value, upper: type === 'word' ? value.toUpperCase() : value, start, end, line: startLine, col: startCol });
  };

  while (i < n) {
    const ch = sql[i];

    // newlines / whitespace
    if (ch === '\n') {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }

    // comments
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const startLine = line;
      const startCol = i - lineStart + 1;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= n) throw new SqlSyntaxError('Unterminated block comment', startLine, startCol);
      i += 2;
      continue;
    }

    const start = i;
    const startLine = line;
    const startCol = i - lineStart + 1;

    // dollar-quoted strings ($$ ... $$ or $tag$ ... $tag$)
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) throw new SqlSyntaxError('Unterminated dollar-quoted string', startLine, startCol);
        const body = sql.slice(i + tag.length, close);
        for (const c of body) if (c === '\n') line++;
        i = close + tag.length;
        lineStart = sql.lastIndexOf('\n', i - 1) + 1;
        push('string', body, start, i, startLine, startCol);
        continue;
      }
    }

    // string literal (plain, E'..' or N'..')
    if (ch === "'" || ((ch === 'E' || ch === 'N' || ch === 'e' || ch === 'n') && sql[i + 1] === "'")) {
      if (ch !== "'") i++;
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        const c = sql[i];
        if (c === "'") {
          if (sql[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (c === '\\' && i + 1 < n) {
          const nx = sql[i + 1];
          out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          i += 2;
          continue;
        }
        if (c === '\n') {
          line++;
          lineStart = i + 1;
        }
        out += c;
        i++;
      }
      if (!closed) throw new SqlSyntaxError('Unterminated string literal', startLine, startCol);
      push('string', out, start, i, startLine, startCol);
      continue;
    }

    // quoted identifiers
    if (ch === '"' || ch === '`') {
      const closeCh = ch;
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        const c = sql[i];
        if (c === closeCh) {
          if (sql[i + 1] === closeCh) {
            out += closeCh;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (c === '\n') throw new SqlSyntaxError('Newline inside quoted identifier', startLine, startCol);
        out += c;
        i++;
      }
      if (!closed) throw new SqlSyntaxError('Unterminated quoted identifier', startLine, startCol);
      push('quoted', out, start, i, startLine, startCol);
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(?:0x[0-9A-Fa-f]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(sql.slice(i));
      const text = m ? m[0] : ch;
      i += text.length;
      push('number', text, start, i, startLine, startCol);
      continue;
    }

    // words (identifiers / keywords)
    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j++;
      push('word', sql.slice(i, j), start, j, startLine, startCol);
      i = j;
      continue;
    }

    // multi-char operators
    let matched = false;
    for (const op of MULTI_PUNCT) {
      if (sql.startsWith(op, i)) {
        i += op.length;
        push('punct', op, start, i, startLine, startCol);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // single punct
    i++;
    push('punct', ch, start, i, startLine, startCol);
  }

  tokens.push({ type: 'eof', value: '', upper: '', start: n, end: n, line, col: n - lineStart + 1 });
  return tokens;
}
