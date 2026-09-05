import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { useUi } from '@/store/useUi';

/**
 * Warn before the tab closes when a file-backed diagram has unsaved changes.
 * The autosaved workspace never warns: nothing is lost there.
 */
export function useBeforeUnload(): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const { dirty, fileBacked } = useStore.getState();
      if (!dirty || !fileBacked || !useUi.getState().warnOnClose) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
