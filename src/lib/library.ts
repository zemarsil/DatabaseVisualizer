/**
 * The diagram library: every diagram you have worked on, kept in IndexedDB
 * with a thumbnail, plus named checkpoints per diagram. The autosave in
 * useStore still writes the current diagram to localStorage for a fast boot;
 * this adds the "open recent" list and snapshots you can go back to.
 */
import type { Diagram } from '@shared/types';
import { parseDiagramFile, serializeDiagram } from './io';
import { diagramThumbnail } from './thumbnail';
import { newId } from './ids';
import { useStore } from '@/store/useStore';

const DB_NAME = 'dbviz';
const DB_VERSION = 1;
const DIAGRAMS = 'diagrams';
const CHECKPOINTS = 'checkpoints';
const CURRENT_KEY = 'dbviz:currentId';
const AUTOSAVE_MS = 1500;

export interface DiagramRecord {
  id: string;
  name: string;
  dialect: Diagram['dialect'];
  tableCount: number;
  updatedAt: number;
  /** SVG data URL. */
  thumbnail: string;
  /** serializeDiagram output. */
  data: string;
}

export interface CheckpointRecord {
  id: string;
  diagramId: string;
  name: string;
  createdAt: number;
  tableCount: number;
  data: string;
}

/* ---------------- pure helpers ---------------- */

export function diagramRecord(d: Diagram, id: string, updatedAt = Date.now()): DiagramRecord {
  return { id, name: d.name || 'Untitled diagram', dialect: d.dialect, tableCount: d.tables.length, updatedAt, thumbnail: diagramThumbnail(d), data: serializeDiagram(d) };
}

export function checkpointRecord(d: Diagram, diagramId: string, name: string, createdAt = Date.now()): CheckpointRecord {
  return { id: newId('ckpt'), diagramId, name: name.trim() || defaultCheckpointName(createdAt), createdAt, tableCount: d.tables.length, data: serializeDiagram(d) };
}

export function defaultCheckpointName(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function recordToDiagram(r: { data: string }): Diagram {
  return parseDiagramFile(r.data);
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

/* ---------------- current diagram identity ---------------- */

export function newDiagramId(): string {
  return newId('dgm');
}

export function getCurrentDiagramId(): string {
  try {
    const id = localStorage.getItem(CURRENT_KEY);
    if (id) return id;
    const fresh = newDiagramId();
    localStorage.setItem(CURRENT_KEY, fresh);
    return fresh;
  } catch {
    return 'dgm_session';
  }
}

export function setCurrentDiagramId(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* ignore */
  }
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

export async function listDiagrams(): Promise<DiagramRecord[]> {
  if (!hasIdb()) return [];
  const all = await request<DiagramRecord[]>(DIAGRAMS, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDiagram(id: string): Promise<DiagramRecord | undefined> {
  if (!hasIdb()) return undefined;
  return request<DiagramRecord | undefined>(DIAGRAMS, 'readonly', (s) => s.get(id));
}

export async function putDiagram(record: DiagramRecord): Promise<void> {
  if (!hasIdb()) return;
  await request(DIAGRAMS, 'readwrite', (s) => s.put(record));
}

export async function deleteDiagram(id: string): Promise<void> {
  if (!hasIdb()) return;
  await request(DIAGRAMS, 'readwrite', (s) => s.delete(id));
  const cks = await listCheckpoints(id);
  for (const c of cks) await deleteCheckpoint(c.id);
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

/** Keeps the current diagram's library record fresh (debounced). Call once. */
export function installLibraryAutosave(): void {
  if (installed || !hasIdb()) return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    const d = useStore.getState().diagram;
    void putDiagram(diagramRecord(d, getCurrentDiagramId())).catch(() => undefined);
  };
  useStore.subscribe((state, prev) => {
    if (state.diagram === prev.diagram) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, AUTOSAVE_MS);
  });
  // Make sure the diagram that was already open shows up in the library.
  setTimeout(save, 500);
}

/** Save the current diagram immediately under the current id (used before switching diagrams). */
export function flushCurrentDiagram(): Promise<void> {
  if (!hasIdb()) return Promise.resolve();
  return putDiagram(diagramRecord(useStore.getState().diagram, getCurrentDiagramId())).catch(() => undefined);
}

export async function saveCheckpoint(name: string): Promise<CheckpointRecord> {
  const d = useStore.getState().diagram;
  const record = checkpointRecord(d, getCurrentDiagramId(), name);
  await putCheckpoint(record);
  return record;
}
