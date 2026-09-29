import { BookOpen, ChevronDown, ChevronUp, Code2, Database, FileDown, Play, Route, Shapes, ShieldAlert, Sigma, Terminal } from 'lucide-react';
import { selectDiagramContent, selectShowsDatabaseTools, useStore, type DrawerTab } from '@/store/useStore';
import { SqlPanel } from './SqlPanel';
import { ImportPanel } from './ImportPanel';
import { DatabasePanel } from './DatabasePanel';
import { TracePanel } from './TracePanel';
import { SimulatePanel } from './SimulatePanel';
import { DerivedPanel } from './DerivedPanel';
import { WalkthroughPanel } from './WalkthroughPanel';
import { useSimulation } from '@/store/useSimulation';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { TypesPanel } from './TypesPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { QueryPanel } from './QueryPanel';
import { useMemo } from 'react';
import { lintDiagram } from '@/lib/lint';
import { buildLineage, lineageTotals } from '@/lib/lineage';
import { useUi } from '@/store/useUi';

/**
 * `database: true` marks a tab that only means anything once there is a schema:
 * it generates DDL, runs it, imports it or reasons about rows. Those tabs stay
 * off a code map, where they would be nine-tenths of the drawer and none of it
 * usable. Walkthrough, Trace and Problems have no such marker because all three
 * already work across code and tables alike.
 */
const TABS: { id: DrawerTab; label: string; icon: React.ReactNode; database?: boolean }[] = [
  { id: 'walkthrough', label: 'Walkthrough', icon: <BookOpen /> },
  { id: 'sql', label: 'SQL', icon: <Code2 />, database: true },
  { id: 'types', label: 'Types', icon: <Shapes />, database: true },
  { id: 'import', label: 'Import SQL', icon: <FileDown />, database: true },
  { id: 'trace', label: 'Trace', icon: <Route /> },
  { id: 'simulate', label: 'Simulate', icon: <Play />, database: true },
  { id: 'derived', label: 'Derived', icon: <Sigma />, database: true },
  { id: 'problems', label: 'Problems', icon: <ShieldAlert /> },
  { id: 'query', label: 'Query', icon: <Terminal />, database: true },
  { id: 'database', label: 'Database', icon: <Database />, database: true },
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
  // The Types tab holds custom types and extensions, so the badge counts both.
  const typeCount = useStore((s) => s.diagram.customTypes.length + s.diagram.extensions.length);
  const activeWalkthroughSlug = useStore((s) => s.activeWalkthroughSlug);
  const diagram = useStore(selectDiagramContent);
  const errorCount = useMemo(() => lintDiagram(diagram).filter((f) => f.severity === 'error').length, [diagram]);
  const derivedCount = useMemo(() => lineageTotals(buildLineage(diagram), diagram).derived, [diagram]);
  const lensOn = useUi((s) => s.derived !== null);
  const dbTools = useStore(selectShowsDatabaseTools);
  const tabs = dbTools ? TABS : TABS.filter((t) => !t.database);
  // A tab that has just been hidden must not keep rendering its panel behind
  // the tab strip; the drawer falls back to the first one still on offer.
  const shown = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  return (
    <section className={`drawer${open ? '' : ' drawer--collapsed'}`}>
      {open && <ResizeHandle orientation="horizontal" className="resize-handle--start" onResize={(delta) => resizePanel('drawerH', -delta)} />}
      <div className="drawer__tabs">
        {tabs.map((t) => (
          <button key={t.id} data-tour={`tab-${t.id}`} className={`drawer__tab${open && shown === t.id ? ' drawer__tab--active' : ''}`} onClick={() => (open && shown === t.id ? closeDrawer() : openDrawer(t.id))}>
            {t.icon}
            {t.label}
            {t.id === 'trace' && traceResult && <span className="badge badge--trace">{traceResult.hops.length} hops</span>}
            {t.id === 'simulate' && simOn && <span className="badge badge--flow">{simStages ? `${Math.max(0, simStage + 1)}/${simStages}` : 'on'}</span>}
            {t.id === 'types' && typeCount > 0 && <span className="badge">{typeCount}</span>}
            {t.id === 'problems' && errorCount > 0 && <span className="badge badge--danger">{errorCount}</span>}
            {t.id === 'derived' && (lensOn ? <span className="badge badge--flow">lens</span> : derivedCount > 0 ? <span className="badge">{derivedCount}</span> : null)}
            {t.id === 'walkthrough' && activeWalkthroughSlug && !(open && shown === 'walkthrough') && <span className="badge badge--accent">•</span>}
          </button>
        ))}
        <span className="grow" />
        <button className="btn btn--sm btn--icon btn--ghost" onClick={() => (open ? closeDrawer() : openDrawer())} title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown /> : <ChevronUp />}
        </button>
      </div>
      {open && (
        <div className="drawer__body" data-tour="drawer-body">
          {shown === 'walkthrough' && <WalkthroughPanel />}
          {shown === 'sql' && <SqlPanel />}
          {shown === 'types' && <TypesPanel />}
          {shown === 'import' && <ImportPanel />}
          {shown === 'trace' && <TracePanel />}
          {shown === 'simulate' && <SimulatePanel />}
          {shown === 'derived' && <DerivedPanel />}
          {shown === 'problems' && <ProblemsPanel />}
          {shown === 'query' && <QueryPanel />}
          {shown === 'database' && <DatabasePanel />}
        </div>
      )}
    </section>
  );
}
