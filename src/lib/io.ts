import {
  AGGREGATE_FUNCTIONS,
  isCodeKind,
  isProgramLanguage,
  isProgramRole,
  isProgramStepOp,
  isRelationshipKind,
  isWindowFunction,
  normalizeVerb,
  programStepOpMeta,
  settleCodeNode,
  type AggregateFunction,
  type CustomType,
  type Derivation,
  type Diagram,
  type DiagramExtension,
  type Group,
  type Note,
  type Program,
  type ProgramStep,
  type Relationship,
  type Sheet,
  type Table,
  type TableDisplay,
  type TableKind,
  type Workspace,
} from '@shared/types';
import { pruneGroupIds } from './groups';
import { emptyDiagram, newSheetId, singleSheetWorkspace } from './model';
import { newId } from './ids';

export const FILE_EXTENSION = '.dbviz.json';

export function serializeDiagram(d: Diagram): string {
  return JSON.stringify(d, null, 2);
}

class InvalidFile extends Error {}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Structured flow derivations. Absent -> undefined (files written before the
 * field existed keep loading unchanged); present -> one sanitised entry per
 * object, so a hand-edited file cannot smuggle in an unknown aggregate.
 */
function parseDerivations(v: unknown): Derivation[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((e: unknown): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
    .map((e) => {
      const aggregate = AGGREGATE_FUNCTIONS.includes(e.aggregate as AggregateFunction) ? (e.aggregate as AggregateFunction) : undefined;
      // A window needs a known function; an unknown one is dropped rather than
      // kept as a value the app would not know how to evaluate.
      const w = e.window && typeof e.window === 'object' ? (e.window as Record<string, unknown>) : null;
      const window = w && isWindowFunction(w.fn) ? { fn: w.fn, orderBy: strArray(w.orderBy), partitionBy: strArray(w.partitionBy) } : undefined;
      return {
        id: typeof e.id === 'string' && e.id ? e.id : newId('drv'),
        targetColumnId: str(e.targetColumnId),
        expression: str(e.expression),
        groupBy: strArray(e.groupBy),
        ...(aggregate ? { aggregate } : {}),
        ...(typeof e.filter === 'string' && e.filter ? { filter: e.filter } : {}),
        ...(window ? { window } : {}),
      };
    });
}

/**
 * Programs and their steps — and, since code maps, the modules, classes and
 * functions inside them. Absent -> an empty list, which is what every file
 * written before programs existed means.
 *
 * A step is sanitised rather than trusted: an unknown op becomes a read, a
 * compute step is stripped of any table and columns a hand-edited file gave it,
 * a call keeps its code target and nothing of a table's, and an entry with no
 * usable shape is skipped. Table, column and code ids are *not* checked against
 * the diagram here, because the caller may be merging this diagram into
 * another one; the linter is where a reference with nothing at the end of it
 * gets reported.
 *
 * Containment is the one reference that is checked, because a node whose
 * parent is missing, or whose parent chain loops back to itself, cannot be
 * drawn at all: those nodes are put at the top level rather than lost.
 */
function parsePrograms(v: unknown): Program[] {
  if (!Array.isArray(v)) return [];
  const out: Program[] = [];
  for (const rp of v) {
    if (!rp || typeof rp !== 'object') continue;
    const p = rp as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    const pos = (p.position ?? {}) as Record<string, unknown>;
    // Kind and language are settled against each other on the way in, so a
    // file claiming a YAML function — or a data file written in Go — loads as
    // the one thing it can be.
    const settled = settleCodeNode(isCodeKind(p.kind) ? p.kind : 'program', isProgramLanguage(p.language) ? p.language : 'other');
    const kind = settled.kind;
    const steps: ProgramStep[] = [];
    // A data file runs nothing, so any steps written on one are dropped here
    // rather than loaded into a node that could never perform them.
    for (const rs of kind === 'data' ? [] : Array.isArray(p.steps) ? p.steps : []) {
      if (!rs || typeof rs !== 'object') continue;
      const s = rs as Record<string, unknown>;
      const op = isProgramStepOp(s.op) ? s.op : 'read';
      const meta = programStepOpMeta(op);
      steps.push({
        id: typeof s.id === 'string' && s.id ? s.id : newId('pstep'),
        op,
        ...(meta.touchesDatabase && typeof s.tableId === 'string' && s.tableId ? { tableId: s.tableId } : {}),
        columnIds: meta.touchesDatabase ? strArray(s.columnIds) : [],
        ...(meta.namesCode && typeof s.codeId === 'string' && s.codeId ? { codeId: s.codeId } : {}),
        ...(meta.touchesDatabase && typeof s.sql === 'string' && s.sql ? { sql: s.sql } : {}),
        ...(typeof s.code === 'string' && s.code ? { code: s.code } : {}),
        ...(typeof s.note === 'string' && s.note ? { note: s.note } : {}),
      });
    }
    out.push({
      id: p.id,
      name: p.name,
      // 'program' is the default and is left unwritten, so a file that never
      // heard of kinds reads back byte for byte as it was written.
      ...(kind !== 'program' ? { kind } : {}),
      ...(typeof p.parentId === 'string' && p.parentId ? { parentId: p.parentId } : {}),
      ...(p.collapsed === true ? { collapsed: true } : {}),
      language: settled.language,
      ...(isProgramRole(p.role) && kind === 'program' ? { role: p.role } : {}),
      ...(typeof p.entrypoint === 'string' && p.entrypoint ? { entrypoint: p.entrypoint } : {}),
      position: { x: num(pos.x), y: num(pos.y) },
      color: str(p.color, 'slate'),
      ...(typeof p.comment === 'string' && p.comment ? { comment: p.comment } : {}),
      steps,
    });
  }
  pruneCodeParents(out);
  return out;
}

/** Drop a parent pointer that names no node in the list, or that would put a node inside itself. */
export function pruneCodeParents(programs: Program[]): void {
  const ids = new Set(programs.map((p) => p.id));
  const byId = new Map(programs.map((p) => [p.id, p]));
  for (const p of programs) {
    if (!p.parentId) continue;
    if (!ids.has(p.parentId) || p.parentId === p.id) {
      delete p.parentId;
      continue;
    }
    // Walk up; meeting this node again means the chain is a loop, and the
    // pointer that closes it is the one dropped.
    const seen = new Set<string>([p.id]);
    let cur = byId.get(p.parentId);
    while (cur) {
      if (seen.has(cur.id)) {
        delete p.parentId;
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidFile('The file is not valid JSON.');
  }
}

/** Parse and validate a saved file. Tolerant of missing optional fields so old files keep loading. */
export function parseDiagramFile(text: string): Diagram {
  return parseDiagramValue(readJson(text));
}

/** The diagram parser proper, over already-decoded JSON: a whole file, or one sheet of a workspace. */
function parseDiagramValue(raw: unknown): Diagram {
  if (!raw || typeof raw !== 'object') throw new InvalidFile('The file does not contain a diagram.');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tables)) throw new InvalidFile('The file has no "tables" array; is this a Database Visualizer file?');

  const dialect = o.dialect === 'mariadb' ? 'mariadb' : o.dialect === 'sqlite' ? 'sqlite' : o.dialect === 'duckdb' ? 'duckdb' : 'postgresql';
  const d = emptyDiagram(dialect, str(o.name, 'Untitled diagram'));

  const tables: Table[] = [];
  for (const rt of o.tables as unknown[]) {
    if (!rt || typeof rt !== 'object') continue;
    const t = rt as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.name !== 'string') continue;
    const pos = (t.position ?? {}) as Record<string, unknown>;
    const kind: TableKind | undefined = t.kind === 'view' ? 'view' : undefined;
    const collapsed: TableDisplay | undefined = t.collapsed === 'keys' || t.collapsed === 'header' ? t.collapsed : undefined;
    tables.push({
      id: t.id,
      name: t.name,
      schema: typeof t.schema === 'string' && t.schema ? t.schema : undefined,
      kind,
      viewSql: kind === 'view' && typeof t.viewSql === 'string' && t.viewSql ? t.viewSql : undefined,
      materialized: kind === 'view' && t.materialized === true ? true : undefined,
      collapsed,
      comment: typeof t.comment === 'string' && t.comment ? t.comment : undefined,
      color: str(t.color, 'blue'),
      groupId: typeof t.groupId === 'string' && t.groupId ? t.groupId : undefined,
      position: { x: num(pos.x), y: num(pos.y) },
      checks: strArray(t.checks),
      columns: (Array.isArray(t.columns) ? t.columns : [])
        .filter((c: unknown): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
        .filter((c) => typeof c.id === 'string' && typeof c.name === 'string')
        .map((c) => ({
          id: c.id as string,
          name: c.name as string,
          type: str(c.type, 'TEXT'),
          nullable: bool(c.nullable, true),
          primaryKey: bool(c.primaryKey),
          unique: bool(c.unique),
          autoIncrement: bool(c.autoIncrement),
          defaultValue: typeof c.defaultValue === 'string' && c.defaultValue ? c.defaultValue : undefined,
          check: typeof c.check === 'string' && c.check ? c.check : undefined,
          comment: typeof c.comment === 'string' && c.comment ? c.comment : undefined,
        })),
      indexes: (Array.isArray(t.indexes) ? t.indexes : [])
        .filter((i: unknown): i is Record<string, unknown> => Boolean(i) && typeof i === 'object')
        .filter((i) => typeof i.id === 'string')
        .map((i) => ({ id: i.id as string, name: str(i.name), unique: bool(i.unique), columnIds: strArray(i.columnIds) })),
    });
  }
  d.tables = tables;

  const rels: Relationship[] = [];
  for (const rr of (Array.isArray(o.relationships) ? o.relationships : []) as unknown[]) {
    if (!rr || typeof rr !== 'object') continue;
    const r = rr as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.sourceTableId !== 'string' || typeof r.targetTableId !== 'string') continue;
    const kind = isRelationshipKind(r.kind) ? r.kind : 'fk';
    rels.push({
      id: r.id,
      kind,
      // Files written before verbs existed (and any verb that does not fit the
      // kind) fall back to the kind's default.
      verb: normalizeVerb(kind, r.verb),
      sourceTableId: r.sourceTableId,
      targetTableId: r.targetTableId,
      sourceColumnIds: strArray(r.sourceColumnIds),
      targetColumnIds: strArray(r.targetColumnIds),
      name: typeof r.name === 'string' && r.name ? r.name : undefined,
      inverseName: typeof r.inverseName === 'string' && r.inverseName ? r.inverseName : undefined,
      onDelete: (r.onDelete as Relationship['onDelete']) ?? 'NO ACTION',
      onUpdate: (r.onUpdate as Relationship['onUpdate']) ?? 'NO ACTION',
      query: typeof r.query === 'string' && r.query ? r.query : undefined,
      note: typeof r.note === 'string' && r.note ? r.note : undefined,
      derivations: parseDerivations(r.derivations),
    });
  }
  d.relationships = rels;

  const groups: Group[] = [];
  for (const rg of (Array.isArray(o.groups) ? o.groups : []) as unknown[]) {
    if (!rg || typeof rg !== 'object') continue;
    const g = rg as Record<string, unknown>;
    if (typeof g.id !== 'string') continue;
    const pos = (g.position ?? {}) as Record<string, unknown>;
    groups.push({
      id: g.id,
      name: str(g.name, 'Group'),
      color: str(g.color, 'slate'),
      external: bool(g.external),
      note: typeof g.note === 'string' && g.note ? g.note : undefined,
      position: { x: num(pos.x), y: num(pos.y) },
    });
  }
  d.groups = groups;
  // A table pointing at a group that is not in the file would draw nothing.
  pruneGroupIds(d);

  const notes: Note[] = [];
  for (const rn of (Array.isArray(o.notes) ? o.notes : []) as unknown[]) {
    if (!rn || typeof rn !== 'object') continue;
    const n = rn as Record<string, unknown>;
    if (typeof n.id !== 'string') continue;
    const pos = (n.position ?? {}) as Record<string, unknown>;
    notes.push({
      id: n.id,
      text: str(n.text),
      position: { x: num(pos.x), y: num(pos.y) },
      width: num(n.width, 220),
      height: num(n.height, 120),
      color: str(n.color, 'yellow'),
    });
  }
  d.notes = notes;

  const customTypes: CustomType[] = [];
  for (const rc of (Array.isArray(o.customTypes) ? o.customTypes : []) as unknown[]) {
    if (!rc || typeof rc !== 'object') continue;
    const c = rc as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.name !== 'string') continue;
    const kind = c.kind === 'composite' ? 'composite' : 'enum';
    customTypes.push({
      id: c.id,
      name: c.name,
      kind,
      comment: typeof c.comment === 'string' && c.comment ? c.comment : undefined,
      values: kind === 'enum' ? strArray(c.values) : undefined,
      fields:
        kind === 'composite'
          ? (Array.isArray(c.fields) ? c.fields : [])
              .filter((f: unknown): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
              .filter((f) => typeof f.id === 'string' && typeof f.name === 'string')
              .map((f) => ({
                id: f.id as string,
                name: f.name as string,
                type: str(f.type, 'TEXT'),
                comment: typeof f.comment === 'string' && f.comment ? f.comment : undefined,
              }))
          : undefined,
    });
  }
  d.customTypes = customTypes;

  const extensions: DiagramExtension[] = [];
  const seenExtensions = new Set<string>();
  for (const re of (Array.isArray(o.extensions) ? o.extensions : []) as unknown[]) {
    if (!re || typeof re !== 'object') continue;
    const e = re as Record<string, unknown>;
    const name = str(e.name).trim();
    // The name is the identity: an engine cannot enable the same extension
    // twice, so a file that lists one twice keeps the first entry.
    if (!name || seenExtensions.has(name.toLowerCase())) continue;
    seenExtensions.add(name.toLowerCase());
    extensions.push({
      id: typeof e.id === 'string' && e.id ? e.id : newId('ext'),
      name,
      schema: typeof e.schema === 'string' && e.schema ? e.schema : undefined,
      version: typeof e.version === 'string' && e.version ? e.version : undefined,
      comment: typeof e.comment === 'string' && e.comment ? e.comment : undefined,
    });
  }
  d.extensions = extensions;

  d.programs = parsePrograms(o.programs);

  if (o.viewport && typeof o.viewport === 'object') {
    const v = o.viewport as Record<string, unknown>;
    d.viewport = { x: num(v.x), y: num(v.y), zoom: num(v.zoom, 1) || 1 };
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Workspaces: several diagrams in one file                            */
/* ------------------------------------------------------------------ */

/**
 * A workspace as a file. One diagram whose name is the workspace name is
 * written as a bare diagram — byte for byte the format this app has always
 * written — so single-diagram files stay readable by anything that reads them
 * today. Anything richer gets the envelope, with each sheet a diagram object
 * carrying its id.
 */
export function serializeWorkspace(ws: Workspace): string {
  const only = ws.sheets.length === 1 ? ws.sheets[0] : null;
  if (only && only.diagram.name === ws.name) return serializeDiagram(only.diagram);
  return JSON.stringify(
    {
      version: 1,
      kind: 'workspace',
      name: ws.name,
      activeSheet: ws.activeSheetId,
      sheets: ws.sheets.map((s) => ({ id: s.id, ...s.diagram })),
    },
    null,
    2,
  );
}

/**
 * Reads either shape: a workspace envelope, or a bare diagram (which becomes a
 * workspace of one). `sheetId` names that one sheet — the store passes the id
 * an older autosave was already known by, so its checkpoints stay attached.
 */
export function parseWorkspaceFile(text: string, opts?: { sheetId?: string }): Workspace {
  const raw = readJson(text);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(o.sheets)) return singleSheetWorkspace(parseDiagramValue(raw), opts?.sheetId);

  const sheets: Sheet[] = [];
  const seen = new Set<string>();
  o.sheets.forEach((entry, i) => {
    let diagram: Diagram;
    try {
      diagram = parseDiagramValue(entry);
    } catch (e) {
      throw new InvalidFile(`Sheet ${i + 1} of this workspace could not be read: ${e instanceof Error ? e.message : 'unknown problem'}`);
    }
    const e = entry as Record<string, unknown>;
    // A duplicated id would make two tabs share one identity (and one set of checkpoints).
    const id = typeof e.id === 'string' && e.id && !seen.has(e.id) ? e.id : newSheetId();
    seen.add(id);
    sheets.push({ id, diagram });
  });
  if (sheets.length === 0) throw new InvalidFile('The workspace has no diagrams in it.');

  const active = typeof o.activeSheet === 'string' && seen.has(o.activeSheet) ? o.activeSheet : sheets[0].id;
  return { version: 1, name: str(o.name) || sheets[0].diagram.name, sheets, activeSheetId: active };
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Safe file name from the diagram name. */
export function fileSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'diagram';
}
