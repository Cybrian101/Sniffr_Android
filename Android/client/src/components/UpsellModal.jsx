import { useNavigate } from 'react-router-dom';
import Portal from './Portal';

const QUICK_PLANS = [
  { key: 'plus', label: 'Plus', price: 123 },
  { key: 'gold', label: 'Gold', price: 299 },
  { key: 'platinum', label: 'Platinum', price: 999 },
];

// Small, short, reused everywhere a free user hits a locked feature --
// server/services/premiumGate.js is the actual enforcement; this is just
// the "here's why, here's what it costs, upgrade" UX around that rejection.
export default function UpsellModal({ title = 'Premium Feature', message, onClose }) {
  const navigate = useNavigate();

  const goToUpgrade = () => {
    onClose();
    navigate('/profile', { state: { openSettings: true, openPremium: true } });
  };

  return (
    <Portal trapFocus>
    <div
      className="fixed inset-0 z-[400] flex items-end lg:items-center justify-center pb-[env(safe-area-inset-bottom)]"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white dark:bg-zinc-900 w-full max-w-sm rounded-t-[2.5rem] lg:rounded-[2.5rem] shadow-2xl overflow-y-auto max-h-[90dvh]"
        style={{ animation: 'slideUpModal 0.35s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <style>{`
          @keyframes slideUpModal {
            from { transform: translateY(60px); opacity: 0; }
            to   { transform: translateY(0);    opacity: 1; }
          }
        `}</style>

        <div className="h-1.5 w-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500" />
        <div className="flex justify-center pt-3 lg:hidden">
          <div className="w-10 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full" />
        </div>

        <div className="px-6 pt-5 pb-8 text-center space-y-5">
          <div className="w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-500 flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-2xl">workspace_premium</span>
          </div>

          <div className="space-y-1">
            <h2 className="text-lg font-extrabold text-on-surface">{title}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed px-2">{message}</p>
          </div>

          <div className="flex gap-2">
            {QUICK_PLANS.map(p => (
              <div key={p.key} className="flex-1 p-3 rounded-2xl border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700 dark:text-amber-300">{p.label}</p>
                <p className="text-sm font-extrabold text-on-surface mt-0.5">
                  ₹{p.price}<span className="text-[9px] font-bold text-zinc-400">/mo</span>
                </p>
              </div>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl active:scale-95 transition-transform"
            >
              Not Now
            </button>
            <button
              onClick={goToUpgrade}
              className="flex-[2] py-3 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white font-extrabold text-xs rounded-xl shadow-lg active:scale-95 transition-all flex items-center justify-center gap-1.5"
            >
              <span className="material-symbols-outlined text-sm">auto_awesome</span> Upgrade to Premium
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}
