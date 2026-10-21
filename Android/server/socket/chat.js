import MessageRepo from '../models/MessageRepository.js';
import db from '../db/connection.js';
import { isConversationReadOnly, isPetSniffedOut, SNIFFED_OUT_BODY } from '../utils/sniffedOut.js';
import UserRepo from '../models/UserRepository.js';
import { toId } from './safeHandlers.js';

// What a client may send through send_message -- exactly what ChatPage
// sends: plain text, a pet profile card (mediaUrl = the pet's id) and a
// meetup invite (content = a JSON object). Photos, videos, voice notes and
// files are uploaded through POST /api/chat/messages, which sets their type
// and URL itself; the system-ish types (shared_post, call notices) are only
// written by the server. So no client-supplied link can ever be stored as
// media. Returns the normalized { messageType, content, mediaUrl } or null.
const MAX_MESSAGE_LENGTH = 10000;
export function validateSocketMessage(messageType, content, mediaUrl) {
  const text = content === undefined || content === null ? '' : content;
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) return null;
  const noMedia = mediaUrl === undefined || mediaUrl === null || mediaUrl === '';
  switch (messageType) {
    case 'text':
      return noMedia && text.trim() ? { messageType, content: text, mediaUrl: null } : null;
    case 'pet_profile': {
      const petId = toId(mediaUrl);
      return petId ? { messageType, content: text, mediaUrl: String(petId) } : null;
    }
    case 'meetup': {
      if (!noMedia) return null;
      try {
        const invite = JSON.parse(text);
        return invite && typeof invite === 'object' && !Array.isArray(invite) ? { messageType, content: text, mediaUrl: null } : null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

// Track online users: userId -> Set of socketIds
const onlineUsers = new Map();
// Track who's typing in which conversation: conversationId -> Map(userId -> timeout)
const typingTimeouts = new Map();

export function setupChatSocket(io) {
  // Every handler below is registered synchronously, before anything is
  // awaited. Socket.IO silently drops events that arrive while a socket has
  // no listener, so the old version -- which awaited DB work first -- lost
  // any send_message (and its ack) sent right after connecting/reconnecting,
  // and could miss a quick disconnect entirely. The DB work now runs after
  // registration (see syncOnConnect at the bottom).
  io.on('connection', (socket) => {
    const userId = Number(socket.user.id);

    // Register online (in memory, no DB)
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    // Presence is not shared within a blocked pair (services/blocks.js):
    // neither sees the other come online, nor in the online list.
    (async () => {
      const blockedIds = await UserRepo.getBlockedUserIds(userId);
      socket.broadcast.except(blockedIds.map(id => `user_${id}`)).emit('user_online', { userId });
      socket.emit('online_users_list', { onlineUserIds: getOnlineUsers().filter(id => !blockedIds.includes(id)) });
    })().catch(err => console.error('[chat presence error]', err.message));

    // True if the other participant of this conversation and this user are
    // a blocked pair.
    const blockedInConversation = async (conversationId) => {
      const otherUserId = await MessageRepo.getOtherParticipantUserId(conversationId, userId);
      return !!otherUserId && await UserRepo.isBlocked(userId, otherUserId);
    };
    // Join conversation room
  socket.on('join_conversation', async ({ conversationId: rawConversationId }) => {
  const conversationId = toId(rawConversationId);
  if (!conversationId) return;
  // Without this check, any authenticated socket could join any
  // conv_<id> room by guessing/knowing the ID and silently receive every
  // future message in a conversation it isn't part of -- the REST layer
  // already enforces this (MessageRepo.canAccessConversation), but the
  // realtime layer bypassed it entirely until now.
  const access = await MessageRepo.canAccessConversation(conversationId, userId);
  if (!access) return;

  socket.join(`conv_${conversationId}`);

  await MessageRepo.markSeen(conversationId, userId);

  io.to(`conv_${conversationId}`).emit('messages_seen', {
    conversationId,
    userId
  });

  const updatedMessages =
    await MessageRepo.getSeenMessages(conversationId);

  // One batched event for the whole conversation instead of one
  // 'message_updated' per message -- opening a conversation with N
  // unseen messages used to fire N separate socket events, and the
  // client's handler ran a full conversations-list refetch on EACH one
  // (see ChatPage.jsx), turning "open a chat with 30 unread messages"
  // into 30 redundant API calls. A single array event fixes that at
  // the source.
  if (updatedMessages.length) {
    io.to(`conv_${conversationId}`).emit('messages_updated', {
      conversationId,
      messages: updatedMessages
    });
  }
});

    socket.on('leave_conversation', ({ conversationId }) => {
      const id = toId(conversationId);
      if (id) socket.leave(`conv_${id}`);
    });

    // Typing only for a conversation this socket has joined -- join_conversation
    // admits a socket to conv_<id> only after the access check.
    const joinedConversation = (rawConversationId) => {
      const id = toId(rawConversationId);
      return id && socket.rooms.has(`conv_${id}`) ? id : null;
    };

    // ── Typing indicators ──────────────────────────────────────
    // Debounced: client sends 'typing_start' on keystroke, we broadcast
    // to the other party and auto-clear after 4s of silence (protects
    // against a client that never sends 'typing_stop' due to a tab close
    // or crash -- the indicator can't get stuck on forever).
    socket.on('typing_start', async ({ conversationId: rawConversationId }) => {
      const conversationId = joinedConversation(rawConversationId);
      if (!conversationId || await blockedInConversation(conversationId)) return;
      io.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, isTyping: true });

      const key = `${conversationId}_${userId}`;
      if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));
      const timeout = setTimeout(() => {
        io.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, isTyping: false });
        typingTimeouts.delete(key);
      }, 4000);
      typingTimeouts.set(key, timeout);
    });

    socket.on('typing_stop', ({ conversationId: rawConversationId }) => {
      const conversationId = joinedConversation(rawConversationId);
      if (!conversationId) return;
      const key = `${conversationId}_${userId}`;
      if (typingTimeouts.has(key)) {
        clearTimeout(typingTimeouts.get(key));
        typingTimeouts.delete(key);
      }
      io.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, isTyping: false });
    });

    // ── Send message (now with an acknowledgment callback) ─────────
    // IMPORTANT: the third argument here is a Socket.IO acknowledgment
    // callback. If the client provides one (see ChatPage.jsx), it will
    // be called with either { success: true, message } or an error --
    // this is what lets the frontend detect a failed/lost send (e.g. the
    // socket disconnected mid-request) and show a "failed to send, tap
    // to retry" state instead of the message silently vanishing.
    socket.on('send_message', async ({ conversationId: rawConversationId, content, mediaUrl, messageType, replyToId: rawReplyToId, clientTempId }, ack) => {
      const refuse = (error) => { if (typeof ack === 'function') ack({ success: false, error, clientTempId }); };
      try {
        const conversationId = toId(rawConversationId);
        const access = conversationId && await MessageRepo.canAccessConversation(conversationId, userId);
        if (!access) return refuse('NO_ACCESS');

        // Only what the app sends over the socket (see validateSocketMessage);
        // uploaded media goes through POST /api/chat/messages.
        const valid = validateSocketMessage(messageType || 'text', content, mediaUrl);
        if (!valid) return refuse('INVALID_MESSAGE');

        // A reply may only quote a message of this conversation (the reply
        // preview returns the quoted message's text and sender).
        let replyToId = null;
        if (rawReplyToId !== undefined && rawReplyToId !== null && rawReplyToId !== '') {
          replyToId = toId(rawReplyToId);
          if (!replyToId || !(await MessageRepo.isMessageInConversation(replyToId, conversationId))) return refuse('INVALID_REPLY');
        }

        // Same block rule as the REST send (routes/chat.js POST /messages).
        const otherUserId = await MessageRepo.getOtherParticipantUserId(conversationId, userId);
        if (otherUserId && await UserRepo.isBlocked(userId, otherUserId)) {
          refuse('BLOCKED');
          socket.emit('chat_error', { error: 'BLOCKED', message: 'You cannot message this user.', conversationId, clientTempId });
          return;
        }
        // Read-only once the other side is SniffedOut; and a SniffedOut pet
        // can't be sent as a profile card (the chat @mention) either.
        const sniffedOut = await isConversationReadOnly(conversationId, userId)
          || (valid.messageType === 'pet_profile' && await isPetSniffedOut(Number(valid.mediaUrl)));
        if (sniffedOut) {
          // Refused before any write. The ack carries the error for the
          // sender's pending bubble; chat_error matches the other socket
          // refusals (reactions) for clients listening for it.
          if (typeof ack === 'function') ack({ success: false, error: SNIFFED_OUT_BODY.error, clientTempId });
          socket.emit('chat_error', { ...SNIFFED_OUT_BODY, conversationId, clientTempId });
          return;
        }

        const message = await MessageRepo.sendMessage(conversationId, userId, valid.content, valid.mediaUrl, valid.messageType, replyToId);

        // Send to all in conversation
        io.to(`conv_${conversationId}`).emit('message_received', message);
        // M24: reaches the recipient even if they haven't got this
        // conversation's room open right now (see notifyConversationPreview).
        notifyConversationPreview(io, { conversationId, recipientUserId: otherUserId, message });

        // Check if recipient is online and in conversation — mark delivered
        const recipientSockets = getConversationRecipientSockets(io, conversationId, userId);
        if (recipientSockets.length > 0) {

    await MessageRepo.markDelivered(message.id);

const updated = await MessageRepo.getMessageById(message.id);

io.to(`conv_${conversationId}`).emit(
  "message_updated",
  updated
);
}

        if (typeof ack === 'function') ack({ success: true, message, clientTempId });
      } catch (err) {
        console.error('[send_message error]', err.message);
        refuse('SERVER_ERROR'); // no internal error text to the client
      }
    });

    // Message delivered acknowledgment
       //deleted

    // Messages seen
    socket.on('messages_seen', async ({ conversationId: rawConversationId }) => {
  // Only a participant can mark a conversation seen (and trigger the
  // broadcast of its seen messages below).
  const conversationId = toId(rawConversationId);
  if (!conversationId || !(await MessageRepo.canAccessConversation(conversationId, userId))) return;
  await MessageRepo.markSeen(conversationId, userId);

  const updatedMessages =
    await MessageRepo.getSeenMessages(conversationId);

  // One batched event for the whole conversation instead of one
  // 'message_updated' per message -- opening a conversation with N
  // unseen messages used to fire N separate socket events, and the
  // client's handler ran a full conversations-list refetch on EACH one
  // (see ChatPage.jsx), turning "open a chat with 30 unread messages"
  // into 30 redundant API calls. A single array event fixes that at
  // the source.
  if (updatedMessages.length) {
    io.to(`conv_${conversationId}`).emit('messages_updated', {
      conversationId,
      messages: updatedMessages
    });
  }
});

    // ── Message reactions ────────────────────────────────────────
    socket.on('react_to_message', async ({ messageId, conversationId, reaction }) => {
      try {
        // Previously unchecked: the message must be in a conversation this
        // user is part of, and that conversation must not be read-only.
        const msg = await db.get('SELECT conversation_id FROM messages WHERE id = ?', [messageId]);
        if (!msg || !(await MessageRepo.canAccessConversation(msg.conversation_id, userId))) return;
        if (await isConversationReadOnly(msg.conversation_id, userId)) {
          socket.emit('chat_error', { ...SNIFFED_OUT_BODY, messageId });
          return;
        }
        if (await blockedInConversation(msg.conversation_id)) {
          socket.emit('chat_error', { error: 'BLOCKED', message: 'You cannot message this user.', messageId });
          return;
        }

        const existing = await db.get(
          'SELECT id, reaction FROM message_reactions WHERE message_id = ? AND user_id = ?',
          [messageId, userId]
        );

        if (existing && existing.reaction === reaction) {
          // Tapping the same reaction again removes it
          await db.run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [messageId, userId]);
        } else if (existing) {
          await db.run('UPDATE message_reactions SET reaction = ? WHERE message_id = ? AND user_id = ?', [reaction, messageId, userId]);
        } else {
          await db.run('INSERT INTO message_reactions (message_id, user_id, reaction) VALUES (?, ?, ?)', [messageId, userId, reaction]);
        }

        const rows = await db.all('SELECT reaction, COUNT(*)::int as count FROM message_reactions WHERE message_id = ? GROUP BY reaction', [messageId]);
        const reactions = {};
        rows.forEach(r => { reactions[r.reaction] = r.count; });

        io.to(`conv_${msg.conversation_id}`).emit('message_reaction_updated', { messageId, reactions });
      } catch (err) {
        console.error('[react_to_message error]', err.message);
      }
    });

    // Fetch back message
    socket.on('fetch_back_message', async ({ messageId }) => {
      const updated = await MessageRepo.fetchBackMessage(messageId, userId);
      if (updated && updated.conversation_id) {
        io.to(`conv_${updated.conversation_id}`).emit('message_updated', updated);
      }
    });

    // Disconnect
socket.on('disconnect', async () => {
  const sockets = onlineUsers.get(userId);

  if (sockets) {
    sockets.delete(socket.id);

    if (sockets.size === 0) {
      onlineUsers.delete(userId);

      // Clear this user's typing indicator(s) immediately instead of
      // leaving the other party staring at a stale "Typing..." for up to
      // the 4s safety-net window below -- a dropped connection should
      // read the same as the user having stopped typing right away.
      for (const [key, timeout] of typingTimeouts) {
        if (key.endsWith(`_${userId}`)) {
          clearTimeout(timeout);
          typingTimeouts.delete(key);
          const conversationId = key.slice(0, -`_${userId}`.length);
          io.to(`conv_${conversationId}`).emit('user_typing', { conversationId: Number(conversationId), userId, isTyping: false });
        }
      }

      const lastActiveAt = new Date().toISOString();

      await db.run(
    "UPDATE users SET last_active_at = ? WHERE id = ? AND deleted_at IS NULL", // never touch a tombstone
    [lastActiveAt, userId]
);

    const blockedIds = await UserRepo.getBlockedUserIds(userId);
    socket.broadcast.except(blockedIds.map(id => `user_${id}`)).emit('user_offline', { userId, lastActiveAt });
    }
  }
});

    syncOnConnect(io, socket, userId).catch(err => {
      console.error('[chat connect sync error]', err.message);
    });
  });
}

// Connect-time DB work, run only after all handlers exist: record activity
// and push any messages that arrived while this user was offline.
async function syncOnConnect(io, socket, userId) {
  await db.run("UPDATE users SET last_active_at = NOW() WHERE id = ? AND deleted_at IS NULL", [userId]);

  const undelivered = await MessageRepo.getUndelivered(userId);
  for (const msg of undelivered) {
    if (!socket.connected) return;
    socket.emit('message_received', msg);
    await MessageRepo.markDelivered(msg.id);
    const updated = await MessageRepo.getMessageById(msg.id);
    io.to(`conv_${msg.conversation_id}`).emit('message_updated', updated);
  }
}

function getConversationRecipientSockets(io, conversationId, senderId) {
  const room = io.sockets.adapter.rooms.get(`conv_${conversationId}`);
  if (!room) return [];
  const sockets = [];
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.user.id !== senderId) sockets.push(s);
  }
  return sockets;
}

export function getOnlineUsers() { return [...onlineUsers.keys()]; }

// L3: force-close every live socket for a user whose authentication state
// was just revoked (logout, password change/reset) -- otherwise an already-
// connected socket keeps working on its original handshake token for the
// rest of that connection's life, Socket.IO never re-runs authenticateSocket
// for an existing connection. disconnect(true) also closes the underlying
// transport, so a client that still holds the old token can't just silently
// reconnect with it (and if it tries, authenticateSocket now sees the
// revoked/invalidated token and refuses it same as any other request would).
export function disconnectUserSockets(io, userId) {
  const ids = onlineUsers.get(Number(userId));
  if (!ids) return;
  for (const socketId of [...ids]) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.disconnect(true);
  }
}

// M24: `message_received`/`message_updated` are scoped to the `conv_${id}`
// room, which a client only joins while that specific conversation is open
// (join_conversation) -- a message landing in a conversation the recipient
// hasn't opened this session never reached them at all, so its preview/
// unread badge in the conversation list stayed stale until a manual
// pull-to-refresh. Every connected socket is already auto-joined to its own
// `user_${id}` room (see socket/calls.js, socket/notifications.js), so this
// reaches the recipient regardless of which room(s) their socket is in, with
// just enough data for the client to patch its conversation-list state
// directly -- no refetch needed (see M25: ChatPage.jsx no longer calls
// loadConversations() on every message for this exact reason).
export function notifyConversationPreview(io, { conversationId, recipientUserId, message }) {
  if (!recipientUserId || !message) return;
  io.to(`user_${recipientUserId}`).emit('conversation_preview_updated', {
    conversationId: Number(conversationId),
    last_message: message.content,
    last_message_type: message.message_type,
    last_message_at: message.created_at,
    sender_id: message.sender_id,
  });
}