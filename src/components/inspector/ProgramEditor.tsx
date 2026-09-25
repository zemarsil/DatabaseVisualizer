import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsDownUp, ChevronsUpDown, ClipboardCopy, Code2, Copy, Crosshair, Plus, Trash2, TriangleAlert, Ungroup } from 'lucide-react';
import {
  CODE_KINDS,
  PROGRAM_LANGUAGES,
  PROGRAM_ROLES,
  PROGRAM_STEP_OPS,
  canContain,
  canStepName,
  codeKindMeta,
  codeKindOf,
  isCodeStepOp,
  isDataNode,
  programLanguageMeta,
  programStepOpMeta,
  stepOpsForKind,
  type CodeKind,
  type Program,
  type ProgramStep,
  type ProgramStepOp,
} from '@shared/types';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';
import { diagramScope } from '@/lib/sqlScope';
import { describeProgram } from '@/lib/programs';
import { callersOf, codeChildren, codeDescendantIds, codePath, wouldNestInItself } from '@/lib/codemap';
import { generateProgramCode, hasStarter, programCodeFilename } from '@/lib/code/generate';
import { hasDriver } from '@/lib/code/drivers';
import { SqlEditor } from '@/components/ui/SqlEditor';
import { CodeBlock, CodeEditor } from '@/components/ui/CodeEditor';
import { confirmDialog } from '@/components/ui/Modal';
import { Swatches } from '../ui/Swatches';
import '@/styles/programs.css';

/**
 * The editor for a code node of any kind: what it is, where it sits, what it
 * holds, and the ordered list of what it does.
 *
 * The step list is the substance. Everything else on this panel is a label, so
 * it stays compact at the top and the steps get the room — each one a row you
 * can reorder, pointed at a table and its columns or at another code node,
 * carrying the SQL it issues and the code around it.
 */
export function ProgramEditor({ program }: { program: Program }) {
  const diagram = useStore((s) => s.diagram);
  const noTables = diagram.tables.length === 0;
  const updateProgram = useStore((s) => s.updateProgram);
  const deleteProgram = useStore((s) => s.deleteProgram);
  const duplicateProgram = useStore((s) => s.duplicateProgram);
  const dissolveCodeNode = useStore((s) => s.dissolveCodeNode);
  const setCodeCollapsed = useStore((s) => s.setCodeCollapsed);
  const addProgram = useStore((s) => s.addProgram);
  const addProgramStep = useStore((s) => s.addProgramStep);
  const setSelection = useStore((s) => s.setSelection);
  const focusTable = useStore((s) => s.focusTable);
  const toast = useStore((s) => s.toast);
  const activeStepId = useUi((s) => s.activeProgramStepId);
  const [showCode, setShowCode] = useState(false);

  const kind = codeKindOf(program);
  const kindMeta = codeKindMeta(kind);
  const lang = programLanguageMeta(program.language);
  // A data file is the one node with nothing to run: no steps, no driver, and
  // a starter that is the file itself rather than a program.
  const isData = isDataNode(program);
  // Only the languages that suit what this node is: a data file is YAML or
  // JSON, and nothing else may be, since a node written in one *is* a data file.
  const languages = useMemo(() => PROGRAM_LANGUAGES.filter((l) => Boolean(l.data) === isData), [isData]);
  const loaders = useMemo(
    () => (isData ? diagram.programs.filter((x) => x.steps.some((st) => st.op === 'load' && st.codeId === program.id)) : []),
    [diagram, program.id, isData],
  );
  const starter = useMemo(() => generateProgramCode(diagram, program), [diagram, program]);
  const templated = hasDriver(program.language, diagram.dialect);
  // A container with no steps of its own still has a starter: the file it
  // stands for, holding what the diagram draws inside it.
  const starterReady = hasStarter(diagram, program);
  const members = useMemo(() => codeChildren(diagram).get(program.id) ?? [], [diagram, program.id]);
  const descendants = useMemo(() => codeDescendantIds(diagram, program.id).length, [diagram, program.id]);
  const callers = useMemo(() => callersOf(diagram, program.id), [diagram, program.id]);
  // Containers this node could sit in: the right kind, and not itself or anything inside it.
  const parentOptions = useMemo(
    () => diagram.programs.filter((p) => p.id !== program.id && canContain(codeKindOf(p), kind) && !wouldNestInItself(diagram, program.id, p.id)).map((p) => ({ id: p.id, label: codePath(diagram, p) })),
    [diagram, program.id, kind],
  );

  const copyStarter = async () => {
    try {
      await navigator.clipboard.writeText(starter);
      toast('success', `Copied ${programCodeFilename(program)} to the clipboard.`);
    } catch {
      toast('error', 'The clipboard refused the copy; select the code and copy it by hand.');
    }
  };

  const onDelete = async () => {
    if (descendants) {
      const ok = await confirmDialog({
        title: `Delete ${program.name} and the ${descendants} node${descendants === 1 ? '' : 's'} inside it?`,
        message: 'Steps elsewhere that call them keep their code and are reported by Problems. This can be undone with Ctrl+Z.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    deleteProgram(program.id);
  };

  const memberKinds = CODE_KINDS.filter((k) => canContain(kind, k.id));

  /**
   * Turning a node into a data file drops its steps, because nothing runs in
   * one. That is the only kind change that loses anything, so it is the only
   * one that asks first.
   */
  const changeKind = async (next: CodeKind) => {
    if (next === 'data' && program.steps.length > 0) {
      const ok = await confirmDialog({
        title: `Make ${program.name} a data file?`,
        message: `Nothing runs in a YAML or JSON file, so the ${program.steps.length} step${program.steps.length === 1 ? '' : 's'} on this node — and the SQL and code they carry — will be removed. This can be undone with Ctrl+Z.`,
        confirmLabel: 'Make it a data file',
        danger: true,
      });
      if (!ok) return;
    }
    updateProgram(program.id, { kind: next });
  };

  return (
    <div>
      <div className="field">
        <span className="field__label">Name</span>
        <input
          className="input input--mono"
          value={program.name}
          onChange={(e) => updateProgram(program.id, { name: e.target.value })}
          placeholder={kind === 'module' ? 'e.g. orders.py' : kind === 'class' ? 'e.g. OrderService' : kind === 'function' ? 'e.g. place_order' : kind === 'data' ? `e.g. settings.${lang.extension}` : 'e.g. ingest_worker'}
          autoFocus
        />
      </div>

      <div className="row">
        <label className="field grow">
          <span className="field__label">Kind</span>
          <select className="select" value={kind} onChange={(e) => void changeKind(e.target.value as CodeKind)} title={kindMeta.hint}>
            {CODE_KINDS.filter((k) => k.id !== 'procedure').map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span className="field__label">Inside</span>
          <select className="select" value={program.parentId ?? ''} onChange={(e) => updateProgram(program.id, { parentId: e.target.value || undefined })}>
            <option value="">Nothing (top level)</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        <label className="field grow">
          <span className="field__label">Language</span>
          <select className="select" value={program.language} onChange={(e) => updateProgram(program.id, { language: e.target.value as Program['language'] })}>
            {languages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'program' && (
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
        )}
      </div>

      <div className="field">
        <span className="field__label">{kind === 'program' ? 'Where the code lives' : kind === 'module' || kind === 'data' ? 'Path' : 'Signature or location'}</span>
        <input
          className="input input--mono"
          value={program.entrypoint ?? ''}
          onChange={(e) => updateProgram(program.id, { entrypoint: e.target.value || undefined })}
          placeholder={
            kind === 'program'
              ? 'e.g. services/worker/main.py'
              : kind === 'module'
                ? 'e.g. src/orders.py'
                : kind === 'data'
                  ? `e.g. config/settings.${lang.extension}`
                  : kind === 'class'
                    ? 'e.g. class OrderService(BaseService)'
                    : 'e.g. def place_order(cart, customer) -> Order'
          }
        />
      </div>

      <div className="field">
        <span className="field__label">What it is for</span>
        <textarea
          className="textarea"
          rows={2}
          value={program.comment ?? ''}
          onChange={(e) => updateProgram(program.id, { comment: e.target.value || undefined })}
          placeholder={kind === 'function' ? 'Validates the cart and writes the order.' : kind === 'data' ? 'The rates and thresholds the pricing code reads.' : 'Scores every pending job and writes the result back.'}
        />
      </div>

      <div className="field">
        <span className="field__label">Color</span>
        <Swatches value={program.color} onPick={(key) => updateProgram(program.id, { color: key })} label={`${kindMeta.label} colour`} />
      </div>

      {kindMeta.container && (
        <>
          <div className="divider" />
          <div className="section">
            <div className="section__head">
              <span className="section__title">Inside ({members.length})</span>
              {members.length > 0 && (
                <button className="btn btn--sm" onClick={() => setCodeCollapsed([program.id], !program.collapsed)} title={program.collapsed ? 'Draw the members again' : 'Fold everything inside into this one node; arrows gather onto it'}>
                  {program.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} {program.collapsed ? 'Expand' : 'Collapse'}
                </button>
              )}
            </div>
            {members.length === 0 && <div className="faint small">Nothing yet. Add a member below, or drag a node into this {kindMeta.label.toLowerCase()}&apos;s region on the canvas.</div>}
            {members.map((m) => (
              <div key={m.id} className="rel-item" style={{ cursor: 'default' }}>
                <button
                  className="grow row"
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                  onClick={() => {
                    setSelection({ programIds: [m.id], tableIds: [], noteIds: [], relationshipId: null, groupId: null });
                    focusTable(m.id);
                  }}
                >
                  <Crosshair size={13} className="faint" />
                  <span className="faint small">{codeKindMeta(codeKindOf(m)).label.toLowerCase()}</span>
                  <span style={{ fontWeight: 600 }}>{m.name}</span>
                  <span className="faint small">{m.steps.length} step{m.steps.length === 1 ? '' : 's'}</span>
                </button>
              </div>
            ))}
            <div className="row row--wrap" style={{ marginTop: 6 }}>
              {memberKinds.map((k) => (
                <button key={k.id} className="btn btn--sm" title={k.hint} onClick={() => addProgram({ kind: k.id, parentId: program.id })}>
                  <Plus /> {k.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {callers.length > 0 && (
        <div className="field">
          <span className="field__label">Reached from</span>
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

      {isData ? (
        <div className="field">
          <span className="field__label">Loaded by</span>
          <span className="field__hint">{describeProgram(diagram, program)}</span>
          {loaders.length > 0 ? (
            <div className="chip-list">
              {loaders.map((c) => (
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
          ) : (
            <div className="faint small">Nothing loads it yet. Add a <strong>Load</strong> step to the function that reads it, or drag an arrow from that node to this one.</div>
          )}
          <span className="field__hint">
            No steps: nothing runs in a {lang.label} file, so it has nothing it does in order. What is in it is the code that reads it, and that is drawn from the other end.
          </span>
        </div>
      ) : (
        <>
          <div className="field">
            <span className="field__label">Steps, in order</span>
            <span className="field__hint">{describeProgram(diagram, program)}</span>
          </div>

          <div className="program-steps">
            {program.steps.map((step, i) => (
              <StepRow key={step.id} program={program} step={step} index={i} open={step.id === activeStepId} />
            ))}
            {program.steps.length === 0 && (
              <div className="faint small">
                {kind === 'function'
                  ? 'Nothing yet. A function is its steps: what it reads, what it calls, what it writes back.'
                  : kindMeta.container
                    ? 'Nothing yet. A container can have steps of its own — a module its imports, a class what it extends — or leave the steps to the functions inside it.'
                    : 'Nothing yet. A program is its steps: what it reads, what it works out, what it writes back.'}
              </div>
            )}
          </div>

          <div className="row row--wrap">
            {/* A read or a write has to name a table, so on a diagram with no
                tables those buttons would add a step with nothing to point at.
                The moment one table exists they are back. */}
            {PROGRAM_STEP_OPS.filter((op) => stepOpsForKind(kind).includes(op.id) && !(programStepOpMeta(op.id).touchesDatabase && noTables)).map((op) => (
              <button key={op.id} className="btn btn--sm" title={op.hint} onClick={() => addProgramStep(program.id, { op: op.id })}>
                <Plus /> {op.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="divider" />

      <div className="field">
        <div className="row">
          <button className="btn btn--sm" onClick={() => setShowCode((v) => !v)} disabled={!starterReady}>
            <Code2 /> {showCode ? 'Hide' : 'Show'} the {lang.label} starter
          </button>
          <button className="btn btn--sm" onClick={copyStarter} disabled={!starterReady}>
            <ClipboardCopy /> Copy
          </button>
        </div>
        <span className="field__hint">
          {isData
            ? program.language === 'json'
              ? 'An empty document. JSON cannot carry a comment, so what the diagram knows about this file stays on the canvas rather than going in the file.'
              : 'The file, with what the diagram knows written above it: what it is for, and what loads it. The keys are yours to add.'
            : templated
              ? `Written from the steps above, against ${diagram.dialect}${members.length ? `, with the ${members.length === 1 ? 'node' : 'nodes'} inside written out as definitions` : ''}. A starting point, not a finished program: the compute steps and the calls come out as stubs.`
              : `No driver template for ${lang.label} on ${diagram.dialect} yet, so the starter is the plan in comments rather than runnable code.`}
        </span>
      </div>

      {showCode && starterReady && <CodeBlock code={starter} language={program.language} className="program-starter" />}

      <div className="divider" />
      <div className="row row--wrap">
        <button className="btn btn--sm" onClick={() => duplicateProgram(program.id)}>
          <Copy /> Duplicate
        </button>
        {kindMeta.container && members.length > 0 && (
          <button className="btn btn--sm" onClick={() => dissolveCodeNode(program.id)} title="Remove this container and move what is inside it up one level">
            <Ungroup /> Dissolve
          </button>
        )}
        <button className="btn btn--danger btn--sm" onClick={() => void onDelete()}>
          <Trash2 /> Delete {kindMeta.label.toLowerCase()}
        </button>
      </div>
    </div>
  );
}

/**
 * One step: its op, what it touches, and the SQL and code it carries.
 *
 * Shared with the procedure editor. On a procedure everything a step carries
 * is SQL — the statement, and for a compute or a call the procedural code — so
 * the host-language code box gives way to SQL editors there.
 */
export function StepRow({ program, step, index, open }: { program: Program; step: ProgramStep; index: number; open: boolean }) {
  const diagram = useStore((s) => s.diagram);
  const updateProgramStep = useStore((s) => s.updateProgramStep);
  const removeProgramStep = useStore((s) => s.removeProgramStep);
  const moveProgramStep = useStore((s) => s.moveProgramStep);
  const setActiveStep = useUi((s) => s.setActiveProgramStepId);
  const [expanded, setExpanded] = useState(open);
  const scope = useMemo(() => diagramScope(diagram), [diagram]);
  const kind = codeKindOf(program);
  const inDatabase = kind === 'procedure';
  // The ops this node may have, plus the one the step already has, so a step a
  // file gave a stray op still shows what it is rather than a blank select.
  const ops = PROGRAM_STEP_OPS.filter((o) => stepOpsForKind(kind).includes(o.id) || o.id === step.op);
  // A load names a data file and a call, import or extends names code, so the
  // picker only offers what the op could actually mean.
  const codeOptions = useMemo(
    () =>
      diagram.programs
        .filter((p) => p.id !== program.id && canStepName(step.op, codeKindOf(p), codeKindOf(program)))
        .map((p) => ({ id: p.id, label: codePath(diagram, p) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [diagram, program, step.op],
  );

  const meta = programStepOpMeta(step.op);
  const table = step.tableId ? diagram.tables.find((t) => t.id === step.tableId) : undefined;
  const target = step.codeId ? diagram.programs.find((p) => p.id === step.codeId) : undefined;
  const missing = (meta.touchesDatabase && Boolean(step.tableId) && !table) || (meta.namesCode && Boolean(step.codeId) && !target);
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
          {ops.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        {meta.touchesDatabase && (
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
        {meta.namesCode && codeOptions.length === 0 && step.op === 'load' && (
          <span className="faint small">No data file on the canvas yet — add one, then point this step at it.</span>
        )}
        {meta.namesCode && (
          <select className="select select--sm" value={step.codeId ?? ''} onChange={(e) => updateProgramStep(program.id, step.id, { codeId: e.target.value || undefined })}>
            <option value="">
              {step.op === 'call' ? (inDatabase ? 'Pick the routine it calls…' : 'Pick what it calls…') : step.op === 'import' ? 'Pick what it imports…' : step.op === 'load' ? 'Pick the data file…' : 'Pick the base class…'}
            </option>
            {codeOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
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

      {missing && (
        <div className="program-step__alert">
          {meta.namesCode ? 'This step names code that is no longer in the diagram. Point it at another node, or remove the step.' : 'This step names a table that is no longer in the diagram. Point it at another one, or remove the step.'}
        </div>
      )}

      {shown && (
        <div className="program-step__body">
          {meta.touchesDatabase && table && (
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

          {meta.touchesDatabase && (
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
              <span className="field__hint">
                {inDatabase
                  ? 'Leave it empty and the body written from these steps gets a placeholder naming the table and columns above.'
                  : 'Leave it empty and the generated starter writes one from the table and columns above.'}
              </span>
            </div>
          )}

          {step.op !== 'compute' && (
            <div className="field">
              <span className="field__label">Note</span>
              <input
                className="input input--sm"
                value={step.note ?? ''}
                onChange={(e) => updateProgramStep(program.id, step.id, { note: e.target.value || undefined })}
                placeholder={isCodeStepOp(step.op) ? 'what is passed, or why' : 'why this step exists'}
              />
            </div>
          )}

          {inDatabase ? (
            (step.op === 'compute' || step.op === 'call') && (
              <div className="field">
                <span className="field__label">{step.op === 'compute' ? 'Procedural code' : 'The call'}</span>
                <SqlEditor
                  value={step.code ?? ''}
                  onChange={(v) => updateProgramStep(program.id, step.id, { code: v || undefined })}
                  scope={scope}
                  mode="statement"
                  rows={3}
                  expandable
                  title={`Step ${index + 1} of ${program.name}`}
                  placeholder={step.op === 'compute' ? 'IF … THEN … END IF; / SET total = total + 1;' : 'CALL other_procedure(…);'}
                  ariaLabel="Step code"
                />
              </div>
            )
          ) : (
            <div className="field">
              <span className="field__label">Code</span>
              <CodeEditor
                value={step.code ?? ''}
                onChange={(v) => updateProgramStep(program.id, step.id, { code: v || undefined })}
                language={program.language}
                rows={5}
                placeholder={step.op === 'compute' ? 'The part the database never sees.' : step.op === 'load' ? 'The line that reads the file.' : isCodeStepOp(step.op) ? 'The line that makes the call.' : 'The code around this statement.'}
                ariaLabel="Step code"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
