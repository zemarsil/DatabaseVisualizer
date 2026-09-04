import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useStore } from '@/store/useStore';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__icon">{t.kind === 'success' ? <CheckCircle2 /> : t.kind === 'error' ? <AlertCircle /> : <Info />}</span>
          <span className="grow">{t.message}</span>
          <button className="icon-btn toast__close" onClick={() => dismiss(t.id)} title="Dismiss">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
