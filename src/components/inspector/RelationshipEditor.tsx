import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
import {
  REFERENTIAL_ACTIONS,
  RELATIONSHIP_KINDS,
  describeRelationship,
  kindMeta,
  relationshipVerb,
  verbsForKind,
  type ReferentialAction,
  type Relationship,
  type RelationshipKind,
  type RelationshipVerb,
} from '@shared/types';
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

  const meta = kindMeta(r.kind);
  const verb = relationshipVerb(r);
  const isFk = r.kind === 'fk';
  const isEmbed = r.kind === 'embed';

  const patch = (p: Partial<Relationship>) => updateRelationship(r.id, p);
  const setKind = (kind: RelationshipKind) => {
    // A serialized copy is anchored to the one column that stores it, so the
    // target-side columns of a former foreign key would just be dead state.
    if (kind === 'embed') patch({ kind, sourceColumnIds: r.sourceColumnIds.slice(0, 1), targetColumnIds: [] });
    else patch({ kind });
  };

  const pairCount = Math.max(r.sourceColumnIds.length, r.targetColumnIds.length, isFk ? 1 : 0);
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
        <div className="kind-grid">
          {RELATIONSHIP_KINDS.map((k) => (
            <button key={k.id} className={`btn btn--sm${r.kind === k.id ? ' btn--active' : ''}`} onClick={() => setKind(k.id)}>
              <span className={`kind-swatch kind-swatch--${k.id}`} />
              {k.label}
            </button>
          ))}
        </div>
        <span className="field__hint">{meta.hint}</span>
      </div>

      <div className="field">
        <span className="field__label">Reads as</span>
        <select className="select select--sm" value={verb.id} onChange={(e) => patch({ verb: e.target.value as RelationshipVerb })}>
          {verbsForKind(r.kind).map((v) => (
            <option key={v.id} value={v.id}>
              {v.forward} / {v.inverse}
            </option>
          ))}
        </select>
        <div className="verb-preview">
          <div>{describeRelationship(r, src.name, tgt.name, 'forward')}</div>
          <div className="muted">{describeRelationship(r, src.name, tgt.name, 'inverse')}</div>
        </div>
        <span className="field__hint">{verb.hint}</span>
      </div>

      <div className="field">
        <span className="field__label">{isFk ? 'Referencing → referenced' : isEmbed ? 'Container → embedded' : 'Source → target'}</span>
        <div className="row">
          <button className="chip chip--on" onClick={() => setSelection({ tableIds: [src.id], relationshipId: null, noteIds: [] })} title="Select table">
            {src.name}
          </button>
          <span className="faint">→</span>
          <button className="chip chip--on" onClick={() => setSelection({ tableIds: [tgt.id], relationshipId: null, noteIds: [] })} title="Select table">
            {tgt.name}
          </button>
          <span className="grow" />
          <button className="btn btn--sm" onClick={() => swapRelationship(r.id)} title={isFk ? 'Move the foreign key to the other table' : 'Swap direction'}>
            <ArrowLeftRight /> Swap
          </button>
        </div>
      </div>

      {isEmbed ? (
        <div className="field">
          <span className="field__label">Stored in column</span>
          <select
            className="select select--sm"
            value={r.sourceColumnIds[0] ?? ''}
            onChange={(e) => patch({ sourceColumnIds: e.target.value ? [e.target.value] : [] })}
          >
            <option value="">— whole row / not specified —</option>
            {src.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.type}
              </option>
            ))}
          </select>
          <span className="field__hint">
            The column of {src.name} that holds {tgt.name} encoded — usually JSON/JSONB, an array, a blob, or a composite type. Nothing is emitted into
            the DDL for it.
          </span>
        </div>
      ) : (
        <div className="field">
          <span className="field__label">{isFk ? 'Column pairs' : 'Anchor columns (optional)'}</span>
          {Array.from({ length: pairCount }).map((_, i) => (
            <div key={i} className="pair-row">
              <select className="select select--sm" value={r.sourceColumnIds[i] ?? ''} onChange={(e) => setPair(i, 'source', e.target.value)}>
                <option value="">{isFk ? '— pick —' : '(table)'}</option>
                {src.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="pair-row__eq">{isFk ? '=' : '→'}</span>
              <select className="select select--sm" value={r.targetColumnIds[i] ?? ''} onChange={(e) => setPair(i, 'target', e.target.value)}>
                <option value="">{isFk ? '— pick —' : '(table)'}</option>
                {tgt.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.primaryKey ? ' (PK)' : ''}
                  </option>
                ))}
              </select>
              <button className="icon-btn icon-btn--danger" title="Remove pair" onClick={() => removePair(i)} disabled={isFk && pairCount === 1}>
                <Trash2 />
              </button>
            </div>
          ))}
          {(isFk || pairCount === 0) && (
            <div>
              <button className="btn btn--sm" onClick={addPair}>
                <Plus /> {isFk ? 'Add column pair (composite key)' : 'Anchor to columns'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="field">
        <span className="field__label">{isFk ? 'Constraint name' : 'Label'}</span>
        <input
          className="input input--sm"
          value={r.name ?? ''}
          onChange={(e) => patch({ name: e.target.value || undefined })}
          placeholder={isFk ? `fk_${src.name}_${tgt.name}` : 'e.g. nightly rollup'}
          spellCheck={false}
        />
      </div>

      {isFk && (
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
          placeholder={
            isEmbed
              ? `How the value is read back, e.g.\nSELECT jsonb_array_elements(${r.sourceColumnIds[0] ? src.columns.find((c) => c.id === r.sourceColumnIds[0])?.name ?? 'payload' : 'payload'})\nFROM ${src.name};`
              : `How data crosses this connection, e.g.\nINSERT INTO ${tgt.name} (...)\nSELECT ... FROM ${src.name} ...`
          }
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
