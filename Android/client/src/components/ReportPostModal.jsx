import { useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../services/api';
import { notifyActionError } from '../utils/appToast';

export default function ReportPostModal({ post, onClose }) {
  const [reportReason, setReportReason] = useState('Spam');
  const [reportNotes, setReportNotes] = useState('');
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);

  if (!post) return null;

  const submitReport = async () => {
    setIsSubmittingReport(true);
    try {
      await api.post(`/posts/${post.id}/report`, {
        reason: reportReason,
        notes: reportNotes
      });

      onClose();
    } catch (err) {
      notifyActionError(err, "Couldn't send your report. Please try again.");
    } finally {
      setIsSubmittingReport(false);
    }
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        padding: '16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmittingReport) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          width: '100%',
          maxWidth: '24rem',
          borderRadius: '2.5rem',
          boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
          padding: '24px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          textAlign: 'left',
          border: '1px solid rgba(0,0,0,0.05)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-black text-on-surface leading-snug">Report this post</h3>
          <p className="text-xs text-on-surface-variant font-bold mt-1">Why are you reporting this post?</p>
        </div>
        
        <div className="space-y-2">
          {[
            { value: 'Spam', label: 'Spam', icon: 'block' },
            { value: 'Harassment or Bullying', label: 'Harassment or Bullying', icon: 'sentiment_very_dissatisfied' },
            { value: 'Inappropriate Content', label: 'Inappropriate Content', icon: 'no_adult_content' },
            { value: 'False Information', label: 'False Information', icon: 'warning' },
            { value: 'Other', label: 'Other', icon: 'edit' }
          ].map(r => (
            <label key={r.value} className="flex items-center gap-3 bg-zinc-50 p-3 rounded-xl cursor-pointer hover:bg-zinc-100 transition-colors">
              <input
                type="radio"
                name="report_reason"
                value={r.value}
                checked={reportReason === r.value}
                onChange={(e) => setReportReason(e.target.value)}
                disabled={isSubmittingReport}
                className="text-primary focus:ring-primary/20"
              />
              <span className="material-symbols-outlined text-base text-on-surface-variant">{r.icon}</span>
              <span className="text-xs font-bold text-on-surface-variant">{r.label}</span>
            </label>
          ))}
        </div>
        
        {reportReason === 'Other' && (
          <div className="space-y-1.5">
            <textarea
              placeholder="Tell us more..."
              value={reportNotes}
              onChange={e => setReportNotes(e.target.value)}
              disabled={isSubmittingReport}
              rows={2.5}
              className="w-full bg-zinc-50 border-none rounded-xl text-xs px-4 py-3 placeholder:text-on-surface-variant/35 focus:ring-2 focus:ring-primary/20 text-on-surface"
            />
          </div>
        )}
        
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmittingReport}
            className="flex-1 py-3 bg-zinc-100 hover:bg-zinc-200 text-on-surface font-bold text-xs rounded-full transition-colors uppercase tracking-wider disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submitReport}
            disabled={isSubmittingReport || (reportReason === 'Other' && !reportNotes.trim())}
            className="flex-1 py-3 bg-error text-white font-bold text-xs rounded-full hover:bg-error/95 transition-colors uppercase tracking-wider disabled:opacity-50"
          >
            {isSubmittingReport ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
