import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Braces, ChevronDown, ChevronRight, Code2, Copy, Database, Eye, GitBranch, GripVertical, Link2, Plus, Table2, Trash2, Waypoints } from 'lucide-react';
import { verbLabel, type Column, type Index, type RelationshipKind, type Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { ViewEditor } from './ViewEditor';
import { flowDerivations } from '@/lib/derivation';
import { PALETTE, paletteHue } from '@/lib/palette';
import { embeddedColumnIds, foreignKeyColumnIds } from '@/lib/model';
import { TYPE_SUGGESTIONS } from '@/lib/sql/dialect';
import { generateTableSql } from '@/lib/sql/generator';
import { confirmDialog } from '../ui/Modal';

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
  register: (id: string, el: HTMLInputElement | null) => void;
  drag: DragState | null;
  setDrag: (d: DragState | null) => void;
}

function ColumnRow({ table, column, index, fk, embed, register, drag, setDrag }: ColumnRowProps) {
  const updateColumn = useStore((s) => s.updateColumn);
  const deleteColumn = useStore((s) => s.deleteColumn);
  const moveColumn = useStore((s) => s.moveColumn);
  const addColumn = useStore((s) => s.addColumn);
  const reorderColumn = useStore((s) => s.reorderColumn);
  const focusColumn = useStore((s) => s.focusColumn);
  const dialect = useStore((s) => s.diagram.dialect);
  const customType = useStore((s) => s.diagram.customTypes.find((t) => t.name.toLowerCase() === column.type.trim().toLowerCase()));
  const [open, setOpen] = useState(false);
  const patch = (p: Partial<Column>) => updateColumn(table.id, column.id, p);

  /** Enter adds a column below (Shift+Enter above); Escape leaves the field; Ctrl+Backspace on an empty name removes the column. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        const prev = table.columns[index - 1];
        if (prev) addColumn(table.id, undefined, { after: prev.id });
        else {
          const id = addColumn(table.id);
          reorderColumn(table.id, id, 0);
        }
      } else {
        addColumn(table.id, undefined, { after: column.id });
      }
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    } else if (e.key === 'Backspace' && (e.ctrlKey || e.metaKey) && !column.name) {
      e.preventDefault();
      const prev = table.columns[index - 1];
      deleteColumn(table.id, column.id);
      if (prev) focusColumn(prev.id);
    }
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
          ref={(el) => register(column.id, el)}
          className="input input--sm"
          value={column.name}
          onChange={(e) => patch({ name: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder="column"
          spellCheck={false}
          title={fk ? 'Referenced by a foreign key' : embed ? 'Holds another table serialized' : undefined}
          style={fk ? { borderColor: 'var(--accent)' } : embed ? { borderColor: 'var(--embed)' } : undefined}
        />
      </div>
      <input
        className="input input--sm input--mono"
        value={column.type}
        onChange={(e) => patch({ type: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder="TYPE"
        list={`types-${dialect}`}
        spellCheck={false}
        title={customType ? `Custom ${customType.kind === 'enum' ? 'enum' : 'struct'} type — edit it in the Types drawer tab` : undefined}
        style={customType ? { borderColor: 'var(--accent)' } : undefined}
      />
      <div className="col-row__flags">
        <FlagButton on={column.primaryKey} label="PK" title="Primary key" className="flag-btn--pk" onClick={() => patch({ primaryKey: !column.primaryKey })} />
        <FlagButton on={!column.nullable} label="NN" title="NOT NULL" onClick={() => patch({ nullable: !column.nullable })} />
        <FlagButton on={column.unique} label="UQ" title="UNIQUE" onClick={() => patch({ unique: !column.unique })} />
        <FlagButton on={column.autoIncrement} label="AI" title={dialect === 'mariadb' ? 'AUTO_INCREMENT' : 'Identity / serial'} onClick={() => patch({ autoIncrement: !column.autoIncrement })} />
        <button type="button" className="icon-btn" title="More options" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
      </div>
      {open && (
        <div className="col-row__more">
          <div className="field">
            <span className="field__label">Default</span>
            <input className="input input--sm input--mono" value={column.defaultValue ?? ''} onChange={(e) => patch({ defaultValue: e.target.value || undefined })} placeholder="e.g. now() or 'pending'" spellCheck={false} />
          </div>
          <div className="field">
            <span className="field__label">Check</span>
            <input className="input input--sm input--mono" value={column.check ?? ''} onChange={(e) => patch({ check: e.target.value || undefined })} placeholder="e.g. price >= 0" spellCheck={false} />
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
  const [showSql, setShowSql] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const register = (id: string, el: HTMLInputElement | null) => {
    if (el) inputs.current.set(id, el);
    else inputs.current.delete(id);
  };
  const isView = table.kind === 'view';

  // A column added with Enter (or from a menu) gets the cursor so typing flows on.
  useEffect(() => {
    if (!focusColumnId) return;
    const el = inputs.current.get(focusColumnId);
    if (!el) return;
    el.focus();
    el.select();
    focusColumn(null);
  }, [focusColumnId, focusColumn, table.columns.length]);

  const fkColumns = useMemo(() => foreignKeyColumnIds(diagram, table.id), [diagram, table.id]);
  const embedColumns = useMemo(() => embeddedColumnIds(diagram, table.id), [diagram, table.id]);

  const relationships = useMemo(() => diagram.relationships.filter((r) => r.sourceTableId === table.id || r.targetTableId === table.id), [diagram.relationships, table.id]);
  const group = diagram.groups.find((g) => g.id === table.groupId);
  const tableName = (id: string) => diagram.tables.find((t) => t.id === id)?.name ?? '?';
  const sql = showSql ? generateTableSql(diagram, table.id) : '';

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
        {TYPE_SUGGESTIONS[diagram.dialect].map((t) => (
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
        <input className="input" value={table.name} onChange={(e) => updateTable(table.id, { name: e.target.value })} spellCheck={false} autoFocus={table.columns.length <= 1} />
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <span className="field__label">Schema</span>
          <input className="input input--sm" value={table.schema ?? ''} onChange={(e) => updateTable(table.id, { schema: e.target.value || undefined })} placeholder={diagram.dialect === 'postgresql' ? 'public' : '(database)'} spellCheck={false} />
        </div>
        <div className="field">
          <span className="field__label">Color</span>
          <div className="swatches">
            {PALETTE.map((p) => (
              <button key={p.key} className={`swatch${table.color === p.key ? ' swatch--active' : ''}`} style={{ background: p.hue }} title={p.label} onClick={() => updateTable(table.id, { color: p.key })} />
            ))}
          </div>
        </div>
      </div>
      <div className="field">
        <span className="field__label">Comment</span>
        <input className="input input--sm" value={table.comment ?? ''} onChange={(e) => updateTable(table.id, { comment: e.target.value || undefined })} placeholder="What this table is for" />
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
            <ColumnRow key={c.id} table={table} column={c} index={i} fk={fkColumns.has(c.id)} embed={embedColumns.has(c.id)} register={register} drag={drag} setDrag={setDrag} />
          ))}
          {table.columns.length === 0 && <div className="faint small">No columns yet.</div>}
        </div>
        <div className="field__hint" style={{ marginTop: 6 }}>
          PK primary key · NN not null · UQ unique · AI auto-increment. Enter adds the next column, Shift+Enter one above, drag the grip to reorder. Expand a row for default, check and comment.
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
            <input
              className="input input--sm input--mono grow"
              value={chk}
              placeholder="e.g. end_date > start_date"
              spellCheck={false}
              onChange={(e) => setChecks(table.id, table.checks.map((c, j) => (j === i ? e.target.value : c)))}
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
            <pre className="code-block" style={{ maxHeight: 260 }}>
              {sql}
            </pre>
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
