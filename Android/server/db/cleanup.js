import db from './connection.js';
import { runScheduledPurge } from '../services/mediaPurge.js';
import { deleteAbandonedFrozenCircles } from '../services/frozenCircles.js';
import { purgePendingAuthIdentities } from '../services/authIdentityPurge.js';
import { expireJoinRequests } from '../services/circleJoinRequests.js';
import { expireOwnershipTransfers } from '../services/circleOwnershipTransfers.js';

// refresh_tokens accumulates one row per login/refresh and is never pruned
// otherwise -- revoked/expired rows just sit there forever. See
// AUDIT_REPORT.md. Runs once at boot, then every 24h.
export async function cleanupRefreshTokens() {
  try {
    const result = await db.run(
      "DELETE FROM refresh_tokens WHERE revoked = 1 OR expires_at < NOW()"
    );
    if (result.rowCount) {
      console.log(`[cleanup] Removed ${result.rowCount} revoked/expired refresh_tokens rows`);
    }
  } catch (err) {
    console.error('[cleanup] refresh_tokens cleanup failed:', err.message);
  }
}

// Retries Cloudinary files left behind by account deletions (and runs the
// final per-user tag sweeps). Hourly only -- not at boot -- so a restart
// never fires an unexpected purge.
async function purgeDeletedAccountMedia() {
  try {
    await runScheduledPurge();
  } catch (err) {
    console.error('[cleanup] account media purge failed:', err.message);
  }
}

// Frozen PawCircles with no live member left once any ownership transfer has
// run out. Runs before the media purge so their files go in the same run.
async function deleteAbandonedCircles() {
  try {
    await deleteAbandonedFrozenCircles();
  } catch (err) {
    console.error('[cleanup] abandoned frozen circles failed:', err.message);
  }
}

// Supabase Auth identities of deleted accounts that couldn't be removed
// right after the deletion (Supabase down, network...). Hourly only.
async function purgeDeletedAccountIdentities() {
  try {
    await purgePendingAuthIdentities({ limit: 100 });
  } catch (err) {
    console.error('[cleanup] Supabase identity purge failed:', err.message);
  }
}

// Requests to join private PawCircles that nobody answered within 7 days.
async function expireCircleJoinRequests() {
  try {
    await expireJoinRequests();
  } catch (err) {
    console.error('[cleanup] circle join request expiry failed:', err.message);
  }
}

// PawCircle ownership transfers nobody answered within 5 days (both sides
// are notified). Runs before the abandoned-circle sweep, so a frozen circle
// that was only kept for an expired transfer goes in the same run.
async function expireCircleOwnershipTransfers() {
  try {
    await expireOwnershipTransfers();
  } catch (err) {
    console.error('[cleanup] ownership transfer expiry failed:', err.message);
  }
}

export function startCleanupJobs() {
  cleanupRefreshTokens();
  setInterval(cleanupRefreshTokens, 24 * 60 * 60 * 1000);
  setInterval(async () => {
    await expireCircleOwnershipTransfers();
    await deleteAbandonedCircles();
    await expireCircleJoinRequests();
    await purgeDeletedAccountIdentities();
    await purgeDeletedAccountMedia();
  }, 60 * 60 * 1000);
}
