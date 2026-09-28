/**
 * Schema lint: structural problems the database would reject or that bite
 * later, each with an optional one-click fix. Findings are recomputed from the
 * diagram on every change, so the rules stay cheap (no quadratic scans over
 * columns).
 *
 * A fix mutates an immer draft of the diagram; callers hand it to the store's
 * `mutate` so it lands as one undo step.
 */
import {
  canContain,
  canStepName,
  codeKindMeta,
  codeKindOf,
  engineName,
  isCodeStepOp,
  kindMeta,
  programLanguageMeta,
  programStepOpMeta,
  stepVerb,
  type Column,
  type Diagram,
  type Program,
  type Relationship,
  type Table,
} from '@shared/types';
import { codeChildren, codeNoun, importCycles } from './codemap';
import { dialectHasProcedures } from './procedures';
import { flowDerivations, isDerivationComplete } from './derivation';
import { externalTableIds } from './groups';
import { createColumn, createExtension, createIndex, customTypeByName } from './model';
import { fkTargetIsUnique, isJoinTable, pkColumnIds } from './schemaInfo';
import { isReserved, isSerialType, normalizeType, TYPE_SUGGESTIONS } from './sql/dialect';
import { baseTypeName, diagramText, extensionIsUsed, extensionLabel, extensionsProvidingType, findExtensionDef } from './extensions/registry';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFix {
  label: string;
  apply: (d: Diagram) => void;
  /** Renames and removals change meaning; "Fix all safe" leaves them alone. */
  safe: boolean;
}

export interface LintFinding {
  id: string;
  rule: string;
  severity: LintSeverity;
  message: string;
  tableId?: string;
  columnId?: string;
  relationshipId?: string;
  extensionId?: string;
  programId?: string;
  fix?: LintFix;
}

const IDENTIFIER_LIMIT = { postgresql: 63, mariadb: 64, sqlite: 1000, duckdb: 1000 } as const;

/** Types that mean the same column shape once the dialect noise is removed. */
const TYPE_ALIASES: Record<string, string> = {
  SERIAL: 'INTEGER',
  INT4: 'INTEGER',
  INT: 'INTEGER',
  BIGSERIAL: 'BIGINT',
  INT8: 'BIGINT',
  SMALLSERIAL: 'SMALLINT',
  INT2: 'SMALLINT',
  BOOL: 'BOOLEAN',
  'CHARACTER VARYING': 'VARCHAR',
  TIMESTAMPTZ: 'TIMESTAMP WITH TIME ZONE',
  DECIMAL: 'NUMERIC',
  DEC: 'NUMERIC',
  'DOUBLE PRECISION': 'DOUBLE',
  FLOAT8: 'DOUBLE',
  FLOAT4: 'REAL',
};

/** Canonical spelling for comparing two column types. */
export function canonicalType(type: string): string {
  const norm = normalizeType(type);
  const open = norm.indexOf('(');
  let base: string;
  let args = '';
  let suffix = '';
  if (open === -1) {
    base = norm;
  } else {
    const close = norm.indexOf(')', open);
    base = norm.slice(0, open).trim();
    args = close === -1 ? norm.slice(open) : norm.slice(open, close + 1);
    suffix = close === -1 ? '' : norm.slice(close + 1);
  }
  const aliased = TYPE_ALIASES[base] ?? base;
  return `${aliased}${args}${suffix ? ` ${suffix.trim()}` : ''}`.trim();
}

export function typesMatch(a: string, b: string): boolean {
  return canonicalType(a) === canonicalType(b);
}

/** The referencing column's type should become this to match the referenced one. */
function matchingType(target: Column): string {
  const t = target.type.trim();
  if (isSerialType(t)) {
    const base = normalizeType(t);
    return base === 'BIGSERIAL' ? 'BIGINT' : base === 'SMALLSERIAL' ? 'SMALLINT' : 'INTEGER';
  }
  return t;
}

function indexCovers(t: Table, columnIds: string[]): boolean {
  if (columnIds.length === 0) return false;
  const pk = pkColumnIds(t);
  if (pk.length >= columnIds.length && columnIds.every((id, i) => pk[i] === id)) return true;
  return t.indexes.some((ix) => ix.columnIds.length >= columnIds.length && columnIds.every((id, i) => ix.columnIds[i] === id));
}

function idType(dialect: Diagram['dialect']): string {
  return dialect === 'mariadb' ? 'INT' : 'INTEGER';
}

/**
 * Base names of the types the engine has on its own. A definition that claims one
 * of these is describing something the schema can already use, so a column typed
 * with it needs no extension and must not be flagged.
 */
const BUILTIN_TYPE_NAMES = new Map<Diagram['dialect'], Set<string>>();

function builtinTypeNames(dialect: Diagram['dialect']): Set<string> {
  let set = BUILTIN_TYPE_NAMES.get(dialect);
  if (!set) {
    set = new Set(TYPE_SUGGESTIONS[dialect].map((t) => baseTypeName(t)));
    BUILTIN_TYPE_NAMES.set(dialect, set);
  }
  return set;
}

function draftTable(d: Diagram, id: string): Table | undefined {
  return d.tables.find((t) => t.id === id);
}

export function lintDiagram(d: Diagram): LintFinding[] {
  const out: LintFinding[] = [];
  const external = externalTableIds(d);
  const tableById = new Map(d.tables.map((t) => [t.id, t]));
  const limit = IDENTIFIER_LIMIT[d.dialect] ?? 63;
  const push = (f: Omit<LintFinding, 'id'>) =>
    out.push({ ...f, id: `${f.rule}:${f.tableId ?? ''}:${f.columnId ?? ''}:${f.relationshipId ?? ''}:${f.extensionId ?? ''}:${f.programId ?? ''}` });

  /* ---------- tables and columns ---------- */
  // Group by name first: a snapshot has no notion of which table was renamed
  // most recently, so array order is not a reliable way to pick "the" offender.
  // Flag every table in the clashing group instead, each with its own fix, and
  // let the user pick the one they actually meant to rename.
  const nameGroups = new Map<string, Table[]>();
  for (const t of d.tables) {
    const nameKey = `${(t.schema ?? '').toLowerCase()}.${t.name.trim().toLowerCase()}`;
    const group = nameGroups.get(nameKey);
    if (group) group.push(t);
    else nameGroups.set(nameKey, [t]);
  }

  for (const t of d.tables) {
    const isView = t.kind === 'view';
    const isExternal = external.has(t.id);
    const nameKey = `${(t.schema ?? '').toLowerCase()}.${t.name.trim().toLowerCase()}`;
    if ((nameGroups.get(nameKey)?.length ?? 0) > 1) {
      push({
        rule: 'duplicate-table-name',
        severity: 'error',
        message: `Two tables are named "${t.name}"${t.schema ? ` in schema ${t.schema}` : ''}.`,
        tableId: t.id,
        fix: {
          label: `Rename to ${t.name}_2`,
          safe: false,
          apply: (dd) => {
            const x = draftTable(dd, t.id);
            if (x) x.name = `${x.name}_2`;
          },
        },
      });
    }

    if (t.name.length > limit) {
      push({ rule: 'identifier-too-long', severity: 'warning', message: `Table name "${t.name}" is longer than ${limit} characters, the ${d.dialect} limit.`, tableId: t.id });
    }
    if (isReserved(t.name, d.dialect)) {
      push({ rule: 'reserved-word', severity: 'info', message: `"${t.name}" is a reserved word; it will be quoted everywhere, which is easy to forget in hand-written queries.`, tableId: t.id });
    }

    if (!isView && t.storage === 'unlogged' && d.dialect !== 'postgresql') {
      push({
        rule: 'unlogged-unsupported',
        severity: 'warning',
        message: `${engineName(d.dialect)} has no unlogged tables, so "${t.name}" is written as an ordinary table.`,
        tableId: t.id,
        fix: {
          label: 'Make it a regular table',
          safe: false,
          apply: (dd) => {
            const x = draftTable(dd, t.id);
            if (x) x.storage = undefined;
          },
        },
      });
    }

    if (isView) {
      if (!t.viewSql || !t.viewSql.trim()) {
        push({ rule: 'view-without-sql', severity: 'warning', message: `View "${t.name}" has no SELECT yet, so it is left out of the script.`, tableId: t.id });
      }
    } else {
      if (t.columns.length === 0) {
        push({
          rule: 'table-without-columns',
          severity: 'error',
          message: `Table "${t.name}" has no columns.`,
          tableId: t.id,
          fix: {
            label: 'Add an id column',
            safe: true,
            apply: (dd) => {
              const x = draftTable(dd, t.id);
              if (x) x.columns.push(createColumn({ name: 'id', type: idType(dd.dialect), primaryKey: true, nullable: false, autoIncrement: true }));
            },
          },
        });
      } else if (!isExternal && !t.columns.some((c) => c.primaryKey)) {
        const existingId = t.columns.find((c) => c.name.trim().toLowerCase() === 'id');
        push({
          rule: 'missing-primary-key',
          severity: 'warning',
          message: `Table "${t.name}" has no primary key; rows cannot be addressed or referenced reliably.`,
          tableId: t.id,
          fix: {
            label: existingId ? 'Make id the primary key' : 'Add an id primary key',
            safe: true,
            apply: (dd) => {
              const x = draftTable(dd, t.id);
              if (!x) return;
              const c = x.columns.find((col) => col.name.trim().toLowerCase() === 'id');
              if (c) {
                c.primaryKey = true;
                c.nullable = false;
              } else {
                x.columns.unshift(createColumn({ name: 'id', type: idType(dd.dialect), primaryKey: true, nullable: false, autoIncrement: true }));
              }
            },
          },
        });
      }
    }

    // Same reasoning as the table-name group above: group by name first rather
    // than flagging only whichever column the loop reaches second.
    const colGroups = new Map<string, Column[]>();
    for (const c of t.columns) {
      const key = c.name.trim().toLowerCase();
      if (!key) continue;
      const group = colGroups.get(key);
      if (group) group.push(c);
      else colGroups.set(key, [c]);
    }

    for (const c of t.columns) {
      const key = c.name.trim().toLowerCase();
      if (!key) {
        push({
          rule: 'empty-column-name',
          severity: 'error',
          message: `Table "${t.name}" has a column with no name.`,
          tableId: t.id,
          columnId: c.id,
          fix: {
            label: 'Remove the column',
            safe: false,
            apply: (dd) => {
              const x = draftTable(dd, t.id);
              if (x) x.columns = x.columns.filter((col) => col.id !== c.id);
            },
          },
        });
        continue;
      }
      if ((colGroups.get(key)?.length ?? 0) > 1) {
        push({
          rule: 'duplicate-column-name',
          severity: 'error',
          message: `Table "${t.name}" has two columns named "${c.name}".`,
          tableId: t.id,
          columnId: c.id,
          fix: {
            label: `Rename to ${c.name}_2`,
            safe: false,
            apply: (dd) => {
              const col = draftTable(dd, t.id)?.columns.find((x) => x.id === c.id);
              if (col) col.name = `${col.name}_2`;
            },
          },
        });
      }
      if (c.name.length > limit) {
        push({ rule: 'identifier-too-long', severity: 'warning', message: `Column "${t.name}.${c.name}" is longer than ${limit} characters.`, tableId: t.id, columnId: c.id });
      }
      if (isReserved(c.name, d.dialect)) {
        push({ rule: 'reserved-word', severity: 'info', message: `"${t.name}.${c.name}" is a reserved word; it will be quoted everywhere.`, tableId: t.id, columnId: c.id });
      }
    }

    // Two indexes on the same columns waste writes.
    const seenIndexes = new Map<string, string>();
    for (const ix of t.indexes) {
      const key = ix.columnIds.join(',');
      if (!key) continue;
      const earlier = seenIndexes.get(key);
      if (earlier) {
        const names = ix.columnIds.map((id) => t.columns.find((c) => c.id === id)?.name ?? '?').join(', ');
        push({
          rule: 'duplicate-index',
          severity: 'warning',
          message: `Table "${t.name}" indexes (${names}) twice.`,
          tableId: t.id,
          fix: {
            label: 'Remove the duplicate index',
            safe: true,
            apply: (dd) => {
              const x = draftTable(dd, t.id);
              if (x) x.indexes = x.indexes.filter((i) => i.id !== ix.id);
            },
          },
        });
      } else {
        seenIndexes.set(key, ix.id);
      }
      if (ix.name.length > limit) {
        push({ rule: 'identifier-too-long', severity: 'warning', message: `Index name "${ix.name}" on ${t.name} is longer than ${limit} characters.`, tableId: t.id });
      }
    }

    if (!isView && isJoinTable(d, t)) {
      const targets = [...new Set(d.relationships.filter((r) => r.kind === 'fk' && r.sourceTableId === t.id).map((r) => tableById.get(r.targetTableId)?.name ?? '?'))];
      push({ rule: 'join-table', severity: 'info', message: `${t.name} links ${targets.join(' and ')} (many-to-many).`, tableId: t.id });
    }
  }

  /* ---------- relationships ---------- */
  for (const r of d.relationships) {
    const src = tableById.get(r.sourceTableId);
    const tgt = tableById.get(r.targetTableId);
    if (!src || !tgt) continue;
    const meta = kindMeta(r.kind);

    if (r.kind === 'embed' && !r.sourceColumnIds[0]) {
      push({
        rule: 'embed-without-column',
        severity: 'error',
        message: `${src.name} serializes ${tgt.name} but no column of ${src.name} is picked to hold it. Choose one in the inspector.`,
        relationshipId: r.id,
      });
    }

    if (r.kind === 'flow') {
      const incomplete = flowDerivations(r).filter((dv) => !isDerivationComplete(dv)).length;
      if (incomplete) {
        push({
          rule: 'derivation-incomplete',
          severity: 'warning',
          message: `Data flow ${src.name} → ${tgt.name} has ${incomplete} derived column${incomplete === 1 ? '' : 's'} without a target column or expression.`,
          relationshipId: r.id,
        });
      }
    }

    if (!meta.needsColumnPairs) continue;

    const srcCols = r.sourceColumnIds.map((id) => src.columns.find((c) => c.id === id));
    const tgtCols = r.targetColumnIds.map((id) => tgt.columns.find((c) => c.id === id));
    if (srcCols.length === 0 || srcCols.length !== tgtCols.length || srcCols.some((c) => !c) || tgtCols.some((c) => !c)) {
      push({
        rule: 'fk-incomplete',
        severity: 'error',
        message: `Foreign key ${src.name} → ${tgt.name} does not pair up its columns; open the connection and pick a column on each side.`,
        relationshipId: r.id,
      });
      continue;
    }
    const pairs = srcCols.map((c, i) => ({ source: c!, target: tgtCols[i]! }));

    if (external.has(r.targetTableId) && !external.has(r.sourceTableId)) {
      push({
        rule: 'fk-crosses-external',
        severity: 'info',
        message: `${src.name} references ${tgt.name}, which lives in another database; the script documents the link instead of creating a constraint.`,
        relationshipId: r.id,
      });
    }

    if (r.kind === 'fk' && src.kind !== 'view' && tgt.kind !== 'view') {
      const srcStorage = src.storage ?? 'permanent';
      const tgtStorage = tgt.storage ?? 'permanent';
      if (d.dialect === 'postgresql' && srcStorage !== tgtStorage) {
        // Constraints may only point at a table that lasts at least as long as the one holding them.
        const allowed = srcStorage === 'unlogged' ? tgtStorage === 'permanent' : false;
        if (!allowed) {
          push({
            rule: 'fk-storage-mismatch',
            severity: 'error',
            message: `${src.name} (${srcStorage}) references ${tgt.name} (${tgtStorage}). PostgreSQL allows ${
              srcStorage === 'permanent' ? 'a permanent table to reference only permanent tables' : srcStorage === 'unlogged' ? 'an unlogged table to reference only permanent or unlogged tables' : 'a temporary table to reference only temporary tables'
            }.`,
            relationshipId: r.id,
          });
        }
      } else if (d.dialect === 'mariadb' && (srcStorage === 'temporary' || tgtStorage === 'temporary')) {
        push({
          rule: 'fk-storage-mismatch',
          severity: 'warning',
          message: `${src.name} → ${tgt.name} involves a temporary table; MariaDB does not support foreign keys on temporary tables.`,
          relationshipId: r.id,
        });
      }
    }

    if (!fkTargetIsUnique(d, r)) {
      const names = pairs.map((p) => p.target.name).join(', ');
      push({
        rule: 'fk-target-not-unique',
        severity: 'error',
        message: `${src.name} → ${tgt.name} references ${tgt.name}(${names}), which is not a primary key or UNIQUE. PostgreSQL, SQLite and DuckDB reject the constraint.`,
        relationshipId: r.id,
        fix: {
          label: `Add a unique index on ${tgt.name}(${names})`,
          safe: true,
          apply: (dd) => {
            const x = draftTable(dd, tgt.id);
            if (x && !x.indexes.some((ix) => ix.unique && ix.columnIds.join(',') === r.targetColumnIds.join(','))) {
              x.indexes.push(createIndex({ columnIds: [...r.targetColumnIds], unique: true }));
            }
          },
        },
      });
    }

    for (const p of pairs) {
      if (typesMatch(p.source.type, p.target.type)) continue;
      const wanted = matchingType(p.target);
      push({
        rule: 'fk-type-mismatch',
        severity: 'warning',
        message: `${src.name}.${p.source.name} is ${p.source.type} but references ${tgt.name}.${p.target.name}, which is ${p.target.type}.`,
        relationshipId: r.id,
        tableId: src.id,
        columnId: p.source.id,
        fix: {
          label: `Make ${p.source.name} ${wanted}`,
          safe: true,
          apply: (dd) => {
            const col = draftTable(dd, src.id)?.columns.find((c) => c.id === p.source.id);
            if (col) col.type = wanted;
          },
        },
      });
    }

    // DuckDB's parser refuses CASCADE, SET NULL and SET DEFAULT on a foreign
    // key outright, so the CREATE TABLE would fail rather than merely behave differently.
    if (d.dialect === 'duckdb') {
      const unsupported = (a: string | undefined) => a === 'CASCADE' || a === 'SET NULL' || a === 'SET DEFAULT';
      if (unsupported(r.onDelete) || unsupported(r.onUpdate)) {
        const which = [unsupported(r.onDelete) ? `ON DELETE ${r.onDelete}` : '', unsupported(r.onUpdate) ? `ON UPDATE ${r.onUpdate}` : ''].filter(Boolean).join(' and ');
        push({
          rule: 'fk-action-unsupported',
          severity: 'error',
          message: `${src.name} → ${tgt.name} uses ${which}; DuckDB foreign keys only support RESTRICT and NO ACTION, so the CREATE TABLE will fail.`,
          relationshipId: r.id,
          fix: {
            label: 'Use NO ACTION',
            safe: true,
            apply: (dd) => {
              const rel = dd.relationships.find((x) => x.id === r.id);
              if (!rel) return;
              if (unsupported(rel.onDelete)) rel.onDelete = 'NO ACTION';
              if (unsupported(rel.onUpdate)) rel.onUpdate = 'NO ACTION';
            },
          },
        });
      }
    }

    const setNull = r.onDelete === 'SET NULL' || r.onUpdate === 'SET NULL';
    if (setNull) {
      for (const p of pairs) {
        if (p.source.nullable) continue;
        push({
          rule: 'fk-set-null-on-not-null',
          severity: 'error',
          message: `${src.name} → ${tgt.name} uses SET NULL, but ${src.name}.${p.source.name} is NOT NULL, so the action can never succeed.`,
          relationshipId: r.id,
          tableId: src.id,
          columnId: p.source.id,
          fix: {
            label: `Allow NULL in ${p.source.name}`,
            safe: true,
            apply: (dd) => {
              const col = draftTable(dd, src.id)?.columns.find((c) => c.id === p.source.id);
              if (col && !col.primaryKey) col.nullable = true;
            },
          },
        });
      }
    }

    if (d.dialect !== 'mariadb' && !external.has(src.id) && !indexCovers(src, r.sourceColumnIds)) {
      const names = pairs.map((p) => p.source.name).join(', ');
      push({
        rule: 'fk-without-index',
        severity: 'warning',
        message: `${src.name}(${names}) references ${tgt.name} but has no index; ${engineName(d.dialect)} does not add one, so deletes on ${tgt.name} and joins scan ${src.name}.`,
        relationshipId: r.id,
        tableId: src.id,
        fix: {
          label: `Index ${src.name}(${names})`,
          safe: true,
          apply: (dd) => {
            const x = draftTable(dd, src.id);
            if (x && !x.indexes.some((ix) => ix.columnIds.join(',') === r.sourceColumnIds.join(','))) x.indexes.push(createIndex({ columnIds: [...r.sourceColumnIds] }));
          },
        },
      });
    }

    if (r.sourceTableId === r.targetTableId && pairs.some((p) => !p.source.nullable && !p.source.primaryKey)) {
      push({
        rule: 'self-reference-not-null',
        severity: 'info',
        message: `${src.name} references itself through a NOT NULL column, so the first row can only be inserted if it points at itself.`,
        relationshipId: r.id,
      });
    }
  }

  /* ---------- extensions ---------- */
  // Only the name identifies an extension to the engine, so two entries with the
  // same name are one extension written twice.
  const extensionCounts = new Map<string, number>();
  for (const e of d.extensions) {
    const k = e.name.trim().toLowerCase();
    if (k) extensionCounts.set(k, (extensionCounts.get(k) ?? 0) + 1);
  }
  const usageText = diagramText(d);
  const enabledNames = new Set([...extensionCounts.keys()]);

  for (const e of d.extensions) {
    const name = e.name.trim();
    if (!name) {
      push({
        rule: 'extension-without-name',
        severity: 'error',
        message: 'An extension entry has no name, so nothing can be generated for it.',
        extensionId: e.id,
        fix: { label: 'Remove the entry', safe: false, apply: (dd) => void (dd.extensions = dd.extensions.filter((x) => x.id !== e.id)) },
      });
      continue;
    }
    if ((extensionCounts.get(name.toLowerCase()) ?? 0) > 1) {
      push({
        rule: 'duplicate-extension',
        severity: 'warning',
        message: `The extension "${name}" is listed more than once; an engine can only enable it once.`,
        extensionId: e.id,
        fix: { label: 'Remove this copy', safe: true, apply: (dd) => void (dd.extensions = dd.extensions.filter((x) => x.id !== e.id)) },
      });
    }

    const def = findExtensionDef(name, d.dialect);
    if (!def) {
      push({
        rule: 'extension-unknown',
        severity: 'info',
        message: `Nothing here defines "${name}", so its types and functions cannot help with autocomplete or checks. The generated SQL is unaffected. Load a definition pack, or read one off a connected database.`,
        extensionId: e.id,
      });
      continue;
    }

    for (const req of def.requires ?? []) {
      if (enabledNames.has(req.toLowerCase())) continue;
      push({
        rule: 'extension-missing-requirement',
        severity: 'error',
        message: `${extensionLabel(def)} needs "${req}" enabled first; the engine will refuse to create it otherwise.`,
        extensionId: e.id,
        fix: {
          label: `Enable ${req}`,
          safe: true,
          apply: (dd) => {
            if (!dd.extensions.some((x) => x.name.trim().toLowerCase() === req.toLowerCase())) {
              // Ahead of the extension that needs it, so the script order is right.
              const at = dd.extensions.findIndex((x) => x.id === e.id);
              dd.extensions.splice(at < 0 ? dd.extensions.length : at, 0, createExtension({ name: req }));
            }
          },
        },
      });
    }

    if (!extensionIsUsed(d, def, usageText)) {
      push({
        rule: 'extension-unused',
        severity: 'info',
        message: `Nothing in this diagram uses what ${extensionLabel(def)} provides. Enabling an extension you do not use still costs an install and a dependency.`,
        extensionId: e.id,
        fix: { label: `Remove ${name}`, safe: false, apply: (dd) => void (dd.extensions = dd.extensions.filter((x) => x.id !== e.id)) },
      });
    }
  }

  // A column typed with something only an extension provides, where the diagram
  // never enables that extension. Without this the type just looks like a typo.
  const flaggedTypes = new Set<string>();
  for (const t of d.tables) {
    if (t.kind === 'view' || external.has(t.id)) continue;
    for (const c of t.columns) {
      const base = baseTypeName(c.type);
      if (!base || builtinTypeNames(d.dialect).has(base)) continue;
      // Matched on the raw text, arguments and all: SQL has no parameterised
      // CREATE TYPE, so "vector(1536)" is never a custom type named "vector".
      if (customTypeByName(d, c.type)) continue;
      const providers = extensionsProvidingType(c.type, d.dialect).filter((p) => !enabledNames.has(p.name.toLowerCase()));
      if (providers.length === 0) continue;
      // One finding per column, but do not repeat the same advice for a type
      // used across twenty columns of the same table.
      const dedupe = `${t.id}:${base}`;
      if (flaggedTypes.has(dedupe)) continue;
      flaggedTypes.add(dedupe);
      const first = providers[0];
      push({
        rule: 'type-needs-extension',
        severity: 'error',
        message:
          providers.length === 1
            ? `${t.name}.${c.name} is ${c.type}, a type ${extensionLabel(first)} provides, but the diagram does not enable "${first.name}". The CREATE TABLE will fail.`
            : `${t.name}.${c.name} is ${c.type}, a type provided by ${providers.map((p) => `"${p.name}"`).join(' or ')}, none of which this diagram enables.`,
        tableId: t.id,
        columnId: c.id,
        fix: {
          label: `Enable ${first.name}`,
          safe: true,
          apply: (dd) => {
            if (!dd.extensions.some((x) => x.name.trim().toLowerCase() === first.name.toLowerCase())) {
              dd.extensions.push(createExtension({ name: first.name }));
            }
          },
        },
      });
    }
  }

  /* ---------- programs ---------- */
  // Nothing here can stop the schema from being created: a program is not DDL.
  // The findings are about the diagram lying — a step pointing at a table that
  // is gone, a write onto a column a data flow already computes — because a
  // diagram that says two different things about who fills a column is worse
  // than one that says nothing.
  const derivedColumns = new Set<string>();
  for (const r of d.relationships) {
    if (r.kind !== 'flow') continue;
    for (const dv of flowDerivations(r)) derivedColumns.add(dv.targetColumnId);
  }
  // Names only have to be distinct among siblings: two classes may each have a
  // `save`, and the map is read through its containers.
  const programNames = new Map<string, number>();
  // A procedure's namespace is the database schema it is created in, not the
  // code map: a program and the stored procedure it calls may share a name.
  const siblingKey = (prg: Program) => `${codeKindOf(prg) === 'procedure' ? `db:${(prg.schema ?? '').trim().toLowerCase()}` : (prg.parentId ?? '')}|${prg.name.trim().toLowerCase()}`;
  for (const prg of d.programs) programNames.set(siblingKey(prg), (programNames.get(siblingKey(prg)) ?? 0) + 1);
  const codeById = new Map(d.programs.map((p) => [p.id, p]));
  const children = codeChildren(d);
  // "Nothing calls this" is only news once the map draws calls at all; a map
  // of imports alone, or of plain programs, has no entry points to tell apart.
  const anyCall = d.programs.some((p) => p.steps.some((s) => s.op === 'call'));
  const called = new Set<string>();
  for (const p of d.programs) for (const s of p.steps) if (isCodeStepOp(s.op) && s.codeId) called.add(s.codeId);

  for (const prg of d.programs) {
    const kind = codeKindOf(prg);
    const noun = codeNoun(prg);
    const members = children.get(prg.id) ?? [];
    if (!prg.name.trim()) {
      push({ rule: 'program-unnamed', severity: 'warning', message: `A ${noun} has no name, so nothing can refer to it.`, programId: prg.id });
    } else if ((programNames.get(siblingKey(prg)) ?? 0) > 1) {
      push({
        rule: 'duplicate-program-name',
        severity: 'warning',
        message: `More than one ${noun} is called "${prg.name}" in the same place; the diagram cannot say which one a reader means.`,
        programId: prg.id,
      });
    }

    // A function inside a class inside a module: the map only reads if each
    // level really can hold the next.
    const parent = prg.parentId ? codeById.get(prg.parentId) : undefined;
    if (parent && !canContain(codeKindOf(parent), kind)) {
      push({
        rule: 'code-cannot-contain',
        severity: 'warning',
        message: `${prg.name} is a ${noun} inside ${parent.name}, which is a ${codeNoun(parent)}; a ${codeNoun(parent)} cannot hold a ${noun}.`,
        programId: prg.id,
        fix: {
          label: parent.parentId ? `Move it up into ${codeById.get(parent.parentId)?.name ?? 'the container above'}` : 'Move it to the top level',
          safe: false,
          apply: (dd) => {
            const x = dd.programs.find((p) => p.id === prg.id);
            if (!x) return;
            if (parent.parentId) x.parentId = parent.parentId;
            else delete x.parentId;
          },
        },
      });
    }

    if (prg.steps.length === 0) {
      if (kind === 'program' && members.length === 0) {
        push({
          rule: 'program-without-steps',
          severity: 'info',
          message: `${prg.name || 'A program'} has no steps yet, so the diagram does not say what it touches.`,
          programId: prg.id,
        });
      } else if (codeKindMeta(kind).container && kind !== 'program' && members.length === 0) {
        push({
          rule: 'code-empty-container',
          severity: 'info',
          message: `${prg.name} is a ${noun} with nothing in it and no steps of its own; it draws as an empty region.`,
          programId: prg.id,
        });
      }
    }

    if (kind === 'procedure') {
      if (!dialectHasProcedures(d.dialect)) {
        push({
          rule: 'procedure-unsupported',
          severity: 'warning',
          message: `${engineName(d.dialect)} has no stored procedures, so ${prg.name || 'this procedure'} is written into the script as a comment and never created. It is kept, and comes back as soon as the diagram targets PostgreSQL or MariaDB.`,
          programId: prg.id,
        });
      }
      if (!prg.body?.trim() && prg.steps.length === 0) {
        push({
          rule: 'procedure-empty',
          severity: 'info',
          message: `${prg.name || 'A procedure'} has no body and no steps, so the script creates one that does nothing.`,
          programId: prg.id,
        });
      }
      (prg.params ?? []).forEach((x, i) => {
        if (x.name.trim() && x.type.trim()) return;
        push({
          rule: 'procedure-param-incomplete',
          severity: 'warning',
          message: `Parameter ${i + 1} of ${prg.name} has no ${x.name.trim() ? 'type' : 'name'}, so the script leaves it out and the routine takes one argument fewer than drawn.`,
          programId: prg.id,
          fix: {
            label: 'Remove the parameter',
            safe: false,
            apply: (dd) => {
              const target = dd.programs.find((p) => p.id === prg.id);
              if (target?.params) target.params = target.params.filter((y) => y.id !== x.id);
            },
          },
        });
      });
    }

    if (kind === 'data' && !d.programs.some((x) => x.steps.some((s) => s.op === 'load' && s.codeId === prg.id))) {
      push({
        rule: 'code-data-unread',
        severity: 'info',
        message: `Nothing in the map loads ${prg.name}. A data file is only on the canvas because something reads it, so either that step has not been drawn or the file is no longer used.`,
        programId: prg.id,
      });
    }

    if (kind === 'function' && anyCall && !called.has(prg.id)) {
      push({
        rule: 'code-uncalled-function',
        severity: 'info',
        message: `Nothing in the map calls ${prg.name}. Either it is an entry point, or the call that reaches it has not been drawn yet.`,
        programId: prg.id,
      });
    }

    prg.steps.forEach((s, i) => {
      const table = s.tableId ? tableById.get(s.tableId) : undefined;
      const meta = programStepOpMeta(s.op);

      if (meta.namesCode) {
        if (!s.codeId) {
          push({
            rule: 'code-step-without-target',
            severity: 'warning',
            message: `Step ${i + 1} of ${prg.name} is a ${s.op} but names nothing, so it draws no arrow.`,
            programId: prg.id,
          });
        } else if (!codeById.has(s.codeId)) {
          push({
            rule: 'code-step-missing-target',
            severity: 'error',
            message: `Step ${i + 1} of ${prg.name} ${stepVerb(s.op)} something that is no longer in the diagram. Its code is still here; point it at another node or remove the step.`,
            programId: prg.id,
            fix: {
              label: 'Remove the step',
              // The step may carry the only copy of its code, so never in bulk.
              safe: false,
              apply: (dd) => {
                const target = dd.programs.find((x) => x.id === prg.id);
                if (target) target.steps = target.steps.filter((x) => x.id !== s.id);
              },
            },
          });
        } else if (s.codeId === prg.id && s.op !== 'call') {
          push({
            rule: 'code-step-names-itself',
            severity: 'warning',
            message: `Step ${i + 1} of ${prg.name} ${s.op}s ${prg.name} itself, which cannot be what was meant.`,
            programId: prg.id,
          });
        } else if (!canStepName(s.op, codeKindOf(codeById.get(s.codeId)!), kind) && (kind === 'procedure' || codeKindOf(codeById.get(s.codeId)!) === 'procedure')) {
          // A stored routine runs inside the database: it can call another one
          // there and nothing else, and all anything can do to one is call it.
          const target = codeById.get(s.codeId)!;
          const fromProcedure = kind === 'procedure' && codeKindOf(target) !== 'procedure';
          push({
            rule: 'procedure-step-mismatch',
            severity: 'warning',
            message: fromProcedure
              ? `Step ${i + 1} of ${prg.name} ${stepVerb(s.op)} ${target.name}, which is a ${codeNoun(target)} in the code map. A stored procedure runs inside the database and can only call other routines there.`
              : `Step ${i + 1} of ${prg.name} ${stepVerb(s.op)} ${target.name}, which is a stored procedure. A routine is only ever called.`,
            programId: prg.id,
            fix: fromProcedure
              ? {
                  label: 'Remove the step',
                  safe: false,
                  apply: (dd) => {
                    const x = dd.programs.find((p) => p.id === prg.id);
                    if (x) x.steps = x.steps.filter((y) => y.id !== s.id);
                  },
                }
              : {
                  label: 'Make it a call',
                  safe: false,
                  apply: (dd) => {
                    const step = dd.programs.find((x) => x.id === prg.id)?.steps.find((x) => x.id === s.id);
                    if (step) step.op = 'call';
                  },
                },
          });
        } else if (!canStepName(s.op, codeKindOf(codeById.get(s.codeId)!))) {
          // The one pairing rule the data files bring: a data file is loaded,
          // and a load loads a data file. Either way round, what the step says
          // happens cannot happen, and the fix is to change the op rather than
          // to throw away whatever the step carries.
          const target = codeById.get(s.codeId)!;
          const wrongWay = s.op === 'load';
          push({
            rule: 'code-step-op-mismatch',
            severity: 'warning',
            message: wrongWay
              ? `Step ${i + 1} of ${prg.name} loads ${target.name}, which is ${codeNoun(target) === 'program' ? 'a program' : `a ${codeNoun(target)}`} rather than a data file. Only a YAML or JSON file holds values to load.`
              : `Step ${i + 1} of ${prg.name} ${stepVerb(s.op)} ${target.name}, which is a data file. Nothing runs in one, so it can only be loaded.`,
            programId: prg.id,
            fix: {
              label: wrongWay ? 'Make it a call' : 'Make it a load',
              safe: false,
              apply: (dd) => {
                const step = dd.programs.find((x) => x.id === prg.id)?.steps.find((x) => x.id === s.id);
                if (step) step.op = wrongWay ? 'call' : 'load';
              },
            },
          });
        }
        return;
      }

      if (meta.touchesDatabase && !s.tableId) {
        push({
          rule: 'program-step-without-table',
          severity: 'warning',
          message: `Step ${i + 1} of ${prg.name} is a ${s.op} but names no table, so it draws nothing.`,
          programId: prg.id,
        });
        return;
      }

      if (meta.touchesDatabase && s.tableId && !table) {
        push({
          rule: 'program-step-missing-table',
          severity: 'error',
          message: `Step ${i + 1} of ${prg.name} reads or writes a table that is no longer in the diagram. Its SQL and code are still here; point it at another table or remove the step.`,
          programId: prg.id,
          fix: {
            label: 'Remove the step',
            // Deleting the step throws away whatever code it carried, which is
            // exactly why this is not a "safe" fix and not applied in bulk.
            safe: false,
            apply: (dd) => {
              const target = dd.programs.find((x) => x.id === prg.id);
              if (target) target.steps = target.steps.filter((x) => x.id !== s.id);
            },
          },
        });
        return;
      }

      if (s.op === 'write' && table) {
        const clashing = s.columnIds.filter((id) => derivedColumns.has(id));
        for (const id of clashing) {
          const column = table.columns.find((c) => c.id === id);
          if (!column) continue;
          push({
            rule: 'program-writes-derived-column',
            severity: 'warning',
            message: `${prg.name} writes ${table.name}.${column.name} at step ${i + 1}, but a data flow already computes that column. One of the two is wrong about where the value comes from.`,
            programId: prg.id,
            tableId: table.id,
            columnId: column.id,
          });
        }
      }

      if (s.op === 'write' && table && external.has(table.id)) {
        push({
          rule: 'program-writes-external-table',
          severity: 'info',
          message: `${prg.name} writes ${table.name}, which the diagram says lives in another database. Worth being sure that is intended.`,
          programId: prg.id,
          tableId: table.id,
        });
      }

      // A step that defines the view (a procedure's CREATE OR REPLACE VIEW)
      // is not writing rows into it.
      if (s.op === 'write' && table?.kind === 'view' && !/^\s*CREATE\b/i.test(s.sql ?? '')) {
        push({
          rule: 'program-writes-view',
          severity: 'warning',
          message: `${prg.name} writes ${table.name}, which is a view. Most engines refuse that unless the view is simple enough to be updatable or has a rule behind it.`,
          programId: prg.id,
          tableId: table.id,
        });
      }
    });

    // A program that only reads is a reader, and a program that only writes is a
    // feed; both are fine. One that does neither, and holds no code that might,
    // has steps that say nothing about this schema.
    const touches = prg.steps.some((s) => programStepOpMeta(s.op).touchesDatabase && s.tableId && tableById.has(s.tableId));
    const reaches = prg.steps.some((s) => isCodeStepOp(s.op) && s.codeId && codeById.has(s.codeId));
    if (kind === 'program' && !touches && !reaches && prg.steps.length > 0 && members.length === 0) {
      push({
        rule: 'program-touches-nothing',
        severity: 'info',
        message: `${prg.name} is ${programLanguageMeta(prg.language).label} that never reads or writes this schema, so it sits on the canvas without connecting to it.`,
        programId: prg.id,
      });
    }
  }

  // A module that imports a module that imports it back: the circular import
  // that fails at run time and hides well in a big map.
  for (const cycle of importCycles(d)) {
    const names = cycle.map((id) => codeById.get(id)?.name ?? '?');
    push({
      rule: 'code-import-cycle',
      severity: 'warning',
      message: `${names.join(' imports ')} imports ${names[0]} again: a circular import.`,
      programId: cycle[0],
    });
  }

  const order: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.message.localeCompare(b.message));
}

export function summarizeFindings(findings: LintFinding[]): { errors: number; warnings: number; infos: number } {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

/** Whether a column's type names a custom enum (used by suggestions to avoid text-vs-integer false alarms). */
export function isEnumTyped(d: Diagram, c: Column): boolean {
  return customTypeByName(d, c.type)?.kind === 'enum';
}

export type { Relationship as LintRelationship };
