import {
  kindMeta,
  programStepOpMeta,
  type Column,
  type CustomType,
  type CustomTypeField,
  type Derivation,
  type Diagram,
  type DiagramExtension,
  type Dialect,
  type Group,
  type Index,
  type Note,
  type Program,
  type ProgramLanguage,
  type ProgramStep,
  type Relationship,
  type RelationshipKind,
  type Table,
  type Workspace,
} from '@shared/types';
import { columnNameKey, matchColumnsByName } from './derivation';
import { newId } from './ids';
import { colorForName } from './palette';

export function emptyDiagram(dialect: Dialect = 'postgresql', name = 'Untitled diagram'): Diagram {
  return { version: 1, name, dialect, tables: [], relationships: [], notes: [], groups: [], customTypes: [], extensions: [], programs: [] };
}

export function newSheetId(): string {
  return newId('sht');
}

/** A workspace holding one diagram — what every file written before workspaces existed becomes. */
export function singleSheetWorkspace(d: Diagram, id: string = newSheetId()): Workspace {
  return { version: 1, name: d.name, sheets: [{ id, diagram: d }], activeSheetId: id };
}

/** A new workspace: one empty diagram, named the same, so it still saves as a plain diagram file. */
export function emptyWorkspace(dialect: Dialect = 'postgresql', name = 'Untitled diagram'): Workspace {
  return singleSheetWorkspace(emptyDiagram(dialect, name));
}

/** "Untitled diagram 2" — a name no other sheet in the workspace is using. */
export function uniqueSheetName(taken: string[], base: string): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const next = `${base} ${i}`;
    if (!used.has(next)) return next;
  }
}

export function isView(t: Pick<Table, 'kind'>): boolean {
  return t.kind === 'view';
}

export function createColumn(partial: Partial<Column> & { name: string }): Column {
  return {
    id: newId('col'),
    type: partial.type ?? (partial.primaryKey ? 'INTEGER' : 'VARCHAR(255)'),
    nullable: partial.nullable ?? !partial.primaryKey,
    primaryKey: partial.primaryKey ?? false,
    unique: partial.unique ?? false,
    autoIncrement: partial.autoIncrement ?? false,
    ...partial,
    name: partial.name,
  };
}

export function createTable(partial: Partial<Table> & { name: string }): Table {
  // `id` is pulled out so callers cloning a table can pass `id: undefined` and
  // still get a fresh id (a plain spread would overwrite it with undefined).
  const { id, ...rest } = partial;
  return {
    id: id ?? newId('tbl'),
    columns: [],
    indexes: [],
    checks: [],
    position: { x: 0, y: 0 },
    color: colorForName(partial.name),
    ...rest,
  };
}

export function createIndex(partial: Partial<Index> & { columnIds: string[] }): Index {
  return { id: newId('idx'), name: '', unique: false, ...partial };
}

export function createRelationship(partial: Omit<Relationship, 'id'> & { id?: string }): Relationship {
  return { id: newId('rel'), onDelete: 'NO ACTION', onUpdate: 'NO ACTION', ...partial };
}

export function createGroup(partial: Partial<Group> = {}): Group {
  return { id: newId('grp'), name: 'New group', color: 'slate', external: false, position: { x: 0, y: 0 }, ...partial };
}

export function createDerivation(partial: Partial<Derivation> = {}): Derivation {
  const { aggregate, window, ...rest } = partial;
  return {
    id: newId('drv'),
    targetColumnId: '',
    expression: '',
    groupBy: [],
    ...rest,
    // null is accepted on the type ("no aggregate") but never stored, so a
    // derivation round-trips through JSON unchanged.
    ...(aggregate ? { aggregate } : {}),
    ...(window ? { window: { fn: window.fn, orderBy: [...(window.orderBy ?? [])], partitionBy: [...(window.partitionBy ?? [])] } } : {}),
  };
}

export function createNote(partial: Partial<Note> = {}): Note {
  const { id, ...rest } = partial;
  return { id: id ?? newId('note'), text: 'New note', position: { x: 0, y: 0 }, width: 220, height: 120, color: 'yellow', ...rest };
}

export function createProgramStep(partial: Partial<ProgramStep> = {}): ProgramStep {
  const { id, op, tableId, codeId, ...rest } = partial;
  const step: ProgramStep = { id: id ?? newId('pstep'), op: op ?? 'read', columnIds: [], ...rest };
  // Each op names one kind of thing or nothing: a table on a compute step, or a
  // table on a call, would be a contradiction the rest of the app would have to
  // keep checking for, so it is settled here once.
  const meta = programStepOpMeta(step.op);
  if (meta.touchesDatabase && tableId) step.tableId = tableId;
  if (meta.namesCode && codeId) step.codeId = codeId;
  if (!meta.touchesDatabase) {
    step.columnIds = [];
    delete step.sql;
  }
  return step;
}

export function createProgram(partial: Partial<Program> = {}): Program {
  const { id, name, ...rest } = partial;
  const finalName = name ?? 'new_program';
  return {
    id: id ?? newId('prg'),
    language: 'python' as ProgramLanguage,
    position: { x: 0, y: 0 },
    color: colorForName(finalName),
    steps: [],
    ...rest,
    name: finalName,
  };
}

/**
 * Next free name like "worker_2" among the nodes that share a container. Two
 * classes may each have a `save`, so the namespace is the siblings, not the
 * whole diagram; a top-level program only has to be distinct from the other
 * top-level nodes.
 */
export function uniqueProgramName(d: Diagram, base = 'new_program', parentId?: string): string {
  const names = new Set(d.programs.filter((p) => (p.parentId ?? null) === (parentId ?? null)).map((p) => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`.toLowerCase())) i++;
  return `${base}_${i}`;
}

export function programById(d: Diagram, id: string): Program | undefined {
  return d.programs.find((p) => p.id === id);
}

export function createCustomTypeField(partial: Partial<CustomTypeField> & { name: string }): CustomTypeField {
  return { id: newId('ctf'), type: 'TEXT', ...partial, name: partial.name };
}

export function createCustomType(partial: Partial<CustomType> & { name: string; kind: CustomType['kind'] }): CustomType {
  return {
    id: newId('ctype'),
    values: partial.kind === 'enum' ? ['value_1'] : undefined,
    fields: partial.kind === 'composite' ? [createCustomTypeField({ name: 'field_1' })] : undefined,
    ...partial,
    name: partial.name,
  };
}

/** Next free custom type name like "my_type_2". Names live in the same namespace as SQL types, case-insensitive. */
export function uniqueCustomTypeName(d: Diagram, base = 'my_type'): string {
  const names = new Set(d.customTypes.map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`.toLowerCase())) i++;
  return `${base}_${i}`;
}

export function customTypeByName(d: Diagram, type: string): CustomType | undefined {
  const bare = type.trim().replace(/^["'`]|["'`]$/g, '');
  return d.customTypes.find((t) => t.name.toLowerCase() === bare.toLowerCase());
}

export function createExtension(partial: Partial<DiagramExtension> & { name: string }): DiagramExtension {
  const { id, ...rest } = partial;
  return { id: id ?? newId('ext'), ...rest, name: partial.name.trim() };
}

/** The declaration for an extension, by the name the engine knows it by (case-insensitive). */
export function extensionByName(d: Diagram, name: string): DiagramExtension | undefined {
  const key = name.trim().toLowerCase();
  return d.extensions.find((e) => e.name.toLowerCase() === key);
}

export function hasExtension(d: Diagram, name: string): boolean {
  return extensionByName(d, name) !== undefined;
}

/** Next free table name like "table_3". */
export function uniqueTableName(d: Diagram, base = 'new_table'): string {
  const names = new Set(d.tables.map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** Next free group name like "Source DB 2". */
export function uniqueGroupName(d: Diagram, base = 'New group'): string {
  const names = new Set(d.groups.map((g) => g.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

export function uniqueColumnName(t: Table, base = 'column'): string {
  const names = new Set(t.columns.map((c) => c.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function tableById(d: Diagram, id: string): Table | undefined {
  return d.tables.find((t) => t.id === id);
}

export function columnById(t: Table | undefined, id: string): Column | undefined {
  return t?.columns.find((c) => c.id === id);
}

export function findColumnOwner(d: Diagram, columnId: string): { table: Table; column: Column } | undefined {
  for (const t of d.tables) {
    const c = t.columns.find((col) => col.id === columnId);
    if (c) return { table: t, column: c };
  }
  return undefined;
}

/** Column ids referenced by any FK where this table is the referencing side. */
export function foreignKeyColumnIds(d: Diagram, tableId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of d.relationships) {
    if (r.kind === 'fk' && r.sourceTableId === tableId) r.sourceColumnIds.forEach((id) => ids.add(id));
  }
  return ids;
}

/**
 * Patch that moves a relationship to another kind while keeping its columns
 * meaningful: a foreign key needs a column pair, so one is filled in from the
 * primary key when the connection had none, and a serialized copy is anchored
 * to the single column that stores it, so everything else is dropped.
 *
 * Lives here rather than in either caller because the inspector's kind picker
 * and the edge context menu both change a connection's kind, and two copies of
 * these rules would drift.
 */
export function relationshipKindPatch(d: Diagram, r: Relationship, kind: RelationshipKind): Partial<Relationship> {
  if (kind === 'embed') return { kind, sourceColumnIds: r.sourceColumnIds.slice(0, 1), targetColumnIds: [] };
  if (kind !== 'fk') return { kind };
  const src = tableById(d, r.sourceTableId);
  const tgt = tableById(d, r.targetTableId);
  if (!src?.columns.length || !tgt?.columns.length) return { kind };
  const sourceColumnIds = r.sourceColumnIds.filter(Boolean);
  const targetColumnIds = r.targetColumnIds.filter(Boolean);
  return {
    kind,
    sourceColumnIds: sourceColumnIds.length ? sourceColumnIds : [src.columns[0].id],
    targetColumnIds: targetColumnIds.length ? targetColumnIds : [(tgt.columns.find((c) => c.primaryKey) ?? tgt.columns[0]).id],
  };
}

/** Column ids of this table that hold another table serialized inside them. */
export function embeddedColumnIds(d: Diagram, tableId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of d.relationships) {
    if (r.kind === 'embed' && r.sourceTableId === tableId && r.sourceColumnIds[0]) ids.add(r.sourceColumnIds[0]);
  }
  return ids;
}

/**
 * Derivations that fill a flow's still-unmapped target columns from source
 * columns of the same name: plain passthroughs, no aggregate, carrying forward
 * the grouping and filter of the entries already there so the generator can
 * still write the whole set as one INSERT ... SELECT.
 */
export function derivationsMatchedByName(src: Table, tgt: Table, existing: Derivation[]): Derivation[] {
  // A table feeding itself would match every column to itself, which says nothing.
  if (src.id === tgt.id) return [];
  // Same "the next column is rolled up like the last one" assumption the
  // inspector's Add button makes; the aggregate is deliberately not copied,
  // because a name match is a column carried across, not a rollup.
  const like = existing[existing.length - 1];
  return matchColumnsByName(src.columns, tgt.columns, existing).map((m) =>
    createDerivation({
      targetColumnId: m.targetColumnId,
      expression: m.sourceColumnName,
      groupBy: [...(like?.groupBy ?? [])],
      filter: like?.filter,
    }),
  );
}

/**
 * The same data flow aimed at another table: one source feeding five tables
 * that share a shape is five relationships, and this builds the other four from
 * the one already filled in.
 *
 * Each derivation is re-pointed at the column of `to` that carries the same
 * name as the column it filled in `from`; a derivation with no counterpart
 * there is dropped rather than left pointing at a column of another table. The
 * tagged query is not carried over — it names the old target table, so copying
 * it would produce SQL that quietly writes to the wrong place.
 */
export function flowCopyForTable(r: Relationship, from: Table, to: Table): Omit<Relationship, 'id'> {
  const byKey = new Map<string, Column>();
  for (const c of to.columns) {
    const key = columnNameKey(c.name);
    if (key && !byKey.has(key)) byKey.set(key, c);
  }
  const derivations: Derivation[] = [];
  for (const dv of r.derivations ?? []) {
    const name = from.columns.find((c) => c.id === dv.targetColumnId)?.name;
    const column = name ? (to.columns.find((c) => c.name.trim() === name.trim()) ?? byKey.get(columnNameKey(name))) : undefined;
    if (!column) continue;
    const { id: _id, ...rest } = dv;
    derivations.push(createDerivation({ ...rest, targetColumnId: column.id, groupBy: [...dv.groupBy] }));
  }
  return {
    kind: 'flow',
    ...(r.verb ? { verb: r.verb } : {}),
    sourceTableId: r.sourceTableId,
    // The source end can keep its anchor column; the target end's belongs to the
    // table being copied away from, so the new edge meets the header instead.
    sourceColumnIds: [...r.sourceColumnIds],
    targetTableId: to.id,
    targetColumnIds: [],
    ...(r.name ? { name: r.name } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(derivations.length ? { derivations } : {}),
  };
}

/**
 * Program steps after tables and columns have been deleted.
 *
 * Column references are dropped, because a column that is gone says nothing.
 * A step whose *table* is gone is deliberately kept, dangling id and all: it
 * may carry hand-written code and a note, and silently deleting that to tidy up
 * a reference would throw away the only copy. The canvas simply draws no edge
 * for it and the linter reports it, with a one-click fix that removes the step
 * once the user agrees that is what they want. A call whose callee is gone is
 * kept for exactly the same reason, and by the same rule.
 */
export function pruneProgramRefs(d: Diagram): Program[] {
  const columns = new Set(d.tables.flatMap((t) => t.columns.map((c) => c.id)));
  return d.programs.map((p) => ({
    ...p,
    steps: p.steps.map((s) => ({ ...s, columnIds: s.columnIds.filter((id) => columns.has(id)) })),
  }));
}

/** Remove dangling references after tables/columns are deleted. */
export function pruneRelationships(d: Diagram): Diagram {
  const tables = new Set(d.tables.map((t) => t.id));
  const columns = new Set(d.tables.flatMap((t) => t.columns.map((c) => c.id)));
  const relationships = d.relationships
    .filter((r) => tables.has(r.sourceTableId) && tables.has(r.targetTableId))
    .map((r) => ({
      ...r,
      sourceColumnIds: r.sourceColumnIds.filter((id) => columns.has(id)),
      targetColumnIds: r.targetColumnIds.filter((id) => columns.has(id)),
      // A derivation whose target column is gone has nothing left to populate.
      ...(r.derivations ? { derivations: r.derivations.filter((dv) => columns.has(dv.targetColumnId)) } : {}),
    }))
    // Only column-pair kinds (FKs) become meaningless without their columns; the
    // documentation kinds are table-to-table and survive a column being dropped.
    .filter((r) => !kindMeta(r.kind).needsColumnPairs || (r.sourceColumnIds.length > 0 && r.targetColumnIds.length > 0));
  const tablesOut = d.tables.map((t) => ({
    ...t,
    indexes: t.indexes.map((i) => ({ ...i, columnIds: i.columnIds.filter((id) => columns.has(id)) })).filter((i) => i.columnIds.length > 0),
  }));
  return { ...d, tables: tablesOut, relationships, programs: pruneProgramRefs(d) };
}

/**
 * Deep-copy code nodes with fresh ids (for copy/paste and duplicate).
 *
 * Containment and calls are re-pointed within the copied set, so a copied
 * module still holds its copied functions and they still call each other. A
 * step that named something outside the set keeps its pointer only when the
 * destination diagram has that very node or table (a paste back into the same
 * diagram), and otherwise keeps everything but the pointer — the code and the
 * note are the part nobody can rebuild, the pointer would only ever dangle.
 * `tableIdMap` is how tables copied alongside are found again, and
 * `columnIdMap` their columns.
 */
export function clonePrograms(
  programs: Program[],
  tableIdMap: Map<string, string>,
  existing: Diagram | null,
  offset: { x: number; y: number } = { x: 40, y: 40 },
  columnIdMap: Map<string, string> = new Map(),
): Program[] {
  const idMap = new Map(programs.map((p) => [p.id, newId('prg')] as const));
  const knownCode = new Set((existing?.programs ?? []).map((p) => p.id));
  const knownTables = new Set((existing?.tables ?? []).map((t) => t.id));
  const knownColumns = new Set((existing?.tables ?? []).flatMap((t) => t.columns.map((c) => c.id)));
  // A column id survives when its table came along (and was re-minted) or
  // when the destination already has it; anything else would dangle.
  const pastedColumns = new Set(columnIdMap.values());
  return programs.map((p) => {
    const parentId = p.parentId ? (idMap.get(p.parentId) ?? (knownCode.has(p.parentId) ? p.parentId : undefined)) : undefined;
    const copy: Program = {
      ...p,
      id: idMap.get(p.id)!,
      position: { x: p.position.x + offset.x, y: p.position.y + offset.y },
      steps: p.steps.map((s) => {
        const codeId = s.codeId ? (idMap.get(s.codeId) ?? (knownCode.has(s.codeId) ? s.codeId : undefined)) : undefined;
        const tableId = s.tableId ? (tableIdMap.get(s.tableId) ?? (knownTables.has(s.tableId) ? s.tableId : undefined)) : undefined;
        const columnIds = tableId ? s.columnIds.map((id) => columnIdMap.get(id) ?? id).filter((id) => pastedColumns.has(id) || knownColumns.has(id)) : [];
        const { codeId: _c, tableId: _t, ...rest } = s;
        return createProgramStep({ ...rest, id: undefined, columnIds, ...(codeId ? { codeId } : {}), ...(tableId ? { tableId } : {}) });
      }),
    };
    delete copy.parentId;
    if (parentId) copy.parentId = parentId;
    return copy;
  });
}

/**
 * Deep-copy tables with fresh ids (for copy/paste). Relationships are kept only
 * when both ends are inside the copied set; their column ids are remapped.
 * Names are made unique against `existing`, and a group membership survives
 * only when that group exists in the destination diagram. `tableIdMap` says
 * which copy each original became, for anything else pasted alongside.
 */
export function cloneTables(
  tables: Table[],
  relationships: Relationship[],
  existing: Diagram | null,
  offset: { x: number; y: number } = { x: 40, y: 40 },
): { tables: Table[]; relationships: Relationship[]; tableIdMap: Map<string, string>; columnIdMap: Map<string, string> } {
  const tableIdMap = new Map<string, string>();
  const columnIdMap = new Map<string, string>();
  const scratch: Diagram = existing ? { ...existing, tables: [...existing.tables] } : emptyDiagram();
  const groupIds = new Set((existing?.groups ?? []).map((g) => g.id));
  const out: Table[] = [];
  for (const t of tables) {
    const copy: Table = {
      ...t,
      id: newId('tbl'),
      name: uniqueTableName(scratch, t.name),
      position: { x: t.position.x + offset.x, y: t.position.y + offset.y },
      groupId: t.groupId && groupIds.has(t.groupId) ? t.groupId : undefined,
      columns: t.columns.map((c) => {
        const id = newId('col');
        columnIdMap.set(c.id, id);
        return { ...c, id };
      }),
      indexes: [],
      checks: [...t.checks],
    };
    copy.indexes = t.indexes.map((ix) => ({ ...ix, id: newId('idx'), columnIds: ix.columnIds.map((c) => columnIdMap.get(c) ?? c) }));
    tableIdMap.set(t.id, copy.id);
    scratch.tables.push(copy);
    out.push(copy);
  }
  const rels: Relationship[] = [];
  for (const r of relationships) {
    const s = tableIdMap.get(r.sourceTableId);
    const t = tableIdMap.get(r.targetTableId);
    if (!s || !t) continue;
    rels.push({
      ...r,
      id: newId('rel'),
      sourceTableId: s,
      targetTableId: t,
      sourceColumnIds: r.sourceColumnIds.map((c) => columnIdMap.get(c) ?? c),
      targetColumnIds: r.targetColumnIds.map((c) => columnIdMap.get(c) ?? c),
      ...(r.derivations
        ? { derivations: r.derivations.map((dv) => ({ ...dv, id: newId('drv'), targetColumnId: columnIdMap.get(dv.targetColumnId) ?? dv.targetColumnId })) }
        : {}),
    });
  }
  return { tables: out, relationships: rels, tableIdMap, columnIdMap };
}

/** Custom types referenced by the given tables' column types (case-insensitive name match). */
export function customTypesUsedBy(d: Diagram, tables: Table[]): CustomType[] {
  const used = new Set<string>();
  for (const t of tables) for (const c of t.columns) used.add(c.type.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase());
  return d.customTypes.filter((ct) => used.has(ct.name.toLowerCase()));
}
