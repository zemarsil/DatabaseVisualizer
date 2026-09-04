import { Code2, Database, FileDown, Plus, Route, Shuffle } from 'lucide-react';
import { DIALECTS } from '@shared/types';
import { flowDerivations } from '@/lib/derivation';
import { useStore } from '@/store/useStore';

export function DiagramPanel() {
  const diagram = useStore((s) => s.diagram);
  const addTable = useStore((s) => s.addTable);
  const applyLayout = useStore((s) => s.applyLayout);
  const openDrawer = useStore((s) => s.openDrawer);
  const setTracePicking = useStore((s) => s.setTracePicking);
  const setDiagramName = useStore((s) => s.setDiagramName);

  const columns = diagram.tables.reduce((n, t) => n + t.columns.length, 0);
  const fks = diagram.relationships.filter((r) => r.kind === 'fk').length;
  const flows = diagram.relationships.length - fks;
  const tagged = diagram.relationships.filter((r) => r.query && r.query.trim()).length;
  const derived = diagram.relationships.reduce((n, r) => n + flowDerivations(r).length, 0);
  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;

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
        <div className="stat">
          <div className="stat__value">{derived}</div>
          <div className="stat__label">derived columns</div>
        </div>
      </div>
      <div className="section">
        <div className="section__head">
          <span className="section__title">Quick actions</span>
        </div>
        <div className="stack">
          <button className="btn" onClick={() => addTable()}>
            <Plus /> Add a table
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
          <li>Everything autosaves in this browser; use File → Save to keep a portable .dbviz.json file.</li>
        </ul>
      </div>
    </div>
  );
}
