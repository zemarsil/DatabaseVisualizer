import { useMemo, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, ClipboardCopy, Code2, Copy, Plus, ScanSearch, Trash2, WandSparkles } from 'lucide-react';
import { PROCEDURE_PARAM_MODES, PROGRAM_STEP_OPS, engineName, programStepOpMeta, stepOpsForKind, type Program, type ProcedureParam, type ProcedureParamMode } from '@shared/types';
import { selectDiagramContent, useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { diagramScope } from '@/lib/sqlScope';
import { describeProgram } from '@/lib/programs';
import { callersOf, codePath } from '@/lib/codemap';
import { bodyFromSteps, createProcedureParam, dialectHasProcedures, isStoredFunction, stepsFromBody } from '@/lib/procedures';
import { pasteRoutineInto } from '@/lib/canvasActions';
import { generateProcedureSql } from '@/lib/sql/generator';
import { TYPE_SUGGESTIONS } from '@/lib/sql/dialect';
import { SqlCode, SqlEditor } from '@/components/ui/SqlEditor';
import { confirmDialog } from '@/components/ui/Modal';
import { Swatches } from '../ui/Swatches';
import { StepRow } from './ProgramEditor';
import '@/styles/programs.css';

/**
 * The editor for a stored procedure or function.
 *
 * Laid out the way a CREATE statement reads — name, parameters, what it
 * returns, then what it does — with the two descriptions of what it does side
 * by side: the steps, which the canvas draws, and the body, which the engine
 * runs. Either can be written from the other. A body left empty is written
 * from the steps when the script is generated, and "Detect steps" reads the
 * steps back out of a body someone typed or imported, which is the same thing
 * "Detect from SQL" does for a view.
 */
export function ProcedureEditor({ program }: { program: Program }) {
  const diagram = useStore(selectDiagramContent);
  const updateProgram = useStore((s) => s.updateProgram);
  const deleteProgram = useStore((s) => s.deleteProgram);
  const duplicateProgram = useStore((s) => s.duplicateProgram);
  const addProgramStep = useStore((s) => s.addProgramStep);
  const setCodeCollapsed = useStore((s) => s.setCodeCollapsed);
  const setProgramSteps = useStore((s) => s.setProgramSteps);
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const toast = useStore((s) => s.toast);
  const activeStepId = useUi((s) => s.activeProgramStepId);
  const [showSql, setShowSql] = useState(false);

  const dialect = diagram.dialect;
  const supported = dialectHasProcedures(dialect);
  const fn = isStoredFunction(program);
  const scope = useMemo(() => diagramScope(diagram), [diagram]);
  const params = program.params ?? [];
  const callers = useMemo(() => callersOf(diagram, program.id), [diagram, program.id]);
  const written = useMemo(() => bodyFromSteps(diagram, program), [diagram, program]);
  const ddl = useMemo(() => (showSql ? generateProcedureSql(diagram, program.id) : null), [showSql, diagram, program.id]);
  const noTables = diagram.tables.length === 0;

  const setParams = (next: ProcedureParam[]) => updateProgram(program.id, { params: next.length ? next : undefined });
  const patchParam = (id: string, patch: Partial<ProcedureParam>) => setParams(params.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  /** Read the steps out of the body. Replacing hand-drawn steps asks first, since their notes would go with them. */
  const detectSteps = async () => {
    const body = program.body?.trim() ?? '';
    if (!body) return;
    const byName = (name: string) => diagram.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const routine = (name: string) => diagram.programs.find((p) => p.kind === 'procedure' && p.name.toLowerCase() === name.toLowerCase());
    const steps = stepsFromBody(body, byName, routine);
    if (!steps.length) {
      toast('info', 'The body names no table in this diagram and calls no procedure in it, so there are no steps to draw.');
      return;
    }
    if (program.steps.length) {
      const ok = await confirmDialog({
        title: `Replace the ${program.steps.length} step${program.steps.length === 1 ? '' : 's'} of ${program.name}?`,
        message: `The body reads as ${steps.length} step${steps.length === 1 ? '' : 's'}. The current steps, and any notes on them, are replaced. This can be undone with Ctrl+Z.`,
        confirmLabel: 'Replace the steps',
      });
      if (!ok) return;
    }
    setProgramSteps(program.id, steps);
    toast('success', `Drew ${steps.length} step${steps.length === 1 ? '' : 's'} from the body.`);
  };

  /**
   * A whole CREATE [OR REPLACE] PROCEDURE pasted into the body or the name is
   * read into the form: name, parameters, return type, language, and the body
   * alone. Steps are drawn from the body when there are none yet; steps someone
   * already drew are kept, and Detect steps is there to redraw them. Anything
   * that is not a routine the parser can read pastes as plain text.
   */
  const pasteCreate = (text: string): boolean => {
    const r = pasteRoutineInto(program.id, text);
    if (!r) return false;
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const parts = [plural(r.params, 'parameter')];
    if (r.returns) parts.push(`returns ${r.returns}`);
    if (r.steps) parts.push(`${plural(r.steps, 'step')} drawn from the body`);
    const alongside = [r.alongside.tables ? plural(r.alongside.tables, 'table') : '', r.alongside.views ? plural(r.alongside.views, 'view') : '', r.alongside.procedures ? plural(r.alongside.procedures, 'other procedure') : ''].filter(Boolean);
    toast(
      'success',
      `Read ${r.name} from the CREATE statement: ${parts.join(', ')}.${alongside.length ? ` Also imported ${alongside.join(', ')} from the paste.` : ''}${r.keptSteps ? ' Its steps were kept; Detect steps redraws them from the new body.' : ''}`,
    );
    for (const w of r.warnings) toast('info', w);
    return true;
  };

  const onDelete = () => deleteProgram(program.id);

  const copyDdl = async () => {
    const text = generateProcedureSql(diagram, program.id).script;
    try {
      await navigator.clipboard.writeText(text);
      toast('success', `Copied CREATE ${fn ? 'FUNCTION' : 'PROCEDURE'} ${program.name}.`);
    } catch {
      toast('error', 'The clipboard refused the copy; open the preview and copy it by hand.');
    }
  };

  return (
    <div>
      <div className="field">
        <span className="field__label">Name</span>
        <input
          className="input input--mono"
          value={program.name}
          onChange={(e) => updateProgram(program.id, { name: e.target.value })}
          onPaste={(e) => {
            if (pasteCreate(e.clipboardData.getData('text/plain'))) e.preventDefault();
          }}
          placeholder="e.g. archive_orders"
          autoFocus
        />
      </div>

      <div className="row">
        <label className="field grow">
          <span className="field__label">Kind</span>
          <select
            className="select"
            value={fn ? 'function' : 'procedure'}
            onChange={(e) => updateProgram(program.id, { returns: e.target.value === 'function' ? program.returns?.trim() || (dialect === 'mariadb' ? 'INT' : 'integer') : undefined })}
            title="A procedure is run with CALL; a function returns a value and is used inside a query."
          >
            <option value="procedure">Procedure</option>
            <option value="function">Function</option>
          </select>
        </label>
        {dialect !== 'mariadb' && (
          <label className="field grow">
            <span className="field__label">Schema</span>
            <input
              className="input input--mono"
              value={program.schema ?? ''}
              onChange={(e) => updateProgram(program.id, { schema: e.target.value || undefined })}
              placeholder={dialect === 'postgresql' ? 'public' : '(default)'}
            />
          </label>
        )}
      </div>

      <div className="row">
        {fn && (
          <label className="field grow">
            <span className="field__label">Returns</span>
            <input
              className="input input--mono"
              value={program.returns ?? ''}
              onChange={(e) => updateProgram(program.id, { returns: e.target.value })}
              placeholder={dialect === 'mariadb' ? 'DECIMAL(10,2)' : 'numeric / TABLE (id int) / SETOF orders'}
              list="procedure-types"
            />
          </label>
        )}
        {dialect === 'postgresql' && (
          <label className="field grow">
            <span className="field__label">Body language</span>
            <select
              className="select"
              value={program.routineLanguage ?? 'plpgsql'}
              onChange={(e) => updateProgram(program.id, { routineLanguage: e.target.value === 'sql' ? 'sql' : undefined })}
              title="PL/pgSQL has variables, IF and loops, inside BEGIN … END; plain SQL is a list of statements."
            >
              <option value="plpgsql">PL/pgSQL</option>
              <option value="sql">SQL</option>
            </select>
          </label>
        )}
      </div>

      {!supported && (
        <div className="field">
          <span className="field__hint">
            {engineName(dialect)} has no stored procedures, so the script writes this one as a comment instead of creating it. Everything here is kept for when the diagram targets
            PostgreSQL or MariaDB.
          </span>
        </div>
      )}

      <div className="field">
        <span className="field__label">What it is for</span>
        <textarea
          className="textarea"
          rows={2}
          value={program.comment ?? ''}
          onChange={(e) => updateProgram(program.id, { comment: e.target.value || undefined })}
          placeholder="Moves orders older than a cutoff into the archive."
        />
      </div>

      <div className="field">
        <span className="field__label">Color</span>
        <Swatches value={program.color} onPick={(key) => updateProgram(program.id, { color: key })} label="Procedure colour" />
      </div>

      <div className="divider" />

      <div className="section">
        <div className="section__head">
          <span className="section__title">Parameters ({params.length})</span>
          <button className="btn btn--sm" onClick={() => setParams([...params, createProcedureParam({ name: `p_${params.length + 1}`, type: dialect === 'mariadb' ? 'INT' : 'integer' })])}>
            <Plus /> Parameter
          </button>
        </div>
        {params.length === 0 && <div className="faint small">None. Add one for each value a caller passes in{fn ? '' : ', or gets back through OUT'}.</div>}
        {params.map((x, i) => (
          <div key={x.id} className="procedure-param">
            <select
              className="select select--sm procedure-param__mode"
              value={x.mode ?? 'in'}
              onChange={(e) => patchParam(x.id, { mode: e.target.value === 'in' ? undefined : (e.target.value as ProcedureParamMode) })}
              title="IN: passed in. OUT: handed back. INOUT: both."
              aria-label={`Mode of parameter ${i + 1}`}
            >
              {PROCEDURE_PARAM_MODES.map((m) => (
                <option key={m} value={m}>
                  {m.toUpperCase()}
                </option>
              ))}
            </select>
            <input className="input input--sm input--mono grow" value={x.name} onChange={(e) => patchParam(x.id, { name: e.target.value })} placeholder="name" aria-label={`Name of parameter ${i + 1}`} />
            <input
              className="input input--sm input--mono grow"
              value={x.type}
              onChange={(e) => patchParam(x.id, { type: e.target.value })}
              placeholder="type"
              list="procedure-types"
              aria-label={`Type of parameter ${i + 1}`}
            />
            {dialect === 'postgresql' && (
              <input
                className="input input--sm input--mono procedure-param__default"
                value={x.defaultValue ?? ''}
                onChange={(e) => patchParam(x.id, { defaultValue: e.target.value || undefined })}
                placeholder="default"
                aria-label={`Default of parameter ${i + 1}`}
              />
            )}
            <button className="btn btn--sm btn--icon btn--ghost" title="Remove parameter" onClick={() => setParams(params.filter((y) => y.id !== x.id))}>
              <Trash2 />
            </button>
          </div>
        ))}
        <datalist id="procedure-types">
          {TYPE_SUGGESTIONS[dialect].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>

      {callers.length > 0 && (
        <div className="field">
          <span className="field__label">Called from</span>
          <div className="chip-list">
            {callers.map((c) => (
              <button
                key={c.id}
                className="chip"
                title={codePath(diagram, c)}
                onClick={() => {
                  setSelection({ programIds: [c.id], tableIds: [], noteIds: [], relationshipId: null, groupId: null });
                  focusTable(c.id);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="divider" />

      <div className="field">
        <div className="section__head">
          <span className="field__label">Steps, in order</span>
          {program.steps.length > 0 && (
            <button className="btn btn--sm" onClick={() => setCodeCollapsed([program.id], !program.collapsed)} title={program.collapsed ? 'Draw the step rows on the canvas again' : 'Fold the step rows on the canvas into the header; arrows leave the header'}>
              {program.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} {program.collapsed ? 'Expand' : 'Collapse'}
            </button>
          )}
        </div>
        <span className="field__hint">{describeProgram(diagram, program)}</span>
      </div>
      <div className="program-steps">
        {program.steps.map((step, i) => (
          <StepRow key={step.id} program={program} step={step} index={i} open={step.id === activeStepId} />
        ))}
        {program.steps.length === 0 && (
          <div className="faint small">Nothing yet. A procedure is its steps: what it reads, what it works out, what it writes back — or write the body below and detect them from it.</div>
        )}
      </div>
      <div className="row row--wrap">
        {PROGRAM_STEP_OPS.filter((op) => stepOpsForKind('procedure').includes(op.id) && !(programStepOpMeta(op.id).touchesDatabase && noTables)).map((op) => (
          <button key={op.id} className="btn btn--sm" title={op.id === 'compute' ? 'Procedural work: variables, conditions, loops.' : op.id === 'call' ? 'Calls another procedure or function.' : op.hint} onClick={() => addProgramStep(program.id, { op: op.id })}>
            <Plus /> {op.label}
          </button>
        ))}
      </div>

      <div className="divider" />

      <div className="field">
        <span className="field__label">Body</span>
        <SqlEditor
          value={program.body ?? ''}
          onChange={(v) => updateProgram(program.id, { body: v.trim() ? v : undefined })}
          onPaste={pasteCreate}
          scope={scope}
          mode="statement"
          rows={8}
          expandable
          title={`Body of ${program.name}`}
          placeholder={written}
          ariaLabel="Procedure body"
          actions={
            <>
              <button className="btn btn--sm" onClick={() => void detectSteps()} disabled={!program.body?.trim()} title="Read the tables this body reads and writes, and the procedures it calls, into the steps above">
                <ScanSearch /> Detect steps
              </button>
              <button
                className="btn btn--sm"
                onClick={() => updateProgram(program.id, { body: written })}
                disabled={program.steps.length === 0 || Boolean(program.body?.trim())}
                title="Write a body from the steps above, to start from"
              >
                <WandSparkles /> From steps
              </button>
            </>
          }
        />
        <span className="field__hint">
          {program.body?.trim()
            ? dialect === 'postgresql'
              ? `What goes between the dollar quotes${(program.routineLanguage ?? 'plpgsql') === 'plpgsql' ? ': a BEGIN … END; block, with DECLARE above it for variables' : ''}. It is used exactly as written.`
              : dialect === 'mariadb'
                ? 'The routine body, usually one BEGIN … END compound statement. It is used exactly as written.'
                : 'Kept exactly as written, for when the diagram targets an engine with procedures.'
            : 'Empty: the script writes the body from the steps above, which is the grey text in the box. Type over it, use From steps to start from it, or paste a whole CREATE PROCEDURE to fill in everything at once.'}
        </span>
      </div>

      <div className="divider" />

      <div className="field">
        <div className="row">
          <button className="btn btn--sm" onClick={() => setShowSql((v) => !v)}>
            <Code2 /> {showSql ? 'Hide' : 'Show'} the CREATE {fn ? 'FUNCTION' : 'PROCEDURE'}
          </button>
          <button className="btn btn--sm" onClick={() => void copyDdl()}>
            <ClipboardCopy /> Copy
          </button>
        </div>
        {ddl && (
          <>
            <SqlCode sql={ddl.script} scope={scope} style={{ maxHeight: 320 }} />
            {ddl.warnings.map((w) => (
              <span key={w} className="field__hint">
                {w}
              </span>
            ))}
          </>
        )}
      </div>

      <div className="divider" />
      <div className="row row--wrap">
        <button className="btn btn--sm" onClick={() => duplicateProgram(program.id)}>
          <Copy /> Duplicate
        </button>
        <button className="btn btn--danger btn--sm" onClick={onDelete}>
          <Trash2 /> Delete {fn ? 'function' : 'procedure'}
        </button>
      </div>
    </div>
  );
}
