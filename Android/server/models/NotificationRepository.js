import BaseRepository from './BaseRepository.js';
import db, { withTransaction } from '../db/connection.js';
import PetRepo from './PetRepository.js';
import MatchRepo from './MatchRepository.js';
import { hasCurrentAccess } from '../services/subscriptionService.js';
import { SNIFFED_OUT, isPetSniffedOut, isUserSniffedOut } from '../utils/sniffedOut.js';
import { notBlockedSql, blockParams, isBlockedPair } from '../services/blocks.js';

// The sender pet's owner (NULL for system notifications, which always pass).
const NOT_FROM_BLOCKED = notBlockedSql('(SELECT sp.user_id FROM pets sp WHERE sp.id = notifications.sender_pet_id)');

// Global, whole-word, literal match for a pet name inside notification text.
function wholeWord(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

class NotificationRepository extends BaseRepository {
  constructor() {
    super('notifications');
  }

  // The sender's pet name is already baked into `title`/`description` as
  // flat text at creation time (e.g. "Rex liked your post"), so there's no
  // structured pet object to attach a badge to per-notification card --
  // this looks up the sender pet's owner premium status once and attaches
  // it as `is_premium` so the UI can render the badge alongside the title.
  //
  // Also flags a SniffedOut sender (sender_sniffed_out): no avatar, no
  // premium badge, and -- if the stored text still has the old pet name
  // (a tombstone that hasn't been scrubbed yet) -- that name reads as
  // "SniffedOut". A real deletion rewrites the stored text itself.
  async _attachSenderPremium(notif) {
    if (!notif) return notif;
    notif.sender_sniffed_out = false;
    if (!notif.sender_pet_id) { notif.is_premium = false; return notif; }
    const owner = await db.get(
      `SELECT u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date, p.name AS pet_name,
              (p.deleted_at IS NOT NULL OR u.deleted_at IS NOT NULL) AS sniffed_out
       FROM pets p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
      [notif.sender_pet_id]
    );
    if (owner?.sniffed_out) {
      notif.sender_sniffed_out = true;
      notif.is_premium = false;
      notif.avatar_url = null;
      if (owner.pet_name && owner.pet_name !== SNIFFED_OUT) {
        const name = wholeWord(owner.pet_name);
        if (notif.title) notif.title = notif.title.replace(name, SNIFFED_OUT);
        if (notif.description) notif.description = notif.description.replace(name, SNIFFED_OUT);
      }
      return notif;
    }
    notif.is_premium = !!(owner && hasCurrentAccess(owner) && owner.premium_badge_enabled);
    return notif;
  }

  async getPreferences(userId) {
    let pref = await db.get('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
    if (!pref) {
      await db.run(
        'INSERT INTO notification_preferences (user_id, matches, activity, pawcircle, nearby, offers, email) VALUES (?, 1, 1, 1, 1, 1, 1)',
        [userId]
      );
      pref = await db.get('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
    }
    return pref;
  }

  async updatePreferences(userId, prefs) {
    const current = await this.getPreferences(userId);
    const keys = ['matches', 'activity', 'pawcircle', 'nearby', 'offers', 'email'];
    const updates = {};
    keys.forEach(k => {
      if (prefs[k] !== undefined) updates[k] = prefs[k] ? 1 : 0;
    });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    if (setClause) {
      await db.run(`UPDATE notification_preferences SET ${setClause} WHERE user_id = ?`, [...Object.values(updates), userId]);
    }
    return this.getPreferences(userId);
  }

  async getUnreadCount(userId) {
    const row = await db.get(`SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0 AND ${NOT_FROM_BLOCKED}`,
      [userId, ...blockParams(userId)]);
    return row ? Number(row.count) : 0;
  }

  async getByUserId(userId, { page = 1, limit = 20, category = 'all' } = {}) {
    const offset = (page - 1) * limit;
    // Notifications from someone in a blocked pair with this user (sent
    // before the block) are hidden, and left out of the unread badge.
    let whereSql = `WHERE user_id = ? AND ${NOT_FROM_BLOCKED}`;
    const params = [userId, ...blockParams(userId)];

    if (category && category !== 'all') {
      whereSql += ' AND category = ?';
      params.push(category);
    }

    const notifications = await db.all(
      `SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    await Promise.all(notifications.map(n => this._attachSenderPremium(n)));

    const totalRow = await db.get(`SELECT COUNT(*) as count FROM notifications ${whereSql}`, params);
    const total = totalRow ? Number(totalRow.count) : 0;
    const unreadCount = await this.getUnreadCount(userId);

    return {
      notifications,
      total,
      unreadCount,
      hasMore: offset + limit < total,
      page,
    };
  }

  async markAsRead(id, userId) {
    await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
    return db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  }

  async markAllAsRead(userId) {
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
    return { success: true };
  }

  async deleteById(id) {
    const result = await db.run('DELETE FROM notifications WHERE id = ? RETURNING *', [id]);
    return result.rows[0] || null;
  }

  // Writes the past-tense action_status the UI actually checks for
  // ('accepted'/'declined') -- NOT the bare verb from a request body
  // ('accept'/'decline'), which previously caused an accepted request to
  // mis-render as "Request Declined" in NotificationsPanel.jsx.
  async markActionStatus(notificationId, actionStatus) {
    await db.run('UPDATE notifications SET action_status = ?, is_read = 1 WHERE id = ?', [actionStatus, notificationId]);
    return this.findById(notificationId);
  }

  // Accept/Reject pressed directly on a "sniff request" notification card.
  // Delegates the actual state-machine work to MatchRepository so this path
  // and the Pending-tab's POST /matches/pending/:petId/respond share one
  // implementation -- neither duplicates the other's business logic.
  async respondToMatchRequest(notificationId, userId, action) {
    const notif = await db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [notificationId, userId]);
    if (!notif || !notif.sender_pet_id) return null;
    // A request from a SniffedOut pet can't be accepted or declined.
    if (await isPetSniffedOut(notif.sender_pet_id)) return { sniffedOut: true };
    // No matching with someone in a blocked pair (declining stays allowed).
    if (action === 'accept') {
      const sender = await PetRepo.findById(notif.sender_pet_id);
      if (sender && await isBlockedPair(userId, sender.user_id)) return { blocked: true };
    }

    // M3: resolve the pet this specific request was actually addressed to,
    // not whichever pet happens to be active right now -- see
    // MatchRepository.findRecipientPetForRequest. Responding to a sniff
    // notification is exactly the scenario this bug was reported against:
    // the user taps Accept/Reject straight from the notification without
    // necessarily having the targeted pet active.
    const recipientPetId = (await MatchRepo.findRecipientPetForRequest(userId, notif.sender_pet_id))
      || (await PetRepo.getActivePet(userId))?.id;
    if (!recipientPetId) return null;

    let matchResult;
    if (action === 'accept') {
      matchResult = await MatchRepo.acceptMeetRequest(recipientPetId, notif.sender_pet_id);
      await this.markActionStatus(notificationId, matchResult.matched ? 'accepted' : 'declined');
    } else {
      matchResult = await MatchRepo.rejectMeetRequest(recipientPetId, notif.sender_pet_id);
      await this.markActionStatus(notificationId, 'declined');
    }

    return {
      notification: await this.findById(notificationId),
      matchResult,
      requesterPetId: notif.sender_pet_id,
    };
  }

  // ── Shared grouping helper for lick/comment notifications ──────────
  // Both types now work identically: track actual actor names in
  // metadata_json from the very first event, never parse names out of
  // old title text (that was the root cause of the "New and X others"
  // bug -- it was literally grabbing the word "New" from a hardcoded
  // title string).
  async _createGroupedActivityNotification({
    userId, category, type, targetId, senderPetId, actionStatus,
    avatarUrl, actorName, singleDescription,
  }) {
    // Locked on (userId, type, targetId) -- without this, two near-
    // simultaneous likes/comments on the same post could both read "no
    // recent grouped notification" before either write commits, each
    // INSERTing its own row instead of merging into one, inflating the
    // unread count for what should read as a single grouped notification.
    return withTransaction((tx) => this._createGroupedActivityNotificationLocked(tx, {
      userId, category, type, targetId, senderPetId, actionStatus, avatarUrl, actorName, singleDescription,
    }));
  }

  async _createGroupedActivityNotificationLocked(tx, {
    userId, category, type, targetId, senderPetId, actionStatus,
    avatarUrl, actorName, singleDescription,
  }) {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext(?))', [`notif:${userId}:${type}:${targetId}`]);

    const recent = await tx.get(
      "SELECT * FROM notifications WHERE user_id = ? AND type = ? AND target_id = ? AND created_at > NOW() - INTERVAL '12 hours'",
      [userId, type, targetId]
    );

    // metadata_json = { names, pet_ids }: pet_ids[i] is the pet behind
    // names[i] (null for entries written before pet ids were stored), so an
    // account deletion can find its own entries without guessing by name.
    let names = [actorName];
    let petIds = [senderPetId ?? null];
    if (recent) {
      try {
        const meta = recent.metadata_json ? JSON.parse(recent.metadata_json) : { names: [] };
        const existingNames = Array.isArray(meta.names) ? meta.names : [];
        const existingPetIds = Array.isArray(meta.pet_ids) ? meta.pet_ids : [];
        const others = existingNames
          .map((name, i) => ({ name, petId: existingPetIds[i] ?? null }))
          // Drop this actor's earlier entry: by pet id when known, else by name.
          .filter(e => (senderPetId && e.petId != null) ? e.petId !== senderPetId : e.name !== actorName);
        names = [actorName, ...others.map(e => e.name)];
        petIds = [senderPetId ?? null, ...others.map(e => e.petId)];
      } catch (e) {
        names = [actorName];
        petIds = [senderPetId ?? null];
      }
    }

    const groupedTitle = buildGroupedActivityTitle(type, names);
    // Single actor: show the specific detail (e.g. the actual comment text).
    // Once grouped the title alone is fully descriptive -- avoid showing the
    // same sentence twice. Empty string, not NULL: description is NOT NULL,
    // and NULL here used to make every grouped update fail silently, so a
    // like/comment notification never grew past its first actor.
    const groupedDescription = names.length === 1 ? (singleDescription || groupedTitle) : '';

    const updatedMeta = JSON.stringify({ names, pet_ids: petIds });

    // Writes go through tx, inside the advisory lock above, and only while the
    // recipient is live (RECIPIENT_IS_LIVE): never for a deleted account.
    if (recent) {
      const result = await tx.run(
        `UPDATE notifications SET title = ?, description = ?, avatar_url = ?, metadata_json = ?, is_read = 0, created_at = CURRENT_TIMESTAMP
         WHERE id = ? AND ${RECIPIENT_IS_LIVE}`,
        [groupedTitle, groupedDescription, avatarUrl, updatedMeta, recent.id, userId]
      );
      if (!result.rowCount) return null;
      const updated = await tx.get('SELECT * FROM notifications WHERE id = ?', [recent.id]);
      return this._attachSenderPremium(updated);
    } else {
      const id = await insertForLiveRecipient(
        [userId, category, type, groupedTitle, groupedDescription, avatarUrl, targetId, senderPetId, actionStatus, updatedMeta],
        tx
      );
      if (!id) return null;
      const created = await tx.get('SELECT * FROM notifications WHERE id = ?', [id]);
      return this._attachSenderPremium(created);
    }
  }

  async createNotification({
    userId,
    category,
    type,
    title,
    description,
    avatarUrl = null,
    targetId = null,
    senderPetId = null,
    actionStatus = 'pending',
    metadata = null,
    actorName = null,
  }) {
    // A SniffedOut (deleted) account never gets a notification. Checked up
    // front so no preferences row is created for it either; the writes
    // below re-check atomically, which is what actually closes the race
    // with background senders (e.g. Spotlight broadcasts).
    if (await isUserSniffedOut(userId)) return null;

    // Check preferences
    const prefs = await this.getPreferences(userId);
    if (prefs[category] === 0) return null;

    if ((type === 'lick' || type === 'comment') && targetId && actorName) {
      return this._createGroupedActivityNotification({
        userId, category, type, targetId, senderPetId, actionStatus,
        avatarUrl, actorName, singleDescription: description,
      });
    }

    const metaStr = metadata ? JSON.stringify(metadata) : null;
    const id = await insertForLiveRecipient(
      [userId, category, type, title, description, avatarUrl, targetId, senderPetId, actionStatus, metaStr]
    );
    if (!id) return null;

    const created = await db.get('SELECT * FROM notifications WHERE id = ?', [id]);
    return this._attachSenderPremium(created);
  }
}

// Title of a grouped lick/comment notification from its actor names (most
// recent first). Shared with account deletion, which rewrites these titles.
export function buildGroupedActivityTitle(type, names) {
  const verb = type === 'lick' ? 'liked your post' : 'commented on your post';
  const emoji = type === 'lick' ? '🐾' : '💬';
  if (names.length === 1) return `${names[0]} ${verb} ${emoji}`;
  if (names.length === 2) return `${names[0]} and 1 other ${verb} ${emoji}`;
  return `${names[0]} and ${names.length - 1} others ${verb} ${emoji}`;
}

// True only while the recipient (the last `?` parameter) exists and isn't
// SniffedOut. FOR SHARE makes the write wait for an in-progress account
// deletion (which holds the users row FOR UPDATE) and then re-check, so a
// notification can never be written for an account being deleted.
const RECIPIENT_IS_LIVE = 'EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL FOR SHARE)';

// Inserts a notification row only if the recipient is live, in one
// statement. Returns the new id, or null if nothing was written. `q` is the
// pool by default, or a transaction handle (grouped notifications).
async function insertForLiveRecipient([userId, category, type, title, description, avatarUrl, targetId, senderPetId, actionStatus, metadataJson], q = db) {
  const result = await q.run(
    `INSERT INTO notifications (user_id, category, type, title, description, avatar_url, target_id, sender_pet_id, action_status, metadata_json)
     SELECT ?::int, ?, ?, ?, ?, ?, ?, ?::int, ?, ?
     WHERE ${RECIPIENT_IS_LIVE}
     RETURNING id`,
    // description is NOT NULL in the schema; a caller that omits it gets ''.
    [userId, category, type, title, description ?? '', avatarUrl,
      targetId === null || targetId === undefined ? null : String(targetId),
      senderPetId, actionStatus, metadataJson, userId]
  );
  return result.rows[0]?.id ?? null;
}

export default new NotificationRepository();