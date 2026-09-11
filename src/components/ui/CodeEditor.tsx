import { useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { ProgramLanguage } from '@shared/types';
import { highlightCode } from '@/lib/code/highlight';
import type { HighlightSpan } from '@/lib/sql/highlight';
import '@/styles/sqleditor.css';

/**
 * The host-language counterpart of SqlEditor: a textarea with a coloured copy
 * laid over it.
 *
 * Much smaller than its SQL sibling on purpose. Code pasted next to a step is
 * read far more often than it is written, and the app has no business
 * completing or checking Rust, so this keeps what a textarea gives for free —
 * native undo, IME, selection — adds colour, and stops there. The one editing
 * nicety it does keep is Tab inserting an indent, because Tab moving focus out
 * of a code box is maddening.
 */
const HIGHLIGHT_LIMIT = 40_000;

/** Spans as elements, plain text left as bare text nodes so a long file stays cheap. */
function renderSpans(spans: HighlightSpan[]): ReactNode[] {
  return spans.map((s, i) =>
    s.cls === 'text' ? (
      s.text
    ) : (
      <span key={i} className={`sqled__tk sqled__tk--${s.cls}`}>
        {s.text}
      </span>
    ),
  );
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: ProgramLanguage;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

export function CodeEditor({ value, onChange, language, rows = 6, placeholder, ariaLabel, className, style, disabled }: CodeEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const spans = useMemo(() => (value.length > HIGHLIGHT_LIMIT ? null : highlightCode(value, language)), [value, language]);

  // The overlay has to scroll in step with the textarea or the colours drift
  // away from the characters they belong to.
  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const hl = hlRef.current;
    if (!ta || !hl) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }, []);
  useLayoutEffect(syncScroll, [value, syncScroll]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    // Shift+Tab still moves focus, so the box is never a keyboard trap.
    if (e.shiftKey) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = ta;
    const next = `${value.slice(0, start)}    ${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 4;
    });
  };

  return (
    <div className={`sqled${className ? ` ${className}` : ''}`} style={style}>
      <div className="sqled__box">
        <pre ref={hlRef} className="sqled__hl" aria-hidden="true">
          {spans ? renderSpans(spans) : value}
        </pre>
        <textarea
          ref={taRef}
          className="sqled__ta"
          value={value}
          rows={rows}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

/** Code that is only read — a generated starter, a preview — coloured the same way. */
export function CodeBlock({ code, language, className, style }: { code: string; language: ProgramLanguage; className?: string; style?: CSSProperties }) {
  const spans = useMemo(() => (code.length > HIGHLIGHT_LIMIT ? null : highlightCode(code, language)), [code, language]);
  return (
    <pre className={`code-block sqled__code${className ? ` ${className}` : ''}`} style={style}>
      {spans ? renderSpans(spans) : code}
    </pre>
  );
}
