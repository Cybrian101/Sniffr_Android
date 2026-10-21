import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import MatchRepo from '../models/MatchRepository.js';
import PetRepo from '../models/PetRepository.js';
import NotificationRepo from '../models/NotificationRepository.js';
import UserRepo from '../models/UserRepository.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { notifyMeetMatch } from '../services/meetNotifications.js';
import { canUndoLike } from '../services/premiumGate.js';
import { sendServerError } from '../utils/errors.js';
import { requirePet } from '../middleware/requirePet.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import { isPetSniffedOut, SNIFFED_OUT_BODY } from '../utils/sniffedOut.js';
import { toPublicPet } from '../utils/publicPet.js';
import { isBlockedPair, BLOCKED_BODY } from '../services/blocks.js';

const router = Router();
router.use(authenticateAccess);

const FIVE_MINS_MS = 5 * 60 * 1000;
const UNDO_WINDOW_MS = 5000;

// swipeId -> setTimeout handle. Lets POST /undo cancel a pending commit before
// it fires. Purely an optimization/cleanup -- commitPendingSwipeAction() is a
// safe no-op on an already-deleted/committed row either way.
const pendingCommitTimers = new Map();

// Runs once the 5s undo window elapses for a FRESH swipe (left or right).
// Never forms a match -- a swipe is never itself an Accept. See
// MatchRepository's createPendingSwipeAction/acceptMeetRequest split.
async function commitPendingSwipeAction(swipeId) {
  pendingCommitTimers.delete(swipeId);
  try {
    await MatchRepo.commitPendingSwipeAction(swipeId);
  } catch (err) {
    console.error('Failed to commit pending swipe action:', err);
  }
}

// GET /api/matches/discover?lat=&lng=&radius= — nearby swipeable pets
// (excludes own pet, real Meet matches, live sniff requests/cooldowns in
// either direction, and pets already chatting with -- see
// MatchRepo.getExcludedMeetPetIds)
router.get('/discover', requirePet, async (req, res) => {
  try {
    const myPet = req.pet; // requirePet

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 15;
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'MISSING_LOCATION', message: 'Location is required to discover nearby pets.' });
    }

    const excludeIds = await MatchRepo.getExcludedMeetPetIds(myPet.id);
    const nearby = await PetRepo.findNearby(lat, lng, radius, excludeIds, 1, 50);
    const blockedUserIds = await UserRepo.getBlockedUserIds(req.user.id);

    const now = Date.now();
    const pets = nearby
      .filter(p => !blockedUserIds.includes(p.user_id))
      .map(p => ({
        ...toPublicPet(p), // distance is computed here; no coordinates
        online: p.last_active_at ? (now - new Date(p.last_active_at).getTime()) < FIVE_MINS_MS : false,
      }));

    res.json({ pets });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/matches/activity — requested (outgoing), pending (incoming), accepted (mutual)
router.get('/activity', async (req, res) => {
  try {
    const myPet = await PetRepo.getActivePet(req.user.id);
    if (!myPet) return res.json({ requested: [], pending: [], accepted: [] });

    const activity = await MatchRepo.getMeetActivityLists(myPet.id, req.user.id);
    res.json(activity);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/matches — full mutual-match list (used by Meet, Chat, and the Share Sheet)
router.get('/', async (req, res) => {
  try {
    const myPet = await PetRepo.getActivePet(req.user.id);
    if (!myPet) return res.json({ matches: [], total: 0, page: 1, hasMore: false });

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const result = await MatchRepo.getMatches(myPet.id, page, limit, req.user.id);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/matches/like/:petId — swipe right. Sends ONE pending sniff
// request with a 5s undo window (see POST /undo/:petId). A swipe is never
// itself an Accept -- a match only ever forms via POST /pending/:petId/respond
// or POST /notifications/match-request/:id/respond. If the target already
// has a live request out to us, the swipe is silently absorbed (see
// MatchRepo.createPendingSwipeAction) rather than creating a duplicate or
// contradictory row.
router.post('/like/:petId', requirePet, rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const myPet = req.pet; // requirePet

    const targetPetId = parseInt(req.params.petId, 10);
    if (isNaN(targetPetId)) return res.status(400).json({ error: 'INVALID_ID' });

    const targetPet = await PetRepo.findById(targetPetId);
    if (!targetPet) return res.status(404).json({ error: 'NOT_FOUND' });
    if (await isPetSniffedOut(targetPetId)) return res.status(403).json(SNIFFED_OUT_BODY);

    if (await UserRepo.isBlocked(req.user.id, targetPet.user_id)) {
      return res.status(403).json({ error: 'BLOCKED', message: 'You cannot interact with this profile.' });
    }

    const result = await MatchRepo.createPendingSwipeAction(myPet.id, targetPetId, 'awaiting');
    if (result.type === 'absorbed') {
      return res.json({ pending: false, absorbed: true });
    }

    const io = req.app.get('io');
    if (io) {
      const notification = await sendRealtimeNotification(io, targetPet.user_id, {
        category: 'matches',
        type: 'match_request',
        title: `🥰 ${myPet.name} couldn't resist a sniff!`,
        description: `${myPet.name} sent you a sniff request. Accept to match!`,
        avatarUrl: myPet.avatar_url,
        targetId: String(myPet.id),
        senderPetId: myPet.id,
        actionStatus: 'pending',
      });
      if (notification) {
        await MatchRepo.attachNotificationId(result.swipeId, notification.id);
      }
    }

    const timer = setTimeout(() => commitPendingSwipeAction(result.swipeId), UNDO_WINDOW_MS);
    pendingCommitTimers.set(result.swipeId, timer);

    res.json({ pending: true, swipeId: result.swipeId, undoWindowMs: UNDO_WINDOW_MS, matched: false });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/matches/undo/:petId — cancel a fresh left/right swipe within its
// 5s undo window. Premium-gated (Undo Like): free users still see the
// snackbar/button (frontend concern, unchanged), but the actual undo is
// rejected here -- the swipe still commits normally on its own 5s timer.
router.post('/undo/:petId', requirePet, rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const io = req.app.get('io');
    const premiumCheck = await canUndoLike(req.user.id, io);
    if (!premiumCheck.allowed) {
      return res.status(403).json({ error: premiumCheck.reason, message: 'Undo Like is a Premium feature.', plan: premiumCheck.plan });
    }

    const myPet = req.pet; // requirePet

    const targetPetId = parseInt(req.params.petId, 10);
    if (isNaN(targetPetId)) return res.status(400).json({ error: 'INVALID_ID' });

    const undone = await MatchRepo.undoPendingSwipeAction(myPet.id, targetPetId);
    if (!undone) {
      return res.status(410).json({ error: 'TOO_LATE', message: 'This action has already been confirmed and can no longer be undone.' });
    }

    const timer = pendingCommitTimers.get(undone.swipeId);
    if (timer) {
      clearTimeout(timer);
      pendingCommitTimers.delete(undone.swipeId);
    }

    if (undone.notificationId) {
      const removedNotif = await NotificationRepo.deleteById(undone.notificationId);
      if (removedNotif && io) {
        const unreadCount = await NotificationRepo.getUnreadCount(removedNotif.user_id);
        io.to(`user_${removedNotif.user_id}`).emit('notification_removed', {
          notificationId: undone.notificationId,
          unreadCount,
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/matches/decline/:petId — swipe left. Same pending/undo/absorbed
// treatment as swipe-right, just resulting in a 30-day rejection cooldown
// instead of a request. No notification is ever sent for a decline.
router.post('/decline/:petId', requirePet, rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const myPet = req.pet; // requirePet

    const targetPetId = parseInt(req.params.petId, 10);
    if (isNaN(targetPetId)) return res.status(400).json({ error: 'INVALID_ID' });
    if (await isPetSniffedOut(targetPetId)) return res.status(403).json(SNIFFED_OUT_BODY);

    const result = await MatchRepo.createPendingSwipeAction(myPet.id, targetPetId, 'rejected');
    if (result.type === 'absorbed') {
      return res.json({ success: true, absorbed: true });
    }

    const timer = setTimeout(() => commitPendingSwipeAction(result.swipeId), UNDO_WINDOW_MS);
    pendingCommitTimers.set(result.swipeId, timer);

    res.json({ success: true, swipeId: result.swipeId, undoWindowMs: UNDO_WINDOW_MS });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/matches/pending/:petId/respond — Accept/Reject an INCOMING
// request from the Pending tab. :petId is the ORIGINAL REQUESTER's pet id.
// Shares the exact same accept/reject business logic as the notification's
// own buttons (POST /notifications/match-request/:id/respond) via
// MatchRepo.acceptMeetRequest/rejectMeetRequest -- resolving from either
// surface keeps both in sync.
router.post('/pending/:petId/respond', requirePet, rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { action } = req.body; // 'accept' | 'decline'
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'INVALID_ACTION', message: 'action must be accept or decline' });
    }

    const requesterPetId = parseInt(req.params.petId, 10);
    if (isNaN(requesterPetId)) return res.status(400).json({ error: 'INVALID_ID' });
    if (await isPetSniffedOut(requesterPetId)) return res.status(403).json(SNIFFED_OUT_BODY);
    // No matching with someone in a blocked pair (declining stays allowed).
    if (action === 'accept') {
      const requester = await PetRepo.findById(requesterPetId);
      if (requester && await isBlockedPair(req.user.id, requester.user_id)) return res.status(403).json(BLOCKED_BODY);
    }

    // M3: resolve the pet this specific request was actually addressed to --
    // req.pet (requirePet) is whichever pet is currently ACTIVE, which for a
    // multi-pet user is not necessarily the one the requester sniffed.
    // Falls back to the active pet (req.pet) only when no live request is
    // found at all, so an already-resolved/expired request still surfaces
    // as EXPIRED below exactly as before rather than 403/404ing differently.
    const recipientPetId = (await MatchRepo.findRecipientPetForRequest(req.user.id, requesterPetId)) || req.pet.id;
    const myPet = await PetRepo.findById(recipientPetId);

    const io = req.app.get('io');

    if (action === 'accept') {
      const result = await MatchRepo.acceptMeetRequest(myPet.id, requesterPetId);
      if (!result.matched) {
        return res.status(410).json({ error: 'EXPIRED', message: 'This request is no longer available.' });
      }
      if (result.notificationId) {
        await NotificationRepo.markActionStatus(result.notificationId, 'accepted');
        if (io) {
          io.to(`user_${req.user.id}`).emit('notification_updated', {
            notification: await NotificationRepo.findById(result.notificationId),
          });
        }
      }
      if (io) {
        const requesterPet = await PetRepo.findById(requesterPetId);
        if (requesterPet) await notifyMeetMatch(io, result.matchId, myPet, requesterPet);
      }
      return res.json({ success: true, matched: true, matchId: result.matchId });
    }

    const result = await MatchRepo.rejectMeetRequest(myPet.id, requesterPetId);
    if (!result.rejected) {
      return res.status(410).json({ error: 'EXPIRED', message: 'This request is no longer available.' });
    }
    if (result.notificationId) {
      await NotificationRepo.markActionStatus(result.notificationId, 'declined');
      if (io) {
        io.to(`user_${req.user.id}`).emit('notification_updated', {
          notification: await NotificationRepo.findById(result.notificationId),
        });
      }
    }
    // No notification sent to the requester -- silent, per spec -- but their
    // device still needs to drop the resolved entry from Requested live.
    if (io) {
      const requesterPet = await PetRepo.findById(requesterPetId);
      if (requesterPet) {
        io.to(`user_${requesterPet.user_id}`).emit('meet_request_declined', {
          fromPetId: requesterPetId,
          toPetId: myPet.id,
        });
      }
    }
    res.json({ success: true, matched: false });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
