import { useState } from 'react';
import { createPortal } from 'react-dom';
import { notifyActionError } from '../utils/appToast';

const REASONS = [
  { value: 'Harassment or Bullying', icon: 'sentiment_very_dissatisfied' },
  { value: 'Inappropriate Messages', icon: 'no_adult_content' },
  { value: 'Spam or Scam', icon: 'block' },
  { value: 'Fake Profile', icon: 'person_off' },
  { value: 'Other', icon: 'edit' },
];

// Report someone -- a chat partner (ChatPage.jsx's 3-dot menu) or a pet's
// owner from their profile (ProfilePage.jsx's 3-dot menu); each caller
// passes its own onSubmit that posts to whichever endpoint fits what it
// has (a conversationId vs. a userId). Two steps in one modal: pick a
// reason, then a proper success confirmation -- never a window.alert().
export default function ReportUserModal({ onSubmit, name, onClose }) {
  const [reason, setReason] = useState('Harassment or Bullying');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit(reason, notes);
      setDone(true);
    } catch (err) {
      notifyActionError(err, "Couldn't send your report. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-[2.2rem] shadow-2xl p-6 flex flex-col gap-5 border border-black/5 dark:border-white/10 animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {done ? (
          <>
            <div className="flex flex-col items-center text-center gap-3 py-2">
              <div className="w-14 h-14 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center">
                <span className="material-symbols-outlined text-3xl">check_circle</span>
              </div>
              <div>
                <h3 className="text-base font-black text-on-surface">Reported successfully</h3>
                <p className="text-xs text-on-surface-variant font-bold mt-1">
                  Thanks for letting us know. Our team will review {name || 'this user'}'s account.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 bg-primary hover:bg-primary/90 text-white font-bold text-xs rounded-full transition-colors uppercase tracking-wider active:scale-95"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <div>
              <h3 className="text-base font-black text-on-surface leading-snug">Report {name || 'this user'}</h3>
              <p className="text-xs text-on-surface-variant font-bold mt-1">Why are you reporting them?</p>
            </div>

            <div className="space-y-2">
              {REASONS.map(r => (
                <label key={r.value} className="flex items-center gap-3 bg-zinc-50 dark:bg-zinc-800 p-3 rounded-xl cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors">
                  <input
                    type="radio"
                    name="report_user_reason"
                    value={r.value}
                    checked={reason === r.value}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={submitting}
                    className="text-primary focus:ring-primary/20"
                  />
                  <span className="material-symbols-outlined text-base text-on-surface-variant">{r.icon}</span>
                  <span className="text-xs font-bold text-on-surface-variant">{r.value}</span>
                </label>
              ))}
            </div>

            {reason === 'Other' && (
              <textarea
                placeholder="Tell us more..."
                value={notes}
                onChange={e => setNotes(e.target.value)}
                disabled={submitting}
                rows={2.5}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-xl text-xs px-4 py-3 placeholder:text-on-surface-variant/35 focus:ring-2 focus:ring-primary/20 text-on-surface"
              />
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-on-surface font-bold text-xs rounded-full transition-colors uppercase tracking-wider disabled:opacity-50 active:scale-95"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting || (reason === 'Other' && !notes.trim())}
                className="flex-1 py-3 bg-error hover:bg-error/90 text-white font-bold text-xs rounded-full transition-colors uppercase tracking-wider disabled:opacity-50 active:scale-95"
              >
                {submitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
