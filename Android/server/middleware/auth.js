import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config.js';
import db, { withTransaction } from '../db/connection.js';
import { getAnonClient } from '../lib/supabase.js';
import UserRepo from '../models/UserRepository.js';

export function generateAccessToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, config.JWT_ACCESS_SECRET, { expiresIn: config.ACCESS_TOKEN_EXPIRY, algorithm: 'HS256' });
}

// ── Single-purpose tokens ───────────────────────────────────────
// Short-lived tokens that are NOT sessions (the 2FA step after a correct
// password, the Google sign-up ticket) are signed with a key derived from
// JWT_ACCESS_SECRET per purpose, never with JWT_ACCESS_SECRET itself, so
// they can't pass as an access token anywhere (resolveUserFromToken), and a
// token for one purpose can't be used for another.
function purposeKey(purpose) {
  return crypto.createHmac('sha256', config.JWT_ACCESS_SECRET).update(`sniffr:${purpose}`).digest();
}

export function signPurposeToken(purpose, payload, expiresIn) {
  return jwt.sign({ ...payload, purpose }, purposeKey(purpose), { expiresIn, algorithm: 'HS256' });
}

// Throws (jsonwebtoken's errors) if invalid, expired or for another purpose.
export function verifyPurposeToken(purpose, token) {
  const decoded = jwt.verify(String(token), purposeKey(purpose), { algorithms: ['HS256'] });
  if (decoded.purpose !== purpose) throw new jwt.JsonWebTokenError('wrong token purpose');
  return decoded;
}

// AES-256-GCM for a secret that has to ride inside such a token (a JWT
// payload is only base64, readable by whoever holds it).
export function sealSecret(purpose, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', purposeKey(`${purpose}:enc`), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

export function openSecret(purpose, sealed) {
  const buf = Buffer.from(String(sealed), 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', purposeKey(`${purpose}:enc`), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
}

export async function generateRefreshToken(user, deviceInfo = 'unknown') {
  const token = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY_MS).toISOString();
  await db.run('INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at) VALUES (?, ?, ?, ?)',
    [user.id, tokenHash, deviceInfo, expiresAt]);
  return token;
}

export function verifyAccessToken(token) {
  // Pin the algorithm explicitly -- without this, jwt.verify() accepts
  // whatever algorithm the token itself claims (as long as it isn't
  // "none"), which is the classic algorithm-confusion JWT attack class.
  // Only HS256 tokens signed with our own secret should ever be valid.
  return jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
}

export async function verifyRefreshToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await db.get(
    "SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW()",
    [tokenHash]
  );
  return record || null;
}

export async function revokeRefreshToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [tokenHash]);
}

export async function revokeAllUserTokens(userId) {
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [userId]);
}

// Atomically claims (revokes) a refresh token and issues its replacement in
// one DB transaction (L2: rotation was previously two separate awaited
// calls -- verifyRefreshToken's read, then a later revokeRefreshToken's
// write -- so two concurrent refresh calls using the same still-valid token
// could both pass the read before either committed the revoke, each then
// minting its own "new" refresh token from one old one, undetected. The
// UPDATE...RETURNING below only succeeds for exactly one concurrent caller;
// everyone else gets null, same as an already-used/invalid token. Returns
// null if the token doesn't exist, is already revoked, or is expired.
export async function rotateRefreshToken(token, deviceInfo) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return withTransaction(async tx => {
    const record = await tx.get(
      'UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW() RETURNING *',
      [tokenHash]
    );
    if (!record) return null;
    const newToken = crypto.randomBytes(40).toString('hex');
    const newHash = crypto.createHash('sha256').update(newToken).digest('hex');
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY_MS).toISOString();
    await tx.run(
      'INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at) VALUES (?, ?, ?, ?)',
      [record.user_id, newHash, deviceInfo || record.device_info, expiresAt]
    );
    return { userId: record.user_id, refreshToken: newToken };
  });
}

// A still-valid access token must stop working the moment its account is
// deleted (tombstoned) -- the JWT alone can't know that, so every request
// re-checks the users row. Missing row counts as deleted too.
export async function isAccountActive(userId) {
  const row = await db.get('SELECT deleted_at FROM users WHERE id = ?', [userId]);
  return !!row && !row.deleted_at;
}

export const ACCOUNT_DELETED_BODY = { error: 'ACCOUNT_DELETED', message: 'This account has been deleted.' };
// ── Dual-path token resolution ──────────────────────────────────
// Two kinds of valid access token exist side by side:
//   1. Our own custom JWT (still issued by /api/auth/google -- Google
//      Sign-In deliberately keeps its existing implementation, untouched
//      by the Supabase Auth migration).
//   2. A Supabase Auth session token (email/password login path).
// Both resolve to the SAME internal { id, email } shape (id = the
// integer public.users.id every route/repository already expects), via
// the auth_user_id link column for path 2 -- so nothing downstream of
// this middleware needs to know or care which path a given user took.
//
// Path 1 is checked first and is a fast, local, no-network signature
// check (as it always was). Path 2 costs one network round-trip to
// Supabase's Auth API per request (getUser() verifies the token
// regardless of whether the project uses legacy or asymmetric JWT
// signing) -- acceptable at current scale; if this ever needs to be
// faster, switch to local JWKS verification (see server/lib/supabase.js)
// once the project's signing-key mode is confirmed.
class AuthResolutionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function resolveUserFromToken(token) {
  try {
    const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    // Only real access tokens (generateAccessToken). 2FA temp tokens used to
    // be signed with this same secret; any still in circulation (10 min
    // lifetime) must not count as a session.
    if (decoded.is2FATemp || decoded.purpose || !Number.isInteger(decoded.id)) {
      throw new AuthResolutionError('INVALID_TOKEN');
    }
    return { id: decoded.id, email: decoded.email };
  } catch (customJwtErr) {
    if (customJwtErr instanceof AuthResolutionError) throw customJwtErr;
    if (customJwtErr.name === 'TokenExpiredError') {
      throw new AuthResolutionError('TOKEN_EXPIRED');
    }
    // Not (or no longer) a valid custom JWT -- try it as a Supabase
    // Auth session token instead.
  }

  let supabaseUser;
  try {
    const { data, error } = await getAnonClient().auth.getUser(token);
    if (error || !data?.user) {
      const expired = /expired/i.test(error?.message || '');
      throw new AuthResolutionError(expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
    }
    supabaseUser = data.user;
  } catch (err) {
    if (err instanceof AuthResolutionError) throw err;
    throw new AuthResolutionError('INVALID_TOKEN');
  }

  const user = await db.get('SELECT id, email, pawprint_2fa_enabled FROM users WHERE auth_user_id = ?', [supabaseUser.id]);
  if (!user) throw new AuthResolutionError('INVALID_TOKEN');

  // H1: a Supabase session is otherwise valid regardless of HOW it was
  // obtained -- including a raw signInWithPassword call straight against
  // Supabase's own API, entirely bypassing POST /api/auth/login and the
  // PawPrint challenge it gates behind 2FA. For a 2FA-enabled account, this
  // specific session must have been marked verified by /2fa/verify-login
  // (or /2fa/verify-enable, for the session that just turned 2FA on) --
  // see UserRepository's pawprint_verified_sessions methods. GoTrue's
  // session_id claim stays the same across access-token refresh, so a
  // normal client that refreshes its token isn't forced to redo 2FA.
  if (user.pawprint_2fa_enabled) {
    const sessionId = supabaseSessionIdFromToken(token);
    if (!sessionId || !(await UserRepo.isPawprintSessionVerified(sessionId, user.id))) {
      throw new AuthResolutionError('TWOFA_REQUIRED');
    }
  }

  return { id: user.id, email: user.email };
}

// GoTrue (Supabase Auth) JWTs carry a `session_id` claim that stays the same
// across access-token refresh within one login session, only changing on a
// fresh sign-in. The token was already cryptographically verified by
// getAnonClient().auth.getUser() just above -- this is a trusted read of its
// own claims, not a second verification.
export function supabaseSessionIdFromToken(token) {
  try {
    const decoded = jwt.decode(token);
    return decoded?.session_id || decoded?.sid || null;
  } catch {
    return null;
  }
}

export async function authenticateAccess(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'NO_TOKEN', message: 'Access token required' });
  }
  // Either token kind (our own JWT or a Supabase session) resolves to the
  // same { id, email }; the deleted-account check below then applies to both.
  let decoded;
  try {
    decoded = await resolveUserFromToken(authHeader.split(' ')[1]);
  } catch (err) {
    const code = err instanceof AuthResolutionError ? err.code : 'INVALID_TOKEN';
    const message = code === 'TOKEN_EXPIRED' ? 'Access token expired'
      : code === 'TWOFA_REQUIRED' ? 'This session has not completed PawPrint Verification.'
      : 'Invalid access token';
    return res.status(401).json({ error: code, message });
  }

  let active;
  try {
    active = await isAccountActive(decoded.id);
  } catch (err) {
    console.error('[authenticateAccess] account check failed:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not verify your session.' });
  }
  if (!active) return res.status(401).json(ACCOUNT_DELETED_BODY);

  req.user = decoded;
  // Outside the try blocks on purpose, so an error thrown by a later
  // handler is never misreported as a token problem.
  next();
}

export async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  let decoded;
  try {
    decoded = await resolveUserFromToken(token);
  } catch {
    return next(new Error('Invalid token'));
  }
  try {
    if (!(await isAccountActive(decoded.id))) return next(new Error('Account deleted'));
  } catch (err) {
    console.error('[authenticateSocket] account check failed:', err.message);
    return next(new Error('Server error'));
  }
  socket.user = decoded;
  next();
}