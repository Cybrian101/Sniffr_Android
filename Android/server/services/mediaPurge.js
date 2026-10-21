import { v2 as cloudinary } from 'cloudinary';
import db from '../db/connection.js';
import config from '../config.js';
import cloudStorage from '../storage/CloudStorage.js'; // also configures the Cloudinary SDK
import { findStillReferenced } from './accountDeletion.js';

// Deletes the Cloudinary files that account deletions queued in
// pending_media_deletions. Runs right after a deletion (for that user) and
// hourly for anything left over. Every outcome is logged with
// [ACCOUNT_DELETE_MEDIA] so failures are easy to find.
//
// Two kinds of queue rows:
//   - a file (public_id + resource_type), destroyed with uploader.destroy
//     (Upload API, not subject to the Admin API rate limit); "not found"
//     counts as done;
//   - a final "tag sweep" for a deleted user (source 'tag_sweep'): lists every
//     file still tagged user_<id> and destroys those nothing else uses. It
//     uses the rate-limited Admin API, so only the hourly job runs it, a few
//     per run.

export const MAX_ATTEMPTS = 10;
const LOG = '[ACCOUNT_DELETE_MEDIA]';
const SWEEP_SOURCE = 'tag_sweep';
const SWEEPS_PER_RUN = 5;
const PROTECTED_PREFIX = 'sniffr/payment_proofs/';
const RESOURCE_TYPES = ['image', 'video', 'raw'];

// Test-only: rows under this prefix fail on purpose, when a test process
// opts in and never in production.
const TEST_HOOKS_ENABLED = process.env.SNIFFR_TEST_HOOKS === '1' && config.NODE_ENV !== 'production';
const TEST_FAIL_PREFIX = 'sniffr/__purge_test_fail__/';

const cloudReady = () => config.STORAGE_TYPE === 'cloud'
  && !!config.CLOUDINARY_CLOUD_NAME && !!config.CLOUDINARY_API_KEY && !!config.CLOUDINARY_API_SECRET;

async function giveUp(row, reason) {
  await db.run(
    'UPDATE pending_media_deletions SET attempts = ?, last_error = ?, last_attempt_at = NOW() WHERE id = ?',
    [MAX_ATTEMPTS, reason, row.id]);
  console.error(`${LOG} not purging ${row.public_id}: ${reason} -- needs manual follow-up`);
}

async function recordFailure(row, err) {
  const message = String(err?.message || err?.error?.message || err).slice(0, 500);
  const updated = await db.get(
    `UPDATE pending_media_deletions SET attempts = attempts + 1, last_error = ?, last_attempt_at = NOW()
     WHERE id = ? RETURNING attempts`,
    [message, row.id]);
  const attempts = updated?.attempts ?? row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    console.error(`${LOG} GIVING UP on ${row.resource_type}/${row.public_id} (user #${row.deleted_user_id}) after ${attempts} attempts: ${message} -- needs manual follow-up`);
  } else {
    console.error(`${LOG} failed to purge ${row.resource_type}/${row.public_id} (user #${row.deleted_user_id}), attempt ${attempts}/${MAX_ATTEMPTS}: ${message}`);
  }
}

// A destroyed file no longer counts against anyone's storage quota: drop its
// media_files rows -- whoever uploaded it (deleting a frozen circle purges
// other, live members' files too) -- and give those bytes back to the live
// uploaders. A deleted account's storage_used_bytes is already 0.
async function releaseMediaRecords(publicId) {
  await db.run(
    `WITH gone AS (
       DELETE FROM media_files WHERE position(?::text IN url) > 0 RETURNING user_id, bytes
     ), totals AS (
       SELECT user_id, SUM(bytes)::bigint AS bytes FROM gone GROUP BY user_id
     )
     UPDATE users u SET storage_used_bytes = GREATEST(0, u.storage_used_bytes - t.bytes)
     FROM totals t
     WHERE u.id = t.user_id AND u.deleted_at IS NULL`,
    [publicId]);
}

async function purgeFileRow(row) {
  if (row.public_id.startsWith(PROTECTED_PREFIX)) {
    await giveUp(row, 'refused: payment proofs are never purged');
    return 'refused';
  }
  if (TEST_HOOKS_ENABLED && row.public_id.startsWith(TEST_FAIL_PREFIX)) {
    throw new Error('Injected purge failure (test)');
  }
  const { ok, result } = await cloudStorage.destroy(row.public_id, row.resource_type);
  if (!ok) throw new Error(`Cloudinary destroy returned "${result}"`);
  await db.run('DELETE FROM pending_media_deletions WHERE id = ?', [row.id]);
  await releaseMediaRecords(row.public_id);
  return 'purged';
}

// Lists every file still tagged with a deleted user's tag and destroys the
// ones no surviving row uses. Payment proofs carry a different tag and are
// excluded by folder as well.
export async function sweepTaggedMedia(userId) {
  const found = [];
  for (const resourceType of RESOURCE_TYPES) {
    let nextCursor;
    do {
      const page = await cloudinary.api.resources_by_tag(`user_${userId}`, {
        resource_type: resourceType, max_results: 100, ...(nextCursor ? { next_cursor: nextCursor } : {}),
      });
      for (const r of page.resources || []) {
        if (!r.public_id.startsWith(PROTECTED_PREFIX)) found.push({ publicId: r.public_id, resourceType });
      }
      nextCursor = page.next_cursor;
    } while (nextCursor);
  }
  const stillUsed = await findStillReferenced(db, found.map(f => f.publicId));
  let destroyed = 0;
  for (const f of found) {
    if (stillUsed.has(f.publicId)) continue;
    const { ok, result } = await cloudStorage.destroy(f.publicId, f.resourceType);
    if (!ok) throw new Error(`Cloudinary destroy of ${f.publicId} returned "${result}"`);
    await releaseMediaRecords(f.publicId);
    destroyed++;
  }
  console.log(`${LOG} tag sweep for user #${userId}: ${found.length} tagged, ${destroyed} destroyed, ${found.length - destroyed} still in use`);
  return { found: found.length, destroyed, kept: found.length - destroyed };
}

async function sweepRow(row) {
  const user = await db.get('SELECT deleted_at FROM users WHERE id = ?', [row.deleted_user_id]);
  if (!user?.deleted_at) {
    await giveUp(row, 'refused: tag sweeps only run for deleted accounts');
    return 'refused';
  }
  await sweepTaggedMedia(row.deleted_user_id);
  await db.run('DELETE FROM pending_media_deletions WHERE id = ?', [row.id]);
  return 'purged';
}

/**
 * Processes queued rows that haven't given up yet.
 *   deletedUserId  only that user's rows
 *   includeSweeps  process tag-sweep rows (Admin API) instead of file rows
 * Returns { purged, failed, refused, skipped }.
 */
export async function purgePendingMedia({ limit = 100, deletedUserId = null, includeSweeps = false } = {}) {
  if (!cloudReady()) {
    console.warn(`${LOG} Cloudinary is not configured (STORAGE_TYPE/CLOUDINARY_*) -- purge skipped`);
    return { purged: 0, failed: 0, refused: 0, skipped: true };
  }
  const rows = await db.all(
    `SELECT * FROM pending_media_deletions
     WHERE attempts < ? AND (?::int IS NULL OR deleted_user_id = ?::int)
       AND (source = ?) = ?::boolean
     ORDER BY created_at, id
     LIMIT ?`,
    [MAX_ATTEMPTS, deletedUserId, deletedUserId, SWEEP_SOURCE, includeSweeps, includeSweeps ? Math.min(limit, SWEEPS_PER_RUN) : limit]);

  const counts = { purged: 0, failed: 0, refused: 0, skipped: false };
  for (const row of rows) {
    try {
      const outcome = row.source === SWEEP_SOURCE ? await sweepRow(row) : await purgeFileRow(row);
      counts[outcome]++;
    } catch (err) {
      counts.failed++;
      await recordFailure(row, err);
    }
  }
  return counts;
}

// Queues the final tag sweep for a deleted account (run later by the hourly
// job). Idempotent.
export async function queueTagSweep(userId) {
  await db.run(
    `INSERT INTO pending_media_deletions (public_id, resource_type, source, deleted_user_id)
     VALUES (?, 'image', ?, ?) ON CONFLICT (public_id, resource_type) DO NOTHING`,
    [`tag:user_${userId}`, SWEEP_SOURCE, userId]);
}

/**
 * Right after a deletion commits: queue the tag sweep, then purge that user's
 * queued files, waiting at most timeoutMs (the purge keeps going in the
 * background if it takes longer). Returns 'complete' if none of the user's
 * files are left in the queue, otherwise 'pending'.
 */
export async function purgeAfterDeletion(userId, { timeoutMs = 8000 } = {}) {
  try {
    await queueTagSweep(userId);
    const purge = purgePendingMedia({ deletedUserId: userId, limit: 500 })
      .catch(err => console.error(`${LOG} purge after deletion of user #${userId} failed:`, err.message));
    const finished = await Promise.race([
      purge.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!finished) return 'pending';
    const left = await db.get(
      'SELECT count(*)::int AS n FROM pending_media_deletions WHERE deleted_user_id = ? AND source <> ?', [userId, SWEEP_SOURCE]);
    return left.n === 0 ? 'complete' : 'pending';
  } catch (err) {
    console.error(`${LOG} purge after deletion of user #${userId} could not start:`, err.message);
    return 'pending';
  }
}

// Hourly: retry leftover file rows, then a few tag sweeps.
export async function runScheduledPurge() {
  const files = await purgePendingMedia({ limit: 200 });
  if (files.skipped) return;
  const sweeps = await purgePendingMedia({ includeSweeps: true });
  if (files.purged || files.failed || sweeps.purged || sweeps.failed) {
    console.log(`${LOG} scheduled run: files ${files.purged} purged / ${files.failed} failed; sweeps ${sweeps.purged} done / ${sweeps.failed} failed`);
  }
}
