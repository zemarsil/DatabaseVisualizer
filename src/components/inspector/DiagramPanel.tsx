import { Boxes, Code2, Cpu, Database, FileDown, Plus, Route, Shuffle } from 'lucide-react';
import { DIALECTS, RELATIONSHIP_KINDS, isCodeStepOp, verbsForKind, type RelationshipKind } from '@shared/types';
import { flowDerivations } from '@/lib/derivation';
import { selectShowsDatabaseTools, useStore } from '@/store/useStore';
import { Checkpoints } from './Checkpoints';

const GLYPH_COLOR: Record<RelationshipKind, string> = {
  fk: 'var(--edge-strong)',
  flow: 'var(--flow)',
  embed: 'var(--embed)',
  dependency: 'var(--dep)',
};

const GLYPH_DASH: Record<RelationshipKind, string | undefined> = {
  fk: undefined,
  flow: '6 4',
  embed: undefined,
  dependency: '2 3',
};

/** Miniature of the edge as the canvas draws it, for the legend. */
function KindGlyph({ kind }: { kind: RelationshipKind }) {
  const c = GLYPH_COLOR[kind];
  return (
    <svg className="kind-glyph" viewBox="0 0 46 16" width="46" height="16" aria-hidden>
      <line x1="6" y1="8" x2="40" y2="8" stroke={c} strokeWidth="1.6" strokeDasharray={GLYPH_DASH[kind]} />
      {kind === 'fk' && (
        <>
          <path d="M 12 8 L 4 3 M 12 8 L 4 8 M 12 8 L 4 13" stroke={c} strokeWidth="1.6" fill="none" />
          <line x1="38" y1="3" x2="38" y2="13" stroke={c} strokeWidth="1.6" />
        </>
      )}
      {kind === 'flow' && <path d="M 44 8 L 36 4 L 36 12 Z" fill={c} />}
      {kind === 'embed' && <path d="M 2 8 L 8 4 L 14 8 L 8 12 Z" fill={c} />}
      {kind === 'dependency' && <path d="M 36 3 L 43 8 L 36 13" stroke={c} strokeWidth="1.6" fill="none" />}
    </svg>
  );
}

export function DiagramPanel() {
  const diagram = useStore((s) => s.diagram);
  const dbTools = useStore(selectShowsDatabaseTools);
  const addTable = useStore((s) => s.addTable);
  const addProgram = useStore((s) => s.addProgram);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const applyLayout = useStore((s) => s.applyLayout);
  const openDrawer = useStore((s) => s.openDrawer);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const setDiagramName = useStore((s) => s.setDiagramName);
  const addGroup = useStore((s) => s.addGroup);
  const selectGroup = useStore((s) => s.selectGroup);

  const columns = diagram.tables.reduce((n, t) => n + t.columns.length, 0);
  const byKind = (k: RelationshipKind) => diagram.relationships.filter((r) => r.kind === k).length;
  const fks = byKind('fk');
  const documented = diagram.relationships.length - fks;
  const breakdown = RELATIONSHIP_KINDS.filter((k) => k.id !== 'fk' && byKind(k.id) > 0)
    .map((k) => `${byKind(k.id)} ${k.short}`)
    .join(' · ');
  const tagged = diagram.relationships.filter((r) => r.query && r.query.trim()).length;
  const derived = diagram.relationships.reduce((n, r) => n + flowDerivations(r).length, 0);
  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;
  const externalTables = diagram.tables.filter((t) => diagram.groups.some((g) => g.id === t.groupId && g.external)).length;
  // The code half's own numbers, so a code map's panel is not five zeroes about
  // foreign keys. Steps are the code equivalent of columns: the detail inside.
  const steps = diagram.programs.reduce((n, p) => n + p.steps.length, 0);
  const codeLinks = diagram.programs.reduce((n, p) => n + p.steps.filter((st) => isCodeStepOp(st.op) && st.codeId).length, 0);
  const addCode = () => {
    addProgram();
    setInspectorOpen(true);
  };

  return (
    <div>
      <div className="field">
        <span className="field__label">Diagram name</span>
        <input className="input" value={diagram.name} onChange={(e) => setDiagramName(e.target.value)} />
      </div>
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        {/* The schema numbers where there is a schema, the code numbers where
            there is code. A code map used to get five zeroes about foreign keys. */}
        {dbTools && (
          <>
            <div className="stat">
              <div className="stat__value">{diagram.tables.length}</div>
              <div className="stat__label">tables · {columns} columns</div>
            </div>
            <div className="stat">
              <div className="stat__value">{fks}</div>
              <div className="stat__label">foreign keys</div>
            </div>
            <div className="stat">
              <div className="stat__value">{documented}</div>
              <div className="stat__label">{breakdown || 'documented links'}</div>
            </div>
            <div className="stat">
              <div className="stat__value">{tagged}</div>
              <div className="stat__label">tagged queries</div>
            </div>
            <div className="stat">
              <div className="stat__value">{derived}</div>
              <div className="stat__label">derived columns</div>
            </div>
          </>
        )}
        {diagram.programs.length > 0 && (
          <>
            <div className="stat">
              <div className="stat__value">{diagram.programs.length}</div>
              <div className="stat__label">code nodes · {steps} steps</div>
            </div>
            <div className="stat">
              <div className="stat__value">{codeLinks}</div>
              <div className="stat__label">calls, imports and loads</div>
            </div>
          </>
        )}
        {diagram.groups.length > 0 && (
          <div className="stat">
            <div className="stat__value">{diagram.groups.length}</div>
            <div className="stat__label">groups{externalTables ? ` · ${externalTables} external tables` : ''}</div>
          </div>
        )}
      </div>
      {diagram.groups.length > 0 && (
        <div className="section">
          <div className="section__head">
            <span className="section__title">Groups</span>
          </div>
          <div className="chip-list">
            {diagram.groups.map((g) => (
              <button key={g.id} className={`chip${g.external ? ' chip--external' : ''}`} onClick={() => selectGroup(g.id)} title={g.external ? 'In another database' : undefined}>
                {g.name}
                <span className="faint"> ({diagram.tables.filter((t) => t.groupId === g.id).length})</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <Checkpoints />
      <div className="section">
        <div className="section__head">
          <span className="section__title">Quick actions</span>
        </div>
        <div className="stack">
          <button className="btn" onClick={addCode}>
            <Cpu /> Add a program
          </button>
          {dbTools && (
            <button className="btn" onClick={() => addTable()}>
              <Plus /> Add a table
            </button>
          )}
          <button className="btn" onClick={() => addGroup()}>
            <Boxes /> Add a group
          </button>
          {dbTools && (
            <>
              <button className="btn" onClick={() => openDrawer('import')}>
                <FileDown /> Import CREATE TABLE statements
              </button>
              <button className="btn" onClick={() => openDrawer('sql')}>
                <Code2 /> View the {dialect} script
              </button>
            </>
          )}
          {/* Both halves lay out and trace, so both count towards "is there
              enough here to bother". */}
          <button className="btn" onClick={() => applyLayout()} disabled={diagram.tables.length + diagram.programs.length < 2}>
            <Shuffle /> Detangle the layout
          </button>
          <button
            className="btn"
            onClick={() => {
              openDrawer('trace');
              setTracePicking(true);
            }}
            disabled={diagram.tables.length + diagram.programs.length < 2}
          >
            <Route /> Trace a path between two nodes
          </button>
          {dbTools && (
            <button className="btn" onClick={() => openDrawer('database')}>
              <Database /> Docker &amp; database
            </button>
          )}
        </div>
      </div>
      {/* The legend is about connections between tables; a code map's arrows are
          explained by the steps that make them, on the node itself. */}
      {dbTools && (
        <div className="section">
          <div className="section__head">
            <span className="section__title">Connection types</span>
          </div>
          <div className="legend">
            {RELATIONSHIP_KINDS.map((k) => (
              <div key={k.id} className="legend__row">
                <KindGlyph kind={k.id} />
                <div>
                  <div className="legend__name">
                    {k.label}
                    {!k.emitsDdl && <span className="legend__tag">no DDL</span>}
                  </div>
                  <div className="legend__verbs">{verbsForKind(k.id).map((v) => `${v.forward} / ${v.inverse}`).join(' · ')}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="faint small" style={{ marginTop: 6 }}>
            Select a connection to switch its kind and pick how it reads. "has", "contains" and "used by" are the reverse readings of "belongs to", "is part
            of" and "uses", so they are the same connection seen from the other table.
          </div>
        </div>
      )}
      <div className="section">
        <div className="section__head">
          <span className="section__title">Tips</span>
        </div>
        <ul className="hint-list small">
          <li>Click anything to edit it here; shift-click to select several.</li>
          <li>
            <strong>C</strong> adds a code node — inside the selected container, if that container can hold one. Drag a node's header handle onto another for a
            call, an import or a load.
          </li>
          {dbTools && <li>Drag a column handle onto another table's column to add a foreign key.</li>}
          {dbTools && <li>Drag the orange header handle to another table for a table-to-table link, then set its kind in the inspector.</li>}
          {dbTools && <li>Group tables into a region to keep a second database's tables apart; mark the group external and the script stops creating them.</li>}
          {!dbTools && (
            <li>This diagram is about code, so the database tooling is out of the way. Add a table and it all comes back — or say so in View → This diagram is about.</li>
          )}
          <li>Everything autosaves in this browser; use File → Save to keep a portable .dbviz.json file.</li>
        </ul>
      </div>
    </div>
  );
}
