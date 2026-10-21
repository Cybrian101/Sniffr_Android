import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ACCOUNT_DELETED_EVENT } from '../utils/accountSession';

// Final "Your account has been deleted." message. Mounted at app level (not
// inside Settings) because by the time it shows the user is already signed
// out and the protected pages -- Settings included -- are gone.
export default function AccountDeletedNotice() {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(ACCOUNT_DELETED_EVENT, show);
    return () => window.removeEventListener(ACCOUNT_DELETED_EVENT, show);
  }, []);

  if (!visible) return null;

  const handleOk = () => {
    setVisible(false);
    navigate('/', { replace: true }); // the sign-in page
  };

  return (
    <div className="fixed inset-0 z-[100001] flex items-center justify-center p-4 select-none" role="alertdialog" aria-modal="true">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl border border-outline-variant/10 shadow-2xl p-6 space-y-4 text-center animate-scale-up">
        <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto">
          <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-extrabold text-on-surface">Your account has been deleted.</h2>
          <p className="text-xs text-zinc-500 font-medium leading-relaxed">Thanks for being part of the pack.</p>
        </div>
        <button
          onClick={handleOk}
          autoFocus
          className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform"
        >
          OK
        </button>
      </div>
    </div>
  );
}
