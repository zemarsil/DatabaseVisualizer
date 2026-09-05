/**
 * Schema lint: structural problems the database would reject or that bite
 * later, each with an optional one-click fix. Findings are recomputed from the
 * diagram on every change, so the rules stay cheap (no quadratic scans over
 * columns).
 *
 * A fix mutates an immer draft of the diagram; callers hand it to the store's
 * `mutate` so it lands as one undo step.
 */
import { kindMeta, type Column, type Diagram, type Relationship, type Table } from '@shared/types';
import { flowDerivations, isDerivationComplete } from './derivation';
import { externalTableIds } from './groups';
import { createColumn, createIndex, customTypeByName } from './model';
import { fkTargetIsUnique, isJoinTable, pkColumnIds } from './schemaInfo';
import { isReserved, isSerialType, normalizeType } from './sql/dialect';

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
  fix?: LintFix;
}

const IDENTIFIER_LIMIT = { postgresql: 63, mariadb: 64, sqlite: 1000 } as const;

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

function draftTable(d: Diagram, id: string): Table | undefined {
  return d.tables.find((t) => t.id === id);
}

export function lintDiagram(d: Diagram): LintFinding[] {
  const out: LintFinding[] = [];
  const external = externalTableIds(d);
  const tableById = new Map(d.tables.map((t) => [t.id, t]));
  const limit = IDENTIFIER_LIMIT[d.dialect] ?? 63;
  const push = (f: Omit<LintFinding, 'id'>) => out.push({ ...f, id: `${f.rule}:${f.tableId ?? ''}:${f.columnId ?? ''}:${f.relationshipId ?? ''}` });

  /* ---------- tables and columns ---------- */
  const seenNames = new Map<string, Table>();
  for (const t of d.tables) {
    const isView = t.kind === 'view';
    const isExternal = external.has(t.id);
    const nameKey = `${(t.schema ?? '').toLowerCase()}.${t.name.trim().toLowerCase()}`;
    const clash = seenNames.get(nameKey);
    if (clash) {
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
    } else {
      seenNames.set(nameKey, t);
    }

    if (t.name.length > limit) {
      push({ rule: 'identifier-too-long', severity: 'warning', message: `Table name "${t.name}" is longer than ${limit} characters, the ${d.dialect} limit.`, tableId: t.id });
    }
    if (isReserved(t.name)) {
      push({ rule: 'reserved-word', severity: 'info', message: `"${t.name}" is a reserved word; it will be quoted everywhere, which is easy to forget in hand-written queries.`, tableId: t.id });
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

    const seenCols = new Map<string, Column>();
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
      if (seenCols.has(key)) {
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
      } else {
        seenCols.set(key, c);
      }
      if (c.name.length > limit) {
        push({ rule: 'identifier-too-long', severity: 'warning', message: `Column "${t.name}.${c.name}" is longer than ${limit} characters.`, tableId: t.id, columnId: c.id });
      }
      if (isReserved(c.name)) {
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

    if (!fkTargetIsUnique(d, r)) {
      const names = pairs.map((p) => p.target.name).join(', ');
      push({
        rule: 'fk-target-not-unique',
        severity: 'error',
        message: `${src.name} → ${tgt.name} references ${tgt.name}(${names}), which is not a primary key or UNIQUE. PostgreSQL and SQLite reject the constraint.`,
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
        message: `${src.name}(${names}) references ${tgt.name} but has no index; ${d.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL'} does not add one, so deletes on ${tgt.name} and joins scan ${src.name}.`,
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
