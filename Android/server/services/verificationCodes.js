import crypto from 'crypto';
import { withTransaction } from '../db/connection.js';
import config from '../config.js';

// Emailed 6-digit verification codes (currently only for account deletion).
// Only an HMAC of each code is stored, keyed with CODE_PEPPER and bound to
// the user + purpose, so a leaked verification_codes row can't be turned
// back into a usable code. Attempts, expiry and single use live in the row
// itself, so limits survive restarts and work across server instances.

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 3;
const PURPOSES = new Set(['delete_account']);

export class VerificationCodeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function assertPurpose(purpose) {
  if (!PURPOSES.has(purpose)) throw new VerificationCodeError('INVALID_PURPOSE', `Unknown verification code purpose: ${purpose}`);
}

function hashCode(userId, purpose, code) {
  return crypto.createHmac('sha256', config.CODE_PEPPER).update(`${userId}:${purpose}:${code}`).digest('hex');
}

function hashesMatch(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b || '', 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Creates a new code for user + purpose and returns it in plain text so the
// caller can email it. Throws VerificationCodeError RATE_LIMITED (with
// retryAfterSeconds) once MAX_CODES_PER_HOUR have been sent in the last
// rolling hour -- invalidated codes still count, since they were sent.
// Any earlier unused code for the same user + purpose stops working.
export async function issueCode(userId, purpose) {
  assertPurpose(purpose);
  return withTransaction(async tx => {
    // Serializes concurrent requests for the same user, so a double-tap
    // can't slip past the hourly cap or leave two live codes.
    const user = await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user) throw new VerificationCodeError('USER_NOT_FOUND', `User ${userId} not found`);

    const recent = await tx.get(
      `SELECT COUNT(*)::int AS count,
              CEIL(EXTRACT(EPOCH FROM (MIN(created_at) + INTERVAL '1 hour' - NOW())))::int AS retry_after
       FROM verification_codes
       WHERE user_id = ? AND purpose = ? AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId, purpose]
    );
    if (recent.count >= MAX_CODES_PER_HOUR) {
      throw new VerificationCodeError('RATE_LIMITED', 'Too many codes requested. Try again later.', {
        retryAfterSeconds: Math.max(1, recent.retry_after),
      });
    }

    await tx.run(
      `UPDATE verification_codes SET invalidated_at = NOW()
       WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [userId, purpose]
    );

    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const row = await tx.get(
      `INSERT INTO verification_codes (user_id, purpose, code_hash, expires_at)
       VALUES (?, ?, ?, NOW() + make_interval(secs => ?))
       RETURNING id`,
      [userId, purpose, hashCode(userId, purpose, code), CODE_TTL_SECONDS]
    );
    return { code, codeId: Number(row.id), expiresInSeconds: CODE_TTL_SECONDS };
  });
}

// Checks a submitted code against the user's latest code for this purpose.
// Never consumes it -- the caller does that in its own transaction once the
// guarded action has actually happened. `q` is a run/get/all adapter: pass
// the plain `db` adapter (not a transaction you might roll back) so a wrong
// attempt is always recorded.
//
// Returns one of:
//   { status: 'OK', codeId }
//   { status: 'NO_ACTIVE_CODE' }
//   { status: 'INVALID_CODE', attemptsRemaining }
//   { status: 'CODE_EXPIRED' }
//   { status: 'TOO_MANY_ATTEMPTS' }   (code is now invalidated)
export async function checkCode(q, userId, purpose, code) {
  assertPurpose(purpose);
  const latest = await q.get(
    `SELECT id, code_hash, attempts, consumed_at, invalidated_at, (expires_at <= NOW()) AS expired
     FROM verification_codes
     WHERE user_id = ? AND purpose = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [userId, purpose]
  );

  if (!latest || latest.consumed_at) return { status: 'NO_ACTIVE_CODE' };
  if (latest.invalidated_at) {
    return latest.attempts >= MAX_ATTEMPTS ? { status: 'TOO_MANY_ATTEMPTS' } : { status: 'NO_ACTIVE_CODE' };
  }
  if (latest.expired) return { status: 'CODE_EXPIRED' };

  const submitted = String(code ?? '').trim();
  if (hashesMatch(hashCode(userId, purpose, submitted), latest.code_hash)) {
    return { status: 'OK', codeId: Number(latest.id) };
  }

  // Atomic increment: concurrent wrong guesses can't both read the same count.
  const updated = await q.get(
    `UPDATE verification_codes
     SET attempts = attempts + 1,
         invalidated_at = CASE WHEN attempts + 1 >= ? THEN NOW() ELSE invalidated_at END
     WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
     RETURNING attempts`,
    [MAX_ATTEMPTS, latest.id]
  );
  if (!updated) return { status: 'NO_ACTIVE_CODE' };
  if (updated.attempts >= MAX_ATTEMPTS) return { status: 'TOO_MANY_ATTEMPTS' };
  return { status: 'INVALID_CODE', attemptsRemaining: MAX_ATTEMPTS - updated.attempts };
}
