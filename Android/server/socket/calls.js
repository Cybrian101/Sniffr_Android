import CallRepo from '../models/CallRepository.js';
import PetRepo from '../models/PetRepository.js';
import { isUserSniffedOut, SNIFFED_OUT_BODY } from '../utils/sniffedOut.js';
import UserRepo from '../models/UserRepository.js';
import { toId } from './safeHandlers.js';

// User call availability: userId -> 'available' | 'busy' | 'in-call'
const userCallState = new Map();
// Active calls: callId -> { from, to, callerPetId, receiverPetId, type, start_time,
// startedAt, answered, ringTimeout, callerSocketId, answeredSocketId }
// callerSocketId/answeredSocketId (H13): the ONE specific socket on each side
// that's actually part of the call -- a user can be signed in on several
// devices/tabs at once (they all join the same `user_${id}` room), so
// broadcasting signaling to the whole room meant every device the callee
// had open received the same WebRTC offer/ICE candidates and could answer,
// and a device that never answered could still end the call for the one
// that did (both pass the `call.to === userId` check). Set once the caller
// initiates / the callee accepts; re-pointed at a fresh socket id on
// reconnect (see the grace-period handling below) rather than torn down.
const activeCalls = new Map();
// userId -> timeout: a brief disconnect (tab backgrounded, wifi hiccup)
// shouldn't immediately end an already-answered call -- socket.io's own
// client reconnection (reconnectionDelay 1s, up to 10 attempts) usually
// recovers within a couple seconds. Cleared the moment any new connection
// for that user arrives; only fires (and ends their active call(s)) if they
// truly have no live socket left once the grace period elapses.
const pendingDisconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 12 * 1000;

// How long an outgoing call rings before it's auto-cancelled as unanswered.
// Previously nothing expired an unanswered call server-side -- if the
// receiving client's app was killed/backgrounded and never sent
// call_reject, the caller's UI (and the callee's call_incoming) could be
// left ringing indefinitely with no server-driven cleanup.
const RING_TIMEOUT_MS = 45 * 1000;

async function endUnansweredCall(io, callId, status) {
  const call = activeCalls.get(callId);
  if (!call) return;
  activeCalls.delete(callId);
  userCallState.set(call.from, 'available');
  userCallState.set(call.to, 'available');

  try {
    await CallRepo.log({
      callerPetId: call.callerPetId,
      receiverPetId: call.receiverPetId,
      type: call.type,
      status,
      duration: 0,
      start_time: call.start_time,
      end_time: new Date().toISOString()
    });
  } catch (err) {
    console.error('Call timeout logging failed:', err.message);
  }

  io.to(`user_${call.from}`).emit('call_timeout', { callId });
  io.to(`user_${call.to}`).emit('call_timeout', { callId });
}

export function setupCallSocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.user.id;
    userCallState.set(userId, 'available');

    socket.join(`user_${userId}`);

    // This connection might BE the recovery from a recent drop -- cancel
    // any pending teardown and re-point this user's role in whatever
    // call(s) they're still (supposed to be) part of at their new socket
    // id, so signaling keeps working without the call ever having ended.
    const pendingDisconnect = pendingDisconnectTimers.get(userId);
    if (pendingDisconnect) {
      clearTimeout(pendingDisconnect);
      pendingDisconnectTimers.delete(userId);
    }
    for (const call of activeCalls.values()) {
      if (call.from === userId) call.callerSocketId = socket.id;
      if (call.to === userId && call.answered) call.answeredSocketId = socket.id;
    }

    socket.on('call_initiate', async ({ to: rawTo, type }) => {
      const to = toId(rawTo);
      if (!to || to === userId || (type !== 'audio' && type !== 'video')) {
        return socket.emit('call_error', { message: 'This call could not be started.' });
      }
      if (userCallState.get(userId) === 'in-call') {
        return socket.emit('call_error', { message: 'You are already in a call' });
      }

      // No calling (or calling back) a SniffedOut account.
      if (await isUserSniffedOut(to)) {
        return socket.emit('call_error', { ...SNIFFED_OUT_BODY });
      }

      const recipientState = userCallState.get(to);
      if (recipientState === 'in-call' || recipientState === 'busy') {
        return socket.emit('call_busy', { userId: to });
      }

      // A block should stop calls the same way it already stops
      // chat/swipe/share (see AUDIT_REPORT.md) -- without this, a blocked
      // user could still voice/video-call the person who blocked them.
      if (await UserRepo.isBlocked(userId, to)) {
        return socket.emit('call_error', { message: 'You cannot call this user' });
      }

      const callerPet = await PetRepo.getActivePet(userId);
      // No pet yet (skipped during signup): the app asks them to create one.
      if (!callerPet) {
        return socket.emit('call_error', { code: 'NO_PET', message: "Create your pet's profile first 🐾" });
      }
      const receiverPet = await PetRepo.getActivePet(to);
      if (!receiverPet) {
        return socket.emit('call_error', { message: 'Registered pet profiles not found' });
      }

      const callId = `${userId}_${to}_${Date.now()}`;
      const ringTimeout = setTimeout(() => endUnansweredCall(io, callId, 'missed'), RING_TIMEOUT_MS);
      activeCalls.set(callId, {
        from: userId,
        to,
        callerPetId: callerPet.id,
        receiverPetId: receiverPet.id,
        type,
        start_time: new Date().toISOString(),
        startedAt: null,
        answered: false,
        ringTimeout,
        callerSocketId: socket.id,
        answeredSocketId: null,
      });

      userCallState.set(userId, 'busy');
      userCallState.set(to, 'busy');

      // Include caller's pet info directly so the receiving client doesn't
      // need to guess which profile to fetch (avoids "wrong pet shown" bugs).
      io.to(`user_${to}`).emit('call_incoming', {
        callId,
        from: userId,
        type,
        callerPet: {
          id: callerPet.id,
          name: callerPet.name,
          avatar_url: callerPet.avatar_url,
          pet_username: callerPet.pet_username,
        }
      });
      socket.emit('call_ringing', { callId, to });
    });

    // Call state: ringing (call_initiate) -> answered (call_accept, by the
    // callee only) -> media negotiation (webrtc_*, only on an answered call).
    socket.on('call_accept', ({ callId }) => {
      const call = activeCalls.get(callId);
      // Only the person being called can answer, and only once -- the
      // `call.answered` check also catches a SECOND device of the same
      // callee tapping Accept a moment after the first (H13: "multiple
      // tabs/devices can answer the same call").
      if (!call || call.to !== userId || call.answered) return;
      clearTimeout(call.ringTimeout);
      call.startedAt = Date.now();
      call.answered = true;
      // THIS socket -- not every socket this user has open -- is now the
      // one actually in the call; see the activeCalls comment above.
      call.answeredSocketId = socket.id;

      userCallState.set(call.from, 'in-call');
      userCallState.set(call.to, 'in-call');

      io.to(call.callerSocketId).emit('call_connected', { callId });
      socket.emit('call_connected', { callId });
      // Every OTHER device/tab this callee has open was also shown the
      // incoming-call UI (call_incoming went to the whole user_${to} room,
      // correctly -- ringing should show everywhere) -- `socket.to(...)`
      // excludes the emitting socket itself, so only those other devices
      // get told to stand down instead of sitting in a stale "connected"
      // state they were never actually part of.
      socket.to(`user_${call.to}`).emit('call_answered_elsewhere', { callId });
    });

    socket.on('call_reject', async ({ callId, reason }) => {
      const call = activeCalls.get(callId);
      if (!call || (call.from !== userId && call.to !== userId)) return;
      clearTimeout(call.ringTimeout);

      userCallState.set(call.from, 'available');
      userCallState.set(call.to, 'available');
      activeCalls.delete(callId);

      try {
        await CallRepo.log({
          callerPetId: call.callerPetId,
          receiverPetId: call.receiverPetId,
          type: call.type,
          status: reason === 'declined' ? 'declined' : 'missed',
          duration: 0,
          declinedBy: reason === 'declined' ? 'receiver' : null,
          start_time: call.start_time,
          end_time: new Date().toISOString()
        });
      } catch (err) {
        console.error('Call reject logging failed:', err.message);
      }

      io.to(`user_${call.from}`).emit('call_rejected', { callId, reason: reason || 'declined' });
      io.to(`user_${call.to}`).emit('call_rejected', { callId, reason: reason || 'declined' });
    });

    socket.on('call_end', async ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call || (call.from !== userId && call.to !== userId)) return;
      // H13: once answered, only the two sockets actually on the call may
      // end it -- otherwise a second device/tab of either party (which
      // never joined the call, just saw the same user_${id} broadcasts)
      // could hang up a call it was never part of. Before answering, any of
      // either party's devices may still cancel/decline it.
      if (call.answered && socket.id !== call.callerSocketId && socket.id !== call.answeredSocketId) return;
      clearTimeout(call.ringTimeout);

      userCallState.set(call.from, 'available');
      userCallState.set(call.to, 'available');
      activeCalls.delete(callId);

      try {
        const endTime = new Date().toISOString();
        const duration = call.answered && call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
        await CallRepo.log({
          callerPetId: call.callerPetId,
          receiverPetId: call.receiverPetId,
          type: call.type,
          status: call.answered ? 'completed' : 'missed',
          duration,
          start_time: call.start_time,
          end_time: endTime
        });
      } catch (err) {
        console.error('Call end logging failed:', err.message);
      }

      io.to(`user_${call.from}`).emit('call_ended', { callId });
      io.to(`user_${call.to}`).emit('call_ended', { callId });
    });

    // Signaling relays are restricted to two sockets that actually have an
    // active call between them -- without this, any authenticated socket
    // could send a bare webrtc_offer/ice_candidate to any userId and get
    // relayed straight into their call UI, with no call having ever been
    // initiated/accepted through call_initiate/call_accept.
    //
    // Nothing is relayed until the callee has ANSWERED: an offer delivered
    // while the phone is still ringing would make the callee's app set up
    // the connection and turn on its microphone/camera before the person
    // chose to pick up. And each side may only send its own part: offers
    // come from the caller (CallModal creates them only on the caller's
    // side, including ICE-restart re-offers), answers from the callee.
    function answeredCallBetween(a, b) {
      for (const call of activeCalls.values()) {
        if (!call.answered) continue;
        if ((call.from === a && call.to === b) || (call.from === b && call.to === a)) return call;
      }
      return null;
    }

    // H13: targeted at the one specific socket on each side of the call
    // (not the whole user_${id} room) -- otherwise every device/tab the
    // other party had open received the same offer/answer/candidate and
    // could independently act on it.
    socket.on('webrtc_offer', ({ to: rawTo, sdp }) => {
      const to = toId(rawTo);
      const call = to && answeredCallBetween(userId, to);
      if (!call || socket.id !== call.callerSocketId || !call.answeredSocketId) return;
      io.to(call.answeredSocketId).emit('webrtc_offer', { from: userId, sdp });
    });
    socket.on('webrtc_answer', ({ to: rawTo, sdp }) => {
      const to = toId(rawTo);
      const call = to && answeredCallBetween(userId, to);
      if (!call || call.to !== userId || socket.id !== call.answeredSocketId) return;
      io.to(call.callerSocketId).emit('webrtc_answer', { from: userId, sdp });
    });
    socket.on('webrtc_ice_candidate', ({ to: rawTo, candidate }) => {
      const to = toId(rawTo);
      const call = to && answeredCallBetween(userId, to);
      if (!call) return;
      const targetSocketId = call.from === userId ? call.answeredSocketId : call.callerSocketId;
      if (!targetSocketId) return;
      io.to(targetSocketId).emit('webrtc_ice_candidate', { from: userId, candidate });
    });

    // Pure relay, same shape as the ICE-candidate one above -- lets the
    // remote party's UI show "X is muted" instead of just going silent
    // with no indication of why.
    socket.on('call_mute_state', ({ to: rawTo, muted }) => {
      const to = toId(rawTo);
      const call = to && answeredCallBetween(userId, to);
      if (!call) return;
      const targetSocketId = call.from === userId ? call.answeredSocketId : call.callerSocketId;
      if (!targetSocketId) return;
      io.to(targetSocketId).emit('call_mute_state', { from: userId, muted });
    });

    // H13: "a brief socket interruption can end a call immediately" -- this
    // used to tear the call down the instant the signaling socket dropped,
    // even though socket.io's own client reconnects within a second or two
    // on a transient blip (wifi hiccup, tab backgrounded) and the WebRTC
    // media itself (once connected, a separate peer-to-peer path) doesn't
    // even depend on this socket staying open. Give reconnection a real
    // chance first; the connection handler above cancels this timer and
    // re-points the call at the new socket id if the user comes back in time.
    socket.on('disconnect', () => {
      const timer = setTimeout(async () => {
        pendingDisconnectTimers.delete(userId);
        // A live socket for this user (this one reconnected fast enough to
        // race the timer, or they have another device/tab open) means
        // they're not actually gone.
        if ((io.sockets.adapter.rooms.get(`user_${userId}`)?.size || 0) > 0) return;

        for (const [callId, call] of activeCalls) {
          if (call.from !== userId && call.to !== userId) continue;
          clearTimeout(call.ringTimeout);
          const other = call.from === userId ? call.to : call.from;
          userCallState.set(other, 'available');
          activeCalls.delete(callId);

          try {
            const endTime = new Date().toISOString();
            const duration = call.answered && call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
            await CallRepo.log({
              callerPetId: call.callerPetId,
              receiverPetId: call.receiverPetId,
              type: call.type,
              status: call.answered ? 'completed' : 'failed',
              duration,
              start_time: call.start_time,
              end_time: endTime
            });
          } catch (err) {
            console.error('Call disconnect logging failed:', err.message);
          }

          io.to(`user_${other}`).emit('call_ended', { callId, reason: 'disconnected' });
        }
        userCallState.delete(userId);
      }, DISCONNECT_GRACE_MS);
      pendingDisconnectTimers.set(userId, timer);
    });
  });
}

export function getUserCallState(userId) {
  return userCallState.get(userId) || 'available';
}