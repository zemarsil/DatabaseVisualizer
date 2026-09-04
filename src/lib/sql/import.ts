import type { CustomType, Diagram, Dialect, Relationship, Table } from '@shared/types';
import { createColumn, createCustomTypeField, createIndex, createRelationship, createTable } from '../model';
import { newId } from '../ids';
import { parseSql, type ParseResult, type ParsedTable } from './parser';

export interface ImportResult {
  tables: Table[];
  relationships: Relationship[];
  customTypes: CustomType[];
  errors: string[];
  warnings: string[];
  statementCount: number;
}

/** Turn a parser result into diagram tables and relationships (ids assigned, positions in a grid). */
export function parseResultToDiagram(res: ParseResult, existing: Diagram | null = null): ImportResult {
  const warnings = res.warnings.map((w) => `line ${w.line}: ${w.message}`);
  const errors = res.errors.map((e) => `line ${e.line}:${e.col}: ${e.message}`);
  const tables: Table[] = [];
  const relationships: Relationship[] = [];
  const byName = new Map<string, Table>();
  const existingNames = new Set((existing?.tables ?? []).map((t) => t.name.toLowerCase()));

  const keyOf = (name: string) => name.toLowerCase();

  for (const pt of res.tables) {
    const t = parsedTableToTable(pt);
    if (existingNames.has(keyOf(t.name))) warnings.push(`Table ${t.name} already exists in the diagram; the imported copy was renamed.`);
    let name = t.name;
    let i = 2;
    while (existingNames.has(keyOf(name)) || byName.has(keyOf(name))) name = `${t.name}_${i++}`;
    t.name = name;
    byName.set(keyOf(pt.name), t);
    tables.push(t);
  }

  // Referenced tables that are not defined get a stub so the relationship can be drawn.
  const ensureTarget = (refName: string, refColumns: string[], from: string): Table => {
    const key = keyOf(refName);
    let target = byName.get(key);
    if (target) return target;
    const fromExisting = existing?.tables.find((t) => keyOf(t.name) === key);
    if (fromExisting) return fromExisting;
    warnings.push(`Table ${refName} is referenced by ${from} but not defined; a placeholder table was created.`);
    target = createTable({ name: refName, comment: `Placeholder created for a reference from ${from}` });
    for (const c of refColumns.length ? refColumns : ['id']) {
      target.columns.push(createColumn({ name: c, type: 'INTEGER', primaryKey: true, nullable: false }));
    }
    byName.set(key, target);
    tables.push(target);
    return target;
  };

  for (const pt of res.tables) {
    const src = byName.get(keyOf(pt.name))!;
    const fks = [...pt.foreignKeys];
    for (const c of pt.columns) {
      if (c.references) fks.push({ ...c.references, columns: [c.name] });
    }
    for (const fk of fks) {
      const target = ensureTarget(fk.refTable, fk.refColumns, pt.name);
      const sourceColumnIds = fk.columns.map((n) => src.columns.find((c) => c.name === n)?.id).filter((x): x is string => Boolean(x));
      let refCols = fk.refColumns;
      if (refCols.length === 0) refCols = target.columns.filter((c) => c.primaryKey).map((c) => c.name);
      const targetColumnIds = refCols.map((n) => target.columns.find((c) => c.name === n)?.id).filter((x): x is string => Boolean(x));
      if (sourceColumnIds.length === 0 || targetColumnIds.length === 0) {
        warnings.push(`Foreign key on ${pt.name} (${fk.columns.join(', ')}) could not be matched to columns and was skipped.`);
        continue;
      }
      relationships.push(
        createRelationship({
          kind: 'fk',
          name: fk.name,
          sourceTableId: src.id,
          sourceColumnIds,
          targetTableId: target.id,
          targetColumnIds,
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        }),
      );
    }
  }

  // simple grid so tables never stack before the user runs auto-layout
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  tables.forEach((t, i) => {
    t.position = { x: (i % cols) * 320, y: Math.floor(i / cols) * 260 };
  });

  const existingTypeNames = new Set((existing?.customTypes ?? []).map((t) => t.name.toLowerCase()));
  const customTypes: CustomType[] = [];
  for (const e of res.enums) {
    if (existingTypeNames.has(e.name.toLowerCase())) {
      warnings.push(`Type ${e.name} already exists in the diagram; the imported enum was skipped.`);
      continue;
    }
    customTypes.push({ id: newId('ctype'), name: e.name, kind: 'enum', values: e.values });
  }
  for (const c of res.compositeTypes) {
    if (existingTypeNames.has(c.name.toLowerCase())) {
      warnings.push(`Type ${c.name} already exists in the diagram; the imported type was skipped.`);
      continue;
    }
    customTypes.push({
      id: newId('ctype'),
      name: c.name,
      kind: 'composite',
      fields: c.fields.map((f) => createCustomTypeField({ name: f.name, type: f.type })),
    });
  }

  return { tables, relationships, customTypes, errors, warnings, statementCount: res.statementCount };
}

function parsedTableToTable(pt: ParsedTable): Table {
  const t = createTable({ name: pt.name, schema: pt.schema, comment: pt.comment });
  for (const pc of pt.columns) {
    let defaultValue = pc.defaultValue;
    let autoIncrement = pc.autoIncrement;
    if (defaultValue && /^nextval\s*\(/i.test(defaultValue)) {
      autoIncrement = true;
      defaultValue = undefined;
    }
    t.columns.push(
      createColumn({
        name: pc.name,
        type: pc.type,
        nullable: pc.nullable,
        primaryKey: pc.primaryKey,
        unique: pc.unique,
        autoIncrement,
        defaultValue,
        check: pc.check,
        comment: pc.comment,
      }),
    );
  }
  const idFor = (name: string) => t.columns.find((c) => c.name === name)?.id;
  for (const u of pt.uniques) {
    const ids = u.columns.map(idFor).filter((x): x is string => Boolean(x));
    if (ids.length) t.indexes.push(createIndex({ name: u.name ?? '', columnIds: ids, unique: true }));
  }
  for (const idx of pt.indexes) {
    const ids = idx.columns.map(idFor).filter((x): x is string => Boolean(x));
    if (ids.length) t.indexes.push(createIndex({ name: idx.name ?? '', columnIds: ids, unique: idx.unique }));
  }
  t.checks = [...pt.checks];
  return t;
}

/** Convenience: parse + convert in one call. */
export function importSql(sql: string, dialect: Dialect, existing: Diagram | null = null): ImportResult {
  return parseResultToDiagram(parseSql(sql, dialect), existing);
}
