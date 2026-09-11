import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ClipboardCopy, Code2, Copy, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  PROGRAM_LANGUAGES,
  PROGRAM_ROLES,
  PROGRAM_STEP_OPS,
  programLanguageMeta,
  programStepOpMeta,
  type Program,
  type ProgramStep,
  type ProgramStepOp,
} from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { diagramScope } from '@/lib/sqlScope';
import { describeProgram } from '@/lib/programs';
import { generateProgramCode, programCodeFilename } from '@/lib/code/generate';
import { hasDriver } from '@/lib/code/drivers';
import { SqlEditor } from '@/components/ui/SqlEditor';
import { CodeBlock, CodeEditor } from '@/components/ui/CodeEditor';
import { Swatches } from '../ui/Swatches';
import '@/styles/programs.css';

/**
 * The program editor: what the program is, and the ordered list of what it does.
 *
 * The step list is the substance. Everything else on this panel is a label, so
 * it stays compact at the top and the steps get the room — each one a row you
 * can reorder, pointed at a table and its columns, carrying the SQL it issues
 * and the code around it.
 */
export function ProgramEditor({ program }: { program: Program }) {
  const diagram = useStore((s) => s.diagram);
  const updateProgram = useStore((s) => s.updateProgram);
  const deleteProgram = useStore((s) => s.deleteProgram);
  const duplicateProgram = useStore((s) => s.duplicateProgram);
  const addProgramStep = useStore((s) => s.addProgramStep);
  const toast = useStore((s) => s.toast);
  const activeStepId = useUi((s) => s.activeProgramStepId);
  const [showCode, setShowCode] = useState(false);

  const lang = programLanguageMeta(program.language);
  const starter = useMemo(() => generateProgramCode(diagram, program), [diagram, program]);
  const templated = hasDriver(program.language, diagram.dialect);

  const copyStarter = async () => {
    try {
      await navigator.clipboard.writeText(starter);
      toast('success', `Copied ${programCodeFilename(program)} to the clipboard.`);
    } catch {
      toast('error', 'The clipboard refused the copy; select the code and copy it by hand.');
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
          placeholder="e.g. ingest_worker"
          autoFocus
        />
      </div>

      <div className="row">
        <label className="field grow">
          <span className="field__label">Language</span>
          <select className="select" value={program.language} onChange={(e) => updateProgram(program.id, { language: e.target.value as Program['language'] })}>
            {PROGRAM_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span className="field__label">Runs as</span>
          <select
            className="select"
            value={program.role ?? ''}
            onChange={(e) => updateProgram(program.id, { role: (e.target.value || undefined) as Program['role'] })}
          >
            <option value="">Unspecified</option>
            {PROGRAM_ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field">
        <span className="field__label">Where the code lives</span>
        <input
          className="input input--mono"
          value={program.entrypoint ?? ''}
          onChange={(e) => updateProgram(program.id, { entrypoint: e.target.value || undefined })}
          placeholder="e.g. services/worker/main.py"
        />
      </div>

      <div className="field">
        <span className="field__label">What it is for</span>
        <textarea
          className="textarea"
          rows={2}
          value={program.comment ?? ''}
          onChange={(e) => updateProgram(program.id, { comment: e.target.value || undefined })}
          placeholder="Scores every pending job and writes the result back."
        />
      </div>

      <div className="field">
        <span className="field__label">Color</span>
        <Swatches value={program.color} onPick={(key) => updateProgram(program.id, { color: key })} label="Program colour" />
      </div>

      <div className="divider" />

      <div className="field">
        <span className="field__label">Steps, in order</span>
        <span className="field__hint">{describeProgram(diagram, program)}</span>
      </div>

      <div className="program-steps">
        {program.steps.map((step, i) => (
          <StepRow key={step.id} program={program} step={step} index={i} open={step.id === activeStepId} />
        ))}
        {program.steps.length === 0 && <div className="faint small">Nothing yet. A program is its steps: what it reads, what it works out, what it writes back.</div>}
      </div>

      <div className="row">
        {PROGRAM_STEP_OPS.map((op) => (
          <button key={op.id} className="btn btn--sm" title={op.hint} onClick={() => addProgramStep(program.id, { op: op.id })}>
            <Plus /> {op.label}
          </button>
        ))}
      </div>

      <div className="divider" />

      <div className="field">
        <div className="row">
          <button className="btn btn--sm" onClick={() => setShowCode((v) => !v)} disabled={program.steps.length === 0}>
            <Code2 /> {showCode ? 'Hide' : 'Show'} the {lang.label} starter
          </button>
          <button className="btn btn--sm" onClick={copyStarter} disabled={program.steps.length === 0}>
            <ClipboardCopy /> Copy
          </button>
        </div>
        <span className="field__hint">
          {templated
            ? `Written from the steps above, against ${diagram.dialect}. A starting point, not a finished program: the compute steps come out as stubs.`
            : `No driver template for ${lang.label} on ${diagram.dialect} yet, so the starter is the plan in comments rather than runnable code.`}
        </span>
      </div>

      {showCode && program.steps.length > 0 && <CodeBlock code={starter} language={program.language} className="program-starter" />}

      <div className="divider" />
      <div className="row">
        <button className="btn btn--sm" onClick={() => duplicateProgram(program.id)}>
          <Copy /> Duplicate
        </button>
        <button className="btn btn--danger btn--sm" onClick={() => deleteProgram(program.id)}>
          <Trash2 /> Delete program
        </button>
      </div>
    </div>
  );
}

/** One step: its op, what it touches, and the SQL and code it carries. */
function StepRow({ program, step, index, open }: { program: Program; step: ProgramStep; index: number; open: boolean }) {
  const diagram = useStore((s) => s.diagram);
  const updateProgramStep = useStore((s) => s.updateProgramStep);
  const removeProgramStep = useStore((s) => s.removeProgramStep);
  const moveProgramStep = useStore((s) => s.moveProgramStep);
  const setActiveStep = useUi((s) => s.setActiveProgramStepId);
  const [expanded, setExpanded] = useState(open);
  const scope = useMemo(() => diagramScope(diagram), [diagram]);

  const table = step.tableId ? diagram.tables.find((t) => t.id === step.tableId) : undefined;
  const missing = step.op !== 'compute' && Boolean(step.tableId) && !table;
  const meta = programStepOpMeta(step.op);
  const shown = open || expanded;

  const toggleColumn = (columnId: string) => {
    const next = step.columnIds.includes(columnId) ? step.columnIds.filter((id) => id !== columnId) : [...step.columnIds, columnId];
    updateProgramStep(program.id, step.id, { columnIds: next });
  };

  return (
    <div className={`program-step${shown ? ' program-step--open' : ''}${missing ? ' program-step--missing' : ''}`}>
      <div className="program-step__head">
        <span className="program-step__num">{index + 1}</span>
        <select
          className="select select--sm"
          value={step.op}
          onChange={(e) => updateProgramStep(program.id, step.id, { op: e.target.value as ProgramStepOp })}
          title={meta.hint}
        >
          {PROGRAM_STEP_OPS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        {step.op !== 'compute' && (
          <select
            className="select select--sm"
            value={step.tableId ?? ''}
            onChange={(e) => updateProgramStep(program.id, step.id, { tableId: e.target.value || undefined, columnIds: [] })}
          >
            <option value="">Pick a table…</option>
            {diagram.tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {step.op === 'compute' && (
          <input
            className="input input--sm"
            value={step.note ?? ''}
            onChange={(e) => updateProgramStep(program.id, step.id, { note: e.target.value || undefined })}
            placeholder="what happens here"
          />
        )}

        <span className="grow" />
        {missing && <TriangleAlert size={13} className="program-step__warn" />}
        <button
          className="btn btn--sm btn--icon btn--ghost"
          title="Move earlier"
          disabled={index === 0}
          onClick={() => moveProgramStep(program.id, step.id, -1)}
        >
          <ArrowUp />
        </button>
        <button
          className="btn btn--sm btn--icon btn--ghost"
          title="Move later"
          disabled={index === program.steps.length - 1}
          onClick={() => moveProgramStep(program.id, step.id, 1)}
        >
          <ArrowDown />
        </button>
        <button
          className="btn btn--sm btn--icon btn--ghost"
          title={shown ? 'Collapse' : 'Expand'}
          onClick={() => {
            setExpanded((v) => !v);
            setActiveStep(shown ? null : step.id);
          }}
        >
          {shown ? '−' : '+'}
        </button>
        <button className="btn btn--sm btn--icon btn--ghost" title="Remove step" onClick={() => removeProgramStep(program.id, step.id)}>
          <Trash2 />
        </button>
      </div>

      {missing && <div className="program-step__alert">This step names a table that is no longer in the diagram. Point it at another one, or remove the step.</div>}

      {shown && (
        <div className="program-step__body">
          {step.op !== 'compute' && table && (
            <div className="field">
              <span className="field__label">Columns it touches</span>
              <div className="chip-list">
                {table.columns.map((c) => (
                  <button
                    key={c.id}
                    className={`chip${step.columnIds.includes(c.id) ? ' chip--on' : ''}`}
                    onClick={() => toggleColumn(c.id)}
                    title={`${c.name} ${c.type}`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <span className="field__hint">{step.columnIds.length === 0 ? 'None picked, so this step means the whole row.' : `${step.columnIds.length} of ${table.columns.length}.`}</span>
            </div>
          )}

          {step.op !== 'compute' && (
            <div className="field">
              <span className="field__label">The statement it runs</span>
              <SqlEditor
                value={step.sql ?? ''}
                onChange={(v) => updateProgramStep(program.id, step.id, { sql: v || undefined })}
                scope={scope}
                mode="statement"
                rows={3}
                expandable
                title={`Step ${index + 1} of ${program.name}`}
                placeholder={step.op === 'read' ? 'SELECT … FROM …' : 'INSERT INTO … / UPDATE …'}
                ariaLabel="Step SQL"
              />
              <span className="field__hint">Leave it empty and the generated starter writes one from the table and columns above.</span>
            </div>
          )}

          {step.op !== 'compute' && (
            <div className="field">
              <span className="field__label">Note</span>
              <input
                className="input input--sm"
                value={step.note ?? ''}
                onChange={(e) => updateProgramStep(program.id, step.id, { note: e.target.value || undefined })}
                placeholder="why this step exists"
              />
            </div>
          )}

          <div className="field">
            <span className="field__label">Code</span>
            <CodeEditor
              value={step.code ?? ''}
              onChange={(v) => updateProgramStep(program.id, step.id, { code: v || undefined })}
              language={program.language}
              rows={5}
              placeholder={step.op === 'compute' ? 'The part the database never sees.' : 'The code around this statement.'}
              ariaLabel="Step code"
            />
          </div>
        </div>
      )}
    </div>
  );
}
