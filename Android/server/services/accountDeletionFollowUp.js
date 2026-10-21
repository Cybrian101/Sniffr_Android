import db from '../db/connection.js';
import { purgeAfterDeletion } from './mediaPurge.js';
import { purgePendingAuthIdentities, authCleanupStatus } from './authIdentityPurge.js';
import { notifyCancelledTransfers } from './circleOwnershipTransfers.js';
import { LIVE_EVENTS_CHANNEL, emitRelayedEvent } from './liveEvents.js';
import { createPgListener } from './pgListener.js';

// What happens right after an account deletion has committed -- shared by
// POST /api/account/delete/confirm and the support script
// (scripts/deleteAccount.js):
//   1. socket announcements: account_deleted + disconnect for the deleted
//      user's sessions, conversation_read_only for their 1:1 chats,
//      community_frozen for the circles they owned;
//   2. deleting the Supabase Auth identity (email/password accounts), queued
//      inside the deletion transaction;
//   3. the Cloudinary media purge.
//
// The endpoint runs inside the server and emits through its own io. The
// support script is a separate process with no sockets, so it hands the
// announcement to every running server through Postgres NOTIFY on the shared
// database; each server LISTENs (listenForDeletionAnnouncements) and emits
// through the same announceDeletion() below.

const CHANNEL = 'sniffr_account_deleted';
// NOTIFY payloads are limited to 8000 bytes: ids go in chunks.
const IDS_PER_NOTIFY = 400;

// Tells the deleted user's open sessions and everyone affected. The emit and
// the disconnect go out on the same socket, so account_deleted arrives before
// the (server-initiated, non-reconnecting) disconnect.
export function announceDeletion(io, userId, { conversationIds = [], ownedCircleIds = [] } = {}) {
  if (!io) return;
  try {
    io.to(`user_${userId}`).emit('account_deleted', { userId });
    io.in(`user_${userId}`).disconnectSockets();
    for (const conversationId of conversationIds) {
      io.to(`conv_${conversationId}`).emit('conversation_read_only', { conversationId });
    }
    for (const communityId of ownedCircleIds) {
      io.to(`pawcircle_${communityId}`).emit('community_frozen', { communityId, reason: 'owner_deleted' });
    }
  } catch (err) {
    console.error('[account deletion] socket announcements failed:', err.message);
  }
}

// Hands the announcement to the running server(s) via NOTIFY.
async function notifyServers(userId, { conversationIds = [], ownedCircleIds = [] } = {}) {
  const chunks = [];
  const convs = [...conversationIds];
  const circles = [...ownedCircleIds];
  do {
    chunks.push({ userId, conversationIds: convs.splice(0, IDS_PER_NOTIFY), ownedCircleIds: circles.splice(0, IDS_PER_NOTIFY) });
  } while (convs.length || circles.length);
  for (const payload of chunks) {
    await db.run('SELECT pg_notify(?::text, ?::text)', [CHANNEL, JSON.stringify(payload)]);
  }
  return chunks.length;
}

/**
 * Post-commit steps for a deleted account. `deleted` is deleteUserAccount()'s
 * result. With `io` (inside the server) the announcements go out directly;
 * without it (support script) they're handed to the running servers.
 * Returns { mediaCleanup, authCleanup }, each 'complete' or 'pending'
 * (anything pending is retried by the hourly job).
 */
export async function afterAccountDeletion(userId, deleted, { io = null, purgeTimeoutMs = 8000 } = {}) {
  if (io) {
    announceDeletion(io, userId, deleted);
  } else {
    try {
      await notifyServers(userId, deleted);
    } catch (err) {
      console.error('[account deletion] could not notify running servers:', err.message);
    }
  }
  // Owners whose PawCircle ownership transfer TO this user was cancelled.
  // (Without io the notifications are stored; open pages see them on reload.)
  try {
    await notifyCancelledTransfers(io, deleted?.cancelledTransfers, userId, 'deleted');
  } catch (err) {
    console.error('[account deletion] ownership transfer notifications failed:', err.message);
  }
  // The Supabase identity first: until it's gone the email can't sign up again.
  try {
    await purgePendingAuthIdentities({ deletedUserId: userId });
  } catch (err) {
    console.error('[account deletion] Supabase identity removal failed (stays queued):', err.message);
  }
  const authCleanup = await authCleanupStatus(userId).catch(() => 'pending');
  const mediaCleanup = await purgeAfterDeletion(userId, { timeoutMs: purgeTimeoutMs });
  return { mediaCleanup, authCleanup };
}

/**
 * Server side of the hand-offs: LISTENs on the shared database and announces
 * deletions made by the support script, and relays live events from code
 * without io (liveEvents.js) -- one connection for both channels. The
 * connection is kept alive, replaced if it drops or stops delivering, and
 * LISTENs again on both channels (services/pgListener.js). Needs a
 * session-mode or direct connection (Postgres LISTEN doesn't work through a
 * transaction pooler).
 */
export function listenForDeletionAnnouncements(io) {
  const listener = createPgListener({
    [CHANNEL]: raw => {
      try {
        const payload = JSON.parse(raw);
        const userId = Number(payload.userId);
        if (!Number.isInteger(userId)) return;
        announceDeletion(io, userId, payload);
        console.log(`[account deletion] announced deletion of user #${userId} (from the support tool)`);
      } catch (err) {
        console.error('[account deletion] bad announcement payload:', err.message);
      }
    },
    // Live socket events handed over by code without io (hourly job, scripts).
    [LIVE_EVENTS_CHANNEL]: raw => {
      try {
        emitRelayedEvent(io, JSON.parse(raw));
      } catch (err) {
        console.error('[live events] bad payload:', err.message);
      }
    },
  }, { label: 'NOTIFY listener' });
  listener.start();
  return listener;
}
