/**
 * Store-aware actions shared by the canvas key handlers and the right-click
 * menus: copy the selection, paste text (tables, SQL or a whole file) and open
 * dropped files.
 *
 * A copy puts the same tables on the clipboard three ways, and the paste target
 * picks the one it understands:
 *
 * - `text/plain` is the DDL, so a text editor or a psql prompt gets SQL;
 * - `text/html` is the Markdown data dictionary as HTML, so an editor that
 *   converts rich text on paste (Obsidian, Notion, a mail client) gets a table;
 * - a private flavor carries the diagram fragment itself, so pasting back onto
 *   a canvas restores positions, colours and the connections DDL cannot express.
 *
 * Not every browser lets us write or read that private flavor, so paste falls
 * back to the last in-app copy and finally to importing whatever text arrived.
 */
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { classifyPastedText, decodeClipboard, encodeClipboard } from './clipboard';
import { importSql } from './sql/import';
import { parseDiagramFile } from './io';
import { getSqliteEngine } from './sqlite/engine';
import { introspectionToDiagram } from './introspectImport';
import { estimateNodeSize } from './geometry';
import { selectionHtml, selectionSql } from './selectionExport';
import { confirmDialog } from '@/components/ui/Modal';
import type { Diagram, Table } from '@shared/types';

/** The clipboard flavor holding the diagram fragment, when the browser allows one. */
export const DBVIZ_FLAVOR = 'application/x-dbviz';

export interface ClipboardFlavors {
  /** The diagram fragment: full fidelity when pasted back onto a canvas. */
  json: string;
  /** What a plain-text target gets: the DDL for the copied tables. */
  text: string;
  /** What a rich-text target gets: the Markdown data dictionary, as HTML. */
  html: string;
}

/** In-memory fallback for browsers that refuse clipboard reads. */
let lastCopied: ClipboardFlavors | null = null;

/** Every rendering of `tableIds`, or null when none of them is a table in this diagram. */
export function selectionFlavors(d: Diagram, tableIds: string[]): ClipboardFlavors | null {
  if (!tableIds.length) return null;
  const sql = selectionSql(d, tableIds).text;
  if (!sql) return null;
  return { json: encodeClipboard(d, tableIds), text: sql, html: selectionHtml(d, tableIds, { includeSql: true }) };
}

function flavorsFor(tableIds?: string[]): ClipboardFlavors | null {
  const s = useStore.getState();
  return selectionFlavors(s.diagram, tableIds ?? s.selection.tableIds);
}

/**
 * Fill a copy/cut event with every flavor. Synchronous `setData` is the only
 * way to offer more than plain text on Safari, and the only way to offer a
 * private flavor at all, so the keyboard path uses this rather than
 * `copySelectionToClipboard`.
 */
export function writeSelectionToEvent(e: ClipboardEvent, tableIds?: string[]): number {
  const flavors = flavorsFor(tableIds);
  if (!flavors || !e.clipboardData) return 0;
  lastCopied = flavors;
  e.clipboardData.setData('text/plain', flavors.text);
  // Each extra flavor stands on its own: a browser that refuses one should
  // still get the other, and every target has the DDL either way.
  for (const [type, value] of [
    ['text/html', flavors.html],
    [DBVIZ_FLAVOR, flavors.json],
  ] as const) {
    try {
      e.clipboardData.setData(type, value);
    } catch {
      /* not supported here */
    }
  }
  return countTables(flavors.json);
}

function countTables(json: string): number {
  return decodeClipboard(json)?.tables.length ?? 0;
}

/** The toast after a copy: it says where each flavor lands so the change is discoverable. */
export function copiedMessage(n: number): string {
  return `Copied ${n} table${n === 1 ? '' : 's'}: SQL as plain text, Markdown in a rich-text editor, tables here.`;
}

async function writeFlavors(flavors: ClipboardFlavors): Promise<void> {
  lastCopied = flavors;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([flavors.text], { type: 'text/plain' }),
          'text/html': new Blob([flavors.html], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch {
    /* older browsers, or one that refuses text/html: fall back to plain text */
  }
  try {
    await navigator.clipboard.writeText(flavors.text);
  } catch {
    /* the in-memory copy still works within this tab */
  }
}

/** Write plain text to the clipboard and say so, or say why it did not work. */
export async function copyTextToClipboard(text: string, message: string): Promise<void> {
  const s = useStore.getState();
  try {
    await navigator.clipboard.writeText(text);
    s.toast('success', message);
  } catch {
    s.toast('error', 'The browser would not let us write to the clipboard.');
  }
}

export async function copySelectionToClipboard(tableIds?: string[]): Promise<boolean> {
  const flavors = flavorsFor(tableIds);
  if (!flavors) return false;
  await writeFlavors(flavors);
  useStore.getState().toast('success', copiedMessage(countTables(flavors.json)));
  return true;
}

/** `alreadyOnClipboard` is for the cut event, which filled the clipboard itself. */
export function cutSelection(opts: { alreadyOnClipboard?: boolean } = {}): void {
  const s = useStore.getState();
  const ids = s.selection.tableIds;
  if (!ids.length) return;
  if (!opts.alreadyOnClipboard) {
    const flavors = flavorsFor(ids);
    if (!flavors) return;
    void writeFlavors(flavors);
  }
  s.removeElements({ tableIds: ids, noteIds: s.selection.noteIds });
  s.toast('success', `Cut ${ids.length} table${ids.length === 1 ? '' : 's'}.`);
}

/** Lay pasted tables out in a grid whose top-left corner is `at`. */
function gridAt(tables: Table[], at: { x: number; y: number }): void {
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  let x = at.x;
  let y = at.y;
  let rowH = 0;
  tables.forEach((t, i) => {
    if (i > 0 && i % cols === 0) {
      x = at.x;
      y += rowH + 60;
      rowH = 0;
    }
    t.position = { x, y };
    const size = estimateNodeSize(t.columns);
    x += size.width + 60;
    rowH = Math.max(rowH, size.height);
  });
}

/** Paste clipboard text onto the canvas. Returns what it recognised. */
export function pasteText(text: string, at?: { x: number; y: number }): 'clipboard' | 'sql' | 'diagram' | 'unknown' {
  const s = useStore.getState();
  const kind = classifyPastedText(text);
  if (kind === 'clipboard') {
    const payload = decodeClipboard(text)!;
    let offset = { x: 40, y: 40 };
    if (at && payload.tables.length) {
      const minX = Math.min(...payload.tables.map((t) => t.position.x));
      const minY = Math.min(...payload.tables.map((t) => t.position.y));
      offset = { x: at.x - minX, y: at.y - minY };
    }
    const ids = s.pasteTables(payload.tables, payload.relationships, payload.customTypes, offset);
    s.toast('success', `Pasted ${ids.length} table${ids.length === 1 ? '' : 's'}.`);
  } else if (kind === 'sql') {
    const res = importSql(text, s.diagram.dialect, s.diagram);
    if (res.tables.length === 0) {
      s.toast('error', res.errors[0] ?? 'No CREATE TABLE statements found in the pasted text.');
      return kind;
    }
    if (at) {
      gridAt(res.tables, at);
      s.pasteTables(res.tables, res.relationships, res.customTypes, { x: 0, y: 0 });
    } else {
      s.importTables(res.tables, res.relationships, 'merge', { customTypes: res.customTypes });
    }
    const problems = res.errors.length ? ` (${res.errors.length} statement${res.errors.length === 1 ? '' : 's'} had errors)` : '';
    s.toast('success', `Imported ${res.tables.length} table${res.tables.length === 1 ? '' : 's'} from the pasted SQL${problems}.`);
  } else if (kind === 'diagram') {
    try {
      const d = parseDiagramFile(text);
      const ids = s.pasteTables(d.tables, d.relationships, d.customTypes, at ? { x: at.x - Math.min(...d.tables.map((t) => t.position.x)), y: at.y - Math.min(...d.tables.map((t) => t.position.y)) } : { x: 0, y: 0 });
      s.toast('success', `Added ${ids.length} table${ids.length === 1 ? '' : 's'} from the pasted diagram.`);
    } catch (e) {
      s.toast('error', e instanceof Error ? e.message : 'Could not read the pasted diagram.');
    }
  }
  return kind;
}

/**
 * The diagram fragment behind `text`, when this is our own copy coming back:
 * either the private flavor survived, or the plain text is byte-for-byte the
 * DDL we last wrote and the fragment is still in memory.
 */
function fragmentFor(text: string, flavor?: string): string | null {
  if (flavor && decodeClipboard(flavor)) return flavor;
  if (lastCopied && text.trim() && text.trim() === lastCopied.text.trim()) return lastCopied.json;
  return null;
}

/** Paste from a clipboard event, preferring the diagram fragment over the DDL. Returns true when something landed. */
export function pasteFromEvent(e: ClipboardEvent, at?: { x: number; y: number }): boolean {
  const data = e.clipboardData;
  if (!data) return false;
  let flavor = '';
  try {
    flavor = data.getData(DBVIZ_FLAVOR);
  } catch {
    /* browsers that reject unknown flavors */
  }
  const text = data.getData('text/plain') ?? '';
  const fragment = fragmentFor(text, flavor);
  if (fragment) return pasteText(fragment, at) !== 'unknown';
  if (!text.trim()) return false;
  return pasteText(text, at) !== 'unknown';
}

/** Paste from the system clipboard (falls back to the last in-app copy). */
export async function pasteFromClipboard(at?: { x: number; y: number }): Promise<void> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }
  const fragment = fragmentFor(text) ?? (!text && lastCopied ? lastCopied.json : null);
  if (fragment) {
    pasteText(fragment, at);
    return;
  }
  if (!text) {
    useStore.getState().toast('info', 'Nothing to paste. Copy tables or SQL first.');
    return;
  }
  if (pasteText(text, at) === 'unknown') useStore.getState().toast('info', 'The clipboard holds neither tables, SQL nor a diagram file.');
}

/** Open files dropped on the canvas: .sql, .dbviz.json, or a SQLite database. */
export async function openDroppedFiles(files: File[], at?: { x: number; y: number }): Promise<void> {
  const s = useStore.getState();
  for (const file of files) {
    const name = file.name.toLowerCase();
    try {
      if (/\.(sqlite3?|db)$/.test(name)) {
        const engine = await getSqliteEngine();
        await engine.load(new Uint8Array(await file.arrayBuffer()));
        const res = await engine.introspect();
        const converted = introspectionToDiagram(res, 'sqlite', s.diagram.tables.length ? s.diagram : null);
        useConnection.getState().setDialect('sqlite');
        if (s.diagram.tables.length === 0) s.setDialect('sqlite', false);
        s.importTables(converted.tables, converted.relationships, s.diagram.tables.length ? 'merge' : 'replace', { customTypes: converted.customTypes });
        s.toast('success', `Opened ${file.name} in the browser and imported ${converted.tables.length} table${converted.tables.length === 1 ? '' : 's'}.`);
        continue;
      }
      const text = await file.text();
      if (name.endsWith('.json')) {
        const d = parseDiagramFile(text);
        if (s.diagram.tables.length === 0) {
          s.setDiagram(d);
          s.toast('success', `Opened "${d.name}".`);
        } else {
          const replace = await confirmDialog({
            title: `Open "${d.name}"?`,
            message: 'Replace the current diagram, or add its tables to this one instead?',
            confirmLabel: 'Replace',
            cancelLabel: 'Add tables',
          });
          if (replace) {
            s.setDiagram(d);
            s.toast('success', `Opened "${d.name}".`);
          } else {
            pasteText(text, at);
          }
        }
        continue;
      }
      if (name.endsWith('.sql') || name.endsWith('.txt') || classifyPastedText(text) === 'sql') {
        const res = importSql(text, s.diagram.dialect, s.diagram.tables.length ? s.diagram : null);
        if (!res.tables.length) {
          s.toast('error', `${file.name}: no CREATE TABLE statements found.`);
          continue;
        }
        s.importTables(res.tables, res.relationships, s.diagram.tables.length ? 'merge' : 'replace', { customTypes: res.customTypes });
        s.toast('success', `Imported ${res.tables.length} table${res.tables.length === 1 ? '' : 's'} from ${file.name}.`);
        continue;
      }
      s.toast('error', `${file.name}: drop a .sql, .dbviz.json or .sqlite file.`);
    } catch (e) {
      s.toast('error', `${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
