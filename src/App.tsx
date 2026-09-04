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
  const panelSizes = useStore((s) => s.panelSizes);

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
