import { useMemo, useState } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronRight, CopyPlus, Play, Plus, Trash2, Wand2 } from 'lucide-react';
import {
  AGGREGATE_FUNCTIONS,
  REFERENTIAL_ACTIONS,
  WINDOW_FUNCTIONS,
  windowMeta,
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
  type Table,
  type WindowFunction,
} from '@shared/types';
import { columnNameKey, derivationSummary, matchColumnsByName } from '@/lib/derivation';
import { createDerivation, relationshipKindPatch } from '@/lib/model';
import { generateFlowSql } from '@/lib/sql/generator';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { useSimulation } from '@/store/useSimulation';

/** "a, b, c and 2 more": enough of a list to recognise without filling the panel. */
function listNames(names: string[], max = 4): string {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

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

/**
 * Columns an expression on `src` may name: its own, and those of every table it
 * reaches through foreign keys (child -> parent, a few hops), written table.column.
 */
function reachableColumns(tables: Table[], relationships: Relationship[], src: Table): { table: Table; via: string }[] {
  const out: { table: Table; via: string }[] = [];
  const seen = new Set<string>([src.id]);
  let frontier: { id: string; via: string }[] = [{ id: src.id, via: '' }];
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const next: { id: string; via: string }[] = [];
    for (const { id, via } of frontier) {
      const from = tables.find((t) => t.id === id);
      for (const fk of relationships) {
        if (fk.kind !== 'fk' || fk.sourceTableId !== id || seen.has(fk.targetTableId)) continue;
        const parent = tables.find((t) => t.id === fk.targetTableId);
        if (!parent) continue;
        seen.add(parent.id);
        const col = from?.columns.find((c) => c.id === fk.sourceColumnIds[0])?.name ?? '?';
        const path = via ? `${via} → ${from?.name ?? '?'}.${col}` : `${from?.name ?? '?'}.${col}`;
        out.push({ table: parent, via: path });
        next.push({ id: parent.id, via: path });
      }
    }
    frontier = next;
  }
  return out;
}

/** Chips for every column an expression may use; clicking one appends it to the expression. */
function ReferenceChips({ src, reachable, onInsert }: { src: Table; reachable: { table: Table; via: string }[]; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="field field--tight">
      <button className="btn btn--sm btn--ghost" style={{ justifyContent: 'flex-start', padding: '0 4px' }} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown /> : <ChevronRight />} Columns you can use{reachable.length ? ` (${src.name} and ${reachable.length} table${reachable.length === 1 ? '' : 's'} it points at)` : ''}
      </button>
      {open && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="chip-list">
            {src.columns.map((c) => (
              <button key={c.id} className="chip" title={`${c.type} — click to add to the expression`} onClick={() => onInsert(c.name)}>
                {c.name}
              </button>
            ))}
          </div>
          {reachable.map(({ table, via }) => (
            <div key={table.id}>
              <div className="faint small" style={{ margin: '2px 0' }}>
                {table.name} · through {via}
              </div>
              <div className="chip-list">
                {table.columns.map((c) => (
                  <button key={c.id} className="chip" title={`${c.type} — looked up through the foreign key; click to add`} onClick={() => onInsert(`${table.name}.${c.name}`)}>
                    {table.name}.{c.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <span className="field__hint">
            Write SQL: arithmetic, comparisons, AND / OR, CASE, CAST, and functions such as COALESCE, ROUND, UPPER, DATE. A column of another table is
            looked up through the foreign keys shown, so the diagram says how the tables combine.
          </span>
        </div>
      )}
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
  const fillFlowByName = useStore((s) => s.fillFlowByName);
  const copyFlowToTables = useStore((s) => s.copyFlowToTables);
  const toast = useStore((s) => s.toast);
  /** Tables ticked in "Feed other tables the same way", cleared once they are drawn. */
  const [feedPicks, setFeedPicks] = useState<string[]>([]);

  const flowSql = useMemo(() => (r.kind === 'flow' ? generateFlowSql(diagram, r.id) : ''), [diagram, r.id, r.kind]);
  const simulatingThis = useSimulation((s) => s.targetId === r.targetTableId);

  const src = tables.find((t) => t.id === r.sourceTableId);
  const tgt = tables.find((t) => t.id === r.targetTableId);
  const reachable = useMemo(() => (src && r.kind === 'flow' ? reachableColumns(tables, diagram.relationships, src) : []), [tables, diagram.relationships, src, r.kind]);

  // Target columns a source column of the same name could fill outright, and
  // the other tables this flow could be repeated onto. Both are the answer to
  // "one table feeds five that look alike": neither should be typed out by hand.
  const nameMatches = useMemo(
    () => (r.kind === 'flow' && src && tgt && src.id !== tgt.id ? matchColumnsByName(src.columns, tgt.columns, r.derivations ?? []) : []),
    [r.kind, r.derivations, src, tgt],
  );
  const feedCandidates = useMemo(() => {
    if (r.kind !== 'flow' || !src || !tgt) return [];
    const wanted = (r.derivations ?? [])
      .map((dv) => tgt.columns.find((c) => c.id === dv.targetColumnId)?.name)
      .filter((name): name is string => Boolean(name))
      .map(columnNameKey);
    if (wanted.length === 0) return [];
    const fed = new Set(diagram.relationships.filter((x) => x.kind === 'flow' && x.sourceTableId === src.id).map((x) => x.targetTableId));
    return tables
      .filter((t) => t.id !== src.id && !fed.has(t.id))
      .map((t) => {
        const keys = new Set(t.columns.map((c) => columnNameKey(c.name)));
        return { table: t, matches: wanted.filter((k) => keys.has(k)).length, of: wanted.length };
      })
      .filter((c) => c.matches > 0)
      .sort((a, b) => b.matches - a.matches || a.table.name.localeCompare(b.table.name));
  }, [r.kind, r.derivations, src, tgt, tables, diagram.relationships]);

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
  const setWindow = (dv: Derivation, fn: WindowFunction | '') => {
    if (!fn) {
      const { window: _w, ...rest } = dv;
      setDerivations(derivations.map((x) => (x.id === dv.id ? rest : x)));
      return;
    }
    // Keep the ordering when only the function changes; a fresh window orders by the expression's column, or the first column.
    const orderBy = dv.window?.orderBy.length ? dv.window.orderBy : [src.columns.find((c) => c.name === dv.expression.trim())?.name ?? src.columns[0]?.name ?? ''].filter(Boolean);
    updateDerivation(dv.id, { window: { fn, orderBy, partitionBy: dv.window?.partitionBy ?? [] } });
  };
  const appendToExpression = (dv: Derivation, text: string) => {
    const cur = dv.expression;
    updateDerivation(dv.id, { expression: cur && !/[\s(]$/.test(cur) ? `${cur} ${text}` : `${cur}${text}` });
  };
  /** Fill every still-unmapped target column that a source column of the same name can fill. */
  const matchByName = () => {
    const n = fillFlowByName(r.id);
    if (n > 0) toast('success', `Filled ${n} column${n === 1 ? '' : 's'} of ${tgt.name} from ${src.name}.`);
  };
  const feedPicked = () => {
    const wanted = feedPicks.filter((id) => feedCandidates.some((c) => c.table.id === id));
    const made = copyFlowToTables(r.id, wanted);
    setFeedPicks([]);
    if (made.length > 0) toast('success', `Drew ${made.length} more flow${made.length === 1 ? '' : 's'} out of ${src.name}.`);
    else toast('info', `Nothing to draw: ${src.name} already feeds those tables.`);
  };
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

      <div className="field">
        <span className="field__label">Reverse label</span>
        <input
          className="input input--sm"
          value={r.inverseName ?? ''}
          onChange={(e) => patch({ inverseName: e.target.value || undefined })}
          placeholder={verb.inverse}
          spellCheck={false}
        />
        <span className="field__hint">
          Shown on the {tgt.name} end of the edge, reading {tgt.name} → {src.name}. Empty uses the verb's “{verb.inverse}”.
        </span>
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
            <button
              className={`btn btn--sm${simulatingThis ? ' btn--active' : ''}`}
              title={simulatingThis ? 'Stop simulating' : `Watch sample rows flow from ${src.name} into ${tgt.name}`}
              disabled={derivations.length === 0 && !simulatingThis}
              onClick={() => (simulatingThis ? useSimulation.getState().stop() : useSimulation.getState().start(tgt.id))}
            >
              <Play /> {simulatingThis ? 'Stop' : 'Simulate'}
            </button>
            <button className="btn btn--sm" onClick={addDerivation} disabled={tgt.columns.length === 0}>
              <Plus /> Add
            </button>
          </div>
          {derivations.length === 0 && (
            <div className="faint small" style={{ marginBottom: 6 }}>
              Say how each column of {tgt.name} is computed from {src.name}: an expression, an aggregate over a grouping, a filter, or a sequence operation
              over rows in order. The app summarises it on the edge, generates the INSERT skeleton, and can simulate the rows moving.
            </div>
          )}
          {nameMatches.length > 0 && (
            <div className="row" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
              <span className="faint small grow">
                {nameMatches.length === 1 ? '1 column' : `${nameMatches.length} columns`} of {tgt.name} ({listNames(nameMatches.map((m) => m.targetColumnName))})
                {nameMatches.length === 1 ? ' matches a column' : ' match columns'} of {src.name} by name.
              </span>
              <button className="btn btn--sm" onClick={matchByName} title={`Add a plain passthrough derivation for each: ${nameMatches.map((m) => `${m.targetColumnName} = ${m.sourceColumnName}`).join(', ')}`}>
                <Wand2 /> Match by name
              </button>
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
                    placeholder={
                      dv.window && !windowMeta(dv.window.fn).needsExpression
                        ? 'not needed for this sequence operation'
                        : dv.aggregate === 'COUNT'
                          ? 'blank for COUNT(*)'
                          : reachable.length
                            ? `e.g. quantity * unit_price_cents, or ${reachable[0].table.name}.${reachable[0].table.columns[0]?.name ?? 'column'}`
                            : 'e.g. quantity * unit_price_cents'
                    }
                    spellCheck={false}
                  />
                </div>
                <ReferenceChips src={src} reachable={reachable} onInsert={(text) => appendToExpression(dv, text)} />

                <div className="field field--tight">
                  <span className="field__label">Sequence (window)</span>
                  <select className="select select--sm" value={dv.window?.fn ?? ''} onChange={(e) => setWindow(dv, e.target.value as WindowFunction | '')} title="Compute the value from neighbouring rows once they are put in order">
                    <option value="">(none: each row on its own)</option>
                    {WINDOW_FUNCTIONS.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                  {dv.window && (
                    <>
                      <span className="field__hint">{windowMeta(dv.window.fn).hint}</span>
                      <span className="field__label" style={{ marginTop: 4 }}>
                        Order by
                      </span>
                      {dv.window.orderBy.map((key, i) => (
                        <GroupByRow
                          key={i}
                          value={key}
                          columns={src.columns}
                          onChange={(v) => updateDerivation(dv.id, { window: { ...dv.window!, orderBy: dv.window!.orderBy.map((g, j) => (j === i ? v : g)) } })}
                          onRemove={() => updateDerivation(dv.id, { window: { ...dv.window!, orderBy: dv.window!.orderBy.filter((_, j) => j !== i) } })}
                        />
                      ))}
                      <div>
                        <button
                          className="btn btn--sm"
                          onClick={() =>
                            updateDerivation(dv.id, { window: { ...dv.window!, orderBy: [...dv.window!.orderBy, src.columns.find((c) => !dv.window!.orderBy.includes(c.name))?.name ?? ''] } })
                          }
                        >
                          <Plus /> Add ordering key
                        </button>
                      </div>
                      <span className="field__hint">Which row counts as "previous": a timestamp, usually. Add DESC after an expression key to reverse it.</span>
                      <span className="field__label" style={{ marginTop: 4 }}>
                        Partition by
                      </span>
                      {dv.window.partitionBy.map((key, i) => (
                        <GroupByRow
                          key={i}
                          value={key}
                          columns={src.columns}
                          onChange={(v) => updateDerivation(dv.id, { window: { ...dv.window!, partitionBy: dv.window!.partitionBy.map((g, j) => (j === i ? v : g)) } })}
                          onRemove={() => updateDerivation(dv.id, { window: { ...dv.window!, partitionBy: dv.window!.partitionBy.filter((_, j) => j !== i) } })}
                        />
                      ))}
                      <div>
                        <button
                          className="btn btn--sm"
                          onClick={() =>
                            updateDerivation(dv.id, { window: { ...dv.window!, partitionBy: [...dv.window!.partitionBy, src.columns.find((c) => !dv.window!.partitionBy.includes(c.name))?.name ?? ''] } })
                          }
                        >
                          <Plus /> Add partition key
                        </button>
                      </div>
                      <span className="field__hint">Optional: restart the sequence for every distinct value, e.g. one series per customer or per sensor.</span>
                    </>
                  )}
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
          {feedCandidates.length > 0 && (
            <div className="field" style={{ marginTop: 8 }}>
              <span className="field__label">Feed other tables the same way</span>
              <div className="chip-list">
                {feedCandidates.map((c) => (
                  <button
                    key={c.table.id}
                    className={`chip${feedPicks.includes(c.table.id) ? ' chip--on' : ''}`}
                    title={`${c.table.name} spells ${c.matches} of the ${c.of} derived column${c.of === 1 ? '' : 's'} the same way`}
                    onClick={() => setFeedPicks((p) => (p.includes(c.table.id) ? p.filter((x) => x !== c.table.id) : [...p, c.table.id]))}
                  >
                    {c.table.name} · {c.matches}/{c.of}
                  </button>
                ))}
              </div>
              <div>
                <button className="btn btn--sm" disabled={feedPicks.length === 0} onClick={feedPicked}>
                  <CopyPlus /> {feedPicks.length === 0 ? 'Draw more flows' : `Draw ${feedPicks.length} more flow${feedPicks.length === 1 ? '' : 's'}`}
                </button>
              </div>
              <span className="field__hint">
                A connection joins two tables, so five targets are five edges. Each ticked table gets its own from {src.name}, carrying these derivations
                re-pointed at the columns it spells the same way; ones it has no column for are dropped. The tagged query is not copied — it names{' '}
                {tgt.name}.
              </span>
            </div>
          )}
          {flowSql && (
            <div className="field" style={{ marginTop: 8 }}>
              <span className="field__label">Generated from these derivations</span>
              <pre className="code-block small">{flowSql}</pre>
              <span className="field__hint">
                A skeleton, not executed. Columns named table.column are joined through the diagram's foreign keys; joins the diagram does not know
                about belong in the tagged query below.
              </span>
            </div>
          )}
        </div>
      )}

      <div className="field">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="field__label">Tagged query</span>
          <button
            className="btn btn--sm btn--ghost"
            disabled={!r.query?.trim()}
            title="Run this query in the Query tab against the connected database"
            onClick={() => {
              useUi.getState().setPendingQuery(r.query ?? '', true);
              useStore.getState().openDrawer('query');
            }}
          >
            <Play /> Run
          </button>
        </div>
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
