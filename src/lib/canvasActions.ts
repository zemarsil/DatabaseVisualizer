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
 * The private flavor is spelled two ways because the two write paths are two
 * different APIs: a `copy` event takes any format through `setData`, while
 * `navigator.clipboard.write` only accepts a custom one behind the `web `
 * prefix. Both are read back on paste. A browser that supports neither still
 * gets the DDL, and a paste there falls back to the last in-app copy and then
 * to importing whatever text arrived.
 */
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { classifyPastedText, decodeClipboard } from './clipboard';
import { importSql } from './sql/import';
import { parseDiagramFile, parseWorkspaceFile } from './io';
import { getSqliteEngine } from './sqlite/engine';
import { getDuckdbEngine } from './duckdb/engine';
import { introspectionToDiagram } from './introspectImport';
import { estimateNodeSize } from './geometry';
import { selectionFlavors, type ClipboardFlavors } from './selectionExport';
import { confirmDialog } from '@/components/ui/Modal';
import type { Table } from '@shared/types';

/** The diagram-fragment flavor as a `copy` event spells it. */
export const DBVIZ_FLAVOR = 'application/x-dbviz';
/** The same flavor as the async clipboard API spells it; custom formats need the prefix. */
export const DBVIZ_FLAVOR_WEB = `web ${DBVIZ_FLAVOR}`;

/** In-memory fallback for browsers that refuse clipboard reads. */
let lastCopied: ClipboardFlavors | null = null;

function flavorsFor(tableIds?: string[]): ClipboardFlavors | null {
  const s = useStore.getState();
  return selectionFlavors(s.diagram, tableIds ?? s.selection.tableIds);
}

/**
 * The fragment also rides inside the HTML flavor, as a trailing comment.
 *
 * The two clipboard APIs cannot see each other's private formats: a paste event
 * reads what `setData` wrote, `navigator.clipboard.read` reads what
 * `ClipboardItem` wrote, and neither sees the other's. `text/html` is the one
 * flavor both can read, and every rich-text target drops comments on the way in,
 * so hiding the fragment there is what makes the context-menu Paste as good as
 * Ctrl+V no matter which way the copy was made. Base64 keeps `-->` out of a
 * table name and out of the comment.
 */
const FRAGMENT_OPEN = '<!--dbviz:';
const FRAGMENT_CLOSE = '-->';

function toBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function htmlWithFragment(flavors: ClipboardFlavors): string {
  try {
    return `${flavors.html}\n${FRAGMENT_OPEN}${toBase64(flavors.json)}${FRAGMENT_CLOSE}`;
  } catch {
    return flavors.html;
  }
}

/**
 * Pull the fragment back out of an HTML flavor we wrote, or '' for anyone
 * else's HTML. `atob` is lenient about junk, so what comes out is only returned
 * once it reads as a fragment.
 */
export function fragmentFromHtml(html: string): string {
  const start = html.lastIndexOf(FRAGMENT_OPEN);
  if (start < 0) return '';
  const end = html.indexOf(FRAGMENT_CLOSE, start);
  if (end < 0) return '';
  try {
    const json = fromBase64(html.slice(start + FRAGMENT_OPEN.length, end).trim());
    return decodeClipboard(json) ? json : '';
  } catch {
    return '';
  }
}

/** Put every flavor on a copy/cut event. The fragment goes under both names: a paste event reads the bare one, the async API the prefixed one. */
function fillEvent(data: DataTransfer, flavors: ClipboardFlavors): void {
  data.setData('text/plain', flavors.text);
  // Each extra flavor stands on its own: a browser that refuses one should
  // still get the others, and every target has the DDL either way.
  for (const [type, value] of [
    ['text/html', htmlWithFragment(flavors)],
    [DBVIZ_FLAVOR, flavors.json],
    [DBVIZ_FLAVOR_WEB, flavors.json],
  ] as const) {
    try {
      data.setData(type, value);
    } catch {
      /* not supported here */
    }
  }
}

/**
 * Fill a copy/cut event with every flavor, and report how many tables went.
 * Synchronous `setData` is the only way to offer more than plain text on
 * Safari, so the keyboard path uses this rather than `copySelectionToClipboard`.
 */
export function writeSelectionToEvent(e: ClipboardEvent, tableIds?: string[]): number {
  const flavors = flavorsFor(tableIds);
  if (!flavors || !e.clipboardData) return 0;
  lastCopied = flavors;
  fillEvent(e.clipboardData, flavors);
  return flavors.tableCount;
}

/**
 * Copy by driving a synthetic copy event.
 *
 * Not nostalgia for `execCommand`: a private format written through
 * `navigator.clipboard.write` is invisible to paste events — only `text/plain`
 * survives — so a menu copy read back with Ctrl+V would lose the fragment and
 * fall back to importing DDL. Driving the event is what makes both copy paths
 * leave the same thing on the clipboard. Must run inside the click that asked
 * for it, or the browser refuses.
 */
function writeViaCopyEvent(flavors: ClipboardFlavors): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  let wrote = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    fillEvent(e.clipboardData, flavors);
    wrote = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    return document.execCommand('copy') && wrote;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

/** The toast after a copy: it says where each flavor lands so the change is discoverable. */
export function copiedMessage(n: number): string {
  return `Copied ${n} table${n === 1 ? '' : 's'}: SQL as plain text, Markdown in a rich-text editor, tables here.`;
}

function blob(text: string, type: string): Blob {
  return new Blob([text], { type });
}

/**
 * Write every flavor from a menu or palette action. The synthetic copy event is
 * tried first because it is the only write a later paste event can read in
 * full; the async API is the fallback, and its custom format still feeds the
 * context-menu Paste. A browser that rejects custom formats rejects the whole
 * `write`, so that attempt is retried without one before falling back to text.
 */
async function writeFlavors(flavors: ClipboardFlavors): Promise<void> {
  lastCopied = flavors;
  if (writeViaCopyEvent(flavors)) return;
  const standard = {
    'text/plain': blob(flavors.text, 'text/plain'),
    'text/html': blob(htmlWithFragment(flavors), 'text/html'),
  };
  for (const items of [{ ...standard, [DBVIZ_FLAVOR_WEB]: blob(flavors.json, DBVIZ_FLAVOR_WEB) }, standard]) {
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) break;
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return;
    } catch {
      /* try the next, smaller, set */
    }
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
  useStore.getState().toast('success', copiedMessage(flavors.tableCount));
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
    const ids = s.pasteTables(payload.tables, payload.relationships, payload.customTypes, offset, payload.extensions);
    s.toast('success', `Pasted ${ids.length} table${ids.length === 1 ? '' : 's'}.`);
  } else if (kind === 'sql') {
    const res = importSql(text, s.diagram.dialect, s.diagram);
    if (res.tables.length === 0) {
      s.toast('error', res.errors[0] ?? 'No CREATE TABLE statements found in the pasted text.');
      return kind;
    }
    if (at) {
      gridAt(res.tables, at);
      s.pasteTables(res.tables, res.relationships, res.customTypes, { x: 0, y: 0 }, res.extensions);
    } else {
      s.importTables(res.tables, res.relationships, 'merge', { customTypes: res.customTypes, extensions: res.extensions });
    }
    const problems = res.errors.length ? ` (${res.errors.length} statement${res.errors.length === 1 ? '' : 's'} had errors)` : '';
    s.toast('success', `Imported ${res.tables.length} table${res.tables.length === 1 ? '' : 's'} from the pasted SQL${problems}.`);
  } else if (kind === 'diagram') {
    try {
      const d = parseDiagramFile(text);
      const ids = s.pasteTables(
        d.tables,
        d.relationships,
        d.customTypes,
        at ? { x: at.x - Math.min(...d.tables.map((t) => t.position.x)), y: at.y - Math.min(...d.tables.map((t) => t.position.y)) } : { x: 0, y: 0 },
        d.extensions,
      );
      s.toast('success', `Added ${ids.length} table${ids.length === 1 ? '' : 's'} from the pasted diagram.`);
    } catch (e) {
      s.toast('error', e instanceof Error ? e.message : 'Could not read the pasted diagram.');
    }
  }
  return kind;
}

/**
 * The diagram fragment behind `text`, when this is our own copy coming back:
 * either a private flavor survived, or — on a browser that has none — the plain
 * text is byte-for-byte the DDL we last wrote and the fragment is still in
 * memory from this tab.
 */
function fragmentFor(text: string, flavor?: string): string | null {
  if (flavor && decodeClipboard(flavor)) return flavor;
  if (lastCopied && text.trim() && text.trim() === lastCopied.text.trim()) return lastCopied.json;
  return null;
}

function readFlavor(data: DataTransfer, type: string): string {
  try {
    return data.getData(type);
  } catch {
    return ''; // browsers that reject unknown flavors
  }
}

/** Paste from a clipboard event, preferring the diagram fragment over the DDL. Returns true when something landed. */
export function pasteFromEvent(e: ClipboardEvent, at?: { x: number; y: number }): boolean {
  const data = e.clipboardData;
  if (!data) return false;
  const flavor = readFlavor(data, DBVIZ_FLAVOR) || readFlavor(data, DBVIZ_FLAVOR_WEB) || fragmentFromHtml(readFlavor(data, 'text/html'));
  const text = data.getData('text/plain') ?? '';
  const fragment = fragmentFor(text, flavor);
  if (fragment) return pasteText(fragment, at) !== 'unknown';
  if (!text.trim()) return false;
  return pasteText(text, at) !== 'unknown';
}

/** Read the clipboard through the async API: the fragment if it is there, else the plain text. */
async function readClipboard(): Promise<{ text: string; flavor: string }> {
  let flavor = '';
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t === DBVIZ_FLAVOR_WEB || t === DBVIZ_FLAVOR);
      if (type) {
        flavor = await (await item.getType(type)).text();
        break;
      }
      if (!item.types.includes('text/html')) continue;
      flavor = fragmentFromHtml(await (await item.getType('text/html')).text());
      if (flavor) break;
    }
  } catch {
    /* no read permission, or a browser without custom formats */
  }
  try {
    return { text: await navigator.clipboard.readText(), flavor };
  } catch {
    return { text: '', flavor };
  }
}

/** Paste from the system clipboard (falls back to the last in-app copy). */
export async function pasteFromClipboard(at?: { x: number; y: number }): Promise<void> {
  const { text, flavor } = await readClipboard();
  const fragment = fragmentFor(text, flavor) ?? (!text && lastCopied ? lastCopied.json : null);
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

/** Open files dropped on the canvas: .sql, .dbviz.json, or a SQLite / DuckDB database. */
export async function openDroppedFiles(files: File[], at?: { x: number; y: number }): Promise<void> {
  const s = useStore.getState();
  for (const file of files) {
    const name = file.name.toLowerCase();
    try {
      if (/\.duckdb$/.test(name)) {
        const engine = await getDuckdbEngine();
        await engine.load(new Uint8Array(await file.arrayBuffer()));
        const res = await engine.introspect();
        const converted = introspectionToDiagram(res, 'duckdb', s.diagram.tables.length ? s.diagram : null);
        useConnection.getState().setDialect('duckdb');
        if (s.diagram.tables.length === 0) s.setDialect('duckdb', false);
        s.importTables(converted.tables, converted.relationships, s.diagram.tables.length ? 'merge' : 'replace', { customTypes: converted.customTypes, extensions: converted.extensions });
        s.toast('success', `Opened ${file.name} in the browser and imported ${converted.tables.length} table${converted.tables.length === 1 ? '' : 's'}.`);
        continue;
      }
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
        const ws = parseWorkspaceFile(text);
        if (ws.sheets.length > 1) {
          // A workspace file arrives as tabs of its own: nothing already open is displaced.
          let after: string | undefined;
          const added = new Map<string, string>();
          for (const sh of ws.sheets) {
            after = s.addSheet({ diagram: sh.diagram, after, activate: false });
            added.set(sh.id, after);
          }
          const landOn = added.get(ws.activeSheetId);
          if (landOn) useStore.getState().switchSheet(landOn);
          s.toast('success', `Opened "${ws.name}" — its ${ws.sheets.length} diagrams were added as tabs of this workspace.`);
          continue;
        }
        const d = ws.sheets[0].diagram;
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
      s.toast('error', `${file.name}: drop a .sql, .dbviz.json, .sqlite or .duckdb file.`);
    } catch (e) {
      s.toast('error', `${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
