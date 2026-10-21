import db, { withTransaction } from '../db/connection.js';
import CommunityRepo from '../models/CommunityRepository.js';
import { LIVE_MEMBER_COUNT_SQL } from '../utils/sniffedOut.js';
import { queueMediaUrls } from './accountDeletion.js';

// Leaving PawCircles, and the end of frozen ones.
//
// A frozen circle (owner SniffedOut) lives on read-only while any live member
// is left. When the last live member leaves, the circle is deleted with all
// its content, and its Cloudinary files are queued for the media purge --
// unless an ownership transfer is still pending and unexpired: then it's kept
// until the transfer runs out, and the hourly job deletes it if nobody came.

const liveCount = async (q, communityId) => Number((await q.get(LIVE_MEMBER_COUNT_SQL, [communityId])).count);

async function hasPendingTransfer(q, communityId) {
  return !!(await q.get(
    "SELECT 1 FROM community_ownership_transfers WHERE community_id = ? AND status = 'pending' AND expires_at > NOW()",
    [communityId]));
}

// Deletes the circle row (every child table cascades: members, messages and
// their reactions, photos, announcements, events, polls, join requests,
// transfers), then queues the files nothing else still uses. The queue rows
// carry the circle's creator (the SniffedOut owner) as deleted_user_id.
async function deleteCircle(tx, community) {
  const urls = (await tx.all(
    `SELECT media_url AS url FROM community_messages WHERE community_id = ? AND media_url IS NOT NULL
     UNION SELECT media_url FROM community_photos WHERE community_id = ? AND media_url IS NOT NULL
     UNION SELECT cover_image FROM communities WHERE id = ? AND cover_image IS NOT NULL`,
    [community.id, community.id, community.id])).map(r => r.url);
  await tx.run('DELETE FROM communities WHERE id = ?', [community.id]);
  // Notification thumbnails copied from the circle's media would otherwise
  // keep those files alive forever (same as the account deletion).
  if (urls.length) await tx.run('UPDATE notifications SET avatar_url = NULL WHERE avatar_url = ANY(?::text[])', [urls]);
  return queueMediaUrls(tx, urls, community.created_by);
}

/**
 * userId leaves the circle (also what "delete from my list" does on a frozen
 * circle). A pending ownership transfer to or from them is cancelled first,
 * so it can't keep the circle alive; the caller tells the other side
 * (circleOwnershipTransfers.notifyCancelledTransfers).
 * Returns { deleted, keptForTransfer, queuedMedia, cancelledTransfers }.
 */
export async function leaveCircle(communityId, userId) {
  const id = parseInt(communityId, 10);
  return withTransaction(async tx => {
    // Row lock: two members leaving at once can't both miss "last one out".
    const community = await tx.get('SELECT id, created_by, status FROM communities WHERE id = ? FOR UPDATE', [id]);
    if (!community) return { deleted: false, keptForTransfer: false, queuedMedia: 0, cancelledTransfers: [] };

    // H9: whether the leaver is the owner is read from their LIVE role in
    // community_members, not communities.created_by -- created_by is the
    // circle's ORIGINAL creator and is never updated by a successful
    // ownership transfer (circleOwnershipTransfers.js only updates the
    // community_members role row), so after any transfer it no longer
    // identifies the current owner at all.
    const membership = await tx.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [id, userId]);
    const isOwner = membership?.role === 'Owner';

    if (isOwner && community.status !== 'frozen') {
      const otherLive = Number((await tx.get(
        `SELECT COUNT(*)::int AS count FROM community_members m JOIN users u ON u.id = m.user_id
         WHERE m.community_id = ? AND u.deleted_at IS NULL AND m.user_id != ?`,
        [id, userId]
      )).count);
      // Other live members would be left with nobody able to administer the
      // circle (announcements, role changes, moderation) -- block instead of
      // silently stranding it. The existing ownership-transfer flow is the
      // deliberate, user-chosen way to hand off first; nothing has been
      // mutated yet, so this is a clean no-op rollback.
      if (otherLive > 0) {
        return { deleted: false, keptForTransfer: false, queuedMedia: 0, cancelledTransfers: [], blocked: true, reason: 'OWNER_MUST_TRANSFER' };
      }
    }

    const cancelledTransfers = await tx.all(
      `UPDATE community_ownership_transfers SET status = 'cancelled', responded_at = NOW()
       WHERE community_id = ? AND status = 'pending' AND (to_user_id = ? OR from_user_id = ?)
       RETURNING id, community_id, from_user_id, to_user_id`, [id, userId, userId]);
    const done = result => ({ ...result, cancelledTransfers });
    await tx.run('DELETE FROM community_members WHERE community_id = ? AND user_id = ?', [id, userId]);
    const live = await liveCount(tx, id);

    if (live === 0) {
      if (community.status === 'frozen') {
        if (await hasPendingTransfer(tx, id)) {
          await CommunityRepo.recountMembers(id, tx);
          return done({ deleted: false, keptForTransfer: true, queuedMedia: 0 });
        }
        const queuedMedia = await deleteCircle(tx, community);
        return done({ deleted: true, keptForTransfer: false, queuedMedia });
      }
      // Active circle: the owner leaving an otherwise empty circle deletes it
      // -- with its content and Cloudinary files, exactly like a frozen one.
      // isOwner (the leaver's live role), not created_by -- see the H9 note
      // above; using created_by here missed this entirely once a circle had
      // changed hands, leaving a permanently orphaned empty ACTIVE circle
      // (deleteAbandonedFrozenCircles only ever sweeps status='frozen' ones).
      if (isOwner) {
        const queuedMedia = await deleteCircle(tx, community);
        return done({ deleted: true, keptForTransfer: false, queuedMedia });
      }
    }
    await CommunityRepo.recountMembers(id, tx);
    return done({ deleted: false, keptForTransfer: false, queuedMedia: 0 });
  });
}

/**
 * Hourly: deletes frozen circles that have no live member left and no
 * pending, unexpired ownership transfer (e.g. kept for a transfer that then
 * expired, or frozen with nobody else in it). Returns how many were deleted.
 */
export async function deleteAbandonedFrozenCircles() {
  const candidates = await db.all(
    `SELECT c.id FROM communities c
     WHERE c.status = 'frozen'
       AND NOT EXISTS (SELECT 1 FROM community_members m JOIN users u ON u.id = m.user_id
                       WHERE m.community_id = c.id AND u.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM community_ownership_transfers t
                       WHERE t.community_id = c.id AND t.status = 'pending' AND t.expires_at > NOW())`);
  let deleted = 0;
  for (const { id } of candidates) {
    try {
      const done = await withTransaction(async tx => {
        const community = await tx.get("SELECT id, created_by, status FROM communities WHERE id = ? AND status = 'frozen' FOR UPDATE", [id]);
        // Re-check under the lock: someone may have accepted a transfer meanwhile.
        if (!community || await liveCount(tx, id) > 0 || await hasPendingTransfer(tx, id)) return false;
        await deleteCircle(tx, community);
        return true;
      });
      if (done) deleted++;
    } catch (err) {
      console.error(`[frozen circles] could not delete abandoned circle #${id}:`, err.message);
    }
  }
  if (deleted) console.log(`[frozen circles] deleted ${deleted} abandoned frozen PawCircle(s)`);
  return deleted;
}
