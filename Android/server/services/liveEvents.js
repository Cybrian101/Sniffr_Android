import db from '../db/connection.js';

// Socket events from code that may run without the server's io: the hourly
// cleanup job and scripts. With io (inside a request) the event goes out
// directly; without it, it's handed to the running server(s) through Postgres
// NOTIFY on LIVE_EVENTS_CHANNEL, the same hand-off the account-deletion support
// tool uses -- each server LISTENs (accountDeletionFollowUp.js
// listenForDeletionAnnouncements) and emits it to the room.
//   emitLive(io, 'user_12', 'community_transfer_updated', { communityId: 3 })

export const LIVE_EVENTS_CHANNEL = 'sniffr_live_events';
// Rooms an event may be relayed to: a user's own room or a PawCircle room.
const RELAYABLE_ROOM = /^(user|pawcircle)_\d+$/;

export async function emitLive(io, room, event, data) {
  if (io) {
    io.to(room).emit(event, data);
    return;
  }
  try {
    // NOTIFY payloads are limited to 8000 bytes; these events are small.
    await db.run('SELECT pg_notify(?::text, ?::text)', [LIVE_EVENTS_CHANNEL, JSON.stringify({ room, event, data })]);
  } catch (err) {
    console.error(`[live events] could not hand "${event}" to the server:`, err.message);
  }
}

// Server side: emits a relayed event (called by the LISTEN handler).
export function emitRelayedEvent(io, payload) {
  const { room, event, data } = payload || {};
  if (!io || typeof room !== 'string' || !RELAYABLE_ROOM.test(room) || typeof event !== 'string' || !event) return false;
  io.to(room).emit(event, data);
  return true;
}
