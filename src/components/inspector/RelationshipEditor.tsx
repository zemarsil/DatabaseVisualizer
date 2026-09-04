import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
import { REFERENTIAL_ACTIONS, type ReferentialAction, type Relationship } from '@shared/types';
import { useStore } from '@/store/useStore';

export function RelationshipEditor({ relationship: r }: { relationship: Relationship }) {
  const tables = useStore((s) => s.diagram.tables);
  const updateRelationship = useStore((s) => s.updateRelationship);
  const deleteRelationship = useStore((s) => s.deleteRelationship);
  const swapRelationship = useStore((s) => s.swapRelationship);
  const setSelection = useStore((s) => s.setSelection);

  const src = tables.find((t) => t.id === r.sourceTableId);
  const tgt = tables.find((t) => t.id === r.targetTableId);
  if (!src || !tgt) return <div className="danger">This connection points at a table that no longer exists.</div>;

  const patch = (p: Partial<Relationship>) => updateRelationship(r.id, p);
  const pairCount = Math.max(r.sourceColumnIds.length, r.targetColumnIds.length, r.kind === 'fk' ? 1 : 0);
  const setPair = (i: number, side: 'source' | 'target', colId: string) => {
    const key = side === 'source' ? 'sourceColumnIds' : 'targetColumnIds';
    const ids = [...r[key]];
    while (ids.length <= i) ids.push('');
    ids[i] = colId;
    patch({ [key]: ids.filter((x, j) => x || j < pairCount) });
  };
  const removePair = (i: number) => {
    patch({ sourceColumnIds: r.sourceColumnIds.filter((_, j) => j !== i), targetColumnIds: r.targetColumnIds.filter((_, j) => j !== i) });
  };
  const addPair = () => {
    const nextSrc = src.columns.find((c) => !r.sourceColumnIds.includes(c.id))?.id ?? src.columns[0]?.id ?? '';
    const nextTgt = tgt.columns.find((c) => c.primaryKey && !r.targetColumnIds.includes(c.id))?.id ?? tgt.columns[0]?.id ?? '';
    patch({ sourceColumnIds: [...r.sourceColumnIds, nextSrc], targetColumnIds: [...r.targetColumnIds, nextTgt] });
  };

  return (
    <div>
      <div className="field">
        <span className="field__label">Kind</span>
        <div className="row">
          <button className={`btn btn--sm${r.kind === 'fk' ? ' btn--active' : ''}`} onClick={() => patch({ kind: 'fk' })}>
            Foreign key
          </button>
          <button className={`btn btn--sm${r.kind === 'flow' ? ' btn--active' : ''}`} onClick={() => patch({ kind: 'flow' })}>
            Data flow
          </button>
        </div>
        <span className="field__hint">
          {r.kind === 'fk'
            ? 'A real FOREIGN KEY constraint. It is written into the CREATE TABLE script.'
            : 'Documents how rows in the target are produced from the source (an ETL step, a rollup, a trigger). Drawn dashed; never emitted as DDL.'}
        </span>
      </div>

      <div className="field">
        <span className="field__label">{r.kind === 'fk' ? 'Referencing → referenced' : 'Source → target'}</span>
        <div className="row">
          <button className="chip chip--on" onClick={() => setSelection({ tableIds: [src.id], relationshipId: null, noteId: null })} title="Select table">
            {src.name}
          </button>
          <span className="faint">→</span>
          <button className="chip chip--on" onClick={() => setSelection({ tableIds: [tgt.id], relationshipId: null, noteId: null })} title="Select table">
            {tgt.name}
          </button>
          <span className="grow" />
          <button className="btn btn--sm" onClick={() => swapRelationship(r.id)} title="Swap direction">
            <ArrowLeftRight /> Swap
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field__label">{r.kind === 'fk' ? 'Column pairs' : 'Anchor columns (optional)'}</span>
        {Array.from({ length: pairCount }).map((_, i) => (
          <div key={i} className="pair-row">
            <select className="select select--sm" value={r.sourceColumnIds[i] ?? ''} onChange={(e) => setPair(i, 'source', e.target.value)}>
              <option value="">{r.kind === 'fk' ? '— pick —' : '(table)'}</option>
              {src.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="pair-row__eq">{r.kind === 'fk' ? '=' : '→'}</span>
            <select className="select select--sm" value={r.targetColumnIds[i] ?? ''} onChange={(e) => setPair(i, 'target', e.target.value)}>
              <option value="">{r.kind === 'fk' ? '— pick —' : '(table)'}</option>
              {tgt.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.primaryKey ? ' (PK)' : ''}
                </option>
              ))}
            </select>
            <button className="icon-btn icon-btn--danger" title="Remove pair" onClick={() => removePair(i)} disabled={r.kind === 'fk' && pairCount === 1}>
              <Trash2 />
            </button>
          </div>
        ))}
        {(r.kind === 'fk' || pairCount === 0) && (
          <div>
            <button className="btn btn--sm" onClick={addPair}>
              <Plus /> {r.kind === 'fk' ? 'Add column pair (composite key)' : 'Anchor to columns'}
            </button>
          </div>
        )}
      </div>

      <div className="field">
        <span className="field__label">{r.kind === 'fk' ? 'Constraint name' : `Label (${src.name} → ${tgt.name})`}</span>
        <input className="input input--sm" value={r.name ?? ''} onChange={(e) => patch({ name: e.target.value || undefined })} placeholder={r.kind === 'fk' ? `fk_${src.name}_${tgt.name}` : 'e.g. has'} spellCheck={false} />
      </div>

      <div className="field">
        <span className="field__label">Inverse label ({tgt.name} → {src.name})</span>
        <input
          className="input input--sm"
          value={r.inverseName ?? ''}
          onChange={(e) => patch({ inverseName: e.target.value || undefined })}
          placeholder="e.g. used by"
          spellCheck={false}
        />
        <span className="field__hint">Shown on the edge when you're looking from {tgt.name}'s side, e.g. "{src.name} has {tgt.name}" and "{tgt.name} used by {src.name}".</span>
      </div>

      {r.kind === 'fk' && (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <span className="field__label">On delete</span>
            <select className="select select--sm" value={r.onDelete ?? 'NO ACTION'} onChange={(e) => patch({ onDelete: e.target.value as ReferentialAction })}>
              {REFERENTIAL_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <span className="field__label">On update</span>
            <select className="select select--sm" value={r.onUpdate ?? 'NO ACTION'} onChange={(e) => patch({ onUpdate: e.target.value as ReferentialAction })}>
              {REFERENTIAL_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="field">
        <span className="field__label">Tagged query</span>
        <textarea
          className="textarea textarea--mono"
          rows={7}
          value={r.query ?? ''}
          onChange={(e) => patch({ query: e.target.value || undefined })}
          placeholder={`How data crosses this connection, e.g.\nINSERT INTO ${tgt.name} (...)\nSELECT ... FROM ${src.name} ...`}
          spellCheck={false}
        />
        <span className="field__hint">Shown as a badge on the edge and as a comment in the generated script.</span>
      </div>
      <div className="field">
        <span className="field__label">Note</span>
        <textarea className="textarea" rows={2} value={r.note ?? ''} onChange={(e) => patch({ note: e.target.value || undefined })} placeholder="When it runs, who owns it, gotchas…" />
      </div>

      <div className="divider" />
      <button className="btn btn--danger" onClick={() => deleteRelationship(r.id)}>
        <Trash2 /> Delete connection
      </button>
    </div>
  );
}
