import NotificationRepo from '../models/NotificationRepository.js';
import { isUserSniffedOut } from '../utils/sniffedOut.js';

export function setupNotificationSocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.user?.id;
    if (userId) {
      socket.join(`user_${userId}`);
    }
  });
}

// The one path every notification goes through -- so a SniffedOut
// (deleted) account never receives one, whatever triggered it (a reply to
// their old comment, a like, a profile view...).
export async function sendRealtimeNotification(io, userId, notificationData) {
  try {
    if (await isUserSniffedOut(userId)) return null;
    const notification = await NotificationRepo.createNotification({
      userId,
      ...notificationData,
    });
    if (notification && io) {
      const unreadCount = await NotificationRepo.getUnreadCount(userId);
      io.to(`user_${userId}`).emit('notification_received', {
        notification,
        unreadCount,
      });
    }
    return notification;
  } catch (err) {
    console.error('Failed to send real-time notification:', err);
    return null;
  }
}
