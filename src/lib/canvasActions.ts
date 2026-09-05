/**
 * Store-aware actions shared by the canvas key handlers and the right-click
 * menus: copy the selection, paste text (tables, SQL or a whole file) and open
 * dropped files.
 */
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { classifyPastedText, decodeClipboard, encodeClipboard } from './clipboard';
import { importSql } from './sql/import';
import { parseDiagramFile } from './io';
import { getSqliteEngine } from './sqlite/engine';
import { introspectionToDiagram } from './introspectImport';
import { estimateNodeSize } from './geometry';
import { confirmDialog } from '@/components/ui/Modal';
import type { Table } from '@shared/types';

/** In-memory fallback for browsers that refuse clipboard reads. */
let lastCopied: string | null = null;

export function copySelection(tableIds?: string[]): string | null {
  const s = useStore.getState();
  const ids = tableIds ?? s.selection.tableIds;
  if (!ids.length) return null;
  const text = encodeClipboard(s.diagram, ids);
  lastCopied = text;
  return text;
}

export async function copySelectionToClipboard(tableIds?: string[]): Promise<boolean> {
  const text = copySelection(tableIds);
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* the in-memory copy still works within this tab */
  }
  const n = JSON.parse(text).tables.length as number;
  useStore.getState().toast('success', `Copied ${n} table${n === 1 ? '' : 's'}.`);
  return true;
}

export function cutSelection(): void {
  const s = useStore.getState();
  const ids = s.selection.tableIds;
  if (!copySelection(ids)) return;
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

/** Paste from the system clipboard (falls back to the last in-app copy). */
export async function pasteFromClipboard(at?: { x: number; y: number }): Promise<void> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }
  if (!text && lastCopied) text = lastCopied;
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
