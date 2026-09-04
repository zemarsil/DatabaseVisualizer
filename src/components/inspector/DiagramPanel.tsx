import { Boxes, Code2, Database, FileDown, Plus, Route, Shuffle } from 'lucide-react';
import { DIALECTS } from '@shared/types';
import { useStore } from '@/store/useStore';

export function DiagramPanel() {
  const diagram = useStore((s) => s.diagram);
  const addTable = useStore((s) => s.addTable);
  const applyLayout = useStore((s) => s.applyLayout);
  const openDrawer = useStore((s) => s.openDrawer);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const setDiagramName = useStore((s) => s.setDiagramName);
  const addGroup = useStore((s) => s.addGroup);
  const selectGroup = useStore((s) => s.selectGroup);

  const columns = diagram.tables.reduce((n, t) => n + t.columns.length, 0);
  const fks = diagram.relationships.filter((r) => r.kind === 'fk').length;
  const flows = diagram.relationships.length - fks;
  const tagged = diagram.relationships.filter((r) => r.query && r.query.trim()).length;
  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;
  const externalTables = diagram.tables.filter((t) => diagram.groups.some((g) => g.id === t.groupId && g.external)).length;

  return (
    <div>
      <div className="field">
        <span className="field__label">Diagram name</span>
        <input className="input" value={diagram.name} onChange={(e) => setDiagramName(e.target.value)} />
      </div>
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat">
          <div className="stat__value">{diagram.tables.length}</div>
          <div className="stat__label">tables · {columns} columns</div>
        </div>
        <div className="stat">
          <div className="stat__value">{fks}</div>
          <div className="stat__label">foreign keys</div>
        </div>
        <div className="stat">
          <div className="stat__value">{flows}</div>
          <div className="stat__label">data-flow links</div>
        </div>
        <div className="stat">
          <div className="stat__value">{tagged}</div>
          <div className="stat__label">tagged queries</div>
        </div>
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
      <div className="section">
        <div className="section__head">
          <span className="section__title">Quick actions</span>
        </div>
        <div className="stack">
          <button className="btn" onClick={() => addTable()}>
            <Plus /> Add a table
          </button>
          <button className="btn" onClick={() => addGroup()}>
            <Boxes /> Add a group
          </button>
          <button className="btn" onClick={() => openDrawer('import')}>
            <FileDown /> Import CREATE TABLE statements
          </button>
          <button className="btn" onClick={() => openDrawer('sql')}>
            <Code2 /> View the {dialect} script
          </button>
          <button className="btn" onClick={() => applyLayout()} disabled={diagram.tables.length < 2}>
            <Shuffle /> Detangle the layout
          </button>
          <button
            className="btn"
            onClick={() => {
              openDrawer('trace');
              setTracePicking(true);
            }}
            disabled={diagram.tables.length < 2}
          >
            <Route /> Trace a path between two tables
          </button>
          <button className="btn" onClick={() => openDrawer('database')}>
            <Database /> Docker &amp; database
          </button>
        </div>
      </div>
      <div className="section">
        <div className="section__head">
          <span className="section__title">Tips</span>
        </div>
        <ul className="hint-list small">
          <li>Click a table to edit it here; shift-click to select several.</li>
          <li>Drag a column handle onto another table's column to add a foreign key.</li>
          <li>Drag the orange header handle to another table to add a data-flow link, then tag it with the query.</li>
          <li>Group tables into a region to keep a second database's tables apart; mark the group external and the script stops creating them.</li>
          <li>Everything autosaves in this browser; use File → Save to keep a portable .dbviz.json file.</li>
        </ul>
      </div>
    </div>
  );
}
