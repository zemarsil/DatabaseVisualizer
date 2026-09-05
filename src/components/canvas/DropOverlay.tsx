import { FileDown } from 'lucide-react';

/** Full-canvas hint while files are being dragged over it. */
export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="canvas__drop">
      <div className="canvas__drop-card">
        <FileDown />
        <span>Drop a .sql script, a .dbviz.json diagram, or a .sqlite database</span>
      </div>
    </div>
  );
}
