import { useState, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

// UX safeguard only -- is_admin now passes through from GET /auth/me and
// login, but requireAdmin on the backend still does its own fresh DB
// lookup on every /admin/* call regardless of what this field says. A
// client lying about is_admin gains nothing; it still gets 403s from the
// real endpoints below.

function formatSubmittedAt(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const proofImageClass = 'w-full max-h-72 object-contain rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800';

// The screenshot is in private storage: the server hands out a signed URL
// that works for about 5 minutes, fetched when the image is shown. If the
// image fails to load (the URL expired while the page sat open), it asks
// for a fresh one once. Older Cloudinary proofs come back as their URL.
function PaymentProofImage({ sessionId }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retried, setRetried] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/admin/payments/${sessionId}/proof-url`);
      setUrl(res.url);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load the payment proof.');
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const handleImageError = () => {
    if (retried) {
      setError('Could not load the payment proof.');
      return;
    }
    setRetried(true);
    setUrl('');
    load();
  };

  if (error) {
    return <p className="text-[11px] font-bold text-rose-500">{error}</p>;
  }
  if (!url) {
    return (
      <div className="flex items-center justify-center h-24 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800">
        <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  return <img src={url} alt="Payment proof screenshot" onError={handleImageError} className={proofImageClass} />;
}

function PendingPaymentRow({ payment, onResolved }) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [rowError, setRowError] = useState('');
  // The user deleted their account: the session can only be rejected (the
  // server refuses approval). Also set if an approval loses a race with the
  // deletion.
  const [accountDeleted, setAccountDeleted] = useState(!!payment.account_deleted);

  const busy = approving || rejecting;

  const handleApprove = async () => {
    if (busy || accountDeleted) return;
    setApproving(true);
    setRowError('');
    try {
      await api.post(`/admin/payments/${payment.id}/approve`, {});
      onResolved(payment.id);
    } catch (err) {
      if (err?.code === 'ACCOUNT_DELETED') setAccountDeleted(true);
      setRowError(err.message || 'Failed to approve this payment. Please try again.');
      setApproving(false);
    }
  };

  const handleReject = async () => {
    if (busy) return;
    const trimmedReason = rejectionReason.trim();
    if (!trimmedReason) return;
    setRejecting(true);
    setRowError('');
    try {
      await api.post(`/admin/payments/${payment.id}/reject`, { rejectionReason: trimmedReason });
      onResolved(payment.id);
    } catch (err) {
      setRowError(err.message || 'Failed to reject this payment. Please try again.');
      setRejecting(false);
    }
  };

  return (
    <div className="p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-3">
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          {accountDeleted ? (
            <>
              <p className="text-sm font-extrabold text-on-surface truncate flex items-center gap-2">
                <span>User #{payment.user_id}</span>
                <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
                  Account deleted
                </span>
              </p>
              <p className="text-[11px] text-zinc-400 truncate">Name and email were removed with the account.</p>
            </>
          ) : (
            <>
              <p className="text-sm font-extrabold text-on-surface truncate">{payment.full_name || payment.username}</p>
              <p className="text-[11px] text-zinc-400 truncate">@{payment.username} · {payment.email}</p>
            </>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-extrabold text-amber-600">₹{payment.amount}</p>
          <p className="text-[10px] text-zinc-400 uppercase tracking-wide">{payment.plan}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <p className="text-zinc-400 font-bold uppercase tracking-wide text-[9px]">Payment Method</p>
          <p className="text-on-surface font-bold">{payment.payment_method || '-'}</p>
        </div>
        <div>
          <p className="text-zinc-400 font-bold uppercase tracking-wide text-[9px]">UTR</p>
          <p className="text-on-surface font-bold break-all">{payment.upi_transaction_id || '-'}</p>
        </div>
        <div className="col-span-2">
          <p className="text-zinc-400 font-bold uppercase tracking-wide text-[9px]">Submitted</p>
          <p className="text-on-surface font-bold">{formatSubmittedAt(payment.submitted_at)}</p>
        </div>
      </div>

      {(payment.has_proof || payment.proof_url) && <PaymentProofImage sessionId={payment.id} />}

      {rowError && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900/40 dark:text-rose-300 rounded-xl text-xs font-bold animate-fade-in flex items-center gap-2">
          <span className="material-symbols-outlined text-base">error</span>
          <span>{rowError}</span>
        </div>
      )}

      <textarea
        value={rejectionReason}
        onChange={(e) => setRejectionReason(e.target.value)}
        placeholder="Reason for rejection (required to reject)"
        disabled={busy}
        rows={2}
        className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-rose-400 disabled:opacity-60"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleReject}
          disabled={busy || !rejectionReason.trim()}
          className="flex-1 py-2.5 bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-300 font-extrabold text-xs rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {rejecting ? (
            <div className="w-4 h-4 border-2 border-rose-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            'Reject'
          )}
        </button>
        {accountDeleted ? (
          <div className="flex-[2] py-2.5 px-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-bold text-[11px] rounded-xl flex items-center justify-center gap-1.5 text-center">
            <span className="material-symbols-outlined text-sm">block</span>
            <span>Can't approve: account deleted</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleApprove}
            disabled={busy}
            className="flex-[2] py-2.5 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white font-extrabold text-xs rounded-xl shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {approving ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              'Approve'
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdminPaymentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.is_admin === true;

  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/admin/payments/pending');
        if (!cancelled) setPayments(res.payments || []);
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load pending payments.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin]);

  const handleResolved = (sessionId) => {
    setPayments(prev => prev.filter(p => p.id !== sessionId));
  };

  // Same precedent ProtectedRoute already uses for "you don't belong here"
  // (redirect, not a blocking alert/inline stop) -- mirrored here for the
  // "logged in but not admin" case.
  if (!isAdmin) {
    return <Navigate to="/home" replace />;
  }

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-extrabold text-on-surface">Pending Premium Payments</h1>
        <p className="text-xs text-zinc-400 mt-0.5">Manual UPI payments awaiting review.</p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && loadError && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900/40 dark:text-rose-300 rounded-xl text-xs font-bold flex items-center gap-2">
          <span className="material-symbols-outlined text-base">error</span>
          <span>{loadError}</span>
        </div>
      )}

      {!loading && !loadError && payments.length === 0 && (
        <div className="p-8 text-center rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700">
          <span className="material-symbols-outlined text-3xl text-zinc-300">task_alt</span>
          <p className="text-xs font-bold text-zinc-400 mt-2">No pending payments</p>
        </div>
      )}

      {!loading && !loadError && payments.length > 0 && (
        <div className="space-y-3">
          {payments.map(p => (
            <PendingPaymentRow key={p.id} payment={p} onResolved={handleResolved} />
          ))}
        </div>
      )}
    </div>
  );
}
