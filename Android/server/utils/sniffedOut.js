import db from '../db/connection.js';

// Deleted accounts and their pets stay in the database as tombstones
// (users.deleted_at / pets.deleted_at set) so existing chats, comments,
// matches and notifications keep making sense. Everywhere they're shown they
// appear as "SniffedOut" with no avatar and a `sniffed_out: true` flag, and
// any action aimed at them is refused with 403 SNIFFED_OUT.
//
// The real deletion also scrubs the stored name/avatar, but the SQL helpers
// below never rely on that -- a row that is only flagged still comes out as
// "SniffedOut".

export const SNIFFED_OUT = 'SniffedOut';
export const SNIFFED_OUT_BODY = { error: 'SNIFFED_OUT', message: 'This pet parent has left Sniffr.' };

// ── SQL fragments (table aliases are always trusted literals) ──────────
export const sqlGone = (...aliases) => `(${aliases.map(a => `${a}.deleted_at IS NOT NULL`).join(' OR ')})`;
export const sqlUsername = u => `CASE WHEN ${u}.deleted_at IS NOT NULL THEN '${SNIFFED_OUT}' ELSE ${u}.username END`;
export const sqlFullName = u => `CASE WHEN ${u}.deleted_at IS NOT NULL THEN '${SNIFFED_OUT}' ELSE ${u}.full_name END`;
// Pet name: SniffedOut if the pet OR (optionally) its owner is gone.
export const sqlPetName = (p, u = null) =>
  `CASE WHEN ${sqlGone(...[p, u].filter(Boolean))} THEN '${SNIFFED_OUT}' ELSE ${p}.name END`;
// Any other pet/user column: NULL once gone (avatar, handle, breed, bio...).
export const sqlHidden = (expr, ...aliases) => `CASE WHEN ${sqlGone(...aliases)} THEN NULL ELSE ${expr} END`;

// ── JS checks for guarding actions ──────────────────────────────────────
export async function isUserSniffedOut(userId) {
  const row = await db.get('SELECT deleted_at FROM users WHERE id = ?', [userId]);
  return !!row?.deleted_at;
}

// A pet counts as SniffedOut if it or its owner is tombstoned.
export async function isPetSniffedOut(petId) {
  const row = await db.get(
    `SELECT (p.deleted_at IS NOT NULL OR u.deleted_at IS NOT NULL) AS gone
     FROM pets p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    [petId]
  );
  return !!row?.gone;
}

// True if the other side of a 1:1 conversation (from userId's point of view)
// is SniffedOut -- such a conversation is read-only.
export async function isConversationReadOnly(conversationId, userId) {
  const row = await db.get(
    `SELECT bool_or(p.deleted_at IS NOT NULL OR u.deleted_at IS NOT NULL) AS gone
     FROM conversations c
     JOIN matches m ON c.match_id = m.id
     JOIN pets p ON p.id IN (m.pet1_id, m.pet2_id)
     LEFT JOIN users u ON u.id = p.user_id
     WHERE c.id = ? AND (p.user_id IS DISTINCT FROM ?)`,
    [conversationId, userId]
  );
  return !!row?.gone;
}

// True if the post's author (pet or owner) is SniffedOut.
export async function isPostAuthorSniffedOut(postId) {
  const row = await db.get(
    `SELECT (pet.deleted_at IS NOT NULL OR u.deleted_at IS NOT NULL) AS gone
     FROM posts p JOIN pets pet ON pet.id = p.pet_id LEFT JOIN users u ON u.id = pet.user_id
     WHERE p.id = ?`,
    [postId]
  );
  return !!row?.gone;
}

// ── Frozen PawCircles ───────────────────────────────────────────────────
// A circle whose owner is SniffedOut is frozen: members can still read it and
// leave it, every write is refused with 403 COMMUNITY_READ_ONLY, and it's
// hidden from everyone who isn't already a member.
export const COMMUNITY_READ_ONLY_BODY = {
  error: 'COMMUNITY_READ_ONLY',
  message: "This PawCircle's owner deleted their account. It's now read-only.",
};
export const COMMUNITY_UNAVAILABLE_BODY = { error: 'COMMUNITY_UNAVAILABLE', message: 'This PawCircle is no longer available.' };
// A circle its Owner disabled (communities.disabled_at): an archive, read-only
// for every member like a frozen one, until the Owner re-enables it.
export const COMMUNITY_DISABLED_BODY = {
  error: 'COMMUNITY_READ_ONLY',
  reason: 'disabled',
  message: 'This PawCircle has been disabled by its owner.',
};

// SQL: live (non-tombstoned) members of the circle bound to the placeholder.
export const LIVE_MEMBER_COUNT_SQL =
  'SELECT COUNT(*)::int FROM community_members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.deleted_at IS NULL';

export async function isCommunityFrozen(communityId) {
  const id = parseInt(communityId, 10);
  if (!Number.isInteger(id)) return false;
  const row = await db.get('SELECT status FROM communities WHERE id = ?', [id]);
  return row?.status === 'frozen';
}

// Why the circle refuses writes: the frozen or the disabled body, or null.
export async function communityReadOnlyBody(communityId) {
  const id = parseInt(communityId, 10);
  if (!Number.isInteger(id)) return null;
  const row = await db.get('SELECT status, disabled_at FROM communities WHERE id = ?', [id]);
  if (row?.status === 'frozen') return COMMUNITY_READ_ONLY_BODY;
  if (row?.disabled_at) return COMMUNITY_DISABLED_BODY;
  return null;
}

// The circle a PawCircle message belongs to, and whether it's frozen or disabled.
export async function getMessageCommunity(messageId) {
  const id = parseInt(messageId, 10);
  if (!Number.isInteger(id)) return null;
  return db.get(
    `SELECT c.id, c.status = 'frozen' AS frozen, c.disabled_at IS NOT NULL AS disabled
     FROM community_messages m JOIN communities c ON c.id = m.community_id WHERE m.id = ?`,
    [id]
  );
}
