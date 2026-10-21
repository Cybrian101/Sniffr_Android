import { useEffect, useState } from 'react';
import { BLOCK_EVENT, fetchBlockedAccounts, setBlocked } from '../../utils/blocks';
import { avatarUrl } from '../../utils/media';
import { publicAsset } from '../../utils/publicPath';

// Settings > Safety Center > Blocked accounts: the people you blocked (from
// the server, so it is the same after a refresh or on another device), each
// with Unblock. Blocking itself is on their profile or your chat (⋮ menu).
export default function BlockedAccountsModal({ onClose }) {
  const [list, setList] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setError('');
    try {
      setList(await fetchBlockedAccounts());
    } catch (err) {
      setError(err.message || 'Could not load your blocked accounts.');
      setList([]);
    }
  };

  useEffect(() => {
    load();
    // Blocked/unblocked somewhere else while this is open.
    const onChange = () => load();
    window.addEventListener(BLOCK_EVENT, onChange);
    return () => window.removeEventListener(BLOCK_EVENT, onChange);
  }, []);

  const unblock = async (userId) => {
    setBusyId(userId);
    setError('');
    try {
      await setBlocked(userId, false); // fires BLOCK_EVENT -> reload
    } catch (err) {
      setError(err.message || 'Could not unblock. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 select-none">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-3xl border border-outline-variant/10 shadow-2xl z-[310] overflow-hidden max-h-[90vh] flex flex-col animate-scale-up">
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
            <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined">block</span> Blocked accounts
            </h2>
            <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            People you block can't message or call you, sniff you, see your posts or profile, or interact with you, and you won't see theirs. To block someone, open their profile or your chat with them and tap ⋮.
          </p>

          {error && <p className="text-xs font-bold text-rose-600">{error}</p>}

          {list === null ? (
            <div className="flex justify-center py-10">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : list.length === 0 ? (
            <div className="text-center py-10 space-y-2">
              <div className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-400 flex items-center justify-center mx-auto"><span className="material-symbols-outlined text-xl">pets</span></div>
              <p className="text-xs font-extrabold text-zinc-500">You haven't blocked anyone.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {list.map(b => (
                <li key={b.user_id} className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                  <img
                    className="w-10 h-10 rounded-full object-cover"
                    src={avatarUrl(b.pet_avatar) || publicAsset('/logo.png')}
                    alt={b.pet_name || 'Blocked account'}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-extrabold text-on-surface truncate">{b.pet_name || 'Sniffr user'}</p>
                    {b.pet_username && <p className="text-[11px] text-zinc-400 truncate">@{String(b.pet_username).replace(/^@+/, '')}</p>}
                  </div>
                  <button
                    onClick={() => unblock(b.user_id)}
                    disabled={busyId === b.user_id}
                    className="px-4 py-2 rounded-full bg-primary/10 text-primary text-xs font-extrabold hover:bg-primary/20 active:scale-95 transition-all disabled:opacity-50"
                  >
                    {busyId === b.user_id ? 'Unblocking…' : 'Unblock'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
