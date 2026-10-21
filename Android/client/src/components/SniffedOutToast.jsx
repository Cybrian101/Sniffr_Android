import { useEffect, useState } from 'react';
import { SNIFFED_OUT_EVENT, SNIFFED_OUT_MESSAGE } from '../utils/sniffedOut';

// App-wide toast for any API call refused with SNIFFED_OUT that the screen
// didn't explain itself (see api.js) -- e.g. liking, sniffing or messaging a
// pet whose owner just deleted their account. Never crashes the screen.
export default function SniffedOutToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer = null;
    const show = () => {
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 2800);
    };
    window.addEventListener(SNIFFED_OUT_EVENT, show);
    return () => {
      window.removeEventListener(SNIFFED_OUT_EVENT, show);
      clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;
  return (
    <div
      role="status"
      className="fixed top-16 left-1/2 -translate-x-1/2 z-[100000] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-5 py-2.5 rounded-full text-xs font-extrabold shadow-xl flex items-center gap-2 pointer-events-none"
    >
      <span className="material-symbols-outlined text-sm">person_off</span>
      <span>{SNIFFED_OUT_MESSAGE}</span>
    </div>
  );
}
