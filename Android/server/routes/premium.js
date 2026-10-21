import { Router } from 'express';
import multer from 'multer';
import { authenticateAccess } from '../middleware/auth.js';
import { PLANS, PLAN_KEYS, isValidPlanKey } from '../config/plans.js';
import {
  getFullPremiumState,
  serializePremiumState,
  cancelSubscription,
  markWelcomeSliderSeen,
  createCheckoutSession,
  confirmCheckoutSession,
  submitManualPaymentProof,
  BILLING_REASON_MESSAGES,
} from '../services/subscriptionService.js';
import { consumeBoostCredit } from '../services/premiumGate.js';
import db from '../db/connection.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import { sendServerError } from '../utils/errors.js';
import { PROOF_MAX_BYTES, PROOF_MIME_TYPES } from '../services/paymentProofs.js';

const router = Router();
router.use(authenticateAccess);

// UPI transaction IDs (UTR) vary in exact format across banks/PSPs, so this
// is a sanity check, not a strict spec match: non-empty, alphanumeric,
// reasonable length -- present in any real UTR/reference number.
const UTR_REGEX = /^[A-Za-z0-9]{6,30}$/;

// Payment proof screenshots only -- images, not video, unlike the
// posts/chat/community uploads which accept both. Size and types match the
// private storage bucket's limits (services/paymentProofs.js).
const submitProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROOF_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (PROOF_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    req.proofTypeRejected = true;
    cb(null, false);
  },
});

// Runs the upload, turning its rejections into clear 400s (by default an
// oversized file would surface as a generic server error).
function receiveProof(req, res, next) {
  submitProofUpload.single('media')(req, res, err => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'The screenshot must be 5 MB or smaller.' });
    }
    if (err) return next(err);
    if (req.proofTypeRejected) {
      return res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'Attach the screenshot as a JPG, PNG or WebP image.' });
    }
    next();
  });
}

// GET /api/premium/plans — public catalog for the upgrade modal. No auth
// state needed beyond being logged in; same PLANS registry every gate
// check reads from, so the modal can never drift out of sync with what's
// actually enforced server-side.
router.get('/plans', async (req, res) => {
  try {
    res.json({
      plans: PLAN_KEYS.map(key => ({
        key,
        label: PLANS[key].label,
        priceInr: PLANS[key].priceInr,
        maxCommunitiesJoined: PLANS[key].maxCommunitiesJoined === Infinity ? null : PLANS[key].maxCommunitiesJoined,
        maxCommunitiesCreated: PLANS[key].maxCommunitiesCreated === Infinity ? null : PLANS[key].maxCommunitiesCreated,
        maxPets: PLANS[key].maxPets === Infinity ? null : PLANS[key].maxPets,
        canUndoLike: PLANS[key].canUndoLike,
        canUseSuperSniff: PLANS[key].canUseSuperSniff,
        hasEarlyAccess: PLANS[key].hasEarlyAccess,
        hasPremiumBadge: PLANS[key].hasPremiumBadge,
        boostCreditsPerCycle: PLANS[key].boostCreditsPerCycle,
      })),
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/premium/status — the ONE endpoint the frontend calls to know
// everything about the current user's premium state. Always a fresh DB
// read (via getFullPremiumState, which lazily expires stale subscriptions
// AND checks for an in-flight checkout), never trusts anything the client sent.
router.get('/status', async (req, res) => {
  try {
    const io = req.app.get('io');
    const state = await getFullPremiumState(req.user.id, io);
    if (!state) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    res.json(state);
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/premium/checkout { plan } — Step 1 of the payment flow: creates
// a payment session (provider='upi_manual', the live manual-UPI path) but
// does NOT activate the plan. Amount is always derived server-side from
// PLANS[plan].priceInr -- the client only ever sends the plan key, never an
// amount. The plan only ever activates via a future admin-approval
// endpoint, never directly from a client request.
router.post('/checkout', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { plan } = req.body;
    if (!isValidPlanKey(plan) || plan === 'free') {
      return res.status(400).json({ error: 'INVALID_PLAN', message: 'Choose a valid paid plan.' });
    }
    const io = req.app.get('io');
    const session = await createCheckoutSession(req.user.id, plan, 'upi_manual', io);
    res.json(session);
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/premium/checkout/:sessionId/confirm — legacy/dev-only path for
// the mock gateway. confirmCheckoutSession() refuses to run for any session
// whose provider isn't 'mock', so this can never activate a real manual-UPI
// payment (see subscriptionService.js) -- kept only so the mock flow keeps
// working for local development, not called by the live frontend anymore.
router.post('/checkout/:sessionId/confirm', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'INVALID_SESSION_ID' });
    const io = req.app.get('io');
    const result = await confirmCheckoutSession(req.user.id, sessionId, io);
    if (!result.success) {
      const reason = result.reason || 'PAYMENT_FAILED';
      return res.status(400).json({ error: reason, message: BILLING_REASON_MESSAGES[reason] });
    }
    res.json(serializePremiumState(result.user));
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/premium/checkout/:sessionId/submit — the real manual-UPI path.
// User has already paid externally; this only records their proof
// (payment_method, UTR, screenshot) and moves the session to
// 'pending_review'. It NEVER activates Premium -- subscribeToPlan() is only
// ever reachable from a future admin-approval endpoint. Ownership, session
// existence, and state eligibility (not already succeeded/rejected/under
// review) are enforced in submitManualPaymentProof(); this handler only
// validates the shape of what the client sent.
router.post('/checkout/:sessionId/submit', rateLimiter(config.RATE_LIMIT.POST), receiveProof, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) return res.status(400).json({ error: 'INVALID_SESSION_ID' });

    const paymentMethod = String(req.body.payment_method || '').trim().toLowerCase();
    if (paymentMethod !== 'upi') {
      return res.status(400).json({ error: 'INVALID_PAYMENT_METHOD', message: 'Only UPI payments can be submitted right now.' });
    }

    const upiTransactionId = String(req.body.upi_transaction_id || '').trim();
    if (!UTR_REGEX.test(upiTransactionId)) {
      return res.status(400).json({ error: 'INVALID_UTR', message: 'Enter the UPI transaction ID so we can verify your payment.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'NO_PROOF', message: 'Attach a screenshot of your payment.' });
    }

    const io = req.app.get('io');
    const result = await submitManualPaymentProof(req.user.id, sessionId, {
      paymentMethod,
      upiTransactionId,
      file: req.file,
    }, io);

    if (!result.success) {
      const reason = result.reason || 'SUBMISSION_FAILED';
      return res.status(400).json({ error: reason, message: BILLING_REASON_MESSAGES[reason] });
    }
    res.json(result.state);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/cancel', async (req, res) => {
  try {
    const io = req.app.get('io');
    const { cancelled, user } = await cancelSubscription(req.user.id, io);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    const state = await getFullPremiumState(req.user.id, io);
    // M20: still 200 either way (cancelling an account with nothing active
    // isn't really an error the client needs to handle specially), but
    // `cancelled: false` lets the UI tell the difference if it ever wants
    // to -- no Billing History row was written for this call.
    res.json({ ...state, cancelled });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/premium/boost/use — spends 1 Spotlight Boost credit. Atomic
// server-side decrement (see premiumGate.consumeBoostCredit) -- a client
// can't spend credits it doesn't have by racing this endpoint.
router.post('/boost/use', async (req, res) => {
  try {
    const io = req.app.get('io');
    const result = await consumeBoostCredit(req.user.id, io);
    if (!result.success) {
      return res.status(400).json({ error: 'NO_BOOST_CREDITS', message: 'No Spotlight Boost credits remaining.' });
    }
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/premium/history — powers the Billing History settings modal.
// LEFT JOINs payment_sessions via the already-existing payment_session_id
// FK to surface rejection_reason for 'payment_rejected' rows, without a
// new column on plan_history -- NULL for every other row (they either have
// no payment_session_id, or point at a succeeded session whose
// rejection_reason is NULL anyway).
router.get('/history', async (req, res) => {
  try {
    const history = await db.all(
      `SELECT ph.id, ph.plan, ph.source, ph.action, ph.amount_paid, ph.previous_plan, ph.created_at, ps.rejection_reason
       FROM plan_history ph
       LEFT JOIN payment_sessions ps ON ps.id = ph.payment_session_id
       WHERE ph.user_id = ?
       ORDER BY ph.created_at DESC`,
      [req.user.id]
    );
    res.json({ history });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/premium/welcome-seen — marks the founding-member welcome
// slider as shown, so it never reappears on later logins.
router.post('/welcome-seen', async (req, res) => {
  try {
    await markWelcomeSliderSeen(req.user.id);
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
