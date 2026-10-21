import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function EmailVerifyBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('sniffr_verify_banner_dismissed') === '1');
  const [sending, setSending] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  // Synchronous guard against a fast double-click firing the request twice
  // before React state has a chance to re-render and disable the button.
  const inFlightRef = useRef(false);

  // On mount (and whenever the user id changes), read whatever cooldown
  // timestamp was recorded -- either from the automatic signup send
  // (stashed by AuthContext.signup()) or from a previous resend click in
  // this same browser tab session.
  useEffect(() => {
    if (!user?.id) return;
    const stored = sessionStorage.getItem(`sniffr_verify_cooldown_${user.id}`);
    if (stored) {
      const remainingMs = parseInt(stored, 10) - Date.now();
      if (remainingMs > 0) setCooldownRemaining(Math.ceil(remainingMs / 1000));
    }
  }, [user?.id]);

  // Live countdown ticking down every second while in cooldown.
  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const interval = setInterval(() => {
      setCooldownRemaining(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownRemaining]);

  if (!user || user.email_verified === 1 || dismissed) return null;

  const handleDismiss = () => {
    sessionStorage.setItem('sniffr_verify_banner_dismissed', '1');
    setDismissed(true);
  };

  const handleResend = async () => {
    if (inFlightRef.current || cooldownRemaining > 0) return;
    inFlightRef.current = true;
    setSending(true);
    setStatusMsg('');
    try {
      const res = await api.post('/auth/resend-verification');
      if (res?.alreadyVerified) {
        setStatusMsg('Your email is already verified!');
      } else if (res?.cooldownUntil) {
        sessionStorage.setItem(`sniffr_verify_cooldown_${user.id}`, String(res.cooldownUntil));
        const remainingMs = res.cooldownUntil - Date.now();
        setCooldownRemaining(Math.max(0, Math.ceil(remainingMs / 1000)));
        setStatusMsg('Verification email sent! Check your inbox.');
      }
    } catch (err) {
      if (err.code === 'COOLDOWN' && err.cooldownUntil) {
        sessionStorage.setItem(`sniffr_verify_cooldown_${user.id}`, String(err.cooldownUntil));
        const remainingMs = err.cooldownUntil - Date.now();
        setCooldownRemaining(Math.max(0, Math.ceil(remainingMs / 1000)));
      }
      setStatusMsg(err.message || 'Could not send verification email. Please try again.');
    } finally {
      setSending(false);
      inFlightRef.current = false;
    }
  };

  const inCooldown = cooldownRemaining > 0;
  const buttonLabel = sending
    ? 'Sending...'
    : inCooldown
      ? `Resend in ${cooldownRemaining}s`
      : 'Resend Email';

  const displayMessage = statusMsg || (inCooldown
    ? 'Verification email sent! Check your inbox.'
    : 'Please verify your email address.');

  return (
    <div className="w-full bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <span className="material-symbols-outlined text-base flex-shrink-0">mail</span>
        <span className="font-bold text-amber-800 dark:text-amber-300 truncate">
          {displayMessage}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleResend}
          disabled={sending || inCooldown}
          className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white font-bold uppercase tracking-wider rounded-full text-[10px] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed min-w-[92px] text-center"
        >
          {buttonLabel}
        </button>
        <button
          onClick={handleDismiss}
          className="w-6 h-6 rounded-full flex items-center justify-center text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
    </div>
  );
}
