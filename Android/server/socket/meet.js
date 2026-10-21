import { toPublicPet } from '../utils/publicPet.js';

// Meet/live-location room. Location updates are only ever sent to
// sockets that have explicitly joined this room (i.e. someone actively on
// the Meet page), never to every connected socket app-wide -- see
// AUDIT_REPORT.md's location_updated finding for why this room exists.
//
// A viewer sends the point their Meet page is centred on with join_meet
// ({ lat, lng }, re-sent when it changes). Live updates then carry only the
// DISTANCE from that point, computed here per viewer -- never the moving
// pet's coordinates, which are its owner's exact position.
export function setupMeetSocket(io) {
  io.on('connection', (socket) => {
    socket.on('join_meet', ({ lat, lng }) => {
      const la = Number(lat);
      const ln = Number(lng);
      socket.data.meetCenter = Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180
        ? { lat: la, lng: ln }
        : null;
      socket.join('meet_live');
    });

    socket.on('leave_meet', () => {
      socket.leave('meet_live');
      socket.data.meetCenter = null;
    });

    socket.on('disconnect', () => {
      socket.leave('meet_live');
    });
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Sends a pet's new live position to every Meet viewer as a distance from
// that viewer's own centre. The owner's other sockets are skipped (their own
// app already knows where they are); viewers that sent no centre get nothing.
export function emitLiveLocation(io, { pet, latitude, longitude, timestamp }) {
  const room = io.sockets.adapter.rooms.get('meet_live');
  if (!room) return;
  const publicPet = toPublicPet(pet);
  for (const socketId of room) {
    const viewer = io.sockets.sockets.get(socketId);
    const center = viewer?.data?.meetCenter;
    if (!viewer || !center || viewer.user?.id === pet.user_id) continue;
    viewer.emit('location_updated', {
      pet_id: pet.id,
      distance: haversineKm(center.lat, center.lng, latitude, longitude),
      last_updated_location_timestamp: timestamp,
      pet: publicPet,
    });
  }
}
