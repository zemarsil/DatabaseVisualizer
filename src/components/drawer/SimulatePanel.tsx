import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Dices, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { Column, Table } from '@shared/types';
import { useStore } from '@/store/useStore';
import { SIMULATION_SPEEDS, useSimulation } from '@/store/useSimulation';
import { rowsAtStage, simulationTargets, type SimRow, type SimulationResult, type SimulationStage } from '@/lib/simulate/engine';
import { formatValue, isNumericString, type Value } from '@/lib/simulate/expression';
import '@/styles/simulate.css';

/** Parse what the user typed into a cell: numbers stay numbers, NULL is null, the rest is text. */
function parseCell(text: string): Value {
  const t = text.trim();
  if (t === '' || /^null$/i.test(t)) return null;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (isNumericString(t)) return Number(t);
  return text;
}

function Cell({ value, editable, edited, onCommit }: { value: Value; editable: boolean; edited: boolean; onCommit: (v: Value) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);
  if (editing) {
    return (
      <td>
        <input
          ref={ref}
          className="simulate__cell-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onCommit(parseCell(draft));
              setEditing(false);
            } else if (e.key === 'Escape') setEditing(false);
            e.stopPropagation();
          }}
          spellCheck={false}
        />
      </td>
    );
  }
  const text = formatValue(value);
  return (
    <td
      className={`${editable ? 'simulate__cell--editable' : ''}${edited ? ' simulate__cell--edited' : ''}`}
      title={editable ? `${text}\nDouble-click to change this value and watch it flow` : text}
      onDoubleClick={
        editable
          ? (e) => {
              e.stopPropagation();
              setDraft(value === null ? '' : String(value));
              setEditing(true);
            }
          : undefined
      }
    >
      {value === null ? <span className="simulate__null">NULL</span> : text.length > 80 ? `${text.slice(0, 80)}…` : text}
    </td>
  );
}

interface GridProps {
  table: Table;
  rows: SimRow[];
  /** Rows beyond this index have not "arrived" yet. */
  visible: number;
  /** Source rows that fed at least one output row of the stage. */
  fed?: Set<number>;
  /** Rows the filter dropped (every row that is neither fed nor pending). */
  dimSkipped?: boolean;
  /** Rows to emphasise: the lineage of the picked output row. */
  highlight?: Set<number>;
  picked?: number | null;
  readColumns?: Set<string>;
  writtenColumns?: Set<string>;
  editable?: boolean;
  edits?: Record<number, Record<string, Value>>;
  onEdit?: (row: number, column: Column, value: Value) => void;
  onPick?: (row: number) => void;
  /** Rows at or after this index were produced by the stage being looked at, and get a flash. */
  newFrom?: number;
  emptyText: string;
  /** Cap on rows rendered; the header says how many there are. */
  limit?: number;
}

function Grid({ table, rows, visible, fed, dimSkipped, highlight, picked, readColumns, writtenColumns, editable, edits, onEdit, onPick, newFrom, emptyText, limit = 200 }: GridProps) {
  const shown = rows.slice(0, Math.min(visible, limit));
  return (
    <div className="simulate__grid">
      {shown.length === 0 ? (
        <div className="simulate__empty">{emptyText}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="simulate__rownum">#</th>
              {table.columns.map((c) => (
                <th key={c.id} className={readColumns?.has(c.id) ? 'simulate__col--read' : writtenColumns?.has(c.id) ? 'simulate__col--written' : undefined} title={`${c.name} · ${c.type}`}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => {
              const classes: string[] = [];
              if (onPick) classes.push('simulate__row--pickable');
              if (picked === i) classes.push('simulate__row--picked');
              else if (highlight?.has(i)) classes.push('simulate__row--fed');
              else if (dimSkipped && fed && !fed.has(i)) classes.push('simulate__row--skipped');
              if (newFrom !== undefined && i >= newFrom) classes.push('simulate__row--new');
              return (
                <tr key={i} className={classes.join(' ') || undefined} onClick={onPick ? () => onPick(i) : undefined}>
                  <td className="simulate__rownum">{i + 1}</td>
                  {table.columns.map((c) => (
                    <Cell key={c.id} value={row[c.id] ?? null} editable={Boolean(editable)} edited={Boolean(edits?.[i] && c.id in edits[i])} onCommit={(v) => onEdit?.(i, c, v)} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function stageStatus(stage: SimulationStage, current: number): 'done' | 'active' | 'pending' {
  return stage.index < current ? 'done' : stage.index === current ? 'active' : 'pending';
}

/** The pair of tables the right-hand side shows: the stage in play, or the first one before anything has run. */
function shownStage(result: SimulationResult, stage: number): SimulationStage | null {
  if (!result.stages.length) return null;
  return result.stages[Math.max(0, Math.min(result.stages.length - 1, stage))];
}

export function SimulatePanel() {
  const diagram = useStore((s) => s.diagram);
  const selectedTableIds = useStore((s) => s.selection.tableIds);
  const sim = useSimulation();
  const { result, stage, playing } = sim;

  const targets = useMemo(() => simulationTargets(diagram).sort((a, b) => a.name.localeCompare(b.name)), [diagram]);
  const tableById = useMemo(() => new Map(diagram.tables.map((t) => [t.id, t])), [diagram.tables]);
  const target = sim.targetId ? tableById.get(sim.targetId) : undefined;

  const current = result ? shownStage(result, stage) : null;
  const src = current ? tableById.get(current.sourceTableId) : undefined;
  const tgt = current ? tableById.get(current.targetTableId) : undefined;
  const ran = current !== null && stage >= current.index;
  const pickedOrigin = result && sim.picked && tgt && sim.picked.tableId === tgt.id ? result.origins[tgt.id]?.[sim.picked.row] : undefined;
  const lineage = useMemo(() => new Set(pickedOrigin?.sourceRows ?? []), [pickedOrigin]);
  const fed = useMemo(() => new Set(current?.matchedRows ?? []), [current]);
  const readColumns = useMemo(() => new Set(current?.reads.filter((r) => r.tableId === current.sourceTableId).map((r) => r.columnId) ?? []), [current]);
  const writtenColumns = useMemo(() => new Set(current?.writes ?? []), [current]);
  const lookups = current?.lookupTableIds.map((id) => tableById.get(id)?.name ?? '?') ?? [];
  const allWarnings = result ? [...result.warnings, ...result.stages.flatMap((s) => s.warnings.map((w) => `${s.label}: ${w}`))] : [];
  const overrideCount = Object.values(sim.overrides).reduce((n, rows) => n + Object.values(rows).reduce((m, cells) => m + Object.keys(cells).length, 0), 0);

  // A table picked on the canvas that a flow feeds is the natural default.
  const defaultTarget = targets.find((t) => selectedTableIds.includes(t.id)) ?? targets[0];

  const onTargetChange = (id: string) => {
    if (!id) sim.stop();
    else sim.start(id, { play: false });
  };

  return (
    <div className="drawer__split simulate">
      <div className="drawer__col">
        <h3>Simulate data flow</h3>
        <div className="simulate__controls">
          <span className="small muted">Into</span>
          <select className="select select--sm" value={sim.targetId ?? ''} onChange={(e) => onTargetChange(e.target.value)}>
            <option value="">— pick a table a flow feeds —</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {!result && defaultTarget && (
            <button className="btn btn--sm btn--primary" onClick={() => sim.start(defaultTarget.id)}>
              <Play /> Simulate into {defaultTarget.name}
            </button>
          )}
          {result && (
            <>
              <button className="btn btn--sm btn--icon" title="Back one stage" disabled={stage <= -1} onClick={() => sim.step(-1)}>
                <ChevronLeft />
              </button>
              <button className={`btn btn--sm${playing ? ' btn--active' : ' btn--primary'}`} onClick={() => (playing ? sim.pause() : sim.play())} disabled={!result.stages.length}>
                {playing ? <Pause /> : <Play />} {playing ? 'Pause' : stage >= result.stages.length - 1 ? 'Replay' : 'Play'}
              </button>
              <button className="btn btn--sm btn--icon" title="Forward one stage" disabled={stage >= result.stages.length - 1} onClick={() => sim.step(1)}>
                <ChevronRight />
              </button>
              <button className="btn btn--sm btn--icon btn--ghost" title="Restart from the raw inputs" onClick={() => sim.restart()}>
                <RotateCcw />
              </button>
              <select className="select select--sm" value={sim.speedMs} onChange={(e) => sim.setSpeed(Number(e.target.value))} title="Playback speed" style={{ width: 'auto' }}>
                {SIMULATION_SPEEDS.map((s) => (
                  <option key={s.ms} value={s.ms}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="simulate__progress">
                stage {Math.max(0, stage + 1)} / {result.stages.length}
              </span>
              <span className="grow" />
              <button className="btn btn--sm btn--ghost" onClick={() => sim.stop()} title="Leave simulation mode (Esc)">
                <X /> Exit
              </button>
            </>
          )}
        </div>
        {result && (
          <div className="simulate__controls">
            <label className="row small" style={{ gap: 6 }}>
              Rows per input
              <input className="input input--sm" type="number" min={0} max={500} value={sim.rows} onChange={(e) => sim.setRows(Number(e.target.value))} style={{ width: 64 }} />
            </label>
            <label className="row small" style={{ gap: 6 }}>
              Seed
              <input className="input input--sm" type="number" min={0} value={sim.seed} onChange={(e) => sim.setSeed(Number(e.target.value))} style={{ width: 84 }} />
            </label>
            <button className="btn btn--sm" onClick={() => sim.reshuffle()} title="Different sample rows">
              <Dices /> Reshuffle
            </button>
            {overrideCount > 0 && (
              <button className="btn btn--sm btn--ghost" onClick={() => sim.clearOverrides()} title="Forget the cells you edited">
                Reset {overrideCount} edited cell{overrideCount === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}
        {!result && (
          <div className="small muted" style={{ lineHeight: 1.5 }}>
            {targets.length
              ? 'Pick the table you want to see fed. Every data flow upstream of it runs once over sample rows, one stage at a time: the rows move along the connections on the canvas, and here you can follow each value back to the rows it came from.'
              : 'Nothing feeds a table yet. Drag from the orange handle in a table header onto another table to draw a data flow, then select the connection and describe its derived columns: what expression fills each column, over which rows, grouped how, in what order.'}
          </div>
        )}
        {result && (
          <>
            <div className="simulate__stages">
              {result.stages.map((s) => {
                const status = stageStatus(s, stage);
                const produced = s.producedRange[1] - s.producedRange[0];
                return (
                  <button key={s.relationshipId} className={`simulate__stage simulate__stage--${status}`} onClick={() => sim.goTo(s.index)} title={s.groups.map((g) => g.summaries.join('\n')).join('\n\n') || 'no derived columns'}>
                    <span className="simulate__stage-no">{s.index + 1}</span>
                    <span className="simulate__stage-label">
                      {s.label}
                      <span className="simulate__stage-sub">
                        {s.groups.length
                          ? s.groups.map((g) => `${g.aggregated ? 'group and aggregate' : 'row by row'}${g.filter ? ` WHERE ${g.filter}` : ''}`).join(' · ')
                          : 'no derived columns'}
                        {s.lookupTableIds.length ? ` · reads ${s.lookupTableIds.map((id) => tableById.get(id)?.name ?? '?').join(', ')}` : ''}
                      </span>
                    </span>
                    <span className="simulate__stage-count">
                      {s.matchedRows.length} → <strong>{produced}</strong>
                    </span>
                  </button>
                );
              })}
            </div>
            {allWarnings.length > 0 && (
              <ul className="msg-list" style={{ marginTop: 0 }}>
                {allWarnings.map((w, i) => (
                  <li key={i} className="warn">
                    <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <div className="simulate__legend" style={{ marginTop: 6 }}>
              <span className="legend-read">column read</span>
              <span className="legend-written">column written</span>
              <span className="legend-fed">row that fed the picked output</span>
              <span className="legend-skipped">row the filter dropped</span>
            </div>
          </>
        )}
      </div>

      <div className="drawer__col simulate__right">
        {result && current && src && tgt ? (
          <>
            <div className="simulate__grid-head">
              <strong>{src.name}</strong>
              <span className="muted">
                {result.roles[src.id] === 'input' ? 'raw input' : 'derived'} · {rowsAtStage(result, src.id, Math.max(stage, current.index - 1))} rows
                {ran ? `, ${current.matchedRows.length} fed the flow` : ''}
                {lookups.length ? ` · also reads ${lookups.join(', ')} through foreign keys` : ''}
              </span>
              {result.roles[src.id] === 'input' && <span className="faint small">double-click a cell to change it</span>}
            </div>
            <Grid
              table={src}
              rows={result.rows[src.id] ?? []}
              visible={rowsAtStage(result, src.id, Math.max(stage, current.index - 1))}
              fed={fed}
              dimSkipped={ran}
              highlight={lineage}
              readColumns={ran ? readColumns : undefined}
              editable={result.roles[src.id] === 'input'}
              edits={sim.overrides[src.id]}
              onEdit={(row, column, value) => sim.setOverride(src.id, row, column.id, value)}
              emptyText={`${src.name} has no rows.`}
            />
            <div className="simulate__grid-head">
              <strong>{tgt.name}</strong>
              <span className="muted">
                {ran ? `${rowsAtStage(result, tgt.id, stage)} rows` : 'nothing has arrived yet'}
                {ran && tgt.id === result.targetId ? ' · this is the table you asked about' : ''}
              </span>
              {ran && current.producedRange[1] > current.producedRange[0] && <span className="faint small">click a row to see where it came from</span>}
            </div>
            <Grid
              table={tgt}
              rows={result.rows[tgt.id] ?? []}
              visible={ran ? rowsAtStage(result, tgt.id, stage) : 0}
              writtenColumns={ran ? writtenColumns : undefined}
              picked={sim.picked?.tableId === tgt.id ? sim.picked.row : null}
              onPick={(row) => sim.pick(sim.picked?.row === row && sim.picked.tableId === tgt.id ? null : { tableId: tgt.id, row })}
              newFrom={ran && stage === current.index ? current.producedRange[0] : undefined}
              emptyText={ran ? `${current.label} produced no rows: ${current.groups.some((g) => g.matched.length === 0) ? 'no source row passed the filter. Try more rows, another seed, or edit a cell above.' : 'check the warnings on the left.'}` : `Press Play, or step forward, to run ${current.label}.`}
            />
            <div>
              {pickedOrigin ? (
                <pre className="simulate__explain">
                  <div className="simulate__explain-title">
                    {tgt.name} row {sim.picked!.row + 1} ← {src.name} row{pickedOrigin.sourceRows.length === 1 ? '' : 's'} {pickedOrigin.sourceRows.map((r) => r + 1).join(', ')}
                  </div>
                  {pickedOrigin.explain.join('\n')}
                </pre>
              ) : (
                <div className="small faint">
                  {ran && (result.rows[tgt.id]?.length ?? 0) > 0 ? 'Pick a row of the lower table to highlight the rows above that produced it and read how each column was computed.' : ''}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="simulate__empty" style={{ alignSelf: 'start' }}>
            {result && target ? `Nothing to show for ${target.name}.` : 'The rows moving through the flow show here.'}
          </div>
        )}
      </div>
    </div>
  );
}
