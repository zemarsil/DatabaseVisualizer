/**
 * What a keystroke means inside a SQL editor, and the text edits it makes.
 *
 * Like editorKeys.ts for the column grid, this lives away from React so the
 * behaviour can be exercised without a DOM: the component turns a
 * KeyboardEvent into a KeySpec, asks what it means, and applies the edit to
 * (text, selectionStart, selectionEnd).
 */
import type { KeySpec } from './editorKeys';

/** A textarea's text and selection. `start === end` is a plain caret. */
export interface EditState {
  text: string;
  start: number;
  end: number;
}

export type EditorKeyAction =
  /** Open the completion list (Ctrl+Space). */
  | 'complete'
  /** Take the highlighted completion. */
  | 'accept'
  /** Close the completion list. */
  | 'close'
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'indent'
  | 'outdent'
  /** Enter in a multi-line editor: a new line that keeps the indentation. */
  | 'newline'
  /** Ctrl+/: comment the selected lines out, or back in. */
  | 'comment'
  /** Ctrl+Shift+F. */
  | 'format'
  /** Ctrl+Enter: run, import, detect — whatever the editor is for. */
  | 'submit'
  /** Swallow the key: Enter in a single-line field must not add a line. */
  | 'noop';

export interface EditorKeyContext {
  popupOpen: boolean;
  multiline: boolean;
  hasSubmit: boolean;
}

function letter(e: KeySpec): string {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key.length === 1 ? e.key.toLowerCase() : '';
}

/** What the key does here, or null to leave it to the browser. */
export function editorKeyAction(e: KeySpec, ctx: EditorKeyContext): EditorKeyAction | null {
  const mod = Boolean(e.ctrlKey || e.metaKey);
  if (mod && e.key === ' ') return 'complete';
  if (ctx.popupOpen) {
    switch (e.key) {
      case 'ArrowDown':
        return 'down';
      case 'ArrowUp':
        return 'up';
      case 'PageDown':
        return 'pageDown';
      case 'PageUp':
        return 'pageUp';
      case 'Enter':
        return mod ? (ctx.hasSubmit ? 'submit' : 'accept') : 'accept';
      case 'Tab':
        return e.shiftKey ? null : 'accept';
      case 'Escape':
        return 'close';
      default:
        break;
    }
  }
  if (mod && e.key === 'Enter') return ctx.hasSubmit ? 'submit' : null;
  if (mod && !e.shiftKey && (e.key === '/' || e.code === 'Slash')) return ctx.multiline ? 'comment' : null;
  if (mod && e.shiftKey && letter(e) === 'f') return ctx.multiline ? 'format' : null;
  if (e.key === 'Tab' && !mod && !e.altKey) return ctx.multiline ? (e.shiftKey ? 'outdent' : 'indent') : null;
  if (e.key === 'Enter' && !mod && !e.altKey) {
    if (ctx.multiline) return e.shiftKey ? null : 'newline';
    return ctx.hasSubmit ? 'submit' : 'noop';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Text edits                                                          */
/* ------------------------------------------------------------------ */

export function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

export function lineEnd(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i === -1 ? text.length : i;
}

/** The leading whitespace of the line `pos` is on. */
export function lineIndent(text: string, pos: number): string {
  const start = lineStart(text, pos);
  const m = /^[ \t]*/.exec(text.slice(start, lineEnd(text, pos)));
  return m ? m[0] : '';
}

/**
 * Tab / Shift+Tab. A caret with nothing selected inserts the unit (or, on
 * Shift+Tab, removes one from the front of its line); a selection shifts
 * every line it touches.
 */
export function indentSelection(s: EditState, outdent: boolean, unit = '  '): EditState {
  const { text } = s;
  if (s.start === s.end && !outdent) {
    return { text: text.slice(0, s.start) + unit + text.slice(s.end), start: s.start + unit.length, end: s.start + unit.length };
  }
  const from = lineStart(text, s.start);
  const to = lineEnd(text, Math.max(s.start, s.end === s.start ? s.end : s.end - 1));
  const block = text.slice(from, to);
  const lines = block.split('\n');
  let firstDelta = 0;
  let total = 0;
  const shifted = lines.map((line, i) => {
    let next: string;
    if (outdent) {
      const strip = line.startsWith(unit) ? unit.length : line.startsWith('\t') ? 1 : /^ +/.exec(line)?.[0].length ?? 0;
      next = line.slice(strip);
    } else next = unit + line;
    const delta = next.length - line.length;
    if (i === 0) firstDelta = delta;
    total += delta;
    return next;
  });
  const nextText = text.slice(0, from) + shifted.join('\n') + text.slice(to);
  // a selection that starts at the line start stays there: the lines moved, not the anchor
  const start = s.start === from ? from : Math.max(from, s.start + firstDelta);
  const end = Math.max(start, s.end + total);
  return { text: nextText, start, end };
}

/**
 * Enter: a new line indented like the current one, one level deeper after an
 * opening parenthesis. When the caret sits between "(" and ")", the closing
 * one moves to its own line.
 */
export function newlineWithIndent(s: EditState, unit = '  '): EditState {
  const { text } = s;
  const before = text.slice(0, s.start);
  const after = text.slice(s.end);
  const indent = lineIndent(text, s.start);
  const opens = /\($/.test(before.trimEnd());
  const closes = /^\s*\)/.test(after);
  let insert = `\n${indent}${opens ? unit : ''}`;
  let caret = s.start + insert.length;
  if (opens && closes) insert += `\n${indent}`;
  return { text: before + insert + after, start: caret, end: caret };
}

/** Ctrl+/: prefix every selected line with "-- ", or strip it from all of them when every line has one. */
export function toggleLineComment(s: EditState): EditState {
  const { text } = s;
  const from = lineStart(text, s.start);
  const to = lineEnd(text, Math.max(s.start, s.end > s.start ? s.end - 1 : s.end));
  const lines = text.slice(from, to).split('\n');
  const allCommented = lines.every((l) => /^\s*--/.test(l) || !l.trim());
  const anyContent = lines.some((l) => l.trim());
  let total = 0;
  let firstDelta = 0;
  const next = lines.map((line, i) => {
    let out: string;
    if (allCommented && anyContent) out = line.replace(/^(\s*)--\s?/, '$1');
    else if (!line.trim() && lines.length > 1) out = line;
    else out = line.replace(/^(\s*)/, '$1-- ');
    const delta = out.length - line.length;
    if (i === 0) firstDelta = delta;
    total += delta;
    return out;
  });
  const nextText = text.slice(0, from) + next.join('\n') + text.slice(to);
  // the marker goes in after the first line's indentation; a caret before that point does not move
  const insertAt = from + (/^\s*/.exec(lines[0])?.[0].length ?? 0);
  const start = s.start < insertAt || s.start === from ? s.start : Math.max(from, s.start + firstDelta);
  return { text: nextText, start, end: Math.max(start, s.end + total) };
}

const PAIRS: Record<string, string> = { '(': ')', "'": "'", '"': '"' };

/**
 * Typing an opening bracket or quote with nothing after the caret (or a
 * closing one) puts the pair in and leaves the caret between; typing over a
 * selection wraps it. Returns null when the key should just be typed.
 */
export function autoClosePair(s: EditState, ch: string): EditState | null {
  const close = PAIRS[ch];
  if (!close) return null;
  const { text } = s;
  if (s.start !== s.end) {
    const inner = text.slice(s.start, s.end);
    return { text: text.slice(0, s.start) + ch + inner + close + text.slice(s.end), start: s.start + 1, end: s.start + 1 + inner.length };
  }
  const next = text[s.start] ?? '';
  const prev = text[s.start - 1] ?? '';
  // a quote right after a word is an apostrophe, and '' inside a string is an escaped quote
  if (ch === "'" || ch === '"') {
    if (/[A-Za-z0-9_]/.test(prev) || prev === ch) return null;
    if (next === ch) return null;
  }
  if (next && !/[\s)\],;:]/.test(next)) return null;
  return { text: text.slice(0, s.start) + ch + close + text.slice(s.start), start: s.start + 1, end: s.start + 1 };
}

/** Typing the closing character that is already next: step over it. */
export function stepOverClosing(s: EditState, ch: string): EditState | null {
  if (s.start !== s.end || !Object.values(PAIRS).includes(ch)) return null;
  if (s.text[s.start] !== ch) return null;
  return { text: s.text, start: s.start + 1, end: s.start + 1 };
}

/** Backspace between the two halves of an empty pair removes both. */
export function deleteEmptyPair(s: EditState): EditState | null {
  if (s.start !== s.end || s.start === 0) return null;
  const prev = s.text[s.start - 1];
  const close = PAIRS[prev];
  if (!close || s.text[s.start] !== close) return null;
  return { text: s.text.slice(0, s.start - 1) + s.text.slice(s.start + 1), start: s.start - 1, end: s.start - 1 };
}

/**
 * Put `snippet` in at the caret, replacing any selection. `spaced` keeps a
 * space between the snippet and a word it would otherwise run into, which is
 * what a chip inserting a column name into an expression wants. `caretBack`
 * puts the caret that many characters before the end of the snippet.
 */
export function insertSnippet(s: EditState, snippet: string, opts: { spaced?: boolean; caretBack?: number } = {}): EditState {
  const { text } = s;
  let before = text.slice(0, s.start);
  let after = text.slice(s.end);
  let piece = snippet;
  if (opts.spaced) {
    if (before && !/[\s(]$/.test(before)) piece = ` ${piece}`;
    if (after && !/^[\s),]/.test(after)) piece = `${piece} `;
  }
  before += piece;
  const caret = before.length - (opts.caretBack ?? 0) - (opts.spaced && after && !/^[\s),]/.test(after) ? 1 : 0);
  return { text: before + after, start: caret, end: caret };
}

/** Offset of (1-based) line and column, clamped to the text. */
export function offsetOfLine(text: string, line: number, col = 1): number {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) return text.length;
    pos = nl + 1;
  }
  return Math.min(lineEnd(text, pos), pos + Math.max(0, col - 1));
}

/** 1-based line and column of an offset. */
export function lineColAt(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  return { line, col: pos - lineStart(text, pos) + 1 };
}
