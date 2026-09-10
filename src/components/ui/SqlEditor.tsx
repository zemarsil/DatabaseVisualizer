import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Maximize2, Wand2 } from 'lucide-react';
import { Modal } from './Modal';
import { highlightSql, type HighlightSpan, type SqlScope } from '@/lib/sql/highlight';
import { applyCompletion, completions, type CompletionItem, type CompletionResult } from '@/lib/sql/complete';
import { checkExpression, checkStatement, referencedTables, type SqlDiagnostic } from '@/lib/sql/analyze';
import { formatSql } from '@/lib/sql/format';
import {
  autoClosePair,
  deleteEmptyPair,
  editorKeyAction,
  indentSelection,
  insertSnippet,
  lineColAt,
  newlineWithIndent,
  offsetOfLine,
  stepOverClosing,
  toggleLineComment,
  type EditState,
} from '@/lib/sqlEditorKeys';
import '@/styles/sqleditor.css';

/**
 * The one SQL editor: a textarea with a coloured copy of its text laid over
 * it, so it keeps everything a textarea gives for free (native undo, IME,
 * selection, drag-resize) and adds what typing SQL wants — highlighting that
 * knows the diagram's names, completion of tables, columns, keywords and
 * functions, live checking, indentation-aware keys, a formatter, and a
 * bigger version of itself in a dialog for when the inspector is too narrow.
 *
 * Statement mode is for a query, a view or DDL; expression mode is for one
 * expression of a data flow, checked with the simulator's own parser.
 */
export type SqlEditorMode = 'statement' | 'expression' | 'ddl';

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Tables and columns to colour, complete and check against. */
  scope?: SqlScope;
  mode?: SqlEditorMode;
  /** One line, no newlines: for an expression, a filter, a default. */
  multiline?: boolean;
  rows?: number;
  /** Fill a flex column (the drawer tabs) instead of sizing to `rows`. */
  fill?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Ctrl+Enter (Enter in a single-line editor). */
  onSubmit?: () => void;
  /** What Ctrl+Enter does, for the hint under the editor: "runs" (default), "imports", … */
  submitLabel?: string;
  /** Extra completion items, e.g. columns reachable through foreign keys as table.column. */
  extras?: CompletionItem[];
  /** Live diagnostics under the editor (default on). */
  check?: boolean;
  /** Expression mode: only warn about unknown columns, never about syntax the simulator's language lacks. */
  lenient?: boolean;
  /** Offer a bigger editor in a dialog. */
  expandable?: boolean;
  /** Title of that dialog. */
  title?: string;
  /** Extra controls at the right of the status row. */
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The status row (position, mentions, buttons) always shows; by default a single-line editor shows it only for a problem. */
  status?: 'auto' | 'always' | 'never';
  ref?: Ref<SqlEditorHandle>;
}

export interface SqlEditorHandle {
  focus(): void;
  /** Put text in at the caret (replacing the selection); `spaced` keeps a space between it and its neighbours. */
  insert(text: string, opts?: { spaced?: boolean; caretBack?: number }): void;
  /** Move the caret to a 1-based line and column and scroll it into view. */
  goTo(line: number, col?: number): void;
  select(start: number, end: number): void;
  format(): void;
  selection(): { start: number; end: number; text: string };
}

/** Above this many characters the coloured overlay is dropped: a pasted dump is read, not typed. */
const HIGHLIGHT_LIMIT = 60_000;
const POPUP_HEIGHT = 250;

const KIND_LABEL: Record<CompletionItem['kind'], string> = { column: 'col', table: 'table', keyword: 'kw', function: 'fn', snippet: 'snip' };

function keySpec(e: React.KeyboardEvent) {
  return { key: e.key, code: e.nativeEvent.code, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
}

/**
 * SQL that is only read — a generated statement, a script preview — coloured
 * the same way as the editors, in a plain code block.
 */
export function SqlCode({ sql, scope, className, style }: { sql: string; scope?: SqlScope; className?: string; style?: CSSProperties }) {
  const spans = useMemo(() => (sql.length > HIGHLIGHT_LIMIT ? null : highlightSql(sql, scope)), [sql, scope]);
  return (
    <pre className={`code-block sqled__code${className ? ` ${className}` : ''}`} style={style}>
      {spans ? renderSpans(spans, null, { current: null }) : sql}
    </pre>
  );
}

/** Spans rendered as elements; plain text stays a bare text node so a long file is cheap. */
function renderSpans(spans: HighlightSpan[], markAt: number | null, markRef: React.RefObject<HTMLSpanElement | null>): ReactNode[] {
  const out: ReactNode[] = [];
  let marked = markAt === null;
  spans.forEach((s, i) => {
    if (!marked && markAt !== null && markAt >= s.start && markAt <= s.end) {
      const head = s.text.slice(0, markAt - s.start);
      const tail = s.text.slice(markAt - s.start);
      if (head) out.push(s.cls === 'text' ? head : <span key={`${i}a`} className={`sqled__tk sqled__tk--${s.cls}`}>{head}</span>);
      out.push(<span key={`${i}m`} ref={markRef} className="sqled__mark" />);
      if (tail) out.push(s.cls === 'text' ? tail : <span key={`${i}b`} className={`sqled__tk sqled__tk--${s.cls}`}>{tail}</span>);
      marked = true;
      return;
    }
    out.push(s.cls === 'text' ? s.text : <span key={i} className={`sqled__tk sqled__tk--${s.cls}`}>{s.text}</span>);
  });
  if (!marked) out.push(<span key="m" ref={markRef} className="sqled__mark" />);
  return out;
}

export function SqlEditor(props: SqlEditorProps) {
  const {
    ref,
    value,
    onChange,
    scope,
    mode = 'statement',
    multiline = true,
    rows = 6,
    fill = false,
    placeholder,
    ariaLabel,
    onSubmit,
    submitLabel = 'runs',
    extras,
    check = true,
    lenient = false,
    expandable = false,
    title,
    actions,
    className,
    style,
    autoFocus,
    disabled,
    status = 'auto',
  } = props;
  const ta = useRef<HTMLTextAreaElement>(null);
  const hl = useRef<HTMLPreElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const [caret, setCaret] = useState(0);
  const [popup, setPopup] = useState<{ result: CompletionResult; index: number } | null>(null);
  const [popupPos, setPopupPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Set by real typing, so the effect that opens the list runs after that keystroke and not after a programmatic change. */
  const typed = useRef(false);
  /** A selection to apply once React has rendered a value we set ourselves. */
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const plain = value.length > HIGHLIGHT_LIMIT;
  const spans = useMemo(() => (plain ? [] : highlightSql(value, scope, { strict: mode === 'expression' })), [value, scope, mode, plain]);

  /* ---------------- diagnostics ---------------- */
  const diagnostics = useMemo<SqlDiagnostic[]>(() => {
    if (!check || plain) return [];
    if (mode === 'expression') return checkExpression(value, scope, { lenient });
    if (mode === 'statement') return checkStatement(value, scope);
    return [];
  }, [check, plain, mode, value, scope, lenient]);
  // Shown a moment after the last keystroke, so a string being typed is not "unterminated" while it is being typed.
  const [shown, setShown] = useState<SqlDiagnostic[]>(diagnostics);
  useEffect(() => {
    if (diagnostics.length === 0) {
      setShown([]);
      return;
    }
    const id = setTimeout(() => setShown(diagnostics), focused ? 600 : 0);
    return () => clearTimeout(id);
  }, [diagnostics, focused]);

  const mentions = useMemo(() => {
    if (mode !== 'statement' || !scope || !multiline || !value.trim() || plain) return null;
    const known = new Set(scope.tables.map((t) => t.name.toLowerCase()));
    const reads: string[] = [];
    const writes: string[] = [];
    for (const r of referencedTables(value)) {
      const bare = r.name.includes('.') ? r.name.slice(r.name.lastIndexOf('.') + 1) : r.name;
      if (!known.has(bare.toLowerCase()) && !known.has(r.name.toLowerCase())) continue;
      const list = r.role === 'write' ? writes : reads;
      if (!list.includes(bare)) list.push(bare);
    }
    return reads.length || writes.length ? { reads, writes } : null;
  }, [mode, scope, multiline, value, plain]);

  /* ---------------- edits ---------------- */
  const current = (): EditState => {
    const el = ta.current;
    return { text: valueRef.current, start: el?.selectionStart ?? valueRef.current.length, end: el?.selectionEnd ?? valueRef.current.length };
  };

  const setSelection = (start: number, end: number) => {
    const el = ta.current;
    if (!el) return;
    el.setSelectionRange(start, end);
    setCaret(start);
  };

  /**
   * Put a new text in place. Goes through the browser's own insertText when
   * it can, so Ctrl+Z still undoes it; otherwise through onChange, with the
   * selection applied once the new value has rendered.
   */
  const applyEdit = useCallback(
    (next: EditState) => {
      const el = ta.current;
      const old = valueRef.current;
      if (next.text === old) {
        setSelection(next.start, next.end);
        return;
      }
      let done = false;
      if (el && typeof document !== 'undefined' && typeof document.execCommand === 'function') {
        // the changed range: strip the common prefix and suffix
        let p = 0;
        while (p < old.length && p < next.text.length && old[p] === next.text[p]) p++;
        let s = 0;
        while (s < old.length - p && s < next.text.length - p && old[old.length - 1 - s] === next.text[next.text.length - 1 - s]) s++;
        const inserted = next.text.slice(p, next.text.length - s);
        el.focus();
        el.setSelectionRange(p, old.length - s);
        try {
          done = inserted ? document.execCommand('insertText', false, inserted) : document.execCommand('delete', false);
        } catch {
          done = false;
        }
        if (done && el.value !== next.text) done = false;
      }
      if (done) {
        setSelection(next.start, next.end);
        valueRef.current = next.text;
      } else {
        pendingSelection.current = { start: next.start, end: next.end };
        valueRef.current = next.text;
        onChange(next.text);
      }
      // The browser's input event counted as typing; an edit we made (a completion, an indent) must not reopen the list.
      typed.current = false;
    },
    [onChange],
  );

  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    if (!sel || !ta.current) return;
    pendingSelection.current = null;
    ta.current.setSelectionRange(sel.start, sel.end);
    setCaret(sel.start);
  }, [value]);

  const doFormat = useCallback(() => {
    if (!multiline) return;
    const state = current();
    const next = formatSql(state.text);
    if (next === state.text) return;
    const { line } = lineColAt(state.text, state.start);
    const at = offsetOfLine(next, line);
    applyEdit({ text: next, start: at, end: at });
  }, [multiline, applyEdit]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => ta.current?.focus(),
      insert: (text, opts) => applyEdit(insertSnippet(current(), text, opts)),
      goTo: (line, col = 1) => {
        const at = offsetOfLine(valueRef.current, line, col);
        ta.current?.focus();
        setSelection(at, at);
        // scroll the line into view: the textarea scrolls its caret on focus + selection in most browsers, nudge it anyway
        const el = ta.current;
        if (el) {
          const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
          el.scrollTop = Math.max(0, (line - 3) * lineHeight);
          if (hl.current) hl.current.scrollTop = el.scrollTop;
        }
      },
      select: (start, end) => {
        ta.current?.focus();
        setSelection(start, end);
      },
      format: doFormat,
      selection: () => {
        const s = current();
        return { start: s.start, end: s.end, text: s.text.slice(s.start, s.end) };
      },
    }),
    [applyEdit, doFormat],
  );

  /* ---------------- completion ---------------- */
  const openCompletions = useCallback(
    (explicit: boolean) => {
      const el = ta.current;
      if (!el || disabled) return;
      const res = completions(valueRef.current, el.selectionStart, scope, { explicit, extras, keywords: true, minChars: explicit ? 0 : 2 });
      setPopup(res ? { result: res, index: 0 } : null);
    },
    [scope, extras, disabled],
  );

  useEffect(() => {
    if (!typed.current) return;
    typed.current = false;
    openCompletions(false);
  }, [value, openCompletions]);

  const accept = (item: CompletionItem) => {
    if (!popup) return;
    const { text, caret: at } = applyCompletion(valueRef.current, popup.result, item);
    setPopup(null);
    applyEdit({ text, start: at, end: at });
  };

  const measurePopup = useCallback(() => {
    const m = mark.current;
    if (!m) return;
    const r = m.getBoundingClientRect();
    const above = r.bottom + POPUP_HEIGHT > window.innerHeight && r.top > POPUP_HEIGHT;
    setPopupPos({ left: Math.min(r.left, window.innerWidth - 300), top: above ? r.top : r.bottom + 2, above });
  }, []);

  useLayoutEffect(() => {
    if (popup) measurePopup();
    else setPopupPos(null);
  }, [popup, value, measurePopup]);

  useEffect(() => {
    if (!popup) return;
    const onScroll = () => measurePopup();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.sqled-pop') || t === ta.current)) return;
      setPopup(null);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [popup, measurePopup]);

  // Scroll the active row into view as the arrow keys move it.
  const popupList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!popup) return;
    const el = popupList.current?.children[popup.index] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [popup]);

  /* ---------------- events ---------------- */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = editorKeyAction(keySpec(e), { popupOpen: Boolean(popup), multiline, hasSubmit: Boolean(onSubmit) });
    const state = current();
    switch (action) {
      case 'complete':
        e.preventDefault();
        openCompletions(true);
        return;
      case 'accept':
        e.preventDefault();
        if (popup) accept(popup.result.items[popup.index]);
        return;
      case 'close':
        e.preventDefault();
        e.stopPropagation();
        setPopup(null);
        return;
      case 'down':
      case 'up':
      case 'pageDown':
      case 'pageUp': {
        e.preventDefault();
        if (!popup) return;
        const n = popup.result.items.length;
        const delta = action === 'down' ? 1 : action === 'up' ? -1 : action === 'pageDown' ? 5 : -5;
        const next = action === 'pageDown' || action === 'pageUp' ? Math.max(0, Math.min(n - 1, popup.index + delta)) : (popup.index + delta + n) % n;
        setPopup({ ...popup, index: next });
        return;
      }
      case 'indent':
      case 'outdent':
        e.preventDefault();
        applyEdit(indentSelection(state, action === 'outdent'));
        return;
      case 'newline':
        e.preventDefault();
        setPopup(null);
        applyEdit(newlineWithIndent(state));
        return;
      case 'comment':
        e.preventDefault();
        applyEdit(toggleLineComment(state));
        return;
      case 'format':
        e.preventDefault();
        doFormat();
        return;
      case 'submit':
        e.preventDefault();
        setPopup(null);
        onSubmit?.();
        return;
      case 'noop':
        e.preventDefault();
        return;
      default:
        break;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      const over = stepOverClosing(state, e.key);
      if (over) {
        e.preventDefault();
        setSelection(over.start, over.end);
        return;
      }
      const pair = autoClosePair(state, e.key);
      if (pair) {
        e.preventDefault();
        applyEdit(pair);
        return;
      }
    } else if (e.key === 'Backspace') {
      const del = deleteEmptyPair(state);
      if (del) {
        e.preventDefault();
        applyEdit(del);
      }
    }
  };

  const onSelect = () => {
    const el = ta.current;
    if (!el) return;
    setCaret(el.selectionStart);
    if (popup && (el.selectionStart < popup.result.from || el.selectionStart > popup.result.to + 40 || el.selectionStart !== el.selectionEnd)) setPopup(null);
  };

  const onScroll = () => {
    const el = ta.current;
    const p = hl.current;
    if (el && p) {
      p.scrollTop = el.scrollTop;
      p.scrollLeft = el.scrollLeft;
    }
  };

  const jumpTo = (d: SqlDiagnostic) => {
    if (d.start === undefined) {
      ta.current?.focus();
      return;
    }
    ta.current?.focus();
    setSelection(d.start, d.end ?? d.start);
  };

  const pos = lineColAt(value, Math.min(caret, value.length));
  const worst = shown.find((d) => d.severity === 'error') ?? shown[0];
  const showStatus = status === 'always' || (status === 'auto' && (multiline || Boolean(worst)));
  const canFormat = multiline && mode !== 'expression' && !plain;

  const classes = ['sqled', multiline ? '' : 'sqled--single', fill ? 'sqled--fill' : '', plain ? 'sqled--plain' : '', worst ? `sqled--${worst.severity}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={style}>
      <div className="sqled__box">
        {!plain && (
          <pre ref={hl} className="sqled__hl" aria-hidden="true">
            {renderSpans(spans, popup ? popup.result.from : null, mark)}
            {'\u200b'}
          </pre>
        )}
        <textarea
          ref={ta}
          className="sqled__ta"
          value={value}
          rows={multiline ? rows : 1}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={Boolean(popup)}
          data-keeps-escape={popup ? 'true' : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          wrap={multiline ? 'soft' : 'off'}
          onChange={(e) => {
            typed.current = true;
            valueRef.current = e.target.value;
            onChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onClick={onSelect}
          onKeyUp={onSelect}
          onScroll={onScroll}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // the list closes on blur unless the blur is a click on the list itself (handled by mousedown capture)
          }}
        />
      </div>
      {showStatus && (
        <div className="sqled__status">
          {worst ? (
            <button type="button" className={`sqled__diag sqled__diag--${worst.severity}`} onClick={() => jumpTo(worst)} title={shown.length > 1 ? `${shown.length} findings — click to jump to the first` : 'Click to jump to it'}>
              <AlertTriangle />
              <span>
                {worst.message}
                {shown.length > 1 ? ` (+${shown.length - 1})` : ''}
              </span>
            </button>
          ) : mentions ? (
            <span className="sqled__mentions">
              {mentions.writes.length > 0 && (
                <>
                  Writes <b>{mentions.writes.join(', ')}</b>
                  {mentions.reads.length > 0 ? ' · ' : ''}
                </>
              )}
              {mentions.reads.length > 0 && (
                <>
                  Reads <b>{mentions.reads.join(', ')}</b>
                </>
              )}
            </span>
          ) : multiline ? (
            <span className="sqled__hint">Ctrl+Space completes{onSubmit ? ` · Ctrl+Enter ${submitLabel}` : ''}</span>
          ) : null}
          {multiline && (
            <span className="sqled__pos" title="Line and column of the caret">
              Ln {pos.line}, Col {pos.col}
            </span>
          )}
          {canFormat && (
            <button type="button" className="icon-btn sqled__btn" onClick={doFormat} title="Format (Ctrl+Shift+F)" disabled={!value.trim()}>
              <Wand2 />
            </button>
          )}
          {expandable && (
            <button type="button" className="icon-btn sqled__btn" onClick={() => setExpanded(true)} title="Edit in a bigger window">
              <Maximize2 />
            </button>
          )}
          {actions}
        </div>
      )}
      {popup &&
        popupPos &&
        createPortal(
          <div
            className="sqled-pop"
            role="listbox"
            style={popupPos.above ? { left: popupPos.left, bottom: window.innerHeight - popupPos.top + 2 } : { left: popupPos.left, top: popupPos.top }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div ref={popupList}>
              {popup.result.items.map((item, i) => (
                <div
                  key={`${item.kind}:${item.label}`}
                  role="option"
                  aria-selected={i === popup.index}
                  className={`sqled-pop__item${i === popup.index ? ' sqled-pop__item--active' : ''}`}
                  onMouseEnter={() => setPopup({ ...popup, index: i })}
                  onClick={() => accept(item)}
                >
                  <span className={`sqled-pop__kind sqled-pop__kind--${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <span className="sqled-pop__label">{item.label}</span>
                  {item.detail && <span className="sqled-pop__detail">{item.detail}</span>}
                </div>
              ))}
            </div>
            <div className="sqled-pop__foot">↑↓ choose · Enter or Tab insert · Esc close</div>
          </div>,
          document.body,
        )}
      {expanded && (
        <Modal title={title ?? 'SQL'} onClose={() => setExpanded(false)} wide>
          <div className="sqled-modal">
            <SqlEditor {...props} ref={undefined} expandable={false} fill rows={18} autoFocus status="always" />
          </div>
        </Modal>
      )}
    </div>
  );
}
