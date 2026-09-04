import { useState } from 'react';
import { ChevronDown, ChevronRight, List, Plus, Rows3, Trash2 } from 'lucide-react';
import type { CustomType, CustomTypeField } from '@shared/types';
import { useStore } from '@/store/useStore';
import { TYPE_SUGGESTIONS } from '@/lib/sql/dialect';
import { createCustomTypeField } from '@/lib/model';
import { confirmDialog } from '../ui/Modal';

function EnumEditor({ ct }: { ct: CustomType }) {
  const updateCustomType = useStore((s) => s.updateCustomType);
  const values = ct.values ?? [];
  const setValues = (v: string[]) => updateCustomType(ct.id, { values: v });
  return (
    <div className="section">
      <div className="section__head">
        <span className="section__title">Values ({values.length})</span>
        <button className="btn btn--sm" onClick={() => setValues([...values, ''])}>
          <Plus /> Value
        </button>
      </div>
      {values.map((v, i) => (
        <div key={i} className="row" style={{ marginBottom: 4 }}>
          <input
            className="input input--sm input--mono grow"
            value={v}
            placeholder="e.g. pending"
            spellCheck={false}
            onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button className="icon-btn icon-btn--danger" onClick={() => setValues(values.filter((_, j) => j !== i))} title="Remove">
            <Trash2 />
          </button>
        </div>
      ))}
      {values.length === 0 && <div className="faint small">No values yet — this enum won't accept anything until you add one.</div>}
    </div>
  );
}

function CompositeEditor({ ct }: { ct: CustomType }) {
  const updateCustomType = useStore((s) => s.updateCustomType);
  const dialect = useStore((s) => s.diagram.dialect);
  const customTypes = useStore((s) => s.diagram.customTypes);
  const fields = ct.fields ?? [];
  const setFields = (f: CustomTypeField[]) => updateCustomType(ct.id, { fields: f });
  const patchField = (id: string, patch: Partial<CustomTypeField>) => setFields(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const addField = () => setFields([...fields, createCustomTypeField({ name: `field_${fields.length + 1}` })]);

  return (
    <div className="section">
      <div className="section__head">
        <span className="section__title">Fields ({fields.length})</span>
        <button className="btn btn--sm" onClick={addField}>
          <Plus /> Field
        </button>
      </div>
      <datalist id={`types-${dialect}-with-custom`}>
        {TYPE_SUGGESTIONS[dialect].map((t) => (
          <option key={t} value={t} />
        ))}
        {customTypes.filter((t) => t.id !== ct.id).map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
      {fields.map((f) => (
        <div key={f.id} className="row" style={{ marginBottom: 4 }}>
          <input className="input input--sm grow" value={f.name} placeholder="field name" spellCheck={false} onChange={(e) => patchField(f.id, { name: e.target.value })} />
          <input
            className="input input--sm input--mono grow"
            value={f.type}
            placeholder="TYPE"
            list={`types-${dialect}-with-custom`}
            spellCheck={false}
            onChange={(e) => patchField(f.id, { type: e.target.value })}
          />
          <button className="icon-btn icon-btn--danger" onClick={() => setFields(fields.filter((x) => x.id !== f.id))} title="Remove">
            <Trash2 />
          </button>
        </div>
      ))}
      {fields.length === 0 && <div className="faint small">No fields yet — add at least one to make this type usable.</div>}
      {dialect === 'mariadb' && (
        <div className="field__hint" style={{ marginTop: 6 }}>
          MariaDB has no composite type: generated SQL will store columns of this type as JSON.
        </div>
      )}
    </div>
  );
}

function CustomTypeCard({ ct }: { ct: CustomType }) {
  const updateCustomType = useStore((s) => s.updateCustomType);
  const deleteCustomType = useStore((s) => s.deleteCustomType);
  const customTypeUsage = useStore((s) => s.customTypeUsage);
  const dialect = useStore((s) => s.diagram.dialect);
  const [open, setOpen] = useState(true);
  const usage = customTypeUsage(ct.id);

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete type "${ct.name}"?`,
      message: usage.length
        ? `${usage.length} column(s) still use this type by name; they'll keep the raw text "${ct.name}" but it will no longer resolve to a defined type.`
        : 'This can be undone with Ctrl+Z.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) deleteCustomType(ct.id);
  };

  return (
    <div className="list-item">
      <div className="row" style={{ marginBottom: open ? 8 : 0 }}>
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
        <span className="faint" title={ct.kind === 'enum' ? 'Enum' : 'Composite / struct'}>
          {ct.kind === 'enum' ? <List size={14} /> : <Rows3 size={14} />}
        </span>
        <input className="input input--sm input--mono grow" value={ct.name} spellCheck={false} onChange={(e) => updateCustomType(ct.id, { name: e.target.value })} />
        <span className="badge" title={ct.kind === 'enum' ? 'Fixed set of values' : 'Named fields, like a struct'}>
          {ct.kind === 'enum' ? 'enum' : 'struct'}
        </span>
        {usage.length > 0 && (
          <span className="badge badge--accent" title={usage.map((u) => `${u.table.name}.${u.column.name}`).join(', ')}>
            used by {usage.length}
          </span>
        )}
        <button className="icon-btn icon-btn--danger" onClick={onDelete} title="Delete type">
          <Trash2 />
        </button>
      </div>
      {open && (
        <>
          <div className="field field--full" style={{ marginBottom: 8 }}>
            <span className="field__label">Comment</span>
            <input className="input input--sm" value={ct.comment ?? ''} onChange={(e) => updateCustomType(ct.id, { comment: e.target.value || undefined })} placeholder="What this type represents" />
          </div>
          {ct.kind === 'enum' ? <EnumEditor ct={ct} /> : <CompositeEditor ct={ct} />}
          {ct.kind === 'enum' && dialect === 'mariadb' && (
            <div className="field__hint" style={{ marginTop: 6 }}>
              MariaDB has no named enum type: columns using "{ct.name}" are generated as an inline ENUM(...) with these values.
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TypesPanel() {
  const customTypes = useStore((s) => s.diagram.customTypes);
  const addCustomType = useStore((s) => s.addCustomType);

  return (
    <div className="drawer__col" style={{ maxWidth: 640 }}>
      <div className="drawer__toolbar">
        <h3 style={{ margin: 0 }}>Custom types</h3>
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => addCustomType('enum')}>
          <Plus /> Enum
        </button>
        <button className="btn btn--sm" onClick={() => addCustomType('composite')}>
          <Plus /> Struct type
        </button>
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        Define a named type once, then type its name into any column's TYPE field (it shows up in the autocomplete) to reuse it. An <b>enum</b> is a fixed set of
        allowed values. A <b>struct</b> type has its own named sub-fields, like a composite/record type — PostgreSQL emits a real{' '}
        <code>CREATE TYPE … AS ENUM</code> / <code>CREATE TYPE … AS (...)</code>; MariaDB has no such feature, so enums are inlined per-column and structs fall
        back to JSON in generated SQL. SQL databases don't attach methods/functions to types the way a class does — use CHECK constraints on the column for
        validation instead.
      </div>
      {customTypes.length === 0 && <div className="faint small">No custom types yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
        {customTypes.map((ct) => (
          <CustomTypeCard key={ct.id} ct={ct} />
        ))}
      </div>
    </div>
  );
}
