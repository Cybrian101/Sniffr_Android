import { useEffect, useState } from 'react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';

// Delete-account flow (Me -> Settings): intro -> emailed 6-digit code + typed
// "DELETE ACCOUNT" -> deleting. On success the account is gone, so the app
// signs out at once (finishAccountDeletion) and the app-level
// AccountDeletedNotice shows the final message -- that happens even if this
// modal is closed some other way, because it doesn't depend on this modal.
//
// Server: POST /api/account/delete/request-code and /confirm (routes/account.js).

const PHRASE = 'DELETE ACCOUNT';
const RESEND_COOLDOWN_SECONDS = 60;
const SUPPORT_EMAIL = 'official.sniffr@gmail.com';

// Errors that mean the current code is dead: offer "Send a new code".
const DEAD_CODE_ERRORS = ['CODE_EXPIRED', 'TOO_MANY_ATTEMPTS', 'NO_ACTIVE_CODE'];

function useCountdown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return undefined;
    const t = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);
  return [seconds, setSeconds];
}

// Turns an API error into what the modal shows inline.
function describeError(err) {
  const code = err?.code;
  const body = err?.body || {};
  switch (code) {
    case 'ADMIN_CANNOT_SELF_DELETE':
      return { kind: 'admin', message: "Admin accounts can't be deleted here." };
    case 'INVALID_CODE': {
      const left = body.attemptsRemaining;
      return {
        kind: 'invalid',
        message: Number.isInteger(left)
          ? `That code is incorrect. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`
          : 'That code is incorrect.',
      };
    }
    case 'CODE_EXPIRED':
      return { kind: 'dead', message: 'That code has expired.' };
    case 'TOO_MANY_ATTEMPTS':
      return { kind: 'dead', message: 'Too many incorrect attempts. That code no longer works.' };
    case 'NO_ACTIVE_CODE':
      return { kind: 'dead', message: 'There is no active code.' };
    case 'RATE_LIMITED':
      // Per-account limit on codes (3 per hour).
      return { kind: 'rate', message: 'Too many codes requested.', retryAfter: Number(body.retryAfterSeconds) || 60 };
    case 'RATE_LIMIT':
      // Per-device request limit (shared rate limiter).
      return { kind: 'rate', message: 'Too many tries.', retryAfter: Number(body.retryAfter) || 60 };
    case 'CONFIRMATION_MISMATCH':
      return { kind: 'phrase', message: `Type ${PHRASE} exactly to confirm.` };
    case 'DELETION_FAILED':
      return { kind: 'failed', message: 'Nothing was deleted. Please try again.' };
    case 'EMAIL_FAILED':
      return { kind: 'email', message: "We couldn't send the email. Please try again later." };
    default:
      return { kind: 'other', message: err?.isNetworkError ? 'No connection. Please try again.' : 'Something went wrong. Please try again.' };
  }
}

export default function DeleteAccountModal({ onClose, onLockChange }) {
  const { finishAccountDeletion } = useAuth();
  const [step, setStep] = useState('intro'); // 'intro' | 'code' | 'deleting'
  const [maskedEmail, setMaskedEmail] = useState('');
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null); // from describeError
  const [resendIn, setResendIn] = useCountdown();
  const [blockedFor, setBlockedFor] = useCountdown(); // rate-limit countdown

  const deleting = step === 'deleting';

  // While deleting, nothing may close the modal: tell the parent (backdrop)
  // and swallow Escape before the Settings panel's own handler sees it.
  useEffect(() => {
    onLockChange?.(deleting);
    if (!deleting) return undefined;
    const block = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [deleting, onLockChange]);

  useEffect(() => () => onLockChange?.(false), [onLockChange]);

  const showError = (err) => {
    const info = describeError(err);
    setError(info);
    if (info.kind === 'rate') setBlockedFor(info.retryAfter);
    return info;
  };

  const sendCode = async () => {
    if (sending || blockedFor > 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.post('/account/delete/request-code');
      setMaskedEmail(res.maskedEmail || '');
      setCode('');
      setResendIn(RESEND_COOLDOWN_SECONDS);
      setStep('code');
    } catch (err) {
      showError(err);
    } finally {
      setSending(false);
    }
  };

  const codeReady = /^\d{6}$/.test(code);
  const phraseReady = phrase === PHRASE;
  const canDelete = codeReady && phraseReady && blockedFor <= 0 && !sending;

  const confirmDelete = async (e) => {
    e?.preventDefault();
    if (!canDelete) return;
    setError(null);
    setStep('deleting');
    try {
      await api.post('/account/delete/confirm', { code, confirmation: phrase });
      // Gone: sign out and clear storage right now, whatever happens to this modal.
      finishAccountDeletion();
    } catch (err) {
      setStep('code');
      const info = showError(err);
      if (info.kind === 'invalid' || info.kind === 'dead') setCode('');
    }
  };

  const errorBox = error && (
    <div role="alert" className="p-3 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300 rounded-xl text-xs font-bold text-left space-y-2">
      <p>
        {error.message}
        {error.kind === 'rate' && blockedFor > 0 && ` Try again in ${blockedFor}s.`}
      </p>
      {error.kind === 'dead' && step === 'code' && (
        <button
          type="button"
          onClick={sendCode}
          disabled={sending || blockedFor > 0}
          className="px-3 py-1.5 bg-rose-500 text-white rounded-lg text-[11px] font-extrabold active:scale-95 transition-transform disabled:opacity-50"
        >
          {sending ? 'Sending...' : 'Send a new code'}
        </button>
      )}
    </div>
  );

  // ── Deleting ────────────────────────────────────────────────────────
  if (deleting) {
    return (
      <div className="p-6 space-y-4 overflow-y-auto text-center" aria-busy="true">
        <span className="material-symbols-outlined text-4xl text-rose-500 animate-spin block mx-auto">sync</span>
        <div className="space-y-1">
          <h2 className="text-lg font-extrabold text-on-surface">Deleting your account...</h2>
          <p className="text-xs text-zinc-500 font-medium">This takes a few seconds. Please keep this screen open.</p>
        </div>
      </div>
    );
  }

  // ── Intro ───────────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <div className="p-6 space-y-4 overflow-y-auto text-center">
        <div className="w-14 h-14 rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300 flex items-center justify-center mx-auto">
          <span className="material-symbols-outlined text-2xl">delete_forever</span>
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-extrabold text-on-surface">Delete Account</h2>
          <ul className="text-xs text-zinc-600 dark:text-zinc-300 font-medium leading-relaxed text-left space-y-2 bg-zinc-50 dark:bg-zinc-800 rounded-2xl p-4">
            <li className="flex gap-2"><span className="material-symbols-outlined text-base flex-shrink-0">pets</span><span>Your pets, posts, photos and videos will be permanently deleted.</span></li>
            <li className="flex gap-2"><span className="material-symbols-outlined text-base flex-shrink-0">chat_bubble</span><span>Messages you've sent stay visible to the people you sent them to, shown as 'SniffedOut'.</span></li>
            <li className="flex gap-2"><span className="material-symbols-outlined text-base flex-shrink-0">star</span><span>If you have an active Premium plan, it ends immediately and is not refunded.</span></li>
            <li className="flex gap-2"><span className="material-symbols-outlined text-base flex-shrink-0">warning</span><span className="font-extrabold text-rose-600 dark:text-rose-300">This can't be undone.</span></li>
          </ul>
        </div>
        {errorBox}
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={sending}
            className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl active:scale-95 transition-transform disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={sendCode}
            disabled={sending || blockedFor > 0 || error?.kind === 'admin'}
            className="flex-1 py-3 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {sending ? <span className="material-symbols-outlined text-base animate-spin">sync</span> : 'Send code'}
          </button>
        </div>
      </div>
    );
  }

  // ── Code + confirmation ─────────────────────────────────────────────
  return (
    <form onSubmit={confirmDelete} className="p-6 space-y-4 overflow-y-auto text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-extrabold text-on-surface">Delete Account</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">
          We sent a 6-digit code to <strong className="text-on-surface">{maskedEmail || 'your email'}</strong>.
        </p>
      </div>

      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus
        value={code}
        onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); if (error?.kind === 'invalid') setError(null); }}
        placeholder="6-digit code"
        aria-label="6-digit code"
        className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-base font-extrabold text-center tracking-[0.3em] text-on-surface focus:outline-none focus:ring-2 focus:ring-rose-400"
      />

      <div className="text-left space-y-1">
        <label htmlFor="delete-account-phrase" className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
          Type <span className="font-extrabold text-rose-600 dark:text-rose-300">{PHRASE}</span> to confirm
        </label>
        <input
          id="delete-account-phrase"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={phrase}
          onChange={(e) => { setPhrase(e.target.value); if (error?.kind === 'phrase') setError(null); }}
          placeholder={PHRASE}
          className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm font-bold text-on-surface focus:outline-none focus:ring-2 focus:ring-rose-400"
        />
      </div>

      {errorBox}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl active:scale-95 transition-transform"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canDelete}
          className="flex-1 py-3 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Delete my account
        </button>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={sendCode}
          disabled={resendIn > 0 || sending || blockedFor > 0}
          className={`text-xs font-bold transition-colors ${resendIn > 0 || blockedFor > 0 ? 'text-zinc-400 cursor-not-allowed' : 'text-primary hover:underline'}`}
        >
          {sending ? 'Sending...' : resendIn > 0 ? `Resend code (${resendIn}s)` : 'Resend code'}
        </button>
        <p className="text-[10px] text-zinc-400">
          Can't access your email? Contact{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="font-bold text-primary hover:underline">{SUPPORT_EMAIL}</a>
        </p>
      </div>
    </form>
  );
}
