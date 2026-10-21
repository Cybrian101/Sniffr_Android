import db, { withTransaction } from '../db/connection.js';
import CommunityRepo from '../models/CommunityRepository.js';
import { canCreateCommunity } from './premiumGate.js';
import { getPlan } from '../config/plans.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { COMMUNITY_READ_ONLY_BODY } from '../utils/sniffedOut.js';
import NotificationRepo from '../models/NotificationRepository.js';
import { emitLive } from './liveEvents.js';

// PawCircle ownership transfers (community_ownership_transfers).
//
// Only the circle's Owner starts or cancels one, only its recipient (a live
// member) accepts or declines. One pending transfer per circle: picking
// someone else cancels the old one first. A pending transfer lives 5 days
// (expires_at); the hourly job expires it and tells both sides.
//
// Accepting makes the recipient the Owner (role and communities.created_by,
// which account deletion and the circle lists read as "the owner") and the
// old owner a regular Member, after checking the recipient's plan limit for
// owned circles. If the old owner deleted their account meanwhile, the
// circle is frozen; accepting then reactivates it with the recipient as
// owner. The recipient leaving or deleting their account cancels it.
// Frozen circles never get NEW transfers.
// Every exported action returns { status, body } for the route to send.

const REQUEST_TYPE = 'community_ownership_transfer';
const UPDATE_TYPE = 'community_ownership_update';

const TRANSFER_NOT_FOUND = { error: 'TRANSFER_NOT_FOUND', message: 'That ownership transfer no longer exists.' };

const usernameOf = async (userId, q = db) => (await q.get('SELECT username FROM users WHERE id = ?', [userId]))?.username || 'A member';
const circleName = async (communityId, q = db) => (await q.get('SELECT name FROM communities WHERE id = ?', [communityId]))?.name || 'your PawCircle';

// Live updates go through emitLive: directly with io, else (the hourly expiry
// job runs without io) handed to the running server over Postgres NOTIFY, so
// open pages still see them without a reload.

// A plain notification about a transfer (no buttons). Skipped for SniffedOut users.
async function notify(io, userId, communityId, title, description = '') {
  if (!userId) return null;
  const notification = await sendRealtimeNotification(io, userId, {
    category: 'pawcircle',
    type: UPDATE_TYPE,
    title,
    description,
    avatarUrl: null,
    targetId: String(communityId),
    senderPetId: null,
    actionStatus: 'none',
    metadata: { community_id: communityId },
  });
  // sendRealtimeNotification emits only when it has io.
  if (!io && notification) {
    const unreadCount = await NotificationRepo.getUnreadCount(userId);
    await emitLive(null, `user_${userId}`, 'notification_received', { notification, unreadCount });
  }
  return notification;
}

// The recipient's Accept/Decline notification shows the outcome once resolved.
// An open notification panel patches the card in place (notification_updated).
async function resolveRequestNotification(io, transferId, toUserId, status) {
  const rows = await db.all(
    `UPDATE notifications SET action_status = ?
     WHERE user_id = ? AND type = ? AND action_status = 'pending' AND (metadata_json::jsonb ->> 'transfer_id') = ?
     RETURNING *`,
    [status, toUserId, REQUEST_TYPE, String(transferId)]);
  for (const notification of rows) await emitLive(io, `user_${toUserId}`, 'notification_updated', { notification });
}

// Open pages of the people involved reload the transfer banner.
async function emitTransferUpdated(io, communityId, userIds) {
  for (const id of new Set(userIds.filter(Boolean))) {
    await emitLive(io, `user_${id}`, 'community_transfer_updated', { communityId });
  }
}

const shape = t => t && ({
  id: t.id,
  communityId: t.community_id,
  fromUserId: t.from_user_id,
  fromUsername: t.from_username,
  toUserId: t.to_user_id,
  toUsername: t.to_username,
  createdAt: t.created_at,
  expiresAt: t.expires_at,
});

// GET /:id/ownership-transfer -- the pending transfer, shown only to its
// two sides (the owner who started it and the recipient).
export async function getTransferFor(communityId, userId) {
  const t = await db.get(
    `SELECT t.*, fu.username AS from_username, tu.username AS to_username
     FROM community_ownership_transfers t
     LEFT JOIN users fu ON fu.id = t.from_user_id
     JOIN users tu ON tu.id = t.to_user_id
     WHERE t.community_id = ? AND t.status = 'pending' AND t.expires_at > NOW()`, [parseInt(communityId, 10)]);
  if (!t || (t.from_user_id !== userId && t.to_user_id !== userId)) return { status: 200, body: { transfer: null } };
  return { status: 200, body: { transfer: { ...shape(t), isRecipient: t.to_user_id === userId, isSender: t.from_user_id === userId } } };
}

// POST /:id/ownership-transfer { toUserId } -- the Owner (checked by the
// route) offers the circle to a live member. Replaces any pending transfer.
export async function startTransfer(communityId, ownerId, toUserId, io) {
  const id = parseInt(communityId, 10);
  const to = parseInt(toUserId, 10);
  if (!Number.isInteger(to) || to === ownerId) {
    return { status: 400, body: { error: 'INVALID_RECIPIENT', message: 'Choose another member of this PawCircle.' } };
  }
  const outcome = await withTransaction(async tx => {
    const community = await tx.get('SELECT id, name, status FROM communities WHERE id = ? FOR UPDATE', [id]);
    if (!community) return { status: 404, body: { error: 'NOT_FOUND', message: 'PawCircle community not found' } };
    if (community.status === 'frozen') return { status: 403, body: COMMUNITY_READ_ONLY_BODY };
    const recipient = await tx.get(
      `SELECT m.role FROM community_members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.user_id = ? AND u.deleted_at IS NULL`, [id, to]);
    if (!recipient) return { status: 404, body: { error: 'MEMBER_NOT_FOUND', message: 'That pet parent is not a member of this PawCircle.' } };

    const existing = await tx.get(
      `SELECT id, to_user_id, (expires_at <= NOW()) AS expired FROM community_ownership_transfers
       WHERE community_id = ? AND status = 'pending' FOR UPDATE`, [id]);
    if (existing && !existing.expired && existing.to_user_id === to) {
      return { status: 200, body: { transfer: { id: existing.id } }, community, replaced: null, created: false };
    }
    let replaced = null;
    if (existing) {
      // An overdue one the hourly job hasn't reached yet just expires.
      await tx.run('UPDATE community_ownership_transfers SET status = ?, responded_at = NOW() WHERE id = ?',
        [existing.expired ? 'expired' : 'cancelled', existing.id]);
      if (!existing.expired) replaced = existing;
    }
    const created = await tx.get(
      `INSERT INTO community_ownership_transfers (community_id, from_user_id, to_user_id)
       VALUES (?, ?, ?) RETURNING id, expires_at`, [id, ownerId, to]);
    return { status: 201, body: { transfer: { id: created.id, toUserId: to, expiresAt: created.expires_at } }, community, replaced, created: true };
  });
  if (!outcome.created) return { status: outcome.status, body: outcome.body };

  const ownerName = await usernameOf(ownerId);
  if (outcome.replaced) {
    await resolveRequestNotification(io, outcome.replaced.id, outcome.replaced.to_user_id, 'cancelled');
    await notify(io, outcome.replaced.to_user_id, id, `${ownerName} cancelled the ownership transfer of '${outcome.community.name}'.`);
  }
  await sendRealtimeNotification(io, to, {
    category: 'pawcircle',
    type: REQUEST_TYPE,
    title: `${ownerName} wants to transfer ownership of '${outcome.community.name}' to you.`,
    description: 'Accept to become its owner, or decline.',
    avatarUrl: null,
    targetId: String(id),
    senderPetId: null,
    actionStatus: 'pending',
    metadata: { community_id: id, transfer_id: outcome.body.transfer.id },
  });
  await emitTransferUpdated(io, id, [ownerId, to, outcome.replaced?.to_user_id]);
  return { status: outcome.status, body: outcome.body };
}

// DELETE /:id/ownership-transfer -- the Owner withdraws the pending transfer.
export async function cancelTransfer(communityId, ownerId, io) {
  const id = parseInt(communityId, 10);
  const row = await db.get(
    `UPDATE community_ownership_transfers SET status = 'cancelled', responded_at = NOW()
     WHERE community_id = ? AND from_user_id = ? AND status = 'pending' RETURNING id, to_user_id`, [id, ownerId]);
  if (!row) return { status: 404, body: { error: 'NO_PENDING_TRANSFER', message: 'There is no pending ownership transfer to cancel.' } };
  await resolveRequestNotification(io, row.id, row.to_user_id, 'cancelled');
  await notify(io, row.to_user_id, id, `${await usernameOf(ownerId)} cancelled the ownership transfer of '${await circleName(id)}'.`);
  await emitTransferUpdated(io, id, [ownerId, row.to_user_id]);
  return { status: 200, body: { success: true } };
}

// Locks the transfer and checks it belongs to this circle, to this user, and
// is still open. Returns { transfer } or { status, body }.
async function lockOpenTransfer(tx, communityId, transferId, userId) {
  const t = await tx.get(
    `SELECT *, (expires_at <= NOW()) AS expired FROM community_ownership_transfers
     WHERE id = ? AND community_id = ? FOR UPDATE`, [transferId, communityId]);
  if (!t) return { status: 404, body: TRANSFER_NOT_FOUND };
  if (t.to_user_id !== userId) return { status: 403, body: { error: 'NOT_RECIPIENT', message: 'Only the member this transfer was offered to can answer it.' } };
  if (t.status !== 'pending') {
    return { status: 409, body: { error: 'TRANSFER_NOT_PENDING', message: `This transfer was already ${t.status}.`, transferStatus: t.status } };
  }
  if (t.expired) return { status: 410, body: { error: 'TRANSFER_EXPIRED', message: 'This ownership transfer has expired.' } };
  return { transfer: t };
}

// POST /:id/ownership-transfer/:transferId/accept
export async function acceptTransfer(communityId, transferId, userId, io) {
  const id = parseInt(communityId, 10);
  const tid = parseInt(transferId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(tid)) return { status: 404, body: TRANSFER_NOT_FOUND };

  // The recipient's limit for owned circles (same rule as creating one),
  // checked before anything changes; the transfer stays pending if refused.
  const peek = await db.get('SELECT to_user_id FROM community_ownership_transfers WHERE id = ? AND community_id = ?', [tid, id]);
  if (peek && peek.to_user_id === userId) {
    const gate = await canCreateCommunity(userId, io);
    if (!gate.allowed) {
      return {
        status: 409,
        body: {
          error: 'OWNER_LIMIT_REACHED',
          message: `You already own ${gate.limit} PawCircles, the most your ${getPlan(gate.plan).label} plan allows. Delete or hand over one of them, or upgrade, to accept this transfer.`,
          limit: gate.limit,
          plan: gate.plan,
        },
      };
    }
  }

  const outcome = await withTransaction(async tx => {
    const community = await tx.get('SELECT id, name, status FROM communities WHERE id = ? FOR UPDATE', [id]);
    if (!community) return { status: 404, body: TRANSFER_NOT_FOUND };
    const locked = await lockOpenTransfer(tx, id, tid, userId);
    if (!locked.transfer) return locked;
    const t = locked.transfer;
    if (!(await tx.get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', [id, userId]))) {
      await tx.run("UPDATE community_ownership_transfers SET status = 'cancelled', responded_at = NOW() WHERE id = ?", [t.id]);
      return { status: 409, body: { error: 'NOT_A_MEMBER', message: 'You are no longer a member of this PawCircle.' } };
    }
    const frozen = community.status === 'frozen';
    if (frozen) {
      // The owner deleted their account: the circle comes back to life with
      // the recipient as owner; the SniffedOut owner row goes.
      await tx.run('DELETE FROM community_members WHERE community_id = ? AND user_id = ?', [id, t.from_user_id]);
      await tx.run("UPDATE communities SET status = 'active', frozen_at = NULL, frozen_reason = NULL WHERE id = ?", [id]);
    } else {
      const ownerRow = await tx.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [id, t.from_user_id]);
      if (ownerRow?.role !== 'Owner') {
        await tx.run("UPDATE community_ownership_transfers SET status = 'cancelled', responded_at = NOW() WHERE id = ?", [t.id]);
        return { status: 409, body: { error: 'TRANSFER_STALE', message: 'The person who offered this transfer is no longer the owner.' } };
      }
      await tx.run("UPDATE community_members SET role = 'Member' WHERE community_id = ? AND user_id = ?", [id, t.from_user_id]);
    }
    await tx.run("UPDATE community_members SET role = 'Owner' WHERE community_id = ? AND user_id = ?", [id, userId]);
    await tx.run('UPDATE communities SET created_by = ? WHERE id = ?', [userId, id]);
    await tx.run("UPDATE community_ownership_transfers SET status = 'accepted', responded_at = NOW() WHERE id = ?", [t.id]);
    await CommunityRepo.recountMembers(id, tx);
    return { status: 200, body: { success: true, reactivated: frozen }, transfer: t, community };
  });
  if (outcome.status !== 200) {
    if (outcome.body?.error === 'NOT_A_MEMBER' || outcome.body?.error === 'TRANSFER_STALE') await resolveRequestNotification(io, tid, userId, 'cancelled');
    return { status: outcome.status, body: outcome.body };
  }

  const { transfer: t, community } = outcome;
  await resolveRequestNotification(io, t.id, userId, 'accepted');
  await notify(io, t.from_user_id, id, `Ownership transfer successful. ${await usernameOf(userId)} is now the admin of '${community.name}'.`);
  await emitLive(io, `pawcircle_${id}`, 'community_ownership_changed', { communityId: id, ownerId: userId, reactivated: outcome.body.reactivated });
  await emitTransferUpdated(io, id, [t.from_user_id, userId]);
  return { status: 200, body: outcome.body };
}

// POST /:id/ownership-transfer/:transferId/decline
export async function declineTransfer(communityId, transferId, userId, io) {
  const id = parseInt(communityId, 10);
  const tid = parseInt(transferId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(tid)) return { status: 404, body: TRANSFER_NOT_FOUND };
  const outcome = await withTransaction(async tx => {
    const locked = await lockOpenTransfer(tx, id, tid, userId);
    if (!locked.transfer) return locked;
    await tx.run("UPDATE community_ownership_transfers SET status = 'declined', responded_at = NOW() WHERE id = ?", [tid]);
    return { status: 200, body: { success: true }, transfer: locked.transfer };
  });
  if (outcome.status !== 200) return { status: outcome.status, body: outcome.body };
  await resolveRequestNotification(io, tid, userId, 'declined');
  await notify(io, outcome.transfer.from_user_id, id,
    `${await usernameOf(userId)} declined the ownership transfer for '${await circleName(id)}'.`);
  await emitTransferUpdated(io, id, [outcome.transfer.from_user_id, userId]);
  return { status: 200, body: outcome.body };
}

// Pending transfers cancelled because someone left the circle or deleted
// their account (rows: { id, community_id, from_user_id, to_user_id }, from
// frozenCircles.leaveCircle or the account deletion). Tells the other side.
// reason: 'left' | 'deleted'.
export async function notifyCancelledTransfers(io, rows, leaverId, reason) {
  for (const t of rows || []) {
    try {
      const name = await circleName(t.community_id);
      await resolveRequestNotification(io, t.id, t.to_user_id, 'cancelled');
      if (t.to_user_id === leaverId) {
        // The recipient left / deleted their account: tell the owner.
        await notify(io, t.from_user_id, t.community_id, reason === 'deleted'
          ? `The ownership transfer of '${name}' was cancelled: that member deleted their account.`
          : `${await usernameOf(leaverId)} left '${name}', so the ownership transfer was cancelled.`);
      } else {
        // The owner left: tell the recipient.
        await notify(io, t.to_user_id, t.community_id, `The ownership transfer of '${name}' was cancelled.`);
      }
      await emitTransferUpdated(io, t.community_id, [t.from_user_id, t.to_user_id]);
    } catch (err) {
      console.error(`[ownership transfer] could not notify about cancelled transfer #${t.id}:`, err.message);
    }
  }
}

// Hourly (db/cleanup.js): pending transfers past their 5 days expire, and
// both sides are told.
export async function expireOwnershipTransfers(io = null) {
  const rows = await db.all(
    `UPDATE community_ownership_transfers SET status = 'expired', responded_at = NOW()
     WHERE status = 'pending' AND expires_at <= NOW()
     RETURNING id, community_id, from_user_id, to_user_id`);
  for (const t of rows) {
    try {
      const title = `The ownership transfer for '${await circleName(t.community_id)}' expired.`;
      await resolveRequestNotification(io, t.id, t.to_user_id, 'expired');
      await notify(io, t.from_user_id, t.community_id, title);
      await notify(io, t.to_user_id, t.community_id, title);
      await emitTransferUpdated(io, t.community_id, [t.from_user_id, t.to_user_id]);
    } catch (err) {
      console.error(`[ownership transfer] could not notify about expired transfer #${t.id}:`, err.message);
    }
  }
  if (rows.length) console.log(`[ownership transfer] expired ${rows.length} transfer(s)`);
  return rows.length;
}
