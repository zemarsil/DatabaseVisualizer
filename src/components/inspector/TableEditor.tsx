import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Braces, ChevronDown, ChevronRight, Code2, Copy, GitBranch, Link2, Plus, Trash2, Waypoints } from 'lucide-react';
import { verbLabel, type Column, type Index, type RelationshipKind, type Table } from '@shared/types';
import { useStore } from '@/store/useStore';
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

function ColumnRow({ table, column, index, fk, embed }: { table: Table; column: Column; index: number; fk: boolean; embed: boolean }) {
  const updateColumn = useStore((s) => s.updateColumn);
  const deleteColumn = useStore((s) => s.deleteColumn);
  const moveColumn = useStore((s) => s.moveColumn);
  const dialect = useStore((s) => s.diagram.dialect);
  const customType = useStore((s) => s.diagram.customTypes.find((t) => t.name.toLowerCase() === column.type.trim().toLowerCase()));
  const [open, setOpen] = useState(false);
  const patch = (p: Partial<Column>) => updateColumn(table.id, column.id, p);

  return (
    <div className={`col-row${open ? ' col-row--open' : ''}`}>
      <input
        className="input input--sm"
        value={column.name}
        onChange={(e) => patch({ name: e.target.value })}
        placeholder="column"
        spellCheck={false}
        title={fk ? 'Referenced by a foreign key' : embed ? 'Holds another table serialized' : undefined}
        style={fk ? { borderColor: 'var(--accent)' } : embed ? { borderColor: 'var(--embed)' } : undefined}
      />
      <input
        className="input input--sm input--mono"
        value={column.type}
        onChange={(e) => patch({ type: e.target.value })}
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
  const openDrawer = useStore((s) => s.openDrawer);
  const toast = useStore((s) => s.toast);
  const [showSql, setShowSql] = useState(false);

  const fkColumns = useMemo(() => foreignKeyColumnIds(diagram, table.id), [diagram, table.id]);
  const embedColumns = useMemo(() => embeddedColumnIds(diagram, table.id), [diagram, table.id]);

  const relationships = useMemo(() => diagram.relationships.filter((r) => r.sourceTableId === table.id || r.targetTableId === table.id), [diagram.relationships, table.id]);
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

      <div className="section">
        <div className="section__head">
          <span className="section__title">Columns ({table.columns.length})</span>
          <button className="btn btn--sm" onClick={() => addColumn(table.id)}>
            <Plus /> Column
          </button>
        </div>
        <div className="col-editor">
          {table.columns.map((c, i) => (
            <ColumnRow key={c.id} table={table} column={c} index={i} fk={fkColumns.has(c.id)} embed={embedColumns.has(c.id)} />
          ))}
          {table.columns.length === 0 && <div className="faint small">No columns yet.</div>}
        </div>
        <div className="field__hint" style={{ marginTop: 6 }}>
          PK primary key · NN not null · UQ unique · AI auto-increment. Expand a row for default, check and comment.
        </div>
      </div>

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
