import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';

class UserRepository extends BaseRepository {
  constructor() { super('users'); }

  // Login, social sign-in, forgot-password and signup-uniqueness lookups
  // never match a deleted (tombstoned) account. findById deliberately does
  // NOT filter -- tombstones must still load for display ("SniffedOut").
  // Case-insensitive on purpose (M1): emails are stored as typed/normalized
  // at signup, but a mixed-case existing row must still match a lowercase
  // login attempt or a lowercase email handed back by Google -- otherwise a
  // capitalized signup can't log in with lowercase, and Google sign-in can
  // create a duplicate account next to an existing mixed-case one.
  async findByEmail(email) {
    return db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL', [email]);
  }

  async findByUsername(username) {
    return db.get('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL', [username]);
  }

  async updateResetToken(userId, token, expiresAt) {
    return db.run('UPDATE users SET reset_token = ?, reset_token_expires_at = ? WHERE id = ?', [token, expiresAt, userId]);
  }

  async findByResetToken(token) {
    return db.get('SELECT * FROM users WHERE reset_token = ? AND deleted_at IS NULL', [token]);
  }

  async clearResetToken(userId) {
    return db.run('UPDATE users SET reset_token = NULL, reset_token_expires_at = NULL WHERE id = ?', [userId]);
  }

  async updatePassword(userId, passwordHash) {
    return db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  }

  async blockUser(blockerId, blockedId) {
    await db.run(
      'INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT (blocker_id, blocked_id) DO NOTHING',
      [blockerId, blockedId]
    );
    return true;
  }

  async unblockUser(blockerId, blockedId) {
    await db.run(
      'DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?',
      [blockerId, blockedId]
    );
    return true;
  }

  async isBlocked(userId1, userId2) {
    const row = await db.get(
      'SELECT id FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
      [userId1, userId2, userId2, userId1]
    );
    return !!row;
  }

  async getBlockedUserIds(userId) {
    const rows = await db.all(
      'SELECT blocked_id FROM blocked_users WHERE blocker_id = ? UNION SELECT blocker_id FROM blocked_users WHERE blocked_id = ?',
      [userId, userId]
    );
    return rows.map(r => r.blocked_id);
  }

  async set2FAStatus(userId, enabled) {
    return db.run('UPDATE users SET pawprint_2fa_enabled = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
  }

  async setSuperSniffStatus(userId, enabled) {
    return db.run('UPDATE users SET super_sniff_enabled = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
  }

  async setPawCode(userId, code, expiresAt) {
    return db.run('UPDATE users SET paw_code = ?, paw_code_expires_at = ? WHERE id = ?', [code, expiresAt, userId]);
  }

  async getPawCode(userId) {
    return db.get('SELECT paw_code, paw_code_expires_at, pawprint_2fa_enabled, email FROM users WHERE id = ?', [userId]);
  }

  async clearPawCode(userId) {
    return db.run('UPDATE users SET paw_code = NULL, paw_code_expires_at = NULL WHERE id = ?', [userId]);
  }

  async addTrustedDevice(userId, deviceToken, deviceInfo, expiresAt) {
    return db.run(
      `INSERT INTO trusted_devices (user_id, device_token, device_info, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (device_token) DO UPDATE
       SET user_id = EXCLUDED.user_id, device_info = EXCLUDED.device_info, expires_at = EXCLUDED.expires_at`,
      [userId, deviceToken, deviceInfo, expiresAt]
    );
  }

  async isDeviceTrusted(userId, deviceToken) {
    if (!deviceToken) return false;
    const row = await db.get(
      "SELECT id FROM trusted_devices WHERE user_id = ? AND device_token = ? AND expires_at > NOW()",
      [userId, deviceToken]
    );
    return !!row;
  }

  async clearTrustedDevices(userId) {
    return db.run('DELETE FROM trusted_devices WHERE user_id = ?', [userId]);
  }

  // ── PawPrint 2FA / Supabase session binding (H1) ─────────────────
  // A Supabase Auth session obtained OUTSIDE this app (e.g. a raw
  // signInWithPassword call straight against Supabase's own API, bypassing
  // POST /api/auth/login entirely) is otherwise indistinguishable from one
  // that went through our PawPrint challenge -- middleware/auth.js's
  // resolveUserFromToken only ever checked "is this a valid Supabase
  // session", never "did ITS owner actually pass 2FA". These three methods
  // back that missing check: a session (keyed by GoTrue's session_id claim,
  // stable across access-token refresh so a normal client doesn't get
  // logged out every 15 minutes) is recorded here the moment
  // /2fa/verify-login succeeds, and nowhere else -- see
  // server/db/sql/2026-10-10_pawprint_verified_sessions.sql for the table.
  async markPawprintSessionVerified(sessionId, userId) {
    if (!sessionId) return;
    return db.run(
      `INSERT INTO pawprint_verified_sessions (session_id, user_id, verified_at)
       VALUES (?, ?, NOW())
       ON CONFLICT (session_id) DO UPDATE SET verified_at = NOW(), user_id = EXCLUDED.user_id`,
      [sessionId, userId]
    );
  }

  async isPawprintSessionVerified(sessionId, userId) {
    if (!sessionId) return false;
    const row = await db.get(
      'SELECT 1 AS found FROM pawprint_verified_sessions WHERE session_id = ? AND user_id = ?',
      [sessionId, userId]
    );
    return !!row;
  }

  async clearPawprintVerifiedSessions(userId) {
    return db.run('DELETE FROM pawprint_verified_sessions WHERE user_id = ?', [userId]);
  }
}

export default new UserRepository();