import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { useSimulation } from '@/store/useSimulation';
import { useUi } from '@/store/useUi';
import { simulationTargets } from '@/lib/simulate/engine';
import { stepSheet } from '@/lib/sheets';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/canvas/Canvas';
import { SheetTabs } from './components/SheetTabs';
import { Inspector } from './components/inspector/Inspector';
import { Drawer } from './components/drawer/Drawer';
import { Toasts } from './components/ui/Toasts';
import { ContextMenuHost, isContextMenuOpen } from './components/ui/ContextMenu';
import { DialogHost, useDialogStore } from './components/ui/Modal';
import { ShareLinkLoader } from './components/ShareLinkLoader';
import { TourHost } from './components/tour/TourHost';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function App() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const panelSizes = useStore((s) => s.panelSizes);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open context menu drives the keyboard itself (arrows, Enter, Esc).
      if (isContextMenuOpen()) return;
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const bridge = (window as unknown as { __dbviz?: Record<string, () => void> }).__dbviz;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        bridge?.saveFile();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        bridge?.openFile();
        return;
      }
      // Between the diagrams of this workspace, spreadsheet style — and, like a
      // spreadsheet, it works while you are typing in a field too.
      if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        stepSheet(e.key === 'PageDown' ? 1 : -1);
        return;
      }
      if (isEditable(e.target)) return; // let inputs keep their own undo/typing
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod || e.altKey) return;
      switch (e.key) {
        case 't':
        case 'T':
          e.preventDefault();
          s.addTable();
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          s.addNote();
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          s.addGroup({ tableIds: s.selection.tableIds });
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          s.applyLayout();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          s.requestFitView();
          break;
        case 's':
        case 'S': {
          // Simulate into the selected table when something feeds it; otherwise offer the picker.
          e.preventDefault();
          const sim = useSimulation.getState();
          if (sim.targetId) {
            sim.stop();
            break;
          }
          const fed = simulationTargets(s.diagram);
          const picked = s.selection.tableIds.find((id) => fed.some((t) => t.id === id));
          if (picked) sim.start(picked);
          else s.openDrawer('simulate');
          break;
        }
        case 'd':
        case 'D':
          // The derived lens: what is computed rather than stored, everywhere at once.
          e.preventDefault();
          useUi.getState().toggleDerived();
          break;
        case '?':
          e.preventDefault();
          useDialogStore.getState().setHelp(true);
          break;
        case 'Delete':
        case 'Backspace':
          // React Flow handles tables, notes and edges; regions are not its nodes.
          if (s.selection.groupId) {
            e.preventDefault();
            const name = s.diagram.groups.find((g) => g.id === s.selection.groupId)?.name ?? 'group';
            s.deleteGroup(s.selection.groupId, false);
            s.toast('info', `Removed the "${name}" region. Its tables are still in the diagram.`);
          }
          break;
        case 'Escape':
          if (s.trace.picking) s.setTracePicking(false);
          else if (s.trace.result) s.clearTrace();
          else if (useSimulation.getState().targetId) useSimulation.getState().stop();
          // The canvas peels the derived lens back a layer at a time; until it is
          // gone, Esc is about the lens rather than about the selection.
          else if (!useUi.getState().derived) s.clearSelection();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const panelStyle = {
    '--sidebar-w': `${panelSizes.sidebarW}px`,
    '--inspector-w': `${panelSizes.inspectorW}px`,
    '--drawer-h': `${panelSizes.drawerH}px`,
  } as React.CSSProperties;

  return (
    <div className="app" style={panelStyle}>
      <TopBar />
      <div className="app__body">
        {sidebarOpen ? <Sidebar /> : <div />}
        <div className="app__center">
          <SheetTabs />
          <Canvas />
          <Drawer />
        </div>
        {inspectorOpen ? <Inspector /> : <div />}
      </div>
      <TourHost />
      <Toasts />
      <ContextMenuHost />
      <DialogHost />
      <ShareLinkLoader />
    </div>
  );
}
