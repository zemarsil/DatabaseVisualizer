import { useRef } from 'react';
import { PALETTE } from '@/lib/palette';
import { rovingIndex } from '@/lib/editorKeys';

/**
 * The colour row shared by tables, notes and groups.
 *
 * One tab stop, not ten: Tab lands on the colour already in use, the arrow
 * keys walk the palette and Space or Enter picks one. Ten separate tab stops
 * sat in the middle of the table form, between the schema box and the columns,
 * which made Tab a useless way to reach the part of the form people type in.
 */
export function Swatches({ value, onPick, label = 'Colour' }: { value?: string | null; onPick: (key: string) => void; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Nothing chosen yet (a new note, or a mixed selection): the first swatch holds the tab stop.
  const active = Math.max(0, PALETTE.findIndex((p) => p.key === value));
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {PALETTE.map((p, i) => (
        <button
          key={p.key}
          type="button"
          role="radio"
          aria-checked={value === p.key}
          aria-label={p.label}
          tabIndex={i === active ? 0 : -1}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`swatch${value === p.key ? ' swatch--active' : ''}`}
          style={{ background: p.hue }}
          title={p.label}
          onClick={() => onPick(p.key)}
          onKeyDown={(e) => {
            const next = rovingIndex(e.key, i, PALETTE.length, 'both');
            if (next === null) return;
            e.preventDefault();
            refs.current[next]?.focus();
          }}
        />
      ))}
    </div>
  );
}
