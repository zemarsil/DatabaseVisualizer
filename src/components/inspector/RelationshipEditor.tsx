import { useMemo } from 'react';
import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
import {
  AGGREGATE_FUNCTIONS,
  REFERENTIAL_ACTIONS,
  RELATIONSHIP_KINDS,
  describeRelationship,
  kindMeta,
  relationshipVerb,
  verbsForKind,
  type AggregateFunction,
  type Column,
  type Derivation,
  type ReferentialAction,
  type Relationship,
  type RelationshipKind,
  type RelationshipVerb,
} from '@shared/types';
import { derivationSummary } from '@/lib/derivation';
import { createDerivation, relationshipKindPatch } from '@/lib/model';
import { generateFlowSql } from '@/lib/sql/generator';
import { useStore } from '@/store/useStore';

/**
 * One grouping key. Usually a source column, so the picker leads; anything else
 * (an expression, or a column reached through a join) falls back to free text.
 */
function GroupByRow({
  value,
  columns,
  onChange,
  onRemove,
}: {
  value: string;
  columns: Column[];
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const isColumn = columns.some((c) => c.name === value);
  return (
    <div className="derivation__group">
      <select
        className="select select--sm"
        style={isColumn ? { gridColumn: '1 / 3' } : undefined}
        // Options carry the column's index rather than its name: -1 means "free
        // text", and no column name can ever be mistaken for it.
        value={isColumn ? columns.findIndex((c) => c.name === value) : -1}
        onChange={(e) => {
          const i = Number(e.target.value);
          onChange(i < 0 ? '' : columns[i].name);
        }}
      >
        {columns.map((c, i) => (
          <option key={c.id} value={i}>
            {c.name}
          </option>
        ))}
        <option value={-1}>— expression —</option>
      </select>
      {!isColumn && (
        <input
          className="input input--sm input--mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. day"
          spellCheck={false}
        />
      )}
      <button className="icon-btn icon-btn--danger" title="Remove grouping key" onClick={onRemove}>
        <Trash2 />
      </button>
    </div>
  );
}

export function RelationshipEditor({ relationship: r }: { relationship: Relationship }) {
  const diagram = useStore((s) => s.diagram);
  const tables = diagram.tables;
  const updateRelationship = useStore((s) => s.updateRelationship);
  const deleteRelationship = useStore((s) => s.deleteRelationship);
  const swapRelationship = useStore((s) => s.swapRelationship);
  const setSelection = useStore((s) => s.setSelection);

  const flowSql = useMemo(() => (r.kind === 'flow' ? generateFlowSql(diagram, r.id) : ''), [diagram, r.id, r.kind]);

  const src = tables.find((t) => t.id === r.sourceTableId);
  const tgt = tables.find((t) => t.id === r.targetTableId);
  if (!src || !tgt) return <div className="danger">This connection points at a table that no longer exists.</div>;

  const meta = kindMeta(r.kind);
  const verb = relationshipVerb(r);
  const isFk = r.kind === 'fk';
  const isEmbed = r.kind === 'embed';

  const patch = (p: Partial<Relationship>) => updateRelationship(r.id, p);
  const setKind = (kind: RelationshipKind) => patch(relationshipKindPatch(diagram, r, kind));

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

  /* ---------------- structured derivations (flow only) ---------------- */
  const derivations = r.derivations ?? [];
  const setDerivations = (next: Derivation[]) => patch({ derivations: next.length ? next : undefined });
  const updateDerivation = (id: string, p: Partial<Derivation>) => setDerivations(derivations.map((dv) => (dv.id === id ? { ...dv, ...p } : dv)));
  const addDerivation = () => {
    const taken = new Set(derivations.map((dv) => dv.targetColumnId));
    const nextTarget = tgt.columns.find((c) => !taken.has(c.id) && !c.primaryKey) ?? tgt.columns.find((c) => !taken.has(c.id));
    // A second derived column is almost always rolled up like the previous one.
    const like = derivations[derivations.length - 1];
    setDerivations([
      ...derivations,
      createDerivation({ targetColumnId: nextTarget?.id ?? '', aggregate: like?.aggregate, groupBy: [...(like?.groupBy ?? [])], filter: like?.filter }),
    ]);
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

      {r.kind === 'flow' && (
        <div className="section">
          <div className="section__head">
            <span className="section__title">Derived columns ({derivations.length})</span>
            <button className="btn btn--sm" onClick={addDerivation} disabled={tgt.columns.length === 0}>
              <Plus /> Add
            </button>
          </div>
          {derivations.length === 0 && (
            <div className="faint small" style={{ marginBottom: 6 }}>
              Say how a column of {tgt.name} is computed from {src.name}, and the app can summarise it on the edge and generate the INSERT skeleton.
            </div>
          )}
          {derivations.map((dv) => {
            const targetColumn = tgt.columns.find((c) => c.id === dv.targetColumnId);
            return (
              <div key={dv.id} className="derivation">
                <div className="derivation__head">
                  <select
                    className="select select--sm"
                    value={targetColumn ? dv.targetColumnId : ''}
                    onChange={(e) => updateDerivation(dv.id, { targetColumnId: e.target.value })}
                    title={`Column of ${tgt.name} this fills`}
                  >
                    <option value="">— target column —</option>
                    {tgt.columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <span className="pair-row__eq">=</span>
                  <select
                    className="select select--sm"
                    value={dv.aggregate ?? ''}
                    onChange={(e) => updateDerivation(dv.id, { aggregate: e.target.value ? (e.target.value as AggregateFunction) : undefined })}
                    title="Aggregate function"
                  >
                    <option value="">(no aggregate)</option>
                    {AGGREGATE_FUNCTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <button className="icon-btn icon-btn--danger" title="Remove derivation" onClick={() => setDerivations(derivations.filter((x) => x.id !== dv.id))}>
                    <Trash2 />
                  </button>
                </div>

                <div className="field field--tight">
                  <span className="field__label">Expression on {src.name}</span>
                  <input
                    className="input input--sm input--mono"
                    value={dv.expression}
                    onChange={(e) => updateDerivation(dv.id, { expression: e.target.value })}
                    placeholder={dv.aggregate === 'COUNT' ? 'blank for COUNT(*)' : 'e.g. quantity * unit_price_cents'}
                    spellCheck={false}
                  />
                </div>

                <div className="field field--tight">
                  <span className="field__label">Group by</span>
                  {dv.groupBy.map((key, i) => (
                    <GroupByRow
                      key={i}
                      value={key}
                      columns={src.columns}
                      onChange={(v) => updateDerivation(dv.id, { groupBy: dv.groupBy.map((g, j) => (j === i ? v : g)) })}
                      onRemove={() => updateDerivation(dv.id, { groupBy: dv.groupBy.filter((_, j) => j !== i) })}
                    />
                  ))}
                  <div>
                    <button
                      className="btn btn--sm"
                      onClick={() =>
                        updateDerivation(dv.id, { groupBy: [...dv.groupBy, src.columns.find((c) => !dv.groupBy.includes(c.name))?.name ?? ''] })
                      }
                    >
                      <Plus /> Add key
                    </button>
                  </div>
                </div>

                <div className="field field--tight">
                  <span className="field__label">Filter (WHERE)</span>
                  <input
                    className="input input--sm input--mono"
                    value={dv.filter ?? ''}
                    onChange={(e) => updateDerivation(dv.id, { filter: e.target.value || undefined })}
                    placeholder="e.g. status = 'paid'"
                    spellCheck={false}
                  />
                </div>

                <div className="derivation__summary">{derivationSummary(dv, targetColumn?.name)}</div>
              </div>
            );
          })}
          {flowSql && (
            <div className="field" style={{ marginTop: 8 }}>
              <span className="field__label">Generated from these derivations</span>
              <pre className="code-block small">{flowSql}</pre>
              <span className="field__hint">
                A skeleton, not executed. Joins beyond {src.name} and {tgt.name} belong in the tagged query below.
              </span>
            </div>
          )}
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
        <span className="field__hint">
          {r.kind === 'flow'
            ? 'Free text for anything the derivations above cannot express. Shown as a badge on the edge and as a comment in the generated script.'
            : 'Shown as a badge on the edge and as a comment in the generated script.'}
        </span>
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
