import { ChevronDown, ChevronUp, Code2, Database, FileDown, Play, Route, Shapes, ShieldAlert, Terminal } from 'lucide-react';
import { useStore, type DrawerTab } from '@/store/useStore';
import { SqlPanel } from './SqlPanel';
import { ImportPanel } from './ImportPanel';
import { DatabasePanel } from './DatabasePanel';
import { TracePanel } from './TracePanel';
import { SimulatePanel } from './SimulatePanel';
import { useSimulation } from '@/store/useSimulation';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { TypesPanel } from './TypesPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { QueryPanel } from './QueryPanel';
import { useMemo } from 'react';
import { lintDiagram } from '@/lib/lint';

const TABS: { id: DrawerTab; label: string; icon: React.ReactNode }[] = [
  { id: 'sql', label: 'SQL', icon: <Code2 /> },
  { id: 'types', label: 'Types', icon: <Shapes /> },
  { id: 'import', label: 'Import SQL', icon: <FileDown /> },
  { id: 'trace', label: 'Trace', icon: <Route /> },
  { id: 'simulate', label: 'Simulate', icon: <Play /> },
  { id: 'problems', label: 'Problems', icon: <ShieldAlert /> },
  { id: 'query', label: 'Query', icon: <Terminal /> },
  { id: 'database', label: 'Database', icon: <Database /> },
];

export function Drawer() {
  const { open, tab } = useStore((s) => s.drawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const closeDrawer = useStore((s) => s.closeDrawer);
  const traceResult = useStore((s) => s.trace.result);
  const simStages = useSimulation((s) => s.result?.stages.length ?? 0);
  const simStage = useSimulation((s) => s.stage);
  const simOn = useSimulation((s) => s.targetId !== null);
  const resizePanel = useStore((s) => s.resizePanel);
  const typeCount = useStore((s) => s.diagram.customTypes.length);
  const diagram = useStore((s) => s.diagram);
  const errorCount = useMemo(() => lintDiagram(diagram).filter((f) => f.severity === 'error').length, [diagram]);

  return (
    <section className={`drawer${open ? '' : ' drawer--collapsed'}`}>
      {open && <ResizeHandle orientation="horizontal" className="resize-handle--start" onResize={(delta) => resizePanel('drawerH', -delta)} />}
      <div className="drawer__tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`drawer__tab${open && tab === t.id ? ' drawer__tab--active' : ''}`} onClick={() => (open && tab === t.id ? closeDrawer() : openDrawer(t.id))}>
            {t.icon}
            {t.label}
            {t.id === 'trace' && traceResult && <span className="badge badge--trace">{traceResult.hops.length} hops</span>}
            {t.id === 'simulate' && simOn && <span className="badge badge--flow">{simStages ? `${Math.max(0, simStage + 1)}/${simStages}` : 'on'}</span>}
            {t.id === 'types' && typeCount > 0 && <span className="badge">{typeCount}</span>}
            {t.id === 'problems' && errorCount > 0 && <span className="badge badge--danger">{errorCount}</span>}
          </button>
        ))}
        <span className="grow" />
        <button className="btn btn--sm btn--icon btn--ghost" onClick={() => (open ? closeDrawer() : openDrawer())} title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown /> : <ChevronUp />}
        </button>
      </div>
      {open && (
        <div className="drawer__body">
          {tab === 'sql' && <SqlPanel />}
          {tab === 'types' && <TypesPanel />}
          {tab === 'import' && <ImportPanel />}
          {tab === 'trace' && <TracePanel />}
          {tab === 'simulate' && <SimulatePanel />}
          {tab === 'problems' && <ProblemsPanel />}
          {tab === 'query' && <QueryPanel />}
          {tab === 'database' && <DatabasePanel />}
        </div>
      )}
    </section>
  );
}
