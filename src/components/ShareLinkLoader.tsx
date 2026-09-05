import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { clearSharedPayloadFromLocation, decodeDiagramFromUrl, readSharedPayloadFromLocation } from '@/lib/share';
import { confirmDialog } from './ui/Modal';

let handling = false;

/** Opens a diagram passed in the URL hash (`#d=…`). Renders nothing. */
export function ShareLinkLoader() {
  useEffect(() => {
    const run = async () => {
      const payload = readSharedPayloadFromLocation();
      if (!payload || handling) return;
      handling = true;
      const { setDiagram, toast } = useStore.getState();
      try {
        const decoded = await decodeDiagramFromUrl(payload);
        const current = useStore.getState().diagram;
        const ok =
          current.tables.length === 0 ||
          (await confirmDialog({
            title: 'Open shared diagram?',
            message: `"${decoded.name}" (${decoded.tables.length} table${decoded.tables.length === 1 ? '' : 's'}) was shared with you. Your current diagram stays in this browser.`,
            confirmLabel: 'Open',
          }));
        if (ok) {
          setDiagram(decoded);
          toast('success', `Opened "${decoded.name}" from the link.`);
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
