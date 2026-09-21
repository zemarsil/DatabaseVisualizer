/**
 * The workspace library: every workspace you have worked on, kept in IndexedDB
 * with a thumbnail, plus named checkpoints per diagram. The autosave in
 * useStore still writes the open workspace to localStorage for a fast boot;
 * this adds the "open recent" list and snapshots you can go back to.
 *
 * A record holds a whole workspace — every sheet — while a checkpoint holds one
 * diagram, and hangs off that sheet's id rather than the workspace's, so a
 * snapshot follows the diagram it was taken of.
 */
import type { Diagram, Workspace } from '@shared/types';
import { parseDiagramFile, parseWorkspaceFile, serializeDiagram, serializeWorkspace } from './io';
import { diagramThumbnail } from './thumbnail';
import { newId } from './ids';
import { currentWorkspace, useStore, workspaceChanged } from '@/store/useStore';
import { getCurrentWorkspaceId, newWorkspaceId, setCurrentWorkspaceId } from './currentId';

export { getCurrentWorkspaceId, newWorkspaceId, setCurrentWorkspaceId };

const DB_NAME = 'dbviz';
const DB_VERSION = 1;
const DIAGRAMS = 'diagrams';
const CHECKPOINTS = 'checkpoints';
const AUTOSAVE_MS = 1500;

export interface WorkspaceRecord {
  id: string;
  name: string;
  /** Dialect of the sheet that was open, for the one-line summary. */
  dialect: Diagram['dialect'];
  /** Tables across every sheet. */
  tableCount: number;
  /**
   * Code nodes across every sheet. Optional because records written before the
   * library learned that a diagram can be all code have no such field, and a
   * missing count means "unknown", which reads the same as zero here.
   */
  codeCount?: number;
  sheetCount: number;
  /** Sheet ids, so the checkpoints belonging to this workspace can be found without parsing it. */
  sheetIds: string[];
  updatedAt: number;
  /** SVG data URL of the sheet that was open. */
  thumbnail: string;
  /** serializeWorkspace output. */
  data: string;
}

export interface CheckpointRecord {
  id: string;
  /** The sheet this snapshot was taken of. */
  diagramId: string;
  name: string;
  createdAt: number;
  tableCount: number;
  /** As on WorkspaceRecord: absent on checkpoints taken before code maps counted. */
  codeCount?: number;
  data: string;
}

/* ---------------- pure helpers ---------------- */

export function workspaceRecord(ws: Workspace, id: string, updatedAt = Date.now()): WorkspaceRecord {
  const active = ws.sheets.find((s) => s.id === ws.activeSheetId) ?? ws.sheets[0];
  return {
    id,
    name: ws.name || 'Untitled diagram',
    dialect: active.diagram.dialect,
    tableCount: ws.sheets.reduce((n, s) => n + s.diagram.tables.length, 0),
    codeCount: ws.sheets.reduce((n, s) => n + s.diagram.programs.length, 0),
    sheetCount: ws.sheets.length,
    sheetIds: ws.sheets.map((s) => s.id),
    updatedAt,
    thumbnail: diagramThumbnail(active.diagram),
    data: serializeWorkspace(ws),
  };
}

export function checkpointRecord(d: Diagram, diagramId: string, name: string, createdAt = Date.now()): CheckpointRecord {
  return {
    id: newId('ckpt'),
    diagramId,
    name: name.trim() || defaultCheckpointName(createdAt),
    createdAt,
    tableCount: d.tables.length,
    codeCount: d.programs.length,
    data: serializeDiagram(d),
  };
}

export function defaultCheckpointName(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A checkpoint's payload: one diagram. */
export function recordToDiagram(r: { data: string }): Diagram {
  return parseDiagramFile(r.data);
}

export function recordToWorkspace(r: { data: string }): Workspace {
  return parseWorkspaceFile(r.data);
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString();
}

/* ---------------- IndexedDB ---------------- */

function hasIdb(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DIAGRAMS)) db.createObjectStore(DIAGRAMS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(CHECKPOINTS)) {
          const store = db.createObjectStore(CHECKPOINTS, { keyPath: 'id' });
          store.createIndex('diagramId', 'diagramId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function request<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  if (!hasIdb()) return Promise.reject(new Error('IndexedDB is not available'));
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  if (!hasIdb()) return [];
  const all = await request<WorkspaceRecord[]>(DIAGRAMS, 'readonly', (s) => s.getAll());
  return all.map(migrateRecord).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
  if (!hasIdb()) return undefined;
  const r = await request<WorkspaceRecord | undefined>(DIAGRAMS, 'readonly', (s) => s.get(id));
  return r ? migrateRecord(r) : undefined;
}

/** An entry written before workspaces existed holds one diagram, whose sheet id is the entry's own. */
function migrateRecord(r: WorkspaceRecord): WorkspaceRecord {
  return r.sheetIds ? r : { ...r, sheetCount: 1, sheetIds: [r.id] };
}

export async function putWorkspace(record: WorkspaceRecord): Promise<void> {
  if (!hasIdb()) return;
  await request(DIAGRAMS, 'readwrite', (s) => s.put(record));
}

export async function deleteWorkspace(record: Pick<WorkspaceRecord, 'id' | 'sheetIds'>): Promise<void> {
  if (!hasIdb()) return;
  await request(DIAGRAMS, 'readwrite', (s) => s.delete(record.id));
  // Checkpoints hang off sheets; an entry from before workspaces used its own id as the sheet's.
  for (const sheetId of record.sheetIds?.length ? record.sheetIds : [record.id]) {
    for (const c of await listCheckpoints(sheetId)) await deleteCheckpoint(c.id);
  }
}

export async function listCheckpoints(diagramId: string): Promise<CheckpointRecord[]> {
  if (!hasIdb()) return [];
  const all = await request<CheckpointRecord[]>(CHECKPOINTS, 'readonly', (s) => s.index('diagramId').getAll(diagramId));
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putCheckpoint(record: CheckpointRecord): Promise<void> {
  if (!hasIdb()) return;
  await request(CHECKPOINTS, 'readwrite', (s) => s.put(record));
}

export async function deleteCheckpoint(id: string): Promise<void> {
  if (!hasIdb()) return;
  await request(CHECKPOINTS, 'readwrite', (s) => s.delete(id));
}

/* ---------------- autosave into the library ---------------- */

let installed = false;

/** Keeps the open workspace's library record fresh (debounced). Call once. */
export function installLibraryAutosave(): void {
  if (installed || !hasIdb()) return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    void putWorkspace(workspaceRecord(currentWorkspace(useStore.getState()), getCurrentWorkspaceId())).catch(() => undefined);
  };
  useStore.subscribe((state, prev) => {
    if (!workspaceChanged(state, prev)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, AUTOSAVE_MS);
  });
  // Make sure the workspace that was already open shows up in the library.
  setTimeout(save, 500);
}

/** Save the open workspace immediately under the current id (used before opening another one). */
export function flushCurrentWorkspace(): Promise<void> {
  if (!hasIdb()) return Promise.resolve();
  return putWorkspace(workspaceRecord(currentWorkspace(useStore.getState()), getCurrentWorkspaceId())).catch(() => undefined);
}

/** Every "replace the whole workspace" path calls this first, so what it is leaving gets its own library entry instead of being overwritten by what replaces it. */
export async function startFreshWorkspaceEntry(): Promise<void> {
  await flushCurrentWorkspace();
  setCurrentWorkspaceId(newWorkspaceId());
}

/** Snapshot the diagram on the sheet you are on. */
export async function saveCheckpoint(name: string): Promise<CheckpointRecord> {
  const s = useStore.getState();
  const record = checkpointRecord(s.diagram, s.activeSheetId, name);
  await putCheckpoint(record);
  return record;
}

/**
 * "4 tables", "12 code nodes", "4 tables · 12 code nodes" — the one line the
 * library and the checkpoint list use to say how big a saved thing is. It used
 * to count tables alone, which described an entire code map as "0 tables".
 *
 * A record with neither (or one written before code was counted, where the code
 * count is simply unknown) still says something rather than nothing.
 */
export function countLabel(tables: number, code = 0, opts?: { short?: boolean }): string {
  const t = opts?.short ? `${tables} t` : `${tables} table${tables === 1 ? '' : 's'}`;
  const c = opts?.short ? `${code} c` : `${code} code node${code === 1 ? '' : 's'}`;
  if (tables && code) return `${t} · ${c}`;
  if (code) return c;
  return t;
}
