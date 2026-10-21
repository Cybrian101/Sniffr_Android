import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import UserRepo from '../models/UserRepository.js';
import PetRepo from '../models/PetRepository.js';
import {
  generateAccessToken, generateRefreshToken,
  revokeRefreshToken, revokeAllUserTokens, rotateRefreshToken,
  authenticateAccess, ACCOUNT_DELETED_BODY,
  signPurposeToken, verifyPurposeToken, sealSecret, openSecret,
  supabaseSessionIdFromToken,
} from '../middleware/auth.js';
import { disconnectUserSockets } from '../socket/chat.js';
import { isReservedName, RESERVED_NAME_MESSAGE } from '../utils/reservedNames.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import { sendPawCodeEmail, sendPasswordResetEmail, sendVerificationEmail } from '../utils/mailer.js';
import db from '../db/connection.js';
import { grantLaunchOfferIfEligible, getUserWithFreshPlanState } from '../services/subscriptionService.js';
import { sendServerError } from '../utils/errors.js';
import { logUndeliverableSecret } from '../utils/devSecrets.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { createSessionClient, getAdminClient } from '../lib/supabase.js';

const router = Router();
router.use(rateLimiter(config.RATE_LIMIT.AUTH));

// Verification/reset tokens are emailed as raw random hex, but only their
// SHA-256 hash is ever persisted -- a DB read (backup leak, SQL injection,
// etc.) can't be turned into a usable link, since the raw value that
// satisfies the hash was never stored anywhere.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// L4: Math.random() is not cryptographically secure -- its output is
// predictable enough (given a few samples) to make a 6-digit PawPrint code
// guessable without brute-forcing all million values. crypto.randomInt is.
function generatePawCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [name, domain] = email.split('@');
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  const maskedName = `${name[0]}***${name[name.length - 1]}`;
  return `${maskedName}@${domain}`;
}

// Helper: issue session tokens
// supabaseSession (optional): when the email/password path authenticated
// via Supabase Auth, pass its { access_token, refresh_token } here instead
// of minting our own -- the response envelope stays identical either way,
// so the frontend needs no knowledge of which system issued the tokens.
async function issueSession(user, req, res, extraData = {}, supabaseSession = null) {
  const io            = req.app.get('io');
  // Fresh plan-state read (not the raw `user` row) so a subscription that
  // expired since the last login is corrected right here at sign-in time,
  // same lazy-expiry path every other premium read goes through.
  const freshUser      = await getUserWithFreshPlanState(user.id, io) || user;
  const pet          = await PetRepo.getActivePet(user.id);
  const allPets      = await PetRepo.findAllByUserId(user.id);
  const deviceInfo   = req.headers['user-agent'] || 'unknown';
  const accessToken  = supabaseSession ? supabaseSession.access_token  : generateAccessToken(user);
  const refreshToken = supabaseSession ? supabaseSession.refresh_token : await generateRefreshToken(user, deviceInfo);
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      full_name: user.full_name,
      pawprint_2fa_enabled: user.pawprint_2fa_enabled ? 1 : 0,
      super_sniff_enabled: user.super_sniff_enabled ? 1 : 0,
      email_verified: user.email_verified ? 1 : 0,
      is_admin: user.is_admin,
      current_plan: freshUser.current_plan,
      subscription_status: freshUser.subscription_status,
      is_founding_member: freshUser.is_founding_member ? 1 : 0,
      welcome_slider_seen: freshUser.welcome_slider_seen ? 1 : 0,
      premium_badge_enabled: freshUser.premium_badge_enabled ? 1 : 0,
    },
    pet:  pet || null,
    allPets: allPets || [],
    accessToken,
    refreshToken,
    ...extraData
  });
}

// PawPrint (2FA) step after a correct first factor (password or Google):
// emails a Paw Code and returns a 10-minute tempToken for
// /2fa/verify-login. The tempToken is signed with its own key, so it is
// never accepted as an access token. If the first factor produced a
// Supabase session (email/password accounts), that session rides along
// ENCRYPTED in the token -- a JWT payload is readable by whoever holds it,
// and the session must not be usable before the code is checked.
const PAWPRINT_LOGIN_PURPOSE = '2fa_login';
async function startPawPrintChallenge(user, supabaseSession = null) {
  const code = generatePawCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await UserRepo.setPawCode(user.id, hashToken(code), expiresAt);
  logUndeliverableSecret(`PawPrint code for user #${user.id}`, code);
  sendPawCodeEmail(user.email, code).catch(err => console.error("[sendPawCodeEmail error]:", err.message));

  const payload = { id: user.id };
  if (supabaseSession?.access_token) {
    payload.ss = sealSecret(PAWPRINT_LOGIN_PURPOSE, { a: supabaseSession.access_token, r: supabaseSession.refresh_token });
  }
  const tempToken = signPurposeToken(PAWPRINT_LOGIN_PURPOSE, payload, '10m');
  return { requires2FA: true, tempToken, email: maskEmail(user.email) };
}

// Helper: find or prepare social user prefill
async function findOrPrepSocialUser(email, fullName, provider) {
  const existing = await UserRepo.findByEmail(email);
  if (existing) return { user: existing, isNew: false };
  return { user: null, isNew: true, prefill: { email, full_name: fullName || '', provider } };
}

// Helper: validate password complexity
function validatePassword(password) {
  if (!password || password.length < 8 || password.length > 20) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^a-zA-Z0-9]/.test(password)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// EMAIL VERIFICATION — shared cooldown-guarded sender
// ═══════════════════════════════════════════════════════════════
// Shared cooldown tracker: userId -> timestamp of last send. Used by
// BOTH the automatic signup send and manual resend clicks, so there is
// only ever ONE source of truth for "when was the last email sent" —
// this guarantees only one active token can exist and that a rapid
// double-click (or a race between auto-send and a fast manual click)
// cannot generate two different tokens in quick succession.
const verificationCooldowns = new Map();
const VERIFICATION_COOLDOWN_MS = 60 * 1000; // 60 seconds

async function triggerVerificationEmail(user, options = {}) {
  const { isWelcome = false } = options;
  const now = Date.now();
  const lastSent = verificationCooldowns.get(user.id);

  if (lastSent && now - lastSent < VERIFICATION_COOLDOWN_MS) {
    return {
      sent: false,
      throttled: true,
      cooldownUntil: lastSent + VERIFICATION_COOLDOWN_MS,
    };
  }

  // Record the cooldown SYNCHRONOUSLY, before any await below. This is
  // what closes the race window: even if two calls arrive back-to-back
  // (e.g. signup's auto-send and an immediate manual click), the second
  // one will see this Map entry already set and be rejected above,
  // since there is no `await` between the check and this line.
  const cooldownUntil = now + VERIFICATION_COOLDOWN_MS;
  verificationCooldowns.set(user.id, now);

  // Fire-and-forget: the token write + actual email delivery happen in the
  // background instead of being awaited by the caller. A slow or
  // misconfigured SMTP connection (or a slow DNS/TCP handshake to the mail
  // provider) used to block the ENTIRE signup/login response until it
  // resolved or timed out -- the account was already committed to the DB
  // by then, but the browser never got a response back to apply the
  // session, which is exactly what looked like "saved in Supabase but the
  // site never updated, had to refresh and log in".
  (async () => {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
      await db.run(
        'UPDATE users SET email_verify_token = ?, email_verify_expires_at = ? WHERE id = ?',
        [hashToken(token), expiresAt, user.id]
      );
      const verifyLink = `${config.CLIENT_URL}/verify-email?token=${token}`;
      // Printed only in local development without SMTP; never in production.
      logUndeliverableSecret(`email verification link for user #${user.id}`, verifyLink);
      await sendVerificationEmail(user.email, verifyLink, { isWelcome, fullName: user.full_name });
    } catch (err) {
      console.error('[triggerVerificationEmail error]:', err.message);
    }
  })();

  return { sent: true, throttled: false, cooldownUntil };
}

const VERIFY_REMINDER_TYPE = 'email_verify_reminder';
const VERIFY_REMINDER_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000; // don't nag someone who just signed up

async function maybeSendVerifyReminder(user, io) {
  const accountAge = Date.now() - new Date(user.created_at).getTime();
  if (accountAge < VERIFY_REMINDER_MIN_ACCOUNT_AGE_MS) return;

  const recent = await db.get(
    "SELECT id FROM notifications WHERE user_id = ? AND type = ? AND created_at > (NOW() - INTERVAL '7 days') LIMIT 1",
    [user.id, VERIFY_REMINDER_TYPE]
  );
  if (recent) return;

  await sendRealtimeNotification(io, user.id, {
    category: 'activity',
    type: VERIFY_REMINDER_TYPE,
    title: '📧 Verify your email',
    description: "You haven't verified your email yet — verify it to keep your account secure and unlock PawPrint Verification.",
  });
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE  /api/auth/google
// ═══════════════════════════════════════════════════════════════
// The email (and name) always come from Google's answer about a token the
// client got from Google -- never from the request body. Two token kinds:
//   credential:  an ID token (One Tap / the GIS button), checked with
//                tokeninfo?id_token= (signature, expiry, issuer);
//   accessToken: an OAuth access token (the "Continue with Google" popup,
//                initTokenClient), checked with tokeninfo?access_token=.
// Either way the token must have been issued to OUR client id (aud) --
// tokeninfo happily "verifies" tokens issued to any other app -- and the
// email must be verified by Google.
class GoogleAuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function fetchGoogleJson(url, options = {}) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, body };
}

async function verifyGoogleIdentity({ credential, accessToken }) {
  if (!config.GOOGLE_CLIENT_ID) {
    console.error('[/auth/google] GOOGLE_CLIENT_ID is not configured -- refusing to verify Google tokens');
    throw new GoogleAuthError(503, 'GOOGLE_NOT_CONFIGURED', 'Google Sign-In is not available right now.');
  }
  const invalid = () => new GoogleAuthError(401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in could not be verified. Please try again.');
  let payload;
  if (typeof credential === 'string' && credential) {
    const { ok, body } = await fetchGoogleJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!ok || body.error) throw invalid();
    if (body.iss !== 'https://accounts.google.com' && body.iss !== 'accounts.google.com') throw invalid();
    payload = body;
  } else if (typeof accessToken === 'string' && accessToken) {
    const { ok, body } = await fetchGoogleJson(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!ok || body.error || !(Number(body.expires_in) > 0)) throw invalid();
    payload = body;
  } else {
    throw new GoogleAuthError(400, 'MISSING_CREDENTIAL', 'Google sign-in token is missing.');
  }
  if (payload.aud !== config.GOOGLE_CLIENT_ID) {
    throw new GoogleAuthError(401, 'WRONG_AUDIENCE', 'Google sign-in could not be verified. Please try again.');
  }
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new GoogleAuthError(401, 'EMAIL_NOT_VERIFIED', "Google account's email is not verified");
  }
  if (!payload.email || !payload.sub) throw new GoogleAuthError(400, 'NO_EMAIL', 'Could not extract email from Google account');

  let name = payload.name || '';
  if (!name && accessToken) {
    // The access-token tokeninfo has no name; ask Google's userinfo with the
    // same (already verified) token. Best effort: the name is only a prefill.
    try {
      const { ok, body } = await fetchGoogleJson('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (ok && body.sub === payload.sub && typeof body.name === 'string') name = body.name;
    } catch { /* no name */ }
  }
  return { email: payload.email, name };
}

router.post('/google', async (req, res) => {
  try {
    const { email: googleEmail, name } = await verifyGoogleIdentity(req.body || {});
    // M1: Google normally returns a lowercase email anyway, but normalize
    // explicitly rather than relying on that -- this is the one place a
    // Google-sourced email enters the system, and everything downstream
    // (the signup ticket, /social-complete) reads it from here.
    const email = googleEmail.trim().toLowerCase();

    const { user, isNew, prefill } = await findOrPrepSocialUser(email, name, 'google');
    if (!isNew) {
      // Same PawPrint step as the password login: Google is the first
      // factor, the emailed code the second.
      const deviceToken = req.headers['x-device-token'] || req.body.deviceToken;
      if (user.pawprint_2fa_enabled === 1 && !(await UserRepo.isDeviceTrusted(user.id, deviceToken))) {
        return res.json(await startPawPrintChallenge(user));
      }
      return await issueSession(user, req, res);
    }
    // New account: /social-complete needs proof that this request came
    // from a verified Google sign-in for THIS email.
    const signupTicket = signPurposeToken('google_signup', { email, name }, '30m');
    return res.status(200).json({ needsSignup: true, prefill, signupTicket });

  } catch (err) {
    if (err instanceof GoogleAuthError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.name === 'TimeoutError') return res.status(503).json({ error: 'TIMEOUT', message: 'Google verification timed out' });
    console.error('[/auth/google]', err.message);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Google authentication encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SOCIAL COMPLETE
// Google already verifies the person's email ownership before we ever
// see it, so accounts created via this path are auto-verified.
// (Apple Sign-In removed for now -- was never wired into the frontend UI,
// see git history if it needs to come back later.)
// ═══════════════════════════════════════════════════════════════
router.post('/social-complete', async (req, res) => {
  try {
    const { signupTicket, username } = req.body;
    // The email comes only from the ticket /auth/google issued after
    // verifying the Google token -- never from the request body.
    let ticket;
    try {
      ticket = verifyPurposeToken('google_signup', signupTicket);
    } catch {
      return res.status(401).json({ error: 'SIGNUP_TICKET_INVALID', message: 'Your Google sign-in has expired. Please continue with Google again.' });
    }
    const email = ticket.email;
    const full_name = typeof req.body.full_name === 'string' && req.body.full_name.trim() ? req.body.full_name.trim() : (ticket.name || '');
    if (!email) return res.status(401).json({ error: 'SIGNUP_TICKET_INVALID', message: 'Your Google sign-in has expired. Please continue with Google again.' });
    if (typeof username !== 'string' || !username) return res.status(400).json({ error: 'MISSING_FIELDS', field: 'username', message: 'Username is required.' });
    if (isReservedName(username)) return res.status(400).json({ error: 'RESERVED_NAME', field: 'username', message: RESERVED_NAME_MESSAGE });
    // Same format rule as /signup.
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
      return res.status(400).json({ error: 'INVALID_USERNAME', field: 'username', message: 'Username must be 4–20 characters and contain only letters, numbers, and underscores.' });
    }
    if (isReservedName(full_name)) return res.status(400).json({ error: 'RESERVED_NAME', field: 'full_name', message: RESERVED_NAME_MESSAGE });

    if (await UserRepo.findByEmail(email))       return res.status(409).json({ error: 'EMAIL_EXISTS',    message: 'Looks like this pet parent is already part of Sniffr. Try signing in instead.' });
    if (await UserRepo.findByUsername(username)) return res.status(409).json({ error: 'USERNAME_TAKEN',  message: '🐾 Oops! That pet tag is already taken. Try another one.' });

    const password_hash = await bcrypt.hash(Math.random().toString(36) + Date.now() + Math.random(), 12);
    const user = await UserRepo.create({ email, username, password_hash, full_name: full_name || username });
    await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]);
    user.email_verified = 1;

    return await issueSession(user, req, res);
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Social profile setup encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STANDARD EMAIL / PASSWORD SIGN UP
// ═══════════════════════════════════════════════════════════════
router.post('/signup', async (req, res) => {
  try {
    const { password, confirmPassword, username, full_name } = req.body;
    // M1: store emails normalized (trimmed + lowercase) so a later Google
    // sign-in for the same address (Google always hands back lowercase)
    // can't create a duplicate account next to this one, and so this
    // account itself can log in regardless of the case it's typed in --
    // UserRepository.findByEmail now also compares case-insensitively as a
    // second layer, for rows that predate this normalization.
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : req.body.email;
    const errors = [];

    // 1. Full Name Validation
    if (!full_name || !full_name.trim()) {
      errors.push({ field: 'full_name', message: 'Full name is required.' });
    } else if (!/[a-zA-Z]/.test(full_name)) {
      errors.push({ field: 'full_name', message: 'Full name cannot contain numbers or special characters only.' });
    } else if (isReservedName(full_name)) {
      errors.push({ field: 'full_name', message: RESERVED_NAME_MESSAGE });
    }

    // 2. Username Validation
    if (!username || !username.trim()) {
      errors.push({ field: 'username', message: 'Username is required.' });
    } else if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
      errors.push({ field: 'username', message: 'Username must be 4–20 characters and contain only letters, numbers, and underscores.' });
    } else if (isReservedName(username)) {
      errors.push({ field: 'username', message: RESERVED_NAME_MESSAGE });
    } else if (await UserRepo.findByUsername(username)) {
      errors.push({ field: 'username', message: '🐾 Oops! That pet tag is already taken. Try another one.' });
    }

    // 3. Email Validation
    if (!email || !email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ field: 'email', message: "🐾 That doesn't look like a valid email. Check the address and try again." });
    } else if (await UserRepo.findByEmail(email)) {
      errors.push({ field: 'email', message: '🐾 Looks like this pet parent is already part of Sniffr. Try signing in instead.' });
    }

    // 4. Password Validation
    if (!password || !validatePassword(password)) {
      errors.push({
        field: 'password',
        message: '🐾 Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character'
      });
    }

    // 5. Confirm Password Validation
    if (password !== confirmPassword) {
      errors.push({ field: 'confirmPassword', message: "🐾 Those passwords don't match. Give it another sniff." });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    }

    // Password custody now lives in Supabase Auth, not this app -- create
    // the Supabase identity first (source of truth for the credential),
    // then our own users row links to it via auth_user_id. email_confirm:
    // true means Supabase itself won't send its own confirmation email;
    // our existing custom-branded verification flow (triggerVerificationEmail
    // below) still runs exactly as before and still gates whatever features
    // email_verified controls -- the two are deliberately independent.
    const { data: authData, error: authErr } = await getAdminClient().auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authErr || !authData?.user) {
      console.error('[signup] Supabase Auth user creation failed:', authErr?.message);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Registration encountered a problem.' });
    }

    // password_hash is schema-required (NOT NULL) but never read for a
    // Supabase-backed account (auth_user_id set) -- same "unusable random
    // hash" placeholder already used for Google/Apple social signups.
    const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const user = await UserRepo.create({ email, username, password_hash, full_name: full_name.trim() });
    await db.run('UPDATE users SET auth_user_id = ? WHERE id = ?', [authData.user.id, user.id]);
    user.auth_user_id = authData.user.id;

    // Launch offer: first 100 signups get free Sniffr Gold. COUNT(*) here
    // includes the row just inserted above, so "count <= limit" is exactly
    // "this user is among the first `limit` ever created" -- see
    // grantLaunchOfferIfEligible for the exact boundary logic.
    await grantLaunchOfferIfEligible(user.id, req.app.get('io'));

    // Automatic welcome + verification email. isWelcome:true gives the
    // first-time-user version with the warm welcome copy; any later
    // manual resend (see /resend-verification below) uses the plain
    // version instead, since by then they're not "new" anymore.
    const verificationResult = await triggerVerificationEmail(user, { isWelcome: true });

    // Real session, minted by Supabase (admin.createUser doesn't return one).
    const { data: signInData, error: signInErr } = await createSessionClient().auth.signInWithPassword({ email, password });
    if (signInErr || !signInData?.session) {
      console.error('[signup] Post-signup sign-in failed:', signInErr?.message);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Account created, but starting your session failed -- please sign in.' });
    }

    return await issueSession(user, req, res, { verificationCooldownUntil: verificationResult.cooldownUntil }, signInData.session);
  } catch (err) {
    console.error('[signup]', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Registration encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EMAIL VERIFICATION ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/auth/verify-email?token=...
//
// Idempotent by design: this used to NULL out email_verify_token the
// instant it succeeded, which made a SECOND hit on the exact same link a
// guaranteed "invalid/already used" failure. That second hit isn't rare --
// React StrictMode double-invokes effects in dev (VerifyEmailPage.jsx now
// also guards against that directly), and in production, plenty of email
// clients/security gateways (Outlook Safe Links, corporate scanners, some
// antivirus) GET every link in an email to pre-scan it for safety BEFORE
// the user ever clicks, silently consuming a single-use token. Either way
// the real user's own click used to land on a false "failed" screen for a
// link that had, from the server's point of view, already succeeded.
// Fix: once a token verifies an account, it keeps working (returns the same
// success) for as long as it would have anyway -- hashToken is still the
// only way to produce a match, and a fresh resend overwrites it immediately
// (routes/auth.js's triggerVerificationEmail), so "one real link active at
// a time" already holds without needing to burn the token on first use.
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'MISSING_TOKEN', message: 'Verification token is required.' });

    const user = await db.get('SELECT * FROM users WHERE email_verify_token = ? AND deleted_at IS NULL', [hashToken(token)]);
    if (!user) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'This verification link is invalid. Please request a new one.' });
    }

    // Already used (by this exact link, a prefetch, or a StrictMode double-
    // fire) -- same success response, no further DB write needed.
    if (user.email_verified) {
      return res.json({ success: true, message: '🐾 Your email has been verified successfully!' });
    }

    if (!user.email_verify_expires_at || new Date(user.email_verify_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_TOKEN', message: 'This verification link has expired. Please request a new one.' });
    }

    await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]);

    return res.json({ success: true, message: '🐾 Your email has been verified successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Email verification encountered a problem.' });
  }
});

// POST /api/auth/resend-verification  (authenticated)
router.post('/resend-verification', authenticateAccess, async (req, res) => {
  try {
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (user.email_verified) {
      return res.json({ success: true, alreadyVerified: true, message: 'Your email is already verified! 🐾' });
    }

    const result = await triggerVerificationEmail(user);
    if (result.throttled) {
      const waitSeconds = Math.ceil((result.cooldownUntil - Date.now()) / 1000);
      return res.status(429).json({
        error: 'COOLDOWN',
        message: `Please wait ${waitSeconds}s before requesting another verification email.`,
        cooldownUntil: result.cooldownUntil,
        waitSeconds
      });
    }

    return res.json({ success: true, message: '🐾 Verification email sent! Please check your inbox.', cooldownUntil: result.cooldownUntil });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to resend verification email.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STANDARD EMAIL / PASSWORD SIGN IN
// ═══════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const identifier = req.body.email || req.body.username || req.body.emailOrUsername;
    const password = req.body.password;
    const deviceToken = req.headers['x-device-token'] || req.body.deviceToken;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: "🐾 Looks like something's missing." });
    }

    let user = null;
    if (identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier);
    }
    if (!user) {
      user = await UserRepo.findByUsername(identifier);
    }
    if (!user && !identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier);
    }

    // L4: one generic response for "no such account" and "wrong password" --
    // two different error codes/messages here let anyone probe which
    // emails/usernames have a Sniffr account by watching which one comes
    // back (the forgot-password flow already avoids this same mistake, see
    // its genericResponse below). The client already treats NOT_FOUND and
    // BAD_PASSWORD identically (AuthPage.jsx, api.js), so reusing NOT_FOUND
    // for both needs no client change.
    const invalidCredentials = () => res.status(401).json({ error: 'NOT_FOUND', message: "🐾 That email/username or password doesn't match our records. Give it another sniff." });

    if (!user) {
      return invalidCredentials();
    }

    // Migrated (or newly signed-up) accounts have auth_user_id set and
    // authenticate via Supabase Auth. Accounts not yet migrated (the
    // one-time migration script hasn't run for them yet) fall back to the
    // original bcrypt check -- this is what makes the migration safe to
    // run without forcing every existing user to reset their password.
    let supabaseSession = null;
    if (user.auth_user_id) {
      const { data, error } = await createSessionClient().auth.signInWithPassword({ email: user.email, password });
      if (error || !data?.session) {
        return invalidCredentials();
      }
      supabaseSession = data.session;
    } else if (!(await bcrypt.compare(password, user.password_hash))) {
      return invalidCredentials();
    }

    // Check PawPrint 2FA
    if (user.pawprint_2fa_enabled === 1) {
      if (!(await UserRepo.isDeviceTrusted(user.id, deviceToken))) {
        return res.json(await startPawPrintChallenge(user, supabaseSession));
      }
    }

    return await issueSession(user, req, res, {}, supabaseSession);
  } catch (err) {
    console.error('[LOGIN ERROR]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Sign in encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAWPRINT VERIFICATION (2FA) ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Shared cooldown tracker for the "send a code to enable PawPrint" step --
// same synchronous-set-before-await shape as verificationCooldowns
// elsewhere in this file, so a rapid double-tap can't generate two
// different codes for the same pair of requests.
const pawprintEnableCodeCooldowns = new Map(); // userId -> last-sent timestamp
const PAWPRINT_ENABLE_CODE_COOLDOWN_MS = 60 * 1000;

// Brute-force guard shared by both code-verification endpoints
// (/2fa/verify-enable and /2fa/verify-login) -- a 6-digit code is only
// ~1e6 possibilities, so without this a script could just try all of them
// inside the 10-minute window. After PAW_CODE_MAX_ATTEMPTS wrong guesses,
// the account is locked out of verifying (existing or future codes) for
// PAW_CODE_LOCKOUT_MS regardless of how many new codes get requested in the
// meantime -- requesting a new code does not clear an active lock.
const pawCodeAttempts = new Map(); // userId -> { count, lockedUntil }
const PAW_CODE_MAX_ATTEMPTS = 5;
const PAW_CODE_LOCKOUT_MS = 15 * 60 * 1000;

function pawCodeLockSecondsRemaining(userId) {
  const rec = pawCodeAttempts.get(userId);
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}

function registerPawCodeFailure(userId) {
  const rec = pawCodeAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= PAW_CODE_MAX_ATTEMPTS) {
    rec.count = 0;
    rec.lockedUntil = Date.now() + PAW_CODE_LOCKOUT_MS;
  }
  pawCodeAttempts.set(userId, rec);
}

function clearPawCodeAttempts(userId) {
  pawCodeAttempts.delete(userId);
}

// 1. Send Paw Code for Enablement, or -- purpose:'disable' -- for disabling
// (Authenticated). The 'disable' purpose is what H1's second sub-issue
// needs: /2fa/disable below requires re-proving identity (password OR a
// fresh code) instead of trusting the existing session outright, and a
// user without a usable password (e.g. Google/Supabase accounts whose
// password field is an unusable random placeholder) needs a code-based way
// to do that too.
router.post('/2fa/send-code', authenticateAccess, async (req, res) => {
  try {
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    const forDisable = req.body?.purpose === 'disable';
    if (!user.pawprint_2fa_enabled && forDisable) {
      return res.status(400).json({ error: 'NOT_ENABLED', message: 'PawPrint Verification is not enabled.' });
    }
    if (user.pawprint_2fa_enabled && !forDisable) {
      return res.json({ success: true, alreadyEnabled: true, message: 'PawPrint Verification is already enabled! 🐾' });
    }
    if (!user.email_verified) {
      return res.status(400).json({ error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your account email first, then enable PawPrint.' });
    }

    const now = Date.now();
    const lastSent = pawprintEnableCodeCooldowns.get(user.id);
    if (lastSent && now - lastSent < PAWPRINT_ENABLE_CODE_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((lastSent + PAWPRINT_ENABLE_CODE_COOLDOWN_MS - now) / 1000);
      return res.status(429).json({
        error: 'COOLDOWN',
        message: `Please wait ${waitSeconds}s before requesting another code.`,
        cooldownUntil: lastSent + PAWPRINT_ENABLE_CODE_COOLDOWN_MS,
        waitSeconds,
      });
    }
    pawprintEnableCodeCooldowns.set(user.id, now);

    const code = generatePawCode();
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString(); // 10 mins
    await UserRepo.setPawCode(user.id, hashToken(code), expiresAt);

    logUndeliverableSecret(`PawPrint code for user #${user.id}`, code);
    sendPawCodeEmail(user.email, code).catch(err => console.error("[sendPawCodeEmail error]:", err.message));

    return res.json({ success: true, message: 'Paw Code sent to your registered email.', cooldownUntil: now + PAWPRINT_ENABLE_CODE_COOLDOWN_MS });
  } catch (err) {
    console.error('[/2fa/send-code error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to send Paw Code.' });
  }
});

// 2. Verify Code & Enable 2FA (Authenticated)
router.post('/2fa/verify-enable', authenticateAccess, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'MISSING_CODE', message: 'Please enter the Paw Code.' });
    }

    const lockedSeconds = pawCodeLockSecondsRemaining(req.user.id);
    if (lockedSeconds > 0) {
      return res.status(429).json({ error: 'LOCKED', message: `Too many incorrect attempts. Try again in ${lockedSeconds}s.`, waitSeconds: lockedSeconds });
    }

    const pawData = await UserRepo.getPawCode(req.user.id);
    if (!pawData || !pawData.paw_code) {
      return res.status(400).json({ error: 'INVALID_CODE', message: 'No verification code requested. Please request a new code.' });
    }

    if (pawData.paw_code !== hashToken(code.trim())) {
      registerPawCodeFailure(req.user.id);
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    if (!pawData.paw_code_expires_at || new Date(pawData.paw_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    await UserRepo.set2FAStatus(req.user.id, 1);
    await UserRepo.clearPawCode(req.user.id);
    clearPawCodeAttempts(req.user.id);

    // H1: this request's own bearer token just proved both factors (an
    // already-authenticated session + the code just checked above) in THIS
    // session, so mark it PawPrint-verified immediately -- otherwise a
    // Supabase-backed user who enables 2FA mid-session would find their very
    // next request rejected by middleware/auth.js's new 2FA-session check,
    // since this live session never went through /2fa/verify-login (2FA
    // wasn't on yet when it started). A no-op for non-Supabase sessions
    // (supabaseSessionIdFromToken returns null for our own custom JWTs).
    const sessionId = supabaseSessionIdFromToken(req.headers.authorization.split(' ')[1]);
    if (sessionId) await UserRepo.markPawprintSessionVerified(sessionId, req.user.id);

    return res.json({ success: true, message: 'PawPrint Verification enabled successfully! 🐾' });
  } catch (err) {
    console.error('[/2fa/verify-enable error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to verify Paw Code.' });
  }
});

// 3. Disable 2FA (Authenticated) -- H1's second sub-issue: this used to
// trust the existing session alone, so a hijacked/left-open session (the
// exact scenario 2FA exists to protect against) could turn off 2FA with no
// further proof. Now requires re-proving identity in THIS request: either
// the account password, or a fresh Paw Code (POST /2fa/send-code with
// { purpose: 'disable' }) -- the code option covers accounts whose password
// field is an unusable random placeholder (Google/social sign-up).
router.post('/2fa/disable', authenticateAccess, async (req, res) => {
  try {
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (!user.pawprint_2fa_enabled) {
      return res.json({ success: true, message: 'PawPrint Verification is already disabled.' });
    }

    const { password, code } = req.body || {};
    if (!password && !code) {
      return res.status(400).json({ error: 'REAUTH_REQUIRED', message: 'Enter your password or a fresh Paw Code to disable PawPrint Verification.' });
    }

    if (password) {
      const valid = user.auth_user_id
        ? !(await createSessionClient().auth.signInWithPassword({ email: user.email, password })).error
        : await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Incorrect password.' });
      }
    } else {
      const lockedSeconds = pawCodeLockSecondsRemaining(req.user.id);
      if (lockedSeconds > 0) {
        return res.status(429).json({ error: 'LOCKED', message: `Too many incorrect attempts. Try again in ${lockedSeconds}s.`, waitSeconds: lockedSeconds });
      }
      const pawData = await UserRepo.getPawCode(req.user.id);
      if (!pawData?.paw_code || pawData.paw_code !== hashToken(String(code).trim())) {
        registerPawCodeFailure(req.user.id);
        return res.status(400).json({ error: 'INVALID_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
      }
      if (!pawData.paw_code_expires_at || new Date(pawData.paw_code_expires_at) < new Date()) {
        return res.status(400).json({ error: 'EXPIRED_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
      }
    }

    await UserRepo.set2FAStatus(req.user.id, 0);
    await UserRepo.clearPawCode(req.user.id);
    await UserRepo.clearTrustedDevices(req.user.id);
    await UserRepo.clearPawprintVerifiedSessions(req.user.id);
    clearPawCodeAttempts(req.user.id);
    return res.json({ success: true, message: 'PawPrint Verification disabled.' });
  } catch (err) {
    console.error('[/2fa/disable error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to disable PawPrint Verification.' });
  }
});

// 4. Verify 2FA on Login (Public with tempToken)
router.post('/2fa/verify-login', async (req, res) => {
  try {
    const { tempToken, code, trustDevice } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Missing token or verification code.' });
    }

    let decoded;
    try {
      decoded = verifyPurposeToken(PAWPRINT_LOGIN_PURPOSE, tempToken);
    } catch (err) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Verification session expired. Please sign in again.' });
    }

    if (!Number.isInteger(decoded.id)) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Invalid verification session.' });
    }

    const user = await UserRepo.findById(decoded.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (user.deleted_at) return res.status(401).json(ACCOUNT_DELETED_BODY);

    const lockedSeconds = pawCodeLockSecondsRemaining(user.id);
    if (lockedSeconds > 0) {
      return res.status(429).json({ error: 'LOCKED', message: `Too many incorrect attempts. Try again in ${lockedSeconds}s.`, waitSeconds: lockedSeconds });
    }

    const pawData = await UserRepo.getPawCode(user.id);
    if (!pawData || !pawData.paw_code || pawData.paw_code !== hashToken(code.trim())) {
      registerPawCodeFailure(user.id);
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    if (!pawData.paw_code_expires_at || new Date(pawData.paw_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    // Code is valid! Clear code.
    await UserRepo.clearPawCode(user.id);
    clearPawCodeAttempts(user.id);

    let newDeviceToken = null;
    if (trustDevice) {
      newDeviceToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      const deviceInfo = req.headers['user-agent'] || 'Browser';
      await UserRepo.addTrustedDevice(user.id, newDeviceToken, deviceInfo, expiresAt);
    }

    let supabaseSession = null;
    if (decoded.ss) {
      try {
        const s = openSecret(PAWPRINT_LOGIN_PURPOSE, decoded.ss);
        supabaseSession = { access_token: s.a, refresh_token: s.r };
      } catch {
        return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Verification session expired. Please sign in again.' });
      }
      // H1: the whole point of this route -- this Supabase session only
      // becomes usable (middleware/auth.js's resolveUserFromToken) once its
      // owner has actually proved the second factor, which is exactly now.
      const sessionId = supabaseSessionIdFromToken(supabaseSession.access_token);
      if (sessionId) await UserRepo.markPawprintSessionVerified(sessionId, user.id);
    }
    return await issueSession(user, req, res, { deviceToken: newDeviceToken }, supabaseSession);
  } catch (err) {
    console.error('[/2fa/verify-login error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Verification failed.' });
  }
});

// 5. Resend Code (Public or Auth)
// L4: unlike /2fa/send-code, this previously had no per-account cooldown at
// all -- only the general per-IP/per-route limiter (config.RATE_LIMIT.AUTH,
// 20/min) stood between a client holding a valid tempToken and unlimited
// resend calls, each emailing the account's owner a fresh code. Reuses the
// same cooldown map/window as the enable-code path.
router.post('/2fa/resend-code', async (req, res) => {
  try {
    const { tempToken } = req.body;
    let userId = null;

    if (tempToken) {
      try {
        const decoded = verifyPurposeToken(PAWPRINT_LOGIN_PURPOSE, tempToken);
        userId = decoded.id;
      } catch {
        return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Verification session expired. Please sign in again.' });
      }
    } else {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
          userId = decoded.id;
        } catch {}
      }
    }

    if (!userId) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Cannot resend code. Please try again.' });
    }

    const user = await UserRepo.findById(userId);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (user.deleted_at) return res.status(401).json(ACCOUNT_DELETED_BODY);

    const now = Date.now();
    const lastSent = pawprintEnableCodeCooldowns.get(user.id);
    if (lastSent && now - lastSent < PAWPRINT_ENABLE_CODE_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((lastSent + PAWPRINT_ENABLE_CODE_COOLDOWN_MS - now) / 1000);
      return res.status(429).json({
        error: 'COOLDOWN',
        message: `Please wait ${waitSeconds}s before requesting another code.`,
        cooldownUntil: lastSent + PAWPRINT_ENABLE_CODE_COOLDOWN_MS,
        waitSeconds,
      });
    }
    pawprintEnableCodeCooldowns.set(user.id, now);

    const code = generatePawCode();
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    await UserRepo.setPawCode(user.id, hashToken(code), expiresAt);

    logUndeliverableSecret(`PawPrint code (resent) for user #${user.id}`, code);
    sendPawCodeEmail(user.email, code).catch(err => console.error("[sendPawCodeEmail error]:", err.message));

    return res.json({ success: true, message: 'A new Paw Code has been sent to your registered email.', cooldownUntil: now + PAWPRINT_ENABLE_CODE_COOLDOWN_MS });
  } catch (err) {
    console.error('[/2fa/resend-code error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to resend Paw Code.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: "🐾 Looks like something's missing." });
    }

    let user = null;
    if (identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier.trim());
    }
    if (!user) {
      user = await UserRepo.findByUsername(identifier.trim());
    }
    if (!user && !identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier.trim());
    }

    // Always return the same generic success response whether or not the
    // identifier matched a real account -- a 404 here would let anyone
    // enumerate which emails/usernames have a Sniffr account by watching
    // the response code, which the reset flow itself has no other reason
    // to reveal.
    const genericResponse = { message: "🐾 If that account exists, a password reset link has been sent to its linked email. Check your inbox and follow the instructions." };

    if (!user) {
      return res.json(genericResponse);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour expiry
    await UserRepo.updateResetToken(user.id, hashToken(token), expiresAt);

    const resetLink = `${config.CLIENT_URL}/reset-password?token=${token}`;
    logUndeliverableSecret(`password reset link for user #${user.id}`, resetLink);
    await sendPasswordResetEmail(user.email, resetLink);

    return res.json(genericResponse);
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Forgot password operation encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// RESET PASSWORD
// ═══════════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'NO_TOKEN', message: "🐾 That password reset link is invalid or has expired. Give it another sniff." });
    }

    const user = await UserRepo.findByResetToken(hashToken(token));
    if (!user || new Date(user.reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: "🐾 That password reset link is invalid or has expired. Give it another sniff." });
    }

    const errors = [];

    // Validate Password
    if (!password || !validatePassword(password)) {
      errors.push({
        field: 'password',
        message: '🐾 Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character'
      });
    }

    // Validate Confirm Password
    if (password !== confirmPassword) {
      errors.push({ field: 'confirmPassword', message: "🐾 Those passwords don't match. Give it another sniff." });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    }

    if (user.auth_user_id) {
      // Migrated/Supabase-backed account -- the real password lives in
      // Supabase now. password_hash is still updated too (harmless, keeps
      // the NOT NULL column populated) but is never read for this account.
      const { error } = await getAdminClient().auth.admin.updateUserById(user.auth_user_id, { password });
      if (error) {
        console.error('[reset-password] Supabase update failed:', error.message);
        return res.status(500).json({ error: 'SERVER_ERROR', message: 'Password reset encountered a problem.' });
      }
      // Note: Supabase has no "revoke all sessions by user id" without an
      // existing valid access token to submit (this is a forgot-password
      // flow -- the user has none). Already-issued access tokens remain
      // valid until their own (short) expiry; only future refreshes are
      // blocked once a new password is set. See change-password below for
      // the fully-revoking version, usable when the user has an active
      // session token to pass along.
    } else {
      const password_hash = await bcrypt.hash(password, 12);
      await UserRepo.updatePassword(user.id, password_hash);
      // Legacy (non-Supabase) accounts: a password reset is often done
      // *because* the account is suspected compromised, so revoke every
      // outstanding refresh token now -- otherwise a token an attacker
      // already stole stays valid straight through the reset. No "keep
      // this device logged in" carve-out is possible here (unlike
      // change-password below) since this flow has no live session to
      // exempt in the first place.
      await revokeAllUserTokens(user.id);
    }
    await UserRepo.clearResetToken(user.id);

    // L3: force-close any socket still open under the old credentials (e.g.
    // a session left logged in on another device) -- see the longer note on
    // the same call in change-password below. Best-effort regardless of
    // path; the password reset itself already succeeded either way.
    disconnectUserSockets(req.app.get('io'), user.id);

    return res.json({ message: "🐾 Password updated successfully. Try signing in!" });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Password reset encountered a problem.' });
  }
});

// ── Change Password ─────────────────────────────────────────
router.post('/change-password', authenticateAccess, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    if (!currentPassword) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors: [{ field: 'currentPassword', message: 'Current password is required' }] });
    }

    if (user.auth_user_id) {
      const { error: verifyErr } = await createSessionClient().auth.signInWithPassword({ email: user.email, password: currentPassword });
      if (verifyErr) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', errors: [{ field: 'currentPassword', message: 'Incorrect current password' }] });
      }
    } else if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors: [{ field: 'currentPassword', message: 'Incorrect current password' }] });
    }

    const errors = [];
    if (!newPassword || !validatePassword(newPassword)) {
      errors.push({
        field: 'newPassword',
        message: 'Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character'
      });
    }

    if (newPassword !== confirmPassword) {
      errors.push({ field: 'confirmPassword', message: "Passwords don't match." });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    }

    if (user.auth_user_id) {
      const { error } = await getAdminClient().auth.admin.updateUserById(user.auth_user_id, { password: newPassword });
      if (error) return sendServerError(res, new Error(error.message));
      // Unlike reset-password, we DO have a live access token here -- use
      // it to revoke every OTHER session for this user right now (closes
      // the exact gap flagged earlier: a stolen session staying valid
      // through a password change), while leaving the device that just
      // made this request logged in ('others', not 'global' -- the user
      // shouldn't be logged out of their own change-password action).
      // Best-effort: the password change itself already succeeded
      // regardless of this outcome.
      const accessToken = req.headers.authorization?.split(' ')[1];
      if (accessToken) {
        await getAdminClient().auth.admin.signOut(accessToken, 'others').catch(err => {
          console.error('[change-password] Supabase signOut failed:', err.message);
        });
      }
    } else {
      const password_hash = await bcrypt.hash(newPassword, 12);
      await UserRepo.updatePassword(user.id, password_hash);
      // Legacy accounts' refresh tokens are our own (not Supabase's), and
      // this request only carries the short-lived access token -- there's
      // no clean way to identify "just this device" to exempt the way the
      // Supabase branch above does with 'others' scope, so every refresh
      // token is revoked, this device included. The access token that just
      // authenticated this request still works until its own ~15min expiry;
      // after that, even this device needs to log in again -- an acceptable
      // trade-off against leaving a stolen refresh token valid indefinitely.
      await revokeAllUserTokens(user.id);
    }

    // L3: a socket opened before this change keeps running on its original
    // handshake -- Socket.IO never re-checks authenticateSocket for a live
    // connection, so without this it would keep working right through a
    // password change. The client reconnects immediately with whatever
    // access token it currently holds (still valid for the Supabase branch,
    // which only revoked OTHER sessions' tokens), so this is a brief,
    // automatic reconnect, not a logout.
    disconnectUserSockets(req.app.get('io'), user.id);

    return res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'NO_TOKEN' });

    // L2: atomically claim-and-replace in one DB transaction -- two
    // concurrent refresh calls with the same (still-valid) token used to be
    // able to both pass a separate read-then-later-revoke sequence before
    // either committed, each minting its own replacement from one token.
    // rotateRefreshToken's UPDATE...RETURNING only succeeds for one of them.
    const rotated = await rotateRefreshToken(refreshToken, req.headers['user-agent'] || 'unknown');
    if (rotated) {
      // Existing custom-JWT path (Google Sign-In users) -- unchanged.
      const user = await UserRepo.findById(rotated.userId);
      if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND' });
      if (user.deleted_at) return res.status(401).json(ACCOUNT_DELETED_BODY);

      const newAccessToken = generateAccessToken(user);
      return res.json({ accessToken: newAccessToken, refreshToken: rotated.refreshToken });
    }

    // Not a token we issued (or already used/expired/revoked) -- try it as
    // a Supabase Auth refresh token (email/password path). Supabase refresh
    // tokens rotate on use too, same guarantee the custom path already had.
    // (email/password path). Supabase refresh tokens rotate on use too,
    // same guarantee the custom path already had.
    const { data, error } = await createSessionClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session) {
      return res.status(401).json({ error: 'INVALID_REFRESH', message: 'Invalid or expired refresh token' });
    }
    // A deleted account has auth_user_id cleared (and its Supabase identity
    // removed), so it normally can't match here at all; deleted_at is
    // checked as well in case the identity removal is still pending.
    const user = await db.get('SELECT id, email, deleted_at FROM users WHERE auth_user_id = ?', [data.session.user.id]);
    if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND' });
    if (user.deleted_at) return res.status(401).json(ACCOUNT_DELETED_BODY);
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Token refresh encountered a problem.' });
  }
});

// ── Logout ────────────────────────────────────────────────────
router.post('/logout', authenticateAccess, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = await UserRepo.findById(req.user.id);
    if (user?.auth_user_id) {
      // Supabase Auth path -- revoke only THIS session ('local'), matching
      // the existing custom-JWT logout's per-device semantics (it only
      // ever revoked the one refresh token the client sent, not every
      // device). Best-effort: logout must still succeed client-side even
      // if this call fails.
      const accessToken = req.headers.authorization?.split(' ')[1];
      if (accessToken) {
        await getAdminClient().auth.admin.signOut(accessToken, 'local').catch(err => {
          console.error('[logout] Supabase signOut failed:', err.message);
        });
      }
    } else if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Logout encountered a problem.' });
  }
});

// ── /me ───────────────────────────────────────────────────────
router.get('/me', authenticateAccess, async (req, res) => {
  try {
    const io = req.app.get('io');
    const user = await getUserWithFreshPlanState(req.user.id, io);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    const pet = await PetRepo.getActivePet(user.id);
    const allPets = await PetRepo.findAllByUserId(user.id);

    // Best-effort, non-blocking verification reminder -- fires on session
    // checks (app loads) rather than a cron job, since there's no scheduler
    // in this codebase. Gated so it can only ever fire once per 7 days per
    // user: reuses the notifications table itself as the cooldown record
    // instead of adding a new column.
    if (!user.email_verified && io) {
      maybeSendVerifyReminder(user, io).catch(() => {});
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        full_name: user.full_name,
        pawprint_2fa_enabled: user.pawprint_2fa_enabled ? 1 : 0,
        super_sniff_enabled: user.super_sniff_enabled ? 1 : 0,
        email_verified: user.email_verified ? 1 : 0,
        is_admin: user.is_admin,
        current_plan: user.current_plan,
        subscription_status: user.subscription_status,
        is_founding_member: user.is_founding_member ? 1 : 0,
        welcome_slider_seen: user.welcome_slider_seen ? 1 : 0,
        premium_badge_enabled: user.premium_badge_enabled ? 1 : 0,
      },
      pet: pet || null,
      allPets: allPets || [],
    });
  } catch (err) {
    console.error('[/me ERROR]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Profile retrieval encountered a problem.' });
  }
});

export default router;