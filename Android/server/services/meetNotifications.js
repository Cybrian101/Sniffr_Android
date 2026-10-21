import { sendRealtimeNotification } from '../socket/notifications.js';

// The "you matched" notification is identical regardless of which of the
// three accept paths triggered it (fresh mutual swipe was removed -- this
// now only ever fires from an explicit Accept, via the Pending tab or the
// notification's own Accept button) -- one shared place for the copy and
// the cross-wiring (each side's notification references the OTHER pet).
export async function notifyMeetMatch(io, matchId, petA, petB) {
  await sendRealtimeNotification(io, petA.user_id, {
    category: 'matches',
    type: 'new_match',
    title: '🐾 The sniff was mutual!',
    description: `You and ${petB.name} matched! Start chatting.`,
    avatarUrl: petB.avatar_url,
    targetId: String(matchId),
    senderPetId: petB.id,
    actionStatus: 'accepted',
  });
  await sendRealtimeNotification(io, petB.user_id, {
    category: 'matches',
    type: 'new_match',
    title: '🐾 The sniff was mutual!',
    description: `You and ${petA.name} matched! Start chatting.`,
    avatarUrl: petA.avatar_url,
    targetId: String(matchId),
    senderPetId: petA.id,
    actionStatus: 'accepted',
  });
}
