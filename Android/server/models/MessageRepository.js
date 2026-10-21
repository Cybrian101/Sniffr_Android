import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';
import PetRepo from './PetRepository.js';
import { hasCurrentAccess } from '../services/subscriptionService.js';
import { sqlUsername, sqlPetName, sqlHidden, sqlGone, SNIFFED_OUT } from '../utils/sniffedOut.js';

// Sender of a message (users alias `u`): a SniffedOut sender shows as
// "SniffedOut" with no avatar.
const SENDER_COLUMNS = `
  ${sqlUsername('u')} AS sender_username,
  ${sqlHidden(`COALESCE((SELECT avatar_url FROM pets WHERE id = u.active_pet_id), (SELECT avatar_url FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))`, 'u')} AS sender_avatar,
  ${sqlGone('u')} AS sender_sniffed_out`;

// Reply preview (messages alias `reply`), same rule for its sender.
const REPLY_COLUMNS = `
  reply.content AS reply_content,
  reply.sender_id AS reply_sender_id,
  reply.message_type AS reply_message_type,
  (SELECT CASE WHEN ru.deleted_at IS NOT NULL THEN '${SNIFFED_OUT}' ELSE ru.username END FROM users ru WHERE ru.id = reply.sender_id) AS reply_sender_username,
  (SELECT ru.deleted_at IS NOT NULL FROM users ru WHERE ru.id = reply.sender_id) AS reply_sender_sniffed_out`;

class MessageRepository extends BaseRepository {
  constructor() { super('messages'); }

  // `partner` is the other pet in each conversation. A conversation whose
  // partner is SniffedOut stays listed (other_sniffed_out) but is read-only.
  async getConversations(userId) {
    const activePet = await PetRepo.getActivePet(userId);
    if (!activePet) return [];
    const conversations = await db.all(`
      SELECT c.*, m.pet1_id, m.pet2_id,
        ${sqlPetName('partner', 'pu')} as partner_name,
        ${sqlHidden('partner.avatar_url', 'partner', 'pu')} as partner_avatar,
        partner.id as partner_pet_id,
        ${sqlHidden('partner.pet_username', 'partner', 'pu')} as partner_username,
        partner.user_id as partner_user_id,
        ${sqlHidden('pu.last_active_at', 'partner', 'pu')} as partner_last_active_at,
        pu.subscription_status as partner_subscription_status,
        pu.premium_badge_enabled as partner_premium_badge_enabled,
        pu.plan_expiry_date as partner_plan_expiry_date,
        ${sqlGone('partner', 'pu')} as other_sniffed_out,
        ${sqlGone('partner', 'pu')} as read_only,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        -- So the chat list can show "📍 Meetup invitation", "📷 Photo"... instead of raw content.
        (SELECT message_type FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_type,
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND status != 'seen') as unread_count,
        -- A blocked pair (either way, services/blocks.js): the chat stays
        -- listed, read-only; only the blocker can unblock.
        EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id = ? AND b.blocked_id = partner.user_id)
                                                OR (b.blocker_id = partner.user_id AND b.blocked_id = ?)) as blocked,
        EXISTS (SELECT 1 FROM blocked_users b WHERE b.blocker_id = ? AND b.blocked_id = partner.user_id) as blocked_by_me
      FROM conversations c
      JOIN matches m ON c.match_id = m.id
      JOIN pets partner ON partner.id = CASE WHEN m.pet1_id = ? THEN m.pet2_id ELSE m.pet1_id END
      LEFT JOIN users pu ON pu.id = partner.user_id
      WHERE m.pet1_id = ? OR m.pet2_id = ?
      ORDER BY last_message_at DESC
    `, [userId, userId, userId, userId, activePet.id, activePet.id, activePet.id]);

    conversations.forEach(c => {
      c.is_premium = !c.other_sniffed_out && !!(hasCurrentAccess({
        subscription_status: c.partner_subscription_status,
        plan_expiry_date: c.partner_plan_expiry_date,
      }) && c.partner_premium_badge_enabled);
    });
    return conversations;
  }

  async getMessages(conversationId, page = 1, limit = 30) {
    const offset = (page - 1) * limit;
    const rows = await db.all(`
      SELECT msg.*, ${SENDER_COLUMNS},
        ${REPLY_COLUMNS},
        (
          SELECT COALESCE(json_object_agg(mr.reaction, mr.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM message_reactions
            WHERE message_id = msg.id
            GROUP BY reaction
          ) mr
        ) as reactions
      FROM messages msg
      JOIN users u ON msg.sender_id = u.id
      LEFT JOIN messages reply ON msg.reply_to_id = reply.id AND reply.conversation_id = msg.conversation_id
      WHERE msg.conversation_id = ?
      ORDER BY msg.created_at DESC
      LIMIT ? OFFSET ?
    `, [conversationId, limit, offset]);
    return rows.reverse();
  }

  async sendMessage(conversationId, senderId, content, mediaUrl = null, messageType = 'text', replyToId = null) {
    const result = await db.run(
      'INSERT INTO messages (conversation_id, sender_id, content, media_url, message_type, status, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [conversationId, senderId, content, mediaUrl, messageType, 'sent', replyToId]
    );
    const newId = result.rows[0].id;
    return db.get(`
      SELECT msg.*, ${SENDER_COLUMNS},
        ${REPLY_COLUMNS}
      FROM messages msg
      JOIN users u ON msg.sender_id = u.id
      LEFT JOIN messages reply ON msg.reply_to_id = reply.id AND reply.conversation_id = msg.conversation_id
      WHERE msg.id = ?
    `, [newId]);
  }

  async markDelivered(messageId) {
    await db.run("UPDATE messages SET status = 'delivered', delivered_at = NOW() WHERE id = ? AND status = 'sent'", [messageId]);
  }

  async markSeen(conversationId, userId) {
    await db.run(`UPDATE messages SET status = 'seen', seen_at = NOW()
      WHERE conversation_id = ? AND sender_id != ? AND status != 'seen'`, [conversationId, userId]);
  }

  async getUndelivered(userId) {
  return db.all(`
    SELECT msg.*, c.id AS conversation_id
    FROM messages msg
    JOIN conversations c
      ON msg.conversation_id = c.id
    JOIN matches m
      ON c.match_id = m.id
    WHERE msg.status = 'sent'
      AND msg.sender_id != ?
      AND (
        m.pet1_id IN (
          SELECT id FROM pets WHERE user_id = ?
        )
        OR
        m.pet2_id IN (
          SELECT id FROM pets WHERE user_id = ?
        )
      )
  `, [userId, userId, userId]);
}

  async canAccessConversation(conversationId, userId) {
    return db.get(`
      SELECT c.id FROM conversations c
      JOIN matches m ON c.match_id = m.id
      WHERE c.id = ?
        AND (m.pet1_id IN (SELECT id FROM pets WHERE user_id = ?)
          OR m.pet2_id IN (SELECT id FROM pets WHERE user_id = ?))
    `, [conversationId, userId, userId]);
  }

  // A reply may only quote a message of the same conversation: the reply
  // preview carries the quoted message's text and sender.
  async isMessageInConversation(messageId, conversationId) {
    return !!(await db.get('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conversationId]));
  }

  // Resolves the OTHER participant's user_id for a conversation the caller
  // is already confirmed to be in -- used to enforce block checks on
  // existing conversations, not just at conversation-creation time.
  async getOtherParticipantUserId(conversationId, userId) {
    const row = await db.get(`
      SELECT CASE WHEN p1.user_id = ? THEN p2.user_id ELSE p1.user_id END as other_user_id
      FROM conversations c
      JOIN matches m ON c.match_id = m.id
      JOIN pets p1 ON m.pet1_id = p1.id
      JOIN pets p2 ON m.pet2_id = p2.id
      WHERE c.id = ?
    `, [userId, conversationId]);
    return row ? row.other_user_id : null;
  }

  async findOrCreateConversation(petId1, petId2) {
    let match = await db.get('SELECT id FROM matches WHERE (pet1_id = ? AND pet2_id = ?) OR (pet1_id = ? AND pet2_id = ?)', [petId1, petId2, petId2, petId1]);

    if (!match) {
      // source='chat' distinguishes this incidental conversation-linkage row
      // from a real Meet match (source='meet', created by MatchRepository) --
      // Meet's "Accepted" list and getExcludedMeetPetIds's permanent-match
      // exclusion both filter on source='meet' so a pet you only ever
      // messaged directly is never mistaken for a Meet match.
      const matchResult = await db.run("INSERT INTO matches (pet1_id, pet2_id, source) VALUES (?, ?, 'chat') RETURNING id", [petId1, petId2]);
      match = { id: matchResult.rows[0].id };
    }

    let conversation = await db.get('SELECT * FROM conversations WHERE match_id = ?', [match.id]);

    if (!conversation) {
      const convResult = await db.run('INSERT INTO conversations (match_id) VALUES (?) RETURNING id', [match.id]);
      conversation = await db.get('SELECT * FROM conversations WHERE id = ?', [convResult.rows[0].id]);
    }

    return conversation;
  }

  async updateMessageContent(messageId, newContent) {
    await db.run('UPDATE messages SET content = ? WHERE id = ?', [newContent, messageId]);
    return db.get(`
      SELECT msg.*, ${SENDER_COLUMNS}
      FROM messages msg JOIN users u ON msg.sender_id = u.id WHERE msg.id = ?
    `, [messageId]);
  }

  async fetchBackMessage(messageId, userId) {
    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg || msg.sender_id !== userId) return null;

    await db.run("UPDATE messages SET content = '🐾 This message was fetched back.', message_type = 'system', media_url = NULL WHERE id = ?", [messageId]);
    return db.get(`
      SELECT msg.*, ${SENDER_COLUMNS}
      FROM messages msg JOIN users u ON msg.sender_id = u.id WHERE msg.id = ?
    `, [messageId]);
  }

  async getMessageById(messageId) {
  return db.get(`
    SELECT msg.*, ${SENDER_COLUMNS},
      ${REPLY_COLUMNS}
    FROM messages msg
    JOIN users u
      ON msg.sender_id = u.id

    LEFT JOIN messages reply
      ON msg.reply_to_id = reply.id AND reply.conversation_id = msg.conversation_id

    WHERE msg.id = ?
  `, [messageId]);
}

async getSeenMessages(conversationId) {
  return db.all(`
    SELECT msg.*, ${SENDER_COLUMNS},
      ${REPLY_COLUMNS}
    FROM messages msg
    JOIN users u
      ON msg.sender_id = u.id

    LEFT JOIN messages reply
      ON msg.reply_to_id = reply.id AND reply.conversation_id = msg.conversation_id

    WHERE msg.conversation_id = ?
      AND msg.status = 'seen'
  `, [conversationId]);
}
  // Kept for the conversation-list's "X" dismiss on a never-started chat --
  // functionally the same as deleteConversation below now, just named for
  // that call site's intent.
  async deleteEmptyConversation(conversationId, userId) {
    return this.deleteConversation(conversationId, userId);
  }

  // "Delete Chat" (ChatPage.jsx 3-dot menu): a real delete, for both sides --
  // the conversation row and its messages (ON DELETE CASCADE) are gone from
  // the database, not just hidden from one person's list.
  async deleteConversation(conversationId, userId) {
    const access = await this.canAccessConversation(conversationId, userId);
    if (!access) return false;
    await db.run('DELETE FROM conversations WHERE id = ?', [conversationId]);
    return true;
  }

  // The OTHER user in this conversation (its match's other pet's owner),
  // or null if `userId` isn't actually part of it. Used for "Report user"
  // from a chat, where the UI only has the conversation id.
  async getPartnerUserId(conversationId, userId) {
    const row = await db.get(`
      SELECT p1.user_id AS u1, p2.user_id AS u2
      FROM conversations c
      JOIN matches m ON c.match_id = m.id
      JOIN pets p1 ON p1.id = m.pet1_id
      JOIN pets p2 ON p2.id = m.pet2_id
      WHERE c.id = ?
    `, [conversationId]);
    if (!row) return null;
    if (Number(row.u1) === Number(userId)) return row.u2;
    if (Number(row.u2) === Number(userId)) return row.u1;
    return null;
  }
}

export default new MessageRepository();