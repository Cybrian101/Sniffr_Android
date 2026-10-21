import { useEffect, useState } from 'react';
import { APP_TOAST_EVENT } from '../utils/appToast';

// App-wide toast for failed user actions (see utils/appToast.js). The latest
// message replaces the previous one.
export default function AppToast() {
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let timer = null;
    const show = (e) => {
      const { message, icon } = e.detail || {};
      if (!message) return;
      setToast({ message, icon: icon || 'error' });
      clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 3200);
    };
    window.addEventListener(APP_TOAST_EVENT, show);
    return () => {
      window.removeEventListener(APP_TOAST_EVENT, show);
      clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;
  return (
    <div
      role="alert"
      className="fixed top-16 left-1/2 -translate-x-1/2 z-[100000] max-w-[90vw] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-5 py-2.5 rounded-2xl text-xs font-extrabold shadow-xl flex items-center gap-2 pointer-events-none"
    >
      <span className="material-symbols-outlined text-sm">{toast.icon}</span>
      <span className="text-center">{toast.message}</span>
    </div>
  );
}
