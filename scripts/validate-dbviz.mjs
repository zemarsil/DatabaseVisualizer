#!/usr/bin/env node
/**
 * Structural check for a hand-written .dbviz.json (see docs/ADVISOR_OUTPUT_FORMAT.md),
 * whether it holds one diagram or a workspace of several.
 *
 * The app loads tolerantly: a dangling relationship, a verb that does not fit its
 * kind, or a bad colour key produces no error, just a wrong-looking diagram. This
 * catches those before you open the file. Schema advice (missing primary keys,
 * unindexed foreign keys, type mismatches) is the app's own Problems tab; this
 * script only checks that the file says what you meant it to say.
 *
 *   node scripts/validate-dbviz.mjs file.dbviz.json [more.dbviz.json ...]
 *
 * Exits 1 if any file has errors. Warnings alone do not fail.
 */
import { readFileSync } from 'node:fs';

const COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'slate'];
const ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
const DIALECTS = ['postgresql', 'mariadb', 'sqlite'];
const KINDS = ['fk', 'flow', 'embed', 'dependency'];
const AGGREGATES = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
const WINDOW_FUNCTIONS = ['DIFF', 'LAG', 'LEAD', 'RUNNING_SUM', 'RUNNING_AVG', 'ROW_NUMBER', 'RANK'];
const WINDOWS_WITHOUT_EXPRESSION = ['ROW_NUMBER', 'RANK'];
/** Verb id -> the kinds it may describe. A verb outside its kind's list is dropped on load. */
const VERBS = {
  references: ['fk'],
  'belongs-to': ['fk'],
  'part-of': ['fk'],
  extends: ['fk'],
  uses: ['fk', 'dependency'],
  feeds: ['flow'],
  mirrors: ['flow'],
  serializes: ['embed'],
  embeds: ['embed'],
};
/**
 * Types that only an extension provides, and which extension provides them.
 *
 * A deliberately short list of the ones people actually reach for. The app's own
 * catalog (src/lib/extensions) is the complete one and can be extended with packs;
 * this exists so a generated file can be checked without opening the app, and a
 * type missing from here simply is not checked.
 */
const EXTENSION_TYPES = {
  postgresql: {
    vector: 'vector',
    halfvec: 'vector',
    sparsevec: 'vector',
    geometry: 'postgis',
    geography: 'postgis',
    box2d: 'postgis',
    box3d: 'postgis',
    raster: 'postgis_raster',
    citext: 'citext',
    hstore: 'hstore',
    ltree: 'ltree',
    lquery: 'ltree',
    cube: 'cube',
    agtype: 'age',
  },
  mariadb: {},
  sqlite: {},
};

/** "vector(1536)[]" -> "vector": what EXTENSION_TYPES is keyed by. */
function baseTypeName(type) {
  return String(type)
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\(.*$/, '')
    .trim()
    .toLowerCase();
}

/** Types that give away a dialect mix-up. */
const DIALECT_SMELLS = {
  postgresql: [
    [/auto_increment/i, 'MariaDB syntax (use SERIAL/BIGSERIAL with "autoIncrement": true)'],
    [/^\s*(tinyint|datetime|longtext|mediumtext)\b/i, 'MariaDB syntax'],
  ],
  mariadb: [[/^\s*(big|small)?serial\b|timestamptz|jsonb|\bbytea\b|\[\]\s*$/i, 'PostgreSQL syntax']],
  sqlite: [
    [/^\s*(big|small)?serial\b|timestamptz|jsonb|\bbytea\b/i, 'PostgreSQL syntax'],
    [/auto_increment/i, 'MariaDB syntax (SQLite uses INTEGER PRIMARY KEY)'],
  ],
};

function validate(doc) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['Top level is not an object.'], warnings };
  if (doc.version !== 1) warn(`"version" should be 1 (found ${JSON.stringify(doc.version)}).`);
  if (typeof doc.name !== 'string' || !doc.name.trim()) warn('"name" is missing; the diagram will load as "Untitled diagram".');
  if (!DIALECTS.includes(doc.dialect)) err(`"dialect" must be one of ${DIALECTS.join(', ')} (found ${JSON.stringify(doc.dialect)}); anything else silently falls back to postgresql.`);
  if (!Array.isArray(doc.tables)) return { errors: [...errors, '"tables" must be an array; the app refuses the file without it.'], warnings };

  const ids = new Map(); // id -> what claimed it
  const claim = (id, what) => {
    if (typeof id !== 'string' || !id) {
      err(`${what} has a missing or non-string id.`);
      return;
    }
    if (ids.has(id)) err(`Duplicate id "${id}": used by ${ids.get(id)} and ${what}.`);
    else ids.set(id, what);
  };

  const groupIds = new Set();
  /** Groups holding another database's tables: this file documents them, it does not build them. */
  const externalGroupIds = new Set();
  for (const [gi, g] of (Array.isArray(doc.groups) ? doc.groups : []).entries()) {
    const gw = `groups[${gi}]${g && g.name ? ` (${g.name})` : ''}`;
    if (!g || typeof g !== 'object') {
      err(`${gw} is not an object.`);
      continue;
    }
    claim(g.id, gw);
    if (typeof g.id === 'string') groupIds.add(g.id);
    if (typeof g.name !== 'string' || !g.name.trim()) warn(`${gw} has no name; it loads as "Group".`);
    if (g.color !== undefined && !COLORS.includes(g.color)) warn(`${gw}: colour "${g.color}" is not in the palette; it renders as slate.`);
    if (g.external !== undefined && typeof g.external !== 'boolean') err(`${gw}: "external" must be a boolean.`);
    else if (g.external === true && typeof g.id === 'string') externalGroupIds.add(g.id);
  }

  const extensionNames = new Set();
  for (const [ei, e] of (Array.isArray(doc.extensions) ? doc.extensions : []).entries()) {
    const ew = `extensions[${ei}]${e && e.name ? ` (${e.name})` : ''}`;
    if (!e || typeof e !== 'object') {
      err(`${ew} is not an object.`);
      continue;
    }
    claim(e.id, ew);
    if (typeof e.name !== 'string' || !e.name.trim()) {
      err(`${ew} has no name; the app skips extensions without one.`);
      continue;
    }
    const key = e.name.trim().toLowerCase();
    // An engine can only enable an extension once, so the loader keeps the first.
    if (extensionNames.has(key)) err(`${ew}: "${e.name}" is listed twice; only the first is loaded.`);
    else extensionNames.add(key);
    if (e.schema !== undefined && typeof e.schema !== 'string') err(`${ew}: "schema" must be a string.`);
    if (e.version !== undefined && typeof e.version !== 'string') err(`${ew}: "version" must be a string, e.g. "3.4.2".`);
    if (doc.dialect !== 'postgresql' && (e.schema || e.version)) {
      warn(`${ew}: "schema" and "version" are PostgreSQL-only and are ignored on ${doc.dialect}.`);
    }
  }

  const customTypeNames = new Set();
  for (const [ci, c] of (Array.isArray(doc.customTypes) ? doc.customTypes : []).entries()) {
    const cw = `customTypes[${ci}]${c && c.name ? ` (${c.name})` : ''}`;
    if (!c || typeof c !== 'object') {
      err(`${cw} is not an object.`);
      continue;
    }
    claim(c.id, cw);
    if (typeof c.name !== 'string' || !c.name.trim()) err(`${cw} has no name; the app skips types without one.`);
    else customTypeNames.add(c.name.toLowerCase());
    const kind = c.kind === 'composite' ? 'composite' : 'enum';
    if (c.kind !== 'enum' && c.kind !== 'composite') warn(`${cw}: "kind" should be "enum" or "composite" (found ${JSON.stringify(c.kind)}); it loads as an enum.`);
    if (kind === 'enum') {
      const values = Array.isArray(c.values) ? c.values.filter((v) => typeof v === 'string') : [];
      if (values.length === 0) err(`${cw}: an enum needs a non-empty "values" array.`);
      if (Array.isArray(c.fields)) warn(`${cw}: "fields" is ignored on an enum type.`);
    } else {
      const fields = Array.isArray(c.fields) ? c.fields : [];
      if (fields.length === 0) err(`${cw}: a composite type needs a non-empty "fields" array.`);
      for (const [fi, f] of fields.entries()) {
        const fw = `${cw}.fields[${fi}]${f && f.name ? ` (${f.name})` : ''}`;
        if (!f || typeof f !== 'object') {
          err(`${fw} is not an object.`);
          continue;
        }
        claim(f.id, fw);
        if (typeof f.name !== 'string' || !f.name.trim()) err(`${fw} has no name; the app skips fields without one.`);
        if (typeof f.type !== 'string' || !f.type.trim()) warn(`${fw} has no type; it defaults to TEXT.`);
      }
      if (Array.isArray(c.values)) warn(`${cw}: "values" is ignored on a composite type.`);
    }
    if (kind === 'enum' && doc.dialect !== 'postgresql') warn(`${cw}: only PostgreSQL emits CREATE TYPE ... AS ENUM; on ${doc.dialect} the type documents the diagram but is not created.`);
  }

  const columnsOfTable = new Map(); // tableId -> Set(columnId)
  const tableNames = new Map();
  const positions = new Map();

  for (const [ti, t] of doc.tables.entries()) {
    const where = `tables[${ti}]${t && t.name ? ` (${t.name})` : ''}`;
    if (!t || typeof t !== 'object') {
      err(`${where} is not an object.`);
      continue;
    }
    claim(t.id, where);
    if (typeof t.name !== 'string' || !t.name.trim()) err(`${where} has no name; the app skips tables without one.`);
    else {
      const key = `${t.schema ?? ''}.${t.name.toLowerCase()}`;
      if (tableNames.has(key)) err(`${where}: duplicate table name "${t.name}", already used by ${tableNames.get(key)}.`);
      else tableNames.set(key, where);
    }
    const isView = t.kind === 'view';
    const isExternal = typeof t.groupId === 'string' && externalGroupIds.has(t.groupId);
    if (t.kind !== undefined && t.kind !== 'view' && t.kind !== 'table') warn(`${where}: "kind" is only "view" (or omitted for a table); ${JSON.stringify(t.kind)} loads as a table.`);
    if (isView && (typeof t.viewSql !== 'string' || !t.viewSql.trim())) warn(`${where} is a view with no "viewSql"; it draws on the canvas but is left out of the generated script.`);
    if (!isView && t.viewSql) warn(`${where}: "viewSql" is ignored unless "kind" is "view".`);
    if (t.color !== undefined && !COLORS.includes(t.color)) warn(`${where}: colour "${t.color}" is not in the palette; it renders as blue. Use one of ${COLORS.join(', ')}.`);
    if (t.groupId !== undefined && !groupIds.has(t.groupId)) err(`${where}: groupId "${t.groupId}" is not a group in this file; the app silently drops the grouping.`);
    if (t.collapsed !== undefined && t.collapsed !== 'keys' && t.collapsed !== 'header') warn(`${where}: "collapsed" is "keys" or "header"; ${JSON.stringify(t.collapsed)} is ignored.`);
    if (!t.position || typeof t.position.x !== 'number' || typeof t.position.y !== 'number') warn(`${where} has no numeric position; it lands at (0, 0).`);
    else {
      const key = `${t.position.x},${t.position.y}`;
      if (positions.has(key)) warn(`${where} sits exactly on top of ${positions.get(key)} at (${key}). Lay tables out on a grid: x = 320 * column, y = 260 * row.`);
      else positions.set(key, where);
    }
    if (t.checks !== undefined && !Array.isArray(t.checks)) err(`${where}: "checks" must be an array of CHECK bodies.`);
    for (const c of Array.isArray(t.checks) ? t.checks : []) {
      if (typeof c === 'string' && /^\s*check\s*\(/i.test(c)) warn(`${where}: table check ${JSON.stringify(c)} should be the body only, without the CHECK keyword or outer parens.`);
    }

    const cols = new Set();
    columnsOfTable.set(t.id, cols);
    const colNames = new Set();
    if (!Array.isArray(t.columns) || t.columns.length === 0) err(`${where} has no columns.`);
    for (const [ci, c] of (Array.isArray(t.columns) ? t.columns : []).entries()) {
      const cw = `${where}.columns[${ci}]${c && c.name ? ` (${c.name})` : ''}`;
      if (!c || typeof c !== 'object') {
        err(`${cw} is not an object.`);
        continue;
      }
      claim(c.id, cw);
      if (typeof c.id === 'string') cols.add(c.id);
      if (typeof c.name !== 'string' || !c.name.trim()) err(`${cw} has no name; the app skips columns without one.`);
      else if (colNames.has(c.name.toLowerCase())) err(`${cw}: duplicate column name "${c.name}" in this table.`);
      else colNames.add(c.name.toLowerCase());
      if (typeof c.type !== 'string' || !c.type.trim()) warn(`${cw} has no type; it defaults to TEXT.`);
      if (c.primaryKey === true && c.nullable !== false) err(`${cw} is a primary key but nullable is not false.`);
      if (c.nullable === undefined) warn(`${cw}: "nullable" omitted, so it defaults to true (NULL allowed).`);
      if (typeof c.defaultValue === 'string' && /^nextval\s*\(/i.test(c.defaultValue)) warn(`${cw}: use "autoIncrement": true instead of a nextval() default.`);
      if (typeof c.check === 'string' && /^\s*check\s*\(/i.test(c.check)) warn(`${cw}: "check" should be the body only, without the CHECK keyword or outer parens.`);
      if (typeof c.type === 'string' && !customTypeNames.has(c.type.trim().toLowerCase())) {
        for (const [re, why] of DIALECT_SMELLS[doc.dialect] ?? []) {
          if (re.test(c.type)) err(`${cw}: type "${c.type}" is ${why} but the dialect is ${doc.dialect}.`);
        }
        // A view's columns describe what its SELECT returns and are never created,
        // and a table in an external group belongs to a database this file does
        // not build — neither can fail for want of an extension here.
        const provider = isView || isExternal ? undefined : (EXTENSION_TYPES[doc.dialect] ?? {})[baseTypeName(c.type)];
        if (provider && !extensionNames.has(provider)) {
          err(`${cw}: type "${c.type}" needs the "${provider}" extension, which is not in "extensions"; the CREATE TABLE will fail.`);
        }
      }
    }

    for (const [ii, idx] of (Array.isArray(t.indexes) ? t.indexes : []).entries()) {
      const iw = `${where}.indexes[${ii}]${idx && idx.name ? ` (${idx.name})` : ''}`;
      if (!idx || typeof idx !== 'object') {
        err(`${iw} is not an object.`);
        continue;
      }
      claim(idx.id, iw);
      const list = Array.isArray(idx.columnIds) ? idx.columnIds : [];
      if (list.length === 0) err(`${iw} has no columnIds; the app drops indexes with none.`);
      for (const cid of list) if (!cols.has(cid)) err(`${iw} references column id "${cid}", which is not a column of this table.`);
    }
  }

  for (const [ri, r] of (Array.isArray(doc.relationships) ? doc.relationships : []).entries()) {
    const rw = `relationships[${ri}]${r && r.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object') {
      err(`${rw} is not an object.`);
      continue;
    }
    claim(r.id, rw);
    const kind = r.kind === undefined ? 'fk' : r.kind;
    if (!KINDS.includes(kind)) err(`${rw}: "kind" must be one of ${KINDS.join(', ')} (found ${JSON.stringify(r.kind)}); anything else loads as "fk".`);
    if (r.verb !== undefined) {
      if (!VERBS[r.verb]) warn(`${rw}: unknown verb "${r.verb}"; the edge falls back to the kind's default reading.`);
      else if (!VERBS[r.verb].includes(kind)) warn(`${rw}: verb "${r.verb}" does not apply to kind "${kind}" (it is for ${VERBS[r.verb].join(', ')}); the edge falls back to the default reading.`);
    }
    const src = columnsOfTable.get(r.sourceTableId);
    const tgt = columnsOfTable.get(r.targetTableId);
    if (!src) err(`${rw}: sourceTableId "${r.sourceTableId}" is not a table in this file.`);
    if (!tgt) err(`${rw}: targetTableId "${r.targetTableId}" is not a table in this file.`);
    if (r.sourceTableId && r.sourceTableId === r.targetTableId) warn(`${rw} is a self-reference; Trace ignores self-edges.`);
    const sc = Array.isArray(r.sourceColumnIds) ? r.sourceColumnIds : [];
    const tc = Array.isArray(r.targetColumnIds) ? r.targetColumnIds : [];
    for (const cid of sc) if (src && !src.has(cid)) err(`${rw}: sourceColumnIds has "${cid}", which is not a column of the source table.`);
    for (const cid of tc) if (tgt && !tgt.has(cid)) err(`${rw}: targetColumnIds has "${cid}", which is not a column of the target table.`);
    if (kind === 'fk') {
      if (sc.length === 0) err(`${rw}: a foreign key needs columns on both sides. (A table-to-table annotation is a "flow" or a "dependency".)`);
      if (sc.length !== tc.length) err(`${rw}: sourceColumnIds (${sc.length}) and targetColumnIds (${tc.length}) must pair up one to one.`);
    } else if (kind === 'embed') {
      if (sc.length === 0) warn(`${rw}: an embed reads better with the container column in sourceColumnIds[0] — the column of the source that holds the target serialized.`);
      if (sc.length > 1) warn(`${rw}: an embed uses only sourceColumnIds[0]; the rest are ignored.`);
      if (tc.length > 0) warn(`${rw}: an embed does not use targetColumnIds.`);
    } else if (sc.length !== tc.length && sc.length > 0 && tc.length > 0) {
      err(`${rw}: sourceColumnIds (${sc.length}) and targetColumnIds (${tc.length}) must pair up one to one when both are given.`);
    }
    if (kind === 'flow' && !r.query && !r.note && !Array.isArray(r.derivations)) {
      warn(`${rw}: a flow edge with no "query", "note" or "derivations" says only that the tables are related — add how the data is produced.`);
    }
    for (const k of ['onDelete', 'onUpdate']) {
      if (r[k] === undefined) continue;
      if (!ACTIONS.includes(r[k])) err(`${rw}: ${k} "${r[k]}" is not one of ${ACTIONS.join(', ')}.`);
      else if (kind !== 'fk' && r[k] !== 'NO ACTION') warn(`${rw}: ${k} only means something on a foreign key; it is ignored on a "${kind}".`);
    }
    if (r.derivations !== undefined) {
      if (!Array.isArray(r.derivations)) err(`${rw}: "derivations" must be an array.`);
      else {
        if (kind !== 'flow') warn(`${rw}: "derivations" are only read on a "flow"; they are ignored on a "${kind}".`);
        for (const [di, dv] of r.derivations.entries()) {
          const dw = `${rw}.derivations[${di}]`;
          if (!dv || typeof dv !== 'object') {
            err(`${dw} is not an object.`);
            continue;
          }
          claim(dv.id, dw);
          if (typeof dv.targetColumnId !== 'string' || !dv.targetColumnId) err(`${dw} has no targetColumnId; the generator skips it.`);
          else if (tgt && !tgt.has(dv.targetColumnId)) err(`${dw}: targetColumnId "${dv.targetColumnId}" is not a column of the target table.`);
          const w = dv.window;
          const countsRows = w && typeof w === 'object' && WINDOWS_WITHOUT_EXPRESSION.includes(w.fn);
          if ((typeof dv.expression !== 'string' || !dv.expression.trim()) && !countsRows) err(`${dw} has no expression; the generator skips it.`);
          if (dv.aggregate !== undefined && dv.aggregate !== null && !AGGREGATES.includes(dv.aggregate)) {
            err(`${dw}: aggregate "${dv.aggregate}" is not one of ${AGGREGATES.join(', ')}; it is dropped on load.`);
          }
          if (dv.groupBy !== undefined && !Array.isArray(dv.groupBy)) err(`${dw}: "groupBy" must be an array of strings.`);
          if (w !== undefined) {
            if (!w || typeof w !== 'object') err(`${dw}: "window" must be an object { fn, orderBy, partitionBy }.`);
            else {
              if (!WINDOW_FUNCTIONS.includes(w.fn)) err(`${dw}: window fn "${w.fn}" is not one of ${WINDOW_FUNCTIONS.join(', ')}; the window is dropped on load.`);
              if (!Array.isArray(w.orderBy) || !w.orderBy.some((k) => typeof k === 'string' && k.trim())) err(`${dw}: a window needs a non-empty "orderBy" array, or "previous row" means nothing.`);
              if (w.partitionBy !== undefined && !Array.isArray(w.partitionBy)) err(`${dw}: "partitionBy" must be an array of strings.`);
            }
          }
        }
      }
    }
  }

  for (const [ni, n] of (Array.isArray(doc.notes) ? doc.notes : []).entries()) {
    const nw = `notes[${ni}]`;
    if (!n || typeof n !== 'object') {
      err(`${nw} is not an object.`);
      continue;
    }
    claim(n.id, nw);
    if (typeof n.text !== 'string' || !n.text.trim()) warn(`${nw} has no text.`);
    if (n.color !== undefined && !COLORS.includes(n.color)) warn(`${nw}: colour "${n.color}" is not in the palette.`);
  }

  return { errors, warnings };
}

/**
 * A workspace file holds several diagrams under "sheets"; each one is a diagram
 * object with an id, so each is checked on its own and told apart in the report.
 */
function validateWorkspace(doc) {
  const errors = [];
  const warnings = [];
  if (doc.version !== 1) warnings.push(`"version" should be 1 (found ${JSON.stringify(doc.version)}).`);
  if (typeof doc.name !== 'string' || !doc.name.trim()) warnings.push('"name" is missing; the workspace takes the name of its first diagram.');
  if (doc.sheets.length === 0) return { errors: ['"sheets" is empty; a workspace needs at least one diagram.'], warnings };
  const ids = new Set();
  doc.sheets.forEach((sheet, i) => {
    const where = `sheets[${i}]${sheet && typeof sheet.name === 'string' ? ` "${sheet.name}"` : ''}`;
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) {
      errors.push(`${where} is not an object.`);
      return;
    }
    if (typeof sheet.id !== 'string' || !sheet.id) warnings.push(`${where} has no "id"; one is generated on load, and its checkpoints cannot follow it.`);
    else if (ids.has(sheet.id)) errors.push(`${where}: "id" ${JSON.stringify(sheet.id)} is used by an earlier sheet; the app gives one of them a new id on load.`);
    else ids.add(sheet.id);
    const r = validate(sheet);
    for (const m of r.errors) errors.push(`${where}: ${m}`);
    for (const m of r.warnings) warnings.push(`${where}: ${m}`);
  });
  if (doc.activeSheet !== undefined && !ids.has(doc.activeSheet)) warnings.push(`"activeSheet" ${JSON.stringify(doc.activeSheet)} is not one of the sheet ids; the first sheet opens instead.`);
  return { errors, warnings };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/validate-dbviz.mjs <file.dbviz.json> [...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`${file}\n  ERROR  ${e.message}\n`);
    failed = true;
    continue;
  }
  const { errors, warnings } = doc && typeof doc === 'object' && Array.isArray(doc.sheets) ? validateWorkspace(doc) : validate(doc);
  console.log(file);
  for (const m of errors) console.log(`  ERROR  ${m}`);
  for (const m of warnings) console.log(`  warn   ${m}`);
  if (!errors.length && !warnings.length) console.log('  OK');
  console.log('');
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
