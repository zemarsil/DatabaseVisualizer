import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/canvas/Canvas';
import { Inspector } from './components/inspector/Inspector';
import { Drawer } from './components/drawer/Drawer';
import { Toasts } from './components/ui/Toasts';
import { DialogHost, useDialogStore } from './components/ui/Modal';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function App() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
          else s.clearSelection();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="app__body">
        {sidebarOpen ? <Sidebar /> : <div />}
        <div className="app__center">
          <Canvas />
          <Drawer />
        </div>
        {inspectorOpen ? <Inspector /> : <div />}
      </div>
      <Toasts />
      <DialogHost />
    </div>
  );
}
