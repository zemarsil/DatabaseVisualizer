#!/usr/bin/env node
/**
 * Structural check for a hand-written .dbviz.json (see docs/ADVISOR_OUTPUT_FORMAT.md).
 *
 * The app loads tolerantly: a dangling relationship or a bad colour key produces no
 * error, just a wrong-looking diagram. This catches those before you open the file.
 *
 *   node scripts/validate-dbviz.mjs file.dbviz.json [more.dbviz.json ...]
 *
 * Exits 1 if any file has errors. Warnings alone do not fail.
 */
import { readFileSync } from 'node:fs';

const COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'slate'];
const ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

function validate(doc) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['Top level is not an object.'], warnings };
  if (doc.version !== 1) warn(`"version" should be 1 (found ${JSON.stringify(doc.version)}).`);
  if (typeof doc.name !== 'string' || !doc.name.trim()) warn('"name" is missing; the diagram will load as "Untitled diagram".');
  if (doc.dialect !== 'postgresql' && doc.dialect !== 'mariadb') err(`"dialect" must be "postgresql" or "mariadb" (found ${JSON.stringify(doc.dialect)}); it silently falls back to postgresql.`);
  if (!Array.isArray(doc.tables)) return { errors: [...errors, '"tables" must be an array; the app refuses the file without it.'], warnings };

  const ids = new Map(); // id -> what claimed it
  const claim = (id, what) => {
    if (typeof id !== 'string' || !id) { err(`${what} has a missing or non-string id.`); return; }
    if (ids.has(id)) err(`Duplicate id "${id}": used by ${ids.get(id)} and ${what}.`);
    else ids.set(id, what);
  };

  const columnsOfTable = new Map(); // tableId -> Set(columnId)
  const positions = new Map();

  for (const [ti, t] of doc.tables.entries()) {
    const where = `tables[${ti}]${t && t.name ? ` (${t.name})` : ''}`;
    if (!t || typeof t !== 'object') { err(`${where} is not an object.`); continue; }
    claim(t.id, where);
    if (typeof t.name !== 'string' || !t.name.trim()) err(`${where} has no name; the app skips tables without one.`);
    if (t.color !== undefined && !COLORS.includes(t.color)) warn(`${where}: colour "${t.color}" is not in the palette; it renders as blue. Use one of ${COLORS.join(', ')}.`);
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
      if (!c || typeof c !== 'object') { err(`${cw} is not an object.`); continue; }
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
      if (doc.dialect === 'postgresql' && typeof c.type === 'string' && /auto_increment/i.test(c.type)) err(`${cw}: type "${c.type}" is MariaDB syntax but the dialect is postgresql (use SERIAL/BIGSERIAL with autoIncrement).`);
      if (doc.dialect === 'mariadb' && typeof c.type === 'string' && /^\s*(big|small)?serial\b|timestamptz|jsonb/i.test(c.type)) err(`${cw}: type "${c.type}" is PostgreSQL syntax but the dialect is mariadb.`);
    }

    for (const [ii, idx] of (Array.isArray(t.indexes) ? t.indexes : []).entries()) {
      const iw = `${where}.indexes[${ii}]${idx && idx.name ? ` (${idx.name})` : ''}`;
      if (!idx || typeof idx !== 'object') { err(`${iw} is not an object.`); continue; }
      claim(idx.id, iw);
      const list = Array.isArray(idx.columnIds) ? idx.columnIds : [];
      if (list.length === 0) err(`${iw} has no columnIds; the app drops indexes with none.`);
      for (const cid of list) if (!cols.has(cid)) err(`${iw} references column id "${cid}", which is not a column of this table.`);
    }
  }

  for (const [ri, r] of (Array.isArray(doc.relationships) ? doc.relationships : []).entries()) {
    const rw = `relationships[${ri}]${r && r.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object') { err(`${rw} is not an object.`); continue; }
    claim(r.id, rw);
    const kind = r.kind === undefined ? 'fk' : r.kind;
    if (kind !== 'fk' && kind !== 'flow') err(`${rw}: "kind" must be "fk" or "flow" (found ${JSON.stringify(r.kind)}); anything else loads as "fk".`);
    const src = columnsOfTable.get(r.sourceTableId);
    const tgt = columnsOfTable.get(r.targetTableId);
    if (!src) err(`${rw}: sourceTableId "${r.sourceTableId}" is not a table in this file.`);
    if (!tgt) err(`${rw}: targetTableId "${r.targetTableId}" is not a table in this file.`);
    if (r.sourceTableId && r.sourceTableId === r.targetTableId) warn(`${rw} is a self-reference; Trace ignores self-edges.`);
    const sc = Array.isArray(r.sourceColumnIds) ? r.sourceColumnIds : [];
    const tc = Array.isArray(r.targetColumnIds) ? r.targetColumnIds : [];
    for (const cid of sc) if (src && !src.has(cid)) err(`${rw}: sourceColumnIds has "${cid}", which is not a column of the source table.`);
    for (const cid of tc) if (tgt && !tgt.has(cid)) err(`${rw}: targetColumnIds has "${cid}", which is not a column of the target table.`);
    if (sc.length !== tc.length) err(`${rw}: sourceColumnIds (${sc.length}) and targetColumnIds (${tc.length}) must pair up one to one.`);
    if (kind === 'fk' && sc.length === 0) err(`${rw}: a foreign key needs columns on both sides. (A table-to-table annotation should be "kind": "flow".)`);
    if (kind === 'flow' && !r.query && !r.note) warn(`${rw}: a flow edge with no "query" and no "note" says only that the tables are related — add the query that moves the data.`);
    for (const k of ['onDelete', 'onUpdate']) {
      if (r[k] !== undefined && !ACTIONS.includes(r[k])) err(`${rw}: ${k} "${r[k]}" is not one of ${ACTIONS.join(', ')}.`);
    }
  }

  for (const [ni, n] of (Array.isArray(doc.notes) ? doc.notes : []).entries()) {
    const nw = `notes[${ni}]`;
    if (!n || typeof n !== 'object') { err(`${nw} is not an object.`); continue; }
    claim(n.id, nw);
    if (typeof n.text !== 'string' || !n.text.trim()) warn(`${nw} has no text.`);
    if (n.color !== undefined && !COLORS.includes(n.color)) warn(`${nw}: colour "${n.color}" is not in the palette.`);
  }

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
  const { errors, warnings } = validate(doc);
  console.log(file);
  for (const m of errors) console.log(`  ERROR  ${m}`);
  for (const m of warnings) console.log(`  warn   ${m}`);
  if (!errors.length && !warnings.length) console.log('  OK');
  console.log('');
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
