import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Braces, ChevronDown, ChevronRight, Code2, Copy, Database, Eye, GitBranch, GripVertical, Link2, Plus, Sigma, Table2, Trash2, Waypoints } from 'lucide-react';
import { verbLabel, type Column, type Index, type RelationshipKind, type Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { ViewEditor } from './ViewEditor';
import { flowDerivations } from '@/lib/derivation';
import { buildLineage, columnOrigin, describeColumnOrigin, type ColumnOrigin } from '@/lib/lineage';
import { useUi } from '@/store/useUi';
import { columnKeyAction, rovingIndex, FLAG_SHORTCUT, type ColumnField, type ColumnFlag } from '@/lib/editorKeys';
import { PALETTE, paletteHue } from '@/lib/palette';
import { embeddedColumnIds, foreignKeyColumnIds } from '@/lib/model';
import { extensionFunctionSuggestions, typeSuggestions } from '@/lib/extensions/registry';
import { generateTableSql } from '@/lib/sql/generator';
import { confirmDialog } from '../ui/Modal';
import { Swatches } from '../ui/Swatches';
import { SqlCode, SqlEditor } from '../ui/SqlEditor';
import { tableScope } from '@/lib/sqlScope';
import type { CompletionItem } from '@/lib/sql/complete';

/** Little coloured glyph that matches how the edge is drawn on the canvas. */
function RelIcon({ kind }: { kind: RelationshipKind }) {
  if (kind === 'flow') return <GitBranch style={{ color: 'var(--flow)' }} />;
  if (kind === 'embed') return <Braces style={{ color: 'var(--embed)' }} />;
  if (kind === 'dependency') return <Waypoints style={{ color: 'var(--dep)' }} />;
  return <Link2 style={{ color: 'var(--accent)' }} />;
}

function FlagButton({ on, label, title, className, onClick }: { on: boolean; label: string; title: string; className?: string; onClick: () => void }) {
  return (
    <button type="button" className={`flag-btn${on ? ' flag-btn--on' : ''}${className ? ` ${className}` : ''}`} title={title} onClick={onClick}>
      {label}
    </button>
  );
}

/** The four column toggles, in the order they sit on a row. */
const COLUMN_FLAGS: { flag: ColumnFlag; label: string; className?: string }[] = [
  { flag: 'primaryKey', label: 'PK', className: 'flag-btn--pk' },
  { flag: 'nullable', label: 'NN' },
  { flag: 'unique', label: 'UQ' },
  { flag: 'autoIncrement', label: 'AI' },
];

interface DragState {
  id: string;
  over: { id: string; where: 'above' | 'below' } | null;
}

interface ColumnRowProps {
  table: Table;
  column: Column;
  index: number;
  fk: boolean;
  embed: boolean;
  /** How the column gets its value; 'stored' is the ordinary case and shows nothing extra. */
  origin: ColumnOrigin;
  /** The formulas that fill it, one per line, or null when nothing does. */
  originText: string | null;
  register: (id: string, field: 'name' | 'type', el: HTMLInputElement | null) => void;
  /** Put the cursor in another row's name or type box; false if that row is not rendered. */
  focusField: (id: string, field: 'name' | 'type') => boolean;
  drag: DragState | null;
  setDrag: (d: DragState | null) => void;
}

function ColumnRow({ table, column, index, fk, embed, origin, originText, register, focusField, drag, setDrag }: ColumnRowProps) {
  const diagramForScope = useStore((s) => s.diagram);
  /** The default and check boxes colour and complete this table's own columns. */
  const scope = useMemo(() => tableScope(table), [table]);
  /** Functions an enabled extension adds (gen_random_uuid() once pgcrypto is on), offered in the default box. */
  const defaultExtras = useMemo<CompletionItem[]>(
    () => extensionFunctionSuggestions(diagramForScope).map((f) => ({ label: f, insert: f, kind: 'function' as const, detail: 'extension', caretBack: f.endsWith('()') ? 1 : 0 })),
    [diagramForScope],
  );
  const updateColumn = useStore((s) => s.updateColumn);
  const deleteColumn = useStore((s) => s.deleteColumn);
  const moveColumn = useStore((s) => s.moveColumn);
  const addColumn = useStore((s) => s.addColumn);
  const reorderColumn = useStore((s) => s.reorderColumn);
  const focusColumn = useStore((s) => s.focusColumn);
  const dialect = useStore((s) => s.diagram.dialect);
  const customType = useStore((s) => s.diagram.customTypes.find((t) => t.name.toLowerCase() === column.type.trim().toLowerCase()));
  const [open, setOpen] = useState(false);
  // The flags share one tab stop and pass focus between themselves with the
  // arrow keys, so tabbing a row costs three stops (name, type, flags) rather
  // than seven. `flagIndex` is which of them currently holds the tab stop.
  const [flagIndex, setFlagIndex] = useState(0);
  const flagRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const patch = (p: Partial<Column>) => updateColumn(table.id, column.id, p);
  const toggleFlag = (flag: ColumnFlag) => patch({ [flag]: !column[flag] } as Partial<Column>);

  /**
   * Enter adds a column below (Shift+Enter above); Alt+P/N/U/I toggle PK, NN, UQ
   * and AI without the cursor leaving the box; the arrow keys walk the rows;
   * Escape leaves the field; Ctrl+Backspace on an unnamed row removes it.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>, field: ColumnField) => {
    const action = columnKeyAction(e, { field, nameEmpty: !column.name });
    if (!action) return;
    const el = e.currentTarget;
    e.preventDefault();
    if (action.kind === 'add') {
      if (action.where === 'below') addColumn(table.id, undefined, { after: column.id });
      else {
        const prev = table.columns[index - 1];
        if (prev) addColumn(table.id, undefined, { after: prev.id });
        else reorderColumn(table.id, addColumn(table.id), 0);
      }
    } else if (action.kind === 'toggle') {
      toggleFlag(action.flag);
    } else if (action.kind === 'step') {
      const target = table.columns[index + action.delta];
      // From the flag toolbar there is no counterpart on the next row, so land in its name.
      if (target) focusField(target.id, field === 'type' ? 'type' : 'name');
    } else if (action.kind === 'delete') {
      const prev = table.columns[index - 1];
      deleteColumn(table.id, column.id);
      if (prev) focusColumn(prev.id);
    } else if (action.kind === 'blur') {
      el.blur();
    }
  };

  /** Arrow keys move between the flags; everything else is an ordinary row key. */
  const onFlagKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = rovingIndex(e.key, i, COLUMN_FLAGS.length + 1);
    if (next !== null) {
      e.preventDefault();
      setFlagIndex(next);
      flagRefs.current[next]?.focus();
      return;
    }
    onKeyDown(e, 'flags');
  };

  const dragging = drag?.id === column.id;
  const dropWhere = drag?.over?.id === column.id ? drag.over.where : null;
  const classes = ['col-row'];
  if (open) classes.push('col-row--open');
  if (dragging) classes.push('col-row--dragging');
  if (dropWhere) classes.push(`col-row--drop-${dropWhere}`);

  return (
    <div
      className={classes.join(' ')}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const where = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
        if (drag.over?.id !== column.id || drag.over.where !== where) setDrag({ ...drag, over: { id: column.id, where } });
      }}
      onDrop={(e) => {
        if (!drag) return;
        e.preventDefault();
        const from = table.columns.findIndex((c) => c.id === drag.id);
        let to = index + (dropWhere === 'below' ? 1 : 0);
        if (from < to) to -= 1;
        reorderColumn(table.id, drag.id, to);
        setDrag(null);
      }}
    >
      <div className="col-row__name">
        <span
          className="col-row__grip"
          title="Drag to reorder"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', column.id);
            setDrag({ id: column.id, over: null });
          }}
          onDragEnd={() => setDrag(null)}
        >
          <GripVertical />
        </span>
        <input
          ref={(el) => register(column.id, 'name', el)}
          className="input input--sm"
          value={column.name}
          onChange={(e) => patch({ name: e.target.value })}
          onKeyDown={(e) => onKeyDown(e, 'name')}
          placeholder="column"
          spellCheck={false}
          title={fk ? 'Referenced by a foreign key' : embed ? 'Holds another table serialized' : (originText ?? undefined)}
          style={fk ? { borderColor: 'var(--accent)' } : embed ? { borderColor: 'var(--embed)' } : origin !== 'stored' ? { borderColor: 'var(--derived)' } : undefined}
        />
      </div>
      <input
        ref={(el) => register(column.id, 'type', el)}
        className="input input--sm input--mono"
        value={column.type}
        onChange={(e) => patch({ type: e.target.value })}
        onKeyDown={(e) => onKeyDown(e, 'type')}
        placeholder="TYPE"
        list={`types-${dialect}`}
        spellCheck={false}
        title={customType ? `Custom ${customType.kind === 'enum' ? 'enum' : 'struct'} type — edit it in the Types drawer tab` : undefined}
        style={customType ? { borderColor: 'var(--accent)' } : undefined}
      />
      <div className="col-row__flags" role="toolbar" aria-label={`Flags for ${column.name || 'this column'}`}>
        {COLUMN_FLAGS.map((f, i) => {
          const on = f.flag === 'nullable' ? !column.nullable : Boolean(column[f.flag]);
          const what = f.flag === 'primaryKey' ? 'Primary key' : f.flag === 'nullable' ? 'NOT NULL' : f.flag === 'unique' ? 'UNIQUE' : dialect === 'mariadb' ? 'AUTO_INCREMENT' : 'Identity / serial';
          return (
            <button
              key={f.flag}
              type="button"
              ref={(el) => {
                flagRefs.current[i] = el;
              }}
              className={`flag-btn${on ? ' flag-btn--on' : ''}${f.className ? ` ${f.className}` : ''}`}
              title={`${what} (Alt+${FLAG_SHORTCUT[f.flag]})`}
              aria-pressed={on}
              tabIndex={i === flagIndex ? 0 : -1}
              onFocus={() => setFlagIndex(i)}
              onClick={() => toggleFlag(f.flag)}
              onKeyDown={(e) => onFlagKeyDown(e, i)}
            >
              {f.label}
            </button>
          );
        })}
        <button
          type="button"
          ref={(el) => {
            flagRefs.current[COLUMN_FLAGS.length] = el;
          }}
          className="icon-btn"
          title="More options: default, check, comment"
          aria-expanded={open}
          tabIndex={flagIndex === COLUMN_FLAGS.length ? 0 : -1}
          onFocus={() => setFlagIndex(COLUMN_FLAGS.length)}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => onFlagKeyDown(e, COLUMN_FLAGS.length)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
      </div>
      {open && (
        <div className="col-row__more">
          {origin !== 'stored' && (
            <div className="field field--full">
              <span className="field__label">Computed</span>
              <button
                className="btn btn--sm"
                style={{ justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal', height: 'auto', padding: '5px 8px' }}
                title="Open the Derived tab on this column's lineage"
                onClick={() => {
                  useUi.getState().showLineage(column.id);
                  useStore.getState().openDrawer('derived');
                }}
              >
                <Sigma />
                <span className="grow">{originText ?? (origin === 'view' ? 'Computed by the view’s SELECT' : 'Computed by a data flow')}</span>
              </button>
            </div>
          )}
          <div className="field">
            <span className="field__label">Default</span>
            <SqlEditor
              multiline={false}
              mode="expression"
              scope={scope}
              extras={defaultExtras}
              check={false}
              value={column.defaultValue ?? ''}
              onChange={(v) => patch({ defaultValue: v || undefined })}
              placeholder="e.g. now() or 'pending'"
              ariaLabel="Default"
            />
          </div>
          <div className="field">
            <span className="field__label">Check</span>
            <SqlEditor multiline={false} mode="expression" scope={scope} lenient value={column.check ?? ''} onChange={(v) => patch({ check: v || undefined })} placeholder="e.g. price >= 0" ariaLabel="Check" />
          </div>
          <div className="field field--full">
            <span className="field__label">Comment</span>
            <input className="input input--sm" value={column.comment ?? ''} onChange={(e) => patch({ comment: e.target.value || undefined })} placeholder="What this column holds" />
          </div>
          <div className="row field--full" style={{ justifyContent: 'flex-end' }}>
            <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => moveColumn(table.id, column.id, -1)}>
              <ArrowUp />
            </button>
            <button className="icon-btn" title="Move down" disabled={index === table.columns.length - 1} onClick={() => moveColumn(table.id, column.id, 1)}>
              <ArrowDown />
            </button>
            <button className="icon-btn icon-btn--danger" title="Delete column" onClick={() => deleteColumn(table.id, column.id)}>
              <Trash2 />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IndexRow({ table, index }: { table: Table; index: Index }) {
  const updateIndex = useStore((s) => s.updateIndex);
  const deleteIndex = useStore((s) => s.deleteIndex);
  const toggle = (colId: string) => {
    const ids = index.columnIds.includes(colId) ? index.columnIds.filter((c) => c !== colId) : [...index.columnIds, colId];
    updateIndex(table.id, index.id, { columnIds: ids });
  };
  return (
    <div className="list-item">
      <div className="row" style={{ marginBottom: 6 }}>
        <input className="input input--sm grow" value={index.name} onChange={(e) => updateIndex(table.id, index.id, { name: e.target.value })} placeholder="index name (auto)" spellCheck={false} />
        <FlagButton on={index.unique} label="UQ" title="Unique index" onClick={() => updateIndex(table.id, index.id, { unique: !index.unique })} />
        <button className="icon-btn icon-btn--danger" title="Delete index" onClick={() => deleteIndex(table.id, index.id)}>
          <Trash2 />
        </button>
      </div>
      <div className="chip-list">
        {table.columns.map((c) => (
          <button key={c.id} className={`chip${index.columnIds.includes(c.id) ? ' chip--on' : ''}`} onClick={() => toggle(c.id)}>
            {index.columnIds.includes(c.id) ? `${index.columnIds.indexOf(c.id) + 1}. ` : ''}
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TableEditor({ table }: { table: Table }) {
  const scope = useMemo(() => tableScope(table), [table]);
  const diagram = useStore((s) => s.diagram);
  const updateTable = useStore((s) => s.updateTable);
  const addColumn = useStore((s) => s.addColumn);
  const addIndex = useStore((s) => s.addIndex);
  const setChecks = useStore((s) => s.setChecks);
  const deleteTables = useStore((s) => s.deleteTables);
  const duplicateTable = useStore((s) => s.duplicateTable);
  const setSelection = useStore((s) => s.setSelection);
  const setTableGroup = useStore((s) => s.setTableGroup);
  const addGroup = useStore((s) => s.addGroup);
  const openDrawer = useStore((s) => s.openDrawer);
  const toast = useStore((s) => s.toast);
  const focusColumnId = useStore((s) => s.focusColumnId);
  const focusColumn = useStore((s) => s.focusColumn);
  const focusFieldTarget = useStore((s) => s.focusFieldTarget);
  const focusInspectorField = useStore((s) => s.focusInspectorField);
  const [showSql, setShowSql] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const schemaRef = useRef<HTMLInputElement>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const register = (id: string, field: 'name' | 'type', el: HTMLInputElement | null) => {
    const key = `${id}:${field}`;
    if (el) inputs.current.set(key, el);
    else inputs.current.delete(key);
  };
  const focusField = (id: string, field: 'name' | 'type') => {
    const el = inputs.current.get(`${id}:${field}`);
    if (!el) return false;
    el.focus();
    el.select();
    return true;
  };
  const isView = table.kind === 'view';

  /**
   * Enter in the schema box (or a hand-off from elsewhere) drops into the grid.
   * A table with no columns yet gets one, so the fast path never dead-ends —
   * except on a view, where columns are decoration and one would be a surprise.
   */
  const jumpToColumns = () => {
    const first = table.columns[0];
    if (first) focusField(first.id, 'name');
    else if (!isView) addColumn(table.id);
  };

  // A column added with Enter (or from a menu) gets the cursor so typing flows on.
  useEffect(() => {
    if (!focusColumnId) return;
    if (!focusField(focusColumnId, 'name')) return;
    focusColumn(null);
  }, [focusColumnId, focusColumn, table.columns.length]);

  // A new table, or Tab out of the canvas rename box, hands the cursor to a field here.
  useEffect(() => {
    if (!focusFieldTarget) return;
    focusInspectorField(null);
    const box = focusFieldTarget === 'name' ? nameRef.current : focusFieldTarget === 'schema' ? schemaRef.current : null;
    if (box) {
      box.focus();
      box.select();
    } else if (focusFieldTarget === 'columns') {
      jumpToColumns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFieldTarget, table.id]);

  const fkColumns = useMemo(() => foreignKeyColumnIds(diagram, table.id), [diagram, table.id]);
  const embedColumns = useMemo(() => embeddedColumnIds(diagram, table.id), [diagram, table.id]);
  // Where each column's value comes from, so a computed one is not mistaken for
  // something rows arrive carrying.
  const origins = useMemo(() => {
    const lineage = buildLineage(diagram);
    return new Map(table.columns.map((c) => [c.id, { origin: columnOrigin(lineage, c.id), text: describeColumnOrigin(lineage, c.id) }]));
  }, [diagram, table.columns]);

  const relationships = useMemo(() => diagram.relationships.filter((r) => r.sourceTableId === table.id || r.targetTableId === table.id), [diagram.relationships, table.id]);
  const group = diagram.groups.find((g) => g.id === table.groupId);
  const tableName = (id: string) => diagram.tables.find((t) => t.id === id)?.name ?? '?';
  const sql = showSql ? generateTableSql(diagram, table.id) : '';

  /** Enter walks the header fields in the order a table gets typed: name, schema, columns. */
  const stepTo = (e: React.KeyboardEvent<HTMLInputElement>, next: 'schema' | 'columns') => {
    if (e.key === 'Escape') {
      e.currentTarget.blur();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (next === 'columns') jumpToColumns();
    else {
      schemaRef.current?.focus();
      schemaRef.current?.select();
    }
  };

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete table "${table.name}"?`,
      message: relationships.length ? `${relationships.length} connection(s) touching this table will be removed too.` : 'This can be undone with Ctrl+Z.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) deleteTables([table.id]);
  };

  return (
    <div>
      <div className="kind-toggle">
        <button className={`btn btn--sm${!isView ? ' btn--active' : ''}`} onClick={() => updateTable(table.id, { kind: undefined })} title="A real table with rows">
          <Table2 /> Table
        </button>
        <button className={`btn btn--sm${isView ? ' btn--active' : ''}`} onClick={() => updateTable(table.id, { kind: 'view' })} title="A view: a saved SELECT over other tables">
          <Eye /> View
        </button>
      </div>
      <datalist id={`types-${diagram.dialect}`}>
        {typeSuggestions(diagram).map((t) => (
          <option key={t} value={t} />
        ))}
        {diagram.customTypes.map((t) => (
          <option key={t.id} value={t.name}>
            {t.name} ({t.kind === 'enum' ? 'enum' : 'struct'})
          </option>
        ))}
      </datalist>

      <div className="field">
        <span className="field__label">Name</span>
        <input
          ref={nameRef}
          className="input"
          value={table.name}
          onChange={(e) => updateTable(table.id, { name: e.target.value })}
          onKeyDown={(e) => stepTo(e, 'schema')}
          title="Enter moves on to Schema"
          spellCheck={false}
        />
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <span className="field__label">Schema</span>
          <input
            ref={schemaRef}
            className="input input--sm"
            value={table.schema ?? ''}
            onChange={(e) => updateTable(table.id, { schema: e.target.value || undefined })}
            onKeyDown={(e) => stepTo(e, 'columns')}
            placeholder={diagram.dialect === 'postgresql' ? 'public' : '(database)'}
            title="Enter jumps to the columns"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <span className="field__label">Color</span>
          <Swatches value={table.color} onPick={(key) => updateTable(table.id, { color: key })} label="Table colour" />
        </div>
      </div>
      <div className="field">
        <span className="field__label">Comment</span>
        <input
          className="input input--sm"
          value={table.comment ?? ''}
          onChange={(e) => updateTable(table.id, { comment: e.target.value || undefined })}
          onKeyDown={(e) => stepTo(e, 'columns')}
          title="Enter jumps to the columns"
          placeholder="What this table is for"
        />
      </div>
      <div className="field">
        <span className="field__label">Group</span>
        <div className="row">
          <select
            className="select grow"
            value={table.groupId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new__') addGroup({ tableIds: [table.id] });
              else setTableGroup([table.id], e.target.value || null);
            }}
          >
            <option value="">No group</option>
            {diagram.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.external ? ' (external)' : ''}
              </option>
            ))}
            <option value="__new__">New group…</option>
          </select>
        </div>
        {group && (
          <div className="field__hint">
            {group.external ? (
              <>
                <Database size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                In another database: the schema script documents this table instead of creating it.
              </>
            ) : (
              'Drawn inside this region on the canvas; Detangle keeps the group together.'
            )}
          </div>
        )}
      </div>

      {isView && <ViewEditor table={table} />}

      <div className="section">
        <div className="section__head">
          <span className="section__title">
            Columns ({table.columns.length}){isView && <span className="faint"> · optional, for display</span>}
          </span>
          <button className="btn btn--sm" onClick={() => addColumn(table.id)}>
            <Plus /> Column
          </button>
        </div>
        <div className="col-editor">
          {table.columns.map((c, i) => (
            <ColumnRow
              key={c.id}
              table={table}
              column={c}
              index={i}
              fk={fkColumns.has(c.id)}
              embed={embedColumns.has(c.id)}
              origin={origins.get(c.id)?.origin ?? 'stored'}
              originText={origins.get(c.id)?.text ?? null}
              register={register}
              focusField={focusField}
              drag={drag}
              setDrag={setDrag}
            />
          ))}
          {table.columns.length === 0 && <div className="faint small">No columns yet.</div>}
        </div>
        <div className="field__hint" style={{ marginTop: 6 }}>
          PK primary key · NN not null · UQ unique · AI auto-increment — toggle them from the name or type box with Alt+P, Alt+N, Alt+U and Alt+I. Enter adds
          the next column, Shift+Enter one above, ↑ and ↓ walk the rows, Ctrl+Backspace deletes an unnamed one, and the grip drags to reorder. Expand a row for
          default, check and comment. Enter in Name and Schema above walks down to here. A green name box means a data flow (or a view's SELECT) computes the
          column rather than rows carrying it — expand the row to see the formula.
        </div>
      </div>

      {!isView && (
      <div className="section">
        <div className="section__head">
          <span className="section__title">Indexes ({table.indexes.length})</span>
          <button className="btn btn--sm" onClick={() => addIndex(table.id)} disabled={table.columns.length === 0}>
            <Plus /> Index
          </button>
        </div>
        {table.indexes.map((ix) => (
          <IndexRow key={ix.id} table={table} index={ix} />
        ))}
      </div>
      )}

      {!isView && (
      <div className="section">
        <div className="section__head">
          <span className="section__title">Table checks ({table.checks.length})</span>
          <button className="btn btn--sm" onClick={() => setChecks(table.id, [...table.checks, ''])}>
            <Plus /> Check
          </button>
        </div>
        {table.checks.map((chk, i) => (
          <div key={i} className="row" style={{ marginBottom: 4 }}>
            <SqlEditor
              className="grow"
              multiline={false}
              mode="expression"
              scope={scope}
              lenient
              value={chk}
              placeholder="e.g. end_date > start_date"
              ariaLabel="Table check"
              onChange={(v) => setChecks(table.id, table.checks.map((c, j) => (j === i ? v : c)))}
            />
            <button className="icon-btn icon-btn--danger" onClick={() => setChecks(table.id, table.checks.filter((_, j) => j !== i))} title="Remove">
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
      )}

      <div className="section">
        <div className="section__head">
          <span className="section__title">Connections ({relationships.length})</span>
        </div>
        {relationships.length === 0 && <div className="faint small">Drag from a column handle to another table to add one.</div>}
        {relationships.map((r) => {
          const outgoing = r.sourceTableId === table.id;
          const other = tableName(outgoing ? r.targetTableId : r.sourceTableId);
          return (
            <button key={r.id} className="rel-item" onClick={() => setSelection({ relationshipId: r.id, tableIds: [], noteIds: [] })}>
              <RelIcon kind={r.kind} />
              <span className="rel-item__arrow">{verbLabel(r, outgoing ? 'forward' : 'inverse')}</span>
              <span className="grow" style={{ fontWeight: 600 }}>
                {other}
              </span>
              {flowDerivations(r).length > 0 && <span className="badge badge--flow">{flowDerivations(r).length} derived</span>}
              {r.query && <span className="badge badge--accent">SQL</span>}
            </button>
          );
        })}
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">SQL</span>
          <div className="row">
            <button className="btn btn--sm" onClick={() => setShowSql((s) => !s)}>
              <Code2 /> {showSql ? 'Hide' : 'Preview'}
            </button>
            <button className="btn btn--sm" onClick={() => openDrawer('sql')} title="Open the full SQL drawer">
              Drawer
            </button>
          </div>
        </div>
        {showSql && (
          <div style={{ position: 'relative' }}>
            <SqlCode sql={sql} scope={scope} style={{ maxHeight: 260 }} />
            <button
              className="btn btn--sm btn--icon"
              style={{ position: 'absolute', top: 6, right: 6 }}
              title="Copy"
              onClick={() => {
                void navigator.clipboard.writeText(sql);
                toast('success', 'Copied CREATE TABLE.');
              }}
            >
              <Copy />
            </button>
          </div>
        )}
      </div>

      <div className="divider" />
      <div className="row">
        <button className="btn" onClick={() => duplicateTable(table.id)}>
          <Copy /> Duplicate
        </button>
        <span className="grow" />
        <button className="btn btn--danger" onClick={onDelete}>
          <Trash2 /> Delete table
        </button>
      </div>
      <div className="faint small" style={{ marginTop: 10 }}>
        Header colour: <span style={{ color: paletteHue(table.color) }}>■</span> {PALETTE.find((p) => p.key === table.color)?.label ?? table.color}
      </div>
    </div>
  );
}
