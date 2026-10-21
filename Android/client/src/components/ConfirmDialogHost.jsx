import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONFIRM_DIALOG_EVENT } from '../utils/confirmDialog';

// App-wide confirm dialog (see utils/confirmDialog.js) -- the in-app
// replacement for window.confirm(). Mounted once near the app root; any
// screen can open it via confirmDialog({...}) without rendering its own copy.
export default function ConfirmDialogHost() {
  const [dialog, setDialog] = useState(null);

  useEffect(() => {
    const open = (e) => setDialog(e.detail);
    window.addEventListener(CONFIRM_DIALOG_EVENT, open);
    return () => window.removeEventListener(CONFIRM_DIALOG_EVENT, open);
  }, []);

  if (!dialog) return null;
  const { title, message, confirmLabel, cancelLabel, danger, icon, resolve } = dialog;

  const close = (result) => {
    resolve(result);
    setDialog(null);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in"
      onClick={() => close(false)}
    >
      <div
        className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-[2.2rem] shadow-2xl p-6 flex flex-col gap-4 border border-black/5 dark:border-white/10 animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center ${danger ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600' : 'bg-primary/10 text-primary'}`}>
            <span className="material-symbols-outlined text-xl">{icon}</span>
          </div>
          <div className="pt-1">
            <h3 className="text-sm font-black text-on-surface leading-snug">{title}</h3>
            {message && <p className="text-xs text-on-surface-variant font-bold mt-1 whitespace-pre-line">{message}</p>}
          </div>
        </div>
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={() => close(false)}
            className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-on-surface font-bold text-xs rounded-full transition-colors uppercase tracking-wider active:scale-95"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => close(true)}
            className={`flex-1 py-3 font-bold text-xs rounded-full transition-colors uppercase tracking-wider text-white active:scale-95 ${danger ? 'bg-error hover:bg-error/90' : 'bg-primary hover:bg-primary/90'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
