import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { clearSharedPayloadFromLocation, decodeDiagramFromUrl, readSharedPayloadFromLocation } from '@/lib/share';
import { isBlankDiagram } from '@/lib/emphasis';

let handling = false;

/** Opens a diagram passed in the URL hash (`#d=…`) as a new sheet. Renders nothing. */
export function ShareLinkLoader() {
  useEffect(() => {
    const run = async () => {
      const payload = readSharedPayloadFromLocation();
      if (!payload || handling) return;
      handling = true;
      const { addSheet, setDiagram, toast } = useStore.getState();
      try {
        const decoded = await decodeDiagramFromUrl(payload);
        // A shared diagram arrives as a sheet of its own, so nothing you had
        // open is replaced — unless the canvas is an untouched blank one.
        const current = useStore.getState();
        if (current.sheetIds.length === 1 && isBlankDiagram(current.diagram)) {
          setDiagram(decoded);
          toast('success', `Opened "${decoded.name}" from the link.`);
        } else {
          addSheet({ diagram: decoded });
          toast('success', `Opened "${decoded.name}" from the link, in a new tab of this workspace.`);
        }
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'The shared link could not be opened.');
      } finally {
        clearSharedPayloadFromLocation();
        handling = false;
      }
    };
    void run();
    const onHash = () => void run();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return null;
}
