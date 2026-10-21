import db from '../db/connection.js';
import config from '../config.js';
import { getAdminClient } from '../lib/supabase.js';

// Deletes the Supabase Auth identities that account deletions queued in
// pending_auth_deletions (an email/password account's login lives in
// Supabase's auth.users, linked by users.auth_user_id). Runs right after a
// deletion (for that user) and hourly for anything left over. Server-side
// only: uses the service_role admin client.
//
// A 404 / "user not found" counts as done (already gone). Other failures are
// recorded (attempts, last_error) and retried; after MAX_AUTH_ATTEMPTS the row
// is left for a manual look. Until the identity is gone the old email can't
// sign up again (Supabase rejects a duplicate), so failures are logged loudly.

export const MAX_AUTH_ATTEMPTS = 10;
const LOG = '[ACCOUNT_DELETE_AUTH]';

const supabaseAdminReady = () => !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);

function isNotFound(error) {
  return error?.status === 404 || error?.code === 'user_not_found' || /not\s*found/i.test(error?.message || '');
}

async function queueTableExists() {
  const row = await db.get("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok");
  return !!row?.ok;
}

/**
 * Deletes queued identities (all, or only those of one deleted user).
 * Returns { removed, failed, skipped }.
 */
export async function purgePendingAuthIdentities({ deletedUserId = null, limit = 50 } = {}) {
  if (!(await queueTableExists())) return { removed: 0, failed: 0, skipped: true };
  if (!supabaseAdminReady()) {
    console.warn(`${LOG} SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set -- identities stay queued`);
    return { removed: 0, failed: 0, skipped: true };
  }
  const rows = await db.all(
    `SELECT * FROM pending_auth_deletions
     WHERE attempts < ? AND (?::int IS NULL OR deleted_user_id = ?::int)
     ORDER BY created_at, id
     LIMIT ?`,
    [MAX_AUTH_ATTEMPTS, deletedUserId, deletedUserId, limit]);

  const counts = { removed: 0, failed: 0, skipped: false };
  for (const row of rows) {
    try {
      const { error } = await getAdminClient().auth.admin.deleteUser(row.auth_user_id);
      if (error && !isNotFound(error)) throw error;
      await db.run('DELETE FROM pending_auth_deletions WHERE id = ?', [row.id]);
      counts.removed++;
    } catch (err) {
      counts.failed++;
      const message = String(err?.message || err).slice(0, 500);
      const updated = await db.get(
        `UPDATE pending_auth_deletions SET attempts = attempts + 1, last_error = ?, last_attempt_at = NOW()
         WHERE id = ? RETURNING attempts`,
        [message, row.id]);
      const attempts = updated?.attempts ?? row.attempts + 1;
      if (attempts >= MAX_AUTH_ATTEMPTS) {
        console.error(`${LOG} GIVING UP on the Supabase identity of deleted user #${row.deleted_user_id} after ${attempts} attempts: ${message} -- needs manual follow-up`);
      } else {
        console.error(`${LOG} could not delete the Supabase identity of deleted user #${row.deleted_user_id} (attempt ${attempts}/${MAX_AUTH_ATTEMPTS}): ${message}`);
      }
    }
  }
  return counts;
}

// 'complete' once nothing is queued for this user any more, else 'pending'.
export async function authCleanupStatus(deletedUserId) {
  if (!(await queueTableExists())) return 'complete';
  const left = await db.get('SELECT count(*)::int AS n FROM pending_auth_deletions WHERE deleted_user_id = ?', [deletedUserId]);
  return left.n === 0 ? 'complete' : 'pending';
}
