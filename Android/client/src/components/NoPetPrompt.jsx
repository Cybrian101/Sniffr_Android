import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NO_PET_EVENT, NO_PET_MESSAGE } from '../utils/noPet';

// App-wide "create your pet's profile first" prompt, opened by any action
// that needs a pet when the user skipped creating one (see utils/noPet.js
// and api.js: every NO_PET answer from the server opens it).
export default function NoPetPrompt() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(NO_PET_EVENT, show);
    return () => window.removeEventListener(NO_PET_EVENT, show);
  }, []);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mx-auto">
          <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
        </div>
        <div className="space-y-1">
          <h3 className="font-extrabold text-base text-on-surface">{NO_PET_MESSAGE}</h3>
          <p className="text-xs text-zinc-500 font-medium leading-relaxed">
            Sniffing, posting, chatting, calls and PawCircles all happen as your pet. It only takes a minute.
          </p>
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl uppercase tracking-wider"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); navigate('/pet-selection'); }}
            className="flex-[2] py-3 bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-extrabold text-xs rounded-xl shadow-md uppercase tracking-wider"
          >
            Create pet profile
          </button>
        </div>
      </div>
    </div>
  );
}
