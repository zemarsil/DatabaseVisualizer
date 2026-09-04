import { ChevronDown, ChevronUp, Code2, Database, FileDown, Route, Shapes } from 'lucide-react';
import { useStore, type DrawerTab } from '@/store/useStore';
import { SqlPanel } from './SqlPanel';
import { ImportPanel } from './ImportPanel';
import { DatabasePanel } from './DatabasePanel';
import { TracePanel } from './TracePanel';
import { TypesPanel } from './TypesPanel';

const TABS: { id: DrawerTab; label: string; icon: React.ReactNode }[] = [
  { id: 'sql', label: 'SQL', icon: <Code2 /> },
  { id: 'types', label: 'Types', icon: <Shapes /> },
  { id: 'import', label: 'Import SQL', icon: <FileDown /> },
  { id: 'trace', label: 'Trace', icon: <Route /> },
  { id: 'database', label: 'Database', icon: <Database /> },
];

export function Drawer() {
  const { open, tab } = useStore((s) => s.drawer);
  const openDrawer = useStore((s) => s.openDrawer);
  const closeDrawer = useStore((s) => s.closeDrawer);
  const traceResult = useStore((s) => s.trace.result);
  const typeCount = useStore((s) => s.diagram.customTypes.length);

  return (
    <section className={`drawer${open ? '' : ' drawer--collapsed'}`}>
      <div className="drawer__tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`drawer__tab${open && tab === t.id ? ' drawer__tab--active' : ''}`} onClick={() => (open && tab === t.id ? closeDrawer() : openDrawer(t.id))}>
            {t.icon}
            {t.label}
            {t.id === 'trace' && traceResult && <span className="badge badge--trace">{traceResult.hops.length} hops</span>}
            {t.id === 'types' && typeCount > 0 && <span className="badge">{typeCount}</span>}
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
          {tab === 'database' && <DatabasePanel />}
        </div>
      )}
    </section>
  );
}
