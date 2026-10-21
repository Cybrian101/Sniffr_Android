import CommunityRepo from '../models/CommunityRepository.js';
import db from '../db/connection.js';
import { communityReadOnlyBody, getMessageCommunity, COMMUNITY_READ_ONLY_BODY, COMMUNITY_DISABLED_BODY } from '../utils/sniffedOut.js';
import { circleMediaType, isOwnUploadUrl, INVALID_MEDIA_BODY } from '../utils/circleMedia.js';

// Why a message's circle refuses writes (frozen or disabled), or null.
const targetReadOnlyBody = target => (target.frozen ? COMMUNITY_READ_ONLY_BODY : target.disabled ? COMMUNITY_DISABLED_BODY : null);

// Track who's typing in which PawCircle: `${communityId}_${userId}` -> timeout.
// Same shape/purpose as chat.js's typingTimeouts -- a client that never sends
// isTyping:false (crash, dropped connection) can't leave the indicator stuck
// on forever.
const typingTimeouts = new Map();

// Section 6 / L9: send_community_message has no client caller anywhere in
// client/src (the real send flow is POST /:id/messages -- see
// CommunityPage.jsx's handleSendMessage/handleMediaUpload, whose own
// comments explain it replaced emitting this event, to avoid a duplicate-
// message bug). It's kept rather than deleted: server/scripts/
// testCircleChatFixes.js, testCircleMembership.js, testFrozenCircles.js and
// testPrivateCircles.js all exercise it directly to assert its membership/
// frozen-circle/reply/media authorization holds up over the socket path
// too, not just REST -- removing the handler would delete that coverage,
// not just "unused code". What WAS a real gap (the REST route already has
// rateLimiter(config.RATE_LIMIT.POST); this socket event had no equivalent
// at all) is fixed below: a bare per-user sliding-window cap, same
// in-memory-Map technique already used throughout this file (typingTimeouts)
// and routes/auth.js (pawCodeAttempts, verificationCooldowns).
const sendMessageTimestamps = new Map(); // userId -> recent send timestamps
const SEND_MESSAGE_WINDOW_MS = 60 * 1000;
const SEND_MESSAGE_MAX_PER_WINDOW = 20; // matches config.RATE_LIMIT.POST's 10/min order of magnitude, generous for a chat event
function sendMessageRateLimited(userId) {
  const now = Date.now();
  const recent = (sendMessageTimestamps.get(userId) || []).filter(t => now - t < SEND_MESSAGE_WINDOW_MS);
  if (recent.length >= SEND_MESSAGE_MAX_PER_WINDOW) {
    sendMessageTimestamps.set(userId, recent);
    return true;
  }
  recent.push(now);
  sendMessageTimestamps.set(userId, recent);
  return false;
}

const NOT_A_MEMBER_BODY = { error: 'NOT_A_MEMBER', message: 'You must be a member of this PawCircle to do this.' };
const INVALID_REPLY_BODY = { error: 'INVALID_REPLY', message: 'You can only reply to a message in this PawCircle.' };

// A refused action: tell the sender (ack + community_error), change nothing.
function refuse(socket, ack, body, details) {
  if (typeof ack === 'function') ack({ success: false, ...body, ...details });
  socket.emit('community_error', { ...body, ...details });
}

const roomOf = communityId => `pawcircle_${communityId}`;

export function setupCommunitySocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.user.id;

    // Only members get the circle's live messages, reactions and typing.
    socket.on('join_community_chat', async ({ communityId } = {}, ack) => {
      try {
        const id = parseInt(communityId, 10);
        if (!(await CommunityRepo.isMember(id, userId))) return refuse(socket, ack, NOT_A_MEMBER_BODY, { communityId: id });
        socket.join(roomOf(id));
        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        console.error('[join_community_chat error]', err.message);
      }
    });

    socket.on('leave_community_chat', ({ communityId } = {}) => {
      socket.leave(roomOf(parseInt(communityId, 10)));
    });

    // Relayed only from a socket that's in the room, i.e. passed the
    // membership check in join_community_chat.
    //
    // L6: socket.user only ever carries { id, email } (see
    // middleware/auth.js's resolveUserFromToken) -- socket.user.username
    // was always undefined, so CommunityPage.jsx's typing indicator
    // literally rendered "undefined is typing...". Looked up fresh per
    // event rather than cached at connect time: typing bursts are already
    // debounced client-side (one emit per burst, not per keystroke -- see
    // useTypingSignal.js), so this isn't a hot path, and a fresh read can
    // never go stale if the user later changes their username.
    socket.on('community_typing', async ({ communityId, isTyping } = {}) => {
      const id = parseInt(communityId, 10);
      if (!socket.rooms.has(roomOf(id))) return;
      const row = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
      const username = row?.username || null;
      socket.to(roomOf(id)).emit('community_user_typing', {
        communityId: id,
        userId,
        username,
        isTyping
      });

      const key = `${id}_${userId}`;
      if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));

      if (isTyping) {
        const timeout = setTimeout(() => {
          socket.to(roomOf(id)).emit('community_user_typing', {
            communityId: id,
            userId,
            username,
            isTyping: false
          });
          typingTimeouts.delete(key);
        }, 4000);
        typingTimeouts.set(key, timeout);
      } else {
        typingTimeouts.delete(key);
      }
    });

    socket.on('send_community_message', async ({ communityId, content, mediaUrl, replyToId } = {}, ack) => {
      try {
        if (sendMessageRateLimited(userId)) {
          return refuse(socket, ack, { error: 'RATE_LIMIT', message: 'Too many messages. Please slow down.' }, {});
        }
        const id = parseInt(communityId, 10);
        const readOnly = await communityReadOnlyBody(id);
        if (readOnly) return refuse(socket, ack, readOnly, { communityId: id });
        if (!(await CommunityRepo.isMember(id, userId))) return refuse(socket, ack, NOT_A_MEMBER_BODY, { communityId: id });
        if (replyToId && !(await CommunityRepo.isMessageInCommunity(replyToId, id))) {
          return refuse(socket, ack, INVALID_REPLY_BODY, { communityId: id });
        }
        // Only our own uploads (same rule as POST /:id/messages).
        if (mediaUrl && !(await isOwnUploadUrl(mediaUrl))) return refuse(socket, ack, INVALID_MEDIA_BODY, { communityId: id });
        const message = await CommunityRepo.addMessage({
          community_id: id,
          sender_id: userId,
          content: content || '',
          media_url: mediaUrl || null,
          // A photo/video saves as one (not as a text message with a URL).
          message_type: circleMediaType({ url: mediaUrl }),
          reply_to_id: replyToId || null
        });
        io.to(roomOf(id)).emit('community_message_received', message);
        if (typeof ack === 'function') ack({ success: true, message });
      } catch (e) {
        console.error('[send_community_message error]', e);
      }
    });

    // ── Message reactions (same toggle pattern as chat.js's react_to_message,
    // just against community_message_reactions instead of message_reactions) ──
    socket.on('react_to_community_message', async ({ messageId, reaction } = {}, ack) => {
      try {
        // Checked against the circle the message really belongs to, never the
        // communityId the client claims.
        const target = await getMessageCommunity(messageId);
        if (!target) return refuse(socket, ack, { error: 'NOT_FOUND', message: 'Message not found.' }, { messageId });
        if (targetReadOnlyBody(target)) return refuse(socket, ack, targetReadOnlyBody(target), { communityId: target.id, messageId });
        if (!(await CommunityRepo.isMember(target.id, userId))) {
          return refuse(socket, ack, NOT_A_MEMBER_BODY, { communityId: target.id, messageId });
        }
        const existing = await db.get(
          'SELECT id, reaction FROM community_message_reactions WHERE community_message_id = ? AND user_id = ?',
          [messageId, userId]
        );

        if (existing && existing.reaction === reaction) {
          await db.run('DELETE FROM community_message_reactions WHERE community_message_id = ? AND user_id = ?', [messageId, userId]);
        } else if (existing) {
          await db.run('UPDATE community_message_reactions SET reaction = ? WHERE community_message_id = ? AND user_id = ?', [reaction, messageId, userId]);
        } else {
          await db.run('INSERT INTO community_message_reactions (community_message_id, user_id, reaction) VALUES (?, ?, ?)', [messageId, userId, reaction]);
        }

        const rows = await db.all('SELECT reaction, COUNT(*)::int as count FROM community_message_reactions WHERE community_message_id = ? GROUP BY reaction', [messageId]);
        const reactions = {};
        rows.forEach(r => { reactions[r.reaction] = r.count; });

        io.to(roomOf(target.id)).emit('community_message_reaction_updated', { messageId, reactions });
        if (typeof ack === 'function') ack({ success: true, reactions });
      } catch (err) {
        console.error('[react_to_community_message error]', err.message);
      }
    });

    // ── Fetch Back (delete-for-everyone-by-sender), same behavior as
    // chat.js's fetch_back_message. Sender only (fetchBackMessage), and only
    // while still a member of the circle.
    socket.on('fetch_back_community_message', async ({ messageId } = {}, ack) => {
      try {
        const target = await getMessageCommunity(messageId);
        if (!target) return refuse(socket, ack, { error: 'NOT_FOUND', message: 'Message not found.' }, { messageId });
        if (targetReadOnlyBody(target)) return refuse(socket, ack, targetReadOnlyBody(target), { communityId: target.id, messageId });
        if (!(await CommunityRepo.isMember(target.id, userId))) {
          return refuse(socket, ack, NOT_A_MEMBER_BODY, { communityId: target.id, messageId });
        }
        const updated = await CommunityRepo.fetchBackMessage(messageId, userId);
        if (!updated) return refuse(socket, ack, { error: 'FORBIDDEN', message: 'You can only fetch back your own messages.' }, { communityId: target.id, messageId });
        io.to(roomOf(updated.community_id)).emit('community_message_updated', updated);
        if (typeof ack === 'function') ack({ success: true });
      } catch (err) {
        console.error('[fetch_back_community_message error]', err.message);
      }
    });

    socket.on('disconnect', async () => {
      // Same L6 fix as the community_typing handler above -- socket.user
      // only ever carries { id, email }, never username.
      let username = null;
      let usernameLoaded = false;
      for (const [key, timeout] of typingTimeouts) {
        if (key.endsWith(`_${userId}`)) {
          clearTimeout(timeout);
          typingTimeouts.delete(key);
          if (!usernameLoaded) {
            const row = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
            username = row?.username || null;
            usernameLoaded = true;
          }
          const communityId = key.slice(0, -`_${userId}`.length);
          socket.to(roomOf(communityId)).emit('community_user_typing', {
            communityId: Number(communityId),
            userId,
            username,
            isTyping: false
          });
        }
      }
    });
  });
}
