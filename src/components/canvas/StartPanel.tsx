/**
 * The opening choice, on a canvas nothing has been drawn on yet.
 *
 * This app used to open on "add a table", which answered a question it had not
 * asked: half the diagrams people draw here are code maps that never touch a
 * database. So the empty canvas asks instead, and each answer is a real start —
 * it sets the diagram's emphasis *and* puts the first node down, so the reader
 * is one keystroke from typing a name rather than one click from another empty
 * canvas.
 *
 * None of the three is a door that locks. "Code map" only tidies the database
 * tooling away; adding a table brings it straight back. That is why the card
 * says what each path does rather than what it forbids.
 */
import { Cpu, Database, FileDown, FolderOpen, Shapes, Sparkles, Table2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { getBridge } from '@/components/CommandPalette';

export function StartPanel() {
  const setEmphasis = useStore((s) => s.setEmphasis);
  const addTable = useStore((s) => s.addTable);
  const addProgram = useStore((s) => s.addProgram);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const openDrawer = useStore((s) => s.openDrawer);
  const loadSample = useStore((s) => s.loadSample);

  const startCode = () => {
    setEmphasis('code');
    addProgram();
    setInspectorOpen(true);
  };

  const startData = () => {
    setEmphasis('data');
    addTable();
    setInspectorOpen(true);
  };

  return (
    <div className="canvas__empty" data-tour="start-panel">
      <div className="start-card">
        <h2>What are you drawing?</h2>
        <p className="start-card__lead">Either one is a whole diagram on its own. You can add the other half at any point, and the tools for it come back on their own.</p>

        <div className="start-card__paths">
          <button className="start-path" onClick={startCode} data-tour="start-code">
            <Cpu className="start-path__icon" />
            <span className="start-path__title">Code map</span>
            <span className="start-path__body">Programs, modules, classes and functions, and what each one calls, imports and computes. No database needed.</span>
          </button>
          <button className="start-path" onClick={startData} data-tour="start-data">
            <Table2 className="start-path__icon" />
            <span className="start-path__title">Database schema</span>
            <span className="start-path__body">Tables, columns, keys and the connections between them, with SQL generated as you draw and a real engine to run it on.</span>
          </button>
        </div>

        <button className="start-path start-path--wide" onClick={() => setEmphasis('both')} data-tour="start-both">
          <Shapes className="start-path__icon" />
          <span className="start-path__title">Blank canvas</span>
          <span className="start-path__body">Mix freely — every tool on screen from the start.</span>
        </button>

        <div className="start-card__foot">
          <span className="faint">Or start from something you already have:</span>
          <div className="row start-card__links">
            <button className="btn btn--sm" onClick={() => void (setEmphasis('data'), openDrawer('import'))}>
              <FileDown /> Import SQL
            </button>
            <button className="btn btn--sm" onClick={() => void (setEmphasis('data'), openDrawer('database'))}>
              <Database /> Read a live database
            </button>
            <button className="btn btn--sm" onClick={() => getBridge().openFile?.()} title="Run npm run scan:code over a repository, then open the .dbviz.json it writes — or just drop that file on the canvas.">
              <FolderOpen /> Open a scanned code map
            </button>
            <button className="btn btn--sm" onClick={loadSample}>
              <Sparkles /> Load the example
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
