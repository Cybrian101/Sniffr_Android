import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter, failureCounter } from '../middleware/rateLimiter.js';
import db, { withTransaction } from '../db/connection.js';
import config from '../config.js';
import { issueCode, checkCode, VerificationCodeError } from '../services/verificationCodes.js';
import { deleteUserAccount, AccountDeletionError } from '../services/accountDeletion.js';
import { sendAccountDeletionCodeEmail } from '../utils/mailer.js';
import { afterAccountDeletion } from '../services/accountDeletionFollowUp.js';
import { logUndeliverableSecret } from '../utils/devSecrets.js';

// Account deletion: an emailed 6-digit code plus the typed phrase
// "DELETE ACCOUNT". The deletion itself (a tombstone, see
// services/accountDeletion.js) runs in one transaction; if it fails nothing
// is deleted and the code stays valid for a retry.
//
// Two ways in, sharing everything below the account lookup:
//   /delete/*         signed-in user (the app's Settings screen)
//   /public/delete/*  NOT signed in: the landing page's sniffrweb.com/delete-account
//                     (Google Play requirement); the account is named by email
//                     or username. CORS for it: see index.js.

const router = Router();

const PURPOSE = 'delete_account';
const CONFIRMATION_PHRASE = 'DELETE ACCOUNT';

// Per-IP limits on top of the per-account ones (3 codes/hour, 5 attempts per
// code). One-minute windows: the shared limiter prunes entries after 2 min.
const requestCodeLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });
const confirmLimiter = rateLimiter({ windowMs: 60 * 1000, max: 15 });
const publicRequestCodeLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });
const publicConfirmLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });
// Public lookups that match no account: at most 3 per IP per hour (successful
// ones don't count). Once reached, every public lookup from that IP is
// refused until the window passes -- matches included, so a blocked IP can't
// keep probing which accounts exist.
const FAILED_LOOKUP_WINDOW_MS = 60 * 60 * 1000;
const failedLookups = failureCounter({ windowMs: FAILED_LOOKUP_WINDOW_MS, max: 3 });

const ADMIN_BODY = { error: 'ADMIN_CANNOT_SELF_DELETE', message: 'Admin accounts cannot be deleted this way.' };
const NOT_FOUND_BODY = { error: 'ACCOUNT_NOT_FOUND', message: "We couldn't sniff out that account. Please check your details." };
const MAX_IDENTIFIER_LENGTH = 254;

function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [name, domain] = email.split('@');
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  return `${name[0]}***${name[name.length - 1]}@${domain}`;
}

async function loadUser(userId) {
  return db.get('SELECT id, email, is_admin FROM users WHERE id = ?', [userId]);
}

// Live (not SniffedOut) account by email (identifier contains "@") or
// username, case-insensitively. Emails and usernames are unique only
// case-sensitively, so if several rows match, the one with the exact
// spelling wins; if none or several do, it's treated as no match.
async function findLiveAccount(identifier) {
  const column = identifier.includes('@') ? 'email' : 'username';
  const rows = await db.all(
    `SELECT id, email, username, is_admin FROM users
     WHERE deleted_at IS NULL AND LOWER(${column}) = LOWER(?)
     ORDER BY id LIMIT 5`, [identifier]);
  if (rows.length <= 1) return rows[0] || null;
  const exact = rows.filter(r => r[column] === identifier);
  return exact.length === 1 ? exact[0] : null;
}

// Public routes: resolve the identifier to a live account, applying the
// per-IP failed-lookup limit. Returns { user } or { status, body }.
async function resolvePublicAccount(req) {
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
  if (!identifier || identifier.length > MAX_IDENTIFIER_LENGTH) {
    return { status: 400, body: { error: 'MISSING_IDENTIFIER', message: 'Enter the email or username of your Sniffr account.' } };
  }
  const retryAfterSeconds = failedLookups.retryAfterSeconds(req.ip);
  if (retryAfterSeconds) {
    return { status: 429, body: { error: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.', retryAfterSeconds } };
  }
  const user = await findLiveAccount(identifier);
  if (!user) {
    failedLookups.record(req.ip);
    return { status: 404, body: NOT_FOUND_BODY };
  }
  return { user };
}

// Shared by both request-code routes: issue a code and email it.
// Returns { status, body } for an error, or { issued } on success.
async function sendDeletionCode(user) {
  if (user.is_admin) return { status: 403, body: ADMIN_BODY };

  let issued;
  try {
    issued = await issueCode(user.id, PURPOSE);
  } catch (err) {
    if (err instanceof VerificationCodeError && err.code === 'RATE_LIMITED') {
      return {
        status: 429,
        body: { error: 'RATE_LIMITED', message: 'Too many codes requested. Please try again later.', retryAfterSeconds: err.retryAfterSeconds },
      };
    }
    throw err;
  }

  // Local development without email only -- the code is never logged in production.
  logUndeliverableSecret(`account deletion code for user #${user.id}`, issued.code);
  const sent = await sendAccountDeletionCodeEmail(user.email, issued.code);
  if (sent && sent.success === false) {
    return { status: 502, body: { error: 'EMAIL_FAILED', message: "We couldn't send the email. Please try again in a moment." } };
  }
  return { issued };
}

// Shared by both confirm routes, once the account is known and the phrase
// matched: check the code, delete, then the post-commit follow-up.
// Returns { status, body }.
async function confirmDeletion(user, code, io, label) {
  if (user.is_admin) return { status: 403, body: ADMIN_BODY };

  let codeId;
  try {
    // Its own small transaction: a wrong attempt is committed (and counted)
    // even though nothing else happens.
    const result = await withTransaction(tx => checkCode(tx, user.id, PURPOSE, String(code ?? '')));
    switch (result.status) {
      case 'OK':
        codeId = result.codeId;
        break;
      case 'INVALID_CODE':
        return { status: 400, body: { error: 'INVALID_CODE', message: 'That code is incorrect.', attemptsRemaining: result.attemptsRemaining } };
      case 'CODE_EXPIRED':
        return { status: 400, body: { error: 'CODE_EXPIRED', message: 'That code has expired. Request a new one.' } };
      case 'TOO_MANY_ATTEMPTS':
        return { status: 429, body: { error: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Request a new code.' } };
      default:
        return { status: 400, body: { error: 'NO_ACTIVE_CODE', message: 'No active code. Request a new one.' } };
    }
  } catch (err) {
    console.error(`[${label}] code check`, err);
    return { status: 500, body: { error: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } };
  }

  let deleted;
  try {
    deleted = await deleteUserAccount(user.id, { codeId });
  } catch (err) {
    if (err instanceof AccountDeletionError) {
      if (err.code === 'ADMIN_CANNOT_SELF_DELETE') return { status: 403, body: ADMIN_BODY };
      // The code expired or was used between the check and the deletion.
      if (err.code === 'CODE_INVALID') {
        return { status: 400, body: { error: 'CODE_EXPIRED', message: 'That code is no longer valid. Request a new one.' } };
      }
    }
    // Everything was rolled back: nothing deleted, code still valid.
    console.error(`[${label}] deletion failed for user #${user.id}:`, err);
    return { status: 500, body: { error: 'DELETION_FAILED', message: 'Nothing was deleted. Please try again.' } };
  }

  // ── After commit ────────────────────────────────────────────────────
  // Socket announcements, then the Cloudinary purge (waits a few seconds at
  // most; anything left is retried by the hourly job, db/cleanup.js). Shared
  // with the support script, scripts/deleteAccount.js.
  const { mediaCleanup, authCleanup } = await afterAccountDeletion(user.id, deleted, { io });
  return { status: 200, body: { success: true, mediaCleanup, authCleanup } };
}

const confirmationMismatch = confirmation => confirmation !== CONFIRMATION_PHRASE
  && { status: 400, body: { error: 'CONFIRMATION_MISMATCH', message: `Type ${CONFIRMATION_PHRASE} exactly to confirm.` } };

// ── Signed in ─────────────────────────────────────────────────────────

// POST /api/account/delete/request-code
// 200 { success, maskedEmail, expiresInSeconds } | 403 ADMIN_CANNOT_SELF_DELETE
// | 429 RATE_LIMITED { retryAfterSeconds } | 502 EMAIL_FAILED
router.post('/delete/request-code', authenticateAccess, requestCodeLimiter, async (req, res) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    const { status, body, issued } = await sendDeletionCode(user);
    if (!issued) return res.status(status).json(body);
    res.json({ success: true, maskedEmail: maskEmail(user.email), expiresInSeconds: issued.expiresInSeconds });
  } catch (err) {
    console.error('[account/delete/request-code]', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: "Couldn't send a code. Please try again." });
  }
});

// POST /api/account/delete/confirm { code, confirmation }
// 200 { success: true, mediaCleanup, authCleanup } on success. Errors:
//   400 CONFIRMATION_MISMATCH (checked first, uses no attempt)
//   403 ADMIN_CANNOT_SELF_DELETE
//   400 NO_ACTIVE_CODE | 400 INVALID_CODE { attemptsRemaining } | 400 CODE_EXPIRED
//   429 TOO_MANY_ATTEMPTS (code invalidated -- request a new one)
//   500 DELETION_FAILED (nothing was deleted; the code is still valid)
router.post('/delete/confirm', authenticateAccess, confirmLimiter, async (req, res) => {
  const { code, confirmation } = req.body || {};
  const mismatch = confirmationMismatch(confirmation);
  if (mismatch) return res.status(mismatch.status).json(mismatch.body);
  let user;
  try {
    user = await loadUser(req.user.id);
  } catch (err) {
    console.error('[account/delete/confirm] lookup', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  const { status, body } = await confirmDeletion(user, code, req.app.get('io'), 'account/delete/confirm');
  res.status(status).json(body);
});

// ── Public (not signed in) ────────────────────────────────────────────

// POST /api/account/public/delete/request-code { identifier }
// 200 { success, message, expiresInSeconds } (no email shown)
// | 400 MISSING_IDENTIFIER | 404 ACCOUNT_NOT_FOUND (also SniffedOut accounts)
// | 403 ADMIN_CANNOT_SELF_DELETE | 429 RATE_LIMITED { retryAfterSeconds }
//   (3 failed lookups/IP/hour, or the account's 3 codes/hour) | 502 EMAIL_FAILED
router.post('/public/delete/request-code', publicRequestCodeLimiter, async (req, res) => {
  try {
    const found = await resolvePublicAccount(req);
    if (!found.user) return res.status(found.status).json(found.body);
    const { status, body, issued } = await sendDeletionCode(found.user);
    if (!issued) return res.status(status).json(body);
    res.json({ success: true, message: 'Code sent to your registered email', expiresInSeconds: issued.expiresInSeconds });
  } catch (err) {
    console.error('[account/public/delete/request-code]', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: "Couldn't send a code. Please try again." });
  }
});

// POST /api/account/public/delete/confirm { identifier, code, confirmation }
// Same responses as /delete/confirm, plus 400 MISSING_IDENTIFIER,
// 404 ACCOUNT_NOT_FOUND and 429 RATE_LIMITED (the failed-lookup limit, which
// lookups here count towards too). The code is checked against the account
// the identifier names, so one account's code can't delete another.
router.post('/public/delete/confirm', publicConfirmLimiter, async (req, res) => {
  const { code, confirmation } = req.body || {};
  const mismatch = confirmationMismatch(confirmation);
  if (mismatch) return res.status(mismatch.status).json(mismatch.body);
  let found;
  try {
    found = await resolvePublicAccount(req);
  } catch (err) {
    console.error('[account/public/delete/confirm] lookup', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
  if (!found.user) return res.status(found.status).json(found.body);
  const { status, body } = await confirmDeletion(found.user, code, req.app.get('io'), 'account/public/delete/confirm');
  res.status(status).json(body);
});

export default router;
