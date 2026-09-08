/**
 * Where a coach mark points.
 *
 * A step's `target:` is one short token — `ui:add-table`, `tab:sql`,
 * `field:Reads as`, `table:authors`, `column:books.author_id`,
 * `rel:books -> authors` — and this module turns it into two things: a CSS
 * selector for the element to spotlight, and the panels that have to be open
 * before that element exists. Resolving the second half is why the tour can
 * point at the **Reads as** picker without the reader first being told to open
 * the inspector.
 *
 * Chrome is found by a `data-tour` attribute; inspector fields are found by
 * their visible label, which the walkthroughs already have to quote exactly
 * (see docs/walkthroughs/WALKTHROUGH_FORMAT.md), so pointing at one costs the
 * app no extra markup.
 */
import type { Diagram } from '@shared/types';

/** Panels the host must open before the target can be found. */
export interface Reveal {
  drawerTab?: string;
  inspector?: boolean;
  sidebar?: boolean;
  /** Table to bring into view on the canvas, if it is not already there. */
  centerTable?: string;
}

export interface Anchor {
  /** CSS selector for the element to spotlight, or null to float the card in the middle. */
  selector: string | null;
  /**
   * Found by its visible text rather than a selector: `scan` for the label to
   * read, `startsWith` for what it must say, `wrap` for the block around it to
   * ring. This is how a step points at **Reads as** or **Indexes** without the
   * inspector needing a tour attribute on every field it has.
   */
  text?: { scan: string; startsWith: string; wrap: string };
  /**
   * Where to point while the real target does not exist yet — a column the
   * reader has not typed, a connection they have not drawn. Pointing at the
   * panel it will appear in beats letting the card drift off to one side.
   */
  fallback?: string;
  reveal: Reveal;
}

const CENTERED: Anchor = { selector: null, reveal: {} };

function tableId(d: Diagram, name: string): string | undefined {
  return d.tables.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())?.id;
}

function columnId(d: Diagram, ref: string): { table?: string; column?: string } {
  const dot = ref.lastIndexOf('.');
  if (dot === -1) return {};
  const t = d.tables.find((x) => x.name.toLowerCase() === ref.slice(0, dot).trim().toLowerCase());
  return { table: t?.id, column: t?.columns.find((c) => c.name.toLowerCase() === ref.slice(dot + 1).trim().toLowerCase())?.id };
}

function relId(d: Diagram, arg: string): string | undefined {
  const [from, to] = arg.split('->').map((s) => s.trim().toLowerCase());
  const a = d.tables.find((t) => t.name.toLowerCase() === from);
  const b = d.tables.find((t) => t.name.toLowerCase() === to);
  if (!a || !b) return undefined;
  return d.relationships.find((r) => r.sourceTableId === a.id && r.targetTableId === b.id)?.id;
}

/** Reads a `target:` token into the element to spotlight and what has to be open first. */
export function resolveAnchor(target: string | null, d: Diagram): Anchor {
  if (!target || target === 'none') return CENTERED;
  const cut = target.indexOf(':');
  const kind = cut === -1 ? target.trim() : target.slice(0, cut).trim();
  const arg = cut === -1 ? '' : target.slice(cut + 1).trim();

  switch (kind) {
    case 'ui':
      return { selector: `[data-tour="${cssEscape(arg)}"]`, reveal: {} };
    case 'tab':
      return { selector: `[data-tour="tab-${cssEscape(arg)}"]`, reveal: { drawerTab: arg } };
    case 'panel':
      return { selector: '[data-tour="drawer-body"]', reveal: { drawerTab: arg } };
    case 'field':
      return { selector: null, text: { scan: '.inspector .field__label', startsWith: arg, wrap: '.field' }, fallback: '[data-tour="inspector"]', reveal: { inspector: true } };
    case 'section':
      return { selector: null, text: { scan: '.inspector .section__title', startsWith: arg, wrap: '.section' }, fallback: '[data-tour="inspector"]', reveal: { inspector: true } };
    case 'sidebar':
      return { selector: '[data-tour="sidebar"]', reveal: { sidebar: true } };
    case 'table': {
      const id = tableId(d, arg);
      return { selector: id ? `.react-flow__node[data-id="${cssEscape(id)}"]` : null, reveal: { centerTable: arg } };
    }
    case 'column': {
      const { table, column } = columnId(d, arg);
      return {
        selector: table && column ? `.react-flow__node[data-id="${cssEscape(table)}"] [data-column-id="${cssEscape(column)}"]` : null,
        fallback: table ? `.react-flow__node[data-id="${cssEscape(table)}"]` : undefined,
        reveal: { centerTable: arg.slice(0, arg.lastIndexOf('.')) },
      };
    }
    case 'rel': {
      const id = relId(d, arg);
      return { selector: id ? `.react-flow__edge[data-id="${cssEscape(id)}"]` : null, reveal: {} };
    }
    default:
      return CENTERED;
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** The element a resolved anchor points at right now, or null if it is not on screen. */
export function findAnchorElement(anchor: Anchor): Element | null {
  return exactAnchorElement(anchor) ?? (anchor.fallback ? document.querySelector(anchor.fallback) : null);
}

/** The target itself, ignoring the fallback: what decides whether a step's subject has to be selected. */
export function exactAnchorElement(anchor: Anchor): Element | null {
  if (anchor.text) {
    const { scan, startsWith, wrap } = anchor.text;
    const want = startsWith.toLowerCase();
    for (const el of document.querySelectorAll<HTMLElement>(scan)) {
      if (el.textContent?.trim().toLowerCase().startsWith(want)) return el.closest(wrap) ?? el;
    }
    return null;
  }
  return anchor.selector ? document.querySelector(anchor.selector) : null;
}
