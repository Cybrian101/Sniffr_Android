import db, { withTransaction } from '../db/connection.js';
import CommunityRepo from '../models/CommunityRepository.js';
import { canJoinCommunity } from './premiumGate.js';
import { getPlan } from '../config/plans.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { COMMUNITY_READ_ONLY_BODY, COMMUNITY_UNAVAILABLE_BODY } from '../utils/sniffedOut.js';

// Requests to join a PRIVATE PawCircle. Joining a private circle always
// needs the approval of its Owner or an Admin (the roles that already manage
// members); public circles keep their instant join.
//
// One row per (circle, user) in community_join_requests, reused for every
// new request. status: pending -> accepted | declined | cancelled | expired.
//   - a pending request lives REQUEST_TTL_DAYS; the hourly job marks it
//     expired (and every read treats a pending row past expires_at as gone)
//   - after a decline the same user can ask again after DECLINE_COOLDOWN_HOURS
//   - accepting checks the requester's plan circle limit at that moment
//   - frozen or disabled circles take no requests; freezing cancels pending ones
// Every function returns { status, body } for the route to send as is.

export const REQUEST_TTL_DAYS = 7;
export const DECLINE_COOLDOWN_HOURS = 24;
const MANAGER_ROLES = ['Owner', 'Admin'];

const NOT_FOUND_BODY = { error: 'NOT_FOUND', message: 'PawCircle community not found' };
const REQUEST_NOT_FOUND_BODY = { error: 'REQUEST_NOT_FOUND', message: 'That join request no longer exists.' };

// The circle's live Owner and Admins.
async function managerIds(communityId, q = db) {
  return (await q.all(
    `SELECT m.user_id FROM community_members m JOIN users u ON u.id = m.user_id
     WHERE m.community_id = ? AND m.role = ANY(?::text[]) AND u.deleted_at IS NULL`,
    [communityId, MANAGER_ROLES])).map(r => r.user_id);
}

// The user's pet as shown on a request (active pet first).
async function requesterPet(userId, q = db) {
  return q.get(
    `SELECT p.id, p.name, p.avatar_url FROM pets p JOIN users u ON u.id = p.user_id
     WHERE p.user_id = ? AND p.deleted_at IS NULL
     ORDER BY (p.id = u.active_pet_id) DESC NULLS LAST, p.id LIMIT 1`, [userId]);
}

// Tells open circle pages that the Requests list changed.
async function announceRequestsChanged(io, communityId) {
  if (!io) return;
  for (const id of await managerIds(communityId)) io.to(`user_${id}`).emit('community_join_requests_changed', { communityId });
}

// POST /:id/join-request
export async function requestToJoin(communityId, userId, io) {
  const id = parseInt(communityId, 10);
  const community = Number.isInteger(id)
    ? await db.get('SELECT id, name, is_private, status, disabled_at FROM communities WHERE id = ?', [id])
    : null;
  if (!community) return { status: 404, body: NOT_FOUND_BODY };
  if (community.disabled_at) return { status: 404, body: COMMUNITY_UNAVAILABLE_BODY };
  if (community.status === 'frozen') return { status: 403, body: COMMUNITY_READ_ONLY_BODY };
  if (!community.is_private) {
    return { status: 400, body: { error: 'NOT_PRIVATE', message: 'This PawCircle is public: join it directly.' } };
  }
  if (await CommunityRepo.isMember(id, userId)) {
    return { status: 409, body: { error: 'ALREADY_MEMBER', message: "You're already in this PawCircle." } };
  }
  // Same limit as a direct join, so nobody waits on a request that couldn't
  // be accepted anyway (it's checked again on accept).
  const gate = await canJoinCommunity(userId, io);
  if (!gate.allowed) {
    return {
      status: 403,
      body: {
        error: gate.reason,
        message: `Free accounts can join up to ${gate.limit} PawCircles. Upgrade to Premium to join unlimited PawCircles.`,
        plan: gate.plan,
        limit: gate.limit,
      },
    };
  }

  const result = await withTransaction(async tx => {
    const existing = await tx.get(
      `SELECT id, status, expires_at, (status = 'pending' AND expires_at > NOW()) AS active,
              CASE WHEN status = 'declined' AND decided_at > NOW() - make_interval(hours => ?)
                   THEN CEIL(EXTRACT(EPOCH FROM (decided_at + make_interval(hours => ?) - NOW())))::int END AS cooldown_seconds
       FROM community_join_requests WHERE community_id = ? AND user_id = ? FOR UPDATE`,
      [DECLINE_COOLDOWN_HOURS, DECLINE_COOLDOWN_HOURS, id, userId]);
    if (existing?.active) return { created: false, request: existing };
    if (existing?.cooldown_seconds > 0) return { cooldownSeconds: existing.cooldown_seconds };
    const request = await tx.get(
      `INSERT INTO community_join_requests (community_id, user_id, status, created_at, expires_at)
       VALUES (?, ?, 'pending', NOW(), NOW() + make_interval(days => ?))
       ON CONFLICT (community_id, user_id) DO UPDATE
         SET status = 'pending', created_at = NOW(), expires_at = EXCLUDED.expires_at, decided_at = NULL, decided_by = NULL
       RETURNING id, expires_at`,
      [id, userId, REQUEST_TTL_DAYS]);
    return { created: true, request };
  });

  if (result.cooldownSeconds) {
    return {
      status: 429,
      body: {
        error: 'REQUEST_COOLDOWN',
        message: `Your last request was declined. You can ask again in ${Math.ceil(result.cooldownSeconds / 3600)} hour(s).`,
        retryAfterSeconds: result.cooldownSeconds,
      },
    };
  }
  if (result.created) {
    const pet = await requesterPet(userId);
    const petName = pet?.name || 'A pet parent';
    for (const managerId of await managerIds(id)) {
      await sendRealtimeNotification(io, managerId, {
        category: 'pawcircle',
        type: 'community_join_request',
        title: `${petName} wants to join ${community.name} 🐾`,
        description: 'Open the PawCircle to accept or decline.',
        avatarUrl: pet?.avatar_url || null,
        targetId: String(id),
        senderPetId: pet?.id || null,
        metadata: { community_id: id, request_id: result.request.id },
      });
    }
    await announceRequestsChanged(io, id);
  }
  return {
    status: result.created ? 201 : 200,
    body: { joinStatus: 'Requested', request: { id: result.request.id, expiresAt: result.request.expires_at } },
  };
}

// DELETE /:id/join-request -- the requester withdraws a pending request.
export async function cancelJoinRequest(communityId, userId, io) {
  const id = parseInt(communityId, 10);
  const row = Number.isInteger(id) ? await db.get(
    `UPDATE community_join_requests SET status = 'cancelled', decided_at = NOW()
     WHERE community_id = ? AND user_id = ? AND status = 'pending' AND expires_at > NOW()
     RETURNING id`, [id, userId]) : null;
  if (!row) return { status: 404, body: { error: 'NO_PENDING_REQUEST', message: 'There is no pending request to cancel.' } };
  await announceRequestsChanged(io, id);
  return { status: 200, body: { joinStatus: 'Request to Join' } };
}

// GET /:id/join-requests -- pending, unexpired requests from live users.
export async function listJoinRequests(communityId) {
  const requests = await db.all(
    `SELECT r.id, r.user_id, r.created_at, r.expires_at, u.username, u.full_name,
            p.id AS pet_id, p.name AS pet_name, p.avatar_url AS pet_avatar
     FROM community_join_requests r
     JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT id, name, avatar_url FROM pets
       WHERE user_id = u.id AND deleted_at IS NULL
       ORDER BY (id = u.active_pet_id) DESC NULLS LAST, id LIMIT 1
     ) p ON TRUE
     WHERE r.community_id = ? AND r.status = 'pending' AND r.expires_at > NOW()
     ORDER BY r.created_at ASC`, [parseInt(communityId, 10)]);
  return { status: 200, body: { requests } };
}

// Locks and checks a request for accept/decline. Returns { request } or
// { status, body } (an expired one is marked expired on the way).
async function lockPendingRequest(tx, communityId, requestId) {
  const request = await tx.get(
    `SELECT r.id, r.user_id, r.status, (r.expires_at <= NOW()) AS expired, u.deleted_at
     FROM community_join_requests r JOIN users u ON u.id = r.user_id
     WHERE r.id = ? AND r.community_id = ? FOR UPDATE OF r`, [requestId, communityId]);
  if (!request || request.deleted_at) return { status: 404, body: REQUEST_NOT_FOUND_BODY };
  if (request.status !== 'pending') {
    return { status: 409, body: { error: 'REQUEST_NOT_PENDING', message: `This request was already ${request.status}.`, requestStatus: request.status } };
  }
  if (request.expired) {
    await tx.run("UPDATE community_join_requests SET status = 'expired', decided_at = NOW() WHERE id = ?", [request.id]);
    return { status: 410, body: { error: 'REQUEST_EXPIRED', message: 'This request expired. They can send a new one.' } };
  }
  return { request };
}

// POST /:id/join-requests/:requestId/accept
export async function acceptJoinRequest(communityId, requestId, managerId, io) {
  const id = parseInt(communityId, 10);
  const reqId = parseInt(requestId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(reqId)) return { status: 404, body: REQUEST_NOT_FOUND_BODY };
  const peek = await db.get('SELECT user_id FROM community_join_requests WHERE id = ? AND community_id = ?', [reqId, id]);
  if (!peek) return { status: 404, body: REQUEST_NOT_FOUND_BODY };

  // The requester's plan limit, as it is right now.
  const gate = await canJoinCommunity(peek.user_id, io);
  if (!gate.allowed) {
    return {
      status: 409,
      body: {
        error: 'REQUESTER_LIMIT_REACHED',
        message: `This pet parent is already in ${gate.limit} PawCircles, the most their ${getPlan(gate.plan).label} plan allows. They need to leave one or upgrade before you can accept.`,
        limit: gate.limit,
        plan: gate.plan,
      },
    };
  }

  const outcome = await withTransaction(async tx => {
    const community = await tx.get('SELECT id, name, status, disabled_at FROM communities WHERE id = ? FOR UPDATE', [id]);
    if (!community) return { status: 404, body: NOT_FOUND_BODY };
    if (community.status === 'frozen') return { status: 403, body: COMMUNITY_READ_ONLY_BODY };
    if (community.disabled_at) return { status: 404, body: COMMUNITY_UNAVAILABLE_BODY };
    const locked = await lockPendingRequest(tx, id, reqId);
    if (!locked.request) return locked;
    await tx.run(
      "INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'Member') ON CONFLICT (community_id, user_id) DO NOTHING",
      [id, locked.request.user_id]);
    await tx.run(
      "UPDATE community_join_requests SET status = 'accepted', decided_at = NOW(), decided_by = ? WHERE id = ?",
      [managerId, reqId]);
    await CommunityRepo.recountMembers(id, tx);
    return { status: 200, body: { success: true, userId: locked.request.user_id }, community };
  });
  if (outcome.status !== 200) return outcome;

  const userId = outcome.body.userId;
  const pet = await requesterPet(userId);
  const welcome = await CommunityRepo.addMessage({
    community_id: id,
    sender_id: userId,
    content: `🐾 ${pet?.name || 'A new playmate'} joined the pack!`,
    message_type: 'system',
  });
  if (io) io.to(`pawcircle_${id}`).emit('community_message_received', welcome);
  await sendRealtimeNotification(io, userId, {
    category: 'pawcircle',
    type: 'community_join_accepted',
    title: "You're in! 🐾",
    description: `Your request to join ${outcome.community.name} was accepted.`,
    avatarUrl: null,
    targetId: String(id),
    senderPetId: null,
    metadata: { community_id: id },
  });
  if (io) io.to(`user_${userId}`).emit('community_join_request_updated', { communityId: id, status: 'accepted' });
  await announceRequestsChanged(io, id);
  return { status: 200, body: { success: true, userId } };
}

// POST /:id/join-requests/:requestId/decline
export async function declineJoinRequest(communityId, requestId, managerId, io) {
  const id = parseInt(communityId, 10);
  const reqId = parseInt(requestId, 10);
  if (!Number.isInteger(id) || !Number.isInteger(reqId)) return { status: 404, body: REQUEST_NOT_FOUND_BODY };
  const outcome = await withTransaction(async tx => {
    const community = await tx.get('SELECT id, name FROM communities WHERE id = ?', [id]);
    if (!community) return { status: 404, body: NOT_FOUND_BODY };
    const locked = await lockPendingRequest(tx, id, reqId);
    if (!locked.request) return locked;
    await tx.run(
      "UPDATE community_join_requests SET status = 'declined', decided_at = NOW(), decided_by = ? WHERE id = ?",
      [managerId, reqId]);
    return { status: 200, body: { success: true, userId: locked.request.user_id }, community };
  });
  if (outcome.status !== 200) return outcome;

  const userId = outcome.body.userId;
  await sendRealtimeNotification(io, userId, {
    category: 'pawcircle',
    type: 'community_join_declined',
    title: `Your request to join ${outcome.community.name} was declined`,
    description: `You can ask again in ${DECLINE_COOLDOWN_HOURS} hours.`,
    avatarUrl: null,
    targetId: String(id),
    senderPetId: null,
    metadata: { community_id: id },
  });
  if (io) io.to(`user_${userId}`).emit('community_join_request_updated', { communityId: id, status: 'declined' });
  await announceRequestsChanged(io, id);
  return { status: 200, body: { success: true, userId } };
}

// Cancels the pending requests of these circles (they were frozen or
// disabled). q: a transaction handle or the pool. Returns how many.
export async function cancelPendingRequestsForCircles(circleIds, q = db) {
  if (!circleIds?.length) return 0;
  const res = await q.run(
    "UPDATE community_join_requests SET status = 'cancelled', decided_at = NOW() WHERE community_id = ANY(?::int[]) AND status = 'pending'",
    [circleIds]);
  return res.rowCount || 0;
}

// Hourly (db/cleanup.js): pending requests past their 7 days become expired.
export async function expireJoinRequests() {
  const res = await db.run(
    "UPDATE community_join_requests SET status = 'expired', decided_at = NOW() WHERE status = 'pending' AND expires_at <= NOW()");
  if (res.rowCount) console.log(`[circle requests] expired ${res.rowCount} join request(s)`);
  return res.rowCount || 0;
}
