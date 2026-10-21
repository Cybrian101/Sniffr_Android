import db from '../db/connection.js';
import UserRepo from '../models/UserRepository.js';

// One blocking rule for the whole app (stored in blocked_users, one row per
// blocker -> blocked pair):
//   A block works in BOTH directions. If either user has blocked the other,
//   neither can message, call, sniff/match, like, react to or comment on the
//   other's posts, reply to the other's comments, mention the other, or see
//   the other's posts, comments, profile, presence or Meet card. Only the
//   blocker can undo it (and only the blocker sees "You blocked ..." with an
//   Unblock button -- the blocked user just sees the person as unavailable).
// It is user-level: blocking a pet blocks its owner, with all their pets.
// Everything is enforced here on the server; the client only reflects it.

export const BLOCKED_BODY = { error: 'BLOCKED', message: "You can't interact with this user." };

// True if either user has blocked the other.
export function isBlockedPair(userA, userB) {
  if (!userA || !userB || userA === userB) return Promise.resolve(false);
  return UserRepo.isBlocked(userA, userB);
}

// { blockedByMe, blockedMe } between the viewer and another user.
export async function blockState(viewerId, otherId) {
  if (!viewerId || !otherId || viewerId === otherId) return { blockedByMe: false, blockedMe: false };
  const rows = await db.all(
    'SELECT blocker_id FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    [viewerId, otherId, otherId, viewerId]);
  return {
    blockedByMe: rows.some(r => r.blocker_id === viewerId),
    blockedMe: rows.some(r => r.blocker_id === otherId),
  };
}

// SQL condition: the user in `userIdColumn` and the viewer are NOT a blocked
// pair. Uses two `?` placeholders -- pass blockParams(viewerId) at that spot.
export function notBlockedSql(userIdColumn) {
  return `NOT EXISTS (SELECT 1 FROM blocked_users bu
    WHERE (bu.blocker_id = ? AND bu.blocked_id = ${userIdColumn})
       OR (bu.blocked_id = ? AND bu.blocker_id = ${userIdColumn}))`;
}
export const blockParams = (viewerId) => [viewerId, viewerId];

// The people this user blocked (not the ones who blocked them -- that list
// would tell a user who blocked them), newest first, with the active pet
// (or first live pet) to show in Settings.
export async function listBlockedByMe(userId) {
  return db.all(
    `SELECT b.blocked_id AS user_id, b.created_at AS blocked_at,
            p.id AS pet_id, p.name AS pet_name, p.pet_username, p.avatar_url AS pet_avatar
     FROM blocked_users b
     JOIN users u ON u.id = b.blocked_id
     LEFT JOIN LATERAL (
       SELECT id, name, pet_username, avatar_url FROM pets
       WHERE user_id = u.id AND deleted_at IS NULL
       ORDER BY (id = u.active_pet_id) DESC, id ASC
       LIMIT 1
     ) p ON TRUE
     WHERE b.blocker_id = ? AND u.deleted_at IS NULL
     ORDER BY b.created_at DESC`,
    [userId]);
}

// Socket rooms (user_<id>) of everyone in a blocked pair with this user --
// for broadcasts that must skip them (io.except(rooms)).
export async function blockedPairRooms(userId) {
  const ids = await UserRepo.getBlockedUserIds(userId);
  return ids.map(id => `user_${id}`);
}
